export function sessionAgent(
	agents: ReadonlyMap<string, string>,
	sessionID: string,
	explicitAgent?: string,
): string | undefined {
	return explicitAgent ?? agents.get(sessionID)
}
