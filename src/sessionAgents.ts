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
 * is a variant of a specific model, so switching models drops it. An
 * explicit `variant` argument is applied separately, by `deliveryVariant`.
 */
export function deliveryModel(
	explicitModel: DeliveryModel | undefined,
	currentModel: DeliveryModel | undefined,
): DeliveryModel | undefined {
	return explicitModel ?? currentModel
}

/** The server's sentinel for "no variant chosen"; never a selectable variant name. */
export const NO_VARIANT = "default"

/**
 * A caller's explicit `variant` argument, once parsed. The distinction this
 * type exists to keep is "said nothing" versus "explicitly asked for no
 * variant": `undefined` is the former and leaves the variant alone, while
 * `{}` is the latter and clears it.
 */
export type VariantRequest = { variant?: string }

/**
 * Parses a caller's `variant` argument.
 *
 * `"default"` is the server's own sentinel for "no variant chosen", not a
 * variant name — `currentModelOf` already drops it on the way in and the
 * server itself stores an absent variant as `"default"` — so a caller
 * passing it literally means "clear the variant", the one reading
 * consistent with that existing handling. A whitespace-only string is
 * treated the same way rather than being sent on as a variant name no model
 * can have.
 */
export function variantRequest(input: string | undefined): VariantRequest | undefined {
	if (input === undefined) return undefined
	const wanted = input.trim()
	return wanted && wanted !== NO_VARIANT ? { variant: wanted } : {}
}

/**
 * The variant to send with a delivered message: the caller's explicit
 * request if there is one, otherwise whatever the effective model already
 * carries (the preserved current model's variant, or a pin's).
 *
 * A variant belongs to a specific model, but the server takes it as its own
 * prompt-body field rather than as part of `model` (`input.variant` in
 * `SessionPrompt.createUserMessage`), so an explicit request still applies
 * when the target session has no recorded model at all and the agent's own
 * default model is about to be picked server-side.
 */
export function deliveryVariant(
	requested: VariantRequest | undefined,
	model: DeliveryModel | undefined,
): string | undefined {
	return requested ? requested.variant : model?.variant
}

