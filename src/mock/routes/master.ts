// v4 organisation master data + email templates/outbox.
//
// Reads: GET /master/<type> (everyone in the tenant — pickers on employee forms), /master/org,
//        /master/usage, /master/people, /master/shifts/:id/members.
// Writes go through maker-checker (`propose`):
//   • org profile            → entity 'org_profile'   (master.edit, base_version = tenant.version)
//   • locations, departments, designations, grades, cost centres → entity 'master_record' (master.edit)
//   • shifts + assignment    → entity 'shift'         (shifts.manage)
// The appliers registered at the bottom perform the real write (direct apply or on approval) and
// re-check the integrity rules that could have changed in between.
import type * as E from '@/types/entities'
import type * as A from '@/types/access'
import { assertBaseVersion, propose, registerApplier } from '../makerChecker'
import { renderTemplate, LOGIN_URL } from '../email'
import { SYSTEM_EMAIL_TEMPLATES } from '../seeds/access'
import {
  err, find, getDb, insert, logActivity, nowISO, persist, remove, requireAction, roleDef, rows, update, userName, type Ctx, type Router,
} from '../server'

export const MASTER_TABLES = {
  locations: 'locations',
  departments: 'departments',
  designations: 'designations',
  grades: 'grades',
  'cost-centres': 'cost_centres',
  shifts: 'shifts',
} as const
export type MasterPath = keyof typeof MASTER_TABLES
type MasterTable = (typeof MASTER_TABLES)[MasterPath]
type AnyRec = A.Location | A.Department | A.Designation | A.Grade | A.CostCentre | A.Shift

const LABEL: Record<MasterPath, string> = { locations: 'location', departments: 'department', designations: 'designation', grades: 'grade', 'cost-centres': 'cost centre', shifts: 'shift' }
const USER_FIELD: Record<MasterPath, keyof E.User> = { locations: 'location_id', departments: 'department_id', designations: 'designation_id', grades: 'grade_id', 'cost-centres': 'cost_centre_id', shifts: 'shift_id' }
const permOf = (p: MasterPath) => (p === 'shifts' ? 'shifts.manage' : 'master.edit') as 'shifts.manage' | 'master.edit'
const entityOf = (p: MasterPath): A.ChangeEntity => (p === 'shifts' ? 'shift' : 'master_record')
const nameOf = (r: AnyRec) => ('name' in r ? r.name : '') || ('code' in r ? (r as { code: string }).code : '')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/* ------------------------------------------------------------------ */
/* Small validation helpers                                            */
/* ------------------------------------------------------------------ */
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim()
const optId = (v: unknown) => (v === undefined || v === null || v === '' ? null : String(v))
function need(v: string, field: string, label: string, max = 120) {
  if (!v) err(422, 'VALIDATION', `Enter the ${label}.`, field)
  if (v.length > max) err(422, 'VALIDATION', `Keep the ${label} under ${max} characters.`, field)
  return v
}
function code(v: unknown, field = 'code', max = 12) {
  const c = str(v).toUpperCase()
  if (!c) err(422, 'VALIDATION', 'Enter a short code.', field)
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(c) || c.length > max) err(422, 'VALIDATION', `Use letters, digits, - or _ (up to ${max} characters).`, field)
  return c
}
function unique(ctx: Ctx, table: MasterTable, field: 'code' | 'name', value: string, selfId: string | null, label: string) {
  const clash = (rows(ctx, table) as AnyRec[]).find((r) => r.id !== selfId && String((r as unknown as Record<string, unknown>)[field] ?? '').toLowerCase() === value.toLowerCase())
  if (clash) err(409, 'DUPLICATE', `Another ${label} already uses ${field} “${value}”. Pick a different ${field}.`, field)
}
function activeUser(ctx: Ctx, id: string | null, field: string, what: string) {
  if (!id) return null
  const u = rows(ctx, 'users').find((x) => x.id === id)
  if (!u || u.is_super_admin) err(422, 'VALIDATION', `Choose a person from your organisation as ${what}.`, field)
  if (u.status !== 'active') err(422, 'VALIDATION', `${u.name} is not active. Choose an active person as ${what}.`, field)
  return id
}
function ref(ctx: Ctx, table: MasterTable, id: string | null, field: string, label: string) {
  if (!id) return null
  const r = (rows(ctx, table) as AnyRec[]).find((x) => x.id === id) as (AnyRec & { active: boolean }) | undefined
  if (!r) err(422, 'VALIDATION', `Choose a valid ${label}.`, field)
  if (!r.active) err(422, 'VALIDATION', `${nameOf(r)} is inactive. Choose an active ${label}.`, field)
  return id
}
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
function int(v: unknown, field: string, label: string, min: number, max: number) {
  const n = Number(v)
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || Math.round(n) !== n) err(422, 'VALIDATION', `Enter the ${label} as a whole number.`, field)
  if (n < min || n > max) err(422, 'VALIDATION', `The ${label} must be between ${min} and ${max}.`, field)
  return n
}

/* ------------------------------------------------------------------ */
/* Normalise + validate a full record of each type                      */
/* ------------------------------------------------------------------ */
type Draft = Record<string, unknown>
function normalise(ctx: Ctx, type: MasterPath, b: Draft, cur: AnyRec | null): Draft {
  const selfId = cur?.id ?? null
  const table = MASTER_TABLES[type]
  const v = (k: string) => (b[k] !== undefined ? b[k] : (cur as unknown as Draft | null)?.[k])
  switch (type) {
    case 'locations': {
      const out = {
        name: need(str(v('name')), 'name', 'location name', 80), code: code(v('code')), address: str(v('address')).slice(0, 300), city: str(v('city')).slice(0, 60), state: str(v('state')).slice(0, 60),
        timezone: str(v('timezone')) || 'Asia/Kolkata', holiday_calendar: str(v('holiday_calendar')).slice(0, 60) || 'Company holidays', is_head_office: !!v('is_head_office'),
      }
      unique(ctx, table, 'code', out.code, selfId, 'location')
      unique(ctx, table, 'name', out.name, selfId, 'location')
      if (cur && (cur as A.Location).is_head_office && !out.is_head_office)
        err(409, 'HEAD_OFFICE_REQUIRED', 'One location must be the head office. Mark another location as head office instead.', 'is_head_office')
      return out
    }
    case 'departments': {
      const kind = str(v('kind')) || 'delivery'
      if (!['management', 'delivery', 'sales', 'operations'].includes(kind)) err(422, 'VALIDATION', 'Choose what kind of department this is.', 'kind')
      const out = {
        name: need(str(v('name')), 'name', 'department name', 80), code: code(v('code')), kind,
        head_id: activeUser(ctx, optId(v('head_id')), 'head_id', 'department head'),
        parent_id: optId(v('parent_id')), cost_centre_id: optId(v('cost_centre_id')),
      }
      unique(ctx, table, 'code', out.code, selfId, 'department')
      unique(ctx, table, 'name', out.name, selfId, 'department')
      if (out.parent_id) {
        if (out.parent_id === selfId) err(409, 'DEPARTMENT_CYCLE', 'A department cannot sit under itself.', 'parent_id')
        const all = rows(ctx, 'departments')
        const parent = all.find((d) => d.id === out.parent_id)
        if (!parent) err(422, 'VALIDATION', 'Choose a valid parent department.', 'parent_id')
        // walk up from the new parent: reaching this department means a loop
        let p: A.Department | undefined = parent
        for (let i = 0; p && i < 50; i++) {
          if (p.id === selfId) err(409, 'DEPARTMENT_CYCLE', `${parent.name} sits under this department, so it can’t also be its parent.`, 'parent_id')
          p = all.find((d) => d.id === p!.parent_id)
        }
      }
      if (out.cost_centre_id) {
        const cc = rows(ctx, 'cost_centres').find((c) => c.id === out.cost_centre_id)
        if (!cc) err(422, 'VALIDATION', 'Choose a valid cost centre.', 'cost_centre_id')
        if (!cc.active && (cur as A.Department | null)?.cost_centre_id !== cc.id) err(422, 'VALIDATION', `${cc.name} is inactive. Choose an active cost centre.`, 'cost_centre_id')
      }
      return out
    }
    case 'designations': {
      const role = optId(v('default_role_id'))
      if (role) {
        const rd = roleDef(ctx.tenant.id, role)
        if (!rd) err(422, 'VALIDATION', 'Choose a valid default role.', 'default_role_id')
        if (!rd.active) err(422, 'VALIDATION', `The role ${rd.name} is inactive. Choose an active role.`, 'default_role_id')
      }
      const out = {
        name: need(str(v('name')), 'name', 'designation', 80),
        department_id: optId(v('department_id')), grade_id: optId(v('grade_id')), default_role_id: role,
      }
      if (out.department_id !== (cur as A.Designation | null)?.department_id) ref(ctx, 'departments', out.department_id, 'department_id', 'department')
      if (out.grade_id !== (cur as A.Designation | null)?.grade_id) ref(ctx, 'grades', out.grade_id, 'grade_id', 'grade')
      unique(ctx, table, 'name', out.name, selfId, 'designation')
      return out
    }
    case 'grades': {
      const money = (k: string, label: string) => {
        const x = v(k)
        if (x === null || x === undefined || x === '' || x === 0) return null
        const n = Number(x)
        if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) err(422, 'VALIDATION', `Enter the ${label} in rupees.`, k)
        return n
      }
      const lm = Number(v('leave_multiplier') ?? 1)
      const out = {
        code: code(v('code'), 'code', 8), name: need(str(v('name')), 'name', 'grade name', 60),
        min_ctc_paise: money('min_ctc_paise', 'minimum CTC'), max_ctc_paise: money('max_ctc_paise', 'maximum CTC'), leave_multiplier: lm,
      }
      if (!Number.isFinite(lm) || lm < 0.5 || lm > 3) err(422, 'VALIDATION', 'Leave multiplier must be between 0.5 and 3 (1 = standard leave).', 'leave_multiplier')
      if (out.min_ctc_paise !== null && out.max_ctc_paise !== null && out.min_ctc_paise > out.max_ctc_paise)
        err(422, 'GRADE_BAND', 'The minimum CTC is higher than the maximum. Swap them or correct one.', 'max_ctc_paise')
      unique(ctx, table, 'code', out.code, selfId, 'grade')
      return out
    }
    case 'cost-centres': {
      const out = { code: code(v('code'), 'code', 16), name: need(str(v('name')), 'name', 'cost centre name', 80), owner_id: activeUser(ctx, optId(v('owner_id')), 'owner_id', 'owner') }
      unique(ctx, table, 'code', out.code, selfId, 'cost centre')
      return out
    }
    case 'shifts': {
      const start = str(v('start_time'))
      const end = str(v('end_time'))
      if (!HHMM.test(start)) err(422, 'VALIDATION', 'Enter the start time as HH:MM (24-hour).', 'start_time')
      if (!HHMM.test(end)) err(422, 'VALIDATION', 'Enter the end time as HH:MM (24-hour).', 'end_time')
      const len = (minutes(end) - minutes(start) + 1440) % 1440
      if (len === 0) err(422, 'VALIDATION', 'Start and end time are the same. A shift needs some length.', 'end_time')
      const brk = int(v('break_minutes') ?? 0, 'break_minutes', 'break', 0, 240)
      if (brk >= len) err(422, 'SHIFT_BREAK', `The break (${brk} min) must be shorter than the shift (${len} min).`, 'break_minutes')
      const grace = int(v('grace_minutes') ?? 0, 'grace_minutes', 'grace period', 0, 120)
      const days = [...new Set(((v('working_days') as number[] | undefined) ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
      if (!days.length) err(422, 'VALIDATION', 'Pick at least one working day.', 'working_days')
      const minH = Number(v('min_hours') ?? ctx.tenant.settings['calendar.min_hours_per_day'] ?? 8)
      const net = (len - brk) / 60
      if (!Number.isFinite(minH) || minH <= 0) err(422, 'VALIDATION', 'Enter the minimum hours per day.', 'min_hours')
      if (minH > net + 1e-9) err(422, 'SHIFT_MIN_HOURS', `Minimum hours (${minH}h) can’t exceed the working time of the shift (${+net.toFixed(2)}h after break).`, 'min_hours')
      const out = {
        name: need(str(v('name')), 'name', 'shift name', 60), code: code(v('code'), 'code', 8), start_time: start, end_time: end, break_minutes: brk, grace_minutes: grace,
        working_days: days, night_shift: minutes(end) <= minutes(start), min_hours: minH, is_default: !!v('is_default'),
      }
      unique(ctx, table, 'code', out.code, selfId, 'shift')
      unique(ctx, table, 'name', out.name, selfId, 'shift')
      if (cur && (cur as A.Shift).is_default && !out.is_default)
        err(409, 'DEFAULT_SHIFT_REQUIRED', 'One shift must be the default for new joiners. Make another shift the default instead.', 'is_default')
      return out
    }
  }
}

/* ------------------------------------------------------------------ */
/* Usage                                                               */
/* ------------------------------------------------------------------ */
function defaultShiftId(ctx: Ctx) {
  return rows(ctx, 'shifts').find((s) => s.is_default)?.id ?? null
}
/** Effective shift of a user: their own, else the tenant default. */
function shiftOf(ctx: Ctx, u: E.User, def = defaultShiftId(ctx)) {
  return u.shift_id ?? def
}
function peopleOf(ctx: Ctx, type: MasterPath, id: string, includeInactive = false) {
  const def = type === 'shifts' ? defaultShiftId(ctx) : null
  return rows(ctx, 'users').filter((u) => !u.is_super_admin && (includeInactive || u.status !== 'deactivated') && (type === 'shifts' ? shiftOf(ctx, u, def) === id : u[USER_FIELD[type]] === id))
}
const pl = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
/** Where a record is referenced (people + other master rows). Empty = safe to delete. */
function usedBy(ctx: Ctx, type: MasterPath, id: string): string[] {
  const out: string[] = []
  const people = peopleOf(ctx, type, id, true)
  if (people.length) out.push(pl(people.length, 'person', 'people') + (people.length <= 3 ? ` (${people.map((p) => p.name).join(', ')})` : ''))
  if (type === 'departments') {
    const kids = rows(ctx, 'departments').filter((d) => d.parent_id === id)
    if (kids.length) out.push(pl(kids.length, 'sub-department'))
    const des = rows(ctx, 'designations').filter((d) => d.department_id === id)
    if (des.length) out.push(pl(des.length, 'designation'))
  }
  if (type === 'grades') {
    const des = rows(ctx, 'designations').filter((d) => d.grade_id === id)
    if (des.length) out.push(pl(des.length, 'designation'))
  }
  if (type === 'cost-centres') {
    const deps = rows(ctx, 'departments').filter((d) => d.cost_centre_id === id)
    if (deps.length) out.push(pl(deps.length, 'department'))
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Org profile validation                                              */
/* ------------------------------------------------------------------ */
const ORG_FIELDS: (keyof A.OrgProfile)[] = [
  'legal_name', 'brand_name', 'cin', 'gstin', 'pan', 'tan', 'registered_address', 'corporate_address', 'city', 'state', 'pincode', 'country', 'phone', 'email', 'website', 'incorporated_on',
  'employee_code_prefix', 'employee_code_next', 'bank_name', 'bank_account_masked', 'ifsc',
]
export const ORG_FIELD_LABEL: Record<keyof A.OrgProfile, string> = {
  legal_name: 'legal name', brand_name: 'brand name', cin: 'CIN', gstin: 'GSTIN', pan: 'PAN', tan: 'TAN', registered_address: 'registered address', corporate_address: 'corporate address', city: 'city', state: 'state',
  pincode: 'pincode', country: 'country', phone: 'phone', email: 'email', website: 'website', incorporated_on: 'incorporation date', employee_code_prefix: 'employee code prefix', employee_code_next: 'next employee number',
  bank_name: 'bank name', bank_account_masked: 'bank account', ifsc: 'IFSC',
}
const RX = {
  pan: /^[A-Z]{5}[0-9]{4}[A-Z]$/,
  tan: /^[A-Z]{4}[0-9]{5}[A-Z]$/,
  cin: /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/,
  gstin: /^([0-3][0-9])([A-Z]{5}[0-9]{4}[A-Z])[1-9A-Z]Z[0-9A-Z]$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
  pincode: /^[1-9][0-9]{5}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
  website: /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i,
  phone: /^\+?[0-9 ()-]{8,20}$/,
}
function validateOrg(ctx: Ctx, b: Draft, cur: A.OrgProfile): Partial<A.OrgProfile> {
  const next: Partial<A.OrgProfile> = {}
  const up = (k: keyof A.OrgProfile) => str(b[k]).toUpperCase().replace(/\s+/g, '')
  for (const k of ORG_FIELDS) {
    if (b[k] === undefined || k === 'bank_account_masked') continue
    if (['pan', 'tan', 'cin', 'gstin', 'ifsc', 'employee_code_prefix'].includes(k)) (next as Draft)[k] = up(k)
    else if (k === 'employee_code_next') (next as Draft)[k] = Number(b[k])
    else if (k === 'incorporated_on') next.incorporated_on = str(b[k]) || null
    else (next as Draft)[k] = str(b[k])
  }
  const f = { ...cur, ...next }
  if (!f.legal_name) err(422, 'VALIDATION', 'Enter the legal name as registered.', 'legal_name')
  if (!f.brand_name) err(422, 'VALIDATION', 'Enter the name people know you by (used in emails).', 'brand_name')
  if (f.cin && !RX.cin.test(f.cin)) err(422, 'VALIDATION', 'CIN has 21 characters, like U72900OR2025PTC048213.', 'cin')
  if (f.pan && !RX.pan.test(f.pan)) err(422, 'VALIDATION', 'PAN looks like AAAAA9999A (5 letters, 4 digits, 1 letter).', 'pan')
  if (f.tan && !RX.tan.test(f.tan)) err(422, 'VALIDATION', 'TAN looks like AAAA99999A (4 letters, 5 digits, 1 letter).', 'tan')
  if (f.gstin) {
    const m = RX.gstin.exec(f.gstin)
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 38) err(422, 'VALIDATION', 'GSTIN has 15 characters: 2-digit state code, your PAN, entity number, Z and a check character.', 'gstin')
    if (f.pan && m[2] !== f.pan) err(422, 'GSTIN_PAN_MISMATCH', `Characters 3–12 of the GSTIN (${m[2]}) must match your PAN (${f.pan}).`, 'gstin')
  }
  if (f.pincode && !RX.pincode.test(f.pincode)) err(422, 'VALIDATION', 'Pincode is 6 digits and doesn’t start with 0.', 'pincode')
  if (f.email && !RX.email.test(f.email)) err(422, 'VALIDATION', 'Enter a valid email address, like hr@company.in.', 'email')
  if (f.website && !RX.website.test(f.website)) err(422, 'VALIDATION', 'Enter a website like company.in or https://company.in.', 'website')
  if (f.phone && !RX.phone.test(f.phone)) err(422, 'VALIDATION', 'Enter a phone number with country code, like +91 90000 00000.', 'phone')
  if (f.ifsc && !RX.ifsc.test(f.ifsc)) err(422, 'VALIDATION', 'IFSC is 11 characters: 4 letters, 0, then 6 letters or digits (e.g. HDFC0001234).', 'ifsc')
  if (f.incorporated_on && (!/^\d{4}-\d{2}-\d{2}$/.test(f.incorporated_on) || f.incorporated_on > ctx.today)) err(422, 'VALIDATION', 'Enter a past incorporation date.', 'incorporated_on')
  if (!/^[A-Z][A-Z0-9]{0,5}$/.test(f.employee_code_prefix)) err(422, 'VALIDATION', 'Use 1–6 letters or digits, starting with a letter (e.g. SCI).', 'employee_code_prefix')
  if (!Number.isInteger(f.employee_code_next) || f.employee_code_next < 1 || f.employee_code_next > 999999) err(422, 'VALIDATION', 'The next number must be a whole number from 1.', 'employee_code_next')
  // Never reuse an employee number that is already taken.
  if (next.employee_code_prefix !== undefined || next.employee_code_next !== undefined) {
    const taken = rows(ctx, 'users').map((u) => u.employee_code).filter((c): c is string => !!c && c.startsWith(f.employee_code_prefix + '-')).map((c) => Number(c.slice(f.employee_code_prefix.length + 1))).filter(Number.isFinite)
    const max = taken.length ? Math.max(...taken) : 0
    if (f.employee_code_next <= max) err(409, 'EMPLOYEE_CODE_TAKEN', `${formatEmployeeCode(f.employee_code_prefix, max)} is already in use. Start from ${max + 1} or later.`, 'employee_code_next')
  }
  // Bank account: the full number is accepted, only the last 4 are stored.
  if (b.bank_account !== undefined && str(b.bank_account) !== '') {
    const acc = str(b.bank_account).replace(/\s+/g, '')
    if (!/^[0-9]{9,18}$/.test(acc)) err(422, 'VALIDATION', 'Bank account numbers are 9–18 digits.', 'bank_account')
    next.bank_account_masked = 'X'.repeat(acc.length - 4) + acc.slice(-4)
  }
  if ((f.bank_account_masked || next.bank_account_masked) && f.bank_name && !f.ifsc) err(422, 'VALIDATION', 'Add the IFSC of the branch.', 'ifsc')
  return next
}

/** PREFIX-NNN — the employee number format used across the product. */
export function formatEmployeeCode(prefix: string, n: number) {
  return `${prefix}-${String(n).padStart(3, '0')}`
}
/** Take the next employee code for this tenant (increments org.employee_code_next). For Create Employee. */
export function takeEmployeeCode(ctx: Ctx): string {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
  const org = t.org!
  const used = new Set(rows(ctx, 'users').map((u) => u.employee_code))
  let n = org.employee_code_next
  while (used.has(formatEmployeeCode(org.employee_code_prefix, n))) n++
  org.employee_code_next = n + 1
  persist()
  return formatEmployeeCode(org.employee_code_prefix, n)
}

/* ------------------------------------------------------------------ */
/* Email templates                                                     */
/* ------------------------------------------------------------------ */
export const TEMPLATE_PLACEHOLDERS: Record<A.EmailTemplate['key'], string[]> = {
  welcome: ['employee_name', 'company', 'username', 'temp_password', 'login_url', 'role_name', 'manager_name', 'joining_date', 'employee_code', 'designation', 'department'],
  password_reset: ['employee_name', 'company', 'username', 'temp_password', 'login_url'],
  leave_decision: ['employee_name', 'company', 'manager_name', 'decision', 'from_date', 'to_date', 'reason', 'login_url'],
  expense_decision: ['employee_name', 'company', 'amount', 'description', 'decision', 'approver_name', 'reason', 'login_url'],
  task_assigned: ['employee_name', 'company', 'manager_name', 'task_title', 'due_date', 'login_url'],
  payslip: ['employee_name', 'company', 'month', 'net_pay', 'login_url'],
  appraisal_completed: ['employee_name', 'company', 'cycle_name', 'rating', 'login_url'],
  appraisal_letter: ['employee_name', 'company', 'appraisal_period', 'rating', 'hike_pct', 'new_ctc', 'effective_from', 'login_url'],
  custom: ['employee_name', 'company', 'login_url'],
}
/** Placeholders a template must keep (removing them would break the email's purpose). */
const REQUIRED_PLACEHOLDERS: Partial<Record<A.EmailTemplate['key'], string[]>> = {
  welcome: ['username', 'temp_password', 'login_url'],
  password_reset: ['username', 'temp_password', 'login_url'],
}
export const PLACEHOLDER_LABEL: Record<string, string> = {
  employee_name: 'Employee name', company: 'Company', username: 'Username', temp_password: 'Temporary password', login_url: 'Login link', role_name: 'Role', manager_name: 'Manager',
  joining_date: 'Joining date', employee_code: 'Employee code', designation: 'Designation', department: 'Department', decision: 'Decision', from_date: 'From date', to_date: 'To date', reason: 'Reason',
  amount: 'Amount', description: 'Description', approver_name: 'Approver', task_title: 'Task title', due_date: 'Due date', month: 'Month', net_pay: 'Net pay', cycle_name: 'Cycle', rating: 'Rating',
}
function sampleVars(ctx: Ctx): Record<string, string> {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)
  const company = t?.org?.brand_name || t?.name || 'Your company'
  const domain = (t?.org?.website || 'company.in').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return {
    employee_name: 'Ananya Rath', company, username: `ananya@${domain}`, temp_password: 'Kx7-pq2m-Rv', login_url: LOGIN_URL, role_name: 'Employee', manager_name: ctx.user.name || 'Your manager',
    joining_date: '3 Nov 2026', employee_code: formatEmployeeCode(t?.org?.employee_code_prefix || 'EMP', t?.org?.employee_code_next || 1), designation: 'MERN Developer', department: 'Delivery',
    decision: 'approved', from_date: '12 Nov 2026', to_date: '14 Nov 2026', reason: 'Enjoy the break.', amount: '₹2,450', description: 'Client visit — cab fare', approver_name: 'Subhankar Rout',
    task_title: 'Payment gateway integration', due_date: '20 Nov 2026', month: 'October 2026', net_pay: '₹48,250', cycle_name: 'H1 FY26-27', rating: '4 — Exceeds expectations',
  }
}
const PH = /\{\{\s*(\w+)\s*\}\}/g
const placeholdersIn = (s: string) => [...s.matchAll(PH)].map((m) => m[1])
function templateView(t: A.EmailTemplate) {
  return { ...t, placeholders: TEMPLATE_PLACEHOLDERS[t.key] ?? TEMPLATE_PLACEHOLDERS.custom, required_placeholders: REQUIRED_PLACEHOLDERS[t.key] ?? [], is_system: SYSTEM_EMAIL_TEMPLATES.some((s) => s.key === t.key) }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
const isPath = (p: string): p is MasterPath => p in MASTER_TABLES

export function register(r: Router) {
  // Readable by everyone in the tenant (pickers on employee forms, profile pages). Writes need master.edit / shifts.manage.
  for (const [path, table] of Object.entries(MASTER_TABLES)) r.get(`/master/${path}`, ({ ctx }) => rows(ctx, table))
  r.get('/master/org', ({ ctx }) => getDb().tenants.find((t) => t.id === ctx.tenant.id)?.org ?? null)

  r.get('/master/org/meta', ({ ctx }) => {
    requireAction(ctx, 'master.view')
    const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
    return { version: t.version, maker_checker: !!t.maker_checker?.enabled && (t.maker_checker.entities ?? []).includes('org_profile') }
  })

  r.put('/master/org', ({ ctx, body, ifMatch }) => {
    requireAction(ctx, 'master.edit', 'You can’t change the organisation profile.')
    const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
    if (ifMatch !== undefined && ifMatch !== t.version) err(409, 'STALE', 'Someone else changed the organisation profile. Reload to see the latest version.')
    const cur = t.org!
    const next = validateOrg(ctx, body ?? {}, cur)
    const changed = (Object.keys(next) as (keyof A.OrgProfile)[]).filter((k) => next[k] !== cur[k])
    if (!changed.length) return { pending: false, result: cur, result_id: t.id }
    const before = Object.fromEntries(changed.map((k) => [k, cur[k]]))
    const after = Object.fromEntries(changed.map((k) => [k, next[k]]))
    const list = changed.map((k) => ORG_FIELD_LABEL[k])
    return propose(ctx, {
      entity: 'org_profile', entity_id: t.id, action: 'update', summary: `Organisation profile: change ${list.length > 4 ? list.slice(0, 4).join(', ') + ` and ${list.length - 4} more` : list.join(', ')}`,
      before, after, payload: { patch: after }, required_permission: 'master.edit', base_version: t.version,
    })
  })

  r.get('/master/usage', ({ ctx }) => {
    const out: Record<string, Record<string, number>> = { locations: {}, departments: {}, designations: {}, grades: {}, 'cost-centres': {}, shifts: {} }
    const def = defaultShiftId(ctx)
    for (const u of rows(ctx, 'users')) {
      if (u.is_super_admin || u.status === 'deactivated') continue
      const bump = (k: MasterPath, id: string | null | undefined) => id && (out[k][id] = (out[k][id] ?? 0) + 1)
      bump('locations', u.location_id)
      bump('departments', u.department_id)
      bump('designations', u.designation_id)
      bump('grades', u.grade_id)
      bump('cost-centres', u.cost_centre_id)
      bump('shifts', shiftOf(ctx, u, def))
    }
    return out
  })

  /** Light people list for master-data screens (assign shift, heads). */
  r.get('/master/people', ({ ctx }) => {
    requireAction(ctx, 'master.view')
    const def = defaultShiftId(ctx)
    return rows(ctx, 'users')
      .filter((u) => !u.is_super_admin && u.status !== 'deactivated')
      .map((u) => ({ id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue, status: u.status, employee_code: u.employee_code ?? null, department_id: u.department_id ?? null, location_id: u.location_id ?? null, shift_id: shiftOf(ctx, u, def) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  for (const path of Object.keys(MASTER_TABLES) as MasterPath[]) {
    const table = MASTER_TABLES[path]
    const label = LABEL[path]
    const perm = permOf(path)
    const entity = entityOf(path)
    const deny = `You can’t change ${label === 'shift' ? 'shifts' : 'master data'}.`

    r.post(`/master/${path}`, ({ ctx, body }) => {
      requireAction(ctx, perm, deny)
      const data = normalise(ctx, path, body ?? {}, null)
      return propose(ctx, { entity, entity_id: null, action: 'create', summary: `Add ${label} “${data.name ?? data.code}”`, before: null, after: data, payload: { op: 'create', type: path, data }, required_permission: perm })
    })

    r.patch(`/master/${path}/:id`, ({ ctx, params, body, ifMatch }) => {
      requireAction(ctx, perm, deny)
      const cur = find(ctx, table, params.id, cap(label)) as AnyRec
      if (ifMatch !== undefined && ifMatch !== cur.version) err(409, 'STALE', 'Someone else changed this record. Reload to see the latest version.')
      const data = normalise(ctx, path, body ?? {}, cur)
      const curD = cur as unknown as Draft
      const changed = Object.keys(data).filter((k) => JSON.stringify(data[k]) !== JSON.stringify(curD[k]))
      if (!changed.length) return { pending: false, result: cur, result_id: cur.id }
      const before = Object.fromEntries(changed.map((k) => [k, curD[k]]))
      const after = Object.fromEntries(changed.map((k) => [k, data[k]]))
      return propose(ctx, {
        entity, entity_id: cur.id, action: 'update', summary: `Edit ${label} “${nameOf(cur)}”: ${changed.map((k) => k.replace(/_id$|_paise$/, '').replace(/_/g, ' ')).join(', ')}`,
        before, after, payload: { op: 'update', type: path, id: cur.id, data: after }, required_permission: perm, base_version: cur.version,
      })
    })

    r.del(`/master/${path}/:id`, ({ ctx, params, ifMatch }) => {
      requireAction(ctx, perm, deny)
      const cur = find(ctx, table, params.id, cap(label)) as AnyRec
      if (ifMatch !== undefined && ifMatch !== cur.version) err(409, 'STALE', 'Someone else changed this record. Reload to see the latest version.')
      assertDeletable(ctx, path, cur)
      return propose(ctx, { entity, entity_id: cur.id, action: 'delete', summary: `Delete ${label} “${nameOf(cur)}”`, before: { name: nameOf(cur) }, after: null, payload: { op: 'delete', type: path, id: cur.id }, required_permission: perm, base_version: cur.version })
    })

    for (const op of ['activate', 'deactivate'] as const)
      r.post(`/master/${path}/:id/${op}`, ({ ctx, params }) => {
        requireAction(ctx, perm, deny)
        const cur = find(ctx, table, params.id, cap(label)) as AnyRec & { active: boolean }
        if (cur.active === (op === 'activate')) return { pending: false, result: cur, result_id: cur.id }
        if (op === 'deactivate') assertDeactivatable(ctx, path, cur)
        return propose(ctx, {
          entity, entity_id: cur.id, action: 'update', summary: `${cap(op)} ${label} “${nameOf(cur)}”`, before: { active: cur.active }, after: { active: op === 'activate' },
          payload: { op, type: path, id: cur.id }, required_permission: perm, base_version: cur.version,
        })
      })
  }

  r.get('/master/shifts/:id/members', ({ ctx, params }) => {
    requireAction(ctx, 'master.view')
    find(ctx, 'shifts', params.id, 'Shift')
    return peopleOf(ctx, 'shifts', params.id).map((u) => ({ id: u.id, name: u.name, title: u.title, avatar_hue: u.avatar_hue, employee_code: u.employee_code ?? null }))
  })

  r.post('/master/shifts/:id/assign', ({ ctx, params, body }) => {
    requireAction(ctx, 'shifts.manage', 'You can’t assign shifts.')
    const s = find(ctx, 'shifts', params.id, 'Shift')
    if (!s.active) err(409, 'INACTIVE', `${s.name} is inactive. Activate it before assigning people.`)
    const ids = [...new Set(((body?.user_ids ?? []) as string[]).map(String))]
    if (!ids.length) err(422, 'VALIDATION', 'Pick at least one person to move to this shift.', 'user_ids')
    const def = defaultShiftId(ctx)
    const people = ids.map((id) => {
      const u = rows(ctx, 'users').find((x) => x.id === id && !x.is_super_admin)
      if (!u) err(404, 'NOT_FOUND', 'Person not found.')
      if (u.status === 'deactivated') err(422, 'VALIDATION', `${u.name} has left. Only active people can be assigned a shift.`, 'user_ids')
      return u
    }).filter((u) => shiftOf(ctx, u, def) !== s.id || !u.shift_id)
    if (!people.length) return { pending: false, result: { moved: 0 }, result_id: s.id }
    const names = people.map((u) => u.name)
    return propose(ctx, {
      entity: 'shift', entity_id: s.id, action: 'execute', summary: `Move ${names.length <= 3 ? names.join(', ') : pl(names.length, 'person', 'people')} to ${s.name}`,
      before: Object.fromEntries(people.map((u) => [u.name, userShiftName(ctx, u, def)])), after: Object.fromEntries(people.map((u) => [u.name, s.name])),
      payload: { op: 'assign', type: 'shifts', id: s.id, user_ids: people.map((u) => u.id) }, required_permission: 'shifts.manage',
    })
  })

  /* ---------------- Email templates & outbox ---------------- */
  r.get('/emails/templates', ({ ctx }) => {
    requireAction(ctx, 'emails.view')
    const order = SYSTEM_EMAIL_TEMPLATES.map((t) => t.key as string)
    return rows(ctx, 'email_templates').map(templateView).sort((a, b) => (order.indexOf(a.key) + 1 || 99) - (order.indexOf(b.key) + 1 || 99))
  })
  r.get('/emails/templates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'emails.view')
    return templateView(find(ctx, 'email_templates', params.id, 'Template'))
  })

  r.put('/emails/templates/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'emails.view', 'You can’t edit email templates.')
    const t = find(ctx, 'email_templates', params.id, 'Template')
    const subject = body.subject !== undefined ? str(body.subject) : t.subject
    const text = body.body !== undefined ? String(body.body ?? '').replace(/\r\n/g, '\n').trim() : t.body
    if (!subject) err(422, 'VALIDATION', 'Enter a subject line.', 'subject')
    if (subject.length > 200) err(422, 'VALIDATION', 'Keep the subject under 200 characters.', 'subject')
    if (!text) err(422, 'VALIDATION', 'The email body can’t be empty.', 'body')
    if (text.length > 10000) err(422, 'VALIDATION', 'Keep the body under 10,000 characters.', 'body')
    const allowed = TEMPLATE_PLACEHOLDERS[t.key] ?? TEMPLATE_PLACEHOLDERS.custom
    for (const [field, s] of [['subject', subject], ['body', text]] as const) {
      const bad = [...new Set(placeholdersIn(s).filter((p) => !allowed.includes(p)))]
      if (bad.length) err(422, 'UNKNOWN_PLACEHOLDER', `${bad.map((b) => `{{${b}}}`).join(', ')} ${bad.length === 1 ? 'isn’t a' : 'aren’t'} known placeholder${bad.length === 1 ? '' : 's'} for this email. Use one of the chips below the editor.`, field)
    }
    const missing = (REQUIRED_PLACEHOLDERS[t.key] ?? []).filter((p) => !placeholdersIn(subject + '\n' + text).includes(p))
    if (missing.length) err(422, 'REQUIRED_PLACEHOLDER', `This email must include ${missing.map((m) => `{{${m}}}`).join(', ')} — without ${missing.length === 1 ? 'it' : 'them'} the new joiner can’t sign in.`, 'body')
    const active = body.active === undefined ? t.active : !!body.active
    if (!active && REQUIRED_PLACEHOLDERS[t.key]) err(409, 'TEMPLATE_REQUIRED', 'This email delivers login details, so it can’t be switched off.', 'active')
    const out = update(ctx, 'email_templates', t.id, { subject, body: text, active }, ifMatch)
    logActivity(ctx, 'email_template', t.id, 'updated', `${ctx.user.name} edited the “${t.name}” email template`)
    return templateView(out)
  })

  r.post('/emails/templates/:id/reset', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'emails.view', 'You can’t edit email templates.')
    const t = find(ctx, 'email_templates', params.id, 'Template')
    const def = SYSTEM_EMAIL_TEMPLATES.find((s) => s.key === t.key)
    if (!def) err(409, 'NO_DEFAULT', 'This template has no built-in default to restore.')
    const out = update(ctx, 'email_templates', t.id, { subject: def.subject, body: def.body, active: true }, ifMatch)
    logActivity(ctx, 'email_template', t.id, 'reset', `${ctx.user.name} restored the default “${t.name}” email template`)
    return templateView(out)
  })

  // Preview never writes, so it is allowed while viewing as another role.
  r.post(
    '/emails/templates/:id/preview',
    ({ ctx, params, body }) => {
      requireAction(ctx, 'emails.view')
      const t = find(ctx, 'email_templates', params.id, 'Template')
      const subject = body?.subject !== undefined ? String(body.subject) : t.subject
      const text = body?.body !== undefined ? String(body.body) : t.body
      const allowed = TEMPLATE_PLACEHOLDERS[t.key] ?? TEMPLATE_PLACEHOLDERS.custom
      const used = [...new Set(placeholdersIn(subject + '\n' + text))]
      const vars = sampleVars(ctx)
      // unknown placeholders render visibly so the editor can spot them
      const shown = Object.fromEntries(used.map((p) => [p, allowed.includes(p) ? vars[p] ?? '' : `{{${p}}}`]))
      return {
        subject: renderTemplate(subject, shown), body: renderTemplate(text, shown), to: vars.username,
        unknown: used.filter((p) => !allowed.includes(p)), missing: (REQUIRED_PLACEHOLDERS[t.key] ?? []).filter((p) => !used.includes(p)),
      }
    },
    { allowViewAsWrite: true },
  )

  r.get('/emails/outbox', ({ ctx, query }) => {
    requireAction(ctx, 'emails.view')
    const key = str(query.template_key)
    const q = str(query.search).toLowerCase()
    return rows(ctx, 'email_outbox')
      .filter((m) => (!key || m.template_key === key) && (!q || m.to.toLowerCase().includes(q) || m.subject.toLowerCase().includes(q) || userName(ctx, m.to_user_id).toLowerCase().includes(q)))
      .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
      .slice(0, 300)
      .map((m) => ({ ...m, to_name: m.to_user_id ? userName(ctx, m.to_user_id) : null }))
  })
  r.get('/emails/outbox/:id', ({ ctx, params }) => {
    requireAction(ctx, 'emails.view')
    const m = find(ctx, 'email_outbox', params.id, 'Email')
    return { ...m, to_name: m.to_user_id ? userName(ctx, m.to_user_id) : null }
  })
}

function userShiftName(ctx: Ctx, u: E.User, def: string | null) {
  const id = shiftOf(ctx, u, def)
  return rows(ctx, 'shifts').find((s) => s.id === id)?.name ?? '—'
}

function assertDeletable(ctx: Ctx, path: MasterPath, cur: AnyRec) {
  if (path === 'locations' && (cur as A.Location).is_head_office) err(409, 'HEAD_OFFICE_REQUIRED', `${nameOf(cur)} is the head office. Make another location the head office before deleting it.`)
  if (path === 'shifts' && (cur as A.Shift).is_default) err(409, 'DEFAULT_SHIFT_REQUIRED', `${nameOf(cur)} is the default shift. Make another shift the default before deleting it.`)
  const used = usedBy(ctx, path, cur.id)
  if (used.length) err(409, 'IN_USE', `${nameOf(cur)} is used by ${used.length > 1 ? used.slice(0, -1).join(', ') + ' and ' + used[used.length - 1] : used[0]}. Move them first, or deactivate it instead — deactivated ${LABEL[path]}s stay on past records but can’t be picked for new ones.`)
}
function assertDeactivatable(ctx: Ctx, path: MasterPath, cur: AnyRec) {
  if (path === 'locations' && (cur as A.Location).is_head_office) err(409, 'HEAD_OFFICE_REQUIRED', `${nameOf(cur)} is the head office. Make another location the head office first.`)
  if (path === 'shifts' && (cur as A.Shift).is_default) err(409, 'DEFAULT_SHIFT_REQUIRED', `${nameOf(cur)} is the default shift. Make another shift the default first.`)
}

/* ------------------------------------------------------------------ */
/* Appliers (direct apply and on approval)                              */
/* ------------------------------------------------------------------ */
registerApplier('org_profile', (ctx, cs) => {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
  assertBaseVersion(cs, t.version)
  const patch = cs.payload.patch as Partial<A.OrgProfile>
  t.org = { ...t.org!, ...patch }
  t.version++
  persist()
  const by = cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)}, approved by ${ctx.user.name})` : ''
  logActivity(ctx, 'org_profile', t.id, 'updated', `Organisation profile updated: ${Object.keys(patch).map((k) => ORG_FIELD_LABEL[k as keyof A.OrgProfile] ?? k).join(', ')}${by}`)
  return { result: t.org, result_id: t.id }
})

function applyMaster(ctx: Ctx, cs: A.ChangeSet) {
  const p = cs.payload as { op: 'create' | 'update' | 'delete' | 'activate' | 'deactivate' | 'assign'; type: string; id?: string; data?: Draft; user_ids?: string[] }
  if (!isPath(p.type)) err(422, 'VALIDATION', 'Unknown master data type.')
  const path = p.type
  const table = MASTER_TABLES[path]
  const label = LABEL[path]
  const by = cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''
  const exclusive = (flag: 'is_head_office' | 'is_default', keepId: string) => {
    for (const x of rows(ctx, table) as unknown as (AnyRec & Record<string, unknown>)[]) if (x.id !== keepId && x[flag]) update(ctx, table, x.id, { [flag]: false } as never)
  }
  if (p.op === 'create') {
    const data = normalise(ctx, path, p.data ?? {}, null) // re-check uniqueness at apply time
    const row = insert(ctx, table, { ...data, active: true } as never) as AnyRec
    if (path === 'locations' && data.is_head_office) exclusive('is_head_office', row.id)
    if (path === 'shifts' && data.is_default) exclusive('is_default', row.id)
    if (path === 'locations' && !rows(ctx, 'locations').some((l) => l.is_head_office)) update(ctx, 'locations', row.id, { is_head_office: true })
    if (path === 'shifts' && !rows(ctx, 'shifts').some((s) => s.is_default)) update(ctx, 'shifts', row.id, { is_default: true })
    logActivity(ctx, path, row.id, 'created', `${cap(label)} “${nameOf(row)}” added${by}`)
    return { result: find(ctx, table, row.id), result_id: row.id }
  }
  const cur = find(ctx, table, p.id!, cap(label)) as AnyRec & { active: boolean }
  if (p.op !== 'assign') assertBaseVersion(cs, cur.version)
  if (p.op === 'update') {
    const data = normalise(ctx, path, p.data ?? {}, cur)
    const patch = Object.fromEntries(Object.keys(p.data ?? {}).map((k) => [k, data[k]]))
    const row = update(ctx, table, cur.id, patch as never) as AnyRec
    if (path === 'locations' && patch.is_head_office) exclusive('is_head_office', row.id)
    if (path === 'shifts' && patch.is_default) exclusive('is_default', row.id)
    logActivity(ctx, path, row.id, 'updated', `${cap(label)} “${nameOf(row)}” edited${by}`)
    return { result: row, result_id: row.id }
  }
  if (p.op === 'delete') {
    assertDeletable(ctx, path, cur)
    remove(ctx, table, cur.id)
    logActivity(ctx, path, cur.id, 'deleted', `${cap(label)} “${nameOf(cur)}” deleted${by}`)
    return { result: { id: cur.id, deleted: true }, result_id: cur.id }
  }
  if (p.op === 'activate' || p.op === 'deactivate') {
    if (p.op === 'deactivate') assertDeactivatable(ctx, path, cur)
    const row = update(ctx, table, cur.id, { active: p.op === 'activate' } as never) as AnyRec
    logActivity(ctx, path, row.id, p.op === 'activate' ? 'activated' : 'deactivated', `${cap(label)} “${nameOf(row)}” ${p.op}d${by}`)
    return { result: row, result_id: row.id }
  }
  // assign people to a shift
  const s = cur as A.Shift
  if (!s.active) err(409, 'INACTIVE', `${s.name} is inactive. Activate it before assigning people.`)
  let moved = 0
  for (const id of p.user_ids ?? []) {
    const u = rows(ctx, 'users').find((x) => x.id === id)
    if (!u || u.status === 'deactivated') continue
    update(ctx, 'users', u.id, { shift_id: s.id })
    moved++
  }
  logActivity(ctx, 'shifts', s.id, 'assigned', `${pl(moved, 'person', 'people')} moved to ${s.name}${by}`)
  return { result: { moved, at: nowISO() }, result_id: s.id }
}
registerApplier('master_record', applyMaster)
registerApplier('shift', applyMaster)
