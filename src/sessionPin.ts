import { NO_VARIANT, type DeliveryModel, type VariantRequest } from "./sessionAgents.ts"

/**
 * A session pin: a durable snapshot of the agent/model a session should stay
 * on, stored in the session's own `metadata` field (confirmed empirically to
 * round-trip through GET/PATCH and survive a server restart — no separate
 * storage file, no cross-host scoping logic needed, since each server owns
 * its own session records).
 *
 * Deliberately self-only: there is no target-session variant of "pin" —
 * only `set_session_pin`, callable with no session ID argument at all,
 * operating on the calling session's own `context.sessionID`. A caller
 * cannot pin (or unpin) any OTHER session through this mechanism; ordinary
 * OpenCode tool permissions are the only gate on calling it at all, same as
 * any other tool — this is not a security boundary layered on top.
 */
export const SESSION_PIN_METADATA_KEY = "sessionPin"

export type PinSnapshot = {
	agent?: string
	model?: DeliveryModel
}

/** Builds a pin snapshot from a session's current agent/model, or `undefined` if there is nothing to pin yet. */
export function buildPinSnapshot(agent: string | undefined, model: DeliveryModel | undefined): PinSnapshot | undefined {
	const pin: PinSnapshot = { ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
	return Object.keys(pin).length > 0 ? pin : undefined
}

/**
 * Merges a pin (or its removal) into an existing metadata object, touching
 * only the `sessionPin` key. `PATCH /session/{id}` replaces the whole
 * `metadata` object wholesale (confirmed empirically — it does not deep
 * merge), so every write here must first read the session's current
 * metadata and merge client-side, or it would silently wipe whatever any
 * other plugin stored there. There is no compare-and-swap on this endpoint,
 * so a concurrent metadata write from elsewhere between the read and this
 * merge can still be lost — a real, accepted race, not addressed here.
 */
export function mergePinIntoMetadata(
	existing: Record<string, unknown> | undefined,
	pin: PinSnapshot | undefined,
): Record<string, unknown> {
	const merged = { ...(existing ?? {}) }
	if (pin) merged[SESSION_PIN_METADATA_KEY] = pin
	else delete merged[SESSION_PIN_METADATA_KEY]
	return merged
}

function readModel(value: unknown): DeliveryModel | undefined {
	if (!value || typeof value !== "object") return undefined
	const v = value as Record<string, unknown>
	if (typeof v.providerID !== "string" || typeof v.modelID !== "string") return undefined
	return {
		providerID: v.providerID,
		modelID: v.modelID,
		...(typeof v.variant === "string" ? { variant: v.variant } : {}),
	}
}

/**
 * Reads a pin snapshot out of a session's `metadata`, defensively: metadata
 * is free-form and this repo does not control every writer of it, so an
 * unrecognized or malformed shape degrades to "no pin" rather than throwing
 * — the same defensive posture as `currentAgentOf`/`currentModelOf`.
 */
export function readPin(metadata: unknown): PinSnapshot | undefined {
	if (!metadata || typeof metadata !== "object") return undefined
	const raw = (metadata as Record<string, unknown>)[SESSION_PIN_METADATA_KEY]
	if (!raw || typeof raw !== "object") return undefined
	const r = raw as Record<string, unknown>
	const agent = typeof r.agent === "string" ? r.agent : undefined
	const model = readModel(r.model)
	const pin: PinSnapshot = { ...(agent ? { agent } : {}), ...(model ? { model } : {}) }
	return Object.keys(pin).length > 0 ? pin : undefined
}

export type PinConflict = { field: "agent" | "model" | "variant"; pinned: string; requested: string }

export type PinResolution =
	| { conflict: PinConflict }
	| { conflict?: undefined; agent: string | undefined; model: DeliveryModel | undefined }

/**
 * Resolves an incoming reply/send_agent_message delivery against an active
 * pin. An omitted field defers to the pin (same "no explicit request" case
 * as the unpinned path). An explicit field matching the pin keeps the
 * pin's OWN recorded variant rather than dropping it — comparing the whole
 * effective choice (provider+model), not just re-deriving a bare model ref
 * that never carried a variant to begin with. An explicit field that
 * differs from the pin is a conflict, reported rather than silently
 * overridden or silently ignored.
 *
 * An explicit `variant` is refused on exactly the same terms as an explicit
 * model, including the case where the pin records no variant and the caller
 * asks for one: a pin snapshots agent+model+variant together, and a variant
 * is the model's effort level, so letting it through would make pinning a
 * lock with a hole in it where effort is concerned. Changing that effort
 * level also invalidates the prompt cache, so retuning a pinned session's
 * variant mid-run is not the cheap adjustment it looks like. Only a pin
 * that records a model constrains the variant at all — an agent-only pin
 * says nothing about the model, so it says nothing about its variant either.
 */
export function resolveDeliveryAgainstPin(
	pin: PinSnapshot,
	explicitAgent: string | undefined,
	explicitModel: DeliveryModel | undefined,
	requestedVariant?: VariantRequest,
): PinResolution {
	if (pin.agent && explicitAgent && explicitAgent !== pin.agent) {
		return { conflict: { field: "agent", pinned: pin.agent, requested: explicitAgent } }
	}
	if (
		pin.model &&
		explicitModel &&
		(explicitModel.providerID !== pin.model.providerID || explicitModel.modelID !== pin.model.modelID)
	) {
		return {
			conflict: {
				field: "model",
				pinned: `${pin.model.providerID}/${pin.model.modelID}`,
				requested: `${explicitModel.providerID}/${explicitModel.modelID}`,
			},
		}
	}
	if (pin.model && requestedVariant && requestedVariant.variant !== pin.model.variant) {
		return {
			conflict: {
				field: "variant",
				// Both sides are reported as "default" when absent, matching the
				// sentinel the server itself stores for "no variant chosen", so
				// "pinned to variant X, refusing Y" never reads as a comparison
				// against nothing.
				pinned: pin.model.variant ?? NO_VARIANT,
				requested: requestedVariant.variant ?? NO_VARIANT,
			},
		}
	}
	return {
		agent: pin.agent ?? explicitAgent,
		model: pin.model ?? explicitModel,
	}
}
