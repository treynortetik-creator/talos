# A running thread session whose conversation QUOTES dialog words in every way the review found, with a question menu of its own at
# the bottom. None of it is a dialog waiting on the owner. Typed lines are logged.
. "$(dirname "$0")/lib.sh"
d="$TALOS_APP_HOME/workers/$TALOS_APP_WORKER_THREAD"
mkdir -p "$d"
printf '{"v":1,"thread_id":"%s","pid":%d,"at":"2026-10-30T00:00:00.000Z"}\n' "$TALOS_APP_WORKER_THREAD" "$$" > "$d/ready"
RULE='────────────────────────────────────────────────'
printf '\033[2J\033[H'
printf ' ● Bash(vercel whoami)\n   ⎿  Not logged in. Run vercel login.\n\n'
printf ' ● gh auth status says: Not logged in to any GitHub hosts\n\n'
printf '  public static let trust = ["Yes, I trust this folder", "Yes, I trust these settings"]\n'
printf '  ❯ 1. ship it please\n\n'
printf ' %s\n  Which way?\n\n  ❯ 1. Alpha\n    2. Beta\n\n  Enter to select · Esc to cancel\n' "$RULE"
while IFS= read -r line; do
  printf '%s %s\n' "$TALOS_APP_WORKER_THREAD" "$line" >> "${FAKE_TYPED_LOG:-/dev/null}"
done
idle
