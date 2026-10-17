import type * as E from '@/types/entities'
import { canSeeTask } from './tasks'
import { visibleDocuments } from './documents'
import { canView as canViewWorkflow } from './workflowsV7'
import { canSeeIssued } from './docsV7'
import { DEFAULT_SETTINGS, DEFAULT_THEME } from '../seed'
import { err, getDb, insert, nowISO, persist, requireAction, roleDef, rows, uid, withAccess, type Ctx, type Router } from '../server'
import { provisionTenant } from '../seeds/access'
import { addDays, todayISO } from '@/domain/calendar'
import { checkPassword } from '@/domain/passwordPolicy'
import { randomToken, sha256Hex } from '@/domain/totp'
import { MFA_LOGIN_MINUTES, MFA_MAX_ATTEMPTS, twoFactorRecord, useSecondFactor } from '../twoFactor'

export function publicUser(u: E.User) {
  return u
}

/** Lightweight directory row used by every people picker, avatar and name lookup. */
export interface DirectoryPerson {
  id: string
  name: string
  title: string
  role: E.Role
  role_key: string
  role_name: string
  email: string
  reports_to_id: string | null
  avatar_hue: number
  status: E.User['status']
  department: E.User['department']
}

function issue(user: E.User) {
  const d = getDb()
  const token = 'tok_' + uid()
  d.sessions.push({ token, user_id: user.id, tenant_id: user.tenant_id, created_at: nowISO() })
  user.last_login_at = nowISO()
  persist()
  const tenant = d.tenants.find((t) => t.id === user.tenant_id) ?? null
  return { token, user: withAccess(user), tenant }
}

/** A sign-in that passed the password and waits for the second step. The token carries the tenant id as a routing
 * prefix (the API locates the tenant without a cross-tenant lookup); only its SHA-256 is stored. */
function mfaChallenge(user: E.User) {
  const d = getDb()
  const now = nowISO()
  const token = `${user.tenant_id}.${randomToken()}`
  // purge this tenant's expired challenges, and the user's older ones (one pending sign-in per user is plenty)
  d.pending_tokens = d.pending_tokens.filter((t) => !(t.kind === 'mfa_login' && t.tenant_id === user.tenant_id && (t.expires_at <= now || t.user_id === user.id)))
  d.pending_tokens.push({ id: sha256Hex(token), tenant_id: user.tenant_id, created_at: now, updated_at: now, created_by: user.id, version: 1, kind: 'mfa_login', user_id: user.id, ref_id: null, payload: { attempts: 0 }, expires_at: new Date(Date.now() + MFA_LOGIN_MINUTES * 60_000).toISOString() })
  persist()
  return { mfa_required: true as const, mfa_token: token, expires_in: MFA_LOGIN_MINUTES * 60 }
}

export function tenantOf(ctx: Ctx) {
  return getDb().tenants.find((t) => t.id === ctx.tenant.id)!
}

export function register(r: Router) {
  r.post(
    '/auth/login',
    ({ body }) => {
      const d = getDb()
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      const user = d.users.find((u) => u.email.toLowerCase() === email)
      const tenant = user ? d.tenants.find((t) => t.id === user.tenant_id) : null
      const s = tenant?.settings ?? DEFAULT_SETTINGS
      const windowMs = s['security.lockout_minutes'] * 60000
      const recent = d.login_attempts.filter((a) => a.email === email && Date.now() - a.at < windowMs)
      if (recent.length >= s['security.lockout_attempts'])
        err(429, 'LOGIN_LOCKED', `Too many attempts. Try again in ${s['security.lockout_minutes']} minutes or reset your password.`)
      const ok = user && d.passwords.find((p) => p.user_id === user.id)?.password === password
      if (!ok) {
        d.login_attempts.push({ email, at: Date.now() })
        persist()
        const left = s['security.lockout_attempts'] - recent.length - 1
        err(401, 'LOGIN_FAILED', left > 0 ? `Email or password is incorrect. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Email or password is incorrect.')
      }
      if (user!.status === 'deactivated') err(403, 'USER_DEACTIVATED', 'This account has been deactivated. Ask your admin to reactivate it.')
      if (tenant?.status === 'suspended' && !user!.is_super_admin) err(403, 'TENANT_SUSPENDED', 'This workspace is suspended. Contact SeereonOS support.')
      // two-step verification: the password was right, but no session yet — a short-lived, single-use challenge.
      // Failed attempts are NOT cleared here, so a stolen password cannot reset the lockout counter.
      if (user!.two_factor) {
        if (twoFactorRecord(user!)) return mfaChallenge(user!)
        user!.two_factor = false // flag without a factor (data from before real 2FA): heal instead of locking the user out
      }
      d.login_attempts = d.login_attempts.filter((a) => a.email !== email)
      return issue(user!)
    },
    { public: true },
  )

  // second step of sign-in: { mfa_token, code } or { mfa_token, recovery_code } → the normal sign-in payload
  r.post(
    '/auth/login/mfa',
    ({ body }) => {
      const d = getDb()
      const token = String(body.mfa_token ?? '')
      const id = token ? sha256Hex(token) : ''
      const ch = id ? d.pending_tokens.find((t) => t.kind === 'mfa_login' && t.id === id) : undefined
      if (!ch || ch.expires_at <= nowISO()) err(401, 'MFA_EXPIRED', 'This sign-in has expired. Sign in again.')
      const user = d.users.find((u) => u.id === ch!.user_id && u.tenant_id === ch!.tenant_id)
      const rec = user ? twoFactorRecord(user) : null
      const burn = () => {
        d.pending_tokens = d.pending_tokens.filter((t) => t !== ch)
        persist()
      }
      if (!user || !rec) {
        burn()
        err(401, 'MFA_EXPIRED', 'This sign-in has expired. Sign in again.')
      }
      const email = user!.email.toLowerCase()
      const tenant = d.tenants.find((t) => t.id === user!.tenant_id)
      const s = tenant?.settings ?? DEFAULT_SETTINGS
      const recent = d.login_attempts.filter((a) => a.email === email && Date.now() - a.at < s['security.lockout_minutes'] * 60000)
      if (recent.length >= s['security.lockout_attempts']) {
        burn()
        err(429, 'LOGIN_LOCKED', `Too many attempts. Try again in ${s['security.lockout_minutes']} minutes or reset your password.`)
      }
      const useRecovery = body.recovery_code !== undefined && body.recovery_code !== null && String(body.recovery_code).trim() !== ''
      if (!useRecovery && !/^\d{6}$/.test(String(body.code ?? '').replace(/\s/g, ''))) err(422, 'TWO_FACTOR_CODE', 'Enter the 6-digit code from your authenticator app.', 'code')
      const ok = useSecondFactor(rec!, useRecovery ? { recovery_code: body.recovery_code } : { code: body.code })
      if (!ok) {
        // counted toward the account lockout, and the challenge burns after MFA_MAX_ATTEMPTS wrong codes
        d.login_attempts.push({ email, at: Date.now() })
        const attempts = Number((ch!.payload as { attempts?: number } | null)?.attempts ?? 0) + 1
        if (attempts >= MFA_MAX_ATTEMPTS) {
          burn()
          err(401, 'MFA_LOCKED', 'Too many wrong codes. Sign in again.')
        }
        ch!.payload = { attempts }
        ch!.updated_at = nowISO()
        ch!.version++
        persist()
        const left = MFA_MAX_ATTEMPTS - attempts
        err(401, 'MFA_CODE_INVALID', `${useRecovery ? 'That recovery code didn’t work.' : 'That code didn’t work. Check your authenticator app and try again.'} ${left} attempt${left === 1 ? '' : 's'} left.`, useRecovery ? 'recovery_code' : 'code')
      }
      if (user!.status === 'deactivated') err(403, 'USER_DEACTIVATED', 'This account has been deactivated. Ask your admin to reactivate it.')
      if (tenant?.status === 'suspended' && !user!.is_super_admin) err(403, 'TENANT_SUSPENDED', 'This workspace is suspended. Contact SeereonOS support.')
      burn()
      d.login_attempts = d.login_attempts.filter((a) => a.email !== email)
      const out = issue(user!)
      return ok === 'recovery' ? { ...out, recovery_codes_left: rec!.payload.recovery.length } : out
    },
    { public: true },
  )

  r.post(
    '/auth/signup',
    ({ body }) => {
      const d = getDb()
      const company = String(body.company ?? '').trim()
      const name = String(body.name ?? '').trim()
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      if (company.length < 2) err(422, 'VALIDATION', 'Enter your company name.', 'company')
      if (name.length < 2) err(422, 'VALIDATION', 'Enter your name.', 'name')
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) err(422, 'VALIDATION', 'Enter a valid work email.', 'email')
      const weak = checkPassword(password, { min: 10, email })
      if (weak) err(422, weak.code, weak.message, 'password')
      if (d.users.some((u) => u.email.toLowerCase() === email)) err(409, 'USER_EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.', 'email')
      const today = todayISO()
      const tenantId = 'tn_' + uid()
      const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)
      const tenant: E.Tenant = {
        id: tenantId, name: company, slug, status: 'trial', industry: (body.industry as E.Industry) ?? 'it_services', trial_ends_on: addDays(today, 14),
        time_zone: 'Asia/Kolkata', plan_code: 'trial', seats: 5, created_at: nowISO(), logo_data_url: null, theme: { ...DEFAULT_THEME }, settings: { ...DEFAULT_SETTINGS }, version: 1,
      }
      d.tenants.push(tenant)
      const ctx = { tenant, user: { id: 'system' } } as unknown as Ctx
      const t0 = nowISO()
      provisionTenant(d, tenant, () => ({ id: uid(), tenant_id: tenantId, created_at: t0, updated_at: t0, created_by: null, version: 1 }))
      const user = insert(ctx, 'users', {
        email, name, title: 'Founder', role: 'admin', role_key: 'administrator', extra_permissions: [], revoked_permissions: [], reports_to_id: null, grants: [], status: 'active', last_login_at: null,
        avatar_hue: Math.floor(Math.random() * 360), phone: null, joined_on: today, department: 'management', two_factor: false, prefs: {},
      } as never) as E.User
      d.passwords.push({ user_id: user.id, password })
      insert(ctx, 'subscriptions', { plan_code: 'trial', status: 'trialing', current_period_end: addDays(today, 14), seats: 5, razorpay_subscription_id: null } as never)
      d.number_sequences.push({ tenant_id: tenantId, scope: 'project', next_value: 1 })
      return issue(user)
    },
    { public: true },
  )

  r.post('/auth/logout', ({ headers }) => {
    const d = getDb()
    const token = headers['Authorization']?.replace('Bearer ', '')
    d.sessions = d.sessions.filter((s) => s.token !== token)
    persist()
    return { ok: true }
  }, { allowViewAsWrite: true })

  // UI-03 — always 202 so the form never reveals whether an email exists
  r.post(
    '/auth/reset-request',
    ({ body }) => {
      const d = getDb()
      const email = String(body.email ?? '').trim().toLowerCase()
      const user = d.users.find((u) => u.email.toLowerCase() === email)
      let demoToken: string | null = null
      if (user) {
        demoToken = 'rst_' + uid()
        d.reset_tokens.push({ token: demoToken, user_id: user.id, expires_at: Date.now() + 60 * 60000, used: false })
        persist()
      }
      // demo_token lets the preview continue without email delivery; the real API never returns it.
      return { accepted: true, demo_token: demoToken }
    },
    { public: true },
  )
  r.post(
    '/auth/reset',
    ({ body }) => {
      const d = getDb()
      const t = d.reset_tokens.find((x) => x.token === body.token)
      if (!t || t.used || t.expires_at < Date.now()) err(410, 'RESET_EXPIRED', 'This reset link has expired or was already used. Request a new one.')
      const user = d.users.find((u) => u.id === t!.user_id)!
      const tenant = d.tenants.find((x) => x.id === user.tenant_id)
      const weak = checkPassword(String(body.password ?? ''), { min: tenant?.settings['security.password_min_length'] ?? 10, email: user.email })
      if (weak) err(422, weak.code, weak.message, 'password')
      d.passwords = d.passwords.filter((p) => p.user_id !== user.id)
      d.passwords.push({ user_id: user.id, password: body.password })
      t!.used = true
      d.sessions = d.sessions.filter((s) => s.user_id !== user.id)
      persist()
      return { ok: true }
    },
    { public: true },
  )

  // UI-04 — invite acceptance
  r.get(
    '/invites/:token',
    ({ params }) => {
      const d = getDb()
      const inv = d.invites.find((i) => i.token === params.token)
      if (!inv || inv.accepted_at || inv.expires_at < nowISO()) err(410, 'INVITE_EXPIRED', 'This invitation has expired or was already used. Ask your admin to send a new one.')
      const tenant = d.tenants.find((t) => t.id === inv!.tenant_id)!
      const mgr = d.users.find((u) => u.id === inv!.reports_to_id)
      return { email: inv!.email, name: inv!.name, role: inv!.role, role_name: roleDef(tenant.id, inv!.role_key)?.name ?? null, company: tenant.name, reports_to: mgr?.name ?? null, theme: tenant.theme, logo_data_url: tenant.logo_data_url }
    },
    { public: true },
  )
  r.post(
    '/invites/:token/accept',
    ({ params, body }) => {
      const d = getDb()
      const inv = d.invites.find((i) => i.token === params.token)
      if (!inv || inv.accepted_at || inv.expires_at < nowISO()) err(410, 'INVITE_EXPIRED', 'This invitation has expired or was already used.')
      const tenant = d.tenants.find((t) => t.id === inv!.tenant_id)!
      const weak = checkPassword(String(body.password ?? ''), { min: tenant.settings['security.password_min_length'], email: inv!.email })
      if (weak) err(422, weak.code, weak.message, 'password')
      if (String(body.name ?? '').trim().length < 2) err(422, 'VALIDATION', 'Enter your name.', 'name')
      const ctx = { tenant, user: { id: inv!.created_by ?? 'system' } } as unknown as Ctx
      let user = d.users.find((u) => u.email === inv!.email && u.tenant_id === tenant.id)
      if (!user)
        user = insert(ctx, 'users', {
          email: inv!.email, name: String(body.name).trim(), title: body.title ?? '', role: roleDef(tenant.id, inv!.role_key)?.persona ?? inv!.role, role_key: inv!.role_key ?? 'employee', extra_permissions: [], revoked_permissions: [], reports_to_id: inv!.reports_to_id, grants: [], status: 'active', last_login_at: null,
          avatar_hue: Math.floor(Math.random() * 360), phone: null, joined_on: todayISO(), department: inv!.role === 'sales' ? 'sales' : inv!.role === 'ops' ? 'operations' : 'delivery', two_factor: false, prefs: {},
        } as never) as E.User
      else Object.assign(user, { status: 'active', name: String(body.name).trim() })
      d.passwords = d.passwords.filter((p) => p.user_id !== user!.id)
      d.passwords.push({ user_id: user.id, password: body.password })
      inv!.accepted_at = nowISO()
      persist()
      return issue(user)
    },
    { public: true },
  )

  // /me — who am I, my tenant, what I may see
  r.get('/me', ({ ctx }) => {
    const tenant = ctx.isSuper ? null : tenantOf(ctx)
    const rd = roleDef(ctx.tenant.id, ctx.roleKey)
    return {
      user: withAccess(ctx.user), tenant, role: ctx.role, real_role: ctx.realRole, grants: ctx.grants, view_as: ctx.viewAs, is_super_admin: ctx.isSuper,
      permissions: [...ctx.perms].sort(), role_def: rd ? { key: rd.key, name: rd.name, persona: rd.persona } : null,
    }
  })

  r.patch('/me/prefs', ({ ctx, body }) => {
    const u = getDb().users.find((x) => x.id === ctx.user.id)!
    u.prefs = { ...u.prefs, ...body }
    persist()
    return u
  }, { allowViewAsWrite: true })

  r.patch('/me/profile', ({ ctx, body }) => {
    const u = getDb().users.find((x) => x.id === ctx.user.id)!
    if (body.name !== undefined) {
      if (String(body.name).trim().length < 2) err(422, 'VALIDATION', 'Enter your name.', 'name')
      u.name = String(body.name).trim()
    }
    if (body.phone !== undefined) u.phone = body.phone
    if (body.title !== undefined) u.title = body.title
    u.updated_at = nowISO()
    u.version++
    persist()
    return u
  })

  r.post('/me/password', ({ ctx, body }) => {
    const d = getDb()
    const cur = d.passwords.find((p) => p.user_id === ctx.user.id)
    if (!cur || cur.password !== body.current) err(422, 'PASSWORD_WRONG', 'Current password is incorrect.', 'current')
    const weak = checkPassword(String(body.next ?? ''), { min: ctx.tenant.settings?.['security.password_min_length'] ?? 10, email: ctx.user.email })
    if (weak) err(422, weak.code, weak.message, 'next')
    if (body.next === body.current) err(422, 'PASSWORD_REUSED', 'Choose a password different from the current one.', 'next')
    cur!.password = body.next
    const me = d.users.find((x) => x.id === ctx.user.id)!
    me.must_change_password = false
    persist()
    return { ok: true, user: withAccess(me) }
  })

  // Directory for pickers (all active + invited people in the tenant, no salary data)
  r.get('/directory', ({ ctx }) =>
    rows(ctx, 'users').map<DirectoryPerson>((u) => ({ id: u.id, name: u.name, title: u.title, role: u.role, role_key: u.role_key, role_name: roleDef(u.tenant_id, u.role_key)?.name ?? u.title, email: u.email, reports_to_id: u.reports_to_id, avatar_hue: u.avatar_hue, status: u.status, department: u.department })),
  )

  // Global search for the command palette (respects role visibility)
  r.get('/search', ({ ctx, query }) => {
    const q = String(query.q ?? '').trim().toLowerCase()
    if (q.length < 2) return []
    const out: { kind: string; id: string; title: string; subtitle: string; to: string }[] = []
    const seeAll = ctx.perms.has('projects.view_all')
    const myTaskProjects = new Set(rows(ctx, 'tasks').filter((t) => t.owner_id === ctx.user.id || t.backup_id === ctx.user.id).map((t) => t.project_id))
    for (const p of rows(ctx, 'projects'))
      if ((seeAll || myTaskProjects.has(p.id)) && (p.name + ' ' + p.client + ' ' + p.code).toLowerCase().includes(q)) out.push({ kind: 'Project', id: p.id, title: p.name, subtitle: `${p.code} · ${p.client}`, to: `/projects/${p.id}` })
    for (const t of rows(ctx, 'tasks'))
      if (canSeeTask(ctx, t) && t.title.toLowerCase().includes(q)) {
        const p = rows(ctx, 'projects').find((x) => x.id === t.project_id)
        out.push({ kind: 'Task', id: t.id, title: t.title, subtitle: p?.name ?? '', to: `task:${t.id}` })
      }
    if (ctx.perms.has('deals.edit_own') || ctx.perms.has('deals.view_all'))
      for (const d of rows(ctx, 'deals'))
        if ((ctx.perms.has('deals.view_all') || d.owner_id === ctx.user.id) && (d.title + ' ' + d.client).toLowerCase().includes(q)) out.push({ kind: 'Deal', id: d.id, title: d.title, subtitle: d.client, to: `/sales/${d.id}` })
    for (const u of rows(ctx, 'users')) if ((u.name + ' ' + u.email + ' ' + u.title).toLowerCase().includes(q)) out.push({ kind: 'Person', id: u.id, title: u.name, subtitle: u.title, to: ctx.perms.has('users.view') ? `/people?focus=${u.id}` : `/team` })
    const has = (k: string) => ctx.perms.has(k as never)
    if (has('estimates.manage'))
      for (const e of rows(ctx, 'cost_estimates'))
        if ((e.name + ' ' + e.client + ' ' + (e.number ?? '')).toLowerCase().includes(q)) out.push({ kind: 'Estimate', id: e.id, title: e.name, subtitle: `${e.number ? e.number + ' · ' : ''}${e.client}`, to: `/projects/cost-calculator/${e.id}` })
    if (has('finance.view')) {
      const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
      for (const i of rows(ctx, 'invoices')) {
        const p = projects.get(i.project_id)
        const client = i.bill_to?.name ?? p?.client ?? ''
        if ((i.number + ' ' + client + ' ' + (p?.name ?? '')).toLowerCase().includes(q)) out.push({ kind: 'Invoice', id: i.id, title: i.number || 'Draft invoice', subtitle: `${client}${p ? ' · ' + p.code : ''}`, to: `/finance/invoices/${i.id}` })
      }
    }
    for (const d of visibleDocuments(ctx))
      if ((d.title + ' ' + d.tags.join(' ')).toLowerCase().includes(q)) out.push({ kind: 'Document', id: d.id, title: d.title, subtitle: d.project_id ? 'Project document' : 'Company library', to: `/documents?doc=${d.id}` })
    const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
    for (const d of rows(ctx, 'issued_documents'))
      if (canSeeIssued(ctx, d) && (d.title + ' ' + (d.ref_no ?? '') + ' ' + (users.get(d.employee_id)?.name ?? '')).toLowerCase().includes(q))
        out.push({ kind: 'Document', id: d.id, title: d.title, subtitle: `${d.ref_no ? d.ref_no + ' · ' : ''}${users.get(d.employee_id)?.name ?? ''}`, to: `/documents/issued/${d.id}` })
    if (has('documents.templates'))
      for (const t of rows(ctx, 'doc_templates'))
        if (t.name.toLowerCase().includes(q)) out.push({ kind: 'Template', id: t.id, title: t.name, subtitle: 'Document template', to: `/documents/templates/${t.id}` })
    for (const w of rows(ctx, 'wf_instances'))
      if (w.title.toLowerCase().includes(q) && canViewWorkflow(ctx, w)) out.push({ kind: 'Workflow', id: w.id, title: w.title, subtitle: w.status.replace('_', ' '), to: `/workflows/run/${w.id}` })
    if (has('workflows.design'))
      for (const t of rows(ctx, 'wf_templates'))
        if (t.name.toLowerCase().includes(q)) out.push({ kind: 'Workflow', id: t.id, title: t.name, subtitle: 'Workflow template', to: `/workflows/designer/${t.id}` })
    return out.slice(0, 24)
  })

  // Current tenant (settings are readable by everyone in the tenant; edits live in settings routes)
  r.get('/tenant', ({ ctx }) => tenantOf(ctx))

  // Theme is a tenant-level brand setting (admin only)
  r.put('/tenant/theme', ({ ctx, body, ifMatch }) => {
    requireAction(ctx, 'theme.edit', 'Only admins can change the workspace theme.')
    const t = tenantOf(ctx)
    if (ifMatch !== undefined && ifMatch !== t.version) err(409, 'STALE', 'Settings were changed by someone else. Reload and try again.')
    const hex = /^#[0-9a-fA-F]{6}$/
    if (body.primary && !hex.test(body.primary)) err(422, 'VALIDATION', 'Primary colour must be a hex value like #0C6B4E.', 'primary')
    if (body.accent && !hex.test(body.accent)) err(422, 'VALIDATION', 'Accent colour must be a hex value like #B8912B.', 'accent')
    // only theme keys (no arbitrary properties in the stored tenant row)
    const THEME_KEYS = ['preset', 'primary', 'accent', 'radius', 'density', 'font', 'mode', 'sidebar'] as const
    const patch = Object.fromEntries(THEME_KEYS.filter((k) => typeof body[k] === 'string').map((k) => [k, body[k] as string]))
    t.theme = { ...t.theme, ...patch }
    t.version++
    persist()
    return t
  })

  r.put('/tenant/logo', ({ ctx, body }) => {
    requireAction(ctx, 'settings.edit', 'Only admins can change the company logo.')
    const t = tenantOf(ctx)
    const data: string | null = body.data_url ?? null
    if (data && !/^data:image\/(png|svg\+xml|jpeg|webp);base64,/.test(data)) err(422, 'FILE_REJECTED', 'Upload a PNG, SVG, JPG or WebP image.')
    if (data && data.length > 1.4 * 1024 * 1024) err(422, 'FILE_REJECTED', 'Logo must be 1 MB or smaller.')
    t.logo_data_url = data
    t.version++
    persist()
    return t
  })

  // Demo helper: restore the demo data (preview only)
  r.post('/demo/reset', async () => {
    const m = await import('../server')
    await m.resetDb()
    return { ok: true }
  }, { public: true })
}
