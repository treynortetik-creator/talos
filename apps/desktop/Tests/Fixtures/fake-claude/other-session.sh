#!/bin/bash
# Stands in for another Claude session: its argv carries whatever the test passes (e.g. --channels). Sleeps as a child,
# so this process keeps its argv.
/bin/sleep "${FAKE_MAX_LIFETIME:-600}"
