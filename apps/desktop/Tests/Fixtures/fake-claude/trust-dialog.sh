# The folder-trust dialog; never answered by Talos.
printf '\033[2J\033[H'
printf ' Accessing workspace:\n\n /tmp/agent\n\n Quick safety check: Is this a project you created or one you trust?\n\n'
printf ' ❯ 1. Yes, I trust this folder\n   2. No, exit\n\n Enter to confirm · Esc to cancel\n'
IFS= read -r _
sleep "${FAKE_MAX_LIFETIME:-600}"
