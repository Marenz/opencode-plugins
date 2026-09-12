import test from "node:test"
import assert from "node:assert/strict"
import spawnSessionPlugin from "./spawn-session.ts"
import { buildEnvelope } from "./interAgent.ts"

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
const SPAWNED = "ses_spawned000000000000000000"

type PromptCall = { body: Record<string, unknown> }

/**
 * Provider fixtures mirroring what the live `/config/providers` reports
 * (checked against opencode 1.18.30): every model carries a `variants` key,
 * most with effort levels in it, and a few with an empty map. The empty one
 * is load-bearing for the "cannot validate, pass it through" rule.
 */
const PROVIDERS = [
	{
		id: "openai",
		models: {
			"gpt-6-astra": {
				id: "gpt-6-astra",
				name: "GPT-6 Astra",
				variants: { low: {}, medium: {}, high: {}, max: {} },
			},
		},
	},
	{
		id: "anthropic",
		models: {
			"claude-fable-5": { id: "claude-fable-5", name: "Claude Fable 5", variants: { high: {}, max: {} } },
		},
	},
	{ id: "opencode", models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", variants: {} } } },
]

function fakeClient(opts: {
	targetSession: { agent?: string; model?: unknown }
	agents?: string[]
	/** When set, `session.messages` (queried against FROM_SESSION) returns
	 * one inbound envelope from the target, so `reply` can resolve it. */
	inboundFrom?: { agent: string; sessionID: string; directory: string }
}) {
	const prompts: PromptCall[] = []
	const created: Array<Record<string, unknown>> = []
	const deleted: string[] = []
	const client = {
		session: {
			async get() {
				return { data: { id: TARGET, ...opts.targetSession } }
			},
			async create({ body }: { body: Record<string, unknown> }) {
				created.push(body)
				return { data: { id: SPAWNED } }
			},
			async delete({ path }: { path: { id: string } }) {
				deleted.push(path.id)
				return {}
			},
			async promptAsync({ body }: { body: Record<string, unknown> }) {
				prompts.push({ body })
				return {}
			},
			async status() {
				return { data: {} }
			},
			async messages() {
				if (!opts.inboundFrom) {
					// A plain user message: invisible to parseOrigin (so `reply`
					// still reports "nothing to reply to"), but enough for
					// spawn_session's waitForInitialMessage to see a live session.
					return { data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }] }
				}
				const text = buildEnvelope({ from: opts.inboundFrom, message: "original message" })
				return { data: [{ info: { role: "user" }, parts: [{ type: "text", text }] }] }
			},
		},
		app: {
			async agents() {
				return { data: (opts.agents ?? ["build", "plan", "manager"]).map((name) => ({ name })) }
			},
		},
		config: {
			async providers() {
				return { data: { providers: PROVIDERS } }
			},
		},
	}
	return { client, prompts, created, deleted }
}

async function sendAgentMessage(client: unknown, args: Record<string, unknown>) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	return plugin.tool.send_agent_message.execute(args, {
		sessionID: FROM_SESSION,
		agent: "build",
		directory: DIRECTORY,
	})
}

async function sendReply(client: unknown, args: Record<string, unknown>) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	return plugin.tool.reply.execute(args, {
		sessionID: FROM_SESSION,
		agent: "build",
		directory: DIRECTORY,
	})
}

async function spawnSession(client: unknown, args: Record<string, unknown>) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	return plugin.tool.spawn_session.execute({ title: "worker", prompt: "do the thing", ...args }, {
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

test("a session whose model field is a wholly wrong type (not an object) does not crash currentModelOf", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "build", model: "not-an-object" as unknown },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "hi" })

	const { body } = prompts[0]
	assert.equal(body.agent, "build")
	assert.equal(body.model, undefined)
})

test("reply() carries the exact same omitted-agent/model preservation as send_agent_message", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "default" } },
		inboundFrom: { agent: "manager", sessionID: TARGET, directory: DIRECTORY },
	})
	await sendReply(client, { message: "here's the finding" })

	assert.equal(prompts.length, 1)
	const { body } = prompts[0]
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, undefined)
})

test("reply() with an explicit model override behaves the same as send_agent_message's", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "claude-fable-5", providerID: "anthropic", variant: "thinking" } },
		inboundFrom: { agent: "manager", sessionID: TARGET, directory: DIRECTORY },
	})
	await sendReply(client, { message: "switching", model: "openai/gpt-6-astra" })

	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, undefined)
})

test(
	"SCOPE NOTE (not a bug fix, documents current behavior): an explicit model matching the " +
		"session's own current model+provider still drops its variant, same as any other explicit switch — " +
		"there is no 'reaffirm the same model, keep the variant' path, and no tool parameter to request one",
	async () => {
		const { client, prompts } = fakeClient({
			targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "thinking" } },
		})
		// Same provider/model as the session is already running, passed explicitly.
		await sendAgentMessage(client, { session_id: TARGET, message: "hi", model: "openai/gpt-6-astra" })

		const { body } = prompts[0]
		assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
		// If this test starts failing because the tool grows a way to request
		// same-model-keep-variant, update this assertion deliberately — do not
		// "fix" it by guessing what should happen instead.
		assert.equal(body.variant, undefined)
	},
)

test("an explicit variant with no model applies to the session's OWN current model", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "think harder", variant: "max" })

	const { body } = prompts[0]
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "max")
})

test("an explicit variant replaces the variant the session is already running", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "low" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "think harder", variant: "high" })

	assert.equal(prompts[0].body.variant, "high")
})

test("an explicit model plus an explicit variant applies both together", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "high" } },
	})
	await sendAgentMessage(client, {
		session_id: TARGET,
		message: "switch",
		model: "anthropic/claude-fable-5",
		variant: "max",
	})

	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-fable-5" })
	assert.equal(body.variant, "max")
})

test("variant 'default' explicitly clears the variant the session is running, rather than naming one", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "high" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "ease off", variant: "default" })

	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal("variant" in body, false, "the sentinel must not be sent back as a literal variant name")
})

test("no variant argument sends no variant key at all", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "status" })

	assert.equal("variant" in prompts[0].body, false)
})

test("a variant the model does not advertise is refused, listing the ones it has, without prompting", async () => {
	// The server would not catch this: an unknown variant resolves to an empty
	// options object, so the typo silently does nothing and then sticks to the
	// session as its recorded variant.
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
	})
	await assert.rejects(
		() => sendAgentMessage(client, { session_id: TARGET, message: "hi", variant: "xhigh" }),
		/Unknown variant "xhigh" for openai\/gpt-6-astra\. Available variants: high, low, max, medium/,
	)
	assert.equal(prompts.length, 0)
})

test("a model advertising an EMPTY variants map cannot be validated against, so the variant passes through", async () => {
	// An empty or absent map means "this server cannot tell us", never "this
	// model has no valid variants" — an older server must not have every
	// variant request rejected.
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "big-pickle", providerID: "opencode" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "hi", variant: "high" })

	assert.equal(prompts[0].body.variant, "high")
})

test("a model the provider list does not know at all is not validated against either", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gone-from-the-list", providerID: "openai" } },
	})
	await sendAgentMessage(client, { session_id: TARGET, message: "hi", variant: "high" })

	assert.equal(prompts[0].body.variant, "high")
})

test("reply() carries an explicit variant exactly like send_agent_message", async () => {
	const { client, prompts } = fakeClient({
		targetSession: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
		inboundFrom: { agent: "manager", sessionID: TARGET, directory: DIRECTORY },
	})
	await sendReply(client, { message: "answering", variant: "high" })

	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "high")
})

test("spawn_session forwards an explicit model plus variant to the new session's first prompt", async () => {
	const { client, prompts, created } = fakeClient({ targetSession: {} })
	const result = await spawnSession(client, { model: "anthropic/claude-fable-5", variant: "max" })

	assert.equal(created.length, 1)
	const { body } = prompts[0]
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-fable-5" })
	assert.equal(body.variant, "max")
	assert.match(String(result), /with variant max/)
})

test("spawn_session with a variant but no model passes it through unvalidated, for the agent's own model", async () => {
	// Which model an omitted `model` resolves to is the agent's business,
	// server-side, so there is nothing here to validate the variant against.
	const { client, prompts } = fakeClient({ targetSession: {} })
	await spawnSession(client, { variant: "whatever-the-agent-has" })

	assert.equal(prompts[0].body.variant, "whatever-the-agent-has")
	assert.equal(prompts[0].body.model, undefined)
})

test("spawn_session rejects a variant its explicit model does not have, before creating the session", async () => {
	const { client, created, prompts } = fakeClient({ targetSession: {} })
	await assert.rejects(
		() => spawnSession(client, { model: "anthropic/claude-fable-5", variant: "low" }),
		/Unknown variant "low" for anthropic\/claude-fable-5\. Available variants: high, max/,
	)
	assert.equal(created.length, 0, "no half-born session left behind")
	assert.equal(prompts.length, 0)
})

test("spawn_session without a variant sends no variant key", async () => {
	const { client, prompts } = fakeClient({ targetSession: {} })
	await spawnSession(client, { model: "openai/gpt-6-astra" })

	assert.equal("variant" in prompts[0].body, false)
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
