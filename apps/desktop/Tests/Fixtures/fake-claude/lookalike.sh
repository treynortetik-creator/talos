#!/bin/bash
# A bridge lookalike outside any supervised group (same command line as the fake bridge holder).
exec -a "bun apps/bridge/src/server.ts" /bin/sleep "${FAKE_MAX_LIFETIME:-600}"
