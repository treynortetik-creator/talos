import type { ModuleExtras } from '../generic/common.ts'
import { genericFamilyModule } from '../generic/index.ts'
import type { IntegrationModule } from '../types.ts'
import { n8nSetup } from './setup.ts'

export const integration: IntegrationModule & ModuleExtras = genericFamilyModule(n8nSetup)
