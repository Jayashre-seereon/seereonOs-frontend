// v4 organisation master data (org profile, locations, departments, designations, grades,
// cost centres, shifts) — defaults for every new workspace and the realistic demo set.
//
// • provisionMaster(db, tenant, base) runs for every tenant (seed + each signup). It only creates
//   what is missing, so it is idempotent.
// • seedMaster(db, h) replaces the defaults of the demo tenants (Seereon richly, Kalinga lightly)
//   and assigns every demo user a department, designation, grade, location, shift, cost centre and
//   employee code (PREFIX-NNN in joining order).
//
// Note: `Designation.default_role_id` stores a role KEY (RoleDef.key, e.g. 'project_manager'),
// not a row id — role keys are stable across tenants and survive role edits.
import { persist, type DB } from '../server'
import type * as E from '@/types/entities'
import type * as A from '@/types/access'
import { addDays, fmtDate } from '@/domain/calendar'
import { renderTemplate, LOGIN_URL } from '../email'
import type { SeedHelpers } from './index'

type Base = () => E.Base
const L = (lakh: number) => Math.round(lakh * 100000 * 100) // lakh rupees → paise

/** "Kalinga Softworks" → "KS", "Acme" → "ACM". */
export function prefixFromName(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !/^(pvt|ltd|private|limited|llp|inc|the|and|of)$/i.test(w))
  const p = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? 'EMP').slice(0, 3)
  return p.toUpperCase() || 'EMP'
}

/** Working days a default shift should cover from the tenant calendar (Sat included unless all Saturdays are off). */
function calendarDays(t: E.Tenant): number[] {
  const off = new Set(t.settings?.['calendar.weekly_off'] ?? [0])
  const days = [1, 2, 3, 4, 5].filter((d) => !off.has(d))
  if (t.settings?.['calendar.saturday_rule'] !== 'all_off' && !off.has(6)) days.push(6)
  return days
}

function blankOrg(t: E.Tenant): A.OrgProfile {
  return {
    legal_name: t.name, brand_name: t.name, cin: '', gstin: '', pan: '', tan: '', registered_address: '', corporate_address: '', city: '', state: '', pincode: '', country: 'India',
    phone: '', email: '', website: '', incorporated_on: null, employee_code_prefix: prefixFromName(t.name), employee_code_next: 1, bank_name: '', bank_account_masked: '', ifsc: '',
  }
}

const has = (list: { tenant_id: string }[], tid: string) => list.some((x) => x.tenant_id === tid)

export function provisionMaster(db: DB, tenant: E.Tenant, base: Base) {
  const tid = tenant.id
  if (!tenant.org) tenant.org = blankOrg(tenant)
  if (!has(db.locations, tid))
    db.locations.push({ ...base(), name: 'Head office', code: 'HO', address: '', city: '', state: '', timezone: tenant.time_zone || 'Asia/Kolkata', holiday_calendar: 'Company holidays', is_head_office: true, active: true })
  if (!has(db.grades, tid)) {
    const g: [string, string, number][] = [['L1', 'Trainee', 1.0], ['L2', 'Associate', 1.0], ['L3', 'Senior', 1.0], ['L4', 'Lead', 1.1], ['L5', 'Head', 1.2]]
    for (const [code, name, lm] of g) db.grades.push({ ...base(), code, name, min_ctc_paise: null, max_ctc_paise: null, leave_multiplier: lm, active: true })
  }
  if (!has(db.cost_centres, tid) && !has(db.departments, tid)) {
    const defs: [string, string, A.Department['kind']][] = [['Management', 'MGT', 'management'], ['Delivery', 'DEL', 'delivery'], ['Sales', 'SAL', 'sales'], ['Operations', 'OPS', 'operations']]
    for (const [name, code, kind] of defs) {
      const cc = { ...base(), code: `CC-${code}`, name, owner_id: null, active: true }
      db.cost_centres.push(cc)
      db.departments.push({ ...base(), name, code, head_id: null, parent_id: null, cost_centre_id: cc.id, kind, active: true })
    }
  }
  if (!has(db.designations, tid)) {
    const dep = (kind: A.Department['kind']) => db.departments.find((d) => d.tenant_id === tid && d.kind === kind)?.id ?? null
    const gr = (code: string) => db.grades.find((g) => g.tenant_id === tid && g.code === code)?.id ?? null
    const defs: [string, A.Department['kind'], string, string][] = [
      ['Managing Director', 'management', 'L5', 'ceo'],
      ['Project Manager', 'delivery', 'L4', 'project_manager'],
      ['Software Engineer', 'delivery', 'L2', 'employee'],
      ['Sales Executive', 'sales', 'L2', 'sales_executive'],
      ['HR Executive', 'operations', 'L2', 'hr_executive'],
    ]
    for (const [name, kind, g, role] of defs) db.designations.push({ ...base(), name, department_id: dep(kind), grade_id: gr(g), default_role_id: role, active: true })
  }
  if (!has(db.shifts, tid))
    db.shifts.push({
      ...base(), name: 'General shift', code: 'GEN', start_time: '09:30', end_time: '18:30', break_minutes: 60, grace_minutes: 15, working_days: calendarDays(tenant), night_shift: false,
      min_hours: tenant.settings?.['calendar.min_hours_per_day'] ?? 8, is_default: true, active: true,
    })
}

/* ------------------------------------------------------------------ */
/* Demo data                                                            */
/* ------------------------------------------------------------------ */
function clearTenant(db: DB, tid: string) {
  db.locations = db.locations.filter((x) => x.tenant_id !== tid)
  db.departments = db.departments.filter((x) => x.tenant_id !== tid)
  db.designations = db.designations.filter((x) => x.tenant_id !== tid)
  db.grades = db.grades.filter((x) => x.tenant_id !== tid)
  db.cost_centres = db.cost_centres.filter((x) => x.tenant_id !== tid)
  db.shifts = db.shifts.filter((x) => x.tenant_id !== tid)
}

interface Placement { dept: string; desig: string; loc?: string; shift?: string }

/** Assign master refs + employee codes (PREFIX-NNN in joining order) to a tenant's users. Safe to re-run. */
function placeUsers(db: DB, t: E.Tenant, plan: Record<string, Placement>, fallback: Placement) {
  const id = (table: 'departments' | 'designations' | 'locations' | 'shifts', key: string) => `${table.slice(0, 3)}_${t.slug}_${key}`
  const users = db.users.filter((u) => u.tenant_id === t.id && !u.is_super_admin).sort((a, b) => a.joined_on.localeCompare(b.joined_on) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const prefix = t.org?.employee_code_prefix || 'EMP'
  users.forEach((u, i) => {
    const p = plan[u.id] ?? fallback
    const dep = db.departments.find((d) => d.id === id('departments', p.dept))
    const des = db.designations.find((d) => d.id === id('designations', p.desig))
    u.department_id = dep?.id ?? null
    u.designation_id = des?.id ?? null
    u.grade_id = des?.grade_id ?? null
    u.cost_centre_id = dep?.cost_centre_id ?? null
    u.location_id = id('locations', p.loc ?? 'hq')
    u.shift_id = id('shifts', p.shift ?? 'gen')
    u.employment_type = u.employment_type ?? 'full_time'
    u.employee_code = `${prefix}-${String(i + 1).padStart(3, '0')}`
  })
  if (t.org) t.org.employee_code_next = users.length + 1
}

const SEEREON_PLAN: Record<string, Placement> = {
  u_santosh: { dept: 'lead', desig: 'ceo' },
  u_subhankar: { dept: 'del', desig: 'delhead' },
  u_hritesh: { dept: 'del', desig: 'srmern', shift: 'client' },
  u_bijaya: { dept: 'del', desig: 'fastapi' },
  u_jagannath: { dept: 'del', desig: 'fastapi', loc: 'pune', shift: 'client' },
  u_jayashree: { dept: 'del', desig: 'mern' },
  u_pragyasmita: { dept: 'del', desig: 'fullstack' },
  u_ankit: { dept: 'del', desig: 'qa' },
  u_baishali: { dept: 'sal', desig: 'saleslead' },
  u_subham: { dept: 'sal', desig: 'bd' },
  u_priya: { dept: 'ops', desig: 'hracc' },
  u_debasish: { dept: 'it', desig: 'itadmin' },
}

function seedSeereon(db: DB, h: SeedHelpers, t: E.Tenant) {
  const tid = t.id
  const b = (id: string): E.Base => ({ ...h.base(tid), id })
  clearTenant(db, tid)
  t.org = {
    legal_name: 'Seereon Consulting & IT Services Pvt. Ltd.', brand_name: 'Seereon',
    cin: 'U72900OR2025PTC048213', gstin: '21AAKCS4821M1Z5', pan: 'AAKCS4821M', tan: 'BBNS04821E',
    registered_address: '2nd floor, Khandagiri Square, Khandagiri', corporate_address: '2nd floor, Khandagiri Square, Khandagiri', city: 'Bhubaneswar', state: 'Odisha', pincode: '751030', country: 'India',
    phone: '+91 90907 05533', email: 'santosh@seereon.co.in', website: 'seereon.co.in', incorporated_on: '2025-04-14',
    employee_code_prefix: 'SCI', employee_code_next: 1, bank_name: 'HDFC Bank', bank_account_masked: 'XXXXXXXXXX4821', ifsc: 'HDFC0001827',
  }
  const s = 'seereon'
  db.locations.push(
    { ...b(`loc_${s}_hq`), name: 'Bhubaneswar HQ', code: 'BBS', address: '2nd floor, Khandagiri Square, Khandagiri', city: 'Bhubaneswar', state: 'Odisha', timezone: 'Asia/Kolkata', holiday_calendar: 'Odisha holidays', is_head_office: true, active: true },
    { ...b(`loc_${s}_pune`), name: 'Pune client site', code: 'PNQ', address: 'Hinjewadi Phase 1, Rajiv Gandhi Infotech Park', city: 'Pune', state: 'Maharashtra', timezone: 'Asia/Kolkata', holiday_calendar: 'Client calendar', is_head_office: false, active: true },
  )
  const cc = (key: string, code: string, name: string, owner: string | null) => db.cost_centres.push({ ...b(`cc_${s}_${key}`), code, name, owner_id: owner, active: true })
  cc('lead', 'CC-LEAD', 'Leadership & corporate', 'u_santosh')
  cc('del', 'CC-DEL', 'Delivery', 'u_subhankar')
  cc('sap', 'CC-SAP', 'SAP practice', 'u_subhankar')
  cc('sal', 'CC-SAL', 'Sales & marketing', 'u_baishali')
  cc('ops', 'CC-OPS', 'HR & operations', 'u_priya')
  cc('it', 'CC-IT', 'IT & infrastructure', 'u_debasish')
  const dep = (key: string, name: string, code: string, head: string | null, parent: string | null, ccKey: string, kind: A.Department['kind']) =>
    db.departments.push({ ...b(`dep_${s}_${key}`), name, code, head_id: head, parent_id: parent ? `dep_${s}_${parent}` : null, cost_centre_id: `cc_${s}_${ccKey}`, kind, active: true })
  dep('lead', 'Leadership', 'LEAD', 'u_santosh', null, 'lead', 'management')
  dep('del', 'Delivery', 'DEL', 'u_subhankar', 'lead', 'del', 'delivery')
  dep('sap', 'SAP practice', 'SAP', 'u_subhankar', 'del', 'sap', 'delivery')
  dep('sal', 'Sales & marketing', 'SAL', 'u_baishali', 'lead', 'sal', 'sales')
  dep('ops', 'HR & operations', 'OPS', 'u_priya', 'lead', 'ops', 'operations')
  dep('it', 'IT & admin', 'IT', 'u_debasish', 'ops', 'it', 'operations')
  const grades: [string, string, number | null, number | null, number][] = [
    ['L1', 'Trainee', L(2), L(3.6), 1.0],
    ['L2', 'Associate', L(3.6), L(6), 1.0],
    ['L3', 'Senior associate', L(6), L(10), 1.0],
    ['L4', 'Lead', L(10), L(16), 1.1],
    ['L5', 'Head of function', L(16), L(30), 1.2],
    ['L6', 'Leadership', L(30), null, 1.25],
  ]
  for (const [code, name, min, max, lm] of grades) db.grades.push({ ...b(`gra_${s}_${code.toLowerCase()}`), code, name, min_ctc_paise: min, max_ctc_paise: max, leave_multiplier: lm, active: true })
  const des = (key: string, name: string, depKey: string, grade: string, role: string) =>
    db.designations.push({ ...b(`des_${s}_${key}`), name, department_id: `dep_${s}_${depKey}`, grade_id: `gra_${s}_${grade}`, default_role_id: role, active: true })
  des('ceo', 'Founder & CEO', 'lead', 'l6', 'ceo')
  des('delhead', 'Delivery Head', 'del', 'l4', 'project_manager')
  des('srmern', 'Senior MERN Developer', 'del', 'l3', 'employee')
  des('mern', 'MERN Developer', 'del', 'l2', 'employee')
  des('fastapi', 'FastAPI Developer', 'del', 'l2', 'employee')
  des('fullstack', 'Full-stack Developer (Laravel/React)', 'del', 'l2', 'employee')
  des('qa', 'QA Engineer', 'del', 'l2', 'employee')
  des('sapcons', 'SAP ABAP Consultant', 'sap', 'l3', 'employee')
  des('saleslead', 'Sales & Content Lead', 'sal', 'l3', 'sales_manager')
  des('bd', 'Business Development', 'sal', 'l2', 'sales_executive')
  des('hracc', 'HR & Accounts', 'ops', 'l2', 'hr_manager')
  des('itadmin', 'IT & Systems Administrator', 'it', 'l2', 'administrator')
  const min = t.settings['calendar.min_hours_per_day'] ?? 9
  db.shifts.push(
    { ...b(`shi_${s}_gen`), name: 'General shift', code: 'GEN', start_time: '09:30', end_time: '18:30', break_minutes: 60, grace_minutes: 15, working_days: calendarDays(t), night_shift: false, min_hours: Math.min(min, 8), is_default: true, active: true },
    { ...b(`shi_${s}_client`), name: 'Client shift', code: 'CLT', start_time: '11:00', end_time: '20:00', break_minutes: 60, grace_minutes: 10, working_days: [1, 2, 3, 4, 5], night_shift: false, min_hours: 8, is_default: false, active: true },
  )
  placeUsers(db, t, SEEREON_PLAN, { dept: 'del', desig: 'mern' })

  // A few emails already "sent" so Setup → Emails → Sent isn't empty on day one.
  const tpl = (key: string) => db.email_templates.find((x) => x.tenant_id === tid && x.key === key)
  const send = (key: string, userId: string, vars: Record<string, string>, daysAgo: number) => {
    const tp = tpl(key)
    const u = db.users.find((x) => x.id === userId)
    if (!tp || !u) return
    const all = { company: t.org!.brand_name, login_url: LOGIN_URL, employee_name: u.name, username: u.email, ...vars }
    const at = addDays(h.today, -daysAgo) + 'T04:42:00.000Z'
    db.email_outbox.push({ ...h.base(tid), created_at: at, updated_at: at, to: u.email, to_user_id: u.id, subject: renderTemplate(tp.subject, all), body: renderTemplate(tp.body, all), template_key: key, related_entity: 'user', related_id: u.id, status: 'sent', sent_at: at })
  }
  const subham = db.users.find((u) => u.id === 'u_subham')
  if (subham) send('welcome', 'u_subham', { temp_password: 'Wq7-mvk2-Lp', role_name: 'Sales Executive', manager_name: 'Santosh Nayak', joining_date: fmtDate(subham.joined_on, 'long') }, 161)
  const prag = db.users.find((u) => u.id === 'u_pragyasmita')
  if (prag) send('welcome', 'u_pragyasmita', { temp_password: 'Hn4-tqz8-Rc', role_name: 'Employee', manager_name: 'Subhankar Rout', joining_date: fmtDate(prag.joined_on, 'long') }, 201)
  send('password_reset', 'u_jayashree', { temp_password: 'Bt9-kfe3-Vm' }, 12)
}

function seedKalinga(db: DB, h: SeedHelpers, t: E.Tenant) {
  const tid = t.id
  const s = t.slug
  const b = (id: string): E.Base => ({ ...h.base(tid), id })
  clearTenant(db, tid)
  t.org = {
    ...blankOrg(t), legal_name: 'Kalinga Softworks Pvt. Ltd.', brand_name: 'Kalinga Softworks', city: 'Bhubaneswar', state: 'Odisha', pincode: '751024',
    registered_address: 'Infocity, Patia', corporate_address: 'Infocity, Patia', email: 'hello@kalingasoft.in', website: 'kalingasoft.in', employee_code_prefix: 'KS',
  }
  db.locations.push({ ...b(`loc_${s}_hq`), name: 'Patia office', code: 'PAT', address: 'Infocity, Patia', city: 'Bhubaneswar', state: 'Odisha', timezone: 'Asia/Kolkata', holiday_calendar: 'Odisha holidays', is_head_office: true, active: true })
  const defs: [string, string, string, A.Department['kind'], string | null][] = [['mgmt', 'Management', 'MGT', 'management', 'u_k_ananya'], ['del', 'Engineering', 'ENG', 'delivery', 'u_k_rakesh'], ['sal', 'Sales', 'SAL', 'sales', 'u_k_meera']]
  for (const [key, name, code, kind, head] of defs) {
    db.cost_centres.push({ ...b(`cc_${s}_${key}`), code: `CC-${code}`, name, owner_id: head, active: true })
    db.departments.push({ ...b(`dep_${s}_${key}`), name, code, head_id: head, parent_id: key === 'mgmt' ? null : `dep_${s}_mgmt`, cost_centre_id: `cc_${s}_${key}`, kind, active: true })
  }
  const g: [string, string, number][] = [['L1', 'Trainee', 1], ['L2', 'Engineer', 1], ['L3', 'Senior engineer', 1], ['L4', 'Manager', 1.1], ['L5', 'Director', 1.2]]
  for (const [code, name, lm] of g) db.grades.push({ ...b(`gra_${s}_${code.toLowerCase()}`), code, name, min_ctc_paise: null, max_ctc_paise: null, leave_multiplier: lm, active: true })
  const des = (key: string, name: string, depKey: string, grade: string, role: string) => db.designations.push({ ...b(`des_${s}_${key}`), name, department_id: `dep_${s}_${depKey}`, grade_id: `gra_${s}_${grade}`, default_role_id: role, active: true })
  des('md', 'Managing Director', 'mgmt', 'l5', 'ceo')
  des('pm', 'Project Manager', 'del', 'l4', 'project_manager')
  des('react', 'React Developer', 'del', 'l2', 'employee')
  des('python', 'Python Developer', 'del', 'l2', 'employee')
  des('salesmgr', 'Sales Manager', 'sal', 'l4', 'sales_manager')
  db.shifts.push({ ...b(`shi_${s}_gen`), name: 'General shift', code: 'GEN', start_time: '09:30', end_time: '18:30', break_minutes: 60, grace_minutes: 15, working_days: calendarDays(t), night_shift: false, min_hours: 8, is_default: true, active: true })
  placeUsers(db, t, {
    u_k_ananya: { dept: 'mgmt', desig: 'md' },
    u_k_rakesh: { dept: 'del', desig: 'pm' },
    u_k_sneha: { dept: 'del', desig: 'react' },
    u_k_arjun: { dept: 'del', desig: 'python' },
    u_k_meera: { dept: 'sal', desig: 'salesmgr' },
  }, { dept: 'del', desig: 'react' })
}

export function seedMaster(db: DB, h: SeedHelpers) {
  const seereon = db.tenants.find((t) => t.slug === 'seereon')
  const kalinga = db.tenants.find((t) => t.slug === 'kalinga')
  if (seereon) seedSeereon(db, h, seereon)
  if (kalinga) seedKalinga(db, h, kalinga)
  // seedMaster currently runs inside the access seed, before later seeds add people (e.g. Ankit, a
  // past employee). Re-place Seereon users once the whole seed has run so codes follow joining order.
  if (seereon && typeof queueMicrotask === 'function')
    queueMicrotask(() => {
      if (db.users.some((u) => u.tenant_id === seereon.id && !u.employee_code && !u.is_super_admin)) {
        placeUsers(db, seereon, SEEREON_PLAN, { dept: 'del', desig: 'mern' })
        persist()
      }
    })
}

/** Exposed for the seed orchestrator: call after all seeds if seedMaster is moved to the end. */
export function finaliseMasterSeed(db: DB) {
  const seereon = db.tenants.find((t) => t.slug === 'seereon')
  if (seereon) placeUsers(db, seereon, SEEREON_PLAN, { dept: 'del', desig: 'mern' })
}
