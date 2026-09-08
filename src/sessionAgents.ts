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

export type DeliveryModel = { providerID: string; modelID: string; variant?: string }

/**
 * The model to address a delivered message as: the explicit `model` argument
 * to `reply`/`send_agent_message` (already resolved), or the target
 * session's OWN current model — same reasoning as `deliveryAgent`, and the
 * same server behavior bit us again: `SessionPrompt.createUserMessage`
 * resolves an omitted `model` to `t.model ?? U.model ?? sessionDefault`,
 * where `U` is the (correctly-preserved) resolved AGENT's own configured
 * model, not the session's actual current one. So preserving `agent` while
 * omitting `model` can itself flip the model, whenever the addressed agent
 * has a `model:` of its own configured (e.g. the `manager` agent defaults to
 * a different model than most sessions actually run).
 *
 * An explicit model request never carries over the old variant — a variant
 * is a variant of a specific model, so switching models drops it.
 */
export function deliveryModel(
	explicitModel: DeliveryModel | undefined,
	currentModel: DeliveryModel | undefined,
): DeliveryModel | undefined {
	return explicitModel ?? currentModel
}

