#!/bin/sh
# strays: ends the given processes, politely and then firmly.
#
#   kill.sh <pid>@<start> ...
#
# <start> is when the scan saw the process start (epoch seconds). A pid can be
# handed to another program between the scan and the keypress, so a process is
# touched only when it still started at that moment, belongs to this user, and
# is not a Claude Code session. Prints the pids it ended.
set -u
now=$(date +%s)
me=$(id -u)
targets=""
for arg in "$@"; do
  pid=${arg%@*}
  start=${arg#*@}
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  case "$start" in '' | *[!0-9]*) continue ;; esac
  [ "$pid" -gt 1 ] || continue
  line=$(ps -o uid=,etime=,comm= -p "$pid" 2>/dev/null) || continue
  [ -n "$line" ] || continue
  # uid, then elapsed as [[dd-]hh:]mm:ss, then the program
  set -- $line
  [ "$1" = "$me" ] || continue
  case "$(basename "$3")" in claude) continue ;; esac
  began=$(echo "$2" | awk -v now="$now" '{
    d = 0; e = $1
    if (index(e, "-")) { d = substr(e, 1, index(e, "-") - 1); e = substr(e, index(e, "-") + 1) }
    n = split(e, p, ":")
    s = (n == 3) ? p[1] * 3600 + p[2] * 60 + p[3] : p[1] * 60 + p[2]
    print now - d * 86400 - s
  }')
  drift=$((began - start))
  [ "$drift" -ge -5 ] && [ "$drift" -le 5 ] || continue
  targets="$targets $pid"
done
[ -n "$targets" ] || exit 0
# shellcheck disable=SC2086
kill -TERM $targets 2>/dev/null
left="$targets"
i=0
while [ "$i" -lt 20 ] && [ -n "$left" ]; do
  sleep 0.1
  i=$((i + 1))
  left=""
  for pid in $targets; do kill -0 "$pid" 2>/dev/null && left="$left $pid"; done
done
# shellcheck disable=SC2086
[ -n "$left" ] && kill -KILL $left 2>/dev/null
echo "$targets"
