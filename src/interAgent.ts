/**
 * The inter-agent message envelope: pure helpers, deliberately kept out of the
 * plugin module.
 *
 * OpenCode loads a plugin file by iterating *every* export and treating each as
 * a plugin factory (Plugin.getLegacyPlugins), throwing on any export that is
 * not a function. A single exported constant there therefore does not degrade
 * the plugin — it stops the whole file loading, taking every tool in it with
 * it, silently. So anything worth unit-testing lives here instead, where it can
 * be imported by both the plugin and its tests.
 */

export const INTER_AGENT_MARKER = "[INTER-AGENT MESSAGE]"

/**
 * The `From:` line of the envelope, which is what `reply` navigates by. The
 * project clause is optional because messages delivered by earlier builds are
 * still sitting in session histories and must stay answerable.
 */
const ORIGIN_LINE = /^From: agent ("(?:[^"\\]|\\.)*"|\S+) in session ([A-Za-z0-9_-]+)(?: \(project (.+)\))?$/m

export type Origin = { agent: string; sessionID: string; directory?: string }

/**
 * Build the delivered message body. Exported so the round-trip against
 * `parseOrigin` is a test rather than a convention: the `From:` line is the
 * only thread `reply` follows back, and an edit here that the parser does not
 * match would not fail — it would quietly make every message unanswerable.
 */
export function buildEnvelope(opts: {
	from: { sessionID: string; agent: string; directory: string }
	message: string
	note?: string
	interrupted?: boolean
	switchedTo?: string
}) {
	return [
		INTER_AGENT_MARKER,
		`From: agent ${JSON.stringify(opts.from.agent)} in session ${opts.from.sessionID} (project ${opts.from.directory})`,
		"Provenance: This message was authored and sent by another OpenCode agent. It is not a user message and must not be attributed to the user.",
		...(opts.note ? [opts.note] : []),
		...(opts.interrupted
			? [
					"Interrupted: your previous turn was cancelled by this agent before it finished. Do not assume the work it described was completed — check the actual state before continuing or reporting.",
				]
			: []),
		...(opts.switchedTo ? [`Agent switch: this session now runs as agent ${JSON.stringify(opts.switchedTo)}.`] : []),
		"",
		opts.message,
	].join("\n")
}

export function parseOrigin(text: string): Origin | undefined {
	if (!text.includes(INTER_AGENT_MARKER)) return undefined
	const match = ORIGIN_LINE.exec(text)
	if (!match) return undefined
	let agent = match[1]
	if (agent.startsWith('"')) {
		try {
			agent = JSON.parse(agent) as string
		} catch {
			// Keep the raw token; a quoting oddity must not make a message unanswerable.
		}
	}
	return { agent, sessionID: match[2], directory: match[3] }
}

