// Costing & margin rules (BR-23..BR-26). Single source for every money screen.
import type { CostRate, ISODate, Paise } from '@/types/entities'

/** BR-23: cost per hour = monthly CTC ÷ (working days × minimum hours). Returns paise (float). */
export function costPerHour(monthlyCtcPaise: Paise, workingDays: number, minHours: number): number {
  const denom = workingDays * minHours
  return denom > 0 ? monthlyCtcPaise / denom : 0
}

/** Cost always uses the rate valid on the day the hours were worked. */
export function rateOn(rates: CostRate[], userId: string, date: ISODate): CostRate | null {
  let best: CostRate | null = null
  for (const r of rates) {
    if (r.user_id !== userId || r.effective_from > date) continue
    if (!best || r.effective_from > best.effective_from) best = r
  }
  return best
}

/** BR-24 */
export function marginPct(revenue: number, cost: number): number | null {
  return revenue > 0 ? (revenue - cost) / revenue : null
}
export function markupPct(revenue: number, cost: number): number | null {
  return cost > 0 ? (revenue - cost) / cost : null
}
/** BR-26 */
export function effortRatio(actualHours: number, estHours: number): number | null {
  return estHours > 0 ? actualHours / estHours : null
}

export type Health = 'on_track' | 'at_risk' | 'off_track'
/** At risk = projected margin below floor OR effort ratio above alert. Off track = both, or margin negative. */
export function projectHealth(opts: { projectedMargin: number | null; effortRatio: number | null; floor: number; alert: number; overdueMilestones?: number }): Health {
  const lowMargin = opts.projectedMargin !== null && opts.projectedMargin < opts.floor
  const slow = opts.effortRatio !== null && opts.effortRatio > opts.alert
  const negative = opts.projectedMargin !== null && opts.projectedMargin < 0
  if (negative || (lowMargin && slow) || (opts.overdueMilestones ?? 0) >= 2) return 'off_track'
  if (lowMargin || slow || (opts.overdueMilestones ?? 0) === 1) return 'at_risk'
  return 'on_track'
}

/** BR-14/15 sales compensation for a month. */
export function salesCompensation(monthlyCtc: Paise, variablePct: number, targetPaise: Paise | null, achievedPaise: Paise, thresholdPct = 100) {
  const variable = Math.round((monthlyCtc * variablePct) / 100)
  const base = monthlyCtc - variable
  const target = targetPaise ?? monthlyCtc
  const achievement = target > 0 ? achievedPaise / target : 0
  const earned = achievement * 100 >= thresholdPct ? variable : 0
  return { base, variable, target, achieved: achievedPaise, achievement, variableEarned: earned, payout: base + earned }
}

/* ------------------------------------------------------------------ */
/* v5 project cost calculator (Feature Guide §3, §6)                    */
/* ------------------------------------------------------------------ */
export const ADDITIONAL_COST_CATEGORIES: { value: string; label: string }[] = [
  { value: 'software', label: 'Software & licences' },
  { value: 'hardware', label: 'Hardware' },
  { value: 'travel', label: 'Travel' },
  { value: 'third_party', label: 'Third-party services' },
  { value: 'training', label: 'Training' },
  { value: 'other', label: 'Other' },
]
export const additionalCategoryLabel = (v: string) => ADDITIONAL_COST_CATEGORIES.find((c) => c.value === v)?.label ?? v

/** Commercial models offered first on the create form (others stay available). */
export const COMMERCIAL_MODELS = [
  { value: 'fixed', label: 'Fixed price' },
  { value: 'tm', label: 'Time & material' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'ams_retainer', label: 'AMS retainer' },
] as const
export const commercialShort = (m: string) => (m === 'fixed' ? 'Fixed price' : m === 'tm' ? 'Time & material' : m === 'subscription' ? 'Subscription' : m === 'ams_retainer' ? 'AMS retainer' : m)

export interface ParsedMilestone {
  line: number
  code: string // M1..Mn in delivery order (valid lines only)
  name: string
  amount_paise: number
  error: string | null
}
/**
 * AUTO MILESTONE SETUP: one milestone per line, in delivery order, with an optional billing amount after a "|".
 * Amounts accept digits with commas and an optional ₹, or lakh / thousand shorthands ("2L", "1.5 lakh", "75K").
 */
export function parseMilestoneLines(text: string): { items: ParsedMilestone[]; errors: string[] } {
  const items: ParsedMilestone[] = []
  const errors: string[] = []
  const seen = new Map<string, number>()
  let n = 0
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1
    const line = raw.trim()
    if (!line) return
    const bar = line.lastIndexOf('|')
    const name = (bar >= 0 ? line.slice(0, bar) : line).trim().replace(/\s+/g, ' ')
    const amtText = bar >= 0 ? line.slice(bar + 1).trim() : ''
    let error: string | null = null
    let amount = 0
    if (!name) error = `Line ${lineNo}: add the milestone name before the “|”.`
    else if (name.length > 120) error = `Line ${lineNo}: keep the name under 120 characters.`
    if (!error && amtText) {
      const p = parseAmount(amtText)
      if (p === null) error = `Line ${lineNo}: “${amtText}” isn’t an amount. Use digits, e.g. 200000.`
      else amount = p
    }
    if (!error) {
      const key = name.toLowerCase()
      if (seen.has(key)) error = `Line ${lineNo}: “${name}” is already on line ${seen.get(key)}. Give each milestone its own name.`
      else seen.set(key, lineNo)
    }
    if (error) errors.push(error)
    items.push({ line: lineNo, code: error ? '' : `M${++n}`, name, amount_paise: amount, error })
  })
  return { items, errors }
}
function parseAmount(s: string): number | null {
  const t = s.toLowerCase().replace(/[₹,\s]/g, '').replace(/^rs\.?/, '')
  const m = t.match(/^(\d+(?:\.\d+)?)(l|lakh|lakhs|lac|k|cr|crore)?$/)
  if (!m) return null
  const mult = !m[2] ? 1 : m[2] === 'k' ? 1e3 : m[2] === 'cr' || m[2] === 'crore' ? 1e7 : 1e5
  const v = Number(m[1]) * mult
  if (!Number.isFinite(v) || v < 0 || v > 1e10) return null
  return Math.round(v * 100)
}
