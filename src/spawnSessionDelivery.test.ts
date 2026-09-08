import test from "node:test"
import assert from "node:assert/strict"
import spawnSessionPlugin from "./spawn-session.ts"

/**
 * Integration-level regression coverage for `deliverAgentMessage`: proves
 * what actually goes over the wire in `client.session.promptAsync`'s body,
 * not just the pure `deliveryAgent`/`deliveryModel` helpers in isolation.
 * The plugin's default export is the only thing this module is allowed to
 * export (see AGENTS.md), and it happens to be a plain async function of
 * `{ client }` — importable and callable directly against a fake client, no
 * real OpenCode server needed.
 */

const DIRECTORY = "/home/marenz/Projects/cat-bowl"
const TARGET = "ses_target0000000000000000000"
const FROM_SESSION = "ses_sender0000000000000000000"

type PromptCall = { body: Record<string, unknown> }

function fakeClient(opts: {
	targetSession: { agent?: string; model?: { id: string; providerID: string; variant?: string } }
	agents?: string[]
}) {
	const prompts: PromptCall[] = []
	const client = {
		session: {
			async get() {
				return { data: { id: TARGET, ...opts.targetSession } }
			},
			async promptAsync({ body }: { body: Record<string, unknown> }) {
				prompts.push({ body })
				return {}
			},
			async status() {
				return { data: {} }
			},
		},
		app: {
			async agents() {
				return { data: (opts.agents ?? ["build", "plan", "manager"]).map((name) => ({ name })) }
			},
		},
		config: {
			async providers() {
				return {
					data: {
						providers: [
							{ id: "openai", models: { "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra" } } },
							{ id: "anthropic", models: { "claude-fable-5": { id: "claude-fable-5", name: "Claude Fable 5" } } },
						],
					},
				}
			},
		},
	}
	return { client, prompts }
}

async function sendAgentMessage(client: unknown, args: Record<string, unknown>) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	return plugin.tool.send_agent_message.execute(args, {
		sessionID: FROM_SESSION,
		agent: "build",
		directory: DIRECTORY,
	})
}

test("omitted agent and model: outgoing payload carries the session's own current agent+model, not the defaults", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "status update" })

	assert.equal(prompts.length, 1)
	const { body } = prompts[0]
	// This is the exact regression: the manager agent's own config defaults
	// to a different model (claude-fable-5) than most sessions actually run.
	// An omitted `model` must not let that configured default leak in here.
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	// variant "default" is a sentinel for "none chosen" and must not be
	// round-tripped as a literal variant name.
	assert.equal(body.variant, undefined)
})

test("omitted agent and model: a non-default variant IS preserved", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "build", model: { id: "gpt-6-astra", providerID: "openai", variant: "thinking" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "hi" })

	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "thinking")
})

test("explicit model overrides the session's current one, and drops its variant", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "thinking" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "switch", model: "anthropic/claude-fable-5" })

	const { body } = prompts[0]
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-fable-5" })
	assert.equal(body.variant, undefined)
})

test("explicit agent switch still preserves the session's current model", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "build", model: { id: "gpt-6-astra", providerID: "openai" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "take over", agent: "manager" })

	const { body } = prompts[0]
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
})

test("a brand new target session with no agent or model recorded yet sends neither field", async () => {
	const { client, prompts } = fakeClient({ targetSession: {} })
	await sendAgentMessage(client, { session_id: TARGET, message: "first contact" })

	const { body } = prompts[0]
	assert.equal(body.agent, undefined)
	assert.equal(body.model, undefined)
	assert.equal(body.variant, undefined)
})

test("a session whose model field is missing the runtime `id`/`providerID` shape is treated as agentless-model, not crashed", async () => {
	const { client, prompts } = fakeClient({
		// Simulates an even older/odder SDK response shape than expected.
		targetSession: { agent: "build", model: undefined },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "hi" })

	const { body } = prompts[0]
	assert.equal(body.agent, "build")
	assert.equal(body.model, undefined)
})

test("idle-wake watchdog re-addresses the session with its own current agent+model too", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
	})
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })

	const sessionID = "ses_watchdog00000000000000000"
	// A tiny delay, not a real arm: this never touches a live session, only
	// the fake client above, and is disarmed again immediately after.
	await plugin.tool.wake_after_idle.execute(
		{ minutes: 0.001 },
		{ sessionID, agent: "manager", directory: DIRECTORY },
	)
	await plugin.event({ event: { type: "session.idle", properties: { sessionID } } })

	await new Promise((resolve) => setTimeout(resolve, 150))
	await plugin.tool.stop_idle_wake.execute({}, { sessionID, agent: "manager", directory: DIRECTORY })

	assert.equal(prompts.length, 1)
	const { body } = prompts[0]
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, undefined)
})
