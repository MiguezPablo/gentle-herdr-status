# pi-herdr-status

Pi extension that shows the running subagent and what the orchestrator is doing in the
[Herdr](https://herdr.dev) sidebar:

```
● pmiguez · 1
pi [exploring]
↳ explore (2)
```

- `$phase` follows the orchestrator: the ODD phase gentle-pi shows in its own prompt
  label, as one plain lowercase word in square brackets (`[exploring]`,
  `[implementing]`, `[checking]`, …), or `[working]` while no phase is reported. It
  disappears when the agent goes idle, so the row reads just `pi`.
- `$subagent` holds the `↳ ` prefix that marks the row as a subagent, the oldest
  running subagent's name, plus the total count in parentheses when two or more run. It
  disappears when no subagent runs; the arrow never shows on its own.

## What it does not do

This package only publishes presentation metadata (`pane.report_metadata`). It never:

- reports pane state (working, blocked, idle): Herdr's official Pi integration owns it;
- sends desktop notifications or sounds: Herdr decides them from its `[ui.toast]` and
  `[ui.sound]` settings, so turning them off in Herdr turns them off everywhere;
- reacts to UI prompts: opening a subagent viewer or a menu changes nothing;
- shows change counts, branches or colors.

## Requirements

- Herdr 0.9.5 or later, with its Pi integration installed in the agent directory Pi uses:

  ```bash
  herdr integration install pi
  herdr integration status   # pi: current
  ```

- Subagents from [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell)
  (`subagent_run` / `subagent_continue`). The `$phase` token additionally reads
  gentle-pi's ODD phase registry; without gentle-pi it shows `[working]` while the agent
  runs.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-herdr-status
```

Then add the rows for Pi panes in `~/.config/herdr/config.toml`.
`rows_by_agent` replaces the default rows, so they are listed again:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["agent", "$phase"], ["$subagent"]]
```

`["agent", "$phase"]` is the `pi [exploring]` line: the agent name followed by the phase.
Apply it with `herdr server reload-config`. A row whose only token is unset is hidden.

## How it works

- Blocking subagents (`mode: "task"`, the default) count from the tool call to its result.
- Background subagents count from their launch result (`details.gentleAgents`) until
  gentle-pi's `gentle-pi:notification:source` bus reports a finished status
  (`completed`, `failed`, `cancelled`, `timed_out`).
- Only the interactive TUI session publishes; gentle-agents children
  (`GENTLE_PI_AGENTS_CHILD=1`, `--mode rpc`) never do.
- The phase comes from gentle-pi's process-global ODD registry
  (`Symbol.for("gentle-pi.odd-phase-registry").get(sessionId)`, `sessionId` from
  `ctx.sessionManager.getSessionId()`). That registry is an internal of gentle-pi: it
  exposes no change event (its single render-request slot belongs to the prompt) and
  gentle-pi clears it when it settles. Polling it every second just for this token was
  not worth it, so the extension reads it only on the events it already handles, turn
  start (`agent_start`), `tool_call` and `tool_result` (gentle-pi's own phase reports are
  tool calls), and clears the token on `agent_end`. A missing registry, a registry
  without `get`, one that throws, or a value outside gentle-pi's phase list all fall
  back to `[working]`; nothing is published while idle. Since that registry is an
  internal, `PI_HERDR_STATUS_DEBUG` logs what each event saw (see [Debugging](#debugging)).
- Both tokens share source `pi-herdr-status` and one `seq` stream (Herdr orders reports
  per source by `seq`), and every report carries both tokens.
- Both tokens carry a 90 s TTL and are refreshed every 30 s while shown, so they expire
  even if Pi dies. They are cleared on session start and shutdown.
- Source `pi-herdr-status`, agent `pi`.

## Debugging

If the sidebar shows a phase it should not, point `PI_HERDR_STATUS_DEBUG` at a file
before starting Pi:

```bash
PI_HERDR_STATUS_DEBUG=/tmp/pi-herdr-status.jsonl pi
```

Every event that publishes the tokens (`session_start`, `agent_start`, `agent_end`,
`tool_call`, `tool_result`) then appends one JSON line with the event name and tool name,
the session id that event's `ctx` reported, the id the phase lookup actually used, the
`typeof` of the ODD registry this process sees, the sessions that registry tracks (with
their phase and source), the raw phase read and the token published. That tells apart a
session-id mismatch, a registry loaded by another module instance, and a phase that was
never reported.

The variable is unset by default and then nothing is written. Write failures are ignored,
so the diagnostic never affects the sidebar.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
