import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineHostileCases } from './support/guarded-fetch-hostile-cases.ts'

defineHostileCases({ describe, it, expect, beforeAll, afterAll } as never)
