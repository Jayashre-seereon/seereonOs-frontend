// AI layer. Non-negotiable rule: the model NEVER computes or invents figures. It only
//   (a) turns a question into a ReportSpec (JSON) that the report engine runs, or
//   (b) calls data tools that return server-computed numbers, then writes narrative around them.
// With the hosted `sample` capability (claude.ai preview) we use the LLM; without it (the real app
// today, or when the viewer declines) the deterministic rules planner (POST /ai/plan, /ai/answer)
// does the same job and a template narrative reads numbers straight from the result.
import type { ReportSpec } from '@/types/reports'
import { reportsApi, type AiAnswer, type AiContext } from '@/api/reports'
import { describeSpec, sanitizeSpec, type ReportResultX } from './engine'
import { fmtCell, narrate } from './narrative'
import type { DatasetDefX } from './datasets'
import { AGG_LABEL, PRESET_LABEL } from './datasets'

/* ------------------------------------------------------------------ */
/* Runtime access to the `sample` capability                             */
/* ------------------------------------------------------------------ */
interface SampleTool {
  name: string
  description: string
  inputSchema?: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
  execute(input: Record<string, unknown>, ctx: { signal: AbortSignal }): unknown
}
interface SampleOpts {
  onText?: (u: { text: string; delta: string }) => void
  signal?: AbortSignal
  tools?: SampleTool[]
  modelTier?: 'default' | 'complex' | 'quick'
  cache?: boolean | { gcTime?: number; refresh?: boolean }
}
type Msg = { role: 'user' | 'assistant'; content: string }
interface SampleFn {
  (input: string | Msg[], opts?: SampleOpts): Promise<{ text: string; truncated: boolean }>
  json<T = unknown>(input: string | Msg[], opts?: SampleOpts): Promise<T>
  limits(): Promise<{ maxPromptBytes: number; tools?: { maxCount: number } }>
}
let samplePromise: Promise<SampleFn | null> | null = null
let declined = false

/** Resolves the LLM, or null when this view has none (design for absence). */
export function getSample(): Promise<SampleFn | null> {
  if (declined) return Promise.resolve(null)
  if (!samplePromise) {
    const w = window as unknown as { claude?: { use?: (n: string) => Promise<unknown> } }
    if (!w.claude?.use) samplePromise = Promise.resolve(null)
    else
      samplePromise = Promise.race([w.claude.use('sample').then((s) => (typeof s === 'function' ? (s as SampleFn) : null)), new Promise<null>((r) => setTimeout(() => r(null), 11_000))]).catch(() => null)
  }
  return samplePromise
}
/** Non-blocking check for UI badges. */
export async function llmAvailable(): Promise<boolean> {
  return !!(await getSample())
}
function onSampleError(e: unknown) {
  const code = (e as { code?: string })?.code
  if (code === 'not_granted') declined = true
  return code ?? 'error'
}

/* ------------------------------------------------------------------ */
/* Context (datasets, entities) cached per session                      */
/* ------------------------------------------------------------------ */
let ctxCache: { at: number; key: string; ctx: AiContext } | null = null
async function aiContext(scope: string): Promise<AiContext> {
  if (ctxCache && ctxCache.key === scope && Date.now() - ctxCache.at < 5 * 60_000) return ctxCache.ctx
  const ctx = await reportsApi.aiContext()
  ctxCache = { at: Date.now(), key: scope, ctx }
  return ctx
}

function catalogue(ctx: AiContext) {
  const ds = ctx.datasets
    .map((d) => {
      const fields = d.fields.map((f) => {
        const opts = f.type === 'enum' && f.options ? `[${f.options.map((o) => o.value).join('|')}]` : ''
        const unit = (f as { unit?: string }).unit ? `(${(f as { unit?: string }).unit})` : ''
        return `${f.key}:${f.type}${unit}${opts}`
      })
      return `- ${d.id} — ${d.label}. ${d.description} Date field: ${d.dateField ?? 'none'}.\n  fields: ${fields.join(', ')}`
    })
    .join('\n')
  const cap = (a: string[], n: number) => (a.length > n ? [...a.slice(0, n), `…(+${a.length - n})`] : a)
  const e = ctx.entities
  return `DATASETS (only these; only these fields):
${ds}

ENTITIES (exact spellings for filters): people: ${cap(e.people.map((p) => p.name), 40).join('; ')}
projects: ${cap(e.projects.map((p) => p.name), 40).join('; ')}
clients: ${cap(e.clients, 40).join('; ')}${e.products.length ? `\nproducts: ${e.products.join('; ')}` : ''}${e.categories.length ? `\nledger categories: ${e.categories.join('; ')}` : ''}`
}

function specRules(ctx: AiContext) {
  return `ReportSpec JSON shape:
{"title": string, "dataset": DatasetId, "measures": [{"field": fieldKey | "*", "agg": "sum"|"avg"|"count"|"min"|"max"|"count_distinct", "label"?: string}],
 "dimensions": [{"field": fieldKey, "grain"?: "day"|"week"|"month"|"quarter"|"fy"}] (max 2; grain only on date fields),
 "columns"?: [fieldKey] (only for listings: measures=[] and dimensions=[]),
 "filters": [{"field": fieldKey, "op": "eq"|"neq"|"in"|"nin"|"gt"|"gte"|"lt"|"lte"|"contains"|"between"|"is_empty"|"not_empty", "value"?: any}],
 "period"?: {"preset"?: ${Object.keys(PRESET_LABEL).map((p) => `"${p}"`).join('|')}, "from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD", "field"?: dateFieldKey},
 "sort"?: [{"field": dimensionKey or measureKey, "dir": "asc"|"desc"}] (measureKey is "count" for count, else "<agg>_<field>", e.g. "sum_billed"),
 "limit"?: number, "chart": "table"|"bar"|"hbar"|"line"|"area"|"pie"|"stacked"|"kpi", "compare"?: "previous_period"|"none"}
Rules: money filter values are in PAISE (₹1 = 100). Percent values are fractions (25% = 0.25). Boolean filters use true/false.
Use "*" with "count" to count rows. Use the ledger's "billed" for revenue, "collected" for cash in, "spent" for costs, "net" for profit.
Win rate = avg of deals.win over closed deals (filter is_open=false). Today is ${ctx.today}; the financial year starts in month ${ctx.fy_start_month}.
Chart: time on x → line/area/bar; categories → hbar; share of a whole → pie; one number → kpi; lists → table.`
}

/* ------------------------------------------------------------------ */
/* (a) Question → ReportSpec                                             */
/* ------------------------------------------------------------------ */
export interface PlanResult {
  spec: ReportSpec
  explanation: string
  source: 'llm' | 'rules'
  confidence?: number
  warnings?: string[]
}

/** Validates an LLM-proposed spec against the viewer's dataset definitions. */
export function validateSpec(raw: unknown, datasets: DatasetDefX[]): { spec: ReportSpec; warnings: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const ds = datasets.find((d) => d.id === r.dataset)
  if (!ds) return null
  const coerced: Record<string, unknown> = { ...r }
  // coerce numbers written as strings
  if (Array.isArray(r.filters))
    coerced.filters = (r.filters as Record<string, unknown>[]).map((f) => {
      const fd = ds.fields.find((x) => x.key === f.field)
      let value = f.value
      if (fd && ['number', 'money', 'percent'].includes(fd.type)) {
        const n = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)) ? Number(v) : v)
        value = Array.isArray(value) ? value.map(n) : n(value)
      }
      return { ...f, value }
    })
  if (typeof r.limit === 'string') coerced.limit = Number(r.limit)
  const out = sanitizeSpec(coerced as never, ds)
  if (!out.spec.measures.length && !out.spec.dimensions.length && !out.spec.columns?.length) out.spec.columns = ds.defaultColumns
  return out
}

export async function planReport(question: string, opts: { scope?: string; signal?: AbortSignal } = {}): Promise<PlanResult> {
  const sample = await getSample()
  if (sample) {
    try {
      const ctx = await aiContext(opts.scope ?? 'default')
      if (!ctx.enabled) throw new Error('disabled')
      const prompt = `You translate a business question into ONE report specification for SeereonOS (IT services / SAP consulting company, India, money in INR).
You never calculate numbers — the report engine does. Reply with ONLY JSON: {"spec": ReportSpec, "explanation": "one short sentence saying what will be computed"}.

${specRules(ctx)}

${catalogue(ctx)}

QUESTION: ${question}`
      const out = await sample.json<{ spec?: unknown; explanation?: string }>(prompt, { modelTier: 'default', signal: opts.signal, cache: { gcTime: 10 * 60_000 } })
      const v = validateSpec(out?.spec ?? out, ctx.datasets)
      if (v) return { spec: v.spec, explanation: String(out?.explanation ?? '').slice(0, 300) || 'Report planned from your question.', source: 'llm', warnings: v.warnings }
    } catch (e) {
      if ((e as { code?: string })?.code === 'cancelled') throw e
      onSampleError(e)
    }
  }
  const p = await reportsApi.aiPlan(question)
  return { spec: p.spec, explanation: p.explanation, source: 'rules', confidence: p.confidence }
}

/* ------------------------------------------------------------------ */
/* (b) Chat assistant with data tools                                    */
/* ------------------------------------------------------------------ */
export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}
export interface AssistantReply {
  text: string
  source: 'llm' | 'rules'
  answer: AiAnswer | null
  tools: string[]
  note?: string
}

/** Small, pre-formatted payload for the model: it can quote values but has nothing to compute. */
export function compactResult(res: ReportResultX) {
  const cols = res.columns
  return {
    title: res.spec.title,
    period: res.periodLabel,
    row_count: res.rowCount,
    columns: cols.map((c) => c.label),
    rows: res.rows.slice(0, 25).map((r) => Object.fromEntries(cols.map((c) => [c.label, fmtCell(r[c.key], c)]))),
    totals: Object.fromEntries(cols.filter((c) => res.totals[c.key] !== undefined && res.totals[c.key] !== null).map((c) => [c.label, fmtCell(res.totals[c.key], c)])),
    ...(res.totalsPrev ? { previous_period: res.previousLabel, previous_totals: Object.fromEntries(cols.filter((c) => res.totalsPrev![c.key] !== undefined).map((c) => [c.label, fmtCell(res.totalsPrev![c.key], c)])) } : {}),
    computed_summary: narrate(res),
    warnings: res.warnings,
  }
}

const FOLLOW_UP = /^(and |also |only |just |now |what about |how about |same |but |by |for |split |break it |per |in |show it |as a )/i
/** Merges a short follow-up ("by month", "only SAP") with the previous question for the rules path. */
export function withFollowUp(history: ChatTurn[], q: string) {
  const prev = [...history].reverse().find((m) => m.role === 'user')
  if (prev && (FOLLOW_UP.test(q.trim()) || q.trim().split(/\s+/).length <= 3)) return `${prev.content} ${q}`
  return q
}

export async function askAssistant(messages: ChatTurn[], opts: { onText?: (text: string) => void; onStatus?: (s: string) => void; signal?: AbortSignal; scope?: string } = {}): Promise<AssistantReply> {
  const last = [...messages].reverse().find((m) => m.role === 'user')
  if (!last) throw new Error('No question')
  const sample = await getSample()
  let note: string | undefined
  if (sample) {
    try {
      const ctx = await aiContext(opts.scope ?? 'default')
      const limits = await sample.limits().catch(() => null)
      if (limits?.tools) return await llmWithTools(sample, ctx, messages, opts)
      // no tool support in this view: plan with the LLM, compute on the server, narrate from the result
      const plan = await planReport(last.content, { scope: opts.scope, signal: opts.signal })
      const ans = await reportsApi.aiAnswer({ spec: plan.spec, explanation: plan.explanation, source: plan.source })
      opts.onText?.(ans.narrative)
      return { text: ans.narrative, source: plan.source, answer: { ...ans, source: plan.source }, tools: ['run_report'] }
    } catch (e) {
      if ((e as { code?: string })?.code === 'cancelled') throw e
      const code = onSampleError(e)
      note = code === 'not_granted' ? 'AI was not allowed in this view, so the rules engine answered.' : 'The AI model was unavailable, so the rules engine answered.'
    }
  }
  const q = withFollowUp(messages.slice(0, -1), last.content)
  opts.onStatus?.('Planning the report…')
  const ans = await reportsApi.aiAnswer({ question: q })
  opts.onText?.(ans.narrative)
  return { text: ans.narrative, source: 'rules', answer: ans, tools: ['plan', 'run_report'], note }
}

async function llmWithTools(sample: SampleFn, ctx: AiContext, messages: ChatTurn[], opts: { onText?: (t: string) => void; onStatus?: (s: string) => void; signal?: AbortSignal }): Promise<AssistantReply> {
  let lastRun: { spec: ReportSpec; result: ReportResultX } | null = null
  const used: string[] = []
  const tools: SampleTool[] = [
    {
      name: 'run_report',
      description: 'Runs a ReportSpec on the company data and returns the computed table (formatted values, totals and a computed summary). Use it for any number, list, trend or breakdown.',
      inputSchema: { type: 'object', properties: { spec: { type: 'object', description: 'ReportSpec as described in the instructions' } }, required: ['spec'] },
      async execute(input) {
        opts.onStatus?.('Running a report…')
        used.push('run_report')
        const v = validateSpec((input as { spec?: unknown }).spec ?? input, ctx.datasets)
        if (!v) throw new Error('Unknown dataset. Use one of: ' + ctx.datasets.map((d) => d.id).join(', '))
        const res = await reportsApi.run(v.spec)
        lastRun = { spec: res.spec, result: res }
        return compactResult(res)
      },
    },
    {
      name: 'get_project_health',
      description: 'Returns live projects with health, progress %, SPI, effort ratio, projected margin % (if the viewer may see it), overdue/blocked counts and next milestone.',
      async execute() {
        opts.onStatus?.('Checking project health…')
        used.push('get_project_health')
        return reportsApi.toolProjectHealth()
      },
    },
    {
      name: 'get_pipeline',
      description: 'Returns the sales pipeline: open and weighted value (rupees), win rate %, average cycle days and stale deals. Sales and admins only.',
      async execute() {
        opts.onStatus?.('Reading the pipeline…')
        used.push('get_pipeline')
        return reportsApi.toolPipeline()
      },
    },
    {
      name: 'get_approvals_status',
      description: 'Returns timesheet weeks waiting for approval with person, approver, SLA due date and whether overdue.',
      async execute() {
        opts.onStatus?.('Checking approvals…')
        used.push('get_approvals_status')
        return reportsApi.toolApprovals()
      },
    },
    {
      name: 'list_entities',
      description: 'Lists exact names of people, projects, clients, products or ledger_categories for filters.',
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['people', 'projects', 'clients', 'products', 'ledger_categories'] } }, required: ['kind'] },
      async execute(input) {
        used.push('list_entities')
        return reportsApi.toolEntities(String((input as { kind?: string }).kind ?? 'people'))
      },
    },
  ]
  const rules = `You are Seereon AI inside SeereonOS, the operating system of ${ctx.tenant} (IT services / SAP consulting, India). The user is ${ctx.me}.
Answer business questions using ONLY numbers returned by the tools. NEVER calculate, estimate, add, subtract or convert numbers yourself, and never invent figures. If a figure you need is not in a tool result, run another report that computes it (the report engine does sums, averages, counts, periods and previous-period comparison).
Prefer one run_report call that answers the question directly. Quote values exactly as the tool formatted them (₹ with Indian grouping). Keep answers short: 2–5 sentences or a few bullets, lead with the answer, mention the period. If the data can't answer it, say so and suggest a better question.

${specRules(ctx)}

${catalogue(ctx)}`
  const trimmed = messages.slice(-8).filter((m) => m.content.trim())
  const input: Msg[] = [{ role: 'user', content: rules }, ...trimmed.map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))]
  if (input[1]?.role === 'assistant') input.splice(1, 1)
  opts.onStatus?.('Thinking…')
  const { text } = await sample(input, { tools, signal: opts.signal, modelTier: 'default', onText: ({ text }) => opts.onText?.(text) })
  const run = lastRun as { spec: ReportSpec; result: ReportResultX } | null
  const answer: AiAnswer | null = run
    ? { spec: run.spec, result: run.result, explanation: '', confidence: 1, source: 'llm', narrative: narrate(run.result), described: describeSpec(run.spec) }
    : null
  return { text: text.trim(), source: 'llm', answer, tools: used }
}

/** One-shot explanation of an already computed result ("Explain with AI"). */
export async function explainResult(res: ReportResultX, opts: { onText?: (t: string) => void; signal?: AbortSignal } = {}): Promise<{ text: string; source: 'llm' | 'rules' }> {
  const facts = compactResult(res)
  const sample = await getSample()
  if (sample) {
    try {
      const prompt = `Explain this report to a busy CEO in 3–5 short bullet points: what stands out, what to watch, and one suggested next question.
Use ONLY the values below, quoted exactly as written. Do not calculate or invent any number.

REPORT: ${JSON.stringify(facts)}`
      const { text } = await sample(prompt, { modelTier: 'default', signal: opts.signal, onText: ({ text }) => opts.onText?.(text), cache: { gcTime: 10 * 60_000 } })
      return { text, source: 'llm' }
    } catch (e) {
      if ((e as { code?: string })?.code === 'cancelled') throw e
      onSampleError(e)
    }
  }
  const text = narrate(res)
  opts.onText?.(text)
  return { text, source: 'rules' }
}

export { AGG_LABEL }
