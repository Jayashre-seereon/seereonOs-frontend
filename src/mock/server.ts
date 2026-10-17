// In-browser mock of the SeereonOS REST API (/api/v1).
// It behaves like the FastAPI contract: tenant isolation (cross-tenant = 404), role checks (403),
// View-as is read-only (403 on writes), read-only tenants (402), If-Match versions (409 STALE),
// rule codes from the validation catalogue, and non-blocking `warnings[]`.
import type { RequestOptions, ApiEnvelope } from '@/api/http'
import { ApiError } from '@/api/http'
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import type * as A from '@/types/access'
import type * as V7 from '@/types/v7'
import { type Action } from '@/domain/permissions'
import { effectivePermissions } from '@/domain/permissionCatalog'
import type { CalendarCtx } from '@/domain/calendar'
import { todayISO } from '@/domain/calendar'
import { storage } from '@/lib/storage'
import { findFileProblem } from '@/domain/fileSafety'
import { DEFAULT_SETTINGS } from './seed'

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */
export interface DB {
  tenants: E.Tenant[]
  users: E.User[]
  passwords: { user_id: string; password: string }[]
  login_attempts: { email: string; at: number }[]
  sessions: { token: string; user_id: string; tenant_id: string; created_at: string }[]
  invites: E.Invite[]
  reset_tokens: { token: string; user_id: string; expires_at: number; used: boolean }[]
  subscriptions: E.Subscription[]
  billing_invoices: E.BillingInvoice[]
  holidays: E.Holiday[]
  delegations: E.Delegation[]
  projects: E.Project[]
  project_status_history: E.ProjectStatusHistory[]
  milestones: E.Milestone[]
  tasks: E.Task[]
  task_dependencies: E.TaskDependency[]
  comments: E.Comment[]
  notifications: E.Notification[]
  timesheet_weeks: E.TimesheetWeek[]
  timesheet_entries: E.TimesheetEntry[]
  leave: E.Leave[]
  daily_updates: E.DailyUpdate[]
  cost_rates: E.CostRate[]
  allocations: E.Allocation[]
  files: E.FileRef[]
  invoices: E.Invoice[]
  payments: E.Payment[]
  payroll_runs: E.PayrollRun[]
  payroll_lines: E.PayrollLine[]
  ledger_entries: E.LedgerEntry[]
  deals: E.Deal[]
  deal_activities: E.DealActivity[]
  deal_stage_history: E.DealStageHistory[]
  change_requests: E.ChangeRequest[]
  openings: E.Opening[]
  ops_items: E.OpsItem[]
  activity_log: E.ActivityLog[]
  saved_reports: E.SavedReport[]
  // v3 business processes
  task_reviews: B.TaskReview[]
  documents: B.DocumentRec[]
  document_versions: B.DocumentVersion[]
  document_acks: B.DocumentAck[]
  document_views: B.DocumentView[]
  leave_requests: B.LeaveRequest[]
  leave_policies: B.LeavePolicy[]
  appraisal_cycles: B.AppraisalCycle[]
  appraisals: B.Appraisal[]
  goals: B.Goal[]
  feedback: B.Feedback[]
  candidates: B.Candidate[]
  interviews: B.Interview[]
  lifecycle_checklists: B.LifecycleChecklist[]
  assets: B.Asset[]
  expense_claims: B.ExpenseClaim[]
  vendors: B.Vendor[]
  purchase_orders: B.PurchaseOrder[]
  vendor_bills: B.VendorBill[]
  budgets: B.Budget[]
  clients: B.Client[]
  contracts: B.Contract[]
  revenue_leakage: B.RevenueLeakage[]
  objectives: B.Objective[]
  key_results: B.KeyResult[]
  data_exports: E.DataExport[]
  number_sequences: { tenant_id: string; scope: string; next_value: number }[]
  admin_audit: { id: string; actor_id: string; tenant_id: string; action: string; reason: string; at: string }[]
  // v4 access, master data, workflows, maker-checker, email
  roles: A.RoleDef[]
  change_sets: A.ChangeSet[]
  approval_workflows: A.ApprovalWorkflow[]
  locations: A.Location[]
  departments: A.Department[]
  designations: A.Designation[]
  grades: A.Grade[]
  cost_centres: A.CostCentre[]
  shifts: A.Shift[]
  email_templates: A.EmailTemplate[]
  email_outbox: A.EmailMessage[]
  // v7
  cost_estimates: V7.CostEstimate[]
  wf_templates: V7.WfTemplate[]
  wf_instances: V7.WfInstance[]
  doc_templates: V7.DocTemplate[]
  issued_documents: V7.IssuedDocument[]
  employee_documents: V7.EmployeeDocument[]
  // B3: short-lived per-user request state kept in the DB (not in process memory) so every API instance sees it
  pending_tokens: PendingToken[]
}
/** Per-user state kept in the DB (not in process memory) so it works across API instances and restarts:
 *  - two_factor_setup  a started 2FA setup (payload {secret: sealed}) until verified — 30 min
 *  - two_factor        the user's active second factor (payload TwoFactorPayload) — no expiry (far-future date)
 *  - mfa_login         a sign-in waiting for its second step (id = SHA-256 of the mfa_token; payload {attempts}) — 5 min
 *  - wbs_import        a WBS import preview (until committed) — 15 min */
export interface PendingToken {
  id: string
  tenant_id: string
  created_at: string
  updated_at: string
  created_by?: string | null
  version: number
  kind: 'two_factor_setup' | 'two_factor' | 'mfa_login' | 'wbs_import'
  user_id: string
  ref_id: string | null
  payload: unknown
  expires_at: string
}
export type TableName = { [K in keyof DB]: DB[K] extends { tenant_id: string }[] ? K : never }[keyof DB]
export type Row<K extends keyof DB> = DB[K][number]

const DB_KEY = 'seereonos.mockdb.v11'
let db: DB | null = null

/* ------------------------------------------------------------------ */
/* Pluggable store                                                     */
/* The browser demo keeps the whole DB in memory (localStorage-backed). */
/* The API server installs a request-scoped store (Unit of Work over     */
/* PostgreSQL) via setStore(); every helper below then delegates to it. */
/* ------------------------------------------------------------------ */
export interface Store {
  /** The DB view of the current request (tables may load lazily). */
  getDb(): DB
  /** Write intent: something changed and must be saved. */
  persist(): void
  /** Id generator (server: cryptographically random). */
  uid?(prefix: string): string
  /** POST /demo/reset — restore the demo data. */
  reset?(): void | Promise<void>
}
let store: Store | null = null
export function setStore(s: Store | null) {
  store = s
}
export function getStore(): Store | null {
  return store
}

export function getDb(): DB {
  if (store) return store.getDb()
  if (!db) {
    const saved = storage.get<DB | null>(DB_KEY, null)
    if (saved && saved.tenants?.length) {
      db = saved
      db.pending_tokens ??= [] // demo data saved before the table existed
    }
    else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      db = seedFn()
      persistNow()
    }
  }
  return db!
}
let seedFn: () => DB = () => {
  throw new Error('seed not registered')
}
export function registerSeed(fn: () => DB) {
  seedFn = fn
}
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistNow() {
  if (db) storage.set(DB_KEY, db)
}
export function persist() {
  if (store) return store.persist()
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(persistNow, 120)
}
export async function resetDb() {
  if (store) {
    if (!store.reset) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'Demo reset is not available.')
    await store.reset()
    return
  }
  db = seedFn()
  persistNow()
}

/* ------------------------------------------------------------------ */
/* Helpers for route modules                                           */
/* ------------------------------------------------------------------ */
let seq = 0
export function uid(prefix = ''): string {
  if (store?.uid) return store.uid(prefix)
  seq = (seq + 1) % 1e6
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) + seq.toString(36)
}
/**
 * The request clock: every timestamp a request writes is the instant the request started (like PostgreSQL `now()` in
 * a transaction), so rows created by one request tie on created_at / at and keep their insertion order in every
 * newest-first list — deterministically, however long the handler runs. Outside a request: the wall clock.
 */
let requestNow: string | null = null
export const nowISO = () => requestNow ?? new Date().toISOString()

export function err(status: number, code: string, message: string, field?: string): never {
  throw new ApiError(status, code, message, field)
}

export interface Ctx {
  user: E.User
  tenant: E.Tenant
  role: E.Role // effective persona (View as applied) — use for home/default views, NOT for capability checks
  realRole: E.Role
  viewAs: string | null // RoleDef.key being previewed
  roleKey: string // effective RoleDef.key
  perms: Set<string> // effective permission keys — the source of truth for every capability check
  grants: E.Grant[] // deprecated (v3); kept empty-compatible
  isSuper: boolean
  today: string
  warnings: { code: string; message: string }[]
}

export function warn(ctx: Ctx, code: string, message: string) {
  ctx.warnings.push({ code, message })
}

/** Tenant-scoped rows of a table (Row-Level Security equivalent). */
export function rows<K extends TableName>(ctx: Ctx, table: K): Row<K>[] {
  return (getDb()[table] as Row<K>[]).filter((r) => (r as { tenant_id: string }).tenant_id === ctx.tenant.id)
}

/** Fetch by id inside the tenant; anything else is a 404 (never reveal other tenants). */
export function find<K extends TableName>(ctx: Ctx, table: K, id: string, label = 'Record'): Row<K> {
  const r = (getDb()[table] as Row<K>[]).find((x) => (x as { id: string }).id === id)
  if (!r || (r as { tenant_id: string }).tenant_id !== ctx.tenant.id) err(404, 'NOT_FOUND', `${label} not found.`)
  return r
}

export function insert<K extends TableName>(ctx: Ctx | null, table: K, data: Omit<Row<K>, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version'> & Partial<Pick<Row<K> & E.Base, 'id' | 'tenant_id'>>): Row<K> {
  const t = nowISO()
  const row = {
    id: uid(),
    tenant_id: ctx?.tenant.id,
    created_at: t,
    updated_at: t,
    created_by: ctx?.user.id ?? null,
    version: 1,
    ...data,
  } as unknown as Row<K>
  ;(getDb()[table] as Row<K>[]).push(row)
  persist()
  return row
}

/** Optimistic concurrency: when If-Match is sent it must equal the stored version. */
/** Columns no request can set through update(): identity, tenancy and audit/concurrency bookkeeping (mass assignment). */
const PROTECTED_COLUMNS = ['id', 'tenant_id', 'created_at', 'created_by', 'updated_at', 'version'] as const
export function update<K extends TableName>(ctx: Ctx, table: K, id: string, patch: Partial<Row<K>>, ifMatch?: number): Row<K> {
  const r = find(ctx, table, id) as Row<K> & E.Base
  if (ifMatch !== undefined && ifMatch !== r.version) err(409, 'STALE', 'Someone else changed this record. Reload to see the latest version.')
  const safe = { ...patch } as Record<string, unknown>
  for (const k of PROTECTED_COLUMNS) delete safe[k]
  Object.assign(r, safe, { updated_at: nowISO(), version: r.version + 1 })
  persist()
  return r
}

export function remove<K extends TableName>(ctx: Ctx, table: K, id: string, ifMatch?: number) {
  const r = find(ctx, table, id) as Row<K> & E.Base
  if (ifMatch !== undefined && ifMatch !== r.version) err(409, 'STALE', 'Someone else changed this record. Reload to see the latest version.')
  const arr = getDb()[table] as Row<K>[]
  arr.splice(arr.indexOf(r as Row<K>), 1)
  persist()
}

export function removeWhere<K extends TableName>(ctx: Ctx, table: K, pred: (r: Row<K>) => boolean) {
  const d = getDb()
  ;(d as unknown as Record<string, unknown[]>)[table] = (d[table] as Row<K>[]).filter((r) => !((r as { tenant_id: string }).tenant_id === ctx.tenant.id && pred(r)))
  persist()
}

/** Does the current (effective) user hold this permission? */
export function has(ctx: Ctx, action: Action): boolean {
  return ctx.perms.has(action)
}
export function hasAny(ctx: Ctx, ...actions: Action[]): boolean {
  return actions.some((a) => ctx.perms.has(a))
}
export function requireAction(ctx: Ctx, action: Action, message = 'You do not have access to this.') {
  if (!ctx.perms.has(action)) err(403, 'FORBIDDEN', message)
}
export function requireAny(ctx: Ctx, actions: Action[], message = 'You do not have access to this.') {
  if (!actions.some((a) => ctx.perms.has(a))) err(403, 'FORBIDDEN', message)
}

/** Role definition of a tenant by key (null when missing). */
export function roleDef(tenantId: string, key: string | null | undefined): A.RoleDef | null {
  if (!key) return null
  return getDb().roles.find((r) => r.tenant_id === tenantId && r.key === key) ?? null
}
/** Effective permissions of a stored user (role ∪ extra − revoked). Deactivated users have none. */
export function permissionsOf(u: E.User): string[] {
  if (u.status === 'deactivated') return []
  const rd = roleDef(u.tenant_id, u.role_key)
  return effectivePermissions(rd && rd.active ? rd.permissions : [], u.extra_permissions ?? [], u.revoked_permissions ?? [])
}
/** Users of the tenant who currently hold a permission (active only). */
export function usersWith(ctx: Ctx, action: Action): E.User[] {
  return rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && permissionsOf(u).includes(action))
}
/** User as sent to the browser: stored fields + computed permissions and role name. */
export function withAccess(u: E.User): E.User {
  const rd = roleDef(u.tenant_id, u.role_key)
  return { ...u, permissions: permissionsOf(u), role_name: rd?.name ?? u.title }
}
export function requireRole(ctx: Ctx, roles: E.Role[], message = 'You do not have access to this.') {
  if (!roles.includes(ctx.role)) err(403, 'FORBIDDEN', message)
}
/** Called by every write handler (the router does it automatically for non-GET). */
export function assertWritable(ctx: Ctx, path: string) {
  if (ctx.viewAs) err(403, 'VIEW_AS_READ_ONLY', 'You are viewing as another role. Switch back to make changes.')
  if ((ctx.tenant.status === 'read_only' || ctx.tenant.status === 'suspended') && !path.startsWith('/billing') && !path.startsWith('/auth'))
    err(402, 'TENANT_READ_ONLY', 'Your plan has lapsed. The workspace is read-only until billing is renewed.')
}

export function paginate<T>(items: T[], query: Record<string, unknown> = {}) {
  const page = Math.max(1, Number(query.page ?? 1))
  const size = Math.min(200, Math.max(1, Number(query.page_size ?? 50)))
  return { items: items.slice((page - 1) * size, page * size), total: items.length, page, page_size: size }
}

export function nextNumber(ctx: Ctx, scope: string, start = 1): number {
  const d = getDb()
  let s = d.number_sequences.find((x) => x.tenant_id === ctx.tenant.id && x.scope === scope)
  if (!s) {
    s = { tenant_id: ctx.tenant.id, scope, next_value: start }
    d.number_sequences.push(s)
  }
  const v = s.next_value
  s.next_value++
  persist()
  return v
}

export function notify(ctx: Ctx, userId: string, type: E.NotificationType, title: string, body: string, link: string | null = null) {
  insert({ ...ctx, tenant: { ...ctx.tenant } } as Ctx, 'notifications', { user_id: userId, type, title, body, link, read_at: null } as never)
}

export function logActivity(ctx: Ctx, entity: string, entityId: string, action: string, summary: string) {
  insert(ctx, 'activity_log', { entity, entity_id: entityId, action, summary, actor_id: ctx.user.id, at: nowISO() } as never)
}

export function calendarFor(ctx: Ctx, userId?: string): CalendarCtx {
  const holidays = rows(ctx, 'holidays')
  let leaveDates: Set<string> | undefined
  if (userId) leaveDates = new Set(rows(ctx, 'leave').filter((l) => l.user_id === userId && l.portion === 'full').map((l) => l.date))
  return { settings: ctx.tenant.settings, holidays, leaveDates }
}

export function userName(ctx: Ctx, id: string | null | undefined): string {
  if (!id) return '—'
  return getDb().users.find((u) => u.id === id && u.tenant_id === ctx.tenant.id)?.name ?? '—'
}

/** Strip salary / margin fields for viewers without the grant. */
export function canSeeSalaries(ctx: Ctx) {
  return ctx.perms.has('cost_rates.view')
}
export function canSeeMargins(ctx: Ctx) {
  return ctx.perms.has('margins.view')
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export interface Req {
  params: Record<string, string>
  query: Record<string, unknown>
  body: any // eslint-disable-line @typescript-eslint/no-explicit-any
  ifMatch?: number
  ctx: Ctx
  headers: Record<string, string>
}
export type Handler = (req: Req) => unknown
export interface RouteOpts {
  public?: boolean // no session needed
  superAdmin?: boolean
  allowViewAsWrite?: boolean
}
export interface Route {
  method: string
  pattern: string
  parts: string[]
  handler: Handler
  opts: RouteOpts
  /** route module that registered it (OpenAPI tag) */
  module: string
  /** registered by the API server in place of the shared handler */
  override?: boolean
}
const routes: Route[] = []
export const router = {
  /** set by registerAll() while a route module registers (used as the OpenAPI tag) */
  module: 'core',
  add(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}) {
    routes.push({ method, pattern, parts: pattern.split('/').filter(Boolean), handler, opts, module: this.module })
  },
  /** Server-side replacement of a shared route (matched first). Same contract, different storage. */
  override(method: string, pattern: string, handler: Handler, opts: RouteOpts = {}, module = 'auth') {
    routes.unshift({ method, pattern, parts: pattern.split('/').filter(Boolean), handler, opts, module, override: true })
  },
  get(p: string, h: Handler, o?: RouteOpts) {
    this.add('GET', p, h, o)
  },
  post(p: string, h: Handler, o?: RouteOpts) {
    this.add('POST', p, h, o)
  },
  patch(p: string, h: Handler, o?: RouteOpts) {
    this.add('PATCH', p, h, o)
  },
  put(p: string, h: Handler, o?: RouteOpts) {
    this.add('PUT', p, h, o)
  },
  del(p: string, h: Handler, o?: RouteOpts) {
    this.add('DELETE', p, h, o)
  },
}
export type Router = typeof router

/** Every registered route (overrides first), for OpenAPI generation and checks. */
export function routeRegistry(): readonly Route[] {
  return routes
}

export function matchRoute(method: string, path: string) {
  const parts = path.split('?')[0].split('/').filter(Boolean)
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < parts.length; i++) {
      const p = r.parts[i]
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i])
      else if (p !== parts[i]) {
        ok = false
        break
      }
    }
    if (ok) return { route: r, params }
  }
  return null
}

const ANON_USER = { id: 'anon', role: 'employee', grants: [] } as unknown as E.User
const ANON_TENANT = { id: '__none__', settings: {}, status: 'active' } as unknown as E.Tenant

function sessionCtx(headers: Record<string, string>): Ctx | null {
  const d = getDb()
  const token = headers['Authorization']?.replace('Bearer ', '')
  if (!token) return null
  const s = d.sessions.find((x) => x.token === token)
  if (!s) return null
  const user = d.users.find((u) => u.id === s.user_id)
  if (!user || user.status === 'deactivated') return null
  return buildCtx(user, s.tenant_id, headers)
}

/** Ctx of a signed-in user (View-as applied from the X-View-As header). Shared by the mock and the API server. */
export function buildCtx(user: E.User, tenantId: string, headers: Record<string, string>): Ctx {
  const d = getDb()
  // a user without a workspace row (the platform super admin, tenant 'platform') reads the DEFAULT workspace settings:
  // with `{}` every calendar / settings read on a tenant route threw (500) — e.g. weekly offs in /holidays, /daily
  const tenant = d.tenants.find((t) => t.id === tenantId) ?? ({ ...ANON_TENANT, id: tenantId, settings: { ...DEFAULT_SETTINGS } } as E.Tenant)
  const userPerms = permissionsOf(user)
  const requested = headers['X-View-As'] || null
  const viewDef = requested && userPerms.includes('view_as') ? roleDef(tenant.id, requested) : null
  const viewPerms = viewDef ? effectivePermissions(viewDef.permissions) : null
  return {
    user,
    tenant,
    realRole: user.role,
    role: viewDef ? viewDef.persona : user.role,
    viewAs: viewDef ? viewDef.key : null,
    roleKey: viewDef ? viewDef.key : user.role_key,
    perms: new Set(viewPerms ?? userPerms),
    grants: [],
    isSuper: !!user.is_super_admin,
    today: todayISO(),
    warnings: [],
  }
}

const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let loaded: Promise<void> | null = null
export async function ensureRoutes() {
  if (!loaded) loaded = import('./routes').then((m) => m.registerAll(router))
  return loaded
}

/** Browser demo entry point: simulated network latency + dispatch with in-memory sessions. */
export async function handle(method: string, path: string, opts: RequestOptions, headers: Record<string, string>): Promise<ApiEnvelope<unknown>> {
  await ensureRoutes()
  await sleep(method === 'GET' ? 90 + Math.random() * 160 : 160 + Math.random() * 220)
  return dispatch(method, path, opts, headers)
}

export type CtxResolver = (headers: Record<string, string>) => Ctx | null | Promise<Ctx | null>

/**
 * The router core: route match → session → platform/role/View-as/read-only/password-change checks → handler → envelope.
 * `resolveCtx` is replaceable (the API server resolves sessions in PostgreSQL). Routes must be loaded (ensureRoutes()).
 */
export async function dispatch(method: string, path: string, opts: RequestOptions, headers: Record<string, string>, resolveCtx: CtxResolver = sessionCtx): Promise<ApiEnvelope<unknown>> {
  const m = matchRoute(method, path)
  if (!m) throw new ApiError(404, 'ROUTE_NOT_FOUND', `No route for ${method} ${path}`)
  let ctx = await resolveCtx(headers)
  if (!ctx) {
    if (!m.route.opts.public) throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again.')
    ctx = { user: ANON_USER, tenant: ANON_TENANT, role: 'employee', realRole: 'employee', viewAs: null, roleKey: 'anon', perms: new Set(), grants: [], isSuper: false, today: todayISO(), warnings: [] }
  }
  if (m.route.opts.superAdmin && !ctx.isSuper) throw new ApiError(403, 'FORBIDDEN', 'Platform administrators only.')
  if (method !== 'GET' && !m.route.opts.public && !m.route.opts.allowViewAsWrite && !ctx.isSuper) assertWritable(ctx, path)
  if (method !== 'GET' && ctx.user.must_change_password && !m.route.opts.public && !['/me/password', '/auth/logout', '/me/prefs'].includes(path.split('?')[0]))
    throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Set a new password before you continue.')
  // every uploaded file (data: URL anywhere in the body) is checked: size, active content, type vs contents
  if (method !== 'GET' && opts.body && typeof opts.body === 'object') {
    const bad = findFileProblem(opts.body)
    if (bad) throw new ApiError(422, 'FILE_REJECTED', bad.message, bad.field)
  }
  const ifMatch = headers['If-Match'] !== undefined ? Number(headers['If-Match']) : undefined
  // the handlers are synchronous (only /demo/reset awaits), so the request clock never leaks into another request
  requestNow = new Date().toISOString()
  let pending: unknown
  try {
    pending = m.route.handler({ params: m.params, query: opts.query ?? {}, body: clone(opts.body) ?? {}, ifMatch, ctx, headers })
  } finally {
    requestNow = null
  }
  const data = await pending
  return { data: clone(data), warnings: ctx.warnings }
}

// Convenience for type-only consumers
export type { E }
export { getDb as db }
