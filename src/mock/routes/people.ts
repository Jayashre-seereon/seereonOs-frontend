// Module A — people & users, Create employee, invites, delegations, sessions, 2FA.
//
// Capability rules (v4 — permissions only, never the persona):
//   • GET /users                      users.view
//   • job fields (PATCH /users/:id)   employees.edit, applied directly
//   • access fields (role, extra/revoked permissions)  users.manage, maker-checked (entity user_access)
//   • POST /employees                 employees.create, maker-checked (entity employee, action create)
//   • deactivate                      employees.deactivate, maker-checked (entity employee, action delete)
//   • reset password                  users.manage
// Escalation guard: nobody can grant a permission they don't hold, and only holders of
// users.manage can give someone a role that manages roles or users.
import type * as E from '@/types/entities'
import type { ChangeSet, EmailMessage, RoleDef } from '@/types/access'
import { addDays, avgWorkingDaysPerMonth, fyStartYear, isRealISODate, monthOf, todayISO, workingDaysInMonth } from '@/domain/calendar'
import { costPerHour } from '@/domain/costing'
import { effectivePermissions } from '@/domain/permissionCatalog'
import { needsChecker, pendingBrief, registerApplier, type PendingBrief } from '../makerChecker'
import { issueJoiningLetter } from './docsV7'
import { startWorkflow } from './workflowsV7'
import { ensureDocDefaults } from '../docgen'
import { sendEmail } from '../email'
import { calendarFor, err, find, getDb, has, insert, logActivity, notify, nowISO, permissionsOf, persist, remove, removeWhere, requireAction, requireAny, roleDef, rows, uid, update, userName, warn, withAccess, type Ctx, type Req, type Router } from '../server'
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUrl, randomToken, verifyTotp } from '@/domain/totp'
import { openSecret, sealSecret } from '../secrets'
import { FAR_FUTURE, TWO_FACTOR_SETUP_ATTEMPTS, TWO_FACTOR_SETUP_MINUTES, touch, twoFactorRecord, useSecondFactor, type TwoFactorPayload } from '../twoFactor'
import { tenantOf } from './auth'
import { assertNoLockout, cleanPermissions, diffSummary, isAccessAdmin, permLabel, proposeNamed } from './access'

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const DATE_RE = { test: (s: string) => isRealISODate(s) }
const INVITE_DAYS = 7
const TRIAL_SEAT_CAP = 25
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'intern'] as const
const DEPT_FROM_PERSONA: Record<E.Role, E.User['department']> = { admin: 'management', pm: 'delivery', employee: 'delivery', sales: 'sales', ops: 'operations' }

export interface InviteRow extends E.Invite {
  status: 'pending' | 'expired' | 'accepted'
  link: string
  role_name: string
}

function inviteView(ctx: Ctx, i: E.Invite): InviteRow {
  const status = i.accepted_at ? 'accepted' : i.expires_at < nowISO() ? 'expired' : 'pending'
  return { ...i, status, link: `/invite/${i.token}`, role_name: roleDef(ctx.tenant.id, i.role_key)?.name ?? i.role }
}

/* ------------------------------------------------------------------ */
/* User rows                                                            */
/* ------------------------------------------------------------------ */
export interface UserRow extends E.User {
  role_name: string
  permissions: string[]
  role_permissions: string[]
  department_name: string | null
  designation_name: string | null
  grade_name: string | null
  location_name: string | null
  shift_name: string | null
  cost_centre_name: string | null
  manager_name: string | null
  direct_reports: number
  pending_access: PendingBrief | null
  pending_employee: PendingBrief | null
}
function nameIn<T extends { id: string; name: string }>(list: T[], id: string | null | undefined) {
  return id ? list.find((x) => x.id === id)?.name ?? null : null
}
function userRows(ctx: Ctx, list: E.User[]): UserRow[] {
  const all = rows(ctx, 'users')
  const depts = rows(ctx, 'departments')
  const desig = rows(ctx, 'designations')
  const grades = rows(ctx, 'grades').map((g) => ({ ...g, name: g.code ? `${g.code} · ${g.name}` : g.name }))
  const locs = rows(ctx, 'locations')
  const shifts = rows(ctx, 'shifts')
  const ccs = rows(ctx, 'cost_centres')
  return list.map((u) => {
    const rd = roleDef(u.tenant_id, u.role_key)
    return {
      ...withAccess(u),
      role_name: rd?.name ?? u.title,
      permissions: permissionsOf(u),
      role_permissions: rd ? effectivePermissions(rd.permissions) : [],
      extra_permissions: u.extra_permissions ?? [],
      revoked_permissions: u.revoked_permissions ?? [],
      department_name: nameIn(depts, u.department_id),
      designation_name: nameIn(desig, u.designation_id),
      grade_name: nameIn(grades, u.grade_id),
      location_name: nameIn(locs, u.location_id),
      shift_name: nameIn(shifts, u.shift_id),
      cost_centre_name: nameIn(ccs, u.cost_centre_id),
      manager_name: u.reports_to_id ? all.find((x) => x.id === u.reports_to_id)?.name ?? null : null,
      direct_reports: all.filter((x) => x.reports_to_id === u.id && x.status === 'active').length,
      pending_access: pendingBrief(ctx, 'user_access', u.id),
      pending_employee: pendingBrief(ctx, 'employee', u.id),
    }
  })
}
const userRow = (ctx: Ctx, u: E.User) => userRows(ctx, [u])[0]

/* ------------------------------------------------------------------ */
/* Validation helpers                                                    */
/* ------------------------------------------------------------------ */
function emailTaken(ctx: Ctx, email: string, exceptUserId?: string) {
  const d = getDb()
  if (d.users.some((u) => u.email.toLowerCase() === email && u.id !== exceptUserId)) return 'An account with this email already exists.'
  if (rows(ctx, 'invites').some((i) => i.email.toLowerCase() === email && !i.accepted_at && i.expires_at > nowISO())) return 'This email already has a pending invite. Resend or revoke it under Invited.'
  if (rows(ctx, 'change_sets').some((c) => c.status === 'pending' && c.entity === 'employee' && c.action === 'create' && String((c.payload as { input?: { email?: string } }).input?.email ?? '') === email))
    return 'An employee with this email is already waiting for approval.'
  return null
}

/** Seat rule: active users + pending invites may not exceed purchased seats (trial: soft cap 25). */
function assertSeats(ctx: Ctx, adding: number) {
  const t = tenantOf(ctx)
  const used = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin).length + rows(ctx, 'invites').filter((i) => !i.accepted_at && i.expires_at > nowISO()).length
  const cap = t.status === 'trial' ? Math.max(TRIAL_SEAT_CAP, t.seats) : t.seats
  if (used + adding > cap)
    err(409, 'SEATS_FULL', t.status === 'trial' ? `Trials include up to ${cap} people. Choose a plan in Billing to add more.` : `All ${cap} seats are in use. Add seats in Billing, or deactivate someone first.`)
}

/** Would setting `managerId` as `userId`'s manager create a loop? */
function createsLoop(ctx: Ctx, userId: string, managerId: string | null) {
  if (!managerId) return false
  if (managerId === userId) return true
  const byId = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
  let cur: string | null = managerId
  const seen = new Set<string>()
  while (cur) {
    if (cur === userId) return true
    if (seen.has(cur)) return true
    seen.add(cur)
    cur = byId.get(cur)?.reports_to_id ?? null
  }
  return false
}
function assertManager(ctx: Ctx, userId: string | null, managerId: string | null) {
  if (!managerId) return
  const mgr = find(ctx, 'users', managerId, 'Manager')
  if (mgr.status !== 'active') err(422, 'VALIDATION', `${mgr.name} is not active. Choose an active person as manager.`, 'reports_to_id')
  if (userId && managerId === userId) err(409, 'USER_REPORTS_LOOP', 'A person cannot report to themselves.', 'reports_to_id')
  if (userId && createsLoop(ctx, userId, managerId)) err(409, 'USER_REPORTS_LOOP', 'This would create a reporting loop. Pick someone who is not in their reporting line.', 'reports_to_id')
}

type MasterTable = 'departments' | 'designations' | 'grades' | 'locations' | 'shifts' | 'cost_centres'
const MASTER_LABEL: Record<MasterTable, string> = { departments: 'Department', designations: 'Designation', grades: 'Grade', locations: 'Location', shifts: 'Shift', cost_centres: 'Cost centre' }
function masterRef(ctx: Ctx, table: MasterTable, id: unknown, field: string, current?: string | null): string | null {
  const v = id === undefined ? current ?? null : (id as string) || null
  if (!v) return null
  const rec = (rows(ctx, table) as { id: string; active: boolean }[]).find((x) => x.id === v)
  if (!rec) err(422, 'VALIDATION', `${MASTER_LABEL[table]} not found. Choose one from the list.`, field)
  if (!rec.active && v !== current) err(422, 'VALIDATION', `That ${MASTER_LABEL[table].toLowerCase()} is inactive. Choose an active one.`, field)
  return v
}
const hasActive = (ctx: Ctx, table: MasterTable) => (rows(ctx, table) as { active: boolean }[]).some((x) => x.active)

interface AccessInput {
  role_key: string
  extra_permissions: string[]
  revoked_permissions: string[]
}
/** Validate role + overrides, including the escalation guard. */
function readAccess(ctx: Ctx, body: Record<string, unknown>, cur: E.User | null): { access: AccessInput; role: RoleDef } {
  const role_key = String(body.role_key ?? cur?.role_key ?? '')
  const role = roleDef(ctx.tenant.id, role_key)
  if (!role) err(422, 'VALIDATION', 'Choose a role.', 'role_key')
  if (!role.active && role_key !== cur?.role_key) err(422, 'VALIDATION', `${role.name} is inactive. Choose an active role.`, 'role_key')
  const rolePerms = effectivePermissions(role.permissions)
  const extra = (body.extra_permissions !== undefined ? cleanPermissions(body.extra_permissions, 'extra_permissions') : cur?.extra_permissions ?? []).filter((k) => !rolePerms.includes(k))
  const revoked = (body.revoked_permissions !== undefined ? cleanPermissions(body.revoked_permissions, 'revoked_permissions') : cur?.revoked_permissions ?? []).filter((k) => rolePerms.includes(k))
  // escalation guard — compare with what the person already had so unchanged overrides never block
  const had = new Set(cur ? permissionsOf(cur) : [])
  const gaining = effectivePermissions(rolePerms, extra, revoked).filter((k) => !had.has(k))
  if (!has(ctx, 'users.manage') && isAccessAdmin(gaining)) err(403, 'PERMISSION_ESCALATION', `${role.name} can manage roles or user access. Only someone with “Manage user access” can give that.`, 'role_key')
  const newExtras = extra.filter((k) => !(cur?.extra_permissions ?? []).includes(k))
  const beyond = newExtras.filter((k) => !ctx.perms.has(k))
  if (beyond.length) err(403, 'PERMISSION_ESCALATION', `You can only grant permissions you hold yourself. Remove: ${beyond.map(permLabel).join(', ')}.`, 'extra_permissions')
  return { access: { role_key: role.key, extra_permissions: extra.sort(), revoked_permissions: revoked.sort() }, role }
}

/** Strong temporary password that meets the tenant's minimum length. */
function tempPassword(min: number) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '@#$%&*!?']
  const len = Math.max(12, min + 2)
  const rnd = (n: number) => {
    const a = new Uint32Array(1)
    crypto.getRandomValues(a)
    return a[0] % n
  }
  const chars = sets.map((s) => s[rnd(s.length)])
  const all = sets.join('')
  while (chars.length < len) chars.push(all[rnd(all.length)])
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/** Next employee code from the org profile (prefix + running number); falls back to EMP + max existing. */
function nextEmployeeCode(ctx: Ctx) {
  const t = tenantOf(ctx)
  const users = rows(ctx, 'users')
  const prefix = (t.org?.employee_code_prefix || 'EMP').trim()
  const sep = /[-/_]$/.test(prefix) ? '' : '-'
  const fmt = (n: number) => `${prefix}${sep}${String(n).padStart(3, '0')}`
  const maxExisting = users.reduce((m, u) => {
    const c = u.employee_code ?? ''
    if (!c.toUpperCase().startsWith(prefix.toUpperCase())) return m
    const n = Number(c.slice(prefix.length).replace(/^[^0-9]*/, ''))
    return Number.isFinite(n) ? Math.max(m, n) : m
  }, 0)
  let n = Math.max(t.org?.employee_code_next ?? 1, maxExisting + 1)
  while (users.some((u) => u.employee_code === fmt(n))) n++
  if (t.org) t.org.employee_code_next = n + 1
  persist()
  return fmt(n)
}

/* ------------------------------------------------------------------ */
/* Create employee                                                       */
/* ------------------------------------------------------------------ */
interface EmployeeInput {
  name: string
  email: string
  personal_email: string | null
  phone: string | null
  joined_on: string
  employment_type: (typeof EMPLOYMENT_TYPES)[number]
  department_id: string | null
  designation_id: string | null
  grade_id: string | null
  location_id: string | null
  shift_id: string | null
  cost_centre_id: string | null
  reports_to_id: string | null
  role_key: string
  extra_permissions: string[]
  monthly_ctc_paise: number | null
  send_welcome: boolean
  /** v7 documents: issue the joining letter from the Joining letter template once created */
  issue_joining_letter?: boolean
  /** v7 workflows: start the Employee onboarding workflow once created */
  start_onboarding?: boolean
}
function readEmployee(ctx: Ctx, b: Record<string, unknown>): EmployeeInput {
  const name = String(b.name ?? '').trim()
  const email = String(b.email ?? '').trim().toLowerCase()
  const personal = String(b.personal_email ?? '').trim().toLowerCase() || null
  const phone = String(b.phone ?? '').trim() || null
  const joined_on = String(b.joined_on ?? '')
  if (name.length < 2) err(422, 'VALIDATION', 'Enter the employee’s full name.', 'name')
  if (!EMAIL_RE.test(email)) err(422, 'VALIDATION', 'Enter a valid work email.', 'email')
  const taken = emailTaken(ctx, email)
  if (taken) err(409, 'USER_EMAIL_TAKEN', taken, 'email')
  if (personal && !EMAIL_RE.test(personal)) err(422, 'VALIDATION', 'Enter a valid personal email, or leave it empty.', 'personal_email')
  if (personal && personal === email) err(422, 'VALIDATION', 'Personal email should differ from the work email.', 'personal_email')
  if (phone && !/^[+\d][\d\s-]{6,16}$/.test(phone)) err(422, 'VALIDATION', 'Enter a valid phone number.', 'phone')
  if (!DATE_RE.test(joined_on)) err(422, 'VALIDATION', 'Choose the joining date.', 'joined_on')
  if (joined_on < addDays(todayISO(), -365)) err(422, 'DATE_RANGE', 'Joining date is more than a year ago. Check the date.', 'joined_on')
  const et = String(b.employment_type ?? 'full_time')
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(et)) err(422, 'VALIDATION', 'Choose the employment type.', 'employment_type')
  const department_id = masterRef(ctx, 'departments', b.department_id, 'department_id')
  if (!department_id && hasActive(ctx, 'departments')) err(422, 'VALIDATION', 'Choose a department.', 'department_id')
  const designation_id = masterRef(ctx, 'designations', b.designation_id, 'designation_id')
  if (!designation_id && hasActive(ctx, 'designations')) err(422, 'VALIDATION', 'Choose a designation.', 'designation_id')
  const grade_id = masterRef(ctx, 'grades', b.grade_id, 'grade_id')
  const location_id = masterRef(ctx, 'locations', b.location_id, 'location_id') ?? rows(ctx, 'locations').find((l) => l.active && l.is_head_office)?.id ?? null
  const shift_id = masterRef(ctx, 'shifts', b.shift_id, 'shift_id') ?? rows(ctx, 'shifts').find((s) => s.active && s.is_default)?.id ?? null
  const cost_centre_id = masterRef(ctx, 'cost_centres', b.cost_centre_id, 'cost_centre_id')
  const { access, role } = readAccess(ctx, { role_key: b.role_key, extra_permissions: b.extra_permissions ?? [] }, null)
  if ((b.extra_permissions as unknown[] | undefined)?.length && !has(ctx, 'users.manage')) err(403, 'FORBIDDEN', 'Extra permissions need “Manage user access”. Create the employee with their role, then ask an administrator.', 'extra_permissions')
  const reports_to_id = (b.reports_to_id as string) || null
  if (!reports_to_id && role.persona !== 'admin') err(422, 'VALIDATION', 'Choose who they report to. Their manager approves their leave and timesheets.', 'reports_to_id')
  assertManager(ctx, null, reports_to_id)
  let ctc: number | null = null
  if (b.monthly_ctc_paise !== undefined && b.monthly_ctc_paise !== null && b.monthly_ctc_paise !== '' && Number(b.monthly_ctc_paise) > 0) {
    if (!has(ctx, 'cost_rates.edit')) err(403, 'FORBIDDEN', 'Setting CTC needs “Change salaries & cost rates”. Leave it empty.', 'monthly_ctc_paise')
    ctc = Math.round(Number(b.monthly_ctc_paise))
    if (!Number.isFinite(ctc) || ctc < 100_00 || ctc > 1_00_00_000_00) err(422, 'VALIDATION', 'Enter a monthly CTC between ₹100 and ₹1 crore.', 'monthly_ctc_paise')
  }
  return {
    name, email, personal_email: personal, phone, joined_on, employment_type: et as EmployeeInput['employment_type'],
    department_id, designation_id, grade_id, location_id, shift_id, cost_centre_id, reports_to_id,
    role_key: access.role_key, extra_permissions: access.extra_permissions, monthly_ctc_paise: ctc, send_welcome: b.send_welcome !== false,
    issue_joining_letter: readJoiningLetter(ctx, b),
    start_onboarding: readOnboarding(ctx, b),
  }
}

/** v7: start the Employee onboarding workflow for the new joiner (needs “Start workflows for others”). */
function readOnboarding(ctx: Ctx, b: Record<string, unknown>): boolean {
  if (b.start_onboarding !== true) return false
  if (!has(ctx, 'workflows.start')) err(403, 'FORBIDDEN', 'Starting the onboarding workflow needs “Start workflows for others”. Untick it.', 'start_onboarding')
  if (!onboardingTemplate(ctx)) err(422, 'TEMPLATE_MISSING', 'There is no active onboarding workflow. Activate one in the Workflow designer, or untick “Start onboarding workflow”.', 'start_onboarding')
  return true
}
function onboardingTemplate(ctx: Ctx) {
  const list = rows(ctx, 'wf_templates').filter((t) => t.process === 'onboarding' && t.active)
  return list.find((t) => t.key === 'employee_onboarding') ?? list[0] ?? null
}
function readJoiningLetter(ctx: Ctx, b: Record<string, unknown>): boolean {
  if (b.issue_joining_letter !== true) return false
  if (!has(ctx, 'documents.templates')) err(403, 'FORBIDDEN', 'Issuing letters needs “Document templates & issuing”. Untick “Issue joining letter”.', 'issue_joining_letter')
  ensureDocDefaults(ctx)
  if (!rows(ctx, 'doc_templates').some((t) => t.key === 'joining_letter' && t.active)) err(422, 'TEMPLATE_MISSING', 'The Joining letter template is switched off. Turn it on under Documents → Templates, or untick “Issue joining letter”.', 'issue_joining_letter')
  return true
}

export interface CreatedEmployee {
  user: UserRow
  employee_code: string
  login_email: string
  temp_password: string
  email: EmailMessage | null
  manager_name: string | null
  ctc_saved: boolean
  /** v7: the joining letter issued on create (Documents → Issued) */
  joining_letter_id?: string | null
  /** v7: the onboarding workflow started on create */
  onboarding_workflow_id?: string | null
}
function createEmployee(ctx: Ctx, cs: ChangeSet): CreatedEmployee {
  const p = cs.payload as { input: EmployeeInput }
  const i = p.input
  // re-check what may have changed while it waited for approval
  if (getDb().users.some((u) => u.email.toLowerCase() === i.email)) err(409, 'USER_EMAIL_TAKEN', 'An account with this email was created meanwhile.', 'email')
  const role = roleDef(ctx.tenant.id, i.role_key)
  if (!role || !role.active) err(409, 'VALIDATION', 'The chosen role no longer exists or is inactive.', 'role_key')
  if (i.reports_to_id) assertManager(ctx, null, i.reports_to_id)
  assertSeats(ctx, 1)
  const dept = i.department_id ? rows(ctx, 'departments').find((d) => d.id === i.department_id) : null
  const desig = i.designation_id ? rows(ctx, 'designations').find((d) => d.id === i.designation_id) : null
  const code = nextEmployeeCode(ctx)
  const user = insert(ctx, 'users', {
    email: i.email, name: i.name, title: desig?.name ?? role.name, role: role.persona, role_key: role.key, extra_permissions: i.extra_permissions, revoked_permissions: [],
    reports_to_id: i.reports_to_id, grants: [], status: 'active', last_login_at: null, avatar_hue: Math.floor(Math.random() * 360), phone: i.phone, joined_on: i.joined_on,
    department: dept?.kind ?? DEPT_FROM_PERSONA[role.persona], two_factor: false, prefs: {}, must_change_password: true,
    employee_code: code, department_id: i.department_id, designation_id: i.designation_id, grade_id: i.grade_id, location_id: i.location_id, shift_id: i.shift_id,
    cost_centre_id: i.cost_centre_id ?? dept?.cost_centre_id ?? null, employment_type: i.employment_type, personal_email: i.personal_email,
  } as never) as E.User
  if (cs.id !== 'cs_direct') user.created_by = cs.maker_id
  const temp = tempPassword(ctx.tenant.settings?.['security.password_min_length'] ?? 10)
  const d = getDb()
  d.passwords = d.passwords.filter((x) => x.user_id !== user.id)
  d.passwords.push({ user_id: user.id, password: temp })
  // CTC: part of an approved hire, or direct when salaries are not maker-checked on their own
  let ctcSaved = false
  if (i.monthly_ctc_paise) {
    if (cs.id !== 'cs_direct' || !needsChecker(ctx, 'cost_rate')) {
      insert(ctx, 'cost_rates', { user_id: user.id, monthly_ctc_paise: i.monthly_ctc_paise, variable_pct: 0, sales_target_paise: null, effective_from: i.joined_on } as never)
      ctcSaved = true
    } else warn(ctx, 'CTC_NEEDS_APPROVAL', 'Salaries need a second person in this workspace, so the CTC was not saved. Add it under Settings → Cost rates to send it for approval.')
  }
  const mgr = i.reports_to_id ? d.users.find((u) => u.id === i.reports_to_id) ?? null : null
  let email: EmailMessage | null = null
  if (i.send_welcome) {
    email = sendEmail(ctx, 'welcome', { email: user.email, user_id: user.id }, {
      employee_name: user.name, username: user.email, temp_password: temp, role_name: role.name, manager_name: mgr?.name ?? '—',
      joining_date: new Date(i.joined_on + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }), employee_code: code,
    }, { entity: 'user', id: user.id })
    if (!email) warn(ctx, 'EMAIL_TEMPLATE_OFF', 'The welcome email template is turned off, so no email was sent. Share the login details yourself.')
  }
  if (mgr) {
    const mp = permissionsOf(mgr)
    notify(ctx, mgr.id, 'NTF-14', 'New team member', `${user.name} joins your team on ${i.joined_on} as ${desig?.name ?? role.name}.`, mp.includes('users.view') ? `/people?focus=${user.id}` : mp.includes('team.view') ? '/team' : null)
  }
  let joiningLetterId: string | null = null
  if (i.issue_joining_letter) {
    try {
      joiningLetterId = issueJoiningLetter(ctx, user.id, i.monthly_ctc_paise).id
    } catch (e) {
      warn(ctx, 'JOINING_LETTER_FAILED', `The employee was created, but the joining letter was not issued: ${(e as Error).message}`)
    }
  }
  let onboardingId: string | null = null
  if (i.start_onboarding) {
    const t = onboardingTemplate(ctx)
    try {
      if (!t) throw new Error('there is no active onboarding workflow.')
      onboardingId = startWorkflow(ctx, t, user.id, { note: `Started when ${user.name} was created` }).id
    } catch (e) {
      warn(ctx, 'ONBOARDING_NOT_STARTED', `The employee was created, but the onboarding workflow was not started: ${(e as Error).message} Start it from Workflows.`)
    }
  }
  if (cs.id !== 'cs_direct') notify(ctx, cs.maker_id, 'NTF-05', 'Employee created', `${user.name} (${code}) was approved and created.${email ? ' The welcome email has been sent.' : ''}`, `/people?focus=${user.id}`)
  logActivity(ctx, 'user', user.id, 'create', `Created employee ${user.name} (${code}) as ${role.name}${cs.id !== 'cs_direct' ? ` — proposed by ${userName(ctx, cs.maker_id)}` : ''}`)
  persist()
  return { user: userRow(ctx, user), employee_code: code, login_email: user.email, temp_password: temp, email, manager_name: mgr?.name ?? null, ctc_saved: ctcSaved, joining_letter_id: joiningLetterId, onboarding_workflow_id: onboardingId }
}

function deactivateUser(ctx: Ctx, cs: ChangeSet) {
  const id = String((cs.payload as { user_id: string }).user_id)
  const u = find(ctx, 'users', id, 'Person')
  if (u.status === 'deactivated') return { result: userRow(ctx, u), result_id: u.id }
  assertNoLockout(ctx, { users: { [u.id]: { status: 'deactivated' } } })
  const reports = rows(ctx, 'users').filter((x) => x.reports_to_id === u.id && x.status === 'active')
  const out = update(ctx, 'users', u.id, { status: 'deactivated' })
  const d = getDb()
  d.sessions = d.sessions.filter((s) => s.user_id !== u.id)
  persist()
  if (reports.length) warn(ctx, 'REPORTS_ORPHANED', `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to ${u.name}. Assign them a new manager so their approvals keep moving.`)
  logActivity(ctx, 'user', u.id, 'deactivate', `Deactivated ${u.name}${cs.id !== 'cs_direct' ? ` — proposed by ${userName(ctx, cs.maker_id)}` : ''}`)
  return { result: userRow(ctx, out), result_id: u.id }
}

registerApplier('employee', (ctx, cs) => {
  const op = (cs.payload as { op: string }).op
  if (op === 'create') {
    const r = createEmployee(ctx, cs)
    return { result: r, result_id: r.user.id }
  }
  if (op === 'deactivate') return deactivateUser(ctx, cs)
  err(422, 'VALIDATION', 'Unknown employee change.')
})

registerApplier('user_access', (ctx, cs) => {
  const p = cs.payload as { user_id: string; access: AccessInput; before: AccessInput }
  const u = find(ctx, 'users', p.user_id, 'Person')
  const cur: AccessInput = { role_key: u.role_key, extra_permissions: [...(u.extra_permissions ?? [])].sort(), revoked_permissions: [...(u.revoked_permissions ?? [])].sort() }
  if (cs.id !== 'cs_direct' && JSON.stringify(cur) !== JSON.stringify(p.before)) err(409, 'STALE', 'Their access changed after this was proposed. Reject it and ask the maker to propose again.')
  const role = roleDef(ctx.tenant.id, p.access.role_key)
  if (!role) err(409, 'VALIDATION', 'The chosen role no longer exists.')
  assertNoLockout(ctx, { users: { [u.id]: p.access } })
  u.role_key = role.key
  u.role = role.persona
  u.extra_permissions = p.access.extra_permissions
  u.revoked_permissions = p.access.revoked_permissions
  u.version++
  u.updated_at = nowISO()
  persist()
  logActivity(ctx, 'user', u.id, 'access', `${cs.summary}${cs.id !== 'cs_direct' ? ` — proposed by ${userName(ctx, cs.maker_id)}` : ''}`)
  if (cs.id !== 'cs_direct') notify(ctx, u.id, 'NTF-05', 'Your access changed', `You are now ${role.name}. Sign-in pages update within a minute.`, '/home')
  return { result: userRow(ctx, u), result_id: u.id }
})

/* ------------------------------------------------------------------ */
/* Invites                                                               */
/* ------------------------------------------------------------------ */
function roleFromText(ctx: Ctx, v: string): RoleDef | null {
  const s = v.trim().toLowerCase()
  const roles = rows(ctx, 'roles').filter((r) => r.active)
  const legacy: Record<string, string> = { admin: 'administrator', pm: 'project_manager', manager: 'project_manager', sales: 'sales_executive', ops: 'hr_executive', hr: 'hr_executive', operations: 'hr_executive', developer: 'employee', engineer: 'employee', member: 'employee' }
  return roles.find((r) => r.key === s || r.name.toLowerCase() === s) ?? roles.find((r) => r.key === legacy[s]) ?? null
}
function newInvite(ctx: Ctx, b: { name: string; email: string; role: RoleDef; reports_to_id: string | null }) {
  return insert(ctx, 'invites', { email: b.email, name: b.name, role: b.role.persona, role_key: b.role.key, reports_to_id: b.reports_to_id, token: 'inv_' + randomToken(24), expires_at: addDays(todayISO(), INVITE_DAYS) + 'T23:59:59Z', accepted_at: null } as never) as E.Invite
}

/** 2FA setup secrets live in `pending_tokens` (kind two_factor_setup), not in process memory, so the verify call may
 * land on any API instance. A started setup stays valid for 30 minutes and allows 5 wrong codes. */
function twoFactorPending(ctx: Ctx, userId: string) {
  const now = nowISO()
  return rows(ctx, 'pending_tokens').find((t) => t.kind === 'two_factor_setup' && t.user_id === userId && t.expires_at > now) ?? null
}

export function register(r: Router) {
  /* ---------------- people ---------------- */
  r.get('/users', ({ ctx }) => {
    requireAction(ctx, 'users.view')
    return userRows(ctx, rows(ctx, 'users').filter((u) => !u.is_super_admin)).sort((a, b) => a.name.localeCompare(b.name))
  })
  r.get('/users/:id', ({ ctx, params }) => {
    requireAction(ctx, 'users.view')
    return userRow(ctx, find(ctx, 'users', params.id, 'Person'))
  })

  r.patch('/users/:id', ({ ctx, params, body, ifMatch }) => {
    const u = find(ctx, 'users', params.id, 'Person')
    if (u.is_super_admin) err(404, 'NOT_FOUND', 'Person not found.')
    const JOB = ['name', 'title', 'department_id', 'designation_id', 'grade_id', 'location_id', 'shift_id', 'cost_centre_id', 'employment_type', 'reports_to_id', 'phone', 'personal_email', 'joined_on', 'productive_hours']
    const ACCESS = ['role_key', 'extra_permissions', 'revoked_permissions']
    const wantsJob = JOB.some((k) => body[k] !== undefined)
    const wantsAccess = ACCESS.some((k) => body[k] !== undefined)
    if (!wantsJob && !wantsAccess) err(422, 'VALIDATION', 'Nothing to change.')
    if (wantsJob) requireAction(ctx, 'employees.edit', 'You can’t edit employee records.')
    if (wantsAccess) requireAction(ctx, 'users.manage', 'Changing a role or permissions needs “Manage user access”.')
    if (u.status === 'deactivated') err(409, 'USER_DEACTIVATED', 'Reactivate this person before editing.')
    if (ifMatch !== undefined && ifMatch !== u.version) err(409, 'STALE', 'Someone else changed this person. Reload to see the latest version.')

    // validate everything before writing anything
    const patch: Partial<E.User> = {}
    if (wantsJob) {
      if (body.name !== undefined) {
        if (String(body.name).trim().length < 2) err(422, 'VALIDATION', 'Enter a name.', 'name')
        patch.name = String(body.name).trim()
      }
      if (body.title !== undefined) patch.title = String(body.title ?? '').trim().slice(0, 80)
      if (body.phone !== undefined) {
        const ph = String(body.phone ?? '').trim()
        if (ph && !/^[+\d][\d\s-]{6,16}$/.test(ph)) err(422, 'VALIDATION', 'Enter a valid phone number.', 'phone')
        patch.phone = ph || null
      }
      if (body.personal_email !== undefined) {
        const pe = String(body.personal_email ?? '').trim().toLowerCase()
        if (pe && !EMAIL_RE.test(pe)) err(422, 'VALIDATION', 'Enter a valid personal email.', 'personal_email')
        patch.personal_email = pe || null
      }
      if (body.productive_hours !== undefined) {
        // hours of task work a day planning and forecasts assume (Feature Guide §16); null/'' = company default
        const raw = body.productive_hours
        if (raw === null || raw === '') patch.productive_hours = null
        else {
          const h = Number(raw)
          const minH = ctx.tenant.settings['calendar.min_hours_per_day']
          if (!Number.isFinite(h) || h < 0.5 || h > minH || Math.abs(h * 2 - Math.round(h * 2)) > 1e-9) err(422, 'VALIDATION', `Productive hours must be 0.5 to ${minH} (the daily minimum), in half hours.`, 'productive_hours')
          patch.productive_hours = h
        }
      }
      if (body.joined_on !== undefined) {
        if (!DATE_RE.test(String(body.joined_on))) err(422, 'VALIDATION', 'Choose the joining date.', 'joined_on')
        patch.joined_on = String(body.joined_on)
      }
      if (body.employment_type !== undefined) {
        if (body.employment_type && !(EMPLOYMENT_TYPES as readonly string[]).includes(body.employment_type)) err(422, 'VALIDATION', 'Choose the employment type.', 'employment_type')
        patch.employment_type = body.employment_type || null
      }
      const refs: [MasterTable, keyof E.User][] = [['departments', 'department_id'], ['designations', 'designation_id'], ['grades', 'grade_id'], ['locations', 'location_id'], ['shifts', 'shift_id'], ['cost_centres', 'cost_centre_id']]
      for (const [table, field] of refs) if (body[field] !== undefined) (patch as Record<string, unknown>)[field] = masterRef(ctx, table, body[field], field, u[field] as string | null)
      if (patch.department_id) patch.department = rows(ctx, 'departments').find((d) => d.id === patch.department_id)?.kind ?? u.department
      if (patch.designation_id && patch.designation_id !== u.designation_id && body.title === undefined) patch.title = rows(ctx, 'designations').find((d) => d.id === patch.designation_id)?.name ?? u.title
      if (body.reports_to_id !== undefined) {
        const m = (body.reports_to_id as string) || null
        assertManager(ctx, u.id, m)
        if (!m && u.role !== 'admin') err(422, 'VALIDATION', 'Choose who they report to. Only leadership roles may have no manager.', 'reports_to_id')
        patch.reports_to_id = m
      }
    }
    let accessReq: { access: AccessInput; role: RoleDef; before: AccessInput } | null = null
    if (wantsAccess) {
      const { access, role } = readAccess(ctx, body, u)
      const before: AccessInput = { role_key: u.role_key, extra_permissions: [...(u.extra_permissions ?? [])].sort(), revoked_permissions: [...(u.revoked_permissions ?? [])].sort() }
      if (JSON.stringify(before) !== JSON.stringify(access)) {
        const managerId = patch.reports_to_id !== undefined ? patch.reports_to_id : u.reports_to_id
        if (!managerId && role.persona !== 'admin') err(422, 'VALIDATION', `${role.name} needs a reporting manager. Set “Reports to” first.`, 'role_key')
        assertNoLockout(ctx, { users: { [u.id]: access } })
        accessReq = { access, role, before }
      }
    }

    // access first: maker-checker may still refuse it (pending change, no checker) before anything is written
    let access: ReturnType<typeof proposeNamed> | null = null
    if (accessReq) {
      const { access: a, role, before } = accessReq
      const parts: string[] = []
      if (a.role_key !== before.role_key) parts.push(`role ${roleDef(ctx.tenant.id, before.role_key)?.name ?? before.role_key} → ${role.name}`)
      const dx = diffSummary(before.extra_permissions, a.extra_permissions)
      if (dx.text) parts.push(`extra ${dx.text}`)
      const dr = diffSummary(before.revoked_permissions, a.revoked_permissions)
      if (dr.text) parts.push(`removed ${dr.text}`)
      access = proposeNamed(ctx, {
        entity: 'user_access', entity_id: u.id, action: 'update', summary: `${u.name}: ${parts.join('; ')}`,
        before: { ...before }, after: { ...a }, payload: { user_id: u.id, access: a, before }, required_permission: 'users.manage',
      })
    }
    let out = u
    if (wantsJob && Object.keys(patch).length) {
      out = update(ctx, 'users', u.id, patch)
      logActivity(ctx, 'user', u.id, 'update', `Updated ${out.name}’s job details`)
    }
    return { user: userRow(ctx, find(ctx, 'users', out.id)), access }
  })

  r.post('/employees', ({ ctx, body }) => {
    requireAction(ctx, 'employees.create', 'You can’t create employees.')
    const input = readEmployee(ctx, body)
    assertSeats(ctx, 1)
    const role = roleDef(ctx.tenant.id, input.role_key)!
    const mgr = input.reports_to_id ? userName(ctx, input.reports_to_id) : null
    return proposeNamed<CreatedEmployee>(ctx, {
      entity: 'employee', entity_id: null, action: 'create',
      summary: `New employee ${input.name} (${input.email}) as ${role.name}${mgr ? `, reporting to ${mgr}` : ''}`,
      before: null, after: { name: input.name, email: input.email, role: role.name, reports_to: mgr, joined_on: input.joined_on, extra_permissions: input.extra_permissions },
      payload: { op: 'create', input }, required_permission: 'employees.create',
    })
  })

  r.post('/users/:id/reset-password', ({ ctx, params }) => {
    requireAction(ctx, 'users.manage', 'Resetting a password needs “Manage user access”.')
    const u = find(ctx, 'users', params.id, 'Person')
    if (u.is_super_admin) err(404, 'NOT_FOUND', 'Person not found.')
    if (u.status === 'deactivated') err(409, 'USER_DEACTIVATED', 'Reactivate this person first.')
    if (u.id === ctx.user.id) err(409, 'VALIDATION', 'Change your own password under Settings → Security.')
    const temp = tempPassword(ctx.tenant.settings?.['security.password_min_length'] ?? 10)
    const d = getDb()
    d.passwords = d.passwords.filter((x) => x.user_id !== u.id)
    d.passwords.push({ user_id: u.id, password: temp })
    d.sessions = d.sessions.filter((s) => s.user_id !== u.id)
    u.must_change_password = true
    u.version++
    u.updated_at = nowISO()
    persist()
    const email = sendEmail(ctx, 'password_reset', { email: u.email, user_id: u.id }, { employee_name: u.name, username: u.email, temp_password: temp }, { entity: 'user', id: u.id })
    logActivity(ctx, 'user', u.id, 'reset_password', `Reset ${u.name}’s password`)
    return { user: userRow(ctx, u), temp_password: temp, login_email: u.email, email }
  })

  // lost phone and recovery codes: an access admin removes the person's second factor (they sign in with the password
  // and can set it up again); every session of theirs ends. Never for yourself (use Settings → Security).
  r.post('/users/:id/2fa/reset', ({ ctx, params }) => {
    requireAction(ctx, 'users.manage', 'Resetting two-step verification needs “Manage user access”.')
    const u = find(ctx, 'users', params.id, 'Person')
    if (u.is_super_admin) err(404, 'NOT_FOUND', 'Person not found.')
    if (u.id === ctx.user.id) err(409, 'VALIDATION', 'Turn your own two-step verification off under Settings → Security.')
    if (!u.two_factor) err(409, 'TWO_FACTOR_OFF', `${u.name} doesn’t use two-step verification.`)
    removeWhere(ctx, 'pending_tokens', (t) => (t.kind === 'two_factor' || t.kind === 'two_factor_setup' || t.kind === 'mfa_login') && t.user_id === u.id)
    u.two_factor = false
    u.version++
    u.updated_at = nowISO()
    const d = getDb()
    d.sessions = d.sessions.filter((x) => x.user_id !== u.id)
    persist()
    logActivity(ctx, 'user', u.id, 'reset_2fa', `Reset ${u.name}’s two-step verification`)
    return { user: userRow(ctx, u) }
  })

  r.post('/users/:id/deactivate', ({ ctx, params }) => {
    requireAction(ctx, 'employees.deactivate', 'You can’t deactivate people.')
    const u = find(ctx, 'users', params.id, 'Person')
    if (u.is_super_admin) err(404, 'NOT_FOUND', 'Person not found.')
    if (u.status === 'deactivated') return { pending: false, result: userRow(ctx, u), result_id: u.id }
    if (u.id === ctx.user.id) err(409, 'VALIDATION', 'You can’t deactivate yourself. Ask another administrator.')
    if (isAccessAdmin(permissionsOf(u)) && !has(ctx, 'users.manage')) err(403, 'PERMISSION_ESCALATION', `${u.name} manages roles or users. Only someone with “Manage user access” can deactivate them.`)
    assertNoLockout(ctx, { users: { [u.id]: { status: 'deactivated' } } })
    return proposeNamed(ctx, {
      entity: 'employee', entity_id: u.id, action: 'delete', summary: `Deactivate ${u.name}`,
      before: { status: u.status }, after: { status: 'deactivated' }, payload: { op: 'deactivate', user_id: u.id }, required_permission: 'employees.deactivate',
    })
  })

  r.post('/users/:id/reactivate', ({ ctx, params }) => {
    requireAction(ctx, 'employees.deactivate', 'You can’t reactivate people.')
    const u = find(ctx, 'users', params.id, 'Person')
    if (u.status === 'active') return userRow(ctx, u)
    assertSeats(ctx, 1)
    const out = update(ctx, 'users', u.id, { status: 'active' })
    if (u.reports_to_id) {
      const m = getDb().users.find((x) => x.id === u.reports_to_id)
      if (!m || m.status !== 'active') warn(ctx, 'MANAGER_INACTIVE', `${u.name}’s manager is no longer active. Choose a new manager.`)
    }
    logActivity(ctx, 'user', u.id, 'reactivate', `Reactivated ${u.name}`)
    return userRow(ctx, out)
  })

  /* ---------------- invites ---------------- */
  r.get('/invites', ({ ctx }) => {
    requireAction(ctx, 'users.view')
    return rows(ctx, 'invites')
      .filter((i) => !i.accepted_at)
      .map((i) => inviteView(ctx, i))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  })

  r.post('/users/invite', ({ ctx, body }) => {
    requireAction(ctx, 'employees.create', 'You can’t add people.')
    const name = String(body.name ?? '').trim()
    const email = String(body.email ?? '').trim().toLowerCase()
    const reports_to_id = (body.reports_to_id as string) || null
    if (name.length < 2) err(422, 'VALIDATION', 'Enter their name.', 'name')
    if (!EMAIL_RE.test(email)) err(422, 'VALIDATION', 'Enter a valid email address.', 'email')
    const role = roleFromText(ctx, String(body.role_key ?? body.role ?? 'employee'))
    if (!role) err(422, 'VALIDATION', 'Choose a role.', 'role_key')
    readAccess(ctx, { role_key: role.key, extra_permissions: [] }, null)
    const taken = emailTaken(ctx, email)
    if (taken) err(409, 'USER_EMAIL_TAKEN', taken, 'email')
    assertManager(ctx, null, reports_to_id)
    assertSeats(ctx, 1)
    const inv = newInvite(ctx, { name, email, role, reports_to_id })
    logActivity(ctx, 'invite', inv.id, 'create', `Invited ${name} (${email}) as ${role.name}`)
    return inviteView(ctx, inv)
  })

  r.post('/users/bulk-invite', ({ ctx, body }) => {
    requireAction(ctx, 'employees.create', 'You can’t add people.')
    const input = (body.rows ?? []) as { name?: string; email?: string; role?: string; reports_to_email?: string }[]
    if (!input.length) err(422, 'VALIDATION', 'Add at least one row: name,email,role,reports_to_email.')
    if (input.length > 200) err(422, 'VALIDATION', 'Invite up to 200 people at a time.')
    const users = rows(ctx, 'users')
    const seen = new Set<string>()
    const out = input.map((row, idx) => {
      const errors: string[] = []
      const name = String(row.name ?? '').trim()
      const email = String(row.email ?? '').trim().toLowerCase()
      const role = roleFromText(ctx, String(row.role ?? '') || 'employee')
      const mgrEmail = String(row.reports_to_email ?? '').trim().toLowerCase()
      if (name.length < 2) errors.push('Name is missing')
      if (!EMAIL_RE.test(email)) errors.push('Email is not valid')
      else {
        if (seen.has(email)) errors.push('Email appears twice in this file')
        const t = emailTaken(ctx, email)
        if (t) errors.push(t.includes('pending') ? 'Already has a pending invite' : 'Email already has an account')
      }
      seen.add(email)
      if (!role) errors.push(`Role "${row.role}" is not a role in this workspace`)
      else if (!has(ctx, 'users.manage') && isAccessAdmin(role.permissions)) errors.push(`${role.name} needs “Manage user access” to assign`)
      let reports_to_id: string | null = null
      if (mgrEmail) {
        const m = users.find((u) => u.email.toLowerCase() === mgrEmail && u.status === 'active')
        if (!m) errors.push(`Manager ${mgrEmail} is not an active person in this workspace`)
        else reports_to_id = m.id
      }
      return { line: idx + 1, name, email, role: role?.persona ?? 'employee', role_key: role?.key ?? '', role_name: role?.name ?? String(row.role ?? ''), reports_to_id, errors }
    })
    const bad = out.filter((x) => x.errors.length).length
    if (body.mode !== 'commit') return { rows: out, valid: out.length - bad, invalid: bad, committed: false }
    if (bad) err(422, 'VALIDATION', `${bad} row${bad === 1 ? ' has' : 's have'} errors. Fix them and try again — nothing was invited.`)
    assertSeats(ctx, out.length)
    const created = out.map((x) => inviteView(ctx, newInvite(ctx, { name: x.name, email: x.email, role: roleDef(ctx.tenant.id, x.role_key)!, reports_to_id: x.reports_to_id })))
    logActivity(ctx, 'invite', 'bulk', 'create', `Bulk-invited ${created.length} people`)
    return { rows: out, valid: out.length, invalid: 0, committed: true, invites: created }
  })

  r.post('/invites/:id/resend', ({ ctx, params }) => {
    requireAction(ctx, 'employees.create', 'You can’t resend invites.')
    const inv = find(ctx, 'invites', params.id, 'Invite')
    if (inv.accepted_at) err(409, 'INVITE_ACCEPTED', 'This invite was already accepted.')
    const out = update(ctx, 'invites', inv.id, { token: 'inv_' + randomToken(24), expires_at: addDays(todayISO(), INVITE_DAYS) + 'T23:59:59Z' })
    logActivity(ctx, 'invite', inv.id, 'resend', `Resent invite to ${inv.email}`)
    return inviteView(ctx, out)
  })

  r.del('/invites/:id', ({ ctx, params }) => {
    requireAction(ctx, 'employees.create', 'You can’t revoke invites.')
    const inv = find(ctx, 'invites', params.id, 'Invite')
    if (inv.accepted_at) err(409, 'INVITE_ACCEPTED', 'This invite was already accepted. Deactivate the person instead.')
    remove(ctx, 'invites', inv.id)
    logActivity(ctx, 'invite', inv.id, 'revoke', `Revoked invite for ${inv.email}`)
    return { ok: true }
  })

  /* ---------------- team roster (Feature Guide §16 "Team") ---------------- */
  // Who uses the board: role, function, joining date, reports to (= timesheet approver), access level,
  // productive hours a day and monthly CTC (cost_rates.view only). CTC drives cost per hour and payroll:
  // cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day) — Feature Guide §6/§16.
  r.get('/team-roster', ({ ctx }) => {
    requireAction(ctx, 'users.view')
    const st = ctx.tenant.settings
    const seeCtc = has(ctx, 'cost_rates.view')
    const fm = st['company.fy_start_month']
    const avg = avgWorkingDaysPerMonth(fyStartYear(ctx.today, fm), calendarFor(ctx), fm)
    const loading = st['finance.cost_loading_pct'] ?? 15 // kept in the payload for older clients; no longer used
    const minH = st['calendar.min_hours_per_day'] || 9
    const month = monthOf(ctx.today)
    const wdThisMonth = workingDaysInMonth(month, calendarFor(ctx))
    const defHours = st['team.default_productive_hours'] ?? 6
    const depts = rows(ctx, 'departments')
    const all = rows(ctx, 'users').filter((u) => !u.is_super_admin && u.status !== 'invited')
    const rates = rows(ctx, 'cost_rates')
    const rateOf = (id: string) => rates.filter((x) => x.user_id === id && x.effective_from <= ctx.today).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
    const people = all
      .sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || Number(!!a.reports_to_id) - Number(!!b.reports_to_id) || a.joined_on.localeCompare(b.joined_on))
      .map((u) => {
        const rd = roleDef(u.tenant_id, u.role_key)
        const rate = seeCtc ? rateOf(u.id) : null
        const mgr = u.reports_to_id ? all.find((x) => x.id === u.reports_to_id) : null
        return {
          id: u.id, version: u.version, status: u.status, name: u.name, title: u.title, avatar_hue: u.avatar_hue, employee_code: u.employee_code ?? null,
          role_key: u.role_key, role_name: rd?.name ?? u.title, persona: u.role,
          department_id: u.department_id ?? null, department_name: nameIn(depts, u.department_id) ?? null, department_kind: u.department,
          joined_on: u.joined_on, reports_to_id: u.reports_to_id, reports_to_name: mgr?.name ?? null, self_approves: !u.reports_to_id,
          productive_hours: u.productive_hours ?? null, effective_productive_hours: u.productive_hours ?? defHours,
          monthly_ctc_paise: seeCtc ? rate?.monthly_ctc_paise ?? null : null,
          variable_pct: seeCtc ? rate?.variable_pct ?? 0 : null,
          cost_per_hour_paise: seeCtc && rate ? Math.round(costPerHour(rate.monthly_ctc_paise, wdThisMonth, minH)) : null,
          // a full working day = minimum hours × cost per hour (= CTC ÷ working days in the month)
          cost_per_day_paise: seeCtc && rate ? Math.round(costPerHour(rate.monthly_ctc_paise, wdThisMonth, minH) * minH) : null,
          pending_ctc: seeCtc ? pendingBrief(ctx, 'cost_rate', u.id) : null,
        }
      })
    return {
      people, avg_working_days: avg, cost_loading_pct: loading, cost_month: month, working_days_month: wdThisMonth, default_productive_hours: defHours, min_hours: st['calendar.min_hours_per_day'],
      departments: depts.filter((d) => d.active !== false).map((d) => ({ id: d.id, name: d.name })),
      roles: rows(ctx, 'roles').filter((x) => x.active).map((x) => ({ key: x.key, name: x.name, persona: x.persona })),
      can_edit: has(ctx, 'employees.edit') && !ctx.viewAs, can_edit_access: has(ctx, 'users.manage') && !ctx.viewAs,
      can_see_ctc: seeCtc, can_edit_ctc: has(ctx, 'cost_rates.edit') && !ctx.viewAs,
    }
  })

  /* ---------------- delegations (UI-38) ---------------- */
  // Anyone who approves can delegate their own approvals; user administrators manage everyone's.
  const managesAll = (ctx: Ctx) => has(ctx, 'users.manage')
  r.get('/delegations', ({ ctx }) => {
    requireAny(ctx, ['delegations.manage', 'users.manage'])
    const all = rows(ctx, 'delegations')
    const mine = managesAll(ctx) ? all : all.filter((d) => d.from_user_id === ctx.user.id || d.to_user_id === ctx.user.id)
    return mine.sort((a, b) => b.from_on.localeCompare(a.from_on))
  })

  // projects a delegation can be scoped to (active ones)
  r.get('/delegations/options', ({ ctx }) => {
    requireAny(ctx, ['delegations.manage', 'users.manage'])
    return {
      projects: rows(ctx, 'projects').filter((p) => p.status !== 'completed' && p.status !== 'closed').sort((a, b) => a.code.localeCompare(b.code)).map((p) => ({ id: p.id, code: p.code, name: p.name })),
      can_manage_all: managesAll(ctx),
    }
  })

  r.post('/delegations', ({ ctx, body }) => {
    requireAny(ctx, ['delegations.manage', 'users.manage'], 'Only people who approve for others can delegate approvals.')
    const from = managesAll(ctx) ? String(body.from_user_id || ctx.user.id) : ctx.user.id
    if (!managesAll(ctx) && body.from_user_id && body.from_user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'You can only delegate your own approvals.')
    const to = String(body.to_user_id ?? '')
    const from_on = String(body.from_on ?? '')
    const to_on = String(body.to_on ?? '')
    const reason = String(body.reason ?? '').trim().slice(0, 200)
    const projectId = body.project_id ? String(body.project_id) : null
    // Feature Guide §16: approvals (and optionally task follow-ups). A one-project delegation is task follow-ups only.
    const includeTasks = body.include_tasks === undefined ? true : !!body.include_tasks
    if (projectId && !includeTasks) err(422, 'VALIDATION', 'A one-project delegation covers that project’s task follow-ups. Tick “Include task follow-ups” or choose All projects.', 'project_id')
    const fromU = find(ctx, 'users', from, 'Person')
    if (projectId) {
      const p = find(ctx, 'projects', projectId, 'Project')
      if (p.status === 'completed' || p.status === 'closed') err(422, 'VALIDATION', `${p.name} is ${p.status}. Pick an active project or All projects.`, 'project_id')
    }
    if (!to) err(422, 'VALIDATION', 'Choose who will approve on their behalf.', 'to_user_id')
    const toU = find(ctx, 'users', to, 'Delegate')
    if (toU.status !== 'active') err(422, 'VALIDATION', 'The delegate must be an active person.', 'to_user_id')
    if (to === from) err(422, 'VALIDATION', 'Pick someone other than the person delegating.', 'to_user_id')
    if (!DATE_RE.test(from_on) || !DATE_RE.test(to_on)) err(422, 'VALIDATION', 'Choose both dates.', 'from_on')
    if (to_on < from_on) err(422, 'DATE_RANGE', 'The end date must be on or after the start date.', 'to_on')
    if (to_on < todayISO()) err(422, 'DATE_RANGE', 'The range has already ended. Choose dates from today onwards.', 'to_on')
    if (reason && reason.length < 3) err(422, 'VALIDATION', 'Make the note at least 3 characters, or leave it empty.', 'reason')
    // overlapping delegations clash when their scopes overlap (all projects overlaps everything)
    const clash = rows(ctx, 'delegations').find((d) => d.from_user_id === from && d.from_on <= to_on && from_on <= d.to_on && (!d.project_id || !projectId || d.project_id === projectId))
    if (clash) err(409, 'DELEGATION_OVERLAP', `${fromU.name} already has a delegation${clash.project_id ? ' for that project' : ''} from ${clash.from_on} to ${clash.to_on}. Change the dates or remove that one first.`, 'from_on')
    const out = insert(ctx, 'delegations', { from_user_id: from, to_user_id: to, from_on, to_on, reason, project_id: projectId, include_tasks: includeTasks } as never)
    const scope = projectId ? rows(ctx, 'projects').find((p) => p.id === projectId)?.name ?? 'one project' : 'all projects'
    logActivity(ctx, 'delegation', out.id, 'create', `${fromU.name} delegated ${projectId ? 'task follow-ups' : includeTasks ? 'approvals and task follow-ups' : 'approvals'} (${scope}) to ${toU.name}, ${from_on} to ${to_on}`)
    notify(ctx, to, 'NTF-14', 'You are covering', `${fromU.name} handed you ${projectId ? `their ${scope} tasks` : includeTasks ? 'their approvals and open tasks' : 'their approvals'} from ${from_on} to ${to_on}${reason ? `: ${reason}` : ''}.`, projectId ? '/my-tasks' : '/approvals')
    return out
  })

  r.del('/delegations/:id', ({ ctx, params }) => {
    requireAny(ctx, ['delegations.manage', 'users.manage'])
    const d = find(ctx, 'delegations', params.id, 'Delegation')
    if (!managesAll(ctx) && d.from_user_id !== ctx.user.id) err(403, 'FORBIDDEN', 'You can only remove your own delegations.')
    remove(ctx, 'delegations', d.id)
    logActivity(ctx, 'delegation', d.id, 'delete', 'Removed a delegation')
    return { ok: true }
  })

  /* ---------------- sessions & 2FA ---------------- */
  r.get('/sessions', ({ ctx, headers }) => {
    const token = headers['Authorization']?.replace('Bearer ', '')
    return getDb()
      .sessions.filter((s) => s.user_id === ctx.user.id)
      .map((s) => ({ id: s.token.slice(-10), created_at: s.created_at, current: s.token === token }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.created_at.localeCompare(a.created_at))
  })
  r.post(
    '/sessions/revoke-others',
    ({ ctx, headers }) => {
      const token = headers['Authorization']?.replace('Bearer ', '')
      const d = getDb()
      const before = d.sessions.length
      d.sessions = d.sessions.filter((s) => s.user_id !== ctx.user.id || s.token === token)
      persist()
      return { revoked: before - d.sessions.length }
    },
    { allowViewAsWrite: true },
  )
  r.del(
    '/sessions/:id',
    ({ ctx, params, headers }) => {
      const token = headers['Authorization']?.replace('Bearer ', '')
      const d = getDb()
      const s = d.sessions.find((x) => x.user_id === ctx.user.id && x.token.slice(-10) === params.id)
      if (!s) err(404, 'NOT_FOUND', 'Session not found.')
      if (s.token === token) err(409, 'VALIDATION', 'Use Sign out to end this session.')
      d.sessions = d.sessions.filter((x) => x !== s)
      persist()
      return { ok: true }
    },
    { allowViewAsWrite: true },
  )

  r.get('/me/2fa', ({ ctx }) => {
    const u = getDb().users.find((x) => x.id === ctx.user.id)!
    const rec = u.two_factor ? twoFactorRecord(u) : null
    return { enabled: !!rec, enabled_at: rec?.payload.enabled_at ?? null, recovery_codes_left: rec ? rec.payload.recovery.length : 0 }
  })
  r.post(
    '/me/2fa/setup',
    ({ ctx }) => {
      const u = getDb().users.find((x) => x.id === ctx.user.id)!
      if (u.two_factor && twoFactorRecord(u)) err(409, 'TWO_FACTOR_ON', 'Two-step verification is already on.')
      const secret = newTotpSecret()
      const now = nowISO()
      removeWhere(ctx, 'pending_tokens', (t) => t.kind === 'two_factor_setup' && (t.user_id === u.id || t.expires_at <= now))
      insert(ctx, 'pending_tokens', { kind: 'two_factor_setup', user_id: u.id, ref_id: null, payload: { secret: sealSecret(secret), attempts: 0 }, expires_at: new Date(Date.now() + TWO_FACTOR_SETUP_MINUTES * 60_000).toISOString() })
      return { secret, otpauth_url: otpauthUrl('SeereonOS', u.email, secret) }
    },
    { allowViewAsWrite: true },
  )
  r.post(
    '/me/2fa/verify',
    ({ ctx, body, headers }) => {
      const d = getDb()
      const u = d.users.find((x) => x.id === ctx.user.id)!
      const pending = twoFactorPending(ctx, u.id)
      if (!pending) err(409, 'TWO_FACTOR_SETUP', 'Start the setup again — the key has expired.')
      const code = String(body.code ?? '').replace(/\s/g, '')
      if (!/^\d{6}$/.test(code)) err(422, 'TWO_FACTOR_CODE', 'Enter the 6-digit code from your authenticator app.', 'code')
      const p = pending!.payload as { secret: string; attempts?: number }
      const secret = openSecret(p.secret)
      const step = secret ? verifyTotp(secret, code) : null
      if (step === null) {
        const attempts = (p.attempts ?? 0) + 1
        if (attempts >= TWO_FACTOR_SETUP_ATTEMPTS) {
          removeWhere(ctx, 'pending_tokens', (t) => t.id === pending!.id)
          err(409, 'TWO_FACTOR_SETUP', 'Too many wrong codes. Start the setup again.')
        }
        touch(pending!, { ...p, attempts })
        err(422, 'TWO_FACTOR_CODE', 'That code didn’t match. Check that your phone’s clock is set automatically and enter the current code.', 'code')
      }
      const codes = newRecoveryCodes()
      const salt = randomToken(16)
      removeWhere(ctx, 'pending_tokens', (t) => (t.kind === 'two_factor_setup' || t.kind === 'two_factor') && t.user_id === u.id)
      insert(ctx, 'pending_tokens', {
        kind: 'two_factor', user_id: u.id, ref_id: null, expires_at: FAR_FUTURE,
        payload: { secret: p.secret, salt, recovery: codes.map((c) => hashRecoveryCode(salt, c)), last_step: step, fails: 0, enabled_at: nowISO() } satisfies TwoFactorPayload,
      })
      u.two_factor = true
      u.version++
      u.updated_at = nowISO()
      // the account's protection changed: other signed-in devices (which never passed the second step) are signed out
      const current = headers['Authorization']?.replace('Bearer ', '')
      d.sessions = d.sessions.filter((x) => x.user_id !== u.id || x.token === current)
      persist()
      return { user: withAccess(u), recovery_codes: codes }
    },
    { allowViewAsWrite: true },
  )
  /** an authenticated check of the second factor (turn off / new recovery codes); 5 wrong codes in a row → password only */
  const checkFactor = (rec: NonNullable<ReturnType<typeof twoFactorRecord>>, body: Req['body']) => {
    if (rec.payload.fails >= 5) err(429, 'TWO_FACTOR_LOCKED', 'Too many wrong codes. Use your password instead.', 'code')
    if (!useSecondFactor(rec, { code: body.code, recovery_code: body.recovery_code })) {
      touch(rec, { ...rec.payload, fails: (rec.payload.fails ?? 0) + 1 })
      err(422, 'TWO_FACTOR_CODE', 'That code didn’t work. Enter the current code from your authenticator app.', body.recovery_code ? 'recovery_code' : 'code')
    }
  }
  r.post(
    '/me/2fa/disable',
    ({ ctx, body }) => {
      const d = getDb()
      const u = d.users.find((x) => x.id === ctx.user.id)!
      const rec = twoFactorRecord(u)
      const byCode = !body.password && (body.code || body.recovery_code) && rec
      if (byCode) checkFactor(rec!, body)
      else {
        const pw = d.passwords.find((p) => p.user_id === u.id)
        if (!pw || !body.password || pw.password !== body.password) err(422, 'PASSWORD_WRONG', 'Password is incorrect.', 'password')
      }
      const t = d.tenants.find((x) => x.id === u.tenant_id)
      // "admins" = people who can manage roles or user access (a capability, not a persona)
      if (isAccessAdmin(permissionsOf(u)) && t?.settings['security.require_2fa_admins'])
        err(409, 'TWO_FACTOR_REQUIRED', 'Your workspace requires two-step verification for people who manage users or roles. Turn that off in Security first.')
      removeWhere(ctx, 'pending_tokens', (x) => (x.kind === 'two_factor' || x.kind === 'two_factor_setup') && x.user_id === u.id)
      u.two_factor = false
      u.version++
      u.updated_at = nowISO()
      persist()
      return withAccess(u)
    },
    { allowViewAsWrite: true },
  )
  r.post(
    '/me/2fa/recovery-codes',
    ({ ctx, body }) => {
      const u = getDb().users.find((x) => x.id === ctx.user.id)!
      const rec = u.two_factor ? twoFactorRecord(u) : null
      if (!rec) err(409, 'TWO_FACTOR_OFF', 'Turn on two-step verification first.')
      if (!/^\d{6}$/.test(String(body.code ?? '').replace(/\s/g, ''))) err(422, 'TWO_FACTOR_CODE', 'Enter the 6-digit code from your authenticator app.', 'code')
      checkFactor(rec!, { code: body.code })
      const codes = newRecoveryCodes()
      touch(rec!, { ...rec!.payload, recovery: codes.map((c) => hashRecoveryCode(rec!.payload.salt, c)) })
      return { recovery_codes: codes }
    },
    { allowViewAsWrite: true },
  )

  // UI-03: tells the set-password form whether the token is valid and the tenant's minimum length
  r.get(
    '/auth/reset-info/:token',
    ({ params }) => {
      const d = getDb()
      const t = d.reset_tokens.find((x) => x.token === params.token)
      if (!t || t.used || t.expires_at < Date.now()) err(410, 'RESET_EXPIRED', 'This reset link has expired or was already used. Request a new one.')
      const u = d.users.find((x) => x.id === t.user_id)
      const tenant = d.tenants.find((x) => x.id === u?.tenant_id)
      const email = u?.email ?? ''
      return { min_length: tenant?.settings['security.password_min_length'] ?? 10, email_hint: email.replace(/^(.)(.*)(@.*)$/, (_, a: string, b: string, c: string) => a + '•'.repeat(Math.min(6, b.length)) + c), expires_in_minutes: Math.max(1, Math.round((t.expires_at - Date.now()) / 60000)) }
    },
    { public: true },
  )

  r.patch('/me/avatar', ({ ctx, body }) => {
    const u = getDb().users.find((x) => x.id === ctx.user.id)!
    const hue = Number(body.hue)
    if (!Number.isFinite(hue) || hue < 0 || hue > 360) err(422, 'VALIDATION', 'Pick a colour.', 'hue')
    u.avatar_hue = Math.round(hue)
    u.version++
    u.updated_at = nowISO()
    persist()
    return withAccess(u)
  })
}

