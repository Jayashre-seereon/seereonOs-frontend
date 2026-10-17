// v4 approval workflow engine. A tenant configures, per business process, an ordered list of steps
// (who approves, from which amount, SLA, escalation). Routes call `startApproval` on submit and
// `advanceApproval` on every approval; the record keeps `approver_id` = the current step's approver
// plus the frozen chain (see "Stored fields" below), so editing a workflow never re-routes requests
// that are already waiting. Defaults reproduce the v3 behaviour exactly, so a tenant that never opens
// the configurator sees no change.
//
// Stored fields (kept loosely on leave_requests, expense_claims, purchase_orders, vendor_bills,
// timesheet_weeks and tasks — not part of the shared entity types):
//   wf_process   WorkflowProcess
//   wf_chain     StoredStep[]   the resolved approvers at submission time
//   wf_step      number         index into wf_chain of the step that is waiting
//   wf_step_at   ISO datetime   when the current step started (SLA + escalation clock)
//   wf_approver_id (tasks only) current reviewer while in review
import type { ApprovalWorkflow, ApproverType, WorkflowProcess, WorkflowStep } from '@/types/access'
import type * as E from '@/types/entities'
import { addWorkingDays } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { calendarFor, err, find, hasAny, logActivity, notify, nowISO, persist, requireAction, rows, update, userName, type Ctx, type DB, type Router } from './server'
import { propose, registerApplier, assertBaseVersion, pendingChangeFor } from './makerChecker'

export const PROCESS_LABEL: Record<WorkflowProcess, string> = {
  leave: 'Leave requests',
  expense: 'Expense claims',
  purchase_order: 'Purchase orders',
  vendor_bill: 'Vendor bills',
  timesheet: 'Weekly timesheets',
  task_review: 'Task completion review',
}
export const APPROVER_LABEL: Record<ApproverType, string> = {
  reports_to: 'Reporting manager',
  skip_level: 'Manager’s manager',
  role: 'Anyone with a role',
  user: 'A specific person',
  project_pm: 'Project manager of the project',
  project_pm_or_manager: 'Project manager, else reporting manager',
  department_head: 'Head of the requester’s department',
  task_reviewer: 'Task reviewer (set on the task)',
}
/** Processes whose requests carry an amount (steps may apply only above a threshold). */
export const AMOUNT_PROCESSES: WorkflowProcess[] = ['expense', 'purchase_order', 'vendor_bill']
/** Processes whose requests carry a project (project-manager approvers make sense). */
export const PROJECT_PROCESSES: WorkflowProcess[] = ['expense', 'purchase_order', 'task_review']
export const PROCESS_ORDER: WorkflowProcess[] = ['leave', 'expense', 'purchase_order', 'vendor_bill', 'timesheet', 'task_review']

const step = (id: string, name: string, approver: ApproverType, extra: Partial<WorkflowStep> = {}): WorkflowStep => ({ id, name, approver, sla_days: 2, ...extra })

/** v3-equivalent defaults (amounts in paise). */
export const DEFAULT_WORKFLOWS: Omit<ApprovalWorkflow, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version'>[] = [
  { process: 'leave', name: 'Leave approval', description: 'The reporting manager (or their delegate) decides leave.', active: true, require_reason_on_reject: true, notify_requester: true, steps: [step('s1', 'Manager approval', 'reports_to')] },
  {
    process: 'expense', name: 'Expense claim approval', description: 'Project manager (or reporting manager) approves; claims above ₹25,000 also need the CEO.', active: true, require_reason_on_reject: true, notify_requester: true,
    steps: [step('s1', 'Manager / PM approval', 'project_pm_or_manager'), step('s2', 'CEO approval above ₹25,000', 'role', { role_id: 'ceo', min_amount_paise: 2_500_000 })],
  },
  { process: 'purchase_order', name: 'Purchase order approval', description: 'Every purchase order is approved by the CEO before it is issued.', active: true, require_reason_on_reject: true, notify_requester: true, steps: [step('s1', 'CEO approval', 'role', { role_id: 'ceo' })] },
  { process: 'vendor_bill', name: 'Vendor bill approval', description: 'The CEO approves vendor bills for payment.', active: true, require_reason_on_reject: true, notify_requester: false, steps: [step('s1', 'CEO approval', 'role', { role_id: 'ceo' })] },
  { process: 'timesheet', name: 'Timesheet approval', description: 'Weekly timesheets are approved by the reporting manager.', active: true, require_reason_on_reject: true, notify_requester: true, steps: [step('s1', 'Manager approval', 'reports_to', { sla_days: 2 })] },
  { process: 'task_review', name: 'Task review', description: 'Submitted tasks are reviewed by the task reviewer (PM, or the assigning manager).', active: true, require_reason_on_reject: true, notify_requester: true, steps: [step('s1', 'Reviewer approval', 'task_reviewer', { sla_days: 2 })] },
]

export interface ChainInput {
  requester_id: string
  amount_paise?: number | null
  project_id?: string | null
  reviewer_id?: string | null
}
export interface ResolvedStep {
  step: WorkflowStep
  index: number
  approver_id: string
}

export function workflowFor(ctx: Ctx, process: WorkflowProcess): ApprovalWorkflow | null {
  return rows(ctx, 'approval_workflows').find((w) => w.process === process && w.active) ?? null
}

const activeUser = (ctx: Ctx, id: string | null | undefined): E.User | null => {
  if (!id) return null
  const u = rows(ctx, 'users').find((x) => x.id === id)
  return u && u.status === 'active' ? u : null
}
/** First active person holding a role (stable: earliest joiner). */
export function holderOfRole(ctx: Ctx, roleKey: string | null | undefined, exclude?: string): string | null {
  if (!roleKey) return null
  const c = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && u.role_key === roleKey && u.id !== exclude).sort((a, b) => a.joined_on.localeCompare(b.joined_on))
  return c[0]?.id ?? null
}
/** Final fallback approver: the CEO, else anyone on the leadership persona. */
export function topApprover(ctx: Ctx, exclude?: string): string | null {
  return holderOfRole(ctx, 'ceo', exclude) ?? rows(ctx, 'users').find((u) => u.status === 'active' && !u.is_super_admin && u.role === 'admin' && u.id !== exclude)?.id ?? null
}

export function resolveApprover(ctx: Ctx, a: { approver: ApproverType; role_id?: string | null; user_id?: string | null }, input: ChainInput): string | null {
  const req = rows(ctx, 'users').find((u) => u.id === input.requester_id)
  const pm = () => (input.project_id ? rows(ctx, 'projects').find((p) => p.id === input.project_id)?.pm_id ?? null : null)
  switch (a.approver) {
    case 'reports_to':
      return activeUser(ctx, req?.reports_to_id)?.id ?? null
    case 'skip_level': {
      const m = rows(ctx, 'users').find((u) => u.id === req?.reports_to_id)
      return activeUser(ctx, m?.reports_to_id)?.id ?? null
    }
    case 'role':
      return holderOfRole(ctx, a.role_id, input.requester_id) ?? holderOfRole(ctx, a.role_id)
    case 'user':
      return activeUser(ctx, a.user_id)?.id ?? null
    case 'project_pm':
      return activeUser(ctx, pm())?.id ?? null
    case 'project_pm_or_manager': {
      const p = activeUser(ctx, pm())
      if (p && p.id !== input.requester_id) return p.id
      return activeUser(ctx, req?.reports_to_id)?.id ?? null
    }
    case 'department_head': {
      const dep = req?.department_id ? rows(ctx, 'departments').find((d) => d.id === req.department_id) : null
      return activeUser(ctx, dep?.head_id)?.id ?? activeUser(ctx, req?.reports_to_id)?.id ?? null
    }
    case 'task_reviewer':
      return activeUser(ctx, input.reviewer_id)?.id ?? null
  }
}

/** Does a step apply to this amount? (threshold = strictly above, matching v3 "above ₹25,000") */
const applies = (s: WorkflowStep, amount: number | null | undefined) => !s.min_amount_paise || (amount ?? 0) > s.min_amount_paise

/**
 * Concrete approver chain for a request. Steps below their amount threshold are skipped; a step that
 * resolves to the requester is skipped (no self-approval) unless allow_self; consecutive duplicates
 * collapse; an empty chain falls back to the top approver so nothing is ever stranded.
 */
export function resolveChain(ctx: Ctx, process: WorkflowProcess, input: ChainInput, stepsOverride?: WorkflowStep[]): ResolvedStep[] {
  const wf = stepsOverride ? null : workflowFor(ctx, process)
  const steps = stepsOverride ?? wf?.steps ?? (DEFAULT_WORKFLOWS.find((w) => w.process === process)?.steps ?? [])
  const out: ResolvedStep[] = []
  steps.forEach((s, index) => {
    if (!applies(s, input.amount_paise)) return
    let id = resolveApprover(ctx, s, input)
    if ((!id || (id === input.requester_id && !s.allow_self)) && s.escalate_to) {
      const alt = resolveApprover(ctx, s.escalate_to, input)
      if (alt && alt !== input.requester_id) id = alt
    }
    if (!id) return
    if (id === input.requester_id && !s.allow_self) return
    if (out.length && out[out.length - 1].approver_id === id) return
    out.push({ step: s, index, approver_id: id })
  })
  if (!out.length) {
    const top = topApprover(ctx, input.requester_id) ?? topApprover(ctx)
    if (top) out.push({ step: FALLBACK_STEP, index: -1, approver_id: top })
  }
  return out
}
const FALLBACK_STEP: WorkflowStep = { id: 'fallback', name: 'Final approval', approver: 'role', role_id: 'ceo', sla_days: 2 }
/** The step after `currentApproverId` in the chain (null when the current one is the last). */
export function nextInChain(chain: ResolvedStep[], currentApproverId: string | null): ResolvedStep | null {
  const i = chain.findIndex((c) => c.approver_id === currentApproverId)
  return i >= 0 && i + 1 < chain.length ? chain[i + 1] : null
}

/** Seed the default workflows for a tenant (idempotent). */
export function provisionWorkflows(d: DB, tenantId: string, base: () => E.Base) {
  for (const w of DEFAULT_WORKFLOWS) if (!d.approval_workflows.some((x) => x.tenant_id === tenantId && x.process === w.process)) d.approval_workflows.push({ ...base(), ...JSON.parse(JSON.stringify(w)) })
}

/* ================================================================== */
/* Approval state on records                                            */
/* ================================================================== */
export interface StoredStep {
  step_id: string
  index: number // index in the workflow definition (-1 = fallback / legacy rule)
  name: string
  approver_id: string
  sla_days: number
  escalate_to_id: string | null
  decided_by?: string | null
  decided_at?: string | null
  escalated_from?: string | null
}
export interface WfState {
  wf_process: WorkflowProcess
  wf_chain: StoredStep[]
  wf_step: number
  wf_step_at: string
}
type WithWf = Partial<WfState> & { approver_id?: string | null; wf_approver_id?: string | null }

function storeChain(ctx: Ctx, chain: ResolvedStep[], input: ChainInput): StoredStep[] {
  return chain.map((c) => {
    const esc = c.step.escalate_to ? resolveApprover(ctx, c.step.escalate_to, input) : null
    return {
      step_id: c.step.id, index: c.index, name: c.step.name, approver_id: c.approver_id, sla_days: c.step.sla_days || 2,
      escalate_to_id: esc && esc !== c.approver_id && esc !== input.requester_id ? esc : null,
    }
  })
}

/**
 * Resolve the chain for a new submission. When the configured workflow can't name anyone (only the
 * generic fallback would apply) the area's v3 rule (`legacy`) decides — `null` there means
 * "no approver needed" (e.g. the top person's own timesheet or leave is auto-approved).
 */
export function startApproval(ctx: Ctx, process: WorkflowProcess, input: ChainInput, legacy: string | null): WfState & { approver_id: string | null } {
  let chain = resolveChain(ctx, process, input)
  if (chain.length === 1 && chain[0].index === -1) chain = legacy ? [{ step: { ...FALLBACK_STEP, name: 'Approval' }, index: -1, approver_id: legacy }] : []
  const stored = storeChain(ctx, chain, input)
  return { wf_process: process, wf_chain: stored, wf_step: 0, wf_step_at: nowISO(), approver_id: stored[0]?.approver_id ?? null }
}
export const wfPatch = (s: WfState) => ({ wf_process: s.wf_process, wf_chain: s.wf_chain, wf_step: s.wf_step, wf_step_at: s.wf_step_at })
/** Clear the stored chain (after a rejection / send-back the next submission starts over). */
export const wfClear = () => ({ wf_chain: [], wf_step: 0, wf_step_at: null }) as unknown as Partial<WfState>

/** The stored state of a record; records submitted before workflows existed get one built now and aligned to their current approver. */
export function ensureWf(ctx: Ctx, rec: WithWf & { updated_at?: string }, process: WorkflowProcess, input: ChainInput, legacy: string | null, currentApprover?: string | null): WfState {
  const cur = currentApprover !== undefined ? currentApprover : rec.approver_id ?? null
  if (rec.wf_chain && rec.wf_chain.length && rec.wf_step != null && rec.wf_chain[rec.wf_step]) return rec as WfState
  const s = startApproval(ctx, process, input, legacy ?? cur)
  let i = cur ? s.wf_chain.findIndex((c) => c.approver_id === cur) : 0
  if (i < 0) {
    if (cur) s.wf_chain = [{ step_id: 'legacy', index: -1, name: 'Approval', approver_id: cur, sla_days: 2, escalate_to_id: null }, ...s.wf_chain.slice(1)]
    i = 0
  }
  if (!s.wf_chain.length && cur) s.wf_chain = [{ step_id: 'legacy', index: -1, name: 'Approval', approver_id: cur, sla_days: 2, escalate_to_id: null }]
  return { ...s, wf_step: i, wf_step_at: rec.updated_at ?? nowISO() }
}

/**
 * Record the actor's approval of the current step and move on. Steps whose approver is the actor
 * (e.g. the CEO approving as manager on a claim that also needs the CEO) are approved in the same act.
 */
export function advanceApproval(ctx: Ctx, st: WfState, actorId: string): { state: WfState; next: StoredStep | null; done: StoredStep | null } {
  const chain = st.wf_chain.map((c) => ({ ...c }))
  const at = nowISO()
  const done = chain[st.wf_step] ?? null
  if (done) Object.assign(done, { decided_by: actorId, decided_at: at })
  let i = st.wf_step + 1
  while (i < chain.length && chain[i].approver_id === actorId) {
    Object.assign(chain[i], { decided_by: actorId, decided_at: at })
    i++
  }
  const next = i < chain.length ? chain[i] : null
  return { state: { ...st, wf_chain: chain, wf_step: next ? i : st.wf_step, wf_step_at: next ? at : st.wf_step_at }, next, done }
}

/** "Step 2 of 2 · CEO approval" — only for multi-step chains. */
export function stepLabel(rec: WithWf | null | undefined): string | null {
  const c = rec?.wf_chain
  if (!c || c.length < 2 || rec?.wf_step == null) return null
  const s = c[rec.wf_step]
  return s ? `Step ${rec.wf_step + 1} of ${c.length} · ${s.name}` : null
}
/** Working-day SLA due date of the current step (null when not tracked). */
export function stepDue(ctx: Ctx, rec: WithWf | null | undefined): string | null {
  const s = rec?.wf_chain?.[rec?.wf_step ?? -1]
  if (!s || !rec?.wf_step_at) return null
  return addWorkingDays(rec.wf_step_at.slice(0, 10), s.sla_days || 2, calendarFor(ctx))
}
export function escalationTarget(ctx: Ctx, rec: WithWf | null | undefined): { id: string; name: string } | null {
  const s = rec?.wf_chain?.[rec?.wf_step ?? -1]
  if (!s?.escalate_to_id || s.escalated_from) return null
  return { id: s.escalate_to_id, name: userName(ctx, s.escalate_to_id) }
}

export interface RouteStep {
  name: string
  approver_id: string
  approver_name: string
  state: 'done' | 'current' | 'next' | 'skipped'
  decided_by_name: string | null
  escalated_from_name: string | null
}
/** The stored chain as a readable route for detail screens (null for single-step chains). */
export function approvalRoute(ctx: Ctx, rec: WithWf | null | undefined, pending: boolean): RouteStep[] | null {
  const c = rec?.wf_chain
  if (!c || c.length < 2) return null
  return c.map((s, i) => ({
    name: s.name, approver_id: s.approver_id, approver_name: userName(ctx, s.approver_id),
    state: s.decided_by ? 'done' : pending && i === rec!.wf_step ? 'current' : pending ? 'next' : 'skipped',
    decided_by_name: s.decided_by ? userName(ctx, s.decided_by) : null,
    escalated_from_name: s.escalated_from ? userName(ctx, s.escalated_from) : null,
  }))
}

/**
 * Lazy escalation: when the current step is past its SLA and has an escalation target, hand the item
 * to that person (once), notify them and log it. Returns true when the record was reassigned.
 */
export function escalateIfDue(ctx: Ctx, table: 'leave_requests' | 'expense_claims' | 'purchase_orders' | 'vendor_bills' | 'timesheet_weeks' | 'tasks', rec: WithWf & { id: string }, entity: string, title: string, link: string): boolean {
  const due = stepDue(ctx, rec)
  const tgt = escalationTarget(ctx, rec)
  if (!due || !tgt || ctx.today <= due) return false
  const chain = rec.wf_chain!.map((c) => ({ ...c }))
  const s = chain[rec.wf_step!]
  const from = s.approver_id
  if (from === tgt.id) return false
  Object.assign(s, { escalated_from: from, approver_id: tgt.id })
  const patch: Record<string, unknown> = { wf_chain: chain, wf_step_at: nowISO() }
  if (table === 'tasks') patch.wf_approver_id = tgt.id
  else patch.approver_id = tgt.id
  update(ctx, table, rec.id, patch as never)
  notify(ctx, tgt.id, 'NTF-04', 'Escalated to you', `${title} waited past its ${s.sla_days}-working-day deadline with ${userName(ctx, from)}, so it now needs your decision.`, link)
  notify(ctx, from, 'NTF-04', 'Approval escalated', `${title} passed its deadline and was escalated to ${tgt.name}.`, link)
  logActivity(ctx, entity, rec.id, 'escalated', `Escalated from ${userName(ctx, from)} to ${tgt.name} after the ${s.sla_days}-working-day deadline (${s.name})`)
  return true
}

/* ================================================================== */
/* Configuration API                                                    */
/* ================================================================== */
export interface WorkflowView extends ApprovalWorkflow {
  process_label: string
  summary: string
  step_summaries: string[]
  uses_amount: boolean
  uses_project: boolean
  is_default: boolean
  pending_change: { id: string; summary: string; maker_name: string; maker_id: string; created_at: string } | null
}
export interface WorkflowsResult {
  workflows: WorkflowView[]
  roles: { key: string; name: string; active: boolean; holders: number }[]
  approver_labels: Record<ApproverType, string>
  maker_checker: boolean
}
export interface SimulatedStep {
  index: number
  name: string
  approver_id: string
  approver_name: string
  approver_title: string
  sla_days: number
  escalate_to_name: string | null
  reason: string
}
export interface SimulationResult {
  steps: SimulatedStep[]
  skipped: { name: string; reason: string }[]
  fallback: boolean
  auto_approved: boolean
  summary: string
}

function roleName(ctx: Ctx, key: string | null | undefined) {
  if (!key) return 'a role'
  return rows(ctx, 'roles').find((r) => r.key === key)?.name ?? key
}
function approverText(ctx: Ctx, a: { approver: ApproverType; role_id?: string | null; user_id?: string | null }) {
  switch (a.approver) {
    case 'role':
      return roleName(ctx, a.role_id)
    case 'user':
      return userName(ctx, a.user_id)
    case 'reports_to':
      return 'Reporting manager'
    case 'skip_level':
      return 'Manager’s manager'
    case 'project_pm':
      return 'Project manager'
    case 'project_pm_or_manager':
      return 'Project manager (else reporting manager)'
    case 'department_head':
      return 'Department head'
    case 'task_reviewer':
      return 'Task reviewer'
  }
}
export function stepSummary(ctx: Ctx, s: WorkflowStep): string {
  return `${approverText(ctx, s)}${s.min_amount_paise ? ` above ${fmtMoney(s.min_amount_paise)}` : ''}`
}
/** "Reporting manager → CEO above ₹25,000" */
export function chainSummary(ctx: Ctx, steps: WorkflowStep[]): string {
  return steps.map((s) => stepSummary(ctx, s)).join(' → ') || 'No approval'
}
const sameSteps = (a: WorkflowStep[], b: WorkflowStep[]) => {
  const norm = (s: WorkflowStep[]) => JSON.stringify(s.map((x) => ({ n: x.name, a: x.approver, r: x.role_id ?? null, u: x.user_id ?? null, m: x.min_amount_paise ?? null, d: x.sla_days, e: x.escalate_to ?? null, s: !!x.allow_self })))
  return norm(a) === norm(b)
}

function wfView(ctx: Ctx, w: ApprovalWorkflow): WorkflowView {
  const def = DEFAULT_WORKFLOWS.find((d) => d.process === w.process)
  const pc = pendingChangeFor(ctx, 'workflow', w.id)
  return {
    ...w,
    process_label: PROCESS_LABEL[w.process],
    summary: chainSummary(ctx, w.steps),
    step_summaries: w.steps.map((s) => stepSummary(ctx, s)),
    uses_amount: AMOUNT_PROCESSES.includes(w.process),
    uses_project: PROJECT_PROCESSES.includes(w.process),
    is_default: !!def && sameSteps(def.steps, w.steps),
    pending_change: pc ? { id: pc.id, summary: pc.summary, maker_name: userName(ctx, pc.maker_id), maker_id: pc.maker_id, created_at: pc.created_at } : null,
  }
}

function getWorkflow(ctx: Ctx, process: string): ApprovalWorkflow {
  if (!(process in PROCESS_LABEL)) err(404, 'NOT_FOUND', 'Workflow not found.')
  const w = rows(ctx, 'approval_workflows').find((x) => x.process === process)
  if (!w) err(404, 'NOT_FOUND', 'Workflow not found.')
  return w
}

const APPROVER_TYPES = Object.keys(APPROVER_LABEL) as ApproverType[]
let stepSeq = 0
/** Validate an edited step list. Throws 422 with a field path like `steps.1.role_id`. */
export function validateSteps(ctx: Ctx, process: WorkflowProcess, input: unknown, acknowledgeFallback: boolean): WorkflowStep[] {
  if (!Array.isArray(input) || input.length < 1) err(422, 'WF_STEPS', 'Add at least one approval step.', 'steps')
  if (input.length > 5) err(422, 'WF_STEPS', 'A workflow can have at most 5 steps. Combine steps or raise the amount thresholds.', 'steps')
  const roles = rows(ctx, 'roles')
  const amounts = AMOUNT_PROCESSES.includes(process)
  const projects = PROJECT_PROCESSES.includes(process)
  const checkTarget = (a: { approver?: unknown; role_id?: unknown; user_id?: unknown }, n: number, f: string, label: string) => {
    const t = a.approver as ApproverType
    if (!APPROVER_TYPES.includes(t)) err(422, 'WF_APPROVER', `Step ${n}: choose who ${label}.`, `${f}.approver`)
    if (t === 'task_reviewer' && process !== 'task_review') err(422, 'WF_APPROVER', `Step ${n}: “Task reviewer” only applies to task reviews.`, `${f}.approver`)
    if ((t === 'project_pm' || t === 'project_pm_or_manager') && !projects) err(422, 'WF_APPROVER', `Step ${n}: ${PROCESS_LABEL[process].toLowerCase()} have no project, so a project manager can’t be resolved. Pick another approver.`, `${f}.approver`)
    if (t === 'role') {
      const r = roles.find((x) => x.key === a.role_id)
      if (!r) err(422, 'WF_ROLE', `Step ${n}: choose the role that ${label}.`, `${f}.role_id`)
      if (!r.active) err(422, 'WF_ROLE', `Step ${n}: the role “${r.name}” is inactive. Pick an active role.`, `${f}.role_id`)
    }
    if (t === 'user') {
      const u = rows(ctx, 'users').find((x) => x.id === a.user_id)
      if (!u) err(422, 'WF_USER', `Step ${n}: choose the person who ${label}.`, `${f}.user_id`)
      if (u.status !== 'active') err(422, 'WF_USER', `Step ${n}: ${u.name} is not active. Pick someone who can sign in.`, `${f}.user_id`)
    }
    return t
  }
  let lastAmount = -1
  const out = input.map((raw, i): WorkflowStep => {
    const s = (raw ?? {}) as Record<string, unknown>
    const n = i + 1
    const f = `steps.${i}`
    const name = String(s.name ?? '').trim()
    if (name.length < 2) err(422, 'WF_NAME', `Step ${n} needs a name (e.g. “Manager approval”).`, `${f}.name`)
    if (name.length > 60) err(422, 'WF_NAME', `Step ${n}: keep the name under 60 characters.`, `${f}.name`)
    const approver = checkTarget(s, n, f, 'approves')
    let min: number | null = null
    if (s.min_amount_paise !== null && s.min_amount_paise !== undefined && s.min_amount_paise !== '' && Number(s.min_amount_paise) !== 0) {
      if (!amounts) err(422, 'WF_AMOUNT', `Step ${n}: ${PROCESS_LABEL[process].toLowerCase()} have no amount, so remove the threshold.`, `${f}.min_amount_paise`)
      min = Number(s.min_amount_paise)
      if (!Number.isInteger(min) || min < 0) err(422, 'WF_AMOUNT', `Step ${n}: the amount must be zero or more.`, `${f}.min_amount_paise`)
      if (min > 1_00_00_00_000_00) err(422, 'WF_AMOUNT', `Step ${n}: that amount looks too large. Check the number of zeros.`, `${f}.min_amount_paise`)
      if (min <= lastAmount) err(422, 'WF_AMOUNT_ORDER', `Step ${n}: thresholds must go up from step to step (the previous step starts above ${fmtMoney(lastAmount)}).`, `${f}.min_amount_paise`)
      lastAmount = min
    }
    const sla = Number(s.sla_days ?? 2)
    if (!Number.isInteger(sla) || sla < 1 || sla > 15) err(422, 'WF_SLA', `Step ${n}: the deadline must be 1 to 15 working days.`, `${f}.sla_days`)
    let esc: WorkflowStep['escalate_to'] = null
    const e = s.escalate_to as Record<string, unknown> | null | undefined
    if (e && e.approver) {
      const t = checkTarget(e, n, `${f}.escalate_to`, 'takes over after the deadline')
      if (t === 'task_reviewer') err(422, 'WF_APPROVER', `Step ${n}: escalate to a person, a role or a manager — not the task reviewer.`, `${f}.escalate_to.approver`)
      if (t === approver && (t !== 'role' || e.role_id === s.role_id) && (t !== 'user' || e.user_id === s.user_id)) err(422, 'WF_ESCALATION', `Step ${n}: escalation goes to the same approver. Pick someone else, or turn escalation off.`, `${f}.escalate_to.approver`)
      esc = { approver: t, role_id: t === 'role' ? String(e.role_id) : null, user_id: t === 'user' ? String(e.user_id) : null }
    }
    const id = typeof s.id === 'string' && /^[\w-]{1,40}$/.test(s.id) ? s.id : `s${Date.now().toString(36)}${(stepSeq++).toString(36)}`
    return {
      id, name, approver, role_id: approver === 'role' ? String(s.role_id) : null, user_id: approver === 'user' ? String(s.user_id) : null,
      min_amount_paise: min, sla_days: sla, escalate_to: esc, allow_self: !!s.allow_self,
    }
  })
  if (new Set(out.map((s) => s.id)).size !== out.length) out.forEach((s, i) => (s.id = `s${i + 1}${Date.now().toString(36)}`))
  if (!out.some((s) => !s.min_amount_paise) && !acknowledgeFallback)
    err(422, 'WF_NO_BASE_STEP', `Every step has an amount threshold, so requests at or below ${fmtMoney(out[0].min_amount_paise)} would have no approver and go to the CEO. Add a step without an amount, or confirm that fallback.`, 'steps')
  return out
}

export function register(r: Router) {
  r.get('/workflows', ({ ctx }): WorkflowsResult => {
    if (!hasAny(ctx, 'workflows.manage', 'master.view')) err(403, 'FORBIDDEN', 'You can’t see approval workflows.')
    const all = rows(ctx, 'approval_workflows')
    const users = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin)
    return {
      workflows: PROCESS_ORDER.map((p) => all.find((w) => w.process === p)).filter((w): w is ApprovalWorkflow => !!w).map((w) => wfView(ctx, w)),
      roles: rows(ctx, 'roles').map((x) => ({ key: x.key, name: x.name, active: x.active, holders: users.filter((u) => u.role_key === x.key).length })).sort((a, b) => a.name.localeCompare(b.name)),
      approver_labels: APPROVER_LABEL,
      maker_checker: !!ctx.tenant.maker_checker?.enabled && (ctx.tenant.maker_checker.entities.includes('workflow')),
    }
  })

  const save = (ctx: Ctx, w: ApprovalWorkflow, steps: WorkflowStep[], meta: { name?: string; description?: string; require_reason_on_reject?: boolean; notify_requester?: boolean }, reset: boolean, ifMatch?: number) => {
    if (ifMatch !== undefined && ifMatch !== w.version) err(409, 'STALE', 'Someone else changed this workflow. Reload to see the latest version.')
    const name = String(meta.name ?? w.name).trim()
    if (name.length < 3 || name.length > 80) err(422, 'VALIDATION', 'Give the workflow a name of 3 to 80 characters.', 'name')
    const next = {
      name, description: String(meta.description ?? w.description).trim().slice(0, 300),
      require_reason_on_reject: meta.require_reason_on_reject ?? w.require_reason_on_reject, notify_requester: meta.notify_requester ?? w.notify_requester, steps,
    }
    const unchanged = sameSteps(w.steps, steps) && next.name === w.name && next.description === w.description && next.require_reason_on_reject === w.require_reason_on_reject && next.notify_requester === w.notify_requester
    if (unchanged) err(422, 'NO_CHANGE', 'Nothing changed. Edit a step before saving.')
    const before = { name: w.name, steps: w.steps, summary: chainSummary(ctx, w.steps) }
    const after = { name: next.name, steps, summary: chainSummary(ctx, steps) }
    return propose<WorkflowView>(ctx, {
      entity: 'workflow', entity_id: w.id, action: 'update', required_permission: 'workflows.manage', base_version: w.version,
      summary: reset ? `Reset ${PROCESS_LABEL[w.process].toLowerCase()} workflow to the default: ${after.summary}` : `${PROCESS_LABEL[w.process]} workflow: ${after.summary}`,
      before, after, payload: { workflow_id: w.id, ...next },
    })
  }

  r.put('/workflows/:process', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'workflows.manage', 'You can’t change approval workflows.')
    const w = getWorkflow(ctx, params.process)
    const steps = validateSteps(ctx, w.process, body.steps, !!body.acknowledge_fallback)
    return save(ctx, w, steps, body, false, ifMatch)
  })
  r.post('/workflows/:process/reset', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'workflows.manage', 'You can’t change approval workflows.')
    const w = getWorkflow(ctx, params.process)
    const def = DEFAULT_WORKFLOWS.find((d) => d.process === w.process)!
    if (sameSteps(def.steps, w.steps)) err(422, 'NO_CHANGE', 'This workflow already uses the default steps.')
    return save(ctx, w, JSON.parse(JSON.stringify(def.steps)), { name: def.name, description: def.description }, true, ifMatch)
  })
  r.post('/workflows/:process/simulate', ({ ctx, params, body }): SimulationResult => {
    if (!hasAny(ctx, 'workflows.manage', 'master.view')) err(403, 'FORBIDDEN', 'You can’t test approval workflows.')
    const w = getWorkflow(ctx, params.process)
    const requester = find(ctx, 'users', String(body.requester_id ?? ''), 'Requester')
    const steps = body.steps ? validateSteps(ctx, w.process, body.steps, true) : w.steps
    const amount = body.amount_paise === null || body.amount_paise === undefined || body.amount_paise === '' ? null : Number(body.amount_paise)
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) err(422, 'VAL_AMOUNT', 'Enter an amount of zero or more.', 'amount_paise')
    const project_id = body.project_id ? String(body.project_id) : null
    if (project_id) find(ctx, 'projects', project_id, 'Project')
    const reviewer_id = body.reviewer_id ? String(body.reviewer_id) : project_id ? rows(ctx, 'projects').find((p) => p.id === project_id)?.pm_id ?? null : requester.reports_to_id
    const input: ChainInput = { requester_id: requester.id, amount_paise: amount, project_id, reviewer_id }
    const chain = resolveChain(ctx, w.process, input, steps)
    const used = new Set(chain.map((c) => c.index))
    const skipped = steps.map((s, i) => ({ s, i })).filter(({ i }) => !used.has(i)).map(({ s }) => {
      if (!applies(s, amount)) return { name: s.name, reason: `Only above ${fmtMoney(s.min_amount_paise)}` }
      const id = resolveApprover(ctx, s, input)
      if (!id) return { name: s.name, reason: 'Nobody matches (no active person in that position)' }
      if (id === requester.id) return { name: s.name, reason: `${requester.name} can’t approve their own request` }
      return { name: s.name, reason: `Same person as the step before (${userName(ctx, id)})` }
    })
    const fallback = chain.length === 1 && chain[0].index === -1
    const stored = storeChain(ctx, chain, input)
    const auto = fallback && !requester.reports_to_id && (w.process === 'leave' || w.process === 'timesheet')
    const out: SimulatedStep[] = auto ? [] : stored.map((c) => {
      const u = rows(ctx, 'users').find((x) => x.id === c.approver_id)
      const def = c.index >= 0 ? steps[c.index] : null
      return {
        index: c.index, name: c.name, approver_id: c.approver_id, approver_name: u?.name ?? '—', approver_title: u?.title ?? '', sla_days: c.sla_days,
        escalate_to_name: c.escalate_to_id ? userName(ctx, c.escalate_to_id) : null, reason: def ? approverText(ctx, def) : 'Nobody in the workflow could approve, so the top approver decides',
      }
    })
    return {
      steps: out, skipped, fallback, auto_approved: auto,
      summary: auto ? `${requester.name} has no manager, so this is approved automatically.` : out.length ? out.map((s) => s.approver_name).join(' → ') : 'No approver',
    }
  })
}

registerApplier('workflow', (ctx, cs) => {
  const p = cs.payload as { workflow_id: string; name: string; description: string; require_reason_on_reject: boolean; notify_requester: boolean; steps: WorkflowStep[] }
  const w = find(ctx, 'approval_workflows', p.workflow_id, 'Workflow')
  assertBaseVersion(cs, w.version)
  const out = update(ctx, 'approval_workflows', w.id, { name: p.name, description: p.description, require_reason_on_reject: p.require_reason_on_reject, notify_requester: p.notify_requester, steps: p.steps })
  logActivity(ctx, 'workflow', w.id, 'updated', `${PROCESS_LABEL[w.process]} workflow is now: ${chainSummary(ctx, p.steps)}${cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''}`)
  persist()
  return { result: wfView(ctx, out), result_id: w.id }
})
