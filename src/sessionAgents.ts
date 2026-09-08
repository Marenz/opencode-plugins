/**
 * The agent to address a delivered message as: the explicit `agent` argument
 * to `reply`/`send_agent_message`, or the target session's OWN current agent
 * so the message keeps addressing it as whatever it already is.
 *
 * The OpenCode server has no "leave the agent alone" concept for a prompt
 * body: an omitted `agent` field resolves server-side to the global default
 * agent (its config default, typically "build"), not to the session's last
 * agent. So passing `undefined` here — as an earlier version did, reasoning
 * that omitting the field would leave the session untouched — silently
 * flipped every recipient to the default agent on every unaddressed reply.
 * A still-earlier version instead cached the sender's own last explicit
 * agent per target session, which had the same failure mode once any
 * message had ever named one explicitly. Passing the session's actual
 * current agent (fetched fresh, e.g. via session.get) back to it is the only
 * way to get true no-op semantics out of an API with no such primitive.
 */
export function deliveryAgent(explicitAgent: string | undefined, currentAgent: string | undefined): string | undefined {
	return explicitAgent ?? currentAgent
}

