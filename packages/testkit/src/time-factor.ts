/**
 * How much longer a test may take on this machine: TALOS_TEST_TIME_FACTOR (scripts/gate.sh sets 3 on a machine with 4 cores or
 * fewer; default 1). It scales a test's own timeout, and a time budget a test holds the code to with slack for the machine, never
 * a product deadline or a ratio of two times measured on the same machine (those stay exactly as written).
 */
export function timeFactor(): number {
  const n = Number(process.env.TALOS_TEST_TIME_FACTOR)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/** `ms` on this machine: ms × timeFactor(). */
export const t = (ms: number): number => Math.round(ms * timeFactor())
