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
| `reply` | Answer the agent that last messaged this session, without needing its session ID. |
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

### Replying

`reply` answers whoever last messaged this session, so a delegated session can
talk back without being told its manager's session ID:

```
reply(message = "Done, but the migration test is still red because ...")
```

It finds the most recent *received* inter-agent message by scanning this
session's history backwards and parsing the envelope's `From:` line. Only user
messages count — agents quote the envelope in their own prose often enough that
matching assistant messages would let a session answer its own summary of a
message instead of the message.

The scan is bounded to the newest 100 messages and only falls back to the full
history when that window came back full, so "no message to reply to" is an
honest answer rather than an artefact of the window.

The sender's project scope is recorded in the envelope so a reply can cross
scopes. Messages delivered before that was recorded parse fine and fall back to
the replier's own scope; `directory` overrides it if that guess is wrong.

### Agent and model switching

`agent` is applied to the *user message*, and OpenCode drives each turn from
the last user message's `agent`/`model`. The switch therefore persists for the
rest of the session, not just one reply. Omitting `model` lets the new agent's
own configured model take over, which is normally what you want.

## Development

```sh
npm install
npm run check        # typecheck + unit tests
```

### A plugin file may only export its plugin

OpenCode loads a plugin module by iterating **every** export and treating each
one as a plugin factory, throwing `TypeError: Plugin export is not a function`
on anything that is not one (`Plugin.getLegacyPlugins`). The `default`-export
form used here is a function, not an object, so it is not detected as a v1
plugin and does not short-circuit that scan.

The consequence is worth stating plainly: adding a single exported constant to
`spawn-session.ts` does not degrade it, it stops the whole file from loading and
takes every tool in it with it — with nothing in the server log to say so. That
is why the pure, testable parts live in `src/interAgent.ts` and are imported,
rather than being exported from the plugin for the tests to reach.

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
