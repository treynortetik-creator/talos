// The same hostile-peer cases as packages/protocol/test/guarded-fetch-hostile.test.ts, under the runtime the bridge ships on.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { defineHostileCases } from '../../../../packages/protocol/test/support/guarded-fetch-hostile-cases.ts'

defineHostileCases({ describe, it, expect, beforeAll, afterAll } as never)
