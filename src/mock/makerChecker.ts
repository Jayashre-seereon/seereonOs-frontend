// v4 maker-checker. Sensitive changes are proposed by a maker and applied only after a different
// person (the checker) approves. Which entities need a checker is configured per tenant.
//
// Route contract (every guarded write):
//   validate input → build a Proposal → `return propose(ctx, proposal)`
//   propose() either applies immediately (maker-checker off for that entity) and returns
//   { pending: false, result } or stores a ChangeSet and returns { pending: true, change }.
//   The applier registered for the entity performs the real write in both cases, so the rules
//   live in one place.
//
// Integrity rules enforced here:
//   • the maker can never check their own change (409 MAKER_CANNOT_CHECK)
//   • the checker needs `makerchecker.check` AND the change's `required_permission`
//   • one pending change per record (409 CHANGE_PENDING)
//   • a record changed after the proposal fails on approval (status failed, 409 STALE)
//   • rejection needs a reason (≥ 10 characters)
//   • nobody eligible to check → 409 NO_CHECKER (never silently self-approve)
import type { ChangeEntity, ChangeSet, MakerCheckerConfig } from '@/types/access'
import { CHANGE_ENTITY_LABEL } from '@/types/access'
import type { Action } from '@/domain/permissions'
import { PERMISSION_BY_KEY } from '@/domain/permissionCatalog'
import { workingDaysBetween } from '@/domain/calendar'
import {
  calendarFor, err, find, getDb, has, insert, logActivity, notify, nowISO, permissionsOf, persist, requireAction, rows, update, userName, warn, type Ctx, type Router,
} from './server'

export type Applier = (ctx: Ctx, cs: ChangeSet) => { result_id?: string | null; result?: unknown }
const appliers = new Map<ChangeEntity, Applier>()
/** Register the function that performs a change of this entity (called on direct apply and on approval). */
export function registerApplier(entity: ChangeEntity, fn: Applier) {
  appliers.set(entity, fn)
}

export const DEFAULT_MC: MakerCheckerConfig = { enabled: false, entities: [], sla_days: 2 }
export const RECOMMENDED_MC_ENTITIES: ChangeEntity[] = ['role', 'user_access', 'cost_rate', 'workflow', 'payroll_finalise', 'vendor', 'org_profile', 'makerchecker_config']

export function mcConfig(ctx: Ctx): MakerCheckerConfig {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)
  return t?.maker_checker ?? DEFAULT_MC
}
export function needsChecker(ctx: Ctx, entity: ChangeEntity): boolean {
  const c = mcConfig(ctx)
  return c.enabled && (entity === 'makerchecker_config' || c.entities.includes(entity))
}

export interface Proposal {
  entity: ChangeEntity
  entity_id: string | null
  action: ChangeSet['action']
  summary: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  payload: Record<string, unknown>
  required_permission: Action
  base_version?: number | null
}
export type ProposeResult<R = unknown> = { pending: true; change: ChangeView } | { pending: false; result: R; result_id: string | null }

/** People (other than the maker) who could approve a change needing `perm`. */
export function eligibleCheckers(ctx: Ctx, perm: string, makerId: string) {
  return rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && u.id !== makerId && (() => {
    const p = permissionsOf(u)
    return p.includes('makerchecker.check') && p.includes(perm)
  })())
}

function runApplier(ctx: Ctx, cs: ChangeSet) {
  const fn = appliers.get(cs.entity)
  if (!fn) err(500, 'NO_APPLIER', `No handler is registered for ${cs.entity} changes.`)
  return fn(ctx, cs)
}

export function propose<R = unknown>(ctx: Ctx, p: Proposal): ProposeResult<R> {
  const draft: ChangeSet = {
    id: 'cs_direct', tenant_id: ctx.tenant.id, created_at: nowISO(), updated_at: nowISO(), version: 1,
    entity: p.entity, entity_id: p.entity_id, action: p.action, summary: p.summary, before: p.before ?? null, after: p.after ?? null, payload: p.payload,
    maker_id: ctx.user.id, required_permission: p.required_permission, base_version: p.base_version ?? null,
    status: 'approved', checker_id: null, decided_at: null, reason: null, applied_at: null, result_id: null, error: null,
  }
  if (!needsChecker(ctx, p.entity)) {
    const r = runApplier(ctx, draft)
    return { pending: false, result: r.result as R, result_id: r.result_id ?? null }
  }
  if (p.entity_id && rows(ctx, 'change_sets').some((c) => c.status === 'pending' && c.entity === p.entity && c.entity_id === p.entity_id))
    err(409, 'CHANGE_PENDING', 'A change to this record is already waiting for approval. Withdraw it or wait for the checker.')
  const checkers = eligibleCheckers(ctx, p.required_permission, ctx.user.id)
  if (!checkers.length)
    err(409, 'NO_CHECKER', `Maker-checker is on for ${CHANGE_ENTITY_LABEL[p.entity].toLowerCase()}, but no one else can approve it. Give a second person “Check changes” and “${PERMISSION_BY_KEY[p.required_permission]?.label ?? p.required_permission}”, or change the maker-checker settings.`)
  const { id: _i, tenant_id: _t, created_at: _c, updated_at: _u, version: _v, ...rest } = draft
  const cs = insert(ctx, 'change_sets', { ...rest, status: 'pending' } as never) as ChangeSet
  for (const u of checkers) notify(ctx, u.id, 'NTF-04', 'Change to approve', `${ctx.user.name}: ${p.summary}`, '/changes')
  logActivity(ctx, 'change_set', cs.id, 'proposed', `${ctx.user.name} proposed: ${p.summary}`)
  return { pending: true, change: view(ctx, cs) }
}

/** Throws STALE when the record moved on since the proposal. Use inside appliers. */
export function assertBaseVersion(cs: ChangeSet, currentVersion: number | undefined) {
  if (cs.id !== 'cs_direct' && cs.base_version != null && currentVersion != null && currentVersion !== cs.base_version)
    err(409, 'STALE', 'The record changed after this was proposed. Reject it and ask the maker to propose again.')
}

export interface ChangeView extends ChangeSet {
  entity_label: string
  maker_name: string
  maker_hue: number
  maker_title: string
  checker_name: string | null
  required_permission_label: string
  can_check: boolean
  can_withdraw: boolean
  overdue: boolean
  age_days: number
}
function view(ctx: Ctx, c: ChangeSet): ChangeView {
  const pending = c.status === 'pending'
  const age = pending ? Math.max(0, workingDaysBetween(c.created_at.slice(0, 10), ctx.today, calendarFor(ctx)) - 1) : 0
  return {
    ...c,
    entity_label: CHANGE_ENTITY_LABEL[c.entity] ?? c.entity,
    maker_name: userName(ctx, c.maker_id),
    maker_hue: rows(ctx, 'users').find((u) => u.id === c.maker_id)?.avatar_hue ?? 150,
    maker_title: rows(ctx, 'users').find((u) => u.id === c.maker_id)?.title ?? '',
    checker_name: c.checker_id ? userName(ctx, c.checker_id) : null,
    required_permission_label: PERMISSION_BY_KEY[c.required_permission]?.label ?? c.required_permission,
    can_check: pending && !ctx.viewAs && c.maker_id !== ctx.user.id && has(ctx, 'makerchecker.check') && ctx.perms.has(c.required_permission),
    can_withdraw: pending && !ctx.viewAs && c.maker_id === ctx.user.id,
    overdue: pending && age > mcConfig(ctx).sla_days,
    age_days: age,
  }
}
/** The pending change waiting on a record (for "waiting for approval" states on screens). */
export function pendingChangeFor(ctx: Ctx, entity: ChangeEntity, entityId: string | null | undefined): ChangeSet | null {
  if (!entityId) return null
  return rows(ctx, 'change_sets').find((c) => c.status === 'pending' && c.entity === entity && c.entity_id === entityId) ?? null
}
/** Pending change in a light shape for record screens. */
export function pendingBrief(ctx: Ctx, entity: ChangeEntity, entityId: string | null | undefined) {
  const c = pendingChangeFor(ctx, entity, entityId)
  if (!c) return null
  const checkers = eligibleCheckers(ctx, c.required_permission, c.maker_id)
  return { id: c.id, summary: c.summary, maker_id: c.maker_id, maker_name: userName(ctx, c.maker_id), created_at: c.created_at, checker_names: checkers.map((u) => u.name), mine: c.maker_id === ctx.user.id, can_check: !ctx.viewAs && c.maker_id !== ctx.user.id && has(ctx, 'makerchecker.check') && ctx.perms.has(c.required_permission) }
}
export type PendingBrief = NonNullable<ReturnType<typeof pendingBrief>>

/** Permission a checker needs, per entity (the routes pass the same key as `required_permission`). */
export const REQUIRED_PERMISSION_OF: Record<ChangeEntity, Action> = {
  role: 'roles.manage',
  user_access: 'users.manage',
  employee: 'employees.create',
  cost_rate: 'cost_rates.edit',
  workflow: 'workflows.manage',
  org_profile: 'master.edit',
  master_record: 'master.edit',
  shift: 'shifts.manage',
  vendor: 'procurement.manage',
  budget: 'budgets.manage',
  payroll_finalise: 'payroll.finalise',
  settings: 'settings.edit',
  makerchecker_config: 'makerchecker.configure',
}
export const MC_ENTITY_GROUPS: { title: string; entities: ChangeEntity[] }[] = [
  { title: 'Access', entities: ['role', 'user_access', 'employee'] },
  { title: 'Money', entities: ['cost_rate', 'payroll_finalise', 'vendor', 'budget'] },
  { title: 'Configuration', entities: ['workflow', 'org_profile', 'master_record', 'shift', 'settings'] },
]
export interface CheckerRow {
  entity: ChangeEntity
  label: string
  required_permission: string
  required_label: string
  enabled: boolean
  recommended: boolean
  checkers: { id: string; name: string; title: string; hue: number }[]
  /** Eligible checkers other than the viewer (a viewer making a change needs at least one). */
  others: number
}

function canSeeAll(ctx: Ctx) {
  return has(ctx, 'makerchecker.check') || has(ctx, 'audit.view') || has(ctx, 'makerchecker.configure')
}
export function changesToCheck(ctx: Ctx): ChangeView[] {
  return rows(ctx, 'change_sets').filter((c) => c.status === 'pending').map((c) => view(ctx, c)).filter((c) => c.can_check)
}

export function register(r: Router) {
  r.get('/changes', ({ ctx, query }) => {
    const status = String(query.status ?? 'pending')
    const scope = String(query.scope ?? (canSeeAll(ctx) ? 'all' : 'mine'))
    let list = rows(ctx, 'change_sets')
    if (!canSeeAll(ctx) || scope === 'mine') list = list.filter((c) => c.maker_id === ctx.user.id)
    if (status !== 'all') list = list.filter((c) => (status === 'decided' ? c.status !== 'pending' : c.status === status))
    if (query.entity) list = list.filter((c) => c.entity === query.entity)
    let out = list.map((c) => view(ctx, c))
    if (scope === 'to_check') out = out.filter((c) => c.can_check)
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  })
  r.get('/changes/summary', ({ ctx }) => ({
    to_check: changesToCheck(ctx).length,
    mine_pending: rows(ctx, 'change_sets').filter((c) => c.status === 'pending' && c.maker_id === ctx.user.id).length,
    enabled: mcConfig(ctx).enabled,
  }))
  r.get('/changes/:id', ({ ctx, params }) => {
    const c = find(ctx, 'change_sets', params.id, 'Change')
    if (c.maker_id !== ctx.user.id && !canSeeAll(ctx)) err(404, 'NOT_FOUND', 'Change not found.')
    return view(ctx, c)
  })
  r.post('/changes/:id/approve', ({ ctx, params, body }) => {
    const c = find(ctx, 'change_sets', params.id, 'Change')
    if (c.status !== 'pending') err(409, 'INVALID_STATE', `This change is already ${c.status}.`)
    if (c.maker_id === ctx.user.id) err(409, 'MAKER_CANNOT_CHECK', 'You proposed this change, so someone else must approve it.')
    requireAction(ctx, 'makerchecker.check', 'You can’t approve changes.')
    if (!ctx.perms.has(c.required_permission)) err(403, 'FORBIDDEN', `Approving this needs “${PERMISSION_BY_KEY[c.required_permission]?.label ?? c.required_permission}”.`)
    const note = String(body?.note ?? '').trim() || null
    try {
      const res = runApplier(ctx, c)
      update(ctx, 'change_sets', c.id, { status: 'approved', checker_id: ctx.user.id, decided_at: nowISO(), reason: note, applied_at: nowISO(), result_id: res.result_id ?? c.entity_id, error: null } as Partial<ChangeSet>)
    } catch (e) {
      const msg = (e as Error).message
      update(ctx, 'change_sets', c.id, { status: 'failed', checker_id: ctx.user.id, decided_at: nowISO(), error: msg } as Partial<ChangeSet>)
      notify(ctx, c.maker_id, 'NTF-05', 'Change could not be applied', `${c.summary} — ${msg}`, '/changes')
      persist()
      throw e
    }
    notify(ctx, c.maker_id, 'NTF-05', 'Change approved', `${ctx.user.name} approved: ${c.summary}`, '/changes')
    logActivity(ctx, 'change_set', c.id, 'approved', `${ctx.user.name} approved ${userName(ctx, c.maker_id)}’s change: ${c.summary}${note ? ' — ' + note : ''}`)
    return view(ctx, find(ctx, 'change_sets', c.id))
  })
  r.post('/changes/:id/reject', ({ ctx, params, body }) => {
    const c = find(ctx, 'change_sets', params.id, 'Change')
    if (c.status !== 'pending') err(409, 'INVALID_STATE', `This change is already ${c.status}.`)
    if (c.maker_id === ctx.user.id) err(409, 'MAKER_CANNOT_CHECK', 'You proposed this change. Withdraw it instead.')
    requireAction(ctx, 'makerchecker.check', 'You can’t decide changes.')
    if (!ctx.perms.has(c.required_permission)) err(403, 'FORBIDDEN', `Deciding this needs “${PERMISSION_BY_KEY[c.required_permission]?.label ?? c.required_permission}”.`)
    const reason = String(body?.reason ?? '').trim()
    if (reason.length < 10) err(422, 'REASON_REQUIRED', 'Tell the maker why (at least 10 characters).', 'reason')
    const out = update(ctx, 'change_sets', c.id, { status: 'rejected', checker_id: ctx.user.id, decided_at: nowISO(), reason } as Partial<ChangeSet>)
    notify(ctx, c.maker_id, 'NTF-05', 'Change rejected', `${ctx.user.name} rejected: ${c.summary} — ${reason}`, '/changes')
    logActivity(ctx, 'change_set', c.id, 'rejected', `${ctx.user.name} rejected ${userName(ctx, c.maker_id)}’s change: ${c.summary} — ${reason}`)
    return view(ctx, out)
  })
  r.post('/changes/:id/withdraw', ({ ctx, params }) => {
    const c = find(ctx, 'change_sets', params.id, 'Change')
    if (c.maker_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the person who proposed a change can withdraw it.')
    if (c.status !== 'pending') err(409, 'INVALID_STATE', `This change is already ${c.status}.`)
    const out = update(ctx, 'change_sets', c.id, { status: 'withdrawn', decided_at: nowISO() } as Partial<ChangeSet>)
    logActivity(ctx, 'change_set', c.id, 'withdrawn', `${ctx.user.name} withdrew: ${c.summary}`)
    return view(ctx, out)
  })

  // Who could check each kind of change (makerchecker.check + the entity's permission).
  r.get('/maker-checker/checkers', ({ ctx }): CheckerRow[] => {
    if (!has(ctx, 'makerchecker.configure') && !has(ctx, 'makerchecker.check')) err(403, 'FORBIDDEN', 'You can’t see maker-checker settings.')
    const cfg = mcConfig(ctx)
    const all = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin)
    const ents = [...MC_ENTITY_GROUPS.flatMap((g) => g.entities), 'makerchecker_config' as ChangeEntity]
    return ents.map((entity) => {
      const perm = REQUIRED_PERMISSION_OF[entity]
      const holders = all.filter((u) => { const p = permissionsOf(u); return p.includes('makerchecker.check') && p.includes(perm) }).sort((a, b) => a.name.localeCompare(b.name))
      return {
        entity, label: CHANGE_ENTITY_LABEL[entity], required_permission: perm, required_label: PERMISSION_BY_KEY[perm]?.label ?? perm,
        enabled: cfg.enabled && (entity === 'makerchecker_config' || cfg.entities.includes(entity)), recommended: RECOMMENDED_MC_ENTITIES.includes(entity),
        checkers: holders.map((u) => ({ id: u.id, name: u.name, title: u.title, hue: u.avatar_hue })), others: holders.filter((u) => u.id !== ctx.user.id).length,
      }
    })
  })

  // Configuration — itself always maker-checked while maker-checker is on.
  r.get('/maker-checker/config', ({ ctx }) => ({ ...mcConfig(ctx), recommended: RECOMMENDED_MC_ENTITIES, entity_labels: CHANGE_ENTITY_LABEL }))
  r.put('/maker-checker/config', ({ ctx, body }) => {
    requireAction(ctx, 'makerchecker.configure', 'You can’t change maker-checker settings.')
    const cur = mcConfig(ctx)
    const slaIn = Number(body.sla_days ?? cur.sla_days)
    if (!Number.isInteger(slaIn) || slaIn < 1 || slaIn > 10) err(422, 'VALIDATION', 'The checking deadline must be 1 to 10 working days.', 'sla_days')
    const next: MakerCheckerConfig = {
      enabled: !!body.enabled,
      entities: ([...new Set((body.entities ?? []) as ChangeEntity[])]).filter((e) => e in CHANGE_ENTITY_LABEL),
      sla_days: Math.max(1, Math.min(10, Number(body.sla_days ?? cur.sla_days) || 2)),
    }
    if (next.enabled && !eligibleCheckers(ctx, 'makerchecker.check', ctx.user.id).length)
      err(409, 'NO_CHECKER', 'Turn this on only when at least one other person has “Check changes”. Otherwise no one could approve your changes.')
    const parts: string[] = []
    if (cur.enabled !== next.enabled) parts.push(next.enabled ? 'turn maker-checker on' : 'turn maker-checker off')
    const added = next.entities.filter((e) => !cur.entities.includes(e)).map((e) => CHANGE_ENTITY_LABEL[e])
    const removed = cur.entities.filter((e) => !next.entities.includes(e)).map((e) => CHANGE_ENTITY_LABEL[e])
    if (added.length) parts.push('check ' + added.join(', '))
    if (removed.length) parts.push('stop checking ' + removed.join(', '))
    if (cur.sla_days !== next.sla_days) parts.push(`SLA ${cur.sla_days} → ${next.sla_days} days`)
    if (!parts.length) err(422, 'NO_CHANGE', 'Nothing changed.')
    if (next.enabled) {
      const lonely = next.entities.filter((e) => !eligibleCheckers(ctx, REQUIRED_PERMISSION_OF[e], ctx.user.id).length)
      if (lonely.length) warn(ctx, 'NO_CHECKER_FOR', `Nobody else can check ${lonely.map((e) => CHANGE_ENTITY_LABEL[e].toLowerCase()).join(', ')} yet — those changes will be refused until someone has the permission.`)
    }
    return propose(ctx, {
      entity: 'makerchecker_config', entity_id: ctx.tenant.id, action: 'update', summary: 'Maker-checker: ' + parts.join('; '),
      before: { ...cur }, after: { ...next }, payload: { config: next }, required_permission: 'makerchecker.configure',
    })
  })
}

registerApplier('makerchecker_config', (ctx, cs) => {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)!
  t.maker_checker = cs.payload.config as MakerCheckerConfig
  t.version++
  persist()
  logActivity(ctx, 'settings', t.id, 'maker_checker', `Maker-checker settings updated${cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''}`)
  return { result: t.maker_checker, result_id: t.id }
})
