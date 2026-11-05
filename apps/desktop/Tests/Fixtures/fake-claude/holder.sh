#!/bin/bash
# Stands in for a Telegram poller (its command line contains server.ts). Sleeps.
exec -a "bun run --cwd plugin server.ts" /bin/sleep "${FAKE_MAX_LIFETIME:-600}"
