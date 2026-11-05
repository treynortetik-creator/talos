// Loaded before every bridge test (bunfig.toml). A test bridge, in process or spawned, must never find the owner's real
// Chronos and touch its live runs: on 2026-11-03 a test's bridge closed the live morning brief as session_ended.
// Tests that want a scheduler pass TALOS_APP_CHRONOS_BIN to a fake one, which still works.
process.env.TALOS_APP_CHRONOS_AUTODISCOVER = 'off'

// Likewise no bridge test may run the owner's real `claude` (doctor does); a quiet fake is first on PATH unless a test swaps it.
import { installFakeClaude } from './fake-claude.ts'

installFakeClaude()
