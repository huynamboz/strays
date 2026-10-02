#!/bin/sh
# strays: lists the processes Claude Code sessions started that still run.
#
# Claude Code marks every process it starts with CLAUDECODE=1 and the id of its
# session in the environment, and a process keeps its environment after the
# session that started it is gone. A process under a running session is listed
# by its place in the tree, marked or not. One line per process, tab-separated:
#   pid ppid seconds rssKB sessionId claudePid alive attached ports cwd command
# alive: the session that started it still runs. attached: it still hangs under
# that session (a process started with nohup or & is alive but not attached).
set -u
tmp=$(mktemp -d "${TMPDIR:-/tmp}/strays.XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT

ps -axww -o pid=,ppid=,etime=,rss=,command= > "$tmp/all"
ps -axEww -o pid=,command= > "$tmp/env"

awk -v self=$$ '
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
function claude(pid,   first, n, parts) {
  n = split(cmd[pid], parts, " ")
  first = parts[1]
  return first == "claude" || first ~ /\/claude$/ || cmd[pid] ~ /claude-code\/cli\.js/
}
# A command may hold line breaks, and ps prints them as they are: a line that
# does not open a new record continues the one before it.
# First file: every process, for the family tree and the command as typed.
FNR == NR {
  if ($0 ~ /^ *[0-9]+ +[0-9]+ +([0-9]+-)?([0-9]+:)?[0-9]+:[0-9]+ +[0-9]+ /) {
    pid = $1
    parent[pid] = $2
    age[pid] = seconds($3)
    rss[pid] = $4
    line = $0
    sub(/^ *[0-9]+ +[0-9]+ +[^ ]+ +[0-9]+ +/, "", line)
  } else {
    line = cmd[pid] " " $0
  }
  gsub(/\t/, " ", line)
  cmd[pid] = line
  next
}
# Second file: the environments. Remember who carries the marker, and whose it is.
{
  if ($0 ~ /^ *[0-9]+ / && ($1 in parent)) pid = $1
  if (index($0, " CLAUDECODE=1")) marked[pid] = 1
  found = last($0, "CLAUDE_CODE_SESSION_ID=[^ ]+", 23)
  if (found != "") sid[pid] = found
  found = last($0, " CLAUDE_PID=[0-9]+", 12)
  if (found != "") cpid[pid] = found
}
END {
  # Kept: a process that carries the mark, and one that hangs under a running
  # session whatever it carries (macOS shows no environment for its own
  # programs: sh, tail, nc, ssh, so their place in the tree is all there is).
  for (pid in parent) {
    # What the Bash tool runs sits under its shell wrapper; what a session
    # starts for itself (an MCP server, a helper) is its direct child.
    mine = 0; att = 0; own = ""; p = pid
    bash = (cmd[pid] ~ /\/shell-snapshots\//)
    for (i = 0; i < 64 && p > 1; i++) {
      if (p == self) { mine = 1; break }   # this scan and its helpers
      p = parent[p]
      if (p == "") break
      if (claude(p)) { att = 1; if (own == "") own = p }
      else if (own == "" && cmd[p] ~ /\/shell-snapshots\//) bash = 1
    }
    if (mine || (!(pid in marked) && !att)) continue
    keep[pid] = 1; attached[pid] = att; owner[pid] = bash ? own : ""
  }
  for (pid in keep) {
    # Its parent, for grouping: the nearest ancestor that is kept too, so
    # `npm run dev` holds the server it started through a shell in between.
    up = parent[pid]; p = parent[pid]
    for (i = 0; i < 64 && p > 1; i++) {
      if (p in keep) { up = p; break }
      p = parent[p]
      if (p == "") break
    }
    c = (pid in cpid) ? cpid[pid] : ((pid in marked) ? "" : owner[pid])
    alive = attached[pid] || (c != "" && (c in parent) && claude(c))
    printf "%s\t%s\t%s\t%s\t%s\t%s\t%d\t%d\t%s\n", pid, up, age[pid], rss[pid], sid[pid], c, alive, attached[pid], cmd[pid]
  }
}' "$tmp/all" "$tmp/env" > "$tmp/rows"

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
{ printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4, $5, $6, $7, $8, ports[$1], cwd[$1], $9 }
' "$tmp/ports" "$tmp/cwds" "$tmp/rows"
