#!/bin/sh
# strays: ends the given processes, politely and then firmly.
# Touches only a process that carries Claude Code's marker or hangs under a
# Claude Code session, and never a session itself, whatever it is asked: a pid can be reused between the
# scan and the keypress. Prints the pids it ended.
set -u
# Whether a Claude Code session is among the ancestors of the process.
under_claude() {
  p=$1
  n=0
  while [ "$n" -lt 64 ]; do
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    [ -n "$p" ] && [ "$p" -gt 1 ] || return 1
    case "$(basename "$(ps -o comm= -p "$p" 2>/dev/null)")" in claude) return 0 ;; esac
    n=$((n + 1))
  done
  return 1
}
targets=""
for pid in "$@"; do
  case "$pid" in '' | *[!0-9]*) continue ;; esac
  line=$(ps -Eww -o command= -p "$pid" 2>/dev/null) || continue
  case "$(basename "$(ps -o comm= -p "$pid" 2>/dev/null)")" in claude) continue ;; esac
  case "$line" in
  *" CLAUDECODE=1"*) ;;
  *) under_claude "$pid" || continue ;;
  esac
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
