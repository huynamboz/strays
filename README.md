# strays

A Claude Code mod that shows every process Claude Code started and left running,
in any session, and ends it with one key.

Claude starts a dev server, a watcher or a headless browser, moves on, and the
process keeps running after the session is closed, holding a port and memory
until you hunt it down or restart. `strays` finds them.

```
╭────────────────╮ ╭────────────────╮ ╭────────────────╮
│ 2              │ │ 1              │ │ 46             │
│ left behind    │ │ in background  │ │ MB held        │
╰────────────────╯ ╰────────────────╯ ╰────────────────╯
╭──────────────────────────────────────────────────────────────────────────────╮
│ ● Left behind session closed                                                 │
│ ❯  :8767  Python -m http.server 8767     █░░░░░░░  10 MB     6m  tmp [ End ] │
│    :8768  Python -m http.server 8768     █░░░░░░░  12 MB     6m  tmp [ End ] │
╰──────────────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────────────╮
│ ● In the background session still open                                       │
│    :8766  Python -m http.server 8766     █░░░░░░░  24 MB    12s  tmp [ End ] │
╰──────────────────────────────────────────────────────────────────────────────╯
[ End all left behind (2) ]  [ Refresh ]  [ MCP (7) ]  [ Close ]
↑↓ move   ⏎ end   o end all   r refresh   m MCP   x close
```

In color: each group has its own (left behind in yellow, background in cyan), a
port is a label in its group's color, and memory is a bar. Above the prompt, where
a pane is short, the same list draws without the frames.

## Use

Needs Claude Code 2.1.287 or later, on macOS.

```bash
claude --plugin-dir /path/to/strays
```

| Command | Does |
| :- | :- |
| `/strays` | opens the pane: the arrows move between rows, Enter on a row asks, Enter again ends that process and what it started |
| `/strays list` | prints the list where panes do not draw: a table in the VS Code panel, padded columns in `claude -p` |
| `/strays kill` | ends every process whose session is gone |

In the pane: `o` twice ends everything left behind, `r` rescans, `m` shows the MCP
servers of open sessions, `x` closes. A question left unanswered for four seconds
takes itself back. While anything is stray, a line under the prompt says how many
and on which ports; a session that starts while processes from earlier sessions
still run says so once.

## How it finds them

Claude Code marks every process it starts: `CLAUDECODE=1`, its session's id and
its own pid are in the process's environment, and a process keeps its
environment after the session is gone, or after `nohup` and `&` cut it loose.
`bin/scan.sh` reads the process table (`ps -E`), keeps the marked ones and
everything that hangs under a running session, and asks `lsof` for their
listening ports and folders. Nothing is recorded as you work,
so processes started before the mod was installed show up too.

`bin/kill.sh` sends TERM, waits two seconds and sends KILL to what remains. It
checks the mark again before it touches a pid and never ends a Claude Code
session itself.

## What it does not see

- **macOS's own programs once they are cut loose.** macOS shows no environment for
  the programs it ships (`sh`, `tail`, `nc`, `ssh`, `sleep`, ...), so a
  `nohup tail -f log &` whose session is gone cannot be told from anyone else's.
  While it still hangs under an open session it is found by its place in the
  process tree and listed.
- **Programs that rename themselves** (`npm run dev` shows as `npm run dev`, with
  its environment gone): the server it started is listed, the `npm` above it is not.
- **Docker containers**: the `docker` command exits and the container runs under the daemon.
- **Services handed to launchd**, and programs that clear their environment on start.
- Other users' processes.
- Linux and Windows: not yet. Linux needs `/proc/<pid>/environ` in place of `ps -E`.

## Develop

```bash
claude plugin validate .
claude plugin test
npx -p typescript tsc -p .
```
