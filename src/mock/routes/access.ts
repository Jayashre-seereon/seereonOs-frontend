// v4 roles & permissions, plus the organisation setup checklist.
//
// Roles are tenant data (db.roles). Every write goes through maker-checker (`propose`, entity
// 'role'); the applier below performs the real change, so the same rules run on direct apply and
// on approval. Integrity rules:
//   • role names are unique per tenant; permission keys must exist in the catalogue
//   • `requires` dependencies are added automatically (and reported back as a warning)
//   • system roles cannot be deleted or deactivated; Administrator keeps LOCKED_PERMISSIONS
//   • custom roles can be deleted only when nobody holds them
//   • nobody may lock the workspace out: at least one active person must keep both
//     “Manage roles” and “Manage user access”
import type * as E from '@/types/entities'
import type { ChangeSet, RoleDef } from '@/types/access'
import type { Action } from '@/domain/permissions'
import { LOCKED_PERMISSIONS, MODULE_LABEL, MODULE_ORDER, PERMISSIONS, PERMISSION_BY_KEY, effectivePermissions, isPermissionKey } from '@/domain/permissionCatalog'
import { assertBaseVersion, eligibleCheckers, mcConfig, pendingBrief, propose, registerApplier, type PendingBrief, type Proposal } from '../makerChecker'
import { err, getDb, has, insert, logActivity, persist, remove, requireAction, requireAny, roleDef, rows, update, userName, warn, type Ctx, type Router } from '../server'

const PERSONAS: E.Role[] = ['admin', 'pm', 'sales', 'ops', 'employee']
const ADMIN_PAIR: Action[] = ['roles.manage', 'users.manage']

/* ------------------------------------------------------------------ */
/* Helpers shared with routes/people.ts                                 */
/* ------------------------------------------------------------------ */

/** Add every `requires` dependency (transitively). Returns the closed set and what was added. */
export function withDependencies(keys: string[]): { permissions: string[]; added: string[] } {
  const set = new Set(keys)
  const added: string[] = []
  let grew = true
  while (grew) {
    grew = false
    for (const k of [...set]) {
      for (const dep of PERMISSION_BY_KEY[k]?.requires ?? []) {
        if (!set.has(dep)) {
          set.add(dep)
          added.push(dep)
          grew = true
        }
      }
    }
  }
  return { permissions: [...set].sort(), added }
}

/** Validate a permission list from the client: unknown keys are a 422. */
export function cleanPermissions(input: unknown, field = 'permissions'): string[] {
  if (!Array.isArray(input)) err(422, 'VALIDATION', 'Send the permissions as a list.', field)
  const bad = (input as unknown[]).filter((k) => typeof k !== 'string' || !isPermissionKey(k))
  if (bad.length) err(422, 'PERMISSION_UNKNOWN', `Unknown permission${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 4).join(', ')}.`, field)
  return [...new Set(input as string[])].sort()
}

export const permLabel = (k: string) => PERMISSION_BY_KEY[k]?.label ?? k

/** "+a, +b, −c" summary of a permission diff. */
export function diffSummary(before: string[], after: string[]) {
  const b = new Set(before)
  const a = new Set(after)
  const plus = after.filter((k) => !b.has(k))
  const minus = before.filter((k) => !a.has(k))
  const parts = [...plus.map((k) => '+' + k), ...minus.map((k) => '−' + k)]
  return { plus, minus, text: parts.length > 6 ? `${parts.slice(0, 6).join(', ')} and ${parts.length - 6} more` : parts.join(', ') }
}

/** Is this capability-holder an access administrator (can manage roles or users)? */
export const isAccessAdmin = (perms: readonly string[]) => perms.includes('roles.manage') || perms.includes('users.manage')

interface Hypothetical {
  roles?: Record<string, { permissions: string[]; active: boolean } | null> // null = deleted
  users?: Record<string, Partial<Pick<E.User, 'role_key' | 'extra_permissions' | 'revoked_permissions' | 'status'>>>
}
/** Throws 409 LOCKOUT when, after the hypothetical change, no active person keeps roles.manage + users.manage. */
export function assertNoLockout(ctx: Ctx, h: Hypothetical) {
  const users = rows(ctx, 'users').filter((u) => !u.is_super_admin)
  const ok = users.some((u0) => {
    const u = { ...u0, ...(h.users?.[u0.id] ?? {}) }
    if (u.status !== 'active') return false
    let rolePerms: string[] = []
    if (h.roles && u.role_key in h.roles) {
      const r = h.roles[u.role_key]
      rolePerms = r && r.active ? r.permissions : []
    } else {
      const rd = roleDef(ctx.tenant.id, u.role_key)
      rolePerms = rd && rd.active ? rd.permissions : []
    }
    const eff = effectivePermissions(rolePerms, u.extra_permissions ?? [], u.revoked_permissions ?? [])
    return ADMIN_PAIR.every((p) => eff.includes(p))
  })
  if (!ok)
    err(409, 'LOCKOUT', 'This would leave nobody who can manage roles and user access. Keep “Manage roles” and “Manage user access” with at least one active person.')
}

function slugify(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'role'
}
function uniqueKey(ctx: Ctx, name: string) {
  const base = slugify(name)
  const taken = new Set(rows(ctx, 'roles').map((r) => r.key))
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`
}
function assertNameFree(ctx: Ctx, name: string, exceptKey?: string) {
  const n = name.trim().toLowerCase()
  if (rows(ctx, 'roles').some((r) => r.key !== exceptKey && r.name.trim().toLowerCase() === n)) err(409, 'ROLE_NAME_TAKEN', `A role called “${name.trim()}” already exists. Choose another name.`, 'name')
}
function roleOr404(ctx: Ctx, key: string): RoleDef {
  const r = rows(ctx, 'roles').find((x) => x.key === key)
  if (!r) err(404, 'NOT_FOUND', 'Role not found.')
  return r
}
const activeHolders = (ctx: Ctx, key: string) => rows(ctx, 'users').filter((u) => u.role_key === key && u.status !== 'deactivated' && !u.is_super_admin)

export interface RoleRow extends RoleDef {
  user_count: number
  locked_permissions: string[]
  pending: PendingBrief | null
}
function roleRow(ctx: Ctx, r: RoleDef): RoleRow {
  return {
    ...r,
    permissions: effectivePermissions(r.permissions),
    user_count: activeHolders(ctx, r.key).length,
    locked_permissions: r.key === 'administrator' ? [...LOCKED_PERMISSIONS] : [],
    pending: pendingBrief(ctx, 'role', r.id),
  }
}

/** propose() plus the names of who can approve, so the UI can say “Sent to Santosh for approval”. */
export function proposeNamed<R = unknown>(ctx: Ctx, p: Proposal) {
  const r = propose<R>(ctx, p)
  if (!r.pending) return r
  return { ...r, checker_names: eligibleCheckers(ctx, p.required_permission, ctx.user.id).map((u) => u.name) }
}

/* ------------------------------------------------------------------ */
/* Role payload validation                                               */
/* ------------------------------------------------------------------ */
interface RoleInput {
  name: string
  description: string
  persona: E.Role
  permissions: string[]
  active: boolean
}
function readRoleInput(ctx: Ctx, body: Record<string, unknown>, cur: RoleDef | null): { data: RoleInput; added: string[] } {
  const name = body.name !== undefined ? String(body.name ?? '').trim() : cur?.name ?? ''
  if (name.length < 2) err(422, 'VALIDATION', 'Give the role a name (at least 2 characters).', 'name')
  if (name.length > 60) err(422, 'VALIDATION', 'Keep the name under 60 characters.', 'name')
  assertNameFree(ctx, name, cur?.key)
  const description = body.description !== undefined ? String(body.description ?? '').trim().slice(0, 240) : cur?.description ?? ''
  const persona = (body.persona !== undefined ? body.persona : cur?.persona ?? 'employee') as E.Role
  if (!PERSONAS.includes(persona)) err(422, 'VALIDATION', 'Choose what the role sees on Home.', 'persona')
  const active = body.active !== undefined ? !!body.active : cur?.active ?? true
  let perms = body.permissions !== undefined ? cleanPermissions(body.permissions) : effectivePermissions(cur?.permissions ?? [])
  const dep = withDependencies(perms)
  perms = dep.permissions
  if (cur?.is_system && !active) err(409, 'ROLE_SYSTEM', `${cur.name} is a built-in role and can’t be deactivated. Remove people from it or edit its permissions instead.`, 'active')
  if (cur?.key === 'administrator') {
    const missing = LOCKED_PERMISSIONS.filter((k) => !perms.includes(k))
    if (missing.length) err(409, 'ROLE_LOCKED', `Administrator always keeps ${missing.map(permLabel).join(', ')} — it is the way back in.`, 'permissions')
    if (persona !== 'admin') err(409, 'ROLE_LOCKED', 'Administrator always opens the leadership dashboard.', 'persona')
  }
  return { data: { name, description, persona, permissions: perms, active }, added: dep.added }
}

/* ------------------------------------------------------------------ */
/* Setup checklist                                                       */
/* ------------------------------------------------------------------ */
export interface SetupStep {
  key: 'org' | 'places' | 'structure' | 'roles' | 'controls' | 'people' | 'emails'
  title: string
  body: string
  done: boolean
  meta: string
  links: { label: string; to: string; action: Action }[]
}
function setupStatus(ctx: Ctx) {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
  const org = t.org
  const active = <T extends { active: boolean }>(xs: T[]) => xs.filter((x) => x.active)
  const locs = active(rows(ctx, 'locations'))
  const shifts = active(rows(ctx, 'shifts'))
  const depts = active(rows(ctx, 'departments'))
  const desig = active(rows(ctx, 'designations'))
  const grades = active(rows(ctx, 'grades'))
  const roles = rows(ctx, 'roles')
  const people = rows(ctx, 'users').filter((u) => !u.is_super_admin && u.status !== 'deactivated')
  const created = people.filter((u) => !!u.employee_code).length
  const mc = mcConfig(ctx)
  const workflowsTouched = rows(ctx, 'approval_workflows').some((w) => w.version > 1)
  const templatesTouched = rows(ctx, 'email_templates').some((x) => x.version > 1)
  const sent = rows(ctx, 'email_outbox').length
  const rolesTouched = roles.some((r) => r.version > 1 || !r.is_system) || rows(ctx, 'change_sets').some((c) => c.entity === 'role')
  const n = (k: number, one: string, many = one + 's') => `${k} ${k === 1 ? one : many}`
  const orgDone = !!org && !!org.legal_name?.trim() && !!(org.gstin?.trim() || org.pan?.trim()) && !!(org.registered_address?.trim() || org.corporate_address?.trim())
  const steps: SetupStep[] = [
    {
      key: 'org', title: 'Organisation profile', body: 'Legal name, GSTIN or PAN, registered address and the employee code format.',
      done: orgDone, meta: orgDone ? org!.legal_name : 'Legal name, tax ID and address missing',
      links: [{ label: 'Open profile', to: '/setup/org', action: 'master.view' }],
    },
    {
      key: 'places', title: 'Locations & shifts', body: 'Where people work and their working hours.',
      done: locs.length > 0 && shifts.length > 0, meta: `${n(locs.length, 'location')} · ${n(shifts.length, 'shift')}`,
      links: [{ label: 'Locations', to: '/setup/locations', action: 'master.view' }, { label: 'Shifts', to: '/setup/shifts', action: 'master.view' }],
    },
    {
      key: 'structure', title: 'Departments, designations & grades', body: 'Your structure. Designations can suggest a default role for new hires.',
      done: depts.length > 0 && desig.length > 0 && grades.length > 0, meta: `${n(depts.length, 'department')} · ${n(desig.length, 'designation')} · ${n(grades.length, 'grade')}`,
      links: [{ label: 'Departments', to: '/setup/departments', action: 'master.view' }, { label: 'Designations', to: '/setup/designations', action: 'master.view' }, { label: 'Grades', to: '/setup/grades', action: 'master.view' }],
    },
    {
      key: 'roles', title: 'Review roles & permissions', body: 'Nine roles are ready. Adjust what each can see and do, or add your own.',
      done: rolesTouched, meta: `${n(roles.filter((r) => r.active).length, 'active role')}${roles.some((r) => !r.is_system) ? ` · ${n(roles.filter((r) => !r.is_system).length, 'custom role')}` : ''}`,
      links: [{ label: 'Roles & permissions', to: '/setup/roles', action: 'roles.view' }],
    },
    {
      key: 'controls', title: 'Approval workflows & maker-checker', body: 'Who approves leave, expenses and purchases, and which changes need a second person.',
      done: mc.enabled || workflowsTouched, meta: mc.enabled ? `Maker-checker on for ${n(mc.entities.length, 'area')}` : 'Maker-checker off',
      links: [{ label: 'Workflows', to: '/setup/workflows', action: 'workflows.manage' }, { label: 'Maker-checker', to: '/setup/maker-checker', action: 'makerchecker.configure' }],
    },
    {
      key: 'people', title: 'Create employees', body: 'Add people with their role and manager. Each gets a welcome email with login details.',
      done: people.length >= 3, meta: `${n(people.length, 'person', 'people')} active${created ? ` · ${n(created, 'employee code')}` : ''}`,
      links: [{ label: 'Create employee', to: '/people/new', action: 'employees.create' }, { label: 'People', to: '/people', action: 'users.view' }],
    },
    {
      key: 'emails', title: 'Email templates', body: 'Check the welcome email and other messages before people receive them.',
      done: templatesTouched || sent > 0, meta: sent ? `${n(sent, 'email')} sent` : `${n(rows(ctx, 'email_templates').length, 'template')}`,
      links: [{ label: 'Emails', to: '/setup/emails', action: 'emails.view' }],
    },
  ]
  const done = steps.filter((s) => s.done).length
  return { steps, done, total: steps.length, complete: done === steps.length, company: org?.brand_name || t.name }
}

/* ------------------------------------------------------------------ */
/* Routes                                                                */
/* ------------------------------------------------------------------ */
export function register(r: Router) {
  r.get('/permissions', () =>
    MODULE_ORDER.map((m) => ({ module: m, label: MODULE_LABEL[m], permissions: PERMISSIONS.filter((p) => p.module === m) })),
  )

  // Roles list: role admins, previewers, and anyone who assigns roles (people pages, Create employee).
  r.get('/roles', ({ ctx }) => {
    requireAny(ctx, ['roles.view', 'view_as', 'users.view', 'employees.create'])
    const full = has(ctx, 'roles.view') || has(ctx, 'users.view') || has(ctx, 'employees.create')
    return rows(ctx, 'roles')
      .filter((x) => full || x.active)
      .map((x) => roleRow(ctx, x))
      .sort((a, b) => Number(b.is_system) - Number(a.is_system) || 0)
  })

  r.get('/roles/:key', ({ ctx, params }) => {
    requireAction(ctx, 'roles.view')
    const role = roleOr404(ctx, params.key)
    const members = rows(ctx, 'users')
      .filter((u) => u.role_key === role.key && !u.is_super_admin)
      .map((u) => ({ id: u.id, name: u.name, email: u.email, title: u.title, status: u.status, avatar_hue: u.avatar_hue, extra_permissions: u.extra_permissions ?? [], revoked_permissions: u.revoked_permissions ?? [], last_login_at: u.last_login_at }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return { ...roleRow(ctx, role), members, created_by_name: role.created_by ? userName(ctx, role.created_by) : null }
  })

  r.post('/roles', ({ ctx, body }) => {
    requireAction(ctx, 'roles.manage', 'You can’t create roles.')
    let seed: RoleDef | null = null
    if (body.copy_from) seed = roleOr404(ctx, String(body.copy_from))
    const input = { ...body, permissions: body.permissions ?? (seed ? seed.permissions : []), persona: body.persona ?? seed?.persona ?? 'employee' }
    const { data, added } = readRoleInput(ctx, input, null)
    if (added.length) warn(ctx, 'PERMISSIONS_ADDED', `Also added what these need: ${added.map(permLabel).join(', ')}.`)
    const key = uniqueKey(ctx, data.name)
    return proposeNamed(ctx, {
      entity: 'role', entity_id: null, action: 'create',
      summary: `New role ${data.name}${seed ? ` (copy of ${seed.name})` : ''}: ${data.permissions.length} permissions`,
      before: null, after: { ...data, key }, payload: { op: 'create', key, data }, required_permission: 'roles.manage',
    })
  })

  r.post('/roles/:key/clone', ({ ctx, params, body }) => {
    requireAction(ctx, 'roles.manage', 'You can’t create roles.')
    const src = roleOr404(ctx, params.key)
    let name = String(body?.name ?? '').trim()
    if (!name) {
      name = `${src.name} (copy)`
      for (let i = 2; rows(ctx, 'roles').some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `${src.name} (copy ${i})`
    }
    const { data } = readRoleInput(ctx, { name, description: src.description, persona: src.persona, permissions: src.permissions, active: true }, null)
    const key = uniqueKey(ctx, data.name)
    return proposeNamed(ctx, {
      entity: 'role', entity_id: null, action: 'create', summary: `New role ${data.name} (copy of ${src.name}): ${data.permissions.length} permissions`,
      before: null, after: { ...data, key }, payload: { op: 'create', key, data }, required_permission: 'roles.manage',
    })
  })

  r.patch('/roles/:key', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'roles.manage', 'You can’t change roles.')
    const role = roleOr404(ctx, params.key)
    if (ifMatch !== undefined && ifMatch !== role.version) err(409, 'STALE', 'Someone else changed this role. Reload to see the latest version.')
    const { data, added } = readRoleInput(ctx, body, role)
    if (added.length) warn(ctx, 'PERMISSIONS_ADDED', `Also turned on what these need: ${added.map(permLabel).join(', ')}.`)
    const before = { name: role.name, description: role.description, persona: role.persona, permissions: effectivePermissions(role.permissions), active: role.active }
    const parts: string[] = []
    if (data.name !== role.name) parts.push(`rename to ${data.name}`)
    if (data.persona !== role.persona) parts.push(`home → ${data.persona}`)
    if (data.active !== role.active) parts.push(data.active ? 'activate' : 'deactivate')
    if (data.description !== role.description) parts.push('description')
    const d = diffSummary(before.permissions, data.permissions)
    if (d.text) parts.push(d.text)
    if (!parts.length) return { pending: false, result: roleRow(ctx, role), result_id: role.id }
    if (!data.active && activeHolders(ctx, role.key).length) err(409, 'ROLE_IN_USE', `${activeHolders(ctx, role.key).length} people hold ${role.name}. Move them to another role before deactivating it.`, 'active')
    assertNoLockout(ctx, { roles: { [role.key]: { permissions: data.permissions, active: data.active } } })
    return proposeNamed(ctx, {
      entity: 'role', entity_id: role.id, action: 'update', summary: `${role.name}: ${parts.join('; ')}`,
      before, after: { ...data }, payload: { op: 'update', key: role.key, data }, required_permission: 'roles.manage', base_version: role.version,
    })
  })

  r.del('/roles/:key', ({ ctx, params }) => {
    requireAction(ctx, 'roles.manage', 'You can’t delete roles.')
    const role = roleOr404(ctx, params.key)
    if (role.is_system) err(409, 'ROLE_SYSTEM', `${role.name} is a built-in role and can’t be deleted.`)
    const holders = rows(ctx, 'users').filter((u) => u.role_key === role.key && !u.is_super_admin)
    if (holders.length) err(409, 'ROLE_IN_USE', `${holders.length} ${holders.length === 1 ? 'person holds' : 'people hold'} ${role.name}. Move them to another role first.`)
    return proposeNamed(ctx, {
      entity: 'role', entity_id: role.id, action: 'delete', summary: `Delete role ${role.name}`,
      before: { name: role.name, permissions: role.permissions }, after: null, payload: { op: 'delete', key: role.key }, required_permission: 'roles.manage', base_version: role.version,
    })
  })

  r.get('/setup/status', ({ ctx }) => {
    requireAny(ctx, ['master.view', 'roles.view', 'employees.create', 'workflows.manage', 'makerchecker.configure', 'emails.view'])
    return setupStatus(ctx)
  })
}

/* ------------------------------------------------------------------ */
/* Applier — the one place a role is actually written                    */
/* ------------------------------------------------------------------ */
registerApplier('role', (ctx: Ctx, cs: ChangeSet) => {
  const p = cs.payload as { op: 'create' | 'update' | 'delete'; key: string; data?: RoleInput }
  const by = cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''
  if (p.op === 'create') {
    const data = p.data!
    assertNameFree(ctx, data.name)
    const key = rows(ctx, 'roles').some((x) => x.key === p.key) ? uniqueKey(ctx, data.name) : p.key
    const row = insert(ctx, 'roles', { key, name: data.name, description: data.description, persona: data.persona, permissions: data.permissions, is_system: false, active: data.active } as never) as RoleDef
    if (cs.id !== 'cs_direct') row.created_by = cs.maker_id
    logActivity(ctx, 'role', row.id, 'create', `Created role ${row.name}${by}`)
    return { result: roleRow(ctx, row), result_id: row.id }
  }
  const role = roleOr404(ctx, p.key)
  assertBaseVersion(cs, role.version)
  if (p.op === 'delete') {
    if (role.is_system) err(409, 'ROLE_SYSTEM', `${role.name} is a built-in role and can’t be deleted.`)
    if (rows(ctx, 'users').some((u) => u.role_key === role.key && !u.is_super_admin)) err(409, 'ROLE_IN_USE', `People still hold ${role.name}.`)
    remove(ctx, 'roles', role.id)
    logActivity(ctx, 'role', role.id, 'delete', `Deleted role ${role.name}${by}`)
    return { result: { ok: true }, result_id: role.id }
  }
  const data = p.data!
  assertNameFree(ctx, data.name, role.key)
  if (role.key === 'administrator' && LOCKED_PERMISSIONS.some((k) => !data.permissions.includes(k))) err(409, 'ROLE_LOCKED', 'Administrator must keep role and user management.')
  assertNoLockout(ctx, { roles: { [role.key]: { permissions: data.permissions, active: data.active } } })
  const d = diffSummary(effectivePermissions(role.permissions), data.permissions)
  const out = update(ctx, 'roles', role.id, { name: data.name, description: data.description, persona: data.persona, permissions: data.permissions, active: data.active })
  // persona of holders follows the role (home dashboard, default views)
  for (const u of getDb().users) if (u.tenant_id === ctx.tenant.id && u.role_key === role.key && u.role !== data.persona) u.role = data.persona
  persist()
  logActivity(ctx, 'role', role.id, 'update', `Changed role ${data.name}${d.text ? ': ' + d.text : ''}${by}`)
  return { result: roleRow(ctx, out), result_id: role.id }
})

