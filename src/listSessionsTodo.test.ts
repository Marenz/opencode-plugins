import assert from "node:assert/strict"
import test from "node:test"
import spawnSessionPlugin from "./spawn-session.ts"

/**
 * Integration-level coverage for `list_sessions`' `include_todo`: what the
 * tool actually returns and asks for, against a fake client, with no real
 * OpenCode server. The plugin's default export is a plain async function of
 * `{ client }`, so it is importable and callable directly.
 */

const DIRECTORY = "/home/marenz/Projects/cat-bowl"
const ELSEWHERE = "/home/marenz/Projects/dog-bowl"

function session(id: string, updated: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		title: `Title of ${id}`,
		directory: DIRECTORY,
		time: { created: 0, updated },
		...overrides,
	}
}

type TodoCall = { path: { id: string }; query: { directory: string }; throwOnError: boolean }

function fakeClient(opts: {
	sessions: Array<ReturnType<typeof session>>
	todos?: Record<string, unknown>
	failing?: string[]
}) {
	const todoCalls: TodoCall[] = []
	let running = 0
	let peak = 0
	const client = {
		session: {
			async list() {
				return { data: opts.sessions }
			},
			async status() {
				return { data: {} }
			},
			async todo(input: TodoCall) {
				todoCalls.push(input)
				running++
				peak = Math.max(peak, running)
				try {
					await new Promise((resolve) => setTimeout(resolve, 2))
					if (opts.failing?.includes(input.path.id)) throw new Error("boom")
					return { data: opts.todos?.[input.path.id] ?? [] }
				} finally {
					running--
				}
			},
		},
	}
	return { client, todoCalls, peak: () => peak }
}

async function listSessions(client: unknown, args: Record<string, unknown> = {}) {
	const plugin = await (spawnSessionPlugin as unknown as (input: { client: unknown }) => Promise<any>)({ client })
	const output = await plugin.tool.list_sessions.execute(args, {
		sessionID: "ses_caller0000000000000000000",
		agent: "build",
		directory: DIRECTORY,
	})
	return { plugin, output, rows: output.startsWith("[") ? JSON.parse(output) : undefined }
}

const task = (content: string, status: string) => ({ content, status, priority: "medium" })

test("by default no todo is requested and the rows carry no todo", async () => {
	const { client, todoCalls } = fakeClient({ sessions: [session("ses_a", 2), session("ses_b", 1)] })

	const { rows } = await listSessions(client)

	assert.deepEqual(todoCalls, [])
	assert.deepEqual(
		rows.map((row: object) => Object.keys(row)),
		rows.map(() => ["id", "title", "status", "directory", "created_at", "updated_at"]),
	)
})

test("include_todo false is the same as omitting it", async () => {
	const { client, todoCalls } = fakeClient({ sessions: [session("ses_a", 2)] })

	const { rows } = await listSessions(client, { include_todo: false })

	assert.deepEqual(todoCalls, [])
	assert.equal("todo" in rows[0], false)
})

test("include_todo adds a todo object to every row, in the order of the listing", async () => {
	const { client } = fakeClient({
		sessions: [session("ses_old", 1), session("ses_new", 2)],
		todos: {
			ses_new: [task("one", "completed"), task("two", "in_progress"), task("three", "pending")],
			ses_old: [],
		},
	})

	const { rows } = await listSessions(client, { include_todo: true })

	assert.deepEqual(
		rows.map((row: { id: string }) => row.id),
		["ses_new", "ses_old"],
	)
	assert.deepEqual(rows[0].todo, {
		completed: 1,
		total: 3,
		cancelled: 0,
		in_progress: ["two"],
	})
	assert.deepEqual(rows[1].todo, { completed: 0, total: 0, cancelled: 0, in_progress: [] })
})

test("only the rows left after the filter and the limit are asked about", async () => {
	const { client, todoCalls } = fakeClient({
		sessions: [session("ses_a", 4), session("ses_b", 3), session("ses_c", 2), session("ses_d", 1)],
	})

	await listSessions(client, { include_todo: true, limit: 2 })
	assert.deepEqual(
		todoCalls.map((call) => call.path.id).sort(),
		["ses_a", "ses_b"],
	)

	todoCalls.length = 0
	await listSessions(client, { include_todo: true, filter: "ses_d" })
	assert.deepEqual(
		todoCalls.map((call) => call.path.id),
		["ses_d"],
	)
})

test("each todo is requested in the directory of its own session", async () => {
	const { client, todoCalls } = fakeClient({
		sessions: [session("ses_a", 2), session("ses_b", 1, { directory: ELSEWHERE })],
	})

	await listSessions(client, { include_todo: true })

	const byID = Object.fromEntries(todoCalls.map((call) => [call.path.id, call.query.directory]))
	assert.deepEqual(byID, { ses_a: DIRECTORY, ses_b: ELSEWHERE })
	assert.ok(todoCalls.every((call) => call.throwOnError === true))
})

test("a session whose request fails has a null todo and the others are unaffected", async () => {
	const { client } = fakeClient({
		sessions: [session("ses_a", 2), session("ses_b", 1)],
		todos: { ses_b: [task("one", "pending")] },
		failing: ["ses_a"],
	})

	const { rows } = await listSessions(client, { include_todo: true })

	assert.equal(rows[0].todo, null)
	assert.equal(rows[1].todo.total, 1)
})

test("no more than four requests are in flight at once", async () => {
	const sessions = Array.from({ length: 12 }, (_, index) => session(`ses_${index}`, index))
	const { client, todoCalls, peak } = fakeClient({ sessions })

	await listSessions(client, { include_todo: true })

	assert.equal(todoCalls.length, 12)
	assert.equal(peak(), 4)
})

test("an empty listing still says so, without any request", async () => {
	const { client, todoCalls } = fakeClient({ sessions: [] })

	const { output } = await listSessions(client, { include_todo: true })

	assert.match(output, /^No sessions matched/)
	assert.deepEqual(todoCalls, [])
})
