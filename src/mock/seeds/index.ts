// Seed extensions for v3 business processes. Each area owns its own file and fills the tables it owns.
import type { DB } from '../server'
import type { Base } from '@/types/entities'
import * as tasks from './tasks'
import * as documents from './documents'
import * as people from './people'
import * as spend from './spend'
import * as company from './company'
import * as access from './access'
import * as costing from './costing'
import * as time from './time'
import * as ops from './ops'
import * as estimates from './estimates'
import { finaliseMasterSeed } from './master'
import * as documentsV7 from './documentsV7'
import * as workflows from './workflows'
import * as invoices from './invoices'

export interface SeedHelpers {
  today: string
  base: (tenant_id: string) => Base
  id: (prefix: string) => string
  rnd: () => number
}

export function extendSeed(db: DB, h: SeedHelpers) {
  for (const m of [access, tasks, documents, people, spend, company, time, ops]) m.seed(db, h)
  costing.seed(db, h) // v5 workstream A: saved costing plans + allocations by milestone (after the delivery seed)
  estimates.seed(db, h) // v7: standalone cost estimates (after costing: the converted one mirrors a saved plan)
  finaliseMasterSeed(db)
  documentsV7.seed(db, h) // v7 documents hub (after employee codes and master data are placed)
  workflows.seed(db, h) // v7: workflow templates, letters and in-flight instances (last: needs master placement + appraisals)
  invoices.seed(db, h) // v7: GST detail on seeded invoices, client billing addresses, invoicing settings
}
