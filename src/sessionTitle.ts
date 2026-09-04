/**
 * Pure, testable logic for `session_set_title`, kept out of spawn-session.ts
 * for the same reason interAgent.ts is: a plugin file may only export its
 * plugin factory, so anything worth unit testing has to live in an imported
 * module instead.
 */
export interface SessionTitleClient {
	session: {
		update(input: {
			path: { id: string }
			query?: { directory?: string }
			body: { title: string }
		}): Promise<{ error?: unknown }>
	}
}

export async function setSessionTitle(
	client: SessionTitleClient,
	sessionId: string,
	title: string,
	directory: string,
): Promise<string> {
	try {
		const { error } = await client.session.update({
			path: { id: sessionId },
			query: { directory },
			body: { title },
		})
		if (error) {
			const message = typeof error === "string" ? error : JSON.stringify(error)
			return `session_set_title: ${message.split("\n")[0]}`
		}
		return `Set title for session ${sessionId} to ${title}.`
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return `session_set_title: ${message.split("\n")[0]}`
	}
}
