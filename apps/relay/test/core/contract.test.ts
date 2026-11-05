// The testkit's relay contracts, run against the real relay (spec 10.2).
import { defineRelayContract, defineTwoStageAckContract, type RelayHarness } from '@talos-app/testkit'
import { vi } from 'vitest'
import { startTestRelay } from './harness.ts'

// The catch-up case sends 205 frames back to back; the per-socket rate limit (30/s, burst 60) paces them.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 })

const harness: RelayHarness = { start: () => startTestRelay() }

defineRelayContract('real relay (test auth)', harness)
defineTwoStageAckContract('real relay (test auth)', harness)
