import assert from "node:assert/strict"
import test from "node:test"
import { deliveryAgent } from "./sessionAgents.ts"

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
