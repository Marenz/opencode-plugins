import assert from "node:assert/strict"
import test from "node:test"
import { deliveryAgent, deliveryModel, deliveryVariant, variantRequest } from "./sessionAgents.ts"

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

test("an omitted variant argument is not a request at all", () => {
	assert.equal(variantRequest(undefined), undefined)
})

test("a variant argument of 'default' is a request for NO variant, not for a variant named 'default'", () => {
	// "default" is the server's own sentinel for "no variant chosen" — it is
	// what the server stores for an absent variant, and currentModelOf drops
	// it on the way in — so a caller passing it literally means "clear it".
	assert.deepEqual(variantRequest("default"), {})
	assert.deepEqual(variantRequest("   "), {})
})

test("a variant argument is trimmed", () => {
	assert.deepEqual(variantRequest("  high  "), { variant: "high" })
})

test("an omitted variant leaves the effective model's own variant in place", () => {
	assert.equal(deliveryVariant(undefined, { providerID: "openai", modelID: "gpt-6-astra", variant: "high" }), "high")
	assert.equal(deliveryVariant(undefined, { providerID: "openai", modelID: "gpt-6-astra" }), undefined)
	assert.equal(deliveryVariant(undefined, undefined), undefined)
})

test("an explicit variant wins over the effective model's own", () => {
	assert.equal(
		deliveryVariant({ variant: "max" }, { providerID: "openai", modelID: "gpt-6-astra", variant: "high" }),
		"max",
	)
})

test("an explicit request for no variant clears the model's own", () => {
	assert.equal(deliveryVariant({}, { providerID: "openai", modelID: "gpt-6-astra", variant: "high" }), undefined)
})

test("an explicit variant still applies when the session has no model recorded yet", () => {
	// The server takes `variant` as its own prompt-body field, applied to
	// whichever model it ends up resolving, so there is nothing to drop here.
	assert.equal(deliveryVariant({ variant: "high" }, undefined), "high")
})
