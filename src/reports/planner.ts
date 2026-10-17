// Deterministic natural-language → ReportSpec planner (the "Rules" path).
// Used by POST /ai/plan when no LLM is available, and as the safety net when the LLM's spec is
// unusable. It never produces numbers — only a spec for the engine to run.
import type { DatasetId, Dimension, Filter, Measure, ReportSpec, TimeGrain } from '@/types/reports'
import { addDays, addMonths, fyLabel, fyStartYear, monthRange, monthOf, quarterOf, weekStart } from '@/domain/calendar'
import { DATASET_MAP, fieldOf, type DatasetDefX } from './datasets'

export interface PlannerEntities {
  people: { name: string; role: string }[]
  projects: { name: string; code: string; client: string }[]
  clients: string[]
  products: string[]
  categories: string[]
}
export interface PlanCtx {
  today: string
  fyStart: number
  /** Persona — only picks default suggestions. */
  role: string
  /** The viewer only sees their own rows (no team / company scope) — "documents not acknowledged" means mine. */
  personal?: boolean
  /** dataset defs visible to this viewer (grant-stripped) */
  datasets: DatasetDefX[]
  entities: PlannerEntities
  me: string
}
export interface Plan {
  spec: ReportSpec
  explanation: string
  confidence: number
  intent: string
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MON3 = MONTHS.map((m) => m.slice(0, 3))
const WORDNUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 }

const has = (q: string, ...words: (string | RegExp)[]) => words.some((w) => (typeof w === 'string' ? new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q) : w.test(q)))

/* ---------------- period ---------------- */
interface PeriodHit {
  period: ReportSpec['period']
  label: string
  grainHint?: TimeGrain
}
export function parsePeriod(q: string, today: string, fyStart: number): PeriodHit | null {
  const fy = fyStartYear(today, fyStart)
  const mnum = (s: string) => WORDNUM[s] ?? Number(s)
  let m: RegExpMatchArray | null
  if (has(q, 'all time', 'ever', 'since inception', 'to date overall')) return { period: { preset: 'all' }, label: 'All time' }
  if (has(q, 'today')) return { period: { from: today, to: today }, label: 'Today' }
  if (has(q, 'this week', 'current week')) return { period: { from: weekStart(today), to: addDays(weekStart(today), 6) }, label: 'This week' }
  if (has(q, 'last week', 'previous week', 'past week')) {
    const w = addDays(weekStart(today), -7)
    return { period: { from: w, to: addDays(w, 6) }, label: 'Last week' }
  }
  if ((m = q.match(/\b(?:last|past|previous|trailing)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+weeks?\b/))) {
    const n = mnum(m[1])
    return { period: { from: addDays(weekStart(today), -7 * (n - 1)), to: addDays(weekStart(today), 6) }, label: `Last ${n} weeks`, grainHint: 'week' }
  }
  if ((m = q.match(/\b(?:last|past|previous|trailing)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+days?\b/))) {
    const n = mnum(m[1])
    if (n === 30) return { period: { preset: 'last_30_days' }, label: 'Last 30 days' }
    if (n === 90) return { period: { preset: 'last_90_days' }, label: 'Last 90 days' }
    return { period: { from: addDays(today, -(n - 1)), to: today }, label: `Last ${n} days` }
  }
  if ((m = q.match(/\b(?:last|past|previous|trailing)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+months?\b/))) {
    const n = mnum(m[1])
    if (n === 6) return { period: { preset: 'last_6_months' }, label: 'Last 6 months', grainHint: 'month' }
    if (n === 12) return { period: { preset: 'last_12_months' }, label: 'Last 12 months', grainHint: 'month' }
    const from = addMonths(`${monthOf(today)}-01`, -(n - 1))
    return { period: { from, to: monthRange(monthOf(today)).to }, label: `Last ${n} months`, grainHint: 'month' }
  }
  if (has(q, 'last 12 months', 'past 12 months', 'past year', 'last one year', 'trailing twelve months', 'ttm')) return { period: { preset: 'last_12_months' }, label: 'Last 12 months', grainHint: 'month' }
  if (has(q, 'this month', 'current month', 'mtd', 'month to date', 'so far this month')) return { period: { preset: 'this_month' }, label: 'This month' }
  if (has(q, 'last month', 'previous month', 'past month')) return { period: { preset: 'last_month' }, label: 'Last month' }
  if (has(q, 'this quarter', 'current quarter', 'qtd', 'quarter to date')) return { period: { preset: 'this_quarter' }, label: 'This quarter' }
  if (has(q, 'last quarter', 'previous quarter', 'past quarter')) return { period: { preset: 'last_quarter' }, label: 'Last quarter' }
  if (has(q, 'ytd', 'year to date', 'fy to date', 'so far this year')) return { period: { preset: 'ytd' }, label: 'Financial year to date' }
  if (has(q, 'last fy', 'last financial year', 'previous financial year', 'last year', 'previous year', 'prior year')) return { period: { preset: 'last_fy' }, label: fyLabel(fy - 1) }
  if (has(q, 'this fy', 'this financial year', 'current financial year', 'this year', 'current fy', 'this fiscal', 'fiscal year', 'financial year', 'annual', 'fy')) {
    // explicit FY label like fy25-26
    const fm = q.match(/\bfy\s?'?(\d{2})\s?[-/]\s?(\d{2})\b/)
    if (fm) {
      const y = 2000 + Number(fm[1])
      return { period: { from: `${y}-${String(fyStart).padStart(2, '0')}-01`, to: addDays(addMonths(`${y}-${String(fyStart).padStart(2, '0')}-01`, 12), -1) }, label: fyLabel(y) }
    }
    return { period: { preset: 'this_fy' }, label: fyLabel(fy) }
  }
  // Q1..Q4 [FY]
  if ((m = q.match(/\bq([1-4])\b(?:\s*(?:of\s*)?(?:fy\s?'?(\d{2})(?:\s?[-/]\s?\d{2})?|(20\d{2})))?/))) {
    const qn = Number(m[1])
    let y = fy
    if (m[2]) y = 2000 + Number(m[2])
    else if (m[3]) y = Number(m[3])
    const fyFrom = `${y}-${String(fyStart).padStart(2, '0')}-01`
    const from = addMonths(fyFrom, (qn - 1) * 3)
    const to = addDays(addMonths(from, 3), -1)
    return { period: { from, to }, label: quarterOf(from, fyStart).label }
  }
  // month names: "in august", "sep 2026", "august and september"
  const mi = MONTHS.findIndex((mm, i) => new RegExp(`\\b(${mm}|${MON3[i]})\\b`).test(q))
  if (mi >= 0 && !has(q, 'may be', 'maybe')) {
    const ym = q.match(new RegExp(`\\b(?:${MONTHS[mi]}|${MON3[mi]})\\s*,?\\s*(20\\d{2})\\b`))
    let y = ym ? Number(ym[1]) : Number(today.slice(0, 4))
    if (!ym && `${y}-${String(mi + 1).padStart(2, '0')}` > monthOf(today)) y -= 1
    const ym2 = `${y}-${String(mi + 1).padStart(2, '0')}`
    // range "from july to september"
    const mj = MONTHS.findIndex((mm, i) => i !== mi && new RegExp(`\\b(${mm}|${MON3[i]})\\b`).test(q))
    if (mj >= 0 && has(q, 'to', 'through', 'till', 'until', '-', 'and')) {
      const a = Math.min(mi, mj)
      const b = Math.max(mi, mj)
      let ya = y
      if (`${ya}-${String(b + 1).padStart(2, '0')}` > monthOf(today)) ya -= 1
      const from = `${ya}-${String(a + 1).padStart(2, '0')}-01`
      const to = monthRange(`${ya}-${String(b + 1).padStart(2, '0')}`).to
      return { period: { from, to }, label: `${MONTHS[a].slice(0, 3)}–${MONTHS[b].slice(0, 3)} ${ya}`.replace(/^./, (c) => c.toUpperCase()), grainHint: 'month' }
    }
    const r = monthRange(ym2)
    return { period: { from: r.from, to: r.to }, label: `${MONTHS[mi][0].toUpperCase()}${MONTHS[mi].slice(1)} ${y}` }
  }
  if ((m = q.match(/\b(?:in|for|during)\s+(20\d{2})\b/))) {
    const y = Number(m[1])
    return { period: { from: `${y}-01-01`, to: `${y}-12-31` }, label: String(y) }
  }
  return null
}

/* ---------------- grains ---------------- */
function parseGrain(q: string): TimeGrain | null {
  if (has(q, 'daily', 'by day', 'per day', 'each day', 'day by day', 'day-wise', 'daywise')) return 'day'
  if (has(q, 'weekly', 'by week', 'per week', 'each week', 'week by week', 'week-wise', 'weekwise', 'week on week', 'wow')) return 'week'
  if (has(q, 'quarterly', 'by quarter', 'per quarter', 'each quarter', 'quarter-wise', 'qoq', 'quarter on quarter')) return 'quarter'
  if (has(q, 'yearly', 'by year', 'per year', 'by fy', 'year on year', 'yoy', 'annually', 'each year')) return 'fy'
  if (has(q, 'monthly', 'by month', 'per month', 'each month', 'month by month', 'month-wise', 'monthwise', 'mom', 'month on month', 'trend', 'over time', 'timeline', 'trajectory')) return 'month'
  return null
}

/* ---------------- entity matching ---------------- */
function words(s: string) {
  return s.toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9&]+/).filter(Boolean)
}
const STOP = new Set(['the', 'of', 'and', 'for', 'group', 'ltd', 'limited', 'services', 'pvt', 'private', 'app', 'phase', 'system', 'management', 'support', 'solutions', 'consulting', 'it', 'v2', 'website', 'school', 'schools', 'portal', 'mining', 'hrms', 'sap', 'ams', 'sales', 'crm', 'project', 'document'])
function matchPerson(q: string, people: PlannerEntities['people'], me: string): string | null {
  if (has(q, 'my', 'mine', 'me', 'i', "i've", 'myself')) {
    // "my team" is not me
    if (!has(q, 'my team', 'my reports', 'my people', 'my projects')) return me
  }
  const qw = new Set(words(q))
  let best: { name: string; score: number } | null = null
  for (const p of people) {
    const pw = words(p.name)
    const full = q.includes(p.name.toLowerCase())
    const first = pw[0] && qw.has(pw[0]) && pw[0].length > 2
    const firstUnique = first && people.filter((x) => words(x.name)[0] === pw[0]).length === 1
    const score = full ? 3 : firstUnique ? 2 : 0
    if (score && (!best || score > best.score)) best = { name: p.name, score }
  }
  return best?.name ?? null
}
function matchProject(q: string, projects: PlannerEntities['projects']) {
  const qw = new Set(words(q))
  let best: { v: { name: string; code: string; client: string }; score: number } | null = null
  for (const p of projects) {
    if (q.includes(p.code.toLowerCase())) return p
    const nw = words(p.name).filter((w) => w.length > 2 && !STOP.has(w))
    const hits = nw.filter((w) => qw.has(w)).length
    const score = nw.length ? hits / nw.length + hits * 0.2 : 0
    if (hits && score > 0.45 && (!best || score > best.score)) best = { v: p, score }
  }
  return best?.v ?? null
}
function matchText(q: string, list: string[]): string | null {
  const qw = new Set(words(q))
  let best: { v: string; score: number } | null = null
  for (const c of list) {
    if (!c) continue
    if (q.includes(c.toLowerCase())) return c
    const cw = words(c).filter((w) => w.length > 2 && !STOP.has(w))
    const hits = cw.filter((w) => qw.has(w)).length
    if (hits && (!best || hits > best.score) && hits / cw.length >= 0.5) best = { v: c, score: hits }
  }
  return best?.v ?? null
}

/* ---------------- group-by detection ---------------- */
const DIM_WORDS: { re: RegExp; field: Record<string, string> }[] = [
  { re: /\b(stream|business line|line of business|revenue stream|segment)s?\b/, field: { ledger: 'stream', invoices: 'stream', projects: 'stream' } },
  { re: /\b(client|customer|account)s?\b/, field: { ledger: 'client', invoices: 'client', projects: 'client', deals: 'client', hours: 'client', tasks: 'client', milestones: 'client', deal_activities: 'client', revenue_leakage: 'client' } },
  { re: /\b(project)s?\b/, field: { hours: 'project', tasks: 'project', milestones: 'project', invoices: 'project', ledger: 'project', allocations: 'project', task_reviews: 'project', expenses: 'project', purchases: 'project', revenue_leakage: 'project', documents: 'project' } },
  { re: /\b(person|people|employee|employees|member|members|resource|resources|developer|developers|individual|who|each one|everyone|staff)\b/, field: { hours: 'person', tasks: 'owner', allocations: 'person', payroll: 'person', deals: 'owner', deal_activities: 'owner', people: 'name', ops: 'owner', task_reviews: 'owner', leave_requests: 'person', expenses: 'person', appraisals: 'person', okr_key_results: 'owner' } },
  { re: /\b(owner|assignee|salesperson|salespeople|sales person|rep|reps)s?\b/, field: { tasks: 'owner', deals: 'owner', deal_activities: 'owner', ops: 'owner', task_reviews: 'owner', okr_key_results: 'owner', documents: 'owner' } },
  { re: /\b(reviewer|reviewers|approver|approvers)\b/, field: { tasks: 'reviewer', task_reviews: 'reviewer', leave_requests: 'approver', expenses: 'approver', purchases: 'approver' } },
  { re: /\b(assigner|assigners|assigned by|line manager)\b/, field: { tasks: 'assigned_by' } },
  { re: /\b(stage)s?\b/, field: { deals: 'stage', deal_activities: 'stage', candidates: 'stage' } },
  { re: /\b(source|channel|lead source)s?\b/, field: { deals: 'source', candidates: 'source' } },
  { re: /\b(product)s?\b/, field: { deals: 'product' } },
  { re: /\b(department|dept|function|team)s?\b/, field: { payroll: 'department', people: 'department', hours: 'department' } },
  { re: /\b(category|categories|head|heads)\b/, field: { ledger: 'category', ops: 'category', expenses: 'category', purchases: 'category', vendor_bills: 'category', budget_vs_actual: 'category', documents: 'category' } },
  { re: /\b(status|statuses|state)\b/, field: { tasks: 'status', projects: 'status', milestones: 'state', invoices: 'status', deals: 'stage', ops: 'status', leave_requests: 'status', expenses: 'status', purchases: 'status', vendor_bills: 'status', revenue_leakage: 'status', appraisals: 'status', okr_key_results: 'status', task_reviews: 'decision', candidates: 'stage' } },
  { re: /\b(type|kind|activity type)s?\b/, field: { hours: 'kind', projects: 'type', deal_activities: 'type', ledger: 'kind', leave_requests: 'type', revenue_leakage: 'kind', budget_vs_actual: 'kind', tasks: 'kind' } },
  { re: /\b(complexity)\b/, field: { tasks: 'complexity' } },
  { re: /\b(pm|pms|project manager|project managers|manager|managers)\b/, field: { projects: 'pm', milestones: 'pm', people: 'manager', appraisals: 'manager', leave_requests: 'manager' } },
  { re: /\b(milestone)s?\b/, field: { tasks: 'milestone', allocations: 'milestone' } },
  { re: /\b(health)\b/, field: { projects: 'health' } },
  { re: /\b(billing model|commercial model|model)\b/, field: { projects: 'billing_model' } },
  { re: /\b(role)s?\b/, field: { people: 'role', payroll: 'role', candidates: 'opening' } },
  { re: /\b(opening|openings|position|positions|vacancy|vacancies)\b/, field: { candidates: 'opening' } },
  { re: /\b(leave type)s?\b/, field: { hours: 'leave_type', leave_requests: 'type' } },
  { re: /\b(internal activity|activity)\b/, field: { hours: 'internal_code' } },
  { re: /\b(vendor|vendors|supplier|suppliers)\b/, field: { purchases: 'vendor', vendor_bills: 'vendor' } },
  { re: /\b(cycle|cycles)\b/, field: { appraisals: 'cycle' } },
  { re: /\b(level|levels)\b/, field: { okr_key_results: 'level' } },
  { re: /\b(objective|objectives)\b/, field: { okr_key_results: 'objective' } },
  { re: /\b(metric|metrics)\b/, field: { okr_key_results: 'metric' } },
  { re: /\b(period|periods)\b/, field: { okr_key_results: 'period' } },
  { re: /\b(priority|priorities)\b/, field: { tasks: 'priority' } },
  { re: /\b(delay reason|reason|reasons)\b/, field: { tasks: 'delay_reason', task_reviews: 'decision_reason' } },
  { re: /\b(timeliness)\b/, field: { tasks: 'timeliness' } },
  { re: /\b(decision|decisions|outcome|outcomes)\b/, field: { task_reviews: 'decision' } },
]
function groupPhrase(q: string): string | null {
  const m = q.match(/\b(?:by|per|for each|each|across|split by|broken down by|breakdown by|grouped by|group by|wise|vs\.? each)\s+([a-z &]+?)(?=\s+(?:this|last|in|for|during|over|since|from|and|with|where|top|sorted|order|q[1-4])\b|[?.,]|$)/)
  if (m) return m[1]
  const w = q.match(/\b([a-z]+)[- ]wise\b/)
  return w ? w[1] : null
}
function detectDims(q: string, ds: DatasetId, avoid: Set<string>): string[] {
  const out: string[] = []
  const phrase = groupPhrase(q)
  const scan = (text: string) => {
    for (const d of DIM_WORDS) {
      const f = d.field[ds]
      if (f && d.re.test(text) && !out.includes(f) && !avoid.has(f)) out.push(f)
    }
  }
  if (phrase) scan(phrase)
  // "which clients…", "top 5 people…"
  const lead = q.match(/\b(?:which|what|top\s+\d+|bottom\s+\d+|best|worst|each)\s+([a-z ]+?)(?=\s+(?:has|have|had|is|are|by|with|in|on|this|last|below|above|over|under)\b|$)/)
  if (!out.length && lead) scan(lead[1])
  return out
}

/* ---------------- dataset choice ---------------- */
function scoreDatasets(q: string, visible: DatasetDefX[]): { id: DatasetId; score: number }[] {
  return visible
    .map((d) => {
      let s = 0
      for (const a of d.aliases) if (has(q, a)) s += a.includes(' ') ? 3 : 2
      return { id: d.id, score: s }
    })
    .sort((a, b) => b.score - a.score)
}

/* ---------------- helpers ---------------- */
function topN(q: string): { n: number; dir: 'asc' | 'desc' } | null {
  const m = q.match(/\b(top|bottom|best|worst|highest|lowest|largest|smallest|biggest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b/)
  if (m) return { n: WORDNUM[m[2]] ?? Number(m[2]), dir: /bottom|worst|lowest|smallest/.test(m[1]) ? 'asc' : 'desc' }
  if (has(q, 'top', 'biggest', 'largest', 'highest', 'most')) return { n: 10, dir: 'desc' }
  if (has(q, 'lowest', 'least', 'smallest', 'bottom', 'fewest')) return { n: 10, dir: 'asc' }
  return null
}
function pctNumber(q: string, near: RegExp): number | null {
  const m = q.match(near)
  if (!m) return null
  return Number(m[1]) / 100
}
function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

/* ---------------- v3 business intents ---------------- */
interface V3Plan {
  dataset: DatasetId
  intent: string
  measures?: Measure[]
  dims?: Dimension[]
  filters?: Filter[]
  columns?: string[]
  sort?: ReportSpec['sort']
  chart?: ReportSpec['chart']
  title: string
  period?: ReportSpec['period'] | null // null = clear any parsed period
  confidence?: number
  limit?: number
}
const label = (ds: DatasetId, f: string) => (fieldOf(DATASET_MAP[ds], f)?.label ?? f).toLowerCase()
const byTitle = (ds: DatasetId, dims: Dimension[]) => (dims.length ? ' by ' + dims.map((d) => (d.grain ? d.grain : label(ds, d.field))).join(' and ') : '')
const TASKISH = ['task', 'tasks', 'work', 'work items', 'deliverables', 'delivery', 'deliveries', 'assignments']
const LEAKAGE_WORDS: [string[], string][] = [
  [['write off', 'write-off', 'write offs', 'write-offs', 'written off'], 'write_off'], [['bad debt', 'bad debts', 'bad-debt'], 'bad_debt'], [['discount', 'discounts'], 'discount'],
  [['credit note', 'credit notes'], 'credit_note'], [['penalty', 'penalties'], 'penalty'], [['unbilled hours', 'unbilled'], 'unbilled_hours'], [['scope creep'], 'scope_creep'], [['churn', 'churned'], 'churn'],
]

/** v3 topics the viewer asked about but cannot see (so the answer can say so instead of guessing silently). */
function restrictedTopic(q: string, can: (id: DatasetId) => boolean): string | null {
  const topics: [DatasetId, string, (string | RegExp)[]][] = [
    ['budget_vs_actual', 'Budget vs actual', ['budget', 'budgets', 'over budget', 'overspent', 'overspend']],
    ['revenue_leakage', 'Revenue leakage', ['lost revenue', 'revenue lost', 'leakage', 'write off', 'write-off', 'bad debt']],
    ['vendor_bills', 'Vendor bills', ['bill', 'bills', 'vendor bill', 'vendor bills', 'payables']],
    ['purchases', 'Purchase orders', ['po', 'pos', 'purchase order', 'purchase orders']],
    ['appraisals', 'Appraisal', ['appraisal', 'appraisals', 'increment', 'increments']],
    ['candidates', 'Recruitment', ['candidate', 'candidates', 'applicants', 'recruitment', 'hiring']],
  ]
  const hit = topics.find(([id, , words]) => !can(id) && has(q, ...words))
  return hit ? hit[1] : null
}

function planV3(q: string, pc: PlanCtx, per: PeriodHit | null, grain: TimeGrain | null, can: (id: DatasetId) => boolean): V3Plan | null {
  const dimsOf = (ds: DatasetId, fallback: string | null, avoid: string[] = []): Dimension[] => {
    const d = detectDims(q, ds, new Set(avoid))
    const mine = has(q, 'my', 'mine', 'me', 'i') && (fallback === 'owner' || fallback === 'person')
    return d.length ? d.slice(0, 2).map((field) => ({ field })) : fallback && !grain && !mine ? [{ field: fallback }] : []
  }
  const withField = (field: string, dflt?: ReportSpec['period']) => (per?.period ? { ...per.period, field } : dflt ? { ...dflt, field } : undefined)
  const listing = has(q, 'list', 'show me the', 'which', 'what are', 'details')
  const tasky = has(q, ...TASKISH)
  const employeeish = pc.personal ?? (pc.role === 'employee' || pc.role === 'sales')

  /* ----- task governance ----- */
  if (can('tasks') && tasky && has(q, 'completed late', 'finished late', 'delivered late', 'done late', 'closed late', 'submitted late', 'late completion', 'late completions', 'missed due date', 'missed due dates', 'late deliveries', 'late delivery')) {
    const dims = dimsOf('tasks', 'owner')
    return {
      dataset: 'tasks', intent: 'tasks_late', title: `Tasks completed late${byTitle('tasks', dims)}`, dims,
      measures: [{ field: '*', agg: 'count', label: 'Completed late' }, { field: 'variance_days', agg: 'avg', label: 'Average working days late' }, { field: 'variance_days', agg: 'max', label: 'Most days late' }],
      filters: [{ field: 'status', op: 'eq', value: 'done' }, { field: 'is_late', op: 'eq', value: true }], period: withField('done_on', { preset: 'this_fy' }), chart: dims.length && !dims.some((d) => d.grain) ? 'table' : undefined, confidence: 0.9,
    }
  }
  if (can('tasks') && (has(q, 'on-time delivery', 'on time delivery', 'on-time rate', 'on time rate', 'on-time %', 'on time %', 'on-time percentage', 'on time percentage', 'delivered on time', 'finished on time', 'completed on time', 'timeliness', 'punctuality', 'early or late', 'early vs late', 'deadline adherence') || (has(q, 'on time', 'on-time') && tasky))) {
    if (has(q, 'early or late', 'early vs late', 'timeliness split', 'timeliness mix') && !detectDims(q, 'tasks', new Set()).length) {
      return { dataset: 'tasks', intent: 'timeliness_mix', title: 'Completed tasks by timeliness', dims: [{ field: 'timeliness' }], measures: [{ field: '*', agg: 'count', label: 'Tasks' }], filters: [{ field: 'status', op: 'eq', value: 'done' }], period: withField('done_on', { preset: 'this_fy' }), chart: 'pie', confidence: 0.85 }
    }
    const dims = dimsOf('tasks', grain ? null : 'owner')
    return {
      dataset: 'tasks', intent: 'on_time_delivery', title: `On-time delivery${byTitle('tasks', dims)}`, dims,
      measures: [{ field: 'on_time_rate', agg: 'avg', label: 'On-time delivery' }, { field: '*', agg: 'count', label: 'Tasks completed' }, { field: 'is_late', agg: 'sum', label: 'Completed late' }],
      filters: [{ field: 'status', op: 'eq', value: 'done' }], period: withField('done_on', { preset: 'this_fy' }), sort: dims.length ? [{ field: 'avg_on_time_rate', dir: 'desc' }] : undefined, confidence: 0.9,
    }
  }
  if (can('tasks') && (has(q, 'delay reason', 'delay reasons', 'reason for delay', 'reasons for delay', 'reasons for delays', 'causes of delay', 'cause of delay', 'why delayed', 'why late', 'why are tasks late', 'what is delaying', "what's delaying", 'what delays') || (has(q, 'why') && has(q, 'delayed', 'delay', 'delays', 'late', 'slipping', 'slip')))) {
    const extra = detectDims(q, 'tasks', new Set(['delay_reason']))
    const dims: Dimension[] = [{ field: 'delay_reason' }, ...extra.slice(0, 1).map((field) => ({ field }))]
    return {
      dataset: 'tasks', intent: 'delay_reasons', title: `Why tasks are delayed${extra.length ? ' — by ' + label('tasks', extra[0]) : ''}`, dims,
      measures: [{ field: '*', agg: 'count', label: 'Tasks' }],
      filters: [{ field: 'delay_reason', op: 'not_empty' }], period: per?.period ? { ...per.period, field: 'due_on' } : undefined, chart: extra.length ? 'stacked' : 'hbar', confidence: 0.9,
    }
  }
  if ((can('task_reviews') || can('tasks')) && has(q, 'sent back', 'send back', 'send-back', 'send-backs', 'sendbacks', 'sent-back', 'rework', 'reworked', 'returned for rework', 'rejected tasks', 'tasks rejected', 'bounced back', 'first pass', 'first-pass')) {
    if (can('task_reviews')) {
      const asks = has(q, 'by reviewer', 'per reviewer', 'reviewer wise', 'reviewer-wise', 'by approver', 'by whom', 'by the reviewer', 'sent back by')
      const dims = asks ? [{ field: 'reviewer' }, ...detectDims(q, 'task_reviews', new Set(['reviewer'])).slice(0, 1).map((field) => ({ field }))] : dimsOf('task_reviews', 'owner')
      if (listing && !asks && !detectDims(q, 'task_reviews', new Set()).length)
        return { dataset: 'task_reviews', intent: 'sent_back_list', title: 'Tasks sent back', columns: ['decided_at', 'task', 'project', 'owner', 'reviewer', 'round', 'decision_reason'], filters: [{ field: 'is_sent_back', op: 'eq', value: true }], sort: [{ field: 'decided_at', dir: 'desc' }], chart: 'table', period: withField('decided_at'), confidence: 0.85 }
      return {
        dataset: 'task_reviews', intent: 'sent_back', title: `Tasks sent back${byTitle('task_reviews', dims)}`, dims,
        measures: [{ field: '*', agg: 'count', label: 'Times sent back' }], filters: [{ field: 'is_sent_back', op: 'eq', value: true }], period: withField('decided_at'), confidence: 0.9,
      }
    }
  }
  if (can('tasks') && (has(q, 'quality rating', 'quality ratings', 'quality score', 'work quality', 'quality of work', 'review rating', 'review ratings') || (has(q, 'quality') && (tasky || has(q, 'person', 'people', 'team', 'employee', 'employees', 'developer', 'developers', 'reviewer'))))) {
    const dims = dimsOf('tasks', grain ? null : 'owner')
    return {
      dataset: 'tasks', intent: 'quality', title: `Average quality rating${byTitle('tasks', dims)}`, dims,
      measures: [{ field: 'quality_rating', agg: 'avg', label: 'Average quality (1–5)' }],
      filters: [{ field: 'quality_rating', op: 'not_empty' }], period: withField('done_on'), sort: dims.length && !grain ? [{ field: 'avg_quality_rating', dir: 'desc' }] : undefined, confidence: 0.9,
    }
  }
  if (can('tasks') && tasky && has(q, 'in review', 'awaiting review', 'pending review', 'waiting for review', 'under review', 'to review', 'need review', 'needs review')) {
    return { dataset: 'tasks', intent: 'in_review', title: 'Tasks waiting for review', columns: ['code', 'title', 'project', 'owner', 'reviewer', 'submitted_on', 'due_on', 'review_rounds'], filters: [{ field: 'is_in_review', op: 'eq', value: true }], sort: [{ field: 'submitted_on', dir: 'asc' }], chart: 'table', period: null, confidence: 0.85 }
  }

  /* ----- leave ----- */
  const leavey = has(q, 'leave', 'leaves', 'time off', 'vacation', 'vacations', 'absence', 'absences', 'pto')
  if (can('leave_requests') && leavey && !has(q, 'hour', 'hours', 'timesheet', 'timesheets', 'leave without pay cost')) {
    if (has(q, 'pending', 'awaiting', 'to approve', 'waiting', 'unapproved', 'not approved', 'open')) {
      return { dataset: 'leave_requests', intent: 'leave_pending', title: 'Leave requests waiting for a decision', columns: ['person', 'type', 'from_on', 'to_on', 'days', 'approver', 'applied_on'], filters: [{ field: 'status', op: 'eq', value: 'pending' }], sort: [{ field: 'from_on', dir: 'asc' }], chart: 'table', period: per?.period ?? null, confidence: 0.9 }
    }
    if (has(q, 'rejected', 'declined', 'refused')) {
      return { dataset: 'leave_requests', intent: 'leave_rejected', title: 'Rejected leave requests', columns: ['person', 'type', 'from_on', 'to_on', 'days', 'decided_by', 'decision_reason'], filters: [{ field: 'status', op: 'eq', value: 'rejected' }], sort: [{ field: 'from_on', dir: 'desc' }], chart: 'table', period: per?.period ?? undefined, confidence: 0.85 }
    }
    if (has(q, 'leave request', 'leave requests', 'leave applications', 'leave application', 'my leave', 'my leaves') && !has(q, 'taken', 'used', 'days', 'how many', 'total') && !detectDims(q, 'leave_requests', new Set()).length) {
      return { dataset: 'leave_requests', intent: 'leave_requests', title: 'Leave requests', columns: ['person', 'type', 'from_on', 'to_on', 'days', 'status', 'decided_by', 'decision_reason'], filters: [], sort: [{ field: 'from_on', dir: 'desc' }], chart: 'table', period: per?.period ?? null, confidence: 0.85 }
    }
    if (listing || has(q, 'upcoming', 'who is on leave', "who's on leave", 'who is off', 'on leave next', 'on leave this', 'on leave today')) {
      const upcoming = has(q, 'upcoming', 'next', 'coming')
      return { dataset: 'leave_requests', intent: 'leave_list', title: upcoming ? 'Upcoming leave' : 'Leave requests', columns: ['person', 'type', 'from_on', 'to_on', 'days', 'status', 'decided_by'], filters: [{ field: 'status', op: 'in', value: ['approved', 'pending'] }], sort: [{ field: 'from_on', dir: 'asc' }], chart: 'table', period: per?.period ?? (upcoming ? { from: pc.today, to: addDays(pc.today, 30) } : { preset: 'this_month' }), confidence: 0.8 }
    }
    const dims = dimsOf('leave_requests', grain ? null : has(q, 'person', 'people', 'employee', 'who', 'most') ? 'person' : 'type')
    return {
      dataset: 'leave_requests', intent: 'leave_taken', title: `Leave taken${byTitle('leave_requests', dims)}`, dims,
      measures: [{ field: 'days', agg: 'sum', label: 'Leave days' }], filters: [{ field: 'status', op: 'eq', value: 'approved' }], period: withField('from_on', { preset: 'this_fy' }), confidence: 0.85,
    }
  }

  /* ----- spend: budgets, bills, purchase orders, claims ----- */
  const budgetish = has(q, 'vs budget', 'versus budget', 'against budget', 'budget vs actual', 'budget versus actual', 'budget variance', 'over budget', 'overspent', 'overspend', 'overspending', 'under budget', 'within budget', 'exceeded budget', 'exceeded their budget', 'above budget', 'budget utilisation', 'budget utilization', 'budgets') || (has(q, 'budget') && has(q, 'actual', 'spend', 'spent', 'variance', 'category', 'categories', 'used', 'remaining', 'left'))
  if (budgetish && can('budget_vs_actual')) {
    const revenue = has(q, 'revenue', 'income', 'sales target', 'stream', 'streams')
    const over = has(q, 'over budget', 'overspent', 'overspend', 'overspending', 'exceeded budget', 'exceeded their budget', 'above budget', 'over-budget', 'breached')
    const measures: Measure[] = [{ field: 'budget', agg: 'sum', label: 'Budget' }, { field: 'actual', agg: 'sum', label: 'Actual' }, { field: 'variance', agg: 'sum', label: revenue ? 'Variance (actual − budget)' : 'Variance (budget − actual)' }]
    const filters: Filter[] = [{ field: 'kind', op: 'eq', value: revenue ? 'revenue' : 'expense' }]
    if (over && !revenue) filters.push({ field: 'over_budget_ytd', op: 'eq', value: true })
    const dims = dimsOf('budget_vs_actual', 'category', ['kind'])
    return {
      dataset: 'budget_vs_actual', intent: over ? 'over_budget' : 'budget_vs_actual', title: over && !revenue ? 'Categories over budget' : `${revenue ? 'Revenue' : 'Spend'} vs budget${byTitle('budget_vs_actual', dims)}`, dims, measures, filters,
      // a budget table (budget, actual, variance side by side) reads better than a 3-series chart with negative variance
      period: per?.period ?? { preset: 'this_fy' }, sort: dims.length && !dims.some((d) => d.grain) ? [{ field: 'sum_variance', dir: 'asc' }] : undefined, chart: dims.some((d) => d.grain) || grain ? 'bar' : dims.length ? 'table' : 'kpi', confidence: 0.9,
    }
  }
  if (budgetish && !can('budget_vs_actual') && can('expenses') && has(q, 'over budget', 'overspent', 'overspend', 'overspending', 'exceeded budget', 'above budget', 'outside budget', 'unbudgeted')) {
    const dims = dimsOf('expenses', 'category')
    return { dataset: 'expenses', intent: 'claims_over_budget', title: `Expense claims approved outside budget${byTitle('expenses', dims)}`, dims, measures: [{ field: 'amount', agg: 'sum', label: 'Amount claimed' }, { field: '*', agg: 'count', label: 'Claims' }], filters: [{ field: 'in_budget', op: 'eq', value: false }, { field: 'status', op: 'in', value: ['approved', 'paid'] }], period: withField('spent_on', { preset: 'this_fy' }), confidence: 0.7 }
  }
  if (can('vendor_bills') && has(q, 'bill', 'bills', 'vendor bill', 'vendor bills', 'payable', 'payables', 'creditors', 'vendor payments', 'pay vendors', 'owe vendors', 'we owe')) {
    const d = detectDims(q, 'vendor_bills', new Set())
    const overdue = has(q, 'overdue', 'late', 'past due', 'missed')
    const filters: Filter[] = [{ field: 'is_unpaid', op: 'eq', value: true }, { field: 'status', op: 'in', value: ['received', 'approved'] }]
    if (overdue) filters.push({ field: 'is_overdue', op: 'eq', value: true })
    const paid = has(q, 'paid') && !has(q, 'unpaid', 'to be paid', 'not paid')
    if (paid) filters.splice(0, filters.length, { field: 'status', op: 'eq', value: 'paid' })
    if (d.length) {
      const dims = d.slice(0, 2).map((field) => ({ field }))
      return { dataset: 'vendor_bills', intent: 'bills_by', title: `${paid ? 'Bills paid' : overdue ? 'Overdue bills' : 'Bills to pay'}${byTitle('vendor_bills', dims)}`, dims, measures: [{ field: 'payable', agg: 'sum', label: 'Net payable' }, { field: '*', agg: 'count', label: 'Bills' }], filters, period: per?.period ? { ...per.period, field: paid ? 'paid_on' : 'due_on' } : undefined, confidence: 0.85 }
    }
    const due = has(q, 'due', 'upcoming', 'coming up', 'next', 'to pay', 'payable', 'payables', 'pending')
    return {
      dataset: 'vendor_bills', intent: 'bills_due', title: paid ? 'Bills paid' : overdue ? 'Overdue vendor bills' : `Vendor bills due${per ? ' — ' + per.label.toLowerCase() : ' in the next 30 days'}`,
      columns: ['number', 'vendor', 'po', 'bill_date', 'due_on', 'total', 'tds', 'payable', 'status', 'days_overdue'], filters, sort: [{ field: paid ? 'paid_on' : 'due_on', dir: paid ? 'desc' : 'asc' }], chart: 'table',
      period: per?.period ? { ...per.period, field: paid ? 'paid_on' : 'due_on' } : overdue || paid || !due ? null : { from: addDays(pc.today, -365), to: addDays(pc.today, 30), field: 'due_on' }, confidence: 0.85,
    }
  }
  if (can('purchases') && has(q, 'po', 'pos', 'purchase order', 'purchase orders', 'purchase', 'purchases', 'procurement')) {
    const pending = has(q, 'pending', 'awaiting', 'waiting', 'to approve', 'approval', 'approvals', 'unapproved', 'not approved')
    const d = detectDims(q, 'purchases', new Set())
    if (pending && !d.length)
      return { dataset: 'purchases', intent: 'po_pending', title: 'Purchase orders waiting for approval', columns: ['number', 'title', 'vendor', 'category', 'project', 'amount', 'requested_by', 'raised_on', 'needed_by', 'over_budget'], filters: [{ field: 'is_pending', op: 'eq', value: true }], sort: [{ field: 'raised_on', dir: 'asc' }], chart: 'table', period: null, confidence: 0.9 }
    if (!d.length && (listing || has(q, 'open', 'recent')))
      return { dataset: 'purchases', intent: 'po_list', title: 'Purchase orders', columns: ['number', 'vendor', 'category', 'project', 'amount', 'status', 'requested_by', 'raised_on'], filters: has(q, 'open') ? [{ field: 'status', op: 'eq', value: 'approved' }] : [], sort: [{ field: 'raised_on', dir: 'desc' }], chart: 'table', period: per?.period, confidence: 0.8 }
    const dims = dimsOf('purchases', 'vendor')
    return { dataset: 'purchases', intent: 'po_by', title: `Purchase orders${byTitle('purchases', dims)}`, dims, measures: [{ field: 'amount', agg: 'sum', label: 'PO value' }, { field: '*', agg: 'count', label: 'POs' }], filters: pending ? [{ field: 'is_pending', op: 'eq', value: true }] : [{ field: 'status', op: 'in', value: ['pending', 'approved', 'closed'] }], period: withField('raised_on', { preset: 'this_fy' }), confidence: 0.8 }
  }
  const claimy = has(q, 'reimbursement', 'reimbursements', 'reimburse', 'reimbursed', 'expense claim', 'expense claims', 'claim', 'claims', 'my expenses', 'my expense', 'team expenses', 'out of pocket')
  const expensey = has(q, 'expense', 'expenses', 'spend', 'spent', 'spending')
  if (can('expenses') && (claimy || (expensey && (!can('ledger') || employeeish)))) {
    const unpaid = has(q, 'unpaid', 'not paid', 'not reimbursed', 'yet to be paid', 'to be paid', 'to be reimbursed', 'pending payment', 'pending reimbursement', 'pending reimbursements', 'outstanding', 'due', 'owed')
    const pending = !unpaid && has(q, 'pending', 'awaiting', 'waiting', 'to approve', 'approval', 'unapproved', 'submitted')
    const filters: Filter[] = unpaid ? [{ field: 'is_unpaid', op: 'eq', value: true }] : pending ? [{ field: 'is_pending', op: 'eq', value: true }] : [{ field: 'status', op: 'in', value: ['submitted', 'approved', 'paid'] }]
    if (has(q, 'billable', 'rebillable', 'recharge')) filters.push({ field: 'billable', op: 'eq', value: true })
    if (has(q, 'over budget', 'outside budget', 'not in budget', 'unbudgeted')) filters.push({ field: 'in_budget', op: 'eq', value: false })
    const d = detectDims(q, 'expenses', new Set())
    const what = unpaid ? 'Approved claims not yet reimbursed' : pending ? 'Expense claims waiting for approval' : 'Expense claims'
    if ((unpaid || pending || listing) && !d.length)
      return { dataset: 'expenses', intent: unpaid ? 'claims_unpaid' : pending ? 'claims_pending' : 'claims_list', title: what, columns: ['spent_on', 'person', 'category', 'description', 'project', 'amount', 'approver', 'status'], filters, sort: [{ field: 'spent_on', dir: 'asc' }], chart: 'table', period: per?.period ?? null, confidence: 0.9 }
    const dims = dimsOf('expenses', 'category')
    return { dataset: 'expenses', intent: 'claims_by', title: `${what}${byTitle('expenses', dims)}`, dims, measures: [{ field: 'amount', agg: 'sum', label: 'Amount claimed' }, { field: '*', agg: 'count', label: 'Claims' }], filters, period: withField('spent_on', { preset: 'this_fy' }), confidence: 0.85 }
  }

  /* ----- revenue leakage ----- */
  const leakKind = LEAKAGE_WORDS.find(([w]) => has(q, ...w))?.[1]
  if (can('revenue_leakage') && (has(q, 'lost revenue', 'revenue lost', 'revenue leakage', 'leakage', 'leakages', 'leaking', 'leak', 'leaks', 'money lost', 'money left on the table', 'revenue at risk', 'lost money', 'losses') || (leakKind && !has(q, 'deal', 'deals')))) {
    const filters: Filter[] = leakKind ? [{ field: 'kind', op: 'eq', value: leakKind }] : []
    if (has(q, 'recoverable', 'can recover', 'could recover', 'recover')) filters.push({ field: 'recoverable', op: 'eq', value: true }, { field: 'status', op: 'eq', value: 'open' })
    const d = detectDims(q, 'revenue_leakage', new Set(leakKind ? ['kind'] : []))
    if (listing && !d.length)
      return { dataset: 'revenue_leakage', intent: 'leakage_list', title: 'Revenue leakage items', columns: ['date', 'kind', 'client', 'project', 'amount', 'recovered', 'net', 'status', 'reason'], filters, sort: [{ field: 'net', dir: 'desc' }], chart: 'table', period: withField('date', { preset: 'this_fy' }), confidence: 0.85 }
    const dims = d.length ? d.slice(0, 2).map((field) => ({ field })) : grain ? [] : [{ field: leakKind ? 'client' : 'kind' }]
    return {
      dataset: 'revenue_leakage', intent: 'leakage', title: `Revenue lost${byTitle('revenue_leakage', dims)}`, dims,
      measures: [{ field: 'net', agg: 'sum', label: 'Net revenue lost' }], filters, period: withField('date', { preset: 'this_fy' }), confidence: 0.9,
    }
  }

  /* ----- people: appraisals, recruitment ----- */
  if (can('appraisals') && has(q, 'appraisal', 'appraisals', 'performance review', 'performance reviews', 'increment', 'increments', 'hike', 'hikes', 'final rating', 'final ratings', 'review cycle', 'appraisal ratings')) {
    if (has(q, 'pending', 'not completed', 'incomplete', 'overdue', 'not done', 'outstanding', 'stuck', 'status'))
      return { dataset: 'appraisals', intent: 'appraisals_pending', title: 'Appraisals not yet completed', columns: ['cycle', 'person', 'manager', 'status', 'self_rating', 'manager_rating', 'system_score'], filters: [{ field: 'is_completed', op: 'eq', value: false }], sort: [{ field: 'status', dir: 'asc' }], chart: 'table', period: null, confidence: 0.85 }
    const incr = has(q, 'increment', 'increments', 'hike', 'hikes', 'raise', 'raises')
    const dims = dimsOf('appraisals', 'cycle')
    return {
      dataset: 'appraisals', intent: 'appraisal_ratings', title: `${incr ? 'Average increment' : 'Appraisal ratings'}${byTitle('appraisals', dims)}`, dims,
      measures: incr ? [{ field: 'increment_pct', agg: 'avg', label: 'Average increment' }, { field: 'final_rating', agg: 'avg', label: 'Average final rating' }] : [{ field: 'final_rating', agg: 'avg', label: 'Average final rating' }, { field: 'manager_rating', agg: 'avg', label: 'Average manager rating' }, { field: 'self_rating', agg: 'avg', label: 'Average self rating' }],
      filters: [], period: per?.period ? { ...per.period, field: 'period_from' } : null, chart: 'bar', confidence: 0.85,
    }
  }
  if (can('candidates') && has(q, 'candidate', 'candidates', 'applicant', 'applicants', 'recruitment', 'recruiting', 'hiring', 'hiring pipeline', 'talent pipeline', 'openings', 'time to hire', 'time-to-hire')) {
    const filters: Filter[] = []
    if (has(q, 'active', 'in process', 'in progress', 'open', 'current')) filters.push({ field: 'is_active', op: 'eq', value: true })
    if (has(q, 'hired', 'hires', 'joined')) filters.push({ field: 'stage', op: 'eq', value: 'hired' })
    if (has(q, 'time to hire', 'time-to-hire', 'how long', 'days in pipeline', 'ageing', 'aging')) {
      const dims = dimsOf('candidates', 'opening')
      return { dataset: 'candidates', intent: 'candidates_age', title: `Days in pipeline${byTitle('candidates', dims)}`, dims, measures: [{ field: 'days_in_pipeline', agg: 'avg', label: 'Average days in pipeline' }, { field: '*', agg: 'count', label: 'Candidates' }], filters, period: per?.period ? { ...per.period, field: 'applied_on' } : null, confidence: 0.8 }
    }
    if (listing && !detectDims(q, 'candidates', new Set()).length)
      return { dataset: 'candidates', intent: 'candidates_list', title: 'Candidates', columns: ['name', 'opening', 'source', 'stage', 'experience', 'days_in_pipeline'], filters, sort: [{ field: 'days_in_pipeline', dir: 'desc' }], chart: 'table', period: per?.period ? { ...per.period, field: 'applied_on' } : null, confidence: 0.8 }
    const dims = dimsOf('candidates', 'stage')
    return { dataset: 'candidates', intent: 'candidates_by', title: `Candidates${byTitle('candidates', dims)}`, dims, measures: [{ field: '*', agg: 'count', label: 'Candidates' }], filters, period: per?.period ? { ...per.period, field: 'applied_on' } : null, chart: dims.length === 1 && dims[0].field === 'stage' ? 'bar' : undefined, confidence: 0.85 }
  }

  /* ----- documents ----- */
  if (can('documents') && has(q, 'document', 'documents', 'doc', 'docs', 'policy', 'policies', 'must read', 'must-read', 'sop', 'sops', 'acknowledged', 'acknowledgement', 'acknowledgements', 'acknowledgment', 'unacknowledged')) {
    if (has(q, 'not acknowledged', 'unacknowledged', 'not been acknowledged', "haven't acknowledged", 'have not acknowledged', 'pending acknowledgement', 'pending acknowledgment', 'awaiting acknowledgement', 'not read', 'unread', "haven't read", 'have not read', 'yet to read', 'yet to acknowledge', 'acknowledgement pending', 'not signed off')) {
      if (employeeish || has(q, 'my', 'i'))
        return { dataset: 'documents', intent: 'docs_my_pending', title: 'Must-read documents I haven’t acknowledged', columns: ['title', 'project', 'category', 'version', 'updated_on'], filters: [{ field: 'my_ack', op: 'eq', value: 'pending' }], sort: [{ field: 'updated_on', dir: 'desc' }], chart: 'table', period: null, confidence: 0.9 }
      return { dataset: 'documents', intent: 'docs_unacked', title: 'Must-read documents not fully acknowledged', columns: ['title', 'project', 'version', 'audience', 'acknowledged', 'pending', 'ack_pct'], filters: [{ field: 'must_read', op: 'eq', value: true }, { field: 'pending', op: 'gt', value: 0 }], sort: [{ field: 'pending', dir: 'desc' }], chart: 'table', period: null, confidence: 0.9 }
    }
    const d = detectDims(q, 'documents', new Set())
    if (d.length || has(q, 'how many', 'count', 'number of'))
      return { dataset: 'documents', intent: 'docs_by', title: `Documents${byTitle('documents', d.slice(0, 2).map((field) => ({ field })))}`, dims: (d.length ? d : ['category']).slice(0, 2).map((field) => ({ field })), measures: [{ field: '*', agg: 'count', label: 'Documents' }], filters: [{ field: 'archived', op: 'eq', value: false }], period: per?.period ? { ...per.period, field: 'updated_on' } : null, confidence: 0.8 }
    return { dataset: 'documents', intent: 'docs_list', title: has(q, 'must read', 'must-read') ? 'Must-read documents' : 'Documents', columns: ['title', 'project', 'category', 'version', 'must_read', 'acknowledged', 'pending', 'updated_on'], filters: [{ field: 'archived', op: 'eq', value: false }, ...(has(q, 'must read', 'must-read') ? [{ field: 'must_read', op: 'eq' as const, value: true }] : [])], sort: [{ field: 'updated_on', dir: 'desc' }], chart: 'table', period: per?.period ? { ...per.period, field: 'updated_on' } : null, confidence: 0.75 }
  }

  /* ----- OKRs ----- */
  if (can('okr_key_results') && has(q, 'okr', 'okrs', 'objective', 'objectives', 'key result', 'key results', 'krs', 'company goals', 'quarterly goals')) {
    const period = per?.period ? { ...per.period, field: 'period_from' } : { preset: 'this_quarter' as const, field: 'period_from' }
    if (has(q, 'at risk', 'off track', 'behind', 'lagging', 'struggling', 'red'))
      return { dataset: 'okr_key_results', intent: 'okr_risk', title: 'Key results at risk or off track', columns: ['objective', 'key_result', 'owner', 'current', 'target', 'unit', 'progress_pct', 'status'], filters: [{ field: 'status', op: 'in', value: ['at_risk', 'off_track'] }], sort: [{ field: 'progress_pct', dir: 'asc' }], chart: 'table', period, confidence: 0.9 }
    if (listing || has(q, 'key results', 'krs', 'detail', 'details'))
      return { dataset: 'okr_key_results', intent: 'okr_list', title: 'Key results', columns: ['objective', 'key_result', 'owner', 'current', 'target', 'unit', 'progress_pct', 'status'], filters: [], sort: [{ field: 'progress_pct', dir: 'asc' }], chart: 'table', period, confidence: 0.8 }
    const dims = dimsOf('okr_key_results', 'objective')
    return { dataset: 'okr_key_results', intent: 'okr_progress', title: `OKR progress${byTitle('okr_key_results', dims)}`, dims, measures: [{ field: 'progress_pct', agg: 'avg', label: 'Average progress' }, { field: '*', agg: 'count', label: 'Key results' }], filters: [], period, sort: dims.length ? [{ field: 'avg_progress_pct', dir: 'asc' }] : undefined, chart: 'hbar', confidence: 0.85 }
  }
  return null
}

/* ---------------- main ---------------- */
export function planQuestion(question: string, pc: PlanCtx): Plan {
  const q0 = question.trim()
  const q = ' ' + q0.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ') + ' '
  const visible = new Map(pc.datasets.map((d) => [d.id, d]))
  const can = (id: DatasetId) => visible.has(id)
  const per = parsePeriod(q, pc.today, pc.fyStart)
  let grain = parseGrain(q)
  const compare = has(q, 'vs last', 'versus last', 'compared to last', 'compare with last', 'vs previous', 'compared with previous', 'change from last', 'growth', 'grew', 'vs prior', 'previous period')
  const filters: Filter[] = []
  let dataset: DatasetId | null = null
  let measures: Measure[] = []
  let dims: Dimension[] = []
  let columns: string[] | undefined
  let sort: ReportSpec['sort']
  let limit: number | undefined
  let chart: ReportSpec['chart'] | undefined
  let title = ''
  let intent = 'generic'
  let period = per?.period
  let confidence = 0.6
  const person = matchPerson(q, pc.entities.people, pc.me)
  const project = matchProject(q, pc.entities.projects)
  const client = matchText(q, pc.entities.clients)
  const product = matchText(q, pc.entities.products)
  const t = topN(q)

  const want = (id: DatasetId) => (can(id) ? id : null)

  /* ----- specific intents (highest confidence) ----- */
  const v3 = planV3(q, pc, per, grain, can)
  if (v3) {
    dataset = v3.dataset
    intent = v3.intent
    measures = v3.measures ?? []
    dims = v3.dims ?? []
    filters.push(...(v3.filters ?? []))
    columns = v3.columns
    sort = v3.sort
    chart = v3.chart
    title = v3.title
    if (v3.period !== undefined) period = v3.period ?? undefined
    confidence = v3.confidence ?? 0.8
    if (v3.limit) limit = v3.limit
  } else if (has(q, /(hasn'?t|have ?n'?t|not|never|didn'?t|did not|yet to|missing|pending|late)\s+(yet\s+)?(submit|submitted|fill|filled|log|logged)/, 'timesheet compliance', 'missing timesheets', 'unsubmitted', 'timesheet defaulters', 'not submitted') && has(q, 'timesheet', 'timesheets', 'submit', 'submitted', 'hours')) {
    if (want('people')) {
      dataset = 'people'
      intent = 'timesheet_compliance'
      columns = ['name', 'manager', 'last_week_status', 'unsubmitted_weeks_8w', 'ts_compliance_8w']
      filters.push({ field: 'last_week_status', op: 'in', value: ['open', 'locked', 'rejected'] })
      sort = [{ field: 'unsubmitted_weeks_8w', dir: 'desc' }]
      title = 'Timesheets not submitted for last week'
      chart = 'table'
      period = undefined
      confidence = 0.9
    }
  } else if (has(q, 'pending approval', 'awaiting approval', 'waiting for approval', 'to approve', 'unapproved') && has(q, 'timesheet', 'timesheets', 'week', 'weeks', 'hours')) {
    if (want('people')) {
      dataset = 'people'
      intent = 'timesheets_pending_approval'
      columns = ['name', 'manager', 'last_week_status', 'hours_30d']
      filters.push({ field: 'last_week_status', op: 'eq', value: 'submitted' })
      title = 'Timesheets waiting for approval'
      chart = 'table'
      period = undefined
      confidence = 0.85
    }
  } else if (has(q, 'margin', 'margins', 'markup', 'profitable', 'profitability', 'loss making', 'loss-making', 'losing money') && !has(q, 'net margin', 'revenue', 'income', 'ledger', 'p&l')) {
    dataset = want('projects')
    if (dataset) {
      intent = 'project_margin'
      const below = pctNumber(q, /(?:below|under|less than|lower than|<)\s*(\d+(?:\.\d+)?)\s*%/)
      const above = pctNumber(q, /(?:above|over|more than|greater than|>)\s*(\d+(?:\.\d+)?)\s*%/)
      const field = has(q, 'actual margin', 'margin to date', 'realised', 'realized') ? 'actual_margin' : has(q, 'markup') ? 'projected_markup' : 'projected_margin'
      if (has(q, 'loss', 'losing', 'negative')) filters.push({ field, op: 'lt', value: 0 })
      else if (below !== null) filters.push({ field, op: 'lt', value: below })
      else if (above !== null) filters.push({ field, op: 'gt', value: above })
      else if (has(q, 'below floor', 'below the floor', 'under floor', 'low margin', 'at risk')) filters.push({ field, op: 'lt', value: 0.25 })
      if (has(q, 'active', 'running', 'open', 'current') || filters.length) filters.push({ field: 'status', op: 'in', value: ['active', 'initiated', 'on_hold'] })
      if (filters.length || has(q, 'which', 'list', 'show')) {
        columns = ['code', 'name', 'client', 'contract_value', 'projected_cost', field, 'health']
        sort = [{ field, dir: 'asc' }]
        chart = 'table'
        title = filters.some((f) => f.field === field && f.op === 'lt' && f.value === 0) ? 'Loss-making projects' : below !== null ? `Projects below ${Math.round(below * 100)}% margin` : above !== null ? `Projects above ${Math.round(above * 100)}% margin` : 'Project margins'
      } else {
        measures = [{ field, agg: 'avg' }]
        dims = [{ field: detectDims(q, 'projects', new Set())[0] ?? 'name' }]
        chart = 'hbar'
        title = 'Projected margin by project'
      }
      period = undefined
      confidence = 0.9
    }
  } else if (has(q, 'win rate', 'conversion rate', 'close rate', 'closing rate', 'hit rate', 'win ratio', 'success rate') && can('deals')) {
    dataset = 'deals'
    intent = 'win_rate'
    measures = [{ field: 'win', agg: 'avg', label: 'Win rate' }, { field: 'is_won', agg: 'sum', label: 'Won' }, { field: '*', agg: 'count', label: 'Closed deals' }]
    filters.push({ field: 'is_open', op: 'eq', value: false })
    if (period) period = { ...period, field: 'closed_on' }
    const wd = detectDims(q, 'deals', new Set()).filter((f) => f !== 'stage')
    if (wd.length) {
      dims = [{ field: wd[0] }]
      chart = 'hbar'
      sort = [{ field: 'avg_win', dir: 'desc' }]
    }
    title = `Win rate${dims.length ? ' by ' + (fieldOf(DATASET_MAP.deals, dims[0].field)?.label.toLowerCase() ?? '') : ''}`
    confidence = 0.9
  } else if (has(q, 'at risk', 'off track', 'health', 'healthy', 'in trouble', 'red projects', 'projects in red', 'struggling') && has(q, 'project', 'projects', 'portfolio') && can('projects')) {
    dataset = 'projects'
    intent = 'project_health'
    columns = ['code', 'name', 'client', 'pm', 'health', 'progress', 'spi', 'effort_ratio', 'overdue_tasks', 'overdue_milestones']
    if (has(q, 'at risk', 'off track', 'in trouble', 'red', 'struggling')) filters.push({ field: 'health', op: 'in', value: ['at_risk', 'off_track'] })
    filters.push({ field: 'status', op: 'in', value: ['active', 'initiated', 'on_hold'] })
    sort = [{ field: 'overdue_tasks', dir: 'desc' }]
    chart = 'table'
    title = filters.length > 1 ? 'Projects at risk or off track' : 'Project health'
    period = undefined
    confidence = 0.9
  } else if (has(q, 'stale', 'idle', 'no activity', 'going cold', 'gone cold', 'untouched', 'neglected') && can('deals')) {
    dataset = 'deals'
    intent = 'stale_deals'
    filters.push({ field: 'is_stale', op: 'eq', value: true })
    columns = ['title', 'client', 'stage', 'owner', 'value', 'last_activity_on', 'days_idle']
    sort = [{ field: 'days_idle', dir: 'desc' }]
    chart = 'table'
    title = 'Stale deals'
    period = undefined
    confidence = 0.9
  } else if (has(q, 'overdue', 'late', 'past due', 'delayed', 'slipping', 'behind schedule', 'breached') && has(q, 'milestone', 'milestones', 'deliverable', 'deliverables') && can('milestones')) {
    dataset = 'milestones'
    intent = 'overdue_milestones'
    filters.push({ field: 'is_overdue', op: 'eq', value: true })
    columns = ['label', 'project', 'planned_end', 'slip_days', 'progress', 'billing_amount']
    sort = [{ field: 'planned_end', dir: 'asc' }]
    title = 'Overdue milestones'
    chart = 'table'
    period = undefined
    confidence = 0.9
  } else if (has(q, 'milestone', 'milestones') && has(q, 'due', 'upcoming', 'next', 'coming up', 'billable', 'deadline') && can('milestones')) {
    dataset = 'milestones'
    intent = 'upcoming_milestones'
    filters.push({ field: 'is_open', op: 'eq', value: true })
    const nd = q.match(/next\s+(\d+)\s+days/)
    const days = nd ? Number(nd[1]) : 30
    period = { from: pc.today, to: addDays(pc.today, days) }
    columns = ['label', 'project', 'planned_end', 'state', 'progress', 'billing_amount', 'billing_status']
    sort = [{ field: 'planned_end', dir: 'asc' }]
    title = `Milestones due in the next ${days} days`
    chart = 'table'
    confidence = 0.85
  } else if (has(q, 'overdue', 'late', 'past due', 'delayed', 'breached', 'missed deadline', 'missed their deadline') && has(q, 'task', 'tasks', 'work', 'items', 'wbs', 'deliverable') && can('tasks')) {
    dataset = 'tasks'
    intent = 'overdue_tasks'
    filters.push({ field: 'is_overdue', op: 'eq', value: true })
    const d = detectDims(q, 'tasks', new Set())
    if (d.length || has(q, 'count', 'how many', 'number of', 'who', 'whom', 'most', 'least', 'fewest', 'which person', 'which people', 'ranking', 'rank')) {
      measures = [{ field: '*', agg: 'count', label: 'Overdue tasks' }, { field: 'days_overdue', agg: 'max', label: 'Most days overdue' }]
      dims = [{ field: d[0] ?? 'owner' }]
      chart = 'hbar'
      title = `Overdue tasks by ${fieldOf(DATASET_MAP.tasks, dims[0].field)?.label.toLowerCase()}`
    } else {
      columns = ['code', 'title', 'project', 'owner', 'due_on', 'days_overdue', 'status']
      sort = [{ field: 'days_overdue', dir: 'desc' }]
      chart = 'table'
      title = 'Overdue tasks'
    }
    period = undefined
    confidence = 0.9
  } else if (has(q, 'blocked', 'stuck', 'waiting on', 'blocker', 'blockers') && can('tasks')) {
    dataset = 'tasks'
    intent = 'blocked_tasks'
    filters.push({ field: 'is_blocked', op: 'eq', value: true })
    columns = ['code', 'title', 'project', 'owner', 'due_on', 'status']
    title = 'Blocked tasks'
    chart = 'table'
    period = undefined
    confidence = 0.85
  } else if (has(q, 'completed', 'finished', 'closed', 'done', 'delivered', 'throughput') && has(q, 'task', 'tasks', 'work items') && !has(q, 'overdue', 'blocked') && can('tasks')) {
    dataset = 'tasks'
    intent = 'tasks_done'
    filters.push({ field: 'status', op: 'eq', value: 'done' })
    const d = detectDims(q, 'tasks', new Set())
    measures = [{ field: '*', agg: 'count', label: 'Tasks done' }, { field: 'on_time', agg: 'sum', label: 'Done on time' }, { field: 'actual', agg: 'sum', label: 'Actual hours' }]
    dims = d.length ? d.map((f) => ({ field: f })) : grain ? [] : [{ field: 'owner' }]
    if (period) period = { ...period, field: 'done_on' }
    else period = { preset: 'last_30_days', field: 'done_on' }
    chart = grain ? 'bar' : 'hbar'
    title = `Tasks completed${dims.length ? ' by ' + (fieldOf(DATASET_MAP.tasks, dims[0].field)?.label.toLowerCase() ?? '') : ''}`
    confidence = 0.85
  } else if (has(q, 'effort ratio', 'overrun', 'over run', 'estimate accuracy', 'estimation accuracy', 'underestimated', 'over estimate', 'overestimated', 'actual vs estimate', 'actual versus estimate', 'estimated vs actual') && can('tasks')) {
    dataset = 'tasks'
    intent = 'effort_ratio'
    const d = detectDims(q, 'tasks', new Set())
    measures = [{ field: 'effort_ratio', agg: 'avg', label: 'Average effort ratio' }, { field: 'est', agg: 'sum', label: 'Estimated hours' }, { field: 'actual', agg: 'sum', label: 'Actual hours' }]
    dims = [{ field: d[0] ?? (has(q, 'project', 'projects') ? 'project' : 'owner') }]
    filters.push({ field: 'status', op: 'eq', value: 'done' })
    sort = [{ field: 'avg_effort_ratio', dir: 'desc' }]
    chart = 'hbar'
    title = `Estimate vs actual by ${dims[0].field === 'owner' ? 'person' : fieldOf(DATASET_MAP.tasks, dims[0].field)?.label.toLowerCase()}`
    confidence = 0.85
  } else if (has(q, 'utilisation', 'utilization', 'allocation', 'allocated', 'over allocated', 'overallocated', 'under allocated', 'bench', 'capacity', 'free', 'available', 'overloaded', 'load') && can('people')) {
    dataset = 'people'
    intent = 'allocation'
    columns = ['name', 'title', 'allocation_next_10d', 'allocation_today', 'open_tasks', 'overdue_tasks']
    if (has(q, 'over', 'overallocated', 'over allocated', 'overloaded', 'too much')) filters.push({ field: 'allocation_next_10d', op: 'gt', value: 1.1 })
    else if (has(q, 'under', 'bench', 'free', 'available', 'underallocated', 'under allocated', 'idle')) filters.push({ field: 'allocation_next_10d', op: 'lt', value: 0.8 })
    filters.push({ field: 'role', op: 'in', value: ['employee', 'pm'] })
    sort = [{ field: 'allocation_next_10d', dir: filters.some((f) => f.op === 'lt') ? 'asc' : 'desc' }]
    chart = 'hbar'
    measures = [{ field: 'allocation_next_10d', agg: 'avg', label: 'Allocation, next 10 working days' }]
    dims = [{ field: 'name' }]
    columns = undefined
    title = filters.some((f) => f.field === 'allocation_next_10d' && f.op === 'gt') ? 'Over-allocated people' : filters.some((f) => f.field === 'allocation_next_10d' && f.op === 'lt') ? 'People with spare capacity' : 'Allocation, next 10 working days'
    period = undefined
    confidence = 0.8
  } else if (has(q, 'receivable', 'receivables', 'outstanding', 'unpaid', 'owed', 'owe us', 'dues', 'pending payment', 'pending payments', 'awaiting payment', 'ageing', 'aging', 'debtors') && can('invoices')) {
    dataset = 'invoices'
    intent = 'receivables'
    filters.push({ field: 'outstanding', op: 'gt', value: 0 })
    const d = detectDims(q, 'invoices', new Set())
    if (d.length || has(q, 'by client', 'which client', 'who owes')) {
      measures = [{ field: 'outstanding', agg: 'sum', label: 'Outstanding' }, { field: '*', agg: 'count', label: 'Invoices' }, { field: 'age_days', agg: 'max', label: 'Oldest (days)' }]
      dims = [{ field: d[0] ?? 'client' }]
      chart = 'hbar'
      title = 'Receivables by client'
    } else {
      columns = ['number', 'client', 'project', 'invoiced_on', 'amount', 'paid', 'outstanding', 'age_days']
      sort = [{ field: 'age_days', dir: 'desc' }]
      chart = 'table'
      title = 'Outstanding invoices'
    }
    confidence = 0.85
  } else if (has(q, 'payroll', 'salary', 'salaries', 'ctc', 'payslip', 'wage', 'wages', 'net pay', 'take home', 'take-home', 'compensation cost', 'people cost', 'staff cost') && can('payroll')) {
    dataset = 'payroll'
    intent = 'payroll'
    const d = detectDims(q, 'payroll', new Set())
    measures = has(q, 'net pay', 'take home', 'take-home', 'paid out', 'payout') ? [{ field: 'net', agg: 'sum', label: 'Net pay' }] : has(q, 'deduction', 'deductions', 'lwp') ? [{ field: 'deduction', agg: 'sum', label: 'Deductions' }] : [{ field: 'ctc', agg: 'sum', label: 'Payroll cost (CTC)' }]
    dims = d.length ? [{ field: d[0] }] : grain ? [] : [{ field: 'department' }]
    title = `${measures[0].label} by ${dims[0] ? fieldOf(DATASET_MAP.payroll, dims[0].field)?.label.toLowerCase() : 'month'}`
    if (!period) period = { preset: 'this_fy' }
    confidence = 0.85
  } else if (has(q, 'headcount', 'head count', 'how many people', 'how many employees', 'team size', 'staff count', 'number of employees') && can('people')) {
    dataset = 'people'
    intent = 'headcount'
    measures = [{ field: '*', agg: 'count', label: 'People' }]
    dims = [{ field: detectDims(q, 'people', new Set())[0] ?? 'department' }]
    chart = 'bar'
    title = 'Headcount'
    period = undefined
    confidence = 0.8
  } else if (has(q, 'compliance', 'filing', 'filings', 'statutory', 'gst', 'tds', 'pf', 'esi', 'ops item', 'ops items', 'operations register', 'duties') && can('ops')) {
    dataset = 'ops'
    intent = 'ops'
    columns = ['item', 'category', 'owner', 'due_on', 'recurring', 'days_overdue']
    filters.push({ field: 'status', op: 'eq', value: 'open' })
    if (has(q, 'overdue', 'late', 'missed')) filters.push({ field: 'is_overdue', op: 'eq', value: true })
    sort = [{ field: 'due_on', dir: 'asc' }]
    chart = 'table'
    title = filters.length > 1 ? 'Overdue compliance and ops items' : 'Compliance and ops calendar'
    if (!per) period = { from: addDays(pc.today, -60), to: addDays(pc.today, 45) }
    confidence = 0.8
  }

  /* ----- money/revenue family ----- */
  if (!dataset) {
    const moneyish = has(q, 'revenue', 'income', 'billed', 'billing', 'billings', 'invoiced', 'turnover', 'sales revenue', 'collected', 'collection', 'collections', 'cash', 'expense', 'expenses', 'cost', 'costs', 'spend', 'spent', 'spending', 'profit', 'net', 'earnings', 'p&l', 'pnl', 'burn', 'money')
    const salesish = has(q, 'deal', 'deals', 'pipeline', 'lead', 'leads', 'opportunity', 'opportunities', 'won', 'lost', 'funnel', 'closed', 'closing', 'stage')
    const hoursish = has(q, 'hour', 'hours', 'timesheet', 'timesheets', 'logged', 'time spent', 'worked', 'leave', 'leaves', 'effort')
    if (moneyish && !salesish && !hoursish && (can('ledger') || can('invoices'))) {
      const clientDim = detectDims(q, 'ledger', new Set()).includes('client') || !!client
      if (can('ledger')) {
        dataset = 'ledger'
        intent = 'money'
        const billed = has(q, 'revenue', 'income', 'billed', 'billing', 'billings', 'invoiced', 'turnover', 'sales revenue', 'earned')
        const collected = has(q, 'collected', 'collection', 'collections', 'cash in', 'received', 'receipts')
        const cost = has(q, 'expense', 'expenses', 'cost', 'costs', 'spend', 'spent', 'spending', 'burn')
        const net = has(q, 'profit', 'net', 'earnings', 'p&l', 'pnl', 'bottom line')
        if (net || (billed && cost)) measures = [{ field: 'billed', agg: 'sum', label: 'Revenue billed' }, { field: 'spent', agg: 'sum', label: 'Costs' }, { field: 'net', agg: 'sum', label: 'Net earnings' }]
        else if (billed && collected) measures = [{ field: 'billed', agg: 'sum', label: 'Billed' }, { field: 'collected', agg: 'sum', label: 'Collected' }]
        else if (collected) measures = [{ field: 'collected', agg: 'sum', label: 'Cash collected' }]
        else if (cost) {
          measures = [{ field: 'spent', agg: 'sum', label: 'Costs' }]
          filters.push({ field: 'kind', op: 'eq', value: 'expense' })
        } else measures = [{ field: 'billed', agg: 'sum', label: 'Revenue billed' }]
        const d = detectDims(q, 'ledger', new Set())
        if (cost && !billed && !net && !d.length && !grain) dims = [{ field: 'category' }]
        else if (d.length) dims = d.map((f) => ({ field: f }))
        else if (clientDim) dims = [{ field: 'client' }]
        if (dims.some((x) => x.field === 'client')) filters.push({ field: 'client', op: 'not_empty' })
        if (dims.some((x) => x.field === 'stream')) filters.push({ field: 'stream', op: 'not_empty' })
        if (!period) period = { preset: grain || dims.length === 0 && (net || (billed && collected)) ? 'last_12_months' : 'this_fy' }
        if ((net || (billed && collected)) && !dims.length && !grain && per?.period?.preset !== 'this_month') grain = 'month'
        title = `${measures.map((m) => m.label).join(' vs ')}${dims.length ? ' by ' + dims.map((x) => fieldOf(DATASET_MAP.ledger, x.field)?.label.toLowerCase()).join(' and ') : ''}`
        confidence = 0.8
      } else {
        dataset = 'invoices'
        measures = [{ field: 'amount', agg: 'sum', label: 'Invoiced' }]
        dims = [{ field: detectDims(q, 'invoices', new Set())[0] ?? 'client' }]
        title = 'Invoiced by client'
      }
    } else if (salesish && can('deals')) {
      dataset = 'deals'
      intent = 'pipeline'
      const won = has(q, 'won', 'closed won', 'wins', 'closed deals', 'bookings', 'booked')
      const lost = has(q, 'lost', 'losses', 'lose')
      const weighted = has(q, 'weighted', 'forecast')
      if (won) {
        filters.push({ field: 'is_won', op: 'eq', value: true })
        if (period) period = { ...period, field: 'won_on' }
      } else if (lost) {
        filters.push({ field: 'is_lost', op: 'eq', value: true })
        if (period) period = { ...period, field: 'lost_on' }
      } else if (has(q, 'open', 'pipeline', 'active', 'current', 'in play', 'weighted', 'forecast', 'closing this month', 'closing')) {
        filters.push({ field: 'is_open', op: 'eq', value: true })
        if (has(q, 'closing', 'close this', 'expected to close')) {
          if (period) period = { ...period, field: 'expected_close' }
          else period = { preset: 'this_month', field: 'expected_close' }
        } else period = undefined
      }
      const avgQ = has(q, 'average', 'avg', 'mean', 'deal size', 'ticket size')
      measures = avgQ
        ? [{ field: 'value', agg: 'avg', label: 'Average deal size' }, { field: '*', agg: 'count', label: 'Deals' }]
        : [{ field: weighted ? 'weighted' : 'value', agg: 'sum', label: weighted ? 'Weighted value' : won ? 'Won value' : lost ? 'Lost value' : 'Pipeline value' }, { field: '*', agg: 'count', label: 'Deals' }]
      if (avgQ && !won && !lost && !has(q, 'open', 'pipeline')) filters.push({ field: 'is_won', op: 'eq', value: true })
      const d = detectDims(q, 'deals', new Set())
      dims = d.length ? d.map((f) => ({ field: f })) : won || lost ? [] : [{ field: 'stage' }]
      if (lost && !d.length && has(q, 'why', 'reason', 'reasons')) dims = [{ field: 'lost_reason' }]
      if (has(q, 'list', 'which', 'show me the', 'what deals', 'show deals') && !d.length) {
        measures = []
        dims = []
        columns = ['title', 'client', 'stage', 'owner', 'value', 'expected_close', 'days_idle']
        sort = [{ field: 'value', dir: 'desc' }]
        chart = 'table'
      }
      title = `${avgQ ? 'Average deal size' : won ? 'Deals won' : lost ? 'Deals lost' : weighted ? 'Weighted pipeline' : 'Open pipeline'}${dims.length ? ' by ' + dims.map((x) => fieldOf(DATASET_MAP.deals, x.field)?.label.toLowerCase()).join(' and ') : ''}`
      confidence = 0.8
    } else if (has(q, 'activity', 'activities', 'calls', 'meetings', 'demos', 'follow ups', 'follow-ups', 'followups') && can('deal_activities')) {
      dataset = 'deal_activities'
      intent = 'activities'
      measures = [{ field: '*', agg: 'count', label: 'Activities' }]
      const d = detectDims(q, 'deal_activities', new Set())
      dims = d.length ? d.map((f) => ({ field: f })) : [{ field: 'type' }]
      if (has(q, 'calls')) filters.push({ field: 'type', op: 'eq', value: 'call' })
      if (has(q, 'meetings')) filters.push({ field: 'type', op: 'eq', value: 'meeting' })
      if (has(q, 'demos')) filters.push({ field: 'type', op: 'eq', value: 'demo' })
      if (!period) period = { preset: 'last_30_days' }
      title = `Sales activities by ${fieldOf(DATASET_MAP.deal_activities, dims[0].field)?.label.toLowerCase()}`
      confidence = 0.75
    } else if (hoursish && can('hours')) {
      dataset = 'hours'
      intent = 'hours'
      const cost = has(q, 'cost', 'costs', 'labour', 'labor', 'spent money')
      measures = cost && fieldOf(visible.get('hours')!, 'cost') ? [{ field: 'hours', agg: 'sum', label: 'Hours' }, { field: 'cost', agg: 'sum', label: 'Cost' }] : [{ field: 'hours', agg: 'sum', label: 'Hours' }]
      if (has(q, 'leave', 'leaves', 'time off', 'absence', 'absent')) filters.push({ field: 'kind', op: 'eq', value: 'leave' })
      else if (has(q, 'billable', 'project work', 'on projects', 'project hours', 'delivery hours')) filters.push({ field: 'kind', op: 'eq', value: 'task' })
      else if (has(q, 'internal', 'non billable', 'non-billable', 'overhead', 'bench')) filters.push({ field: 'kind', op: 'eq', value: 'internal' })
      if (has(q, 'unapproved', 'not approved', 'pending approval')) filters.push({ field: 'approved', op: 'eq', value: false })
      else if (has(q, 'approved')) filters.push({ field: 'approved', op: 'eq', value: true })
      const d = detectDims(q, 'hours', new Set())
      dims = d.length ? d.map((f) => ({ field: f })) : grain ? [] : [{ field: project ? 'person' : 'project' }]
      if (!period) period = { preset: 'last_30_days' }
      title = `Hours${filters.some((f) => f.value === 'leave') ? ' on leave' : filters.some((f) => f.value === 'task') ? ' on project tasks' : ''}${dims.length ? ' by ' + dims.map((x) => fieldOf(DATASET_MAP.hours, x.field)?.label.toLowerCase()).join(' and ') : ''}`
      confidence = 0.8
    }
  }

  /* ----- generic fallback: best-scoring dataset ----- */
  if (!dataset) {
    const scored = scoreDatasets(q, pc.datasets)
    const top = scored[0]
    if (top && top.score > 0) {
      dataset = top.id
      intent = 'generic'
      confidence = Math.min(0.7, 0.35 + top.score * 0.08)
    } else {
      // role-aware default
      dataset = (['ledger', 'deals', 'tasks', 'hours'] as DatasetId[]).find((d) => can(d)) ?? pc.datasets[0]?.id ?? 'hours'
      confidence = 0.2
    }
    const ds = visible.get(dataset)!
    const d = detectDims(q, dataset, new Set())
    if (project && can('projects') && confidence < 0.5 && !d.length && !grain) {
      dataset = 'projects'
      intent = 'project_status'
      confidence = 0.75
    }
    if (dataset === 'projects' && intent === 'project_status') {
      columns = ['code', 'name', 'client', 'status', 'health', 'progress', 'spi', 'effort_ratio', 'overdue_tasks', 'overdue_milestones', 'contract_value', 'invoiced', 'projected_margin'].filter((k) => fieldOf(visible.get('projects')!, k))
      chart = 'table'
    } else if (!grain && (has(q, 'list', 'show all', 'which', 'what are') || (!d.length && ['tasks', 'milestones', 'ops', 'invoices', 'people', 'allocations', 'deals'].includes(dataset) && !has(q, 'how many', 'count', 'number of', 'total', 'sum', 'average')))) {
      columns = ds.defaultColumns
      chart = 'table'
    } else {
      const numeric = ds.fields.find((f) => (f.type === 'money' || f.unit === 'hours') && (f.aliases ?? []).some((a) => has(q, a))) ?? ds.fields.find((f) => f.type === 'money') ?? ds.fields.find((f) => f.unit === 'hours')
      measures = has(q, 'how many', 'count', 'number of') || !numeric ? [{ field: '*', agg: 'count' }] : [{ field: numeric.key, agg: 'sum' }]
      dims = d.map((f) => ({ field: f }))
    }
    title = intent === 'project_status' && project ? `${project.name} — status` : `${ds.label}${dims.length ? ' by ' + dims.map((x) => fieldOf(ds, x.field)?.label.toLowerCase()).join(' and ') : ''}`
  }

  const ds = visible.get(dataset)!

  /* ----- entity filters (person / project / client / product / stream / stage / source) ----- */
  const personField = { hours: 'person', tasks: 'owner', allocations: 'person', payroll: 'person', deals: 'owner', deal_activities: 'owner', people: 'name', ops: 'owner', task_reviews: 'owner', leave_requests: 'person', expenses: 'person', appraisals: 'person', okr_key_results: 'owner' }[dataset as string]
  const byPersonDim = dims.some((x) => x.field === personField)
  if (person && personField && !byPersonDim && fieldOf(ds, personField) && !(intent === 'timesheet_compliance' || intent === 'allocation' || intent === 'headcount')) {
    filters.push({ field: personField, op: 'eq', value: person })
    title += person === pc.me ? ' — mine' : ` — ${person}`
  }
  if (project && fieldOf(ds, 'project') && !dims.some((x) => x.field === 'project')) {
    filters.push({ field: 'project', op: 'eq', value: project.name })
    title += ` — ${project.name}`
  } else if (project && dataset === 'projects') {
    filters.push({ field: 'name', op: 'eq', value: project.name })
  } else if (client && !project && fieldOf(ds, 'client') && !dims.some((x) => x.field === 'client')) {
    filters.push({ field: 'client', op: 'eq', value: client })
    title += ` — ${client}`
  }
  if (product && dataset === 'deals' && !dims.some((x) => x.field === 'product')) filters.push({ field: 'product', op: 'eq', value: product })
  // streams
  const streams: [RegExp, string][] = [[/\bsap( consulting)?\b/, 'sap_consulting'], [/\bsaas\b|\bsubscriptions?\b/, 'saas'], [/\bams\b|\bsupport retainer/, 'ams'], [/\bproducts?\b(?! by)/, 'products'], [/\bservices\b/, 'services']]
  const streamField = fieldOf(ds, 'stream')
  if (streamField && !dims.some((x) => x.field === 'stream')) {
    const hits = streams.filter(([re]) => re.test(q)).map(([, v]) => v)
    if (hits.length === 1 && !(hits[0] === 'products' && dataset === 'deals')) filters.push({ field: 'stream', op: 'eq', value: hits[0] })
  }
  // deal sources / stages mentioned as filters
  if (dataset === 'deals' || dataset === 'deal_activities') {
    const src = (['referral', 'bni', 'website', 'cold call', 'event', 'partner', 'existing client'] as const).find((s) => has(q, s))
    if (src && dataset === 'deals' && !dims.some((x) => x.field === 'source')) filters.push({ field: 'source', op: 'eq', value: src.replace(' ', '_') })
    const stg = (['qualified', 'demo', 'proposal', 'negotiation'] as const).find((s) => has(q, s, s + 's', s === 'demo' ? 'demo stage' : s))
    if (stg && dataset === 'deals' && !dims.some((x) => x.field === 'stage') && intent !== 'activities') filters.push({ field: 'stage', op: 'eq', value: stg })
  }
  if ((dataset === 'tasks' || dataset === 'task_reviews') && !dims.some((x) => x.field === 'kind' || x.field === 'task_kind')) {
    const kf = dataset === 'tasks' ? 'kind' : 'task_kind'
    if (has(q, 'general task', 'general tasks', 'admin tasks', 'non-project', 'non project')) filters.push({ field: kf, op: 'eq', value: 'general' })
    else if (has(q, 'project task', 'project tasks')) filters.push({ field: kf, op: 'eq', value: 'project' })
  }
  if (dataset === 'tasks' && has(q, 'urgent', 'high priority', 'high-priority') && !dims.some((x) => x.field === 'priority')) filters.push({ field: 'priority', op: 'in', value: has(q, 'high priority', 'high-priority') ? ['high', 'urgent'] : ['urgent'] })
  if (dataset === 'tasks' && !filters.some((f) => f.field === 'status' || f.field === 'is_overdue' || f.field === 'is_blocked')) {
    if (has(q, 'open', 'pending', 'remaining', 'not done', 'incomplete')) filters.push({ field: 'is_open', op: 'eq', value: true })
    else if (has(q, 'done', 'completed', 'finished', 'closed')) filters.push({ field: 'status', op: 'eq', value: 'done' })
    else if (has(q, 'in review')) filters.push({ field: 'status', op: 'eq', value: 'in_review' })
    else if (has(q, 'in progress')) filters.push({ field: 'status', op: 'eq', value: 'in_progress' })
  }
  if (dataset === 'projects' && !filters.some((f) => f.field === 'status') && has(q, 'active', 'running', 'live', 'ongoing', 'current')) filters.push({ field: 'status', op: 'eq', value: 'active' })

  /* ----- time grain ----- */
  if (!grain && per?.grainHint && measures.length && !dims.length && intent !== 'win_rate') grain = per.grainHint
  if (grain && ds.dateField && measures.length) {
    const df = period?.field ?? (intent === 'win_rate' ? 'closed_on' : ds.dateField)
    if (!dims.some((x) => x.grain)) dims = [{ field: df, grain }, ...dims].slice(0, 2)
    if (!period) period = { preset: grain === 'day' ? 'last_30_days' : grain === 'week' ? 'last_90_days' : grain === 'month' ? 'last_12_months' : 'all' }
  }

  /* ----- top N ----- */
  if (t && measures.length && dims.length && !dims.some((x) => x.grain)) {
    limit = t.n
    sort = [{ field: measures[0].agg === 'count' ? 'count' : `${measures[0].agg}_${measures[0].field}`, dir: t.dir }]
    if (/^\d/.test(String(t.n))) title = `${t.dir === 'desc' ? 'Top' : 'Bottom'} ${t.n} ${/^[A-Z][a-z]/.test(title) ? title[0].toLowerCase() + title.slice(1) : title}`.replace(/ by /, ' — by ')
  } else if (t && !measures.length) limit = t.n

  /* ----- chart ----- */
  if (!chart) {
    const timeDim = dims.find((x) => x.grain)
    if (!measures.length) chart = 'table'
    else if (!dims.length) chart = 'kpi'
    else if (timeDim && dims.length === 2) chart = 'stacked'
    else if (timeDim) chart = measures.length > 1 && measures.every((m) => ['billed', 'collected', 'spent', 'net'].includes(m.field)) ? 'bar' : measures.length > 1 ? 'line' : 'area'
    else if (dims.length === 2) chart = 'stacked'
    else if (has(q, 'share', 'split', 'mix', 'breakdown', 'break down', 'proportion', 'composition', 'distribution', 'pie', 'donut') || dims[0].field === 'stream') chart = 'pie'
    else chart = 'hbar'
  }
  if (has(q, 'as a table', 'in a table', 'table of', 'tabular')) chart = 'table'
  if (has(q, 'line chart', 'as a line')) chart = 'line'
  if (has(q, 'bar chart', 'as bars')) chart = 'bar'
  if (has(q, 'pie chart', 'donut')) chart = 'pie'

  const periodLabel = per?.label ?? (period?.preset ? { this_fy: 'This financial year', last_12_months: 'Last 12 months', last_30_days: 'Last 30 days', last_90_days: 'Last 90 days', this_month: 'This month', all: 'All time' }[period.preset as string] : period?.from ? 'Chosen dates' : null)
  const spec: ReportSpec = {
    title: cap(title.trim()),
    ...(periodLabel ? { subtitle: periodLabel } : {}),
    dataset,
    measures,
    dimensions: dims,
    ...(columns ? { columns } : {}),
    filters,
    ...(period ? { period } : {}),
    ...(sort ? { sort } : {}),
    ...(limit ? { limit } : {}),
    chart,
    compare: compare && period && measures.length ? 'previous_period' : 'none',
  }
  const blocked = intent === 'generic' || !v3 ? restrictedTopic(q, can) : null
  const explanation = explain(spec, ds, blocked ? Math.min(confidence, 0.3) : confidence) + (blocked ? ` ${blocked} data isn’t available for your role, so this shows the closest data you can see.` : '')
  if (blocked) confidence = Math.min(confidence, 0.3)
  return { spec, explanation, confidence, intent }
}

function explain(spec: ReportSpec, ds: DatasetDefX, confidence: number) {
  const parts: string[] = [`From ${ds.label.toLowerCase()}`]
  if (spec.measures.length) parts.push(`I’m totalling ${spec.measures.map((m) => (m.agg === 'count' ? `the number of ${ds.noun}` : (m.label ?? fieldOf(ds, m.field)?.label ?? m.field).toLowerCase())).join(', ')}`)
  else parts.push(`I’m listing matching ${ds.noun}`)
  if (spec.dimensions.length) parts.push(`grouped by ${spec.dimensions.map((d) => (d.grain ? d.grain : (fieldOf(ds, d.field)?.label ?? d.field).toLowerCase())).join(' and ')}`)
  if (spec.filters.length) parts.push(`filtered to ${spec.filters.length === 1 ? 'one condition' : `${spec.filters.length} conditions`}`)
  let s = parts.join(', ') + '.'
  if (confidence < 0.45) s += ' I wasn’t sure what you meant, so this is my best guess — adjust it in the builder or rephrase.'
  return s
}

/** Suggested questions per role (UI chips). */
export const SUGGESTIONS: Record<string, string[]> = {
  admin: ['Revenue by stream this FY', 'Cash collected vs billed by month last 6 months', 'Spend vs budget by category', 'Lost revenue by kind this FY', 'On-time delivery by project', 'Why are tasks delayed?', 'Which projects are below 25% margin?', 'Top 5 clients by billing this FY', 'Who has the most overdue tasks?', 'Win rate by source this quarter', 'Payroll cost by department this FY', 'Who hasn’t submitted last week’s timesheet?'],
  pm: ['On-time delivery by person this FY', 'Tasks sent back by reviewer', 'Average quality rating by person', 'Why are tasks delayed?', 'Overdue tasks by owner', 'Hours by person last month', 'Pending leave requests', 'Milestones due in the next 30 days', 'Who is over-allocated?', 'Who hasn’t submitted last week’s timesheet?'],
  sales: ['My open pipeline by stage', 'Win rate by source this quarter', 'Stale deals', 'Deals won this FY by month', 'My activities last 30 days by type', 'Deals closing this month', 'OKR progress'],
  ops: ['Pending leave requests', 'Unpaid reimbursements', 'Bills due this month', 'POs pending approval', 'Candidates by stage', 'Documents not acknowledged', 'Compliance items due', 'Who hasn’t submitted last week’s timesheet?', 'Expenses by category this FY', 'Headcount by department'],
  employee: ['My hours by project last month', 'My overdue tasks', 'My on-time delivery this FY', 'My expense claims by category', 'Documents not acknowledged', 'My hours by week last 8 weeks', 'My tasks due this week'],
}
