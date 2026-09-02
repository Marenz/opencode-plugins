import assert from "node:assert/strict"
import test from "node:test"
import { sessionAgent } from "./sessionAgents.ts"

test("a recorded session agent is inherited", () => {
	const agents = new Map([["worker", "general"]])
	assert.equal(sessionAgent(agents, "worker"), "general")
})

test("an explicit session agent wins over the recorded one", () => {
	const agents = new Map([["worker", "general"]])
	assert.equal(sessionAgent(agents, "worker", "build"), "build")
})

test("a session without a record stays agentless", () => {
	assert.equal(sessionAgent(new Map(), "manager"), undefined)
})
