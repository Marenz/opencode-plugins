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
- `src/beep.js`: idle notification plugin.

## Deployment

- Symlink plugin sources into `~/.config/opencode/plugins/` as documented in `README.md`.
- Dependencies must remain installed in this repository because module resolution follows symlink targets.
- Restart OpenCode after plugin changes; plugins are loaded only at server startup.

## Dependencies And Pitfalls

- Uses `@opencode-ai/plugin` and TypeScript.
- OpenCode treats every module export as a plugin factory; exported constants or helpers break loading.
