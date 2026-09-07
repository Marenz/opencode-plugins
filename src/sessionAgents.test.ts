import assert from "node:assert/strict"
import test from "node:test"
import { deliveryAgent } from "./sessionAgents.ts"

test("an explicit agent is used to address the delivery", () => {
	assert.equal(deliveryAgent("build"), "build")
})

test("an omitted agent leaves the recipient's agent untouched", () => {
	// The regression: this must not fall back to any remembered agent for the
	// target session, or every reply after one explicit switch would keep
	// re-applying it.
	assert.equal(deliveryAgent(undefined), undefined)
})
