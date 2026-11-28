#!/bin/sh
# permission-pre.sh: the PreToolUse companion of permission-relay.py (docs/CLAUDE-CODE.md C3.5, "the prompt is over").
# It runs before EVERY tool call, so it is a few lines of POSIX sh (no python start, about a fifth of the time) that never block, never
# print and always exit 0 (an exit code 2 from a PreToolUse hook BLOCKS the tool call, so every failure here is `|| exit 0`, stderr is
# closed, and the one write is done by a regular builtin, `true`, whose failed redirect only returns non-zero; `:` is a special
# builtin that would end the script with 2). It leaves one EMPTY file per call in <app home>/run/pretool (a 0700 folder we own, not a link;
# files 0600; umask 077):
#   <key>.<session id>.<agent id or ->.<tool_use id>.<epoch>
# where <key> is the POSIX cksum of the tool name and the RAW tool_input text exactly as Claude Code wrote it (nothing is canonicalised, so
# there is nothing for this script and the python hook to disagree about). No tool input is ever stored. The permission hook looks its own
# call up there and takes the tool_use id only when exactly one record of its session fits. Records are pruned after an hour (at most every
# ten minutes), and only names of exactly this five-field shape. The input is one JSON object on one line. session_id and agent_id are read
# from anywhere outside tool_input, as the python hook reads them; the tool name and the order tool_name, tool_input, tool_use_id are what
# Claude Code writes for a PreToolUse.
exec 2>/dev/null
umask 077
d="${TALOS_APP_HOME:-$HOME/.config/talos/app}/run/pretool"
[ -L "$d" ] && exit 0
if [ -d "$d" ]; then
  [ -O "$d" ] || exit 0
  case "$(ls -ld "$d")" in 'drwx------'*) ;; *) exit 0 ;; esac
else
  mkdir -p "$d" || exit 0
fi
IFS= read -r in || [ -n "$in" ] || exit 0
q='"'
fld() { case "$1" in *"\"$2\":\""*) val=${1##*"\"$2\":\""}; val=${val%%"$q"*} ;; *) val= ;; esac; }
case "$in" in '{'*) ;; *) exit 0 ;; esac
hd=${in%%',"tool_input":'*}
case "$hd" in *',"hook_event_name":"PreToolUse","tool_name":"'*) ;; *) exit 0 ;; esac
n=${hd##*',"hook_event_name":"PreToolUse","tool_name":"'}
n=${n%%"$q"*}
r=${in#*',"tool_input":'}
ti=${r%',"tool_use_id":"'*}
tl=${r##*',"tool_use_id":"'}
u=${tl%%"$q"*}
tl=${tl#*"$q"}
fld "$hd" session_id
sid=$val
[ -n "$sid" ] || { fld "$tl" session_id; sid=$val; }
fld "$hd" agent_id
a=$val
[ -n "$a" ] || { fld "$tl" agent_id; a=$val; }
[ -n "$a" ] || a=-
case "$sid$a$u" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
[ -n "$sid" ] && [ -n "$u" ] && [ -n "$n" ] || exit 0
[ ${#sid} -le 100 ] && [ ${#a} -le 100 ] && [ ${#u} -le 100 ] || exit 0
set -- $(printf '%s\n%s' "$n" "$ti" | cksum)
case "$1$2" in ''|*[!0-9]*) exit 0 ;; esac
now=$(date +%s)
case "$now" in ''|*[!0-9]*) exit 0 ;; esac
nm="$1-$2.$sid.$a.$u.$now"
[ ${#nm} -le 250 ] || exit 0
true 2>/dev/null >"$d/$nm" || exit 0
last=0
[ -r "$d/.pruned" ] && read -r last < "$d/.pruned"
case "$last" in ''|*[!0-9]*) last=0 ;; esac
[ ${#last} -le 10 ] || last=0
if [ $((now - last)) -ge 600 ]; then
  echo "$now" > "$d/.pruned"
  cut=$((now - 3600))
  set --
  c=0
  for p in "$d"/*.*; do
    [ -e "$p" ] || continue
    b=${p##*/}
    e=${b##*.}
    case "$e" in ''|*[!0-9]*) continue ;; esac
    [ ${#e} -le 10 ] || continue
    k=${b%%.*}
    case "$k" in ''|*[!0-9-]*) continue ;; esac
    case "$b" in *.*.*.*.*.*) continue ;; *.*.*.*.*) ;; *) continue ;; esac
    if [ "$e" -lt "$cut" ]; then
      set -- "$@" "$p"
      c=$((c + 1))
      if [ "$c" -ge 400 ]; then rm -f -- "$@"; set --; c=0; fi
    fi
  done
  [ "$c" -gt 0 ] && rm -f -- "$@"
fi
exit 0
