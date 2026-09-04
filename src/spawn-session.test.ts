import test from "node:test"
import assert from "node:assert/strict"
import { INTER_AGENT_MARKER, buildEnvelope, parseOrigin } from "./interAgent.ts"
import { setSessionTitle, type SessionTitleClient } from "./sessionTitle.ts"

const from = { sessionID: "ses_fcb9a2e47ffe1moGAkhBuvMURO", agent: "build", directory: "/home/marenz/Projects/chronica" }

test("a delivered envelope round-trips back to its sender", () => {
	// The contract that makes `reply` work at all: whatever the builder writes,
	// the parser recovers. Asserting a literal string here instead would pass
	// while both drifted together.
	const origin = parseOrigin(buildEnvelope({ from, message: "do the thing" }))
	assert.deepEqual(origin, { agent: "build", sessionID: from.sessionID, directory: from.directory })
})

test("the optional envelope lines do not disturb the origin", () => {
	for (const extra of [
		{ note: "Reply: this answers the message you last sent to this session." },
		{ interrupted: true },
		{ switchedTo: "plan" },
		{ note: "Reply: this answers the message you last sent to this session.", interrupted: true, switchedTo: "plan" },
	]) {
		const origin = parseOrigin(buildEnvelope({ from, message: "m", ...extra }))
		assert.equal(origin?.sessionID, from.sessionID, `lost the sender with ${JSON.stringify(extra)}`)
		assert.equal(origin?.directory, from.directory)
	}
})

test("a message body that itself looks like an envelope does not hijack the origin", () => {
	// An agent quoting or forwarding a message it received is ordinary. The
	// origin must be the real sender, not the quoted one, so the parse has to
	// take the first From: line rather than the last.
	const quoted = buildEnvelope({ from: { sessionID: "ses_QUOTEDQUOTED", agent: "plan", directory: "/tmp/other" }, message: "inner" })
	const origin = parseOrigin(buildEnvelope({ from, message: `Here is what I was told:\n\n${quoted}` }))
	assert.equal(origin?.sessionID, from.sessionID)
})

test("an envelope from an older build, with no project clause, stays answerable", () => {
	// Messages delivered before the scope was recorded are still sitting in
	// session histories; reply falls back to the caller's own scope for them.
	const legacy = [
		INTER_AGENT_MARKER,
		`From: agent "build" in session ${from.sessionID}`,
		"Provenance: This message was authored and sent by another OpenCode agent.",
		"",
		"older message",
	].join("\n")
	assert.deepEqual(parseOrigin(legacy), { agent: "build", sessionID: from.sessionID, directory: undefined })
})

test("agent names are recovered verbatim, including awkward ones", () => {
	for (const agent of ["build", "general", "my agent", 'quote"inside', "agent-with-dash", "a_b"]) {
		const origin = parseOrigin(buildEnvelope({ from: { ...from, agent }, message: "m" }))
		assert.equal(origin?.agent, agent, `mangled ${JSON.stringify(agent)}`)
		assert.equal(origin?.sessionID, from.sessionID, `an odd agent name broke the session id for ${agent}`)
	}
})

test("text that is not an inter-agent message has no origin", () => {
	const idleWake = [
		"[IDLE WAKE]",
		"This is an automated reminder requested by this OpenCode agent, not a message from the user.",
		"The session remained idle for 5 minutes.",
	].join("\n")

	for (const text of [
		"",
		"just a normal user message",
		idleWake,
		// The marker without a parsable origin is not an answerable message.
		`${INTER_AGENT_MARKER}\nFrom: somebody\n\nbody`,
		// The line alone, without the marker, is prose about messaging.
		`From: agent "build" in session ${from.sessionID}`,
	]) {
		assert.equal(parseOrigin(text), undefined, `unexpectedly found an origin in ${JSON.stringify(text.slice(0, 40))}`)
	}
})

function clientWith(update: SessionTitleClient["session"]["update"]): SessionTitleClient {
	return { session: { update } }
}

test("setSessionTitle returns a confirmation with the session ID and title", async () => {
	const client = clientWith(async (input) => {
		assert.deepEqual(input, {
			path: { id: "ses_123" },
			query: { directory: "/home/marenz/Projects/chronica" },
			body: { title: "Fix session titles" },
		})
		return {}
	})

	assert.equal(
		await setSessionTitle(client, "ses_123", "Fix session titles", "/home/marenz/Projects/chronica"),
		"Set title for session ses_123 to Fix session titles.",
	)
})

test("setSessionTitle returns the SDK response error with the tool prefix", async () => {
	const client = clientWith(async () => ({ error: { message: "Session not found" } }))

	const result = await setSessionTitle(client, "ses_missing", "New title", "/tmp/work")
	assert.match(result, /^session_set_title: /)
	assert.match(result, /Session not found/)
})

test("setSessionTitle returns the first line of a thrown error with the tool prefix", async () => {
	const client = clientWith(async () => {
		throw new Error("Request failed\nresponse details")
	})

	const result = await setSessionTitle(client, "ses_123", "New title", "/tmp/work")
	assert.equal(result, "session_set_title: Request failed")
})
