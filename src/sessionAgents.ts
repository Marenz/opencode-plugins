/**
 * The agent to address a delivered message as: the explicit `agent` argument
 * to `reply`/`send_agent_message`, or `undefined` to leave the recipient's
 * current agent untouched.
 *
 * Deliberately has no fallback to a remembered agent for the target session.
 * An earlier version consulted such a cache here, so once any message to a
 * session named an explicit agent, every later reply to it — even one that
 * passed no `agent` at all — kept re-applying that cached agent and switching
 * the recipient every time.
 */
export function deliveryAgent(explicitAgent?: string): string | undefined {
	return explicitAgent
}

