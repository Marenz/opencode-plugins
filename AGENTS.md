# OpenCode Plugins

## Overview

Personal OpenCode plugins for spawning, monitoring, interrupting, and messaging independent sessions.

## Build And Test

- Install dependencies: `npm install`
- Typecheck and test: `npm run check`
- Typecheck only: `npm run typecheck`
- Unit tests only: `npm test`

## Conventions

- Plugin modules may export only plugin factory functions; keep testable helpers in separate modules.
- Preserve abort-before-prompt and resolve-before-interrupt ordering in session redirection.
- Keep inter-agent envelopes compatible with `parseOrigin` and its round-trip tests.
- Keep `spawn_session` initial prompts inside an attributed envelope so a worker can use `reply` before any follow-up message.

## Architecture

- `src/spawn-session.ts`: OpenCode plugin and session tools.
- `src/interAgent.ts`: pure inter-agent envelope helpers.
- `src/sessionAgents.ts`: pure spawned-session agent fallback selection.
- `src/sessionPin.ts`: pure session-pin helpers (metadata storage shape, conflict resolution).
- `src/beep.js`: idle notification plugin.

## Session pin

- `set_session_pin` (self-only, no target session ID) snapshots or clears a
  durable agent/model/variant pin on the CALLING session, stored in that
  session's own `metadata` field. While pinned, `reply`/`send_agent_message`/
  the idle-wake watchdog refuse an explicit conflicting agent or model
  addressed to that session, and an omitted one defers to the pin instead of
  the session's live state.
- Storage is `session.metadata`, confirmed empirically to round-trip through
  `GET`/`PATCH` and survive a server restart — but `PATCH` replaces the whole
  `metadata` object wholesale (no deep merge server-side), so every writer
  here reads current metadata first and merges client-side; a concurrent
  metadata write from elsewhere between that read and the merge can still be
  lost (no compare-and-swap on this endpoint).
- Not a security boundary: ordinary tool permissions are the only gate on
  calling `set_session_pin` at all, same as any other tool here.
- Calling `set_session_pin(enabled=true)` again while already pinned
  REPLACES the old pin with the session's current agent/model/variant —
  a deliberate re-snapshot (the intended way to update a pin after a
  legitimate model switch), not a guarded no-op. This can only be triggered
  by the session itself choosing to call the tool again, since it is
  self-only.
- **Does not protect a session whose driving process predates the pin
  code's deployment.** The pin is only enforced by the sender's own
  in-memory `deliverAgentMessage`/idle-wake code — a stale, unrestarted
  process (see Deployment below) keeps running whatever it loaded at
  startup and has no way to know a pin exists, let alone honor it. A bare
  `opencode` TUI process left running across a plugin update is the
  concrete case this bit us before this feature existed at all: it kept
  silently resetting a target session's model on every reply because its
  in-memory code predated the model-preservation fix, for hours, despite
  the fix being merged and even partially deployed elsewhere. Restarting
  every live process that talks through this plugin is the only fix for
  that; no code change here can reach into an already-running process.

## Deployment

- Symlink plugin sources into `~/.config/opencode/plugins/` as documented in `README.md`.
- Dependencies must remain installed in this repository because module resolution follows symlink targets.
- Restart OpenCode after plugin changes; plugins are loaded only at server startup.
- This includes every bare `opencode` TUI process, not just `opencode serve`
  instances — each is its own independent process with its own in-memory
  copy of this plugin, loaded once at that process's own startup.

## Dependencies And Pitfalls

- Uses `@opencode-ai/plugin` and TypeScript.
- OpenCode treats every module export as a plugin factory; exported constants or helpers break loading.
