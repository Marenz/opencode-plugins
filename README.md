# opencode-plugins

Personal [OpenCode](https://opencode.ai) plugins.

## `src/spawn-session.ts`

Tools for running and steering **independent** OpenCode sessions from inside a
session — delegation, monitoring, and now interruption.

| Tool | What it does |
|---|---|
| `spawn_session` | Create an independent session, start it with a prompt, return its ID immediately. Optional `agent`, `model`, `fuzzy_model`. |
| `list_sessions` | Recent sessions in the project scope with live status. |
| `list_models` | Available `provider/model` IDs, grouped by provider. |
| `send_agent_message` | Send an attributed inter-agent message to another session. Optionally `interrupt` it first and/or switch its `agent`/`model`. |
| `interrupt_session` | Abort whatever a session is currently running, leaving it idle. |
| `wake_after_idle` / `stop_idle_wake` | Recurring idle watchdog for manager sessions. |

### Interrupting and redirecting

`send_agent_message` composes the three things you actually want when a
delegated session is going the wrong way:

```
send_agent_message(
  session_id = "ses_...",
  interrupt  = true,          # stop what it is doing now
  agent      = "plan",        # run the rest of the session as a different agent
  message    = "Stop. Reconsider the approach: ...",
)
```

Ordering here is load-bearing, and both rules come from the server's behaviour
rather than from taste:

- **Abort strictly before prompting.** A prompt sent to a *busy* session does
  not fail. The server appends the user message and then *joins* the in-flight
  run (`Runner.ensureRunning`). So prompting first and aborting after can
  cancel the very run that was about to consume the new message, leaving it in
  the stream with nothing running to read it. The tool aborts, polls until the
  server reports `idle`, and only then sends.
- **Resolve the agent and model before touching the session.**
  `prompt_async` answers `204` and reports an unknown agent asynchronously —
  the message is silently dropped while the caller is told it was sent. Both
  are resolved (and can fail) before anything is interrupted, so a typo cannot
  cost you a running turn or produce an invisible no-op.

An interrupted recipient is told so explicitly in the message body: its
previous turn was cancelled part-way, so it must not assume the work that turn
described actually finished.

`interrupt_session` is the bare primitive for when you only want to stop work.
Both tools refuse to target the calling session.

### Agent and model switching

`agent` is applied to the *user message*, and OpenCode drives each turn from
the last user message's `agent`/`model`. The switch therefore persists for the
rest of the session, not just one reply. Omitting `model` lets the new agent's
own configured model take over, which is normally what you want.

## Development

```sh
npm install
npm run typecheck    # tsc --noEmit against the real @opencode-ai/plugin types
```

## Deploy

The plugins are symlinked into OpenCode's plugin directory:

```sh
ln -sfn "$PWD/src/spawn-session.ts" ~/.config/opencode/plugins/spawn-session.ts
ln -sfn "$PWD/src/beep.js"          ~/.config/opencode/plugins/beep.js
```

Two caveats:

- `npm install` must have been run here. Module resolution follows the
  symlink's *real* path, so `@opencode-ai/plugin` is resolved from this repo's
  `node_modules`, not from `~/.config/opencode`.
- Plugins are loaded at server start. An edit only takes effect after OpenCode
  restarts.

To verify a change loads without disturbing a running server, start a throwaway
one against a scratch config and ask it for its tool IDs:

```sh
mkdir -p /tmp/oc/opencode/plugins /tmp/oc/work
ln -s "$PWD/src/spawn-session.ts" /tmp/oc/opencode/plugins/spawn-session.ts
echo '{}' > /tmp/oc/opencode/opencode.json
(cd /tmp/oc/work && XDG_CONFIG_HOME=/tmp/oc opencode serve --port 8899 --hostname 127.0.0.1 &)
curl -s 'http://127.0.0.1:8899/experimental/tool/ids?directory=/tmp/oc/work'
```

## `src/beep.js`

Plays a sound on `session.idle`.
