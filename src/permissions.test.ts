import test from "node:test"
import assert from "node:assert/strict"
import {
	PermissionLog,
	RESOLVED_PER_SESSION,
	RESOLVED_TTL_MS,
	TITLE_MAX,
	observationCaveat,
	summarizePattern,
	summarizeTitle,
	verdictFor,
	type PermissionEvent,
} from "./permissions.ts"

const T0 = Date.UTC(2026, 7, 28, 12, 0, 0)

function ask(overrides: Partial<PermissionEvent> & { id: string; sessionID: string }): PermissionEvent {
	return {
		type: "bash",
		messageID: "msg_1",
		callID: "call_1",
		title: "git push origin main",
		time: { created: T0 },
		...overrides,
	}
}

test("a session waiting on a confirmation is distinguishable from one that is merely busy", () => {
	// The whole point: `busy` is what opencode reports for both, so the store
	// has to be the discriminator.
	const log = new PermissionLog(T0)
	assert.equal(log.isBlocked("ses_a"), false)
	log.opened(ask({ id: "per_1", sessionID: "ses_a" }))
	assert.equal(log.isBlocked("ses_a"), true)
	assert.equal(log.isBlocked("ses_b"), false, "another session must not inherit the block")

	const busy = verdictFor({ status: "busy", pending: log.pendingFor("ses_a", T0), observingSince: T0, now: T0 })
	const alive = verdictFor({ status: "busy", pending: [], observingSince: T0 - 3_600_000, now: T0 })
	assert.match(busy, /awaiting_permission/)
	assert.doesNotMatch(alive, /awaiting_permission/)
	assert.match(alive, /cannot distinguish/, "a busy session with nothing pending must not be claimed as dead or alive")
})

test("a republished permission.updated does not restart the clock or duplicate the row", () => {
	// The event is an upsert and opencode may publish it more than once. Waiting
	// time is the question being asked of this store, so a re-publication must
	// not reset it, and two rows for one request would overstate the blockage.
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_1", sessionID: "ses_a" }))
	log.opened(ask({ id: "per_1", sessionID: "ses_a", time: { created: T0 + 60_000 }, title: "git push --force" }))

	const pending = log.pendingFor("ses_a", T0 + 90_000, true)
	assert.equal(pending.length, 1)
	assert.equal(pending[0].waiting_seconds, 90, "the re-publication restarted the clock")
	assert.equal(pending[0].title, "git push --force", "the newest description should win")
})

test("an answer before the query leaves the session unblocked and briefly explained", () => {
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_1", sessionID: "ses_a" }))
	log.replied("ses_a", "per_1", "once", T0 + 5_000)

	assert.equal(log.isBlocked("ses_a"), false)
	assert.deepEqual(log.pendingFor("ses_a", T0 + 5_000), [])

	const resolved = log.recentlyResolved("ses_a", T0 + 10_000)
	assert.equal(resolved.length, 1)
	assert.equal(resolved[0].response, "once")
	assert.equal(resolved[0].seconds_ago, 5)

	// A manager polling just after the answer should be told it was unblocked,
	// not left to read a bare "busy" as a hang.
	const verdict = verdictFor({ status: "busy", pending: [], resolved, observingSince: T0, now: T0 + 10_000 })
	assert.match(verdict, /answered 5s ago \(once\)/)
})

test("an answer to a request that was never observed is ignored rather than invented", () => {
	// Without the opening event there is no type or title, and a row saying only
	// "something was answered" is noise a manager cannot act on.
	const log = new PermissionLog(T0)
	log.replied("ses_a", "per_ghost", "always", T0 + 1_000)
	assert.deepEqual(log.recentlyResolved("ses_a", T0 + 1_000), [])
	assert.equal(log.isBlocked("ses_a"), false)
})

test("answering one of several requests leaves the others blocking", () => {
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_1", sessionID: "ses_a", time: { created: T0 } }))
	log.opened(ask({ id: "per_2", sessionID: "ses_a", type: "edit", time: { created: T0 + 1_000 } }))
	log.replied("ses_a", "per_2", "reject", T0 + 2_000)

	const pending = log.pendingFor("ses_a", T0 + 2_000)
	assert.equal(log.isBlocked("ses_a"), true)
	assert.deepEqual(
		pending.map((entry) => entry.id),
		["per_1"],
	)
	assert.match(
		verdictFor({ status: "busy", pending, observingSince: T0, now: T0 + 2_000 }),
		/awaiting_permission/,
	)
})

test("the oldest request leads, and extras are counted rather than listed", () => {
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_late", sessionID: "ses_a", type: "edit", time: { created: T0 + 10_000 } }))
	log.opened(ask({ id: "per_early", sessionID: "ses_a", type: "bash", time: { created: T0 } }))

	const pending = log.pendingFor("ses_a", T0 + 10_000)
	assert.deepEqual(
		pending.map((entry) => entry.id),
		["per_early", "per_late"],
		"the blocker is the oldest request, so it must sort first",
	)
	const verdict = verdictFor({ status: "busy", pending, observingSince: T0, now: T0 + 10_000 })
	assert.match(verdict, /bash/)
	assert.match(verdict, /\+1 more/)
})

test("a disposed session takes its records with it", () => {
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_1", sessionID: "ses_a" }))
	log.opened(ask({ id: "per_2", sessionID: "ses_b" }))
	log.replied("ses_b", "per_2", "once", T0 + 1_000)

	log.forget("ses_a")
	log.forget("ses_b")

	assert.equal(log.isBlocked("ses_a"), false)
	assert.deepEqual(log.allPending(T0 + 1_000), [], "a deleted session must not keep reporting a block forever")
	assert.deepEqual(log.recentlyResolved("ses_b", T0 + 1_000), [])
	assert.deepEqual([...log.blockedSessions()], [])
})

test("cross-session listing is by request age, not by session", () => {
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_b", sessionID: "ses_b", time: { created: T0 + 5_000 } }))
	log.opened(ask({ id: "per_a", sessionID: "ses_a", time: { created: T0 } }))

	assert.deepEqual(
		log.allPending(T0 + 5_000).map((entry) => [entry.session_id, entry.waiting_seconds]),
		[
			["ses_a", 5],
			["ses_b", 0],
		],
	)
})

test("answered history is bounded and expires", () => {
	const log = new PermissionLog(T0)
	for (let i = 0; i < RESOLVED_PER_SESSION + 4; i++) {
		log.opened(ask({ id: `per_${i}`, sessionID: "ses_a", time: { created: T0 + i } }))
		log.replied("ses_a", `per_${i}`, "once", T0 + i)
	}
	const kept = log.recentlyResolved("ses_a", T0 + 100)
	assert.equal(kept.length, RESOLVED_PER_SESSION, "this is a courtesy for a late poll, not an audit log")
	assert.equal(kept[0].id, `per_${RESOLVED_PER_SESSION + 3}`, "newest first")

	assert.deepEqual(log.recentlyResolved("ses_a", T0 + RESOLVED_TTL_MS + 1_000), [])
})

test("the request text is withheld by default, because truncating it is not redacting it", () => {
	// A permission's metadata is the literal tool call and its title is derived
	// from that call — for bash the title *is* the command line. A secret near
	// the front survives truncation, so length is no protection; the default has
	// to be omission. This test failed when the title was returned unconditionally
	// and truncation was mistaken for sanitisation.
	const secret = "export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY"
	const log = new PermissionLog(T0)
	log.opened({
		...ask({ id: "per_1", sessionID: "ses_a" }),
		title: `run a script ${secret} ${"x".repeat(500)}`,
		metadata: { command: secret },
	} as PermissionEvent)
	log.opened(ask({ id: "per_2", sessionID: "ses_a", title: `deploy ${secret}`, time: { created: T0 + 1 } }))
	log.replied("ses_a", "per_2", "once", T0 + 2)

	for (const serialized of [
		JSON.stringify(log.pendingFor("ses_a", T0)),
		JSON.stringify(log.allPending(T0)),
		JSON.stringify(log.recentlyResolved("ses_a", T0 + 2)),
	]) {
		assert.equal(serialized.includes("wJalrXUtnFEMIK"), false, "a secret from the request reached the caller")
		assert.equal(serialized.includes("metadata"), false, "metadata must never be reachable at all")
		assert.equal(serialized.includes("title"), false, "the request text is opt-in")
	}

	// Still enough to escalate: which session, what kind of request, how long.
	const [blocker] = log.pendingFor("ses_a", T0)
	assert.equal(blocker.type, "bash")
	assert.equal(blocker.session_id, "ses_a")
	assert.equal(typeof blocker.waiting_seconds, "number")
})

test("asking for the request text returns it, bounded to one line", () => {
	// The opt-in exists for the case where a manager must actually describe the
	// request. It is still one bounded line, and metadata is not reachable even
	// here — that is dropped on the way in, not filtered on the way out.
	const log = new PermissionLog(T0)
	log.opened({
		...ask({ id: "per_1", sessionID: "ses_a" }),
		title: `run\na script ${"x".repeat(500)}`,
		metadata: { command: "secret" },
	} as PermissionEvent)

	const [blocker] = log.pendingFor("ses_a", T0, true)
	assert.ok(blocker.title, "the opt-in did not return the title")
	assert.ok(blocker.title.length <= TITLE_MAX)
	assert.doesNotMatch(blocker.title, /\n/, "a title is one line, since it is printed inside a list")
	assert.equal(JSON.stringify(blocker).includes("metadata"), false)
})

test("a title is one bounded line and a pattern is one readable string", () => {
	assert.equal(summarizeTitle("  a\n\n  b  "), "a b")
	assert.equal(summarizeTitle("abcdef", 4), "abc…")
	assert.equal(summarizeTitle("abcd", 4), "abcd", "an exact fit must not be truncated")

	assert.equal(summarizePattern(undefined), undefined)
	assert.equal(summarizePattern("git *"), "git *")
	assert.equal(summarizePattern(["git *", "rm *"]), "git *, rm *")
	assert.equal(summarizePattern("   "), undefined, "an empty pattern is no pattern")
})

test("a store that has only just started admits it might be blind", () => {
	// An empty result from an observer younger than the session is not evidence
	// the session is unblocked, and a manager must not read it as one.
	const fresh = verdictFor({ status: "busy", pending: [], observingSince: T0 - 5_000, now: T0 })
	const settled = verdictFor({ status: "busy", pending: [], observingSince: T0 - 3_600_000, now: T0 })
	assert.match(fresh, /may not have seen an older request/)
	assert.doesNotMatch(settled, /may not have seen an older request/)
})

test("the caveat does not claim more than the observer knows", () => {
	// It must not assert "nothing older than this can exist": a reload breaks
	// that, and the claim could contradict a row printed beside it.
	const caveat = observationCaveat(T0)
	assert.match(caveat, /1970|2026-08-28T12:00:00\.000Z/)
	assert.doesNotMatch(caveat, /nothing older/)
	assert.match(caveat, /reloaded/, "the one case it can be wrong must be named")
	assert.match(caveat, /'unknown', not as 'not blocked'/)
})

test("an idle session is reported as finished, not as blocked", () => {
	const verdict = verdictFor({ status: "idle", pending: [], observingSince: T0 - 3_600_000, now: T0 })
	assert.match(verdict, /^idle/)
	assert.doesNotMatch(verdict, /awaiting_permission/)
})

test("a pending request outranks the session's reported status", () => {
	// Ordering matters: a session can be reported `retry` or even momentarily
	// `idle` while a confirmation is open, and the block is the actionable fact.
	const log = new PermissionLog(T0)
	log.opened(ask({ id: "per_1", sessionID: "ses_a" }))
	for (const status of ["busy", "idle", "retry", "unknown"]) {
		assert.match(
			verdictFor({ status, pending: log.pendingFor("ses_a", T0), observingSince: T0, now: T0 }),
			/awaiting_permission/,
			`status ${status} swallowed the block`,
		)
	}
})
