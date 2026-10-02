#!/bin/sh
# strays: everything worth knowing about one process, one `key<TAB>value` a line.
#
#   info.sh <pid> [session id] [claude pid]
#
# started (as ps prints it), program (the file it runs), command, user, cpu,
# rss (KB), ppid, pgid, tty, cwd, one `listen` line per listening address, and
# what is known of the session that started it: its name, kind and folder from
# Claude Code's own registry while it runs, its transcript once it is gone.
set -u
pid=${1:-}
sid=${2:-}
cpid=${3:-}
case "$pid" in '' | *[!0-9]*) exit 1 ;; esac
home="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
put() { [ -n "$2" ] && printf '%s\t%s\n' "$1" "$2"; }
one() { ps -ww -o "$1=" -p "$pid" 2>/dev/null | sed 's/^ *//; s/ *$//' | tr '\t\n' '  '; }

kill -0 "$pid" 2>/dev/null || { put gone 1; exit 0; }
put started "$(one lstart)"
put program "$(one comm)"
put command "$(one command)"
put user "$(one user)"
put cpu "$(one pcpu)"
put rss "$(one rss)"
put ppid "$(one ppid)"
put pgid "$(one pgid)"
put tty "$(one tty)"
put cwd "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
lsof -a -p "$pid" -iTCP -sTCP:LISTEN -P -n -Fn 2>/dev/null | sed -n 's/^n//p' | sort -u | while read -r address; do
  put listen "$address"
done

# A flat JSON file: pull one string field out of it.
field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1" | head -1; }
case "$cpid" in '' | *[!0-9]*) ;; *)
  file="$home/sessions/$cpid.json"
  if [ -f "$file" ] && kill -0 "$cpid" 2>/dev/null; then
    put session_alive 1
    put session_name "$(field "$file" name)"
    put session_kind "$(field "$file" entrypoint)"
    put session_cwd "$(field "$file" cwd)"
    put session_status "$(field "$file" status)"
    [ -n "$sid" ] || sid=$(field "$file" sessionId)
  fi
  ;;
esac
case "$sid" in '' | *[!0-9a-zA-Z-]*) ;; *)
  put session_id "$sid"
  for transcript in "$home"/projects/*/"$sid".jsonl; do
    [ -f "$transcript" ] || continue
    put transcript "$transcript"
    put transcript_cwd "$(head -c 20000 "$transcript" | sed -n 's/.*"cwd":"\([^"]*\)".*/\1/p' | head -1)"
    break
  done
  ;;
esac
