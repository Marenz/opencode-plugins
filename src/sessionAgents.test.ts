import assert from "node:assert/strict"
import test from "node:test"
import { deliveryAgent, deliveryModel } from "./sessionAgents.ts"

test("an explicit agent wins over the session's current one", () => {
	assert.equal(deliveryAgent("build", "plan"), "build")
})

test("an omitted agent re-addresses the session as its own current agent", () => {
	// The regression: the server has no "leave it alone" primitive for an
	// omitted `agent` field — it resolves to the global default agent
	// instead. So "no change" has to be spelled out explicitly as the
	// session's own current agent, not as `undefined`.
	assert.equal(deliveryAgent(undefined, "plan"), "plan")
})

test("a brand new session with no agent yet stays agentless", () => {
	assert.equal(deliveryAgent(undefined, undefined), undefined)
})

test("an explicit model wins over the session's current one", () => {
	assert.deepEqual(
		deliveryModel({ providerID: "anthropic", modelID: "claude-fable-5" }, { providerID: "openai", modelID: "gpt-6-astra" }),
		{ providerID: "anthropic", modelID: "claude-fable-5" },
	)
})

test("an omitted model re-addresses the session as its own current model", () => {
	// The regression: preserving `agent` while omitting `model` still lets
	// the server fall through to that agent's own configured model, flipping
	// away from whatever the session was actually running.
	assert.deepEqual(deliveryModel(undefined, { providerID: "openai", modelID: "gpt-6-astra" }), {
		providerID: "openai",
		modelID: "gpt-6-astra",
	})
})

test("a brand new session with no model yet stays modelless", () => {
	assert.equal(deliveryModel(undefined, undefined), undefined)
})

test("an omitted model preserves a non-default variant", () => {
	assert.deepEqual(
		deliveryModel(undefined, { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" }),
		{ providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
	)
})

test("an explicit model switch does not carry over the old variant", () => {
	// A variant is a variant of a specific model; switching models drops it.
	assert.deepEqual(
		deliveryModel(
			{ providerID: "anthropic", modelID: "claude-fable-5" },
			{ providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
		),
		{ providerID: "anthropic", modelID: "claude-fable-5" },
	)
})
