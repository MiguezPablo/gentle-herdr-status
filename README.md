# pi-herdr-status

Pi extension that shows the running subagent in the [Herdr](https://herdr.dev) sidebar:

```
● pmiguez · 1
pi
↳ explore (2)
```

The `$subagent` token holds the `↳ ` prefix that marks the row as a subagent, the oldest
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
  (`subagent_run` / `subagent_continue`).

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-herdr-status
```

Then add a `$subagent` row for Pi panes in `~/.config/herdr/config.toml`.
`rows_by_agent` replaces the default rows, so they are listed again:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["agent"], ["$subagent"]]
```

Apply it with `herdr server reload-config`. A row whose only token is unset is hidden.

## How it works

- Blocking subagents (`mode: "task"`, the default) count from the tool call to its result.
- Background subagents count from their launch result (`details.gentleAgents`) until
  gentle-pi's `gentle-pi:notification:source` bus reports a finished status
  (`completed`, `failed`, `cancelled`, `timed_out`).
- Only the interactive TUI session publishes; gentle-agents children
  (`GENTLE_PI_AGENTS_CHILD=1`, `--mode rpc`) never do.
- The token carries a 90 s TTL and is refreshed every 30 s while shown, so it expires
  even if Pi dies. It is cleared on session start and shutdown.
- Source `pi-herdr-status`, agent `pi`.

## Development

```bash
npm install
npm test
npm run typecheck
```

## License

MIT
