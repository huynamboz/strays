#!/bin/sh
# strays: lists the processes Claude Code sessions started that still run.
#
# A process is listed when one of five things ties it to Claude Code (column
# `how`), whether or not the session that started it is still there:
#   e  it carries CLAUDECODE=1 in its environment: Claude Code marks every
#      process it starts, and a process keeps its environment for life
#   w  it is the shell the Bash tool wraps a command in (its command line names
#      ~/.claude/shell-snapshots); macOS shows no environment for its own
#      programs (sh, zsh, tail, nc, ssh), so the command line stands in
#   s  it is Claude Code itself, run as its search tool: Claude Code carries
#      its own rg, bfs and ugrep and runs itself under their names. A session
#      lists a folder's files this way without the Bash tool, so such an rg
#      carries no mark, and outlives a search of a folder too large to finish
#   t  it hangs under a running session, or under such a shell, in the tree
#   g  it shares a process group with a marked process whose group leader is
#      gone or marked too: one Bash call starts one group, and `nohup tail &`
#      stays in it after the shell that started it exits
#
# One line per process, tab-separated:
#   pid up seconds rssKB sessionId claudePid alive attached ports cwd how pgid cpu start command
# up: the nearest listed ancestor (its parent, for grouping). alive: the session
# that started it still runs. attached: it still hangs under that session.
# start: when it started, in epoch seconds (what bin/kill.sh checks a pid against).
set -u
tmp=$(mktemp -d "${TMPDIR:-/tmp}/strays.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

ps -axww -o pid=,ppid=,pgid=,etime=,rss=,pcpu=,command= > "$tmp/all"
ps -axEww -o pid=,command= > "$tmp/env"
# The program a process runs, whatever name it runs under.
ps -axww -o pid=,ucomm= > "$tmp/names"
# Claude Code keeps one file per running session, named for its pid.
sessions=$(ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions" 2>/dev/null | sed -n 's/^\([0-9][0-9]*\)\.json$/\1/p' | tr '\n' ' ')

awk -v self=$$ -v now="$(date +%s)" -v sessions="$sessions" '
function seconds(e,   n, p, d) {
  d = 0
  if (index(e, "-")) { d = substr(e, 1, index(e, "-") - 1); e = substr(e, index(e, "-") + 1) }
  n = split(e, p, ":")
  if (n == 3) return d * 86400 + p[1] * 3600 + p[2] * 60 + p[3]
  return d * 86400 + p[1] * 60 + p[2]
}
# The environment follows the command on the line, so the last match is the
# variable itself and not a mention of it in the command.
function last(s, re, skip,   out) {
  out = ""
  while (match(s, re)) { out = substr(s, RSTART + skip, RLENGTH - skip); s = substr(s, RSTART + RLENGTH) }
  return out
}
# A Claude Code session: registered as one, or named as one.
function claude(pid,   first, n, parts) {
  if (!(pid in parent)) return 0
  if (pid in registered) return 1
  n = split(cmd[pid], parts, " ")
  first = parts[1]
  return first == "claude" || first ~ /\/claude$/ || cmd[pid] ~ /claude-code\/cli\.js/
}
BEGIN {
  n = split(sessions, list, " ")
  for (i = 1; i <= n; i++) registered[list[i]] = 1
}
# First file: the program behind each process.
FILENAME == ARGV[1] {
  name = $0
  sub(/^ *[0-9]+ +/, "", name); sub(/ +$/, "", name)
  prog[$1] = name
  next
}
# A command may hold line breaks, and ps prints them as they are: a line that
# does not open a new record continues the one before it.
# Second file: every process, for the family tree and the command as typed.
FILENAME == ARGV[2] {
  if ($0 ~ /^ *[0-9]+ +[0-9]+ +[0-9]+ +([0-9]+-)?([0-9]+:)?[0-9]+:[0-9]+ +[0-9]+ +[0-9.,]+ /) {
    pid = $1
    parent[pid] = $2
    pgid[pid] = $3
    age[pid] = seconds($4)
    rss[pid] = $5
    cpu[pid] = $6
    line = $0
    sub(/^ *[0-9]+ +[0-9]+ +[0-9]+ +[^ ]+ +[0-9]+ +[0-9.,]+ +/, "", line)
  } else {
    line = cmd[pid] " " $0
  }
  gsub(/\t/, " ", line)
  cmd[pid] = line
  next
}
# Third file: the environments. Remember who carries the mark, and whose it is.
{
  if ($0 ~ /^ *[0-9]+ / && ($1 in parent)) pid = $1
  if (index($0, " CLAUDECODE=1")) marked[pid] = 1
  found = last($0, "CLAUDE_CODE_SESSION_ID=[^ ]+", 23)
  if (found != "") sid[pid] = found
  found = last($0, " CLAUDE_PID=[0-9]+", 12)
  if (found != "") cpid[pid] = found
}
END {
  for (pid in parent) {
    if (cmd[pid] ~ /\/\.claude\/shell-snapshots\//) wrapper[pid] = 1
    # A process that has exited and waits to be reaped holds nothing and cannot be ended.
    if (cmd[pid] ~ /^(<defunct>|\([^)]*\))$/) mine[pid] = 1
    # Named rg, bfs or ugrep while its program is another: Claude Code under that name.
    split(cmd[pid], parts, " ")
    if (parts[1] ~ /^(rg|bfs|ugrep)$/ && (pid in prog) && prog[pid] != parts[1]) tool[pid] = 1
  }

  # By mark, by wrapper, by name, by place in the tree.
  for (pid in parent) {
    # What the Bash tool runs sits under its wrapper; what a session starts for
    # itself (an MCP server, a helper) is its direct child.
    att = 0; own = ""; under = 0; p = pid
    bash = (pid in wrapper)
    for (i = 0; i < 64 && p > 1; i++) {
      if (p == self) { mine[pid] = 1; break }   # this scan and its helpers
      p = parent[p]
      if (p == "") break
      if (claude(p)) { att = 1; if (own == "") own = p }
      else if (p in wrapper) { under = 1; if (own == "") bash = 1 }
    }
    if (pid in mine) continue
    how[pid] = (pid in marked) ? "e" : (pid in wrapper) ? "w" : (pid in tool) ? "s" : (att || under) ? "t" : ""
    if (how[pid] == "") continue
    attached[pid] = att
    # Whose it is: the pid its mark names, else the session it sits under through
    # a wrapper. A search the session runs for itself is work of that session too,
    # not a server it keeps.
    c[pid] = (pid in cpid) ? cpid[pid] : ((pid in marked) ? "" : ((bash || (pid in tool)) ? own : ""))
    # A search the session ran itself sits in the group of the session, not one it made.
    if (how[pid] == "t" || how[pid] == "s") continue
    if (!(pgid[pid] in member)) member[pgid[pid]] = pid
    if (c[pid] != "" && !(pgid[pid] in owner)) owner[pgid[pid]] = pid
  }
  # The shell of a Bash call shows no mark, and cut loose it hangs under no
  # session: it is whose its group is, as a marked process of that group says.
  for (pid in how) {
    if (how[pid] != "w" || c[pid] != "" || attached[pid] || !(pgid[pid] in owner)) continue
    m = owner[pgid[pid]]
    c[pid] = c[m]; sid[pid] = sid[m]
  }
  # By process group: what a marked process left its group with.
  for (pid in parent) {
    if ((pid in how && how[pid] != "") || (pid in mine) || claude(pid)) continue
    g = pgid[pid]
    if (!(g in member) || g == pid) continue
    if ((g in parent) && !(g in how && how[g] != "")) continue   # the leader lives and is not ours
    m = (g in owner) ? owner[g] : member[g]
    how[pid] = "g"; attached[pid] = 0; c[pid] = c[m]; sid[pid] = sid[m]
  }
  for (pid in how) {
    if (how[pid] == "") continue
    # Its parent, for grouping: the nearest ancestor that is listed too, so
    # `npm run dev` holds the server it started through a shell in between.
    up = parent[pid]; p = parent[pid]
    for (i = 0; i < 64 && p > 1; i++) {
      if ((p in how) && how[p] != "") { up = p; break }
      p = parent[p]
      if (p == "") break
    }
    alive = attached[pid] || (c[pid] != "" && claude(c[pid]))
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%s\t%s\t%s\t%d\t%s\n", pid, up, age[pid], rss[pid], sid[pid], c[pid], alive, attached[pid], how[pid], pgid[pid], cpu[pid], now - age[pid], cmd[pid]
  }
}' "$tmp/names" "$tmp/all" "$tmp/env" > "$tmp/rows"

[ -s "$tmp/rows" ] || exit 0
pids=$(cut -f1 "$tmp/rows" | paste -sd, -)
lsof -a -p "$pids" -iTCP -sTCP:LISTEN -P -n -Fpn > "$tmp/ports" 2>/dev/null
lsof -a -p "$pids" -d cwd -Fpn > "$tmp/cwds" 2>/dev/null

awk -F '\t' '
FILENAME == ARGV[1] {
  if ($0 ~ /^p/) pid = substr($0, 2)
  else if ($0 ~ /^n/) {
    port = $0; sub(/^.*:/, "", port)
    if (port ~ /^[0-9]+$/ && !seen[pid, port]++) ports[pid] = (pid in ports) ? ports[pid] "," port : port
  }
  next
}
FILENAME == ARGV[2] {
  if ($0 ~ /^p/) pid = substr($0, 2)
  else if ($0 ~ /^n/) cwd[pid] = substr($0, 2)
  next
}
{ printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5, $6, $7, $8, ports[$1], cwd[$1], $9, $10, $11, $12, $13 }
' "$tmp/ports" "$tmp/cwds" "$tmp/rows"
