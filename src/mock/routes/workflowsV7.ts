// v7 workflow management: configurable multi-stage workflows (e.g. Employee self-appraisal → Manager / TL review →
// Unit head review → HR review → Finance approval → letter + CTC change). The engine lives here:
//   • templates are versioned (rev); an instance runs on the snapshot it started with
//   • assignees resolve per stage (subject, reporting manager, skip level, department head, role, person, initiator)
//   • only the current assignee (role pool members, or an active delegate) can act; fields are validated here
//   • every response is filtered per viewer: a field's value is sent only to the stages listed in `visible_to`
//     (the owning stage always sees it; the subject sees "subject"/"all" fields only once the workflow completes)
//   • SLA: an overdue stage escalates once to the assignee's manager (lazily, when workflows are read)
//   • completion actions: issue a document (docgen), send an email (outbox), propose a CTC change through
//     maker-checker (entity cost_rate — the same applier as Settings → Cost rates), notify, create a task.
import type * as E from '@/types/entities'
import type * as V7 from '@/types/v7'
import type { DocTemplate } from '@/types/v7'
import { addWorkingDays, fmtDate, fyLabel, fyStartYear, isRealISODate, monthOf, monthRange } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { err, find, getDb, has, hasAny, insert, logActivity, notify, nowISO, persist, requireAction, rows, uid, update, userName, warn, type Ctx, type Router } from '../server'
import { cal } from '../analytics'
import { eligibleCheckers, needsChecker, pendingChangeFor, propose } from '../makerChecker'
import { ensureDocDefaults, issueDocument, longDate, standardVars } from '../docgen'
import { sendEmail } from '../email'
import { ensureWfLetters, provisionWfTemplates } from '../seeds/workflows'

/* ================================================================== */
/* Shared shapes (also used by the client — src/api/wf.ts)             */
/* ================================================================== */
export interface WfPerson {
  id: string
  name: string
  title: string
  hue: number
  invited?: boolean
}
export type WfStatus = V7.WfInstance['status']
export interface WfRow {
  id: string
  title: string
  template_id: string
  template_name: string
  process: V7.WfProcess
  subject: WfPerson | null
  initiator: WfPerson | null
  status: WfStatus
  stage_index: number
  stage_count: number
  stage_name: string | null
  assignee: WfPerson | null
  due_on: string | null
  overdue: boolean
  created_at: string
  updated_at: string
  completed_at: string | null
  can_act: boolean
  version: number
}
export interface WfListView {
  rows: WfRow[]
  counts: { waiting: number; started: number; about: number; all: number | null }
  can_start: boolean
  can_design: boolean
}
export interface WfFieldView extends V7.WfField {
  value: unknown
  display: string
}
export interface WfStageView {
  key: string
  name: string
  index: number
  assignee_kind: string
  status: 'done' | 'current' | 'upcoming' | 'skipped'
  person: WfPerson | null
  acted_at: string | null
  due_on: string | null
  overdue: boolean
  sla_days: number
  fields: WfFieldView[]
  hidden_count: number
  instructions: string
  sees_compensation: boolean
}
export interface WfFacts {
  current_ctc_paise: number | null
  current_annual_paise: number | null
  current_from: string | null
  recommended_pct: number | null
  endorsed_pct: number | null
  normalised_pct: number | null
  approved_pct: number | null
  basis: string | null
  basis_pct: number | null
  new_ctc_paise: number | null
  new_annual_paise: number | null
  monthly_increase_paise: number | null
  annual_impact_paise: number | null
  effective_from: string | null
  band: { grade: string; min_paise: number | null; max_paise: number | null; status: 'within' | 'above' | 'below' } | null
  limited: boolean // the subject's reduced view (outcome only)
}
export interface WfOutputView {
  kind: string
  label: string
  ref_id: string
  status: string | null
  link: string | null
}
export interface WfDetail extends WfRow {
  description: string
  template_rev: number
  latest_rev: number
  stages: WfStageView[]
  form: { stage_key: string; stage_name: string; fields: V7.WfField[]; values: Record<string, unknown>; instructions: string; can_send_back: boolean; can_reject: boolean; sees_compensation: boolean } | null
  facts: WfFacts | null
  outputs: WfOutputView[]
  history: { stage_key: string; stage_name: string; by: WfPerson | null; action: V7.WfInstance['history'][number]['action']; note: string; at: string; to: WfPerson | null }[]
  comments: { id: string; by: WfPerson | null; at: string; body: string }[]
  context: { cycle_id: string | null; cycle_name: string | null; appraisal_id: string | null; note: string | null }
  perms: { can_act: boolean; acting_as: 'assignee' | 'pool' | 'delegate' | null; can_reassign: boolean; can_cancel: boolean; can_comment: boolean }
  escalated: boolean
}
export interface WfTemplateRow {
  id: string
  key: string | null
  name: string
  process: V7.WfProcess
  description: string
  active: boolean
  self_service: boolean
  stage_names: string[]
  rev: number
  running: number
  completed: number
  updated_at: string
  version: number
}
export interface WfIssue {
  path: string
  message: string
}
export interface WfMeta {
  roles: { key: string; name: string; holders: string[] }[]
  doc_templates: { key: string; name: string; active: boolean }[]
  email_templates: { key: string; name: string }[]
  departments_without_head: string[]
  joiners: { id: string; name: string; email: string; manager: string | null }[] // pending invites (onboarding subjects)
  cycles: { id: string; name: string; status: string }[] // open appraisal cycles to link
}
export interface WfAppraisalBrief {
  id: string
  title: string
  status: WfStatus
  stage_index: number
  stage_count: number
  stage_name: string | null
  assignee: WfPerson | null
  due_on: string | null
  overdue: boolean
  can_act: boolean
  stages: { name: string; status: WfStageView['status']; person: WfPerson | null; acted_at: string | null }[]
  outputs: { kind: string; label: string }[]
}

export const PROCESS_LABEL: Record<V7.WfProcess, string> = {
  appraisal: 'Appraisal', onboarding: 'Onboarding', exit: 'Exit', confirmation: 'Confirmation', promotion: 'Promotion', expense: 'Expense', leave: 'Leave', document_approval: 'Document approval', general: 'General',
}
const PROCESSES = Object.keys(PROCESS_LABEL) as V7.WfProcess[]
const ASSIGNEES: V7.WfAssignee[] = ['subject', 'reports_to', 'skip_level', 'department_head', 'role', 'user', 'initiator']
const ASSIGNEE_LABEL: Record<V7.WfAssignee, string> = {
  subject: 'The employee', reports_to: 'Reporting manager / TL', skip_level: 'Skip-level manager', department_head: 'Unit / department head', role: 'Role', user: 'Specific person', initiator: 'Whoever started it',
}
const FIELD_TYPES: V7.WfFieldType[] = ['rating', 'text', 'textarea', 'number', 'percent', 'money', 'select', 'date', 'checkbox', 'file']
const ACTION_TYPES: V7.WfAction['type'][] = ['generate_document', 'send_email', 'update_ctc', 'notify', 'create_task']
const TARGETS = ['subject', 'initiator', 'reports_to', 'participants']
const KEY_RE = /^[a-z][a-z0-9_]{1,31}$/
const DATE_RE = { test: (s: string) => isRealISODate(s) }
const str = (v: unknown) => String(v ?? '').trim()

/* ================================================================== */
/* People                                                              */
/* ================================================================== */
function userOf(ctx: Ctx, id: string | null | undefined): E.User | undefined {
  return id ? rows(ctx, 'users').find((u) => u.id === id) : undefined
}
function inviteOf(ctx: Ctx, id: string | null | undefined): E.Invite | undefined {
  return id ? rows(ctx, 'invites').find((x) => x.id === id) : undefined
}
function person(ctx: Ctx, id: string | null | undefined): WfPerson | null {
  if (!id) return null
  const u = userOf(ctx, id)
  if (u) return { id: u.id, name: u.name, title: u.title, hue: u.avatar_hue }
  const inv = inviteOf(ctx, id)
  if (inv) return { id: inv.id, name: inv.name, title: 'Joining soon (invited)', hue: 200, invited: true }
  return null
}
const isActive = (ctx: Ctx, id: string | null | undefined) => !!id && userOf(ctx, id)?.status === 'active'
function managerOf(ctx: Ctx, id: string | null | undefined): string | null {
  return userOf(ctx, id)?.reports_to_id ?? inviteOf(ctx, id)?.reports_to_id ?? null
}
/** The account behind a subject: the user, or the user an invite turned into once accepted. */
function subjectAccount(ctx: Ctx, id: string | null | undefined): E.User | undefined {
  const u = userOf(ctx, id)
  if (u) return u
  const inv = inviteOf(ctx, id)
  return inv ? rows(ctx, 'users').find((x) => x.email.toLowerCase() === inv.email.toLowerCase()) : undefined
}
function baseFor(ctx: Ctx): () => E.Base {
  return () => ({ id: uid(), tenant_id: ctx.tenant.id, created_at: nowISO(), updated_at: nowISO(), version: 1, created_by: null })
}
/** New workspaces get the built-in templates on first use (idempotent by key; deleted keys are never re-added while others exist). */
function ensureProvisioned(ctx: Ctx) {
  if (!rows(ctx, 'wf_templates').length && ctx.tenant.id !== '__none__') {
    ensureDocDefaults(ctx)
    provisionWfTemplates(getDb(), ctx.tenant.id, baseFor(ctx))
    persist()
  }
}

/* ================================================================== */
/* Engine                                                              */
/* ================================================================== */
export function snapOf(ctx: Ctx, i: V7.WfInstance): V7.WfSnapshot {
  if (i.snapshot) return i.snapshot
  const t = rows(ctx, 'wf_templates').find((x) => x.id === i.template_id)
  return t ? { name: t.name, process: t.process, stages: t.stages, on_complete: t.on_complete, on_reject: t.on_reject } : { name: i.title, process: 'general', stages: [], on_complete: [], on_reject: [] }
}
const snapshotOf = (t: V7.WfTemplate): V7.WfSnapshot => JSON.parse(JSON.stringify({ name: t.name, process: t.process, stages: t.stages, on_complete: t.on_complete, on_reject: t.on_reject }))

interface Who {
  primary: string | null
  pool: string[]
  why: string
}
function roleHolders(ctx: Ctx, key: string | null | undefined): E.User[] {
  return rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin && u.role_key === key).sort((a, b) => a.name.localeCompare(b.name))
}
function deptHead(ctx: Ctx, subjectId: string | null, exclude: Set<string>): string | null {
  const deps = rows(ctx, 'departments')
  const u = userOf(ctx, subjectId) ?? userOf(ctx, managerOf(ctx, subjectId))
  let d = deps.find((x) => x.id === u?.department_id)
  for (let n = 0; d && n < 10; n++) {
    if (d.head_id && !exclude.has(d.head_id) && isActive(ctx, d.head_id)) return d.head_id
    d = d.parent_id ? deps.find((x) => x.id === d!.parent_id) : undefined
  }
  return null
}
function resolveStage(ctx: Ctx, st: V7.WfStage, subjectId: string | null, initiatorId: string, prior: string[]): Who {
  const subj = person(ctx, subjectId)
  const sName = subj?.name ?? 'the employee'
  const one = (id: string | null, why: string): Who => (id && isActive(ctx, id) ? { primary: id, pool: [id], why: '' } : { primary: null, pool: [], why })
  switch (st.assignee) {
    case 'subject':
      if (!subjectId) return one(null, 'the workflow has no employee')
      if (subj?.invited) return one(null, `${sName} has not accepted the invite yet`)
      return one(subjectId, `${sName} is not active`)
    case 'initiator':
      return one(initiatorId, 'the person who started it is no longer active')
    case 'reports_to': {
      const m = managerOf(ctx, subjectId)
      return one(m && m !== subjectId ? m : null, `${sName} has no reporting manager`)
    }
    case 'skip_level': {
      const m = managerOf(ctx, subjectId)
      const s = managerOf(ctx, m)
      return one(s && s !== subjectId ? s : null, `${sName}’s manager has no manager`)
    }
    case 'department_head': {
      // the unit's head; skip the employee and anyone who already reviewed (climb to the parent unit); if no one is
      // left, accept a head who already reviewed, then the employee's own manager (people who head their own unit)
      const self = subjectId ? [subjectId] : []
      const m = managerOf(ctx, subjectId)
      const h = deptHead(ctx, subjectId, new Set([...self, ...prior])) ?? deptHead(ctx, subjectId, new Set(self)) ?? (m && m !== subjectId && isActive(ctx, m) ? m : null)
      return one(h, `no department head is set for ${sName}’s unit (or its parent units) and they have no manager`)
    }
    case 'role': {
      const role = rows(ctx, 'roles').find((r) => r.key === st.role_key)
      if (!role || !role.active) return one(null, `the role “${st.role_key ?? '—'}” does not exist`)
      const pool = roleHolders(ctx, st.role_key).filter((u) => u.id !== subjectId).map((u) => u.id)
      if (!pool.length) {
        const m = managerOf(ctx, subjectId)
        if (roleHolders(ctx, st.role_key).length && m && isActive(ctx, m)) return { primary: m, pool: [m], why: '' }
        return one(null, `nobody holds the ${role.name} role`)
      }
      return { primary: pool[0], pool, why: '' }
    }
    case 'user':
      return one(st.user_id && st.user_id !== subjectId ? st.user_id : null, st.user_id === subjectId ? `${sName} can’t review their own workflow` : 'the chosen person is not active')
  }
}
function lastActor(i: V7.WfInstance, stageKey: string): string | null {
  for (let k = i.history.length - 1; k >= 0; k--) {
    const h = i.history[k]
    if (h.stage_key === stageKey && (h.action === 'submitted' || h.action === 'approved')) return h.by
  }
  return null
}
/** Resolve every stage in order. Done stages use their real actor; a unit head who already reviewed is skipped upward. */
function chainFor(ctx: Ctx, stages: V7.WfStage[], subjectId: string | null, initiatorId: string, i?: V7.WfInstance): Who[] {
  const prior: string[] = []
  return stages.map((st, idx) => {
    const w = resolveStage(ctx, st, subjectId, initiatorId, prior)
    const actual = i && idx < i.current_stage ? lastActor(i, st.key) : null
    const used = actual ?? (i && idx === i.current_stage ? i.current_assignee_id : w.primary)
    if (used) prior.push(used)
    return w
  })
}
function delegatorsOf(ctx: Ctx, me: string): Set<string> {
  return new Set(rows(ctx, 'delegations').filter((d) => d.to_user_id === me && d.from_on <= ctx.today && d.to_on >= ctx.today && !d.project_id).map((d) => d.from_user_id))
}
function actingAs(ctx: Ctx, i: V7.WfInstance): 'assignee' | 'pool' | 'delegate' | null {
  if (i.status !== 'in_progress' || ctx.viewAs) return null
  const me = ctx.user.id
  if (i.current_assignee_id === me) return 'assignee'
  const s = snapOf(ctx, i)
  const st = s.stages[i.current_stage]
  if (st?.assignee === 'role' && me !== i.subject_user_id && roleHolders(ctx, st.role_key).some((u) => u.id === me)) return 'pool'
  if (i.current_assignee_id && delegatorsOf(ctx, me).has(i.current_assignee_id) && me !== i.subject_user_id) return 'delegate'
  return null
}
function isParticipant(ctx: Ctx, i: V7.WfInstance): boolean {
  const me = ctx.user.id
  return i.subject_user_id === me || i.initiated_by === me || i.current_assignee_id === me || i.history.some((h) => h.by === me || h.to === me) || !!actingAs(ctx, i)
}
export function canView(ctx: Ctx, i: V7.WfInstance) {
  return isParticipant(ctx, i) || hasAny(ctx, 'workflows.design', 'workflows.start')
}
function viewerStages(ctx: Ctx, i: V7.WfInstance): Set<string> {
  const me = ctx.user.id
  const s = new Set<string>()
  for (const h of i.history) if (h.by === me && (h.action === 'submitted' || h.action === 'approved')) s.add(h.stage_key)
  const snap = snapOf(ctx, i)
  if (actingAs(ctx, i)) s.add(snap.stages[i.current_stage]?.key)
  return s
}
function fieldVisible(f: V7.WfField, stageKey: string, vs: Set<string>, isSubject: boolean, completed: boolean): boolean {
  if (vs.has(stageKey)) return true
  if (f.visible_to.includes('all')) return true
  if (isSubject) return completed && f.visible_to.includes('subject')
  return f.visible_to.some((k) => vs.has(k))
}
function refValue(values: V7.WfInstance['values'], path: unknown): unknown {
  const p = str(path)
  if (!p.includes('.')) return undefined
  const [s, k] = p.split('.')
  return values[s]?.[k]
}
const numOrNull = (v: unknown) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
function fieldOf(snap: V7.WfSnapshot, path: unknown): V7.WfField | undefined {
  const [s, k] = str(path).split('.')
  return snap.stages.find((x) => x.key === s)?.fields.find((x) => x.key === k)
}
export function displayOf(f: V7.WfField, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  switch (f.type) {
    case 'rating':
      return `${v} / 5`
    case 'percent':
      return `${v}%`
    case 'money':
      return fmtMoney(Number(v))
    case 'date':
      return fmtDate(String(v), 'long')
    case 'checkbox':
      return v ? 'Yes' : 'No'
    case 'file':
      return (v as { name?: string })?.name ?? 'File'
    default:
      return String(v)
  }
}

/* ---------------- validation of a stage's submission ---------------- */
function cleanValues(snap: V7.WfSnapshot, st: V7.WfStage, raw: Record<string, unknown>, values: V7.WfInstance['values']): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of st.fields) {
    const v = raw?.[f.key]
    const empty = v === undefined || v === null || v === '' || (f.type === 'checkbox' && v !== true) || (f.type === 'file' && !(v as { name?: string })?.name)
    if (f.required && empty) err(422, 'VALIDATION', f.type === 'checkbox' ? `Tick “${f.label}” before you submit.` : f.type === 'file' ? `Attach “${f.label}”.` : `Fill in “${f.label}”.`, f.key)
    if (empty) {
      out[f.key] = f.type === 'checkbox' ? false : null
      continue
    }
    switch (f.type) {
      case 'rating': {
        const n = Number(v)
        if (!Number.isFinite(n) || n < (f.min ?? 1) || n > (f.max ?? 5) || Math.round(n * 2) / 2 !== n) err(422, 'VALIDATION', `${f.label}: pick a rating from ${f.min ?? 1} to ${f.max ?? 5}.`, f.key)
        out[f.key] = n
        break
      }
      case 'number':
      case 'percent': {
        const n = Number(v)
        const lo = f.min ?? (f.type === 'percent' ? 0 : -Infinity)
        const hi = f.max ?? (f.type === 'percent' ? 100 : Infinity)
        if (!Number.isFinite(n)) err(422, 'VALIDATION', `${f.label} must be a number.`, f.key)
        if (n < lo || n > hi) err(422, 'VALIDATION', `${f.label} must be between ${lo} and ${hi}${f.type === 'percent' ? '%' : ''}.`, f.key)
        out[f.key] = Math.round(n * 100) / 100
        break
      }
      case 'money': {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 0) err(422, 'MONEY_INVALID', `${f.label}: enter an amount of zero or more.`, f.key)
        if (f.min != null && n < f.min) err(422, 'VALIDATION', `${f.label} must be at least ${fmtMoney(f.min)}.`, f.key)
        if (f.max != null && n > f.max) err(422, 'VALIDATION', `${f.label} must be at most ${fmtMoney(f.max)}.`, f.key)
        out[f.key] = n
        break
      }
      case 'select':
        if (!(f.options ?? []).includes(String(v))) err(422, 'VALIDATION', `${f.label}: choose one of the listed options.`, f.key)
        out[f.key] = String(v)
        break
      case 'date':
        if (!DATE_RE.test(String(v)) || Number.isNaN(new Date(String(v)).getTime())) err(422, 'VALIDATION', `${f.label}: choose a valid date.`, f.key)
        out[f.key] = String(v)
        break
      case 'checkbox':
        out[f.key] = true
        break
      case 'file': {
        const fv = v as { name?: string; size?: number }
        out[f.key] = { name: str(fv.name).slice(0, 160), size: Number(fv.size) || 0 }
        break
      }
      default: {
        const s = str(v)
        const maxLen = f.type === 'textarea' ? 5000 : 300
        if (f.min && s.length < f.min) err(422, 'VALIDATION', `${f.label}: write at least ${f.min} characters.`, f.key)
        if (s.length > maxLen) err(422, 'VALIDATION', `${f.label} is too long (max ${maxLen} characters).`, f.key)
        out[f.key] = s
      }
    }
  }
  // caps from earlier stages, overridable with a written reason
  for (const f of st.fields) {
    if (!f.max_from || out[f.key] === null || out[f.key] === undefined) continue
    const cap = numOrNull(refValue(values, f.max_from))
    if (cap === null || Number(out[f.key]) <= cap) continue
    const reasonField = f.override_field ? st.fields.find((x) => x.key === f.override_field) : undefined
    const reason = reasonField ? str(out[reasonField.key]) : ''
    const capLabel = fieldOf(snap, f.max_from)?.label ?? f.max_from
    if (!reasonField) err(422, 'OVER_CAP', `${f.label} (${out[f.key]}) can’t exceed ${capLabel.toLowerCase()} (${cap}).`, f.key)
    if (reason.length < 10) err(422, 'OVERRIDE_REASON', `${f.label} (${out[f.key]}%) is above the ${capLabel.toLowerCase()} (${cap}%). Explain why in “${reasonField!.label}” (at least 10 characters).`, reasonField!.key)
  }
  return out
}

/* ---------------- compensation facts (server-computed) ---------------- */
function rateOn(ctx: Ctx, userId: string, date: string) {
  return rows(ctx, 'cost_rates').filter((r) => r.user_id === userId && r.effective_from <= date).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
}
function ctcAction(snap: V7.WfSnapshot) {
  const a = snap.on_complete.find((x) => x.type === 'update_ctc')
  return a ? (a.config ?? {}) as { hike_field?: string; effective_field?: string; recommended_field?: string; endorsed_field?: string; normalised_field?: string } : null
}
function computeFacts(ctx: Ctx, i: V7.WfInstance, values: V7.WfInstance['values'], limited: boolean): WfFacts | null {
  const snap = snapOf(ctx, i)
  const cfg = ctcAction(snap)
  const u = subjectAccount(ctx, i.subject_user_id)
  if (!cfg || !u) return null
  const cur = rateOn(ctx, u.id, ctx.today)
  const rec = numOrNull(refValue(values, cfg.recommended_field))
  const endo = numOrNull(refValue(values, cfg.endorsed_field))
  const norm = numOrNull(refValue(values, cfg.normalised_field))
  const appr = numOrNull(refValue(values, cfg.hike_field))
  const pick: [string, number | null][] = [['approved', appr], ['normalised', norm], ['endorsed', endo], ['recommended', rec]]
  const basis = pick.find(([, v]) => v !== null) ?? null
  const newCtc = cur && basis ? Math.round(cur.monthly_ctc_paise * (1 + basis[1]! / 100)) : null
  const eff = refValue(values, cfg.effective_field)
  const g = rows(ctx, 'grades').find((x) => x.id === u.grade_id)
  const annual = newCtc !== null ? newCtc * 12 : null
  const band = g && annual !== null ? { grade: `${g.code} · ${g.name}`, min_paise: g.min_ctc_paise, max_paise: g.max_ctc_paise, status: (g.max_ctc_paise !== null && annual > g.max_ctc_paise ? 'above' : g.min_ctc_paise !== null && annual < g.min_ctc_paise ? 'below' : 'within') as 'within' | 'above' | 'below' } : null
  const f: WfFacts = {
    current_ctc_paise: cur?.monthly_ctc_paise ?? null, current_annual_paise: cur ? cur.monthly_ctc_paise * 12 : null, current_from: cur?.effective_from ?? null,
    recommended_pct: rec, endorsed_pct: endo, normalised_pct: norm, approved_pct: appr, basis: basis ? basis[0] : null, basis_pct: basis ? basis[1] : null,
    new_ctc_paise: newCtc, new_annual_paise: annual, monthly_increase_paise: newCtc !== null && cur ? newCtc - cur.monthly_ctc_paise : null,
    annual_impact_paise: newCtc !== null && cur ? (newCtc - cur.monthly_ctc_paise) * 12 : null, effective_from: typeof eff === 'string' ? eff : null, band, limited,
  }
  if (limited) return { ...f, recommended_pct: null, endorsed_pct: null, normalised_pct: null, monthly_increase_paise: null, annual_impact_paise: null, band: null, current_ctc_paise: null, current_annual_paise: null, current_from: null }
  return f
}
function factsFor(ctx: Ctx, i: V7.WfInstance, vs: Set<string>, values = i.values): WfFacts | null {
  const snap = snapOf(ctx, i)
  const comp = snap.stages.some((s) => s.sees_compensation && vs.has(s.key))
  if (comp) return computeFacts(ctx, i, values, false)
  if (i.subject_user_id === ctx.user.id && i.status === 'completed') return computeFacts(ctx, i, values, true)
  return null
}

/* ---------------- variables for letters and emails ---------------- */
function varsFor(ctx: Ctx, i: V7.WfInstance, map: Record<string, string> | undefined): Record<string, string> {
  const snap = snapOf(ctx, i)
  const out: Record<string, string> = { workflow_title: i.title, cycle_name: str(i.context.cycle_name) }
  for (const st of snap.stages) for (const f of st.fields) out[`${st.key}_${f.key}`] = displayOf(f, i.values[st.key]?.[f.key])
  for (const [k, path] of Object.entries(map ?? {})) {
    const f = fieldOf(snap, path)
    const v = refValue(i.values, path)
    const empty = v === null || v === undefined || v === ''
    out[k] = !f || empty ? '' : f.type === 'percent' || f.type === 'number' ? String(v) : f.type === 'date' ? longDate(String(v)) : displayOf(f, v)
  }
  if (out.cycle_name && !out.appraisal_period) out.appraisal_period = out.cycle_name
  // started without an appraisal cycle: name the period after the financial year it was started in
  if (!out.appraisal_period) out.appraisal_period = fyLabel(fyStartYear(i.created_at.slice(0, 10), ctx.tenant.settings['company.fy_start_month'] ?? 4))
  const acc = subjectAccount(ctx, i.subject_user_id)
  if (acc) {
    const std = standardVars(ctx, acc.id)
    if (!out.new_designation) out.new_designation = std.designation
    out.last_designation = std.designation
    const rate = rateOn(ctx, acc.id, ctx.today)
    if (rate) {
      out.ctc_annual = fmtMoney(rate.monthly_ctc_paise * 12)
      out.ctc_monthly = fmtMoney(rate.monthly_ctc_paise)
    }
    const shift = rows(ctx, 'shifts').find((x) => x.id === acc.shift_id) ?? rows(ctx, 'shifts').find((x) => x.is_default && x.active)
    if (shift) {
      out.working_hours = `${shift.start_time} – ${shift.end_time}`
      out.reporting_time = shift.start_time
    }
    const facts = computeFacts(ctx, i, i.values, false)
    if (facts) {
      out.old_ctc = fmtMoney(facts.current_annual_paise)
      out.current_monthly_ctc = fmtMoney(facts.current_ctc_paise)
      if (facts.new_ctc_paise !== null) {
        out.new_ctc = fmtMoney(facts.new_annual_paise)
        out.new_monthly_ctc = fmtMoney(facts.new_ctc_paise)
      }
      if (!out.hike_pct && facts.basis_pct !== null) out.hike_pct = String(facts.basis_pct)
      if (!out.effective_from && facts.effective_from) out.effective_from = longDate(facts.effective_from)
    }
  } else {
    const inv = inviteOf(ctx, i.subject_user_id)
    if (inv) Object.assign(out, { employee_name: inv.name, employee_email: inv.email })
  }
  return out
}
function targetsOf(ctx: Ctx, i: V7.WfInstance, to: unknown): string[] {
  const t = str(to) || 'subject'
  const acc = subjectAccount(ctx, i.subject_user_id)?.id ?? null
  if (t === 'subject') return acc ? [acc] : []
  if (t === 'initiator') return [i.initiated_by]
  if (t === 'reports_to') return [managerOf(ctx, i.subject_user_id)].filter(Boolean) as string[]
  if (t === 'participants') return [...new Set([i.initiated_by, ...i.history.map((h) => h.by), ...(acc ? [acc] : [])])].filter((x) => isActive(ctx, x))
  if (t.startsWith('role:')) return roleHolders(ctx, t.slice(5)).map((u) => u.id)
  return []
}
function whenOk(i: V7.WfInstance, a: V7.WfAction) {
  const w = a.config?.when as { field?: string; equals?: unknown } | undefined
  if (!w?.field) return true
  return String(refValue(i.values, w.field) ?? '') === String(w.equals ?? '')
}

/* ---------------- completion actions ---------------- */
function lockedMonths(ctx: Ctx) {
  return new Set(rows(ctx, 'payroll_runs').filter((p) => p.status === 'final').map((p) => p.month))
}
/** Mirrors the Settings → Cost rates rules so a completion never half-applies (the applier re-checks on approval). */
function ctcPlan(ctx: Ctx, i: V7.WfInstance, a: V7.WfAction) {
  const snap = snapOf(ctx, i)
  const cfg = (a.config ?? {}) as { hike_field?: string; effective_field?: string }
  const u = subjectAccount(ctx, i.subject_user_id)
  if (!u) err(409, 'WF_NO_ACCOUNT', 'The employee has no SeereonOS account yet, so their CTC can’t be changed.')
  const hike = numOrNull(refValue(i.values, cfg.hike_field))
  const eff = str(refValue(i.values, cfg.effective_field))
  if (hike === null) err(409, 'WF_CTC_INPUT', `The CTC change needs “${fieldOf(snap, cfg.hike_field)?.label ?? cfg.hike_field}”.`)
  if (!DATE_RE.test(eff)) err(409, 'WF_CTC_INPUT', `The CTC change needs “${fieldOf(snap, cfg.effective_field)?.label ?? cfg.effective_field}”.`)
  const hist = rows(ctx, 'cost_rates').filter((x) => x.user_id === u!.id)
  const cur = rateOn(ctx, u!.id, ctx.today) ?? hist.sort((x, y) => x.effective_from.localeCompare(y.effective_from))[0] ?? null
  if (!cur) err(409, 'WF_NO_RATE', `${u!.name} has no current cost rate. Add one under Settings → Cost rates first.`)
  const locked = lockedMonths(ctx)
  const lastLocked = [...locked].sort().pop()
  if (locked.has(monthOf(eff)) || (lastLocked && eff <= monthRange(lastLocked).to)) err(409, 'RATE_PERIOD_LOCKED', `Payroll up to ${fmtDate(monthRange(lastLocked!).to)} is final. Send back to HR to choose a later effective date.`, 'effective_date')
  if (hist.some((x) => x.effective_from === eff)) err(409, 'RATE_EXISTS', `${u!.name} already has a rate starting ${fmtDate(eff)}. Send back to HR to pick another effective date.`)
  const latest = hist.map((x) => x.effective_from).sort().pop()
  if (latest && eff < latest) err(409, 'RATE_PERIOD_LOCKED', `${u!.name}’s latest rate starts ${fmtDate(latest)}; the effective date must be later.`)
  if (pendingChangeFor(ctx, 'cost_rate', u!.id)) err(409, 'CHANGE_PENDING', `A salary change for ${u!.name} is already waiting for a checker. Decide it under Change approvals first.`)
  if (needsChecker(ctx, 'cost_rate') && !eligibleCheckers(ctx, 'cost_rates.edit', ctx.user.id).length)
    err(409, 'NO_CHECKER', 'Maker-checker is on for salaries, but no one else can approve this CTC change. Give a second person “Check changes” and “Change salaries & cost rates”.')
  const ctc = Math.round(cur!.monthly_ctc_paise * (1 + hike! / 100))
  return { u: u!, cur: cur!, hike: hike!, eff, ctc, base_version: hist.length }
}
function preflight(ctx: Ctx, i: V7.WfInstance, actions: V7.WfAction[]) {
  for (const a of actions) {
    if (!whenOk(i, a)) continue
    if (a.type === 'update_ctc') ctcPlan(ctx, i, a)
    if (a.type === 'generate_document') {
      if (!subjectAccount(ctx, i.subject_user_id)) err(409, 'WF_NO_ACCOUNT', `${person(ctx, i.subject_user_id)?.name ?? 'The employee'} has not accepted their invite yet, so the letter can’t be issued. Complete this step after they sign in.`)
      ensureDocDefaults(ctx)
      if (!rows(ctx, 'doc_templates').some((t) => t.key === a.template_key && t.active)) {
        ensureWfLetters(getDb(), ctx.tenant.id, baseFor(ctx))
        if (!rows(ctx, 'doc_templates').some((t) => t.key === a.template_key && t.active)) err(409, 'TEMPLATE_MISSING', `The document template “${a.template_key}” is missing or inactive. Restore it under Documents → Templates.`)
      }
    }
    if (a.type === 'send_email' && !rows(ctx, 'email_templates').some((t) => (t.key as string) === a.template_key)) ensureWfLetters(getDb(), ctx.tenant.id, baseFor(ctx))
  }
}
function runActions(ctx: Ctx, i: V7.WfInstance, actions: V7.WfAction[]) {
  const snap = snapOf(ctx, i)
  const link = `/workflows/run/${i.id}`
  for (const a of actions) {
    if (!whenOk(i, a)) continue
    const cfg = (a.config ?? {}) as Record<string, unknown>
    if (a.type === 'update_ctc') {
      const p = ctcPlan(ctx, i, a)
      const show = (c: number, from: string) => ({ 'Monthly CTC': fmtMoney(c), 'Variable pay': `${p.cur.variable_pct}%`, 'Effective from': from })
      const res = propose<E.CostRate>(ctx, {
        entity: 'cost_rate', entity_id: p.u.id, action: 'create', required_permission: 'cost_rates.edit', base_version: p.base_version,
        summary: `New rate for ${p.u.name}: ${fmtMoney(p.ctc)}/month from ${p.eff} (+${p.hike.toFixed(1)}%) — ${snap.name}${i.context.cycle_name ? ' ' + str(i.context.cycle_name) : ''}`,
        before: show(p.cur.monthly_ctc_paise, p.cur.effective_from), after: show(p.ctc, p.eff),
        payload: { op: 'add', user_id: p.u.id, monthly_ctc_paise: p.ctc, variable_pct: p.cur.variable_pct, sales_target_paise: null, effective_from: p.eff, source: 'workflow', wf_instance_id: i.id },
      })
      if (res.pending) i.outputs.push({ kind: 'cost_rate_change', ref_id: res.change.id, label: `New CTC ${fmtMoney(p.ctc)}/month from ${fmtDate(p.eff)}` })
      else i.outputs.push({ kind: 'cost_rate', ref_id: res.result_id ?? '', label: `New CTC ${fmtMoney(p.ctc)}/month from ${fmtDate(p.eff)} (applied)` })
    } else if (a.type === 'generate_document') {
      const acc = subjectAccount(ctx, i.subject_user_id)!
      const vars = varsFor(ctx, i, cfg.vars as Record<string, string>)
      const tpl = rows(ctx, 'doc_templates').find((t) => t.key === a.template_key && t.active) as DocTemplate
      const title = `${tpl.name}${i.context.cycle_name ? ' ' + str(i.context.cycle_name) : ''} — ${acc.name}`
      // when the workflow also emails the employee itself, skip the generic "document issued" email (one message, not two)
      const ownEmail = actions.some((x) => x.type === 'send_email' && whenOk(i, x) && targetsOf(ctx, i, x.config?.to).includes(acc.id))
      const d = issueDocument(ctx, { template_key: a.template_key!, employee_id: acc.id, vars, title, period: (i.context.cycle_name as string) ?? null, source: { kind: 'workflow', ref_id: i.id }, notify: !ownEmail })
      i.outputs.push({ kind: 'document', ref_id: d.id, label: d.title })
      if (ownEmail) notify(ctx, acc.id, 'NTF-14', `${tpl.name} issued`, `${d.title} is in Documents → My documents. Open it and acknowledge.`, `/documents/issued/${d.id}`)
    } else if (a.type === 'send_email') {
      const vars = varsFor(ctx, i, cfg.vars as Record<string, string>)
      for (const uid2 of targetsOf(ctx, i, cfg.to)) {
        const u = userOf(ctx, uid2)
        if (!u) continue
        const m = sendEmail(ctx, a.template_key as never, { email: u.email, user_id: u.id }, { ...standardVars(ctx, u.id), ...vars, employee_name: vars.employee_name ?? u.name }, { entity: 'wf_instance', id: i.id })
        if (m) i.outputs.push({ kind: 'email', ref_id: m.id, label: `${m.subject} → ${u.email}` })
        else warn(ctx, 'EMAIL_TEMPLATE_MISSING', `No active email template “${a.template_key}”, so no email was sent.`)
      }
    } else if (a.type === 'notify') {
      for (const t of targetsOf(ctx, i, cfg.to)) notify(ctx, t, 'NTF-05', i.title, str(cfg.message) || `${snap.name} is ${i.status === 'rejected' ? 'rejected' : 'complete'}.`, link)
    } else if (a.type === 'create_task') {
      const project = `p_general_${ctx.tenant.slug}`
      if (!rows(ctx, 'projects').some((p) => p.id === project)) continue
      const due = addWorkingDays(ctx.today, Math.max(1, Number(cfg.due_days) || 3), cal(ctx))
      for (const owner of targetsOf(ctx, i, cfg.to)) {
        const no = Math.max(0, ...rows(ctx, 'tasks').filter((t) => t.project_id === project && !t.milestone_id).map((t) => t.no)) + 1
        const title = str(cfg.title) || `Follow up: ${i.title}`
        const t = insert(ctx, 'tasks', {
          project_id: project, milestone_id: null, no, wbs_code: `0.${no}`, title, owner_id: owner, backup_id: null, est_hours: 2, start_on: ctx.today, due_on: due, done_on: null, complexity: 'low', status: 'todo',
          description: `Created by the workflow “${i.title}”.`, blocked_reason: null, kind: 'general', assigned_by: ctx.user.id, reviewer_id: i.initiated_by !== owner ? i.initiated_by : managerOf(ctx, owner), review_round: 0, priority: 'normal',
          stage: 'new', progress: 0, tag: null, actual_start_on: null, baseline_due_on: due, target_revisions: [], slip_flagged_on: null, slip_note: null,
        } as never) as E.Task
        i.outputs.push({ kind: 'task', ref_id: t.id, label: `Task “${title}” for ${userName(ctx, owner)}` })
        notify(ctx, owner, 'NTF-14', 'Task assigned to you', `${title} · due ${fmtDate(due)}`, `/my-tasks?task=${t.id}`)
      }
    }
  }
}

/* ---------------- transitions ---------------- */
function enterStage(ctx: Ctx, i: V7.WfInstance, idx: number, who: string) {
  const snap = snapOf(ctx, i)
  const st = snap.stages[idx]
  i.current_stage = idx
  i.current_assignee_id = who
  i.stage_due_on = addWorkingDays(ctx.today, Math.max(1, st.sla_days), cal(ctx))
  i.stage_started_at = nowISO()
  i.escalated_stage = null
  if (who !== ctx.user.id) notify(ctx, who, 'NTF-04', `${st.name} waiting for you`, `${i.title} · due ${fmtDate(i.stage_due_on)}`, `/workflows/run/${i.id}`)
}
let appraisalHook: ((ctx: Ctx, cycleId: string) => void) | null = null
/** hr.ts registers its cycle-status sync here (avoids a circular import). */
export function setAppraisalSyncHook(fn: (ctx: Ctx, cycleId: string) => void) {
  appraisalHook = fn
}
/** Mirror an appraisal workflow onto the linked appraisal record so the Appraisals screens stay correct. */
export function syncAppraisal(ctx: Ctx, i: V7.WfInstance) {
  const aid = str(i.context?.appraisal_id)
  if (!aid) return
  const a = rows(ctx, 'appraisals').find((x) => x.id === aid)
  if (!a) return
  const snap = snapOf(ctx, i)
  const stageBy = (pred: (s: V7.WfStage) => boolean) => snap.stages.find(pred)
  const selfSt = stageBy((s) => s.assignee === 'subject')
  const mgrSt = stageBy((s) => s.assignee === 'reports_to' || s.assignee === 'skip_level')
  const hrSt = stageBy((s) => s.assignee === 'role' && !!s.role_key?.startsWith('hr')) ?? stageBy((s) => s.sees_compensation === true)
  const rating = (st: V7.WfStage | undefined, prefer: RegExp) => {
    if (!st) return null
    const vals = i.values[st.key] ?? {}
    const rs = st.fields.filter((f) => f.type === 'rating' && numOrNull(vals[f.key]) !== null)
    const p = rs.find((f) => prefer.test(f.key))
    if (p) return Number(vals[p.key])
    return rs.length ? Math.round((rs.reduce((s, f) => s + Number(vals[f.key]), 0) / rs.length) * 2) / 2 : null
  }
  const text = (st: V7.WfStage | undefined) => {
    if (!st) return ''
    const f = st.fields.find((x) => x.type === 'textarea' && x.required) ?? st.fields.find((x) => x.type === 'textarea' && !/private/.test(x.key))
    return f ? str(i.values[st.key]?.[f.key]) : ''
  }
  const at = (st: V7.WfStage | undefined) => {
    if (!st) return null
    for (let k = i.history.length - 1; k >= 0; k--) if (i.history[k].stage_key === st.key && (i.history[k].action === 'submitted' || i.history[k].action === 'approved')) return i.history[k].at
    return null
  }
  let status = a.status
  if (i.status === 'completed') status = 'completed'
  else if (i.status === 'in_progress') {
    const cur = snap.stages[i.current_stage]
    status = cur?.assignee === 'subject' ? 'self_pending' : cur && ['reports_to', 'skip_level', 'department_head'].includes(cur.assignee) ? 'manager_pending' : 'hr_pending'
  }
  const cfg = ctcAction(snap)
  const hike = i.status === 'completed' ? numOrNull(refValue(i.values, cfg?.hike_field)) : null
  const desig = hrSt ? str(i.values[hrSt.key]?.new_designation) : ''
  const done = (st: V7.WfStage | undefined) => !!at(st)
  update(ctx, 'appraisals', a.id, {
    status,
    self_rating: done(selfSt) ? rating(selfSt, /overall/) : null, self_comments: done(selfSt) ? text(selfSt) : '', submitted_self_at: at(selfSt),
    manager_id: a.manager_id ?? managerOf(ctx, a.user_id),
    manager_rating: done(mgrSt) ? rating(mgrSt, /overall/) : null, manager_comments: done(mgrSt) ? text(mgrSt) : '', submitted_manager_at: at(mgrSt),
    hr_rating: done(hrSt) ? rating(hrSt, /final/) : null, hr_comments: done(hrSt) ? text(hrSt) : '',
    final_rating: i.status === 'completed' ? rating(hrSt, /final/) : null, increment_pct: hike, promotion_to: i.status === 'completed' && desig ? desig : null,
    closed_at: i.status === 'completed' ? i.completed_at ?? nowISO() : null,
  } as never)
  appraisalHook?.(ctx, a.cycle_id)
}
function save(ctx: Ctx, i: V7.WfInstance) {
  update(ctx, 'wf_instances', i.id, {} as never)
  syncAppraisal(ctx, i)
}

/** Lazy SLA escalation: an overdue stage moves once to the assignee's manager, and both are told. */
function sweep(ctx: Ctx) {
  if (ctx.viewAs) return
  for (const i of rows(ctx, 'wf_instances')) {
    if (i.status !== 'in_progress' || !i.stage_due_on || i.stage_due_on >= ctx.today || i.escalated_stage === i.current_stage) continue
    const cur = i.current_assignee_id
    const mgr = managerOf(ctx, cur)
    const st = snapOf(ctx, i).stages[i.current_stage]
    i.escalated_stage = i.current_stage
    if (mgr && mgr !== i.subject_user_id && isActive(ctx, mgr)) {
      i.history.push({ stage_key: st?.key ?? '', by: 'system', action: 'escalated', note: `Overdue since ${fmtDate(i.stage_due_on)} — escalated from ${userName(ctx, cur)}`, at: nowISO(), to: mgr })
      i.current_assignee_id = mgr
      i.stage_due_on = addWorkingDays(ctx.today, 1, cal(ctx))
      notify(ctx, mgr, 'NTF-04', `Escalated: ${st?.name ?? 'workflow step'}`, `${i.title} was overdue with ${userName(ctx, cur)} and is now with you.`, `/workflows/run/${i.id}`)
      if (cur) notify(ctx, cur, 'NTF-06', 'Workflow step escalated', `${i.title} passed its deadline and moved to ${userName(ctx, mgr)}.`, `/workflows/run/${i.id}`)
    } else {
      i.history.push({ stage_key: st?.key ?? '', by: 'system', action: 'escalated', note: `Overdue since ${fmtDate(i.stage_due_on)} — nobody above ${userName(ctx, cur)} to escalate to`, at: nowISO(), to: null })
      notify(ctx, i.initiated_by, 'NTF-06', 'Workflow step overdue', `${i.title}: ${st?.name ?? 'a step'} is overdue with ${userName(ctx, cur)}.`, `/workflows/run/${i.id}`)
    }
    i.version++
    i.updated_at = nowISO()
    persist()
  }
}

/* ================================================================== */
/* Start                                                               */
/* ================================================================== */
export function startWorkflow(ctx: Ctx, t: V7.WfTemplate, subjectId: string, context: Record<string, unknown> = {}, title?: string): V7.WfInstance {
  if (!t.active) err(409, 'WF_INACTIVE', `“${t.name}” is inactive. Activate it in the designer first.`)
  const subj = person(ctx, subjectId)
  if (!subj) err(404, 'NOT_FOUND', 'Employee not found.')
  const u = userOf(ctx, subjectId)
  if (u && u.status !== 'active') err(409, 'WF_SUBJECT_INACTIVE', `${u.name} is not active.`)
  if (!u && inviteOf(ctx, subjectId)?.accepted_at) err(409, 'WF_SUBJECT_INACTIVE', `${subj!.name} already accepted the invite — pick their account instead.`)
  if (rows(ctx, 'wf_instances').some((x) => x.template_id === t.id && x.subject_user_id === subjectId && x.status === 'in_progress'))
    err(409, 'WF_RUNNING', `A “${t.name}” workflow for ${subj!.name} is already running. Finish or cancel it first.`)
  const snap = snapshotOf(t)
  const chain = chainFor(ctx, snap.stages, subjectId, ctx.user.id)
  chain.forEach((w, idx) => {
    if (!w.primary && !(snap.stages[idx].assignee === 'subject' && subj!.invited && idx > 0))
      err(409, 'WF_NO_ASSIGNEE', `Can’t start for ${subj!.name}: nobody can do “${snap.stages[idx].name}” — ${w.why}.`)
  })
  const ctxOut: Record<string, unknown> = { ...context }
  if (u) {
    const r = rateOn(ctx, u.id, ctx.today)
    if (r) ctxOut.current_ctc_paise = r.monthly_ctc_paise
  }
  const i = insert(ctx, 'wf_instances', {
    template_id: t.id, title: title || `${t.name} — ${subj!.name}`, subject_user_id: subjectId, initiated_by: ctx.user.id, status: 'in_progress', current_stage: 0, current_assignee_id: null, stage_due_on: null,
    values: {}, history: [{ stage_key: snap.stages[0].key, by: ctx.user.id, action: 'started', note: str(context.note), at: nowISO() }], context: ctxOut, outputs: [],
    template_rev: t.rev ?? 1, snapshot: snap, stage_started_at: nowISO(), escalated_stage: null, comments: [], completed_at: null,
  } as never) as V7.WfInstance
  enterStage(ctx, i, 0, chain[0].primary!)
  logActivity(ctx, 'wf_instance', i.id, 'started', `${ctx.user.name} started “${t.name}” for ${subj!.name}`)
  save(ctx, i)
  return i
}
export function appraisalTemplate(ctx: Ctx, id: string | null | undefined): V7.WfTemplate {
  ensureProvisioned(ctx)
  const t = id ? rows(ctx, 'wf_templates').find((x) => x.id === id) : rows(ctx, 'wf_templates').find((x) => x.key === 'annual_appraisal' && x.active)
  if (!t) err(404, 'NOT_FOUND', 'Workflow template not found.')
  if (t.process !== 'appraisal') err(422, 'VALIDATION', 'Choose an appraisal workflow.', 'workflow_template_id')
  if (!t.active) err(409, 'WF_INACTIVE', `“${t.name}” is inactive.`)
  return t
}
/** Can every person be routed through this template? (used before launching a cycle) */
export function checkRoutable(ctx: Ctx, t: V7.WfTemplate, subjectIds: string[]) {
  for (const s of subjectIds) {
    const chain = chainFor(ctx, t.stages, s, ctx.user.id)
    const bad = chain.findIndex((w) => !w.primary)
    if (bad >= 0) err(409, 'WF_NO_ASSIGNEE', `Can’t route ${userName(ctx, s)} through “${t.name}”: nobody can do “${t.stages[bad].name}” — ${chain[bad].why}.`)
  }
}
/** Appraisals that run through a workflow (their legacy self/manager/HR forms are replaced by the workflow). */
export function wfLinkedAppraisals(ctx: Ctx): Set<string> {
  return new Set(rows(ctx, 'wf_instances').filter((i) => i.status !== 'cancelled' && i.context?.appraisal_id).map((i) => String(i.context.appraisal_id)))
}
export function assertNotWorkflowManaged(ctx: Ctx, appraisalId: string) {
  const i = rows(ctx, 'wf_instances').find((x) => x.status !== 'cancelled' && x.context?.appraisal_id === appraisalId)
  if (i) err(409, 'WORKFLOW_MANAGED', `This appraisal runs through the workflow “${i.title}”. Act on it from Workflows.`)
}

/* ================================================================== */
/* Views                                                               */
/* ================================================================== */
function rowOf(ctx: Ctx, i: V7.WfInstance): WfRow {
  const snap = snapOf(ctx, i)
  const st = snap.stages[i.current_stage]
  const live = i.status === 'in_progress'
  return {
    id: i.id, title: i.title, template_id: i.template_id, template_name: snap.name, process: snap.process, subject: person(ctx, i.subject_user_id), initiator: person(ctx, i.initiated_by), status: i.status,
    stage_index: i.current_stage, stage_count: snap.stages.length, stage_name: live ? st?.name ?? null : null, assignee: live ? person(ctx, i.current_assignee_id) : null,
    due_on: live ? i.stage_due_on : null, overdue: live && !!i.stage_due_on && i.stage_due_on < ctx.today, created_at: i.created_at, updated_at: i.updated_at, completed_at: i.completed_at ?? null, can_act: !!actingAs(ctx, i), version: i.version,
  }
}
function outputsFor(ctx: Ctx, i: V7.WfInstance, vs: Set<string>): WfOutputView[] {
  const snap = snapOf(ctx, i)
  const isSubject = subjectAccount(ctx, i.subject_user_id)?.id === ctx.user.id
  const comp = !!ctcAction(snap)
  const privileged = snap.stages.some((s) => s.sees_compensation && vs.has(s.key)) || hasAny(ctx, 'documents.templates', 'cost_rates.view')
  return i.outputs
    .filter((o) => (isSubject ? o.kind === 'document' || o.kind === 'email' || o.kind === 'task' : !comp || privileged))
    .map((o) => {
      if (o.kind === 'cost_rate_change') {
        const c = rows(ctx, 'change_sets').find((x) => x.id === o.ref_id)
        const canSee = hasAny(ctx, 'makerchecker.check', 'audit.view', 'makerchecker.configure') || c?.maker_id === ctx.user.id
        return { ...o, status: c ? (c.status === 'pending' ? 'Waiting for a checker' : c.status === 'approved' ? 'Approved and applied' : c.status[0].toUpperCase() + c.status.slice(1)) : null, link: canSee ? `/changes?id=${o.ref_id}` : null }
      }
      if (o.kind === 'document') {
        const d = rows(ctx, 'issued_documents').find((x) => x.id === o.ref_id)
        return { ...o, status: d ? (d.status === 'acknowledged' ? 'Acknowledged' : d.status === 'revoked' ? 'Revoked' : 'Issued') : null, link: `/documents/issued/${o.ref_id}` }
      }
      if (o.kind === 'cost_rate') return { ...o, status: 'Applied', link: has(ctx, 'cost_rates.view') ? '/settings/cost-rates' : null }
      if (o.kind === 'task') return { ...o, status: rows(ctx, 'tasks').find((t) => t.id === o.ref_id)?.status === 'done' ? 'Done' : 'Open', link: `/tasks/${o.ref_id}` }
      if (o.kind === 'email') return { ...o, status: 'Sent', link: has(ctx, 'emails.view') ? '/setup/emails' : null }
      return { ...o, status: null, link: null }
    })
}
function detailOf(ctx: Ctx, i: V7.WfInstance): WfDetail {
  const snap = snapOf(ctx, i)
  const vs = viewerStages(ctx, i)
  const acting = actingAs(ctx, i)
  const isSubject = subjectAccount(ctx, i.subject_user_id)?.id === ctx.user.id || i.subject_user_id === ctx.user.id
  const completed = i.status === 'completed'
  const chain = chainFor(ctx, snap.stages, i.subject_user_id, i.initiated_by, i)
  const t = rows(ctx, 'wf_templates').find((x) => x.id === i.template_id)
  const stages: WfStageView[] = snap.stages.map((st, idx) => {
    const done = idx < i.current_stage || completed || (i.status !== 'in_progress' && idx < i.current_stage)
    const current = i.status === 'in_progress' && idx === i.current_stage
    const status: WfStageView['status'] = current ? 'current' : done ? 'done' : i.status === 'in_progress' ? 'upcoming' : 'skipped'
    const actor = lastActor(i, st.key)
    const at = actor ? [...i.history].reverse().find((h) => h.stage_key === st.key && h.by === actor && (h.action === 'submitted' || h.action === 'approved'))?.at ?? null : null
    const vals = i.values[st.key] ?? {}
    const shown = status === 'current' ? [] : st.fields.filter((f) => fieldVisible(f, st.key, vs, isSubject, completed))
    const hasValues = Object.keys(vals).length > 0
    return {
      key: st.key, name: st.name, index: idx, assignee_kind: st.assignee === 'role' ? `${ASSIGNEE_LABEL.role}: ${rows(ctx, 'roles').find((r) => r.key === st.role_key)?.name ?? st.role_key}` : ASSIGNEE_LABEL[st.assignee],
      status, person: person(ctx, status === 'done' ? actor : current ? i.current_assignee_id : chain[idx]?.primary ?? null), acted_at: status === 'done' ? at : null,
      due_on: current ? i.stage_due_on : null, overdue: current && !!i.stage_due_on && i.stage_due_on < ctx.today, sla_days: st.sla_days,
      fields: hasValues ? shown.map((f) => ({ ...f, value: vals[f.key] ?? null, display: displayOf(f, vals[f.key]) })) : [],
      hidden_count: hasValues && status !== 'current' ? st.fields.length - shown.length : 0, instructions: st.instructions ?? '', sees_compensation: !!st.sees_compensation,
    }
  })
  const cur = snap.stages[i.current_stage]
  const form = acting && cur ? {
    stage_key: cur.key, stage_name: cur.name, fields: cur.fields, values: { ...(i.values[cur.key] ?? {}) }, instructions: cur.instructions ?? '',
    can_send_back: cur.can_send_back && i.current_stage > 0, can_reject: cur.assignee !== 'subject' && cur.assignee !== 'initiator', sees_compensation: !!cur.sees_compensation,
  } : null
  const stageName = (k: string) => snap.stages.find((s) => s.key === k)?.name ?? k
  return {
    ...rowOf(ctx, i),
    description: t?.description ?? '', template_rev: i.template_rev ?? 1, latest_rev: t?.rev ?? 1, stages, form,
    facts: factsFor(ctx, i, vs),
    outputs: outputsFor(ctx, i, vs),
    history: i.history.map((h) => ({ stage_key: h.stage_key, stage_name: stageName(h.stage_key), by: person(ctx, h.by), action: h.action, note: h.note, at: h.at, to: person(ctx, h.to) })),
    comments: (i.comments ?? []).map((c) => ({ id: c.id, by: person(ctx, c.by), at: c.at, body: c.body })),
    context: { cycle_id: (i.context.cycle_id as string) ?? null, cycle_name: (i.context.cycle_name as string) ?? null, appraisal_id: (i.context.appraisal_id as string) ?? null, note: str(i.history[0]?.note) || null },
    perms: {
      can_act: !!acting, acting_as: acting, can_reassign: i.status === 'in_progress' && !ctx.viewAs && has(ctx, 'workflows.design'),
      can_cancel: i.status === 'in_progress' && !ctx.viewAs && (i.initiated_by === ctx.user.id || has(ctx, 'workflows.design')), can_comment: !ctx.viewAs,
    },
    escalated: i.escalated_stage === i.current_stage && i.status === 'in_progress',
  }
}
function getVisible(ctx: Ctx, id: string): V7.WfInstance {
  const i = find(ctx, 'wf_instances', id, 'Workflow')
  if (!canView(ctx, i)) err(404, 'NOT_FOUND', 'Workflow not found.')
  return i
}

/* ---------------- approvals inbox feed (used by routes/company.ts) ---------------- */
export interface WfInboxRow {
  id: string
  version: number
  title: string
  template_name: string
  process: V7.WfProcess
  stage_name: string
  step_label: string
  subject_id: string | null
  started_at: string | null
  due_on: string | null
  escalates_to: string | null
  via_delegation: boolean
  note: string | null
}
export function wfInboxRows(ctx: Ctx): WfInboxRow[] {
  sweep(ctx)
  const out: WfInboxRow[] = []
  for (const i of rows(ctx, 'wf_instances')) {
    const how = actingAs(ctx, i)
    if (!how) continue
    const snap = snapOf(ctx, i)
    const st = snap.stages[i.current_stage]
    const mgr = managerOf(ctx, i.current_assignee_id)
    out.push({
      id: i.id, version: i.version, title: `${st.name} · ${person(ctx, i.subject_user_id)?.name ?? i.title}`, template_name: snap.name, process: snap.process, stage_name: st.name,
      step_label: `Step ${i.current_stage + 1} of ${snap.stages.length} · ${st.name}`, subject_id: i.subject_user_id, started_at: i.stage_started_at ?? i.created_at, due_on: i.stage_due_on,
      escalates_to: i.escalated_stage === i.current_stage ? null : mgr && isActive(ctx, mgr) ? userName(ctx, mgr) : null, via_delegation: how === 'delegate', note: st.instructions ?? null,
    })
  }
  return out
}

/* ================================================================== */
/* Template validation                                                 */
/* ================================================================== */
interface TemplateInput {
  name: string
  process: V7.WfProcess
  description: string
  active: boolean
  self_service: boolean
  stages: V7.WfStage[]
  on_complete: V7.WfAction[]
  on_reject: V7.WfAction[]
}
function normalise(body: Record<string, unknown>): TemplateInput {
  const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])
  return {
    name: str(body.name), process: str(body.process) as V7.WfProcess, description: str(body.description), active: body.active !== false, self_service: !!body.self_service,
    stages: arr<V7.WfStage>(body.stages).map((s, idx) => ({
      key: str(s.key), name: str(s.name), assignee: s.assignee, role_key: s.assignee === 'role' ? str(s.role_key) || null : null, user_id: s.assignee === 'user' ? str(s.user_id) || null : null,
      sla_days: Number(s.sla_days), can_send_back: idx > 0 && !!s.can_send_back, instructions: str(s.instructions), sees_compensation: !!s.sees_compensation,
      fields: arr<V7.WfField>(s.fields).map((f) => ({
        key: str(f.key), label: str(f.label), type: f.type, required: !!f.required, help: str(f.help) || undefined,
        options: f.type === 'select' ? arr<string>(f.options).map((o) => str(o)).filter(Boolean) : undefined,
        min: f.min === null || f.min === undefined || (f.min as unknown) === '' ? undefined : Number(f.min), max: f.max === null || f.max === undefined || (f.max as unknown) === '' ? undefined : Number(f.max),
        visible_to: [...new Set(arr<string>(f.visible_to).map(str).filter(Boolean))],
        max_from: str(f.max_from) || null, override_field: str(f.override_field) || null,
      })),
    })),
    on_complete: arr<V7.WfAction>(body.on_complete).map((a) => ({ type: a.type, template_key: str(a.template_key) || null, config: (a.config && typeof a.config === 'object' ? a.config : {}) as Record<string, unknown> })),
    on_reject: arr<V7.WfAction>(body.on_reject).map((a) => ({ type: a.type, template_key: str(a.template_key) || null, config: (a.config && typeof a.config === 'object' ? a.config : {}) as Record<string, unknown> })),
  }
}
function issuesOf(ctx: Ctx, t: TemplateInput, selfId?: string): WfIssue[] {
  const out: WfIssue[] = []
  const add = (path: string, message: string) => out.push({ path, message })
  if (t.name.length < 3) add('name', 'Give the workflow a name (at least 3 characters).')
  else if (rows(ctx, 'wf_templates').some((x) => x.id !== selfId && x.name.toLowerCase() === t.name.toLowerCase())) add('name', `Another workflow is already called “${t.name}”.`)
  if (!PROCESSES.includes(t.process)) add('process', 'Choose a process type.')
  if (!t.stages.length) add('stages', 'Add at least one stage.')
  if (t.stages.length > 12) add('stages', 'A workflow can have at most 12 stages.')
  const keys = new Set<string>()
  const roles = rows(ctx, 'roles')
  t.stages.forEach((s, si) => {
    const p = `stages.${si}`
    const label = s.name || `Stage ${si + 1}`
    if (!KEY_RE.test(s.key)) add(`${p}.key`, `${label}: the key must start with a letter and use only a–z, 0–9 and _ (2–32 characters).`)
    else if (keys.has(s.key)) add(`${p}.key`, `${label}: another stage already uses the key “${s.key}”.`)
    keys.add(s.key)
    if (s.name.length < 2) add(`${p}.name`, `Stage ${si + 1}: give it a name.`)
    if (!Number.isInteger(s.sla_days) || s.sla_days < 1 || s.sla_days > 30) add(`${p}.sla_days`, `${label}: the SLA must be 1 to 30 working days.`)
    if (!ASSIGNEES.includes(s.assignee)) add(`${p}.assignee`, `${label}: choose who does this stage.`)
    if (s.assignee === 'role') {
      const r = roles.find((x) => x.key === s.role_key)
      if (!r) add(`${p}.role_key`, `${label}: choose a role.`)
      else if (!r.active) add(`${p}.role_key`, `${label}: the role ${r.name} is inactive.`)
      else if (!roleHolders(ctx, r.key).length) add(`${p}.role_key`, `${label}: nobody holds the ${r.name} role, so this stage could never be assigned.`)
    }
    if (s.assignee === 'user' && !isActive(ctx, s.user_id)) add(`${p}.user_id`, `${label}: choose an active person.`)
    if (s.assignee === 'subject' && si > 0 && t.stages.slice(0, si).some((x) => x.assignee === 'subject')) add(`${p}.assignee`, `${label}: the employee already has a stage; use one stage per person type.`)
    const fkeys = new Set<string>()
    s.fields.forEach((f, fi) => {
      const fp = `${p}.fields.${fi}`
      const fl = f.label || `Field ${fi + 1}`
      if (!KEY_RE.test(f.key)) add(`${fp}.key`, `${label} › ${fl}: the key must start with a letter and use only a–z, 0–9 and _.`)
      else if (fkeys.has(f.key)) add(`${fp}.key`, `${label} › ${fl}: the key “${f.key}” is used twice in this stage.`)
      fkeys.add(f.key)
      if (f.label.length < 2) add(`${fp}.label`, `${label} › field ${fi + 1}: give it a label.`)
      if (!FIELD_TYPES.includes(f.type)) add(`${fp}.type`, `${label} › ${fl}: choose a field type.`)
      if (f.type === 'select') {
        const opts = f.options ?? []
        if (opts.length < 2) add(`${fp}.options`, `${label} › ${fl}: a select needs at least two options.`)
        if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) add(`${fp}.options`, `${label} › ${fl}: options must be unique.`)
      }
      if (f.min !== undefined && !Number.isFinite(f.min)) add(`${fp}.min`, `${label} › ${fl}: the minimum must be a number.`)
      if (f.max !== undefined && !Number.isFinite(f.max)) add(`${fp}.max`, `${label} › ${fl}: the maximum must be a number.`)
      if (f.min !== undefined && f.max !== undefined && f.min > f.max) add(`${fp}.min`, `${label} › ${fl}: the minimum is above the maximum.`)
      if (f.type === 'rating' && ((f.min !== undefined && (f.min < 1 || f.min > 5)) || (f.max !== undefined && (f.max < 1 || f.max > 5)))) add(`${fp}.min`, `${label} › ${fl}: ratings run from 1 to 5.`)
      const allowed = new Set([...t.stages.map((x) => x.key), 'all', 'subject'])
      const bad = f.visible_to.filter((v) => !allowed.has(v))
      if (bad.length) add(`${fp}.visible_to`, `${label} › ${fl}: “${bad.join(', ')}” is not a stage of this workflow.`)
      if (f.max_from) {
        const [rs, rk] = f.max_from.split('.')
        const ri = t.stages.findIndex((x) => x.key === rs)
        const rf = t.stages[ri]?.fields.find((x) => x.key === rk)
        if (ri < 0 || ri >= si || !rf || !['number', 'percent', 'money', 'rating'].includes(rf.type)) add(`${fp}.max_from`, `${label} › ${fl}: the cap must be a number field of an earlier stage.`)
        if (!['number', 'percent', 'money', 'rating'].includes(f.type)) add(`${fp}.max_from`, `${label} › ${fl}: only number fields can be capped.`)
      }
      if (f.override_field) {
        const of = s.fields.find((x) => x.key === f.override_field)
        if (!of || !['text', 'textarea'].includes(of.type) || of.key === f.key) add(`${fp}.override_field`, `${label} › ${fl}: the override reason must be a text field of the same stage.`)
      }
    })
  })
  const docs = rows(ctx, 'doc_templates')
  const emails = rows(ctx, 'email_templates')
  const anyField = (path: unknown, types: V7.WfFieldType[]) => {
    const [s, k] = str(path).split('.')
    const f = t.stages.find((x) => x.key === s)?.fields.find((x) => x.key === k)
    return !!f && types.includes(f.type)
  }
  const checkActions = (list: V7.WfAction[], where: 'on_complete' | 'on_reject') => list.forEach((a, ai) => {
    const p = `${where}.${ai}`
    const what = where === 'on_complete' ? `On completion, action ${ai + 1}` : `On rejection, action ${ai + 1}`
    const cfg = (a.config ?? {}) as Record<string, unknown>
    if (!ACTION_TYPES.includes(a.type)) return add(p, `${what}: choose what it does.`)
    if (a.type === 'generate_document') {
      const d = docs.find((x) => x.key === a.template_key)
      if (!d) add(`${p}.template_key`, `${what}: choose a document template.`)
      else if (!d.active) add(`${p}.template_key`, `${what}: the template “${d.name}” is inactive.`)
    }
    if (a.type === 'send_email' && !emails.some((x) => (x.key as string) === a.template_key)) add(`${p}.template_key`, `${what}: choose an email template.`)
    if (a.type === 'update_ctc') {
      if (where === 'on_reject') add(p, `${what}: a CTC change can only run on completion.`)
      if (!anyField(cfg.hike_field, ['percent', 'number'])) add(`${p}.hike_field`, `${what}: choose the field that holds the approved hike %.`)
      if (!anyField(cfg.effective_field, ['date'])) add(`${p}.effective_field`, `${what}: choose the date field for the effective date.`)
    }
    if ((a.type === 'notify' || a.type === 'send_email' || a.type === 'create_task') && cfg.to !== undefined && !TARGETS.includes(str(cfg.to)) && !str(cfg.to).startsWith('role:')) add(`${p}.to`, `${what}: choose who receives it.`)
    if (a.type === 'create_task' && str(cfg.title).length < 3) add(`${p}.title`, `${what}: give the task a title.`)
    const w = cfg.when as { field?: string } | undefined
    if (w?.field && !anyField(w.field, FIELD_TYPES)) add(`${p}.when`, `${what}: the condition refers to a field that doesn’t exist.`)
  })
  checkActions(t.on_complete, 'on_complete')
  checkActions(t.on_reject, 'on_reject')
  return out
}
function templateRow(ctx: Ctx, t: V7.WfTemplate): WfTemplateRow {
  const inst = rows(ctx, 'wf_instances').filter((i) => i.template_id === t.id)
  return {
    id: t.id, key: t.key ?? null, name: t.name, process: t.process, description: t.description, active: t.active, self_service: !!t.self_service, stage_names: t.stages.map((s) => s.name),
    rev: t.rev ?? 1, running: inst.filter((i) => i.status === 'in_progress').length, completed: inst.filter((i) => i.status === 'completed').length, updated_at: t.updated_at, version: t.version,
  }
}

/* ================================================================== */
/* Routes                                                              */
/* ================================================================== */
export function register(r: Router) {
  /* ---------- templates ---------- */
  r.get('/wf/templates', ({ ctx }) => {
    ensureProvisioned(ctx)
    const all = rows(ctx, 'wf_templates')
    const list = hasAny(ctx, 'workflows.design', 'workflows.start') ? all : all.filter((t) => t.active && t.self_service)
    return list.map((t) => templateRow(ctx, t)).sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
  })
  r.get('/wf/meta', ({ ctx }) => {
    ensureProvisioned(ctx)
    const meta: WfMeta = {
      roles: rows(ctx, 'roles').filter((x) => x.active).map((x) => ({ key: x.key, name: x.name, holders: roleHolders(ctx, x.key).map((u) => u.name) })).sort((a, b) => a.name.localeCompare(b.name)),
      doc_templates: rows(ctx, 'doc_templates').map((d) => ({ key: d.key, name: d.name, active: d.active })).sort((a, b) => a.name.localeCompare(b.name)),
      email_templates: rows(ctx, 'email_templates').filter((e) => e.active).map((e) => ({ key: e.key as string, name: e.name })).sort((a, b) => a.name.localeCompare(b.name)),
      departments_without_head: rows(ctx, 'departments').filter((d) => d.active && !d.head_id).map((d) => d.name),
      joiners: has(ctx, 'workflows.start') ? rows(ctx, 'invites').filter((x) => !x.accepted_at).map((x) => ({ id: x.id, name: x.name, email: x.email, manager: x.reports_to_id ? userName(ctx, x.reports_to_id) : null })) : [],
      cycles: rows(ctx, 'appraisal_cycles').filter((c) => c.status !== 'closed' && c.status !== 'draft').map((c) => ({ id: c.id, name: c.name, status: c.status })),
    }
    return meta
  })
  r.get('/wf/templates/:id', ({ ctx, params }) => {
    const t = find(ctx, 'wf_templates', params.id, 'Workflow template')
    if (!hasAny(ctx, 'workflows.design', 'workflows.start') && !(t.active && t.self_service)) err(404, 'NOT_FOUND', 'Workflow template not found.')
    return { ...t, running: rows(ctx, 'wf_instances').filter((i) => i.template_id === t.id && i.status === 'in_progress').length }
  })
  r.post('/wf/templates/check', ({ ctx, body }) => {
    requireAction(ctx, 'workflows.design', 'Only workflow designers can edit workflows.')
    return { issues: issuesOf(ctx, normalise(body.template ?? {}), str(body.id) || undefined) }
  })
  r.post('/wf/templates', ({ ctx, body }) => {
    requireAction(ctx, 'workflows.design', 'Only workflow designers can create workflows.')
    ensureProvisioned(ctx)
    const name = str(body.name)
    const copy = body.copy_of ? find(ctx, 'wf_templates', str(body.copy_of), 'Workflow template') : null
    const process = (str(body.process) || copy?.process || 'general') as V7.WfProcess
    const input: TemplateInput = copy
      ? { name, process, description: str(body.description) || copy.description, active: false, self_service: !!copy.self_service, stages: JSON.parse(JSON.stringify(copy.stages)), on_complete: JSON.parse(JSON.stringify(copy.on_complete)), on_reject: JSON.parse(JSON.stringify(copy.on_reject)) }
      : {
        name, process, description: str(body.description), active: false, self_service: false,
        stages: [{ key: 'review', name: 'Manager review', assignee: 'reports_to', sla_days: 3, can_send_back: false, instructions: '', fields: [{ key: 'comments', label: 'Comments', type: 'textarea', required: true, visible_to: ['all'] }] }],
        on_complete: [{ type: 'notify', config: { to: 'subject', message: 'Your request is complete.' } }], on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The workflow was rejected.' } }],
      }
    const issues = issuesOf(ctx, input).filter((x) => x.path === 'name' || x.path === 'process')
    if (issues.length) err(422, 'VALIDATION', issues[0].message, issues[0].path)
    const t = insert(ctx, 'wf_templates', { ...input, rev: 1, key: null, updated_by: ctx.user.id } as never) as V7.WfTemplate
    logActivity(ctx, 'wf_template', t.id, 'created', `${ctx.user.name} created the workflow “${t.name}”${copy ? ` from “${copy.name}”` : ''}`)
    return t
  })
  r.put('/wf/templates/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'workflows.design', 'Only workflow designers can edit workflows.')
    const t = find(ctx, 'wf_templates', params.id, 'Workflow template')
    const input = normalise(body)
    const issues = issuesOf(ctx, input, t.id)
    if (issues.length) err(422, 'WF_INVALID', issues.length === 1 ? issues[0].message : `${issues.length} problems — first: ${issues[0].message}`, issues[0].path)
    const structural = JSON.stringify([t.stages, t.on_complete, t.on_reject, t.process]) !== JSON.stringify([input.stages, input.on_complete, input.on_reject, input.process])
    const out = update(ctx, 'wf_templates', t.id, { ...input, rev: (t.rev ?? 1) + (structural ? 1 : 0), updated_by: ctx.user.id } as never, ifMatch)
    const running = rows(ctx, 'wf_instances').filter((i) => i.template_id === t.id && i.status === 'in_progress').length
    if (structural && running) warn(ctx, 'WF_RUNNING_KEEP_VERSION', `${running} running workflow${running === 1 ? '' : 's'} keep revision ${t.rev ?? 1}; new starts use revision ${(t.rev ?? 1) + 1}.`)
    logActivity(ctx, 'wf_template', t.id, 'updated', `${ctx.user.name} updated the workflow “${input.name}”${structural ? ` (revision ${(t.rev ?? 1) + 1})` : ''}`)
    return out
  })
  r.post('/wf/templates/:id/duplicate', ({ ctx, params }) => {
    requireAction(ctx, 'workflows.design', 'Only workflow designers can copy workflows.')
    const t = find(ctx, 'wf_templates', params.id, 'Workflow template')
    let name = `${t.name} (copy)`
    for (let n = 2; rows(ctx, 'wf_templates').some((x) => x.name.toLowerCase() === name.toLowerCase()); n++) name = `${t.name} (copy ${n})`
    const c = insert(ctx, 'wf_templates', { name, process: t.process, description: t.description, active: false, self_service: !!t.self_service, stages: JSON.parse(JSON.stringify(t.stages)), on_complete: JSON.parse(JSON.stringify(t.on_complete)), on_reject: JSON.parse(JSON.stringify(t.on_reject)), rev: 1, key: null, updated_by: ctx.user.id } as never) as V7.WfTemplate
    logActivity(ctx, 'wf_template', c.id, 'created', `${ctx.user.name} copied the workflow “${t.name}”`)
    return c
  })

  /* ---------- instances ---------- */
  r.get('/wf/instances', ({ ctx, query }) => {
    sweep(ctx)
    const me = ctx.user.id
    const all = rows(ctx, 'wf_instances')
    const canAll = hasAny(ctx, 'workflows.design', 'workflows.start')
    const tab = str(query.tab) || 'waiting'
    const pick = (t: string) => t === 'waiting' ? all.filter((i) => !!actingAs(ctx, i)) : t === 'started' ? all.filter((i) => i.initiated_by === me) : t === 'about' ? all.filter((i) => i.subject_user_id === me || subjectAccount(ctx, i.subject_user_id)?.id === me) : canAll ? all : []
    if (tab === 'all' && !canAll) err(403, 'FORBIDDEN', 'Only HR and workflow designers see every workflow.')
    let list = pick(tab)
    if (query.status) list = list.filter((i) => i.status === query.status)
    if (query.template_id) list = list.filter((i) => i.template_id === query.template_id)
    const v: WfListView = {
      rows: list.map((i) => rowOf(ctx, i)).sort((a, b) => (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1) || (a.due_on ?? '9999').localeCompare(b.due_on ?? '9999') || b.updated_at.localeCompare(a.updated_at)),
      counts: { waiting: pick('waiting').length, started: pick('started').filter((i) => i.status === 'in_progress').length, about: pick('about').filter((i) => i.status === 'in_progress').length, all: canAll ? all.filter((i) => i.status === 'in_progress').length : null },
      can_start: has(ctx, 'workflows.start') || rows(ctx, 'wf_templates').some((t) => t.active && t.self_service), can_design: has(ctx, 'workflows.design'),
    }
    return v
  })
  r.get('/wf/instances/:id', ({ ctx, params }) => {
    sweep(ctx)
    return detailOf(ctx, getVisible(ctx, params.id))
  })
  r.get('/wf/appraisal/:appraisalId', ({ ctx, params }): WfAppraisalBrief | null => {
    sweep(ctx)
    const a = find(ctx, 'appraisals', params.appraisalId, 'Appraisal')
    const i = rows(ctx, 'wf_instances').filter((x) => x.status !== 'cancelled' && x.context?.appraisal_id === a.id).sort((x, y) => y.created_at.localeCompare(x.created_at))[0]
    if (!i) return null
    const d = detailOf(ctx, i)
    return {
      id: d.id, title: d.title, status: d.status, stage_index: d.stage_index, stage_count: d.stage_count, stage_name: d.stage_name, assignee: d.assignee, due_on: d.due_on, overdue: d.overdue, can_act: d.can_act,
      stages: d.stages.map((s) => ({ name: s.name, status: s.status, person: s.person, acted_at: s.acted_at })), outputs: d.outputs.map((o) => ({ kind: o.kind, label: o.label })),
    }
  })
  r.post('/wf/instances', ({ ctx, body }) => {
    ensureProvisioned(ctx)
    const t = find(ctx, 'wf_templates', str(body.template_id), 'Workflow template')
    const ids = [...new Set((Array.isArray(body.subject_ids) ? body.subject_ids : [body.subject_id]).map(str).filter(Boolean))] as string[]
    if (!ids.length) err(422, 'VALIDATION', 'Choose at least one employee.', 'subject_ids')
    if (ids.length > 100) err(422, 'VALIDATION', 'Start at most 100 at a time.', 'subject_ids')
    for (const s of ids) {
      if (s === ctx.user.id ? !(t.self_service || has(ctx, 'workflows.start')) : !has(ctx, 'workflows.start'))
        err(403, 'FORBIDDEN', s === ctx.user.id ? `“${t.name}” can only be started by HR.` : 'Starting workflows for other people needs “Start workflows for others”.')
      if (!userOf(ctx, s) && !(inviteOf(ctx, s) && t.process === 'onboarding')) err(422, 'VALIDATION', 'Choose active employees (invited joiners only for onboarding).', 'subject_ids')
    }
    const note = str(body.note).slice(0, 1000)
    const cycle = body.cycle_id ? find(ctx, 'appraisal_cycles', str(body.cycle_id), 'Appraisal cycle') : null
    if (cycle && t.process !== 'appraisal') err(422, 'VALIDATION', 'Only appraisal workflows link to an appraisal cycle.', 'cycle_id')
    if (cycle && cycle.status === 'closed') err(409, 'CYCLE_CLOSED', `${cycle.name} is closed.`, 'cycle_id')
    // validate every person first (all-or-nothing)
    const linked = wfLinkedAppraisals(ctx)
    for (const s of ids) {
      if (rows(ctx, 'wf_instances').some((x) => x.template_id === t.id && x.subject_user_id === s && x.status === 'in_progress')) err(409, 'WF_RUNNING', `A “${t.name}” workflow for ${person(ctx, s)?.name} is already running.`)
      if (cycle) {
        const a = rows(ctx, 'appraisals').find((x) => x.cycle_id === cycle.id && x.user_id === s)
        if (a && linked.has(a.id)) err(409, 'WF_RUNNING', `${person(ctx, s)?.name}’s ${cycle.name} appraisal already runs through a workflow.`)
        if (a && a.status === 'completed') err(409, 'APPRAISAL_DONE', `${person(ctx, s)?.name}’s ${cycle.name} appraisal is already completed.`)
      }
    }
    if (!t.active) err(409, 'WF_INACTIVE', `“${t.name}” is inactive. Activate it in the designer first.`)
    checkRoutable(ctx, t, ids.filter((s) => !!userOf(ctx, s)))
    const created = ids.map((s) => {
      const a = cycle ? rows(ctx, 'appraisals').find((x) => x.cycle_id === cycle.id && x.user_id === s) : undefined
      const context: Record<string, unknown> = { note, ...(cycle ? { cycle_id: cycle.id, cycle_name: cycle.name, appraisal_id: a?.id ?? null } : {}) }
      const title = str(body.title) && ids.length === 1 ? str(body.title) : `${t.name}${cycle ? ' ' + cycle.name : ''} — ${person(ctx, s)?.name}`
      return startWorkflow(ctx, t, s, context, title)
    })
    return { created: created.map((i) => rowOf(ctx, i)) }
  })

  r.post('/wf/instances/:id/preview', ({ ctx, params, body }) => {
    const i = getVisible(ctx, params.id)
    if (!actingAs(ctx, i)) err(403, 'FORBIDDEN', 'Only the current reviewer can preview.')
    const snap = snapOf(ctx, i)
    const st = snap.stages[i.current_stage]
    const draft: Record<string, unknown> = {}
    for (const f of st.fields) if (['number', 'percent', 'money', 'rating', 'date'].includes(f.type)) draft[f.key] = (body.values ?? {})[f.key]
    return { facts: factsFor(ctx, i, viewerStages(ctx, i), { ...i.values, [st.key]: { ...(i.values[st.key] ?? {}), ...draft } }) }
  })

  r.post('/wf/instances/:id/act', ({ ctx, params, body, ifMatch }) => {
    const i = getVisible(ctx, params.id)
    if (ifMatch !== undefined && ifMatch !== i.version) err(409, 'STALE', 'This workflow changed while you were working. Reload to see the latest.')
    if (i.status !== 'in_progress') err(409, 'WF_CLOSED', `This workflow is ${i.status.replace('_', ' ')}.`)
    const how = actingAs(ctx, i)
    if (!how) err(403, 'FORBIDDEN', `This step is waiting for ${userName(ctx, i.current_assignee_id)}.`)
    const snap = snapOf(ctx, i)
    const idx = i.current_stage
    const st = snap.stages[idx]
    const action = str(body.action)
    const by = how === 'delegate' ? ` (for ${userName(ctx, i.current_assignee_id)})` : ''
    if (action === 'submit') {
      const clean = cleanValues(snap, st, body.values ?? {}, i.values)
      const next = { ...i.values, [st.key]: clean }
      const last = idx === snap.stages.length - 1
      const probe = { ...i, values: next } as V7.WfInstance
      let nextWho: string | null = null
      if (!last) {
        const chain = chainFor(ctx, snap.stages, i.subject_user_id, i.initiated_by, { ...probe, current_stage: idx + 1, current_assignee_id: null, history: [...i.history, { stage_key: st.key, by: ctx.user.id, action: 'approved', note: '', at: nowISO() }] })
        nextWho = chain[idx + 1].primary
        if (!nextWho) err(409, 'WF_NO_ASSIGNEE', `Nobody can do the next stage “${snap.stages[idx + 1].name}” — ${chain[idx + 1].why}. Ask a workflow designer to fix the workflow.`)
      } else preflight(ctx, probe, snap.on_complete)
      // commit
      i.values = next
      i.history.push({ stage_key: st.key, by: ctx.user.id, action: st.assignee === 'subject' || idx === 0 ? 'submitted' : 'approved', note: str(body.note).slice(0, 1000) + by, at: nowISO() })
      if (last) {
        i.status = 'completed'
        i.current_assignee_id = null
        i.stage_due_on = null
        i.completed_at = nowISO()
        runActions(ctx, i, snap.on_complete)
        const kinds = i.outputs.map((o) => o.kind)
        i.history.push({ stage_key: st.key, by: ctx.user.id, action: 'completed', note: [kinds.includes('document') ? 'letter issued' : '', kinds.includes('email') ? 'emailed' : '', kinds.includes('cost_rate_change') ? 'CTC change sent for approval' : kinds.includes('cost_rate') ? 'CTC updated' : ''].filter(Boolean).join(', '), at: nowISO() })
        if (i.initiated_by !== ctx.user.id) notify(ctx, i.initiated_by, 'NTF-05', 'Workflow completed', i.title, `/workflows/run/${i.id}`)
        logActivity(ctx, 'wf_instance', i.id, 'completed', `${ctx.user.name}${by} completed “${i.title}”`)
      } else {
        enterStage(ctx, i, idx + 1, nextWho!)
        logActivity(ctx, 'wf_instance', i.id, 'advanced', `${ctx.user.name}${by} completed ${st.name} on “${i.title}”`)
      }
      save(ctx, i)
      return detailOf(ctx, i)
    }
    if (action === 'send_back') {
      if (!st.can_send_back || idx === 0) err(409, 'WF_NO_SEND_BACK', `${st.name} can’t send back.`)
      const reason = str(body.reason)
      if (reason.length < 10) err(422, 'REASON_REQUIRED', 'Say what should change (at least 10 characters).', 'reason')
      const prev = snap.stages[idx - 1]
      const who = lastActor(i, prev.key) ?? chainFor(ctx, snap.stages, i.subject_user_id, i.initiated_by)[idx - 1].primary
      if (!who || !isActive(ctx, who)) err(409, 'WF_NO_ASSIGNEE', `Nobody is available to redo “${prev.name}”.`)
      i.history.push({ stage_key: st.key, by: ctx.user.id, action: 'sent_back', note: reason + by, at: nowISO(), to: who })
      enterStage(ctx, i, idx - 1, who!)
      notify(ctx, who!, 'NTF-06', `Sent back: ${prev.name}`, `${ctx.user.name}: “${reason}”`, `/workflows/run/${i.id}`)
      logActivity(ctx, 'wf_instance', i.id, 'sent_back', `${ctx.user.name}${by} sent “${i.title}” back to ${prev.name}: ${reason}`)
      save(ctx, i)
      return detailOf(ctx, i)
    }
    if (action === 'reject') {
      if (st.assignee === 'subject' || st.assignee === 'initiator') err(409, 'WF_NO_REJECT', 'This stage can submit but not reject. Ask HR to cancel the workflow instead.')
      const reason = str(body.reason)
      if (reason.length < 10) err(422, 'REASON_REQUIRED', 'Say why it is rejected (at least 10 characters).', 'reason')
      i.history.push({ stage_key: st.key, by: ctx.user.id, action: 'rejected', note: reason + by, at: nowISO() })
      i.status = 'rejected'
      i.current_assignee_id = null
      i.stage_due_on = null
      i.completed_at = nowISO()
      runActions(ctx, i, snap.on_reject.filter((a) => a.type !== 'update_ctc'))
      logActivity(ctx, 'wf_instance', i.id, 'rejected', `${ctx.user.name}${by} rejected “${i.title}”: ${reason}`)
      save(ctx, i)
      return detailOf(ctx, i)
    }
    err(422, 'VALIDATION', 'Unknown action.', 'action')
  })

  r.post('/wf/instances/:id/reassign', ({ ctx, params, body }) => {
    requireAction(ctx, 'workflows.design', 'Only workflow designers can reassign a step.')
    const i = getVisible(ctx, params.id)
    if (i.status !== 'in_progress') err(409, 'WF_CLOSED', 'Only running workflows can be reassigned.')
    const to = str(body.user_id)
    if (!isActive(ctx, to)) err(422, 'VALIDATION', 'Choose an active person.', 'user_id')
    if (to === i.current_assignee_id) err(422, 'VALIDATION', 'That person already has this step.', 'user_id')
    const snap = snapOf(ctx, i)
    const st = snap.stages[i.current_stage]
    if (to === i.subject_user_id && st.assignee !== 'subject') err(422, 'VALIDATION', 'The employee can’t review their own workflow.', 'user_id')
    const note = str(body.note)
    if (note.length < 5) err(422, 'REASON_REQUIRED', 'Say why you are reassigning (at least 5 characters).', 'note')
    const from = i.current_assignee_id
    i.history.push({ stage_key: st.key, by: ctx.user.id, action: 'reassigned', note: `${userName(ctx, from)} → ${userName(ctx, to)}: ${note}`, at: nowISO(), to })
    enterStage(ctx, i, i.current_stage, to)
    if (from && from !== ctx.user.id) notify(ctx, from, 'NTF-06', 'Workflow step reassigned', `${i.title}: ${st.name} moved to ${userName(ctx, to)}.`, `/workflows/run/${i.id}`)
    logActivity(ctx, 'wf_instance', i.id, 'reassigned', `${ctx.user.name} reassigned ${st.name} on “${i.title}” to ${userName(ctx, to)}`)
    save(ctx, i)
    return detailOf(ctx, i)
  })

  r.post('/wf/instances/:id/cancel', ({ ctx, params, body }) => {
    const i = getVisible(ctx, params.id)
    if (i.initiated_by !== ctx.user.id && !has(ctx, 'workflows.design')) err(403, 'FORBIDDEN', 'Only the person who started it or a workflow designer can cancel it.')
    if (i.status !== 'in_progress') err(409, 'WF_CLOSED', `This workflow is already ${i.status.replace('_', ' ')}.`)
    const reason = str(body.reason)
    if (reason.length < 10) err(422, 'REASON_REQUIRED', 'Say why you are cancelling (at least 10 characters).', 'reason')
    const snap = snapOf(ctx, i)
    i.history.push({ stage_key: snap.stages[i.current_stage]?.key ?? '', by: ctx.user.id, action: 'cancelled', note: reason, at: nowISO() })
    const was = i.current_assignee_id
    i.status = 'cancelled'
    i.current_assignee_id = null
    i.stage_due_on = null
    if (was && was !== ctx.user.id) notify(ctx, was, 'NTF-06', 'Workflow cancelled', `${i.title}: ${reason}`, `/workflows/run/${i.id}`)
    logActivity(ctx, 'wf_instance', i.id, 'cancelled', `${ctx.user.name} cancelled “${i.title}”: ${reason}`)
    update(ctx, 'wf_instances', i.id, {} as never)
    return detailOf(ctx, i)
  })

  r.post('/wf/instances/:id/comments', ({ ctx, params, body }) => {
    const i = getVisible(ctx, params.id)
    const text = str(body.body)
    if (text.length < 2) err(422, 'VALIDATION', 'Write a comment first.', 'body')
    if (text.length > 2000) err(422, 'VALIDATION', 'Keep comments under 2,000 characters.', 'body')
    i.comments = [...(i.comments ?? []), { id: uid('c'), by: ctx.user.id, at: nowISO(), body: text }]
    const others = new Set([i.initiated_by, i.current_assignee_id, ...i.history.map((h) => h.by)].filter((x): x is string => !!x && x !== ctx.user.id && x !== 'system' && isActive(ctx, x)))
    for (const o of others) notify(ctx, o, 'NTF-03', `Comment on ${i.title}`, `${ctx.user.name}: “${text.slice(0, 90)}”`, `/workflows/run/${i.id}`)
    update(ctx, 'wf_instances', i.id, {} as never)
    return detailOf(ctx, i)
  })
}
