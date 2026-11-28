import Foundation

/// The PreToolUse hook a thread session runs, the twin of apps/bridge/src/supervisor/pretool-hook.ts (a parity test holds them to
/// the same text and shape). It is a few lines of POSIX sh run as the command itself in a clean environment, so there is no file for
/// the session to rewrite. It leaves one empty record per tool call in <app home>/run/pretool (mode 0700), which the permission
/// hook uses to find the call's tool_use id (docs/CLAUDE-CODE.md C3.5). It never blocks, prints or fails.
enum WorkerPreTool {
  /// The script, line for line: the kit's permission-pre.sh hook without its comments.
  static let script = #"""
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
"""#

  /// The command: the script run by /bin/sh with only the fixed values (never the session's own home or TALOS_APP_HOME).
  static func command(home: String, talosHome: String) -> String {
    "exec /usr/bin/env -i HOME=\(WorkerHook.quote(home)) PATH=/usr/bin:/bin TALOS_APP_HOME=\(WorkerHook.quote(talosHome)) /bin/sh -c \(WorkerHook.quote(script))"
  }

  /// Adds the PreToolUse entry to `hooks` (after the ones there), for every tool. A shape that is not a list is left alone.
  static func add(to hooks: inout [String: Any], session: WorkerHook.Session) {
    if let existing = hooks["PreToolUse"], !(existing is [Any]) { return }
    var entries = (hooks["PreToolUse"] as? [Any]) ?? []
    entries.append(["hooks": [["type": "command", "timeout": 5, "command": command(home: session.home, talosHome: session.talosHome)]]])
    hooks["PreToolUse"] = entries
  }
}
