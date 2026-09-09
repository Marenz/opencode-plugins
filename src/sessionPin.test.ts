import assert from "node:assert/strict"
import test from "node:test"
import {
	buildPinSnapshot,
	mergePinIntoMetadata,
	readPin,
	resolveDeliveryAgainstPin,
	SESSION_PIN_METADATA_KEY,
} from "./sessionPin.ts"

test("a session with no agent or model yet has nothing to pin", () => {
	assert.equal(buildPinSnapshot(undefined, undefined), undefined)
})

test("buildPinSnapshot captures whatever fields are actually present", () => {
	assert.deepEqual(buildPinSnapshot("manager", undefined), { agent: "manager" })
	assert.deepEqual(buildPinSnapshot(undefined, { providerID: "openai", modelID: "gpt-6-astra" }), {
		model: { providerID: "openai", modelID: "gpt-6-astra" },
	})
	assert.deepEqual(buildPinSnapshot("manager", { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" }), {
		agent: "manager",
		model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
	})
})

test("mergePinIntoMetadata sets only its own key, preserving unrelated metadata", () => {
	const existing = { otherPlugin: { foo: "bar" } }
	const merged = mergePinIntoMetadata(existing, { agent: "manager" })
	assert.deepEqual(merged, { otherPlugin: { foo: "bar" }, sessionPin: { agent: "manager" } })
	// the input object itself is not mutated
	assert.deepEqual(existing, { otherPlugin: { foo: "bar" } })
})

test("mergePinIntoMetadata with no pin removes only its own key", () => {
	const existing = { otherPlugin: { foo: "bar" }, [SESSION_PIN_METADATA_KEY]: { agent: "build" } }
	assert.deepEqual(mergePinIntoMetadata(existing, undefined), { otherPlugin: { foo: "bar" } })
})

test("mergePinIntoMetadata works from no existing metadata at all", () => {
	assert.deepEqual(mergePinIntoMetadata(undefined, { agent: "manager" }), { sessionPin: { agent: "manager" } })
})

test("readPin round-trips a full snapshot", () => {
	const metadata = { sessionPin: { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } } }
	assert.deepEqual(readPin(metadata), {
		agent: "manager",
		model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
	})
})

test("readPin is defensive against missing, malformed, or wrong-typed metadata", () => {
	assert.equal(readPin(undefined), undefined)
	assert.equal(readPin(null), undefined)
	assert.equal(readPin("not an object"), undefined)
	assert.equal(readPin({}), undefined)
	assert.equal(readPin({ sessionPin: "not an object" }), undefined)
	assert.equal(readPin({ sessionPin: {} }), undefined)
	assert.equal(readPin({ sessionPin: { agent: 123 } }), undefined)
	assert.equal(readPin({ sessionPin: { model: { providerID: "openai" } } }), undefined) // missing modelID
	assert.equal(readPin({ sessionPin: { model: "not an object" } }), undefined)
})

test("readPin keeps a valid agent even when the model half is malformed", () => {
	assert.deepEqual(readPin({ sessionPin: { agent: "manager", model: "garbage" } }), { agent: "manager" })
})

test("resolveDeliveryAgainstPin: an omitted agent/model defers entirely to the pin", () => {
	const pin = { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } }
	assert.deepEqual(resolveDeliveryAgainstPin(pin, undefined, undefined), {
		agent: "manager",
		model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
	})
})

test("resolveDeliveryAgainstPin: an explicit agent/model matching the pin keeps the pinned variant", () => {
	// The regression this exists to prevent: the general (unpinned) "explicit
	// model" path never carries a variant (resolveModel has no variant field),
	// so naively reusing that path here would silently drop the pin's variant
	// even though the caller asked for exactly the model that's pinned.
	const pin = { agent: "manager", model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" } }
	const result = resolveDeliveryAgainstPin(pin, "manager", { providerID: "openai", modelID: "gpt-6-astra" })
	assert.deepEqual(result, {
		agent: "manager",
		model: { providerID: "openai", modelID: "gpt-6-astra", variant: "thinking" },
	})
})

test("resolveDeliveryAgainstPin: an explicit conflicting agent is reported, not silently overridden or applied", () => {
	const pin = { agent: "manager" }
	const result = resolveDeliveryAgainstPin(pin, "build", undefined)
	assert.deepEqual(result, { conflict: { field: "agent", pinned: "manager", requested: "build" } })
})

test("resolveDeliveryAgainstPin: an explicit conflicting model is reported", () => {
	const pin = { model: { providerID: "openai", modelID: "gpt-6-astra" } }
	const result = resolveDeliveryAgainstPin(pin, undefined, { providerID: "anthropic", modelID: "claude-fable-5" })
	assert.deepEqual(result, {
		conflict: { field: "model", pinned: "openai/gpt-6-astra", requested: "anthropic/claude-fable-5" },
	})
})

test("resolveDeliveryAgainstPin: a partial pin (agent only) leaves the model field to the caller", () => {
	const pin = { agent: "manager" }
	const result = resolveDeliveryAgainstPin(pin, undefined, { providerID: "anthropic", modelID: "claude-fable-5" })
	assert.deepEqual(result, { agent: "manager", model: { providerID: "anthropic", modelID: "claude-fable-5" } })
})

test("resolveDeliveryAgainstPin: a partial pin (model only) leaves the agent field to the caller", () => {
	const pin = { model: { providerID: "openai", modelID: "gpt-6-astra" } }
	const result = resolveDeliveryAgainstPin(pin, "build", undefined)
	assert.deepEqual(result, { agent: "build", model: { providerID: "openai", modelID: "gpt-6-astra" } })
})
