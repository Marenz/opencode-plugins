/**
 * Pure, testable logic for `list_sessions`' opt-in `include_todo`, kept
 * out of spawn-session.ts for the same reason interAgent.ts is: a plugin file
 * may only export its plugin factory, so anything worth unit testing has to
 * live in an imported module instead.
 *
 * A todo summary is a snapshot of how far a session's todo list has got. It counts
 * items, not time or effort, and says nothing about whether the session has
 * actually finished: a worker can still be wrapping up after its last item,
 * so a manager keeps waiting for the worker's own final report. There is no
 * percentage: it follows from `completed` and `total`, which cannot be
 * recovered from it.
 */

/** How many todo requests `list_sessions` has in flight at once. */
export const TODO_CONCURRENCY = 4

export type TodoSummary = {
	/** Completed items. */
	completed: number
	/** Items that are not cancelled; cancelling never counts as completing. Zero for an empty or all-cancelled list. */
	total: number
	cancelled: number
	/** What is being worked on now: the in-progress items, in list order, each on one line. */
	in_progress: string[]
}

/** Null when the todo could not be read: the request failed or the answer was not a list. It says nothing about the todo. */
export type SessionTodo = TodoSummary | null

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/**
 * Turns the answer of the todo endpoint into a todo summary. Nothing about it is
 * trusted: anything that is not a list, or holds something that is not an
 * object, is null as a whole, since dropping the odd item would shift every
 * count. Only `content` and `status` are read; the runtime also sends a
 * priority, and the generated types declare an id the runtime omits. An
 * unknown status stays in the total without counting as completed.
 */
export function summarizeTodos(raw: unknown): SessionTodo {
	if (!Array.isArray(raw)) return null
	let completed = 0
	let cancelled = 0
	const inProgress: string[] = []
	for (const item of raw) {
		if (item === null || typeof item !== "object") return null
		const { content, status } = item as { content?: unknown; status?: unknown }
		if (status === "cancelled") cancelled++
		else if (status === "completed") completed++
		else if (status === "in_progress") inProgress.push(oneLine(typeof content === "string" ? content : ""))
	}
	return { completed, total: raw.length - cancelled, cancelled, in_progress: inProgress }
}

export interface TodoClient {
	session: {
		todo(input: {
			path: { id: string }
			query: { directory: string }
			throwOnError: true
		}): Promise<{ data?: unknown }>
	}
}

/**
 * The todo summary of one session. The directory is the session's own, since it
 * selects the server instance that holds it. A failed request is that
 * session's null and nothing more: it must not take the listing down.
 */
export async function sessionTodo(
	client: TodoClient,
	session: { id: string; directory: string },
): Promise<SessionTodo> {
	try {
		const response = await client.session.todo({
			path: { id: session.id },
			query: { directory: session.directory },
			throwOnError: true,
		})
		return summarizeTodos(response.data)
	} catch {
		return null
	}
}

/** Like `Promise.all(items.map(fn))`, but with at most `limit` calls running at once. Keeps the order. */
export async function mapWithLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length)
	let next = 0
	async function worker() {
		while (next < items.length) {
			const index = next++
			results[index] = await fn(items[index])
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
	return results
}
