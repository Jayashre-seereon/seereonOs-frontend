import { registerSeed, type Router } from '../server'
import { buildSeed } from '../seed'
import * as auth from './auth'
import * as people from './people'
import * as settings from './settings'
import * as admin from './admin'
import * as billing from './billing'
import * as projects from './projects'
import * as tasks from './tasks'
import * as notifications from './notifications'
import * as timesheets from './timesheets'
import * as payroll from './payroll'
import * as sales from './sales'
import * as finance from './finance'
import * as operations from './operations'
import * as dashboards from './dashboards'
import * as reports from './reports'
import * as taskflow from './taskflow'
import * as documentsR from './documents'
import * as hr from './hr'
import * as spend from './spend'
import * as clients from './clients'
import * as company from './company'
import * as makerChecker from '../makerChecker'
import * as access from './access'
import * as master from './master'
import * as docsV7 from './docsV7'
import * as invoices from './invoices'
import * as estimates from './estimates'
import * as workflowsV7 from './workflowsV7'

let done = false
export function registerAll(r: Router) {
  if (done) return
  done = true
  registerSeed(buildSeed)
  const modules = { auth, people, settings, admin, billing, projects, tasks, notifications, timesheets, payroll, sales, finance, operations, dashboards, reports, taskflow, documents: documentsR, hr, spend, clients, company, makerChecker, access, master, estimates, invoices, docs: docsV7, workflows: workflowsV7 }
  for (const [name, m] of Object.entries(modules)) {
    r.module = name // OpenAPI tag of the routes this module registers
    m.register(r)
  }
  r.module = 'core'
}
