import assert from "node:assert/strict"
import test from "node:test"
import { mapWithLimit, sessionTodo, summarizeTodos } from "./sessionTodo.ts"

function todos(...statuses: string[]) {
	return statuses.map((status, index) => ({ content: `item ${index + 1}`, status, priority: "medium" }))
}

test("a list of pending items has done nothing yet", () => {
	assert.deepEqual(summarizeTodos(todos("pending", "pending")), {
		completed: 0,
		total: 2,
		cancelled: 0,
		in_progress: [],
	})
})

test("only a list that is entirely completed has completed equal to total", () => {
	const done = summarizeTodos(todos("completed", "completed")) as { completed: number; total: number }
	assert.equal(done.completed, done.total)
	const partial = summarizeTodos(todos("completed", "completed", "pending")) as { completed: number; total: number }
	assert.equal(partial.completed, 2)
	assert.equal(partial.total, 3)
})

test("a cancelled item is neither completed nor outstanding", () => {
	assert.deepEqual(summarizeTodos(todos("completed", "cancelled", "cancelled", "pending")), {
		completed: 1,
		total: 2,
		cancelled: 2,
		in_progress: [],
	})
	const done = summarizeTodos(todos("completed", "cancelled")) as { completed: number; total: number }
	assert.equal(done.completed, done.total)
})

test("an empty list and an all-cancelled list have nothing to count", () => {
	assert.deepEqual(summarizeTodos([]), { completed: 0, total: 0, cancelled: 0, in_progress: [] })
	assert.deepEqual(summarizeTodos(todos("cancelled", "cancelled")), {
		completed: 0,
		total: 0,
		cancelled: 2,
		in_progress: [],
	})
})

test("what is in progress is listed in list order, and nothing else", () => {
	const summary = summarizeTodos([
		{ content: "done", status: "completed" },
		{ content: "later", status: "pending" },
		{ content: "first", status: "in_progress" },
		{ content: "second", status: "in_progress" },
		{ content: "third", status: "in_progress" },
	])
	assert.deepEqual((summary as { in_progress: string[] }).in_progress, ["first", "second", "third"])
})

test("a pending item is not presented as being in progress", () => {
	assert.deepEqual((summarizeTodos(todos("completed", "pending")) as { in_progress: string[] }).in_progress, [])
})

test("an unknown status stays in the total without being completed", () => {
	const summary = summarizeTodos(todos("completed", "blocked")) as { completed: number; total: number }
	assert.equal(summary.completed, 1)
	assert.equal(summary.total, 2)
})

test("an item in progress is shown on one line", () => {
	const summary = summarizeTodos([{ content: "Add\n  token\tcolumns", status: "in_progress" }])
	assert.deepEqual((summary as { in_progress: string[] }).in_progress, ["Add token columns"])
})

test("anything that is not a list of objects is null", () => {
	for (const raw of [undefined, null, "[]", {}, { todos: [] }, [null], ["x"], [{ status: "pending" }, 3]]) {
		assert.equal(summarizeTodos(raw), null, JSON.stringify(raw))
	}
})

test("an item with missing fields is tolerated", () => {
	const summary = summarizeTodos([{}, { content: 3, status: "in_progress" }]) as { total: number; in_progress: string[] }
	assert.equal(summary.total, 2)
	assert.deepEqual(summary.in_progress, [""])
})

test("sessionTodo asks for the todos of the session in its own directory", async () => {
	const calls: unknown[] = []
	const client = {
		session: {
			async todo(input: unknown) {
				calls.push(input)
				return { data: todos("completed", "pending") }
			},
		},
	}
	const summary = await sessionTodo(client, { id: "ses_a", directory: "/elsewhere" })
	assert.deepEqual(calls, [{ path: { id: "ses_a" }, query: { directory: "/elsewhere" }, throwOnError: true }])
	assert.equal(summary?.total, 2)
})

test("sessionTodo turns a failure into null instead of throwing", async () => {
	const client = {
		session: {
			async todo(): Promise<{ data?: unknown }> {
				throw new Error("boom")
			},
		},
	}
	assert.equal(await sessionTodo(client, { id: "ses_a", directory: "/d" }), null)
})

test("mapWithLimit keeps the order and never exceeds the limit", async () => {
	let running = 0
	let peak = 0
	const results = await mapWithLimit([5, 1, 4, 2, 3, 6, 7, 8, 9, 10], 4, async (n) => {
		running++
		peak = Math.max(peak, running)
		await new Promise((resolve) => setTimeout(resolve, n))
		running--
		return n * 2
	})
	assert.deepEqual(results, [10, 2, 8, 4, 6, 12, 14, 16, 18, 20])
	assert.equal(peak, 4)
})

test("mapWithLimit copes with nothing to do and with fewer items than the limit", async () => {
	assert.deepEqual(await mapWithLimit([], 4, async (n: number) => n), [])
	assert.deepEqual(await mapWithLimit([1, 2], 4, async (n) => n + 1), [2, 3])
})
