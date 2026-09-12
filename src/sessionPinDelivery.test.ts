import test from "node:test"
import assert from "node:assert/strict"
import spawnSessionPlugin from "./spawn-session.ts"

/**
 * Integration-level regression coverage for the session-pin feature: proves
 * the actual outgoing `session.prompt`/`session.update` payloads and a full
 * pin -> deliver -> unpin -> deliver lifecycle, against a STATEFUL fake
 * client (a session actually persists what it's told, across calls) rather
 * than the fixed-snapshot fake used by spawnSessionDelivery.test.ts — the
 * lifecycle is the point here.
 */

const DIRECTORY = "/home/marenz/Projects/cat-bowl"
const TARGET = "ses_target0000000000000000000"
const FROM_SESSION = "ses_sender0000000000000000000"

type SessionState = { agent?: string; model?: { id: string; providerID: string; variant?: string }; metadata?: Record<string, unknown> }

function statefulFakeClient(initial: Record<string, SessionState>) {
	const sessions = new Map(Object.entries(initial))
	const prompts: Array<{ id: string; body: Record<string, unknown> }> = []
	const updates: Array<{ id: string; body: Record<string, unknown> }> = []

	const client = {
		session: {
			async get({ path }: { path: { id: string } }) {
				const s = sessions.get(path.id) ?? {}
				return { data: { id: path.id, ...s } }
			},
			async update({ path, body }: { path: { id: string }; body: Record<string, unknown> }) {
				updates.push({ id: path.id, body })
				const s = sessions.get(path.id) ?? {}
				sessions.set(path.id, { ...s, ...body })
				return { data: { id: path.id, ...sessions.get(path.id) } }
			},
			async promptAsync({ path, body }: { path: { id: string }; body: Record<string, unknown> }) {
				prompts.push({ id: path.id, body })
				return {}
			},
			async status() {
				return { data: {} }
			},
			async messages() {
				return { data: [] }
			},
		},
		app: {
			log: async () => ({}),
			agents: async () => ({ data: [{ name: "build" }, { name: "manager" }, { name: "plan" }] }),
		},
		config: {
			providers: async () => ({
				data: {
					providers: [
						{ id: "openai", models: { "gpt-6-astra": { id: "gpt-6-astra", name: "GPT-6 Astra" } } },
						{
							id: "anthropic",
							models: {
								"claude-sonnet-5": { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
								"claude-fable-5": { id: "claude-fable-5", name: "Claude Fable 5" },
							},
						},
					],
				},
			}),
		},
	}
	return { client, sessions, prompts, updates }
}

async function callTool(client: unknown, tool: string, args: Record<string, unknown>, context: Record<string, unknown>) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	return plugin.tool[tool].execute(args, context)
}

const senderContext = { sessionID: FROM_SESSION, agent: "build", directory: DIRECTORY }

test("set_session_pin(enabled=true) snapshots the calling session's OWN current agent/model/variant", async () => {
	const { client, sessions, updates } = statefulFakeClient({
		[FROM_SESSION]: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai", variant: "thinking" } },
	})

	const result = await callTool(client, "set_session_pin", { enabled: true }, senderContext)

	assert.equal(updates.length, 1)
	assert.equal(updates[0].id, FROM_SESSION)
	assert.deepEqual((sessions.get(FROM_SESSION) as SessionState).metadata, {
		sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } },
	})
	assert.match(String(result), /Pinned session/)
})

test("set_session_pin preserves unrelated metadata already on the session", async () => {
	const { client, sessions } = statefulFakeClient({
		[FROM_SESSION]: {
			agent: "manager",
			model: { id: "gpt-6-astra", providerID: "openai" },
			metadata: { otherPlugin: { foo: "bar" } },
		},
	})

	await callTool(client, "set_session_pin", { enabled: true }, senderContext)

	const metadata = (sessions.get(FROM_SESSION) as SessionState).metadata as Record<string, unknown>
	assert.deepEqual(metadata.otherPlugin, { foo: "bar" })
	assert.ok(metadata.sessionPin)
})

test("set_session_pin(enabled=false) removes only the pin key, leaving other metadata untouched", async () => {
	const { client, sessions } = statefulFakeClient({
		[FROM_SESSION]: {
			agent: "manager",
			metadata: { otherPlugin: { foo: "bar" }, sessionPin: { agent: "manager" } },
		},
	})

	const result = await callTool(client, "set_session_pin", { enabled: false }, senderContext)

	assert.deepEqual((sessions.get(FROM_SESSION) as SessionState).metadata, { otherPlugin: { foo: "bar" } })
	assert.match(String(result), /Unpinned session/)
})

test("set_session_pin(enabled=true) refuses when the session has no agent or model recorded yet", async () => {
	const { client } = statefulFakeClient({ [FROM_SESSION]: {} })
	await assert.rejects(() => callTool(client, "set_session_pin", { enabled: true }, senderContext), /no recorded agent or model/)
})

test("re-pinning an already-pinned session with enabled=true overwrites the old pin with the session's NEW current state", async () => {
	// Explicit re-enable is a deliberate re-snapshot, not a no-op guarded by
	// "already pinned" — an agent that wants to update its own pin (e.g.
	// after a legitimate model switch) calls set_session_pin(true) again;
	// there is no separate "update pin" tool. This is intentional, not an
	// oversight: the tool is self-only and requires an explicit call either
	// way, so overwriting on re-enable can't be triggered by anyone but the
	// session itself choosing to call it again.
	const { client, sessions } = statefulFakeClient({
		[FROM_SESSION]: {
			agent: "manager",
			model: { id: "gpt-6-astra", providerID: "openai" },
			metadata: { sessionPin: { agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5" } } },
		},
	})

	await callTool(client, "set_session_pin", { enabled: true }, senderContext)

	assert.deepEqual((sessions.get(FROM_SESSION) as SessionState).metadata, {
		sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra" } },
	})
})

test("set_session_pin ignores an extraneous session_id argument: it always operates on the caller's own session", async () => {
	const other = "ses_other00000000000000000000"
	const { client, sessions } = statefulFakeClient({
		[FROM_SESSION]: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
		[other]: { agent: "build", model: { id: "claude-sonnet-5", providerID: "anthropic" } },
	})

	await callTool(client, "set_session_pin", { enabled: true, session_id: other }, senderContext)

	assert.ok((sessions.get(FROM_SESSION) as SessionState).metadata?.sessionPin, "caller's own session got pinned")
	assert.equal((sessions.get(other) as SessionState).metadata, undefined, "the named 'other' session was never touched")
})

test("an unaddressed delivery to a pinned session uses the pin, not the session's live (possibly different) state", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "build", // the pin below is for "manager" — proves the pin wins over the session's OWN live agent too
			model: { id: "claude-sonnet-5", providerID: "anthropic" },
			metadata: { sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } } },
		},
	})

	await callTool(client, "send_agent_message", { session_id: TARGET, message: "status" }, senderContext)

	assert.equal(prompts.length, 1)
	const body = prompts[0].body
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "thinking")
})

test("a PARTIAL pin (agent only) leaves the model field to the session's own LIVE current model, not omitted/reset", async () => {
	// The wiring guarantee this proves: an unpinned field of a partial pin
	// must fall through to currentModelOf(target) exactly like the fully
	// unpinned path does — not silently omit the field (which the server
	// would resolve to some default), and not silently reset it to nothing.
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "build",
			model: { id: "claude-sonnet-5", providerID: "anthropic", variant: "thinking" },
			metadata: { sessionPin: { agent: "manager" } }, // no model in the pin at all
		},
	})

	await callTool(client, "send_agent_message", { session_id: TARGET, message: "status" }, senderContext)

	const body = prompts[0].body
	assert.equal(body.agent, "manager") // from the pin
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-sonnet-5" }) // from the session's LIVE state, not omitted
	assert.equal(body.variant, "thinking")
})

test("a PARTIAL pin (model only) leaves the agent field to the session's own LIVE current agent", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "plan",
			model: { id: "gpt-6-astra", providerID: "openai" },
			metadata: { sessionPin: { model: { providerID: "openai", modelID: "gpt-6-astra" } } }, // no agent in the pin
		},
	})

	await callTool(client, "send_agent_message", { session_id: TARGET, message: "status" }, senderContext)

	const body = prompts[0].body
	assert.equal(body.agent, "plan") // from the session's LIVE state, not omitted
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" }) // from the pin
})

test("the same partial-pin fallback-to-live guarantee holds for the idle-wake watchdog too", async () => {
	const { client, sessions, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "build",
			model: { id: "claude-sonnet-5", providerID: "anthropic" },
			metadata: { sessionPin: { agent: "manager" } },
		},
	})
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	await plugin.tool.wake_after_idle.execute(
		{ minutes: 0.001 },
		{ sessionID: TARGET, agent: "manager", directory: DIRECTORY },
	)
	await plugin.event({ event: { type: "session.idle", properties: { sessionID: TARGET } } })
	await new Promise((resolve) => setTimeout(resolve, 150))
	await plugin.tool.stop_idle_wake.execute({}, { sessionID: TARGET, agent: "manager", directory: DIRECTORY })

	assert.equal(prompts.length, 1)
	const body = prompts[0].body
	assert.equal(body.agent, "manager") // from the pin
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-sonnet-5" }) // from LIVE state
	assert.equal(sessions.size, 1) // sanity: didn't accidentally create a session
})

test("an explicit agent conflicting with the pin is rejected, and no prompt is sent at all", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: { agent: "manager", metadata: { sessionPin: { agent: "manager" } } },
	})

	await assert.rejects(
		() => callTool(client, "send_agent_message", { session_id: TARGET, message: "switch", agent: "build" }, senderContext),
		/pinned to agent "manager"/,
	)
	assert.equal(prompts.length, 0)
})

test("an explicit model conflicting with the pin is rejected, and no prompt is sent at all", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "manager",
			metadata: { sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra" } } },
		},
	})

	await assert.rejects(
		() =>
			callTool(
				client,
				"send_agent_message",
				{ session_id: TARGET, message: "switch", model: "anthropic/claude-sonnet-5" },
				senderContext,
			),
		/pinned to model "openai\/gpt-6-astra"/,
	)
	assert.equal(prompts.length, 0)
})

test("an explicit model matching the pin keeps the pinned variant instead of dropping it", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "manager",
			metadata: {
				sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } },
			},
		},
	})

	await callTool(
		client,
		"send_agent_message",
		{ session_id: TARGET, message: "reaffirm", model: "openai/gpt-6-astra" },
		senderContext,
	)

	const body = prompts[0].body
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "thinking")
})

test("an explicit variant conflicting with the pinned one is rejected, and no prompt is sent at all", async () => {
	// The conservative reading of a pin: it locks the effort level too, so it
	// is a genuine lock rather than one with a hole in it where effort is
	// concerned.
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "manager",
			metadata: {
				sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "high" } },
			},
		},
	})

	await assert.rejects(
		() => callTool(client, "send_agent_message", { session_id: TARGET, message: "harder", variant: "max" }, senderContext),
		/pinned to variant "high"; refusing to switch it to "max"/,
	)
	assert.equal(prompts.length, 0)
})

test("asking a pinned session for a variant when the pin records none is refused too", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "manager",
			metadata: { sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra" } } },
		},
	})

	await assert.rejects(
		() => callTool(client, "send_agent_message", { session_id: TARGET, message: "harder", variant: "max" }, senderContext),
		/pinned to variant "default"; refusing to switch it to "max"/,
	)
	assert.equal(prompts.length, 0)
})

test("an explicit variant matching the pinned one is delivered, not refused", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "manager",
			metadata: {
				sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "high" } },
			},
		},
	})

	await callTool(client, "send_agent_message", { session_id: TARGET, message: "carry on", variant: "high" }, senderContext)

	const body = prompts[0].body
	assert.deepEqual(body.model, { providerID: "openai", modelID: "gpt-6-astra" })
	assert.equal(body.variant, "high")
})

test("an agent-only pin does not constrain the variant: it applies to the session's LIVE model", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: {
			agent: "build",
			model: { id: "claude-sonnet-5", providerID: "anthropic" },
			metadata: { sessionPin: { agent: "manager" } }, // no model in the pin, so nothing to say about its variant
		},
	})

	await callTool(client, "send_agent_message", { session_id: TARGET, message: "harder", variant: "max" }, senderContext)

	const body = prompts[0].body
	assert.equal(body.agent, "manager")
	assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-sonnet-5" })
	assert.equal(body.variant, "max")
})

test("full lifecycle: pin, deliver (uses pin), unpin, deliver again (ordinary preserve-current, no pin)", async () => {
	const { client, prompts } = statefulFakeClient({
		[TARGET]: { agent: "manager", model: { id: "gpt-6-astra", providerID: "openai" } },
	})

	// 1. Pin the target to its own current state (simulating the target
	//    session pinning itself from within — a separate call context for realism).
	await callTool(client, "set_session_pin", { enabled: true }, { sessionID: TARGET, agent: "manager", directory: DIRECTORY })

	// 2. An unaddressed delivery must be unaffected (matches current == pin here).
	await callTool(client, "send_agent_message", { session_id: TARGET, message: "one" }, senderContext)
	assert.equal(prompts[0].body.agent, "manager")
	assert.deepEqual(prompts[0].body.model, { providerID: "openai", modelID: "gpt-6-astra" })

	// 3. An explicit conflicting switch is refused while pinned.
	await assert.rejects(() =>
		callTool(client, "send_agent_message", { session_id: TARGET, message: "two", agent: "build" }, senderContext),
	)

	// 4. Unpin (from within the target session itself).
	await callTool(client, "set_session_pin", { enabled: false }, { sessionID: TARGET, agent: "manager", directory: DIRECTORY })

	// 5. The same explicit switch now succeeds — ordinary, unpinned behavior.
	await callTool(client, "send_agent_message", { session_id: TARGET, message: "three", agent: "build" }, senderContext)
	assert.equal(prompts[1].body.agent, "build")
})
