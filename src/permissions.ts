/**
 * A passive record of which sessions are parked on a permission confirmation.
 *
 * Why this exists at all: opencode's `SessionStatus` is `idle | retry | busy`,
 * and a session waiting for the user to answer a confirmation reports `busy` —
 * byte-identical to a session that is thinking, and to one wedged in a hung
 * tool call. There is no read-only route to ask: the server's session route
 * table carries exactly one permission entry,
 * `POST /session/:sessionID/permissions/:permissionID`, which *answers* a
 * request. So a manager session polling `list_sessions` cannot tell a worker
 * that needs the user from a worker that has died, and the only safe reading —
 * "assume it is alive" — is the one that strands the user.
 *
 * The bus does publish the facts (`permission.updated` when a request opens,
 * `permission.replied` when it is answered), so this module folds those two
 * events into queryable state.
 *
 * Two properties are deliberate:
 *
 *   - **It only observes.** Nothing here can grant a permission. The
 *     `permission.ask` hook, which *can* (its `output.status` is the decision),
 *     is not registered anywhere in this package. Read-only is a property of
 *     the code, not a convention.
 *   - **It does not repeat the request text by default.** A permission's
 *     `metadata` carries the literal tool call, and its `title` is derived from
 *     that call — for a bash request the title *is* the command line. Either can
 *     hold a credential. Truncating is not redaction: a secret near the front of
 *     a long command survives it, which is what the test here pins.
 *
 *     The escalation a manager needs to perform does not require the text. The
 *     user has to answer in their own TUI, where the full request is already
 *     displayed; "session X has been waiting 4 minutes on a bash confirmation"
 *     is a complete handover. So `metadata` is dropped on the way in and never
 *     reachable at all, and the title is withheld unless a caller explicitly
 *     asks for it — the manager runs on a different model from the session that
 *     raised the request, so passing it along is a real widening of who sees the
 *     command, not a formatting choice.
 *
 * Lifetime: the store lives as long as the plugin, which lives as long as the
 * server — and pending permissions are server memory too, dying with it. So the
 * observer cannot miss a permission that outlives it. What it *can* miss is one
 * opened before the plugin was reloaded mid-life, which is why
 * `PermissionLog.since` is reported alongside every "nothing pending" answer:
 * an empty result from a store that started after the request is not evidence.
 */

/** The `Permission` payload of a `permission.updated` event, as we use it. */
export type PermissionEvent = {
	id: string
	type: string
	pattern?: string | string[]
	sessionID: string
	messageID: string
	callID?: string
	title: string
	time: { created: number }
}

export type PendingPermission = {
	id: string
	session_id: string
	/** Permission key, e.g. "bash" or "edit". */
	type: string
	/** The matched rule pattern, where the request carries one. */
	pattern?: string
	/**
	 * The request's own description, truncated to one line. Present only when
	 * the caller opted in: it can reproduce a command line verbatim.
	 */
	title?: string
	created_at: string
	waiting_seconds: number
}

export type ResolvedPermission = {
	id: string
	session_id: string
	type: string
	title?: string
	response: string
	resolved_at: string
	seconds_ago: number
}

/**
 * Long enough to name a command and its subject, short enough that a pasted
 * file body or a long argument list is not reproduced into a manager's context.
 */
export const TITLE_MAX = 160

/** How many answered requests to remember per session, and for how long. */
export const RESOLVED_PER_SESSION = 5
export const RESOLVED_TTL_MS = 30 * 60_000

/**
 * One line, bounded. Newlines are collapsed rather than kept because a title is
 * printed inside a list and a multi-line one would look like several rows.
 */
export function summarizeTitle(title: string, max = TITLE_MAX) {
	const flat = title.replace(/\s+/g, " ").trim()
	if (flat.length <= max) return flat
	return `${flat.slice(0, max - 1).trimEnd()}…`
}

/** `pattern` is one rule or several; render it as one readable string. */
export function summarizePattern(pattern?: string | string[]) {
	if (pattern === undefined) return undefined
	const joined = Array.isArray(pattern) ? pattern.join(", ") : pattern
	const flat = joined.replace(/\s+/g, " ").trim()
	return flat.length ? summarizeTitle(flat) : undefined
}

type Entry = {
	id: string
	sessionID: string
	type: string
	pattern?: string
	title: string
	created: number
}

type Answered = Entry & { response: string; resolved: number }

export class PermissionLog {
	/** When this store started observing; see the module note on empty answers. */
	readonly since: number

	private readonly pending = new Map<string, Map<string, Entry>>()
	private readonly answered = new Map<string, Answered[]>()

	constructor(now = Date.now()) {
		this.since = now
	}

	/**
	 * Fold a `permission.updated` event.
	 *
	 * The event is an upsert — the same id can be republished — so the original
	 * `created` is kept. Waiting time is the question being asked of this store,
	 * and a re-publication is not the request starting again.
	 */
	opened(permission: PermissionEvent) {
		let bySession = this.pending.get(permission.sessionID)
		if (!bySession) {
			bySession = new Map()
			this.pending.set(permission.sessionID, bySession)
		}
		const existing = bySession.get(permission.id)
		bySession.set(permission.id, {
			id: permission.id,
			sessionID: permission.sessionID,
			type: permission.type,
			pattern: summarizePattern(permission.pattern),
			title: summarizeTitle(permission.title ?? ""),
			created: existing?.created ?? permission.time?.created ?? Date.now(),
		})
	}

	/**
	 * Fold a `permission.replied` event.
	 *
	 * An answer for something never seen open is ignored rather than invented:
	 * without the request we have no type or title, and a row saying only
	 * "something was answered" would be noise a manager cannot act on.
	 */
	replied(sessionID: string, permissionID: string, response: string, now = Date.now()) {
		const bySession = this.pending.get(sessionID)
		const entry = bySession?.get(permissionID)
		if (!bySession || !entry) return
		bySession.delete(permissionID)
		if (!bySession.size) this.pending.delete(sessionID)

		const history = this.answered.get(sessionID) ?? []
		history.push({ ...entry, response, resolved: now })
		// Newest first, bounded: this is a courtesy for a manager that polled a
		// moment too late, not an audit log.
		history.sort((a, b) => b.resolved - a.resolved)
		this.answered.set(sessionID, history.slice(0, RESOLVED_PER_SESSION))
	}

	/** Drop everything for a session that no longer exists. */
	forget(sessionID: string) {
		this.pending.delete(sessionID)
		this.answered.delete(sessionID)
	}

	/** Session ids with at least one open request. */
	blockedSessions(): Set<string> {
		return new Set(this.pending.keys())
	}

	isBlocked(sessionID: string) {
		return (this.pending.get(sessionID)?.size ?? 0) > 0
	}

	/** Open requests for one session, oldest first — the oldest is the blocker. */
	pendingFor(sessionID: string, now = Date.now(), includeText = false): PendingPermission[] {
		const bySession = this.pending.get(sessionID)
		if (!bySession) return []
		return [...bySession.values()]
			.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
			.map((entry) => view(entry, now, includeText))
	}

	/** Every open request across all sessions, oldest first. */
	allPending(now = Date.now(), includeText = false): PendingPermission[] {
		return [...this.pending.values()]
			.flatMap((bySession) => [...bySession.values()])
			.sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
			.map((entry) => view(entry, now, includeText))
	}

	/** Recently answered requests for one session, newest first. */
	recentlyResolved(sessionID: string, now = Date.now(), includeText = false): ResolvedPermission[] {
		const history = this.answered.get(sessionID)
		if (!history) return []
		const live = history.filter((entry) => now - entry.resolved <= RESOLVED_TTL_MS)
		if (live.length !== history.length) {
			if (live.length) this.answered.set(sessionID, live)
			else this.answered.delete(sessionID)
		}
		return live.map((entry) => ({
			id: entry.id,
			session_id: entry.sessionID,
			type: entry.type,
			...(includeText && entry.title ? { title: entry.title } : {}),
			response: entry.response,
			resolved_at: new Date(entry.resolved).toISOString(),
			seconds_ago: Math.max(0, Math.round((now - entry.resolved) / 1000)),
		}))
	}
}

/**
 * What an empty answer is and is not evidence of.
 *
 * Stated once, and deliberately not as "nothing older than this can exist": the
 * usual case is that the plugin loaded with the server and so has seen every
 * request the server ever had, but a mid-life plugin reload breaks that, and an
 * output that asserted the strong form could contradict a row printed beside it.
 */
export function observationCaveat(since: number) {
	return (
		`This observer began watching at ${new Date(since).toISOString()}. ` +
		"Pending permissions live in opencode's memory and do not survive a server restart, so in the ordinary case " +
		"(plugin loaded with the server) it has seen every request that exists. If the plugin was reloaded while the " +
		"server kept running, a request opened before that reload is invisible here — so treat an empty result from a " +
		"young observer as 'unknown', not as 'not blocked'."
	)
}

function view(entry: Entry, now: number, includeText: boolean): PendingPermission {
	return {
		id: entry.id,
		session_id: entry.sessionID,
		type: entry.type,
		...(entry.pattern ? { pattern: entry.pattern } : {}),
		// Withheld unless asked for: the title can be a verbatim command line.
		...(includeText && entry.title ? { title: entry.title } : {}),
		created_at: new Date(entry.created).toISOString(),
		waiting_seconds: Math.max(0, Math.round((now - entry.created) / 1000)),
	}
}

/**
 * The one sentence a manager needs, derived in one place so the tool and the
 * session listing cannot come to different conclusions about the same session.
 *
 * The distinction being drawn: `busy` with an open request is *waiting on the
 * user* and must be escalated, never retried or replaced; `busy` without one is
 * genuinely running or genuinely wedged, and this store cannot tell those apart
 * — so it says so rather than guessing.
 */
export function verdictFor(input: {
	status: string
	pending: PendingPermission[]
	resolved?: ResolvedPermission[]
	observingSince: number
	now?: number
}) {
	const now = input.now ?? Date.now()
	if (input.pending.length) {
		const oldest = input.pending[0]
		const others = input.pending.length > 1 ? ` (+${input.pending.length - 1} more)` : ""
		return `awaiting_permission — blocked on a user confirmation for ${oldest.waiting_seconds}s: ${oldest.type}${others}. Escalate to the user; the session is alive and cannot proceed until they answer. Do not interrupt or respawn it.`
	}

	const justAnswered = input.resolved?.[0]
	if (input.status === "busy") {
		const recent =
			justAnswered && justAnswered.seconds_ago <= 120
				? ` A permission was answered ${justAnswered.seconds_ago}s ago (${justAnswered.response}), so it has just been unblocked.`
				: ""
		const blind = input.observingSince > now - 60_000 ? " Note: this observer started under a minute ago, so it may not have seen an older request." : ""
		return `busy, no permission pending — working or stuck; this cannot distinguish those.${recent}${blind} Check its last activity before assuming it is dead.`
	}
	if (input.status === "idle") {
		return "idle — not blocked on anything. It has finished its turn, so if you expected a report, ask it."
	}
	return `${input.status} — not blocked on a permission.`
}
