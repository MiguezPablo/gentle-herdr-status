# pi-herdr-status

Pi extension that shows, in the [Herdr](https://herdr.dev) sidebar, the running subagent,
what the orchestrator is doing and the jobs it launched:

```
● pmiguez · 1
gentle [exploring]
↳ explore (+1)
⏵ CI for PR 1834
```

With the opt-in `$changes` token the row can also show the uncommitted lines of the
session's repo, next to the name:

```
gentle [exploring] +120 -40
↳ explore (+1)
⏵ CI for PR 1834
```

- `$name` is the panel name, the fixed word `gentle` (Herdr rows accept only tokens, never
  literal text). It is published from session start, stays while the agent is idle and is
  cleared on shutdown.
- `$phase` follows the orchestrator: the ODD phase gentle-pi shows in its own prompt
  label, as one plain lowercase word in square brackets (`[exploring]`,
  `[implementing]`, `[checking]`, …), or `[working]` while no phase is reported. It
  disappears when the agent goes idle, so the row reads just `gentle`. With
  `PI_HERDR_STATUS_STYLE=emoji` the same token is an emoji plus the word, without
  brackets (see [Configuration](#configuration)).
- `$subagent` holds the `↳ ` prefix that marks the row as a subagent, the oldest
  running subagent's name without gentle-pi's `gentle-ai-` prefix (`gentle-ai-explore`
  shows as `explore`), plus how many other subagents run alongside it, in parentheses
  with a `+`, when two or more run, e.g. `↳ explore`, `↳ verify (+1)`. Names are sanitized
  to one line of at most 32 characters: terminal escape sequences (CSI colours and OSC
  titles) and control characters are dropped. It disappears when no subagent runs; the
  arrow never shows on its own.
- `$jobs` holds the `⏵ ` prefix and the oldest running job's label, plus how many other
  jobs run alongside it, in parentheses with a `+`, when two or more run, e.g.
  `⏵ CI for PR 1834`, `⏵ logs (+1)`. A job keeps
  running without a turn, so this row is published while the agent is idle too; it is
  cleared when no job runs, on session start and on shutdown.
- `$changes` is opt-in: only with `PI_HERDR_STATUS_CHANGES=1` it holds the lines the
  session's repo has without committing, as `+<added> -<deleted>` (e.g. `+120 -40`,
  `+5 -0`), so it reads next to the name. Without that exact value nothing is computed,
  git is never run and the token stays unset. See
  [Configuration](#configuration).

## Configuration

Everything is opt-in, so with no variables set the sidebar looks exactly as described
above. All of them are read from the environment Pi starts with.

### `PI_HERDR_STATUS_STYLE`

Only the exact value `emoji` changes anything, and only for `$phase`: a phase is
recognized faster by its icon than by reading the word. Unset, empty or any other value
(including `EMOJI`) keeps the bracketed form `[exploring]`.

```bash
PI_HERDR_STATUS_STYLE=emoji pi
```

The row then reads `gentle · 🔍 exploring` instead of `gentle · [exploring]`:

| Phase | Emoji | Token |
| --- | --- | --- |
| `authorizing` | 🔐 | `🔐 authorizing` |
| `exploring` | 🔍 | `🔍 exploring` |
| `researching` | 📚 | `📚 researching` |
| `deciding` | 🤔 | `🤔 deciding` |
| `planning` | 📝 | `📝 planning` |
| `implementing` | 🔨 | `🔨 implementing` |
| `checking` | ✅ | `✅ checking` |
| `closing` | 🏁 | `🏁 closing` |
| no phase (`working`) | ⏳ | `⏳ working` |

Every emoji is a single codepoint (no `U+FE0F` variation selector), so it is one glyph,
but some fonts render it two columns wide and some one: the row can shift by a cell
between terminals or themes. `$subagent`, `$jobs` and `$name` never change, and neither
does anything else about the phase: the word is still lowercase, untrimmed input is
still normalized, the token still clears when the agent goes idle.

### `PI_HERDR_STATUS_DEBUG`

Opt-in diagnostic for `$phase`; see [Debugging](#debugging).

### `PI_HERDR_STATUS_CHANGES`

Only the exact value `1` turns the `$changes` token on; unset, empty or any other value
(including `0` or `true`) leaves it out and never runs git. It is off by default because a
number that changes all the time is noise unless you ask for it.

```bash
PI_HERDR_STATUS_CHANGES=1 pi
```

What it counts, always against `HEAD` (`git diff --numstat HEAD`, so staged and unstaged
changes together) plus the lines of the untracked files that git does not ignore
(`git ls-files --others --exclude-standard`). Binary files are skipped. The token is
`+<added> -<deleted>` with an ASCII hyphen and shows a zero part (`+5 -0`); when nothing
changed it disappears. A repo without commits is compared against git's empty tree, and
outside a git repo, with git missing, on error or after a 2 s timeout the token is
cleared instead of keeping the previous value.

When it recalculates, with no timer of its own: on `session_start`, `agent_start`, every
`tool_result` (any tool, so edit/write/bash and the end of a subagent are covered), the
gentle-pi jobs event and `agent_end`. The measurement is asynchronous (`execFile`, no
shell, never blocking events): at most one runs at a time, and events that arrive during
one collapse into exactly one more measurement. It is published in the same report as the
other tokens (same `seq`, source and TTL) and also while the agent is idle, like `$jobs`.

The limit is deliberate: it is event-driven, so changes made outside Pi (another
terminal, an editor, a background job that is not a gentle-pi job) are reflected only on
the next Pi event. Nothing polls the repo.

To show it, add the token to the row with the name:

```toml
pi = [["state_icon", "machine", "workspace", "tab"], ["$name", "$phase", "$changes"], ["$subagent"], ["$jobs"]]
```

## What it does not do

This package only publishes presentation metadata (`pane.report_metadata`). It never:

- reports pane state (working, blocked, idle): Herdr's official Pi integration owns it;
- sends desktop notifications or sounds: Herdr decides them from its `[ui.toast]` and
  `[ui.sound]` settings, so turning them off in Herdr turns them off everywhere;
- reacts to UI prompts: opening a subagent viewer or a menu changes nothing;
- shows branches or colors. Change counts only appear with the opt-in `$changes` token.

## Requirements

- Herdr 0.9.5 or later, with its Pi integration installed in the agent directory Pi uses:

  ```bash
  herdr integration install pi
  herdr integration status   # pi: current
  ```

- Subagents and jobs from [gentle-pi](https://github.com/Gentleman-Programming/gentle-shell)
  (`subagent_run` / `subagent_continue`, and its background jobs). The `$phase` token
  additionally reads gentle-pi's ODD phase registry; without gentle-pi it shows
  `[working]` while the agent runs, and `$jobs` stays empty.

## Install

From a local checkout:

```bash
pi install /absolute/path/to/pi-herdr-status
```

Then add the rows for Pi panes in `~/.config/herdr/config.toml`.
`rows_by_agent` replaces the default rows, so they are listed again:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["$name", "$phase"], ["$subagent"], ["$jobs"]]
```

`["$name", "$phase"]` is the `gentle [exploring]` line: the panel name followed by the
phase. With `PI_HERDR_STATUS_CHANGES=1`, add `$changes` to that row
(`["$name", "$phase", "$changes"]`) to read `gentle [exploring] +120 -40`. `$subagent`
and `$jobs` live in rows of their own, so each disappears (row and all) when its token is
unset. Apply it with `herdr server reload-config`. A row whose only token is unset is
hidden.

## How it works

- Blocking subagents (`mode: "task"`, the default) count from the tool call to its result.
- The name shown drops gentle-pi's `gentle-ai-` prefix (`gentle-ai-worker` -> `worker`); a
  name without that prefix is shown as it comes, and a name that was only the prefix
  falls back to `subagent`.
- Background subagents count from their launch result (`details.gentleAgents`) until
  gentle-pi's `gentle-pi:notification:source` bus reports a finished status
  (`completed`, `failed`, `cancelled`, `timed_out`).
- Only the interactive TUI session publishes; gentle-agents children
  (`GENTLE_PI_AGENTS_CHILD=1`, `--mode rpc`) never do.
- `$name` is the constant `gentle`, published from `session_start` and kept while the agent
  is idle so the row keeps its name; it replaces the `agent` row item, because Herdr
  rejects literal text in rows (its error is "custom tokens must start with `$`"). It is
  refreshed with the same TTL and cleared on shutdown.
- Jobs come from gentle-pi's `gentle-ai:jobs-sidebar` event on Pi's event bus
  (`pi.events.on`): `{ sessionId, snapshot: { jobs } }`, where running jobs carry no
  `status` and recently finished ones carry `status`/`endedAt`/`exitCode`. Each event
  replaces the whole state; an event from another session id or with a malformed payload
  changes nothing. Only running jobs are shown, the oldest by `startedAt` first (a tie is
  won by the job that comes first in the snapshot), plus how many others run in
  parentheses (`+N`) when two or more run. The label is sanitized and capped like the
  subagent name (one line, 32 characters, escape sequences and control characters
  dropped), and an empty label falls back to `job`. That event and
  gentle-pi's `JOBS_SIDEBAR_EVENT` name are internals of gentle-pi: they can change
  without notice, and then the row simply disappears.
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
- The phase style is opt-in: `PI_HERDR_STATUS_STYLE=emoji` is read from the extension's
  own `env` once, and then `phaseToken(value, style)` renders `<emoji> <phase>` instead
  of `[<phase>]`. The default argument is still the bracketed form, so no other token and
  no other behaviour changes.
- `$changes` is opt-in too: `PI_HERDR_STATUS_CHANGES=1` (read once from the same `env`)
  creates a counter that measures the session's `cwd` on the events the extension already
  handles (`session_start`, `agent_start`, every `tool_result`, the jobs event and
  `agent_end`) through an injected git runner (`execFile`, no shell), at most one
  measurement in flight with a single queued re-measurement, a 2 s cap, and `null` on any
  error. It has no timer and no poll of its own; its value travels in the same report and
  is cleared on `session_start` and on shutdown.
- All tokens share source `pi-herdr-status` and one `seq` stream (Herdr orders reports
  per source by `seq`), and every report carries all of them.
- Every token carries a 90 s TTL and is refreshed every 30 s while shown, so they expire
  even if Pi dies. `$jobs` uses the same TTL and refresh; it has no poll of its own, and
  `$phase` is still read only on Pi events. Everything is cleared on session start and
  shutdown.
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
