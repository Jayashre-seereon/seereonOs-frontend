// Working-calendar engine (BR-01, BR-02) and date helpers.
// In the real product the server owns these calculations; the mock server and a few
// read-only UI hints (e.g. greying weekly offs in the week grid) use the same functions.
import type { Holiday, ISODate, TenantSettings } from '@/types/entities'

export interface CalendarCtx {
  settings: Pick<TenantSettings, 'calendar.weekly_off' | 'calendar.saturday_rule' | 'calendar.saturday_off_weeks' | 'calendar.min_hours_per_day'>
  holidays: Pick<Holiday, 'date' | 'name' | 'optional'>[] | Set<string>
  leaveDates?: Set<string> // the person's approved leave (full days)
}

export const DAY_MS = 86400000

export function toISO(d: Date): ISODate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
export function parseISO(s: ISODate): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1)
}
export function todayISO(): ISODate {
  return toISO(new Date())
}
/** True only for a real calendar date in YYYY-MM-DD form — rejects shapes like 2027-02-30 that a
 *  format-only regex lets through (JS Date would silently roll them into March). */
export function isRealISODate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  return toISO(parseISO(s)) === s
}
export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISO(s)
  d.setDate(d.getDate() + n)
  return toISO(d)
}
export function addMonths(s: ISODate, n: number): ISODate {
  const d = parseISO(s)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return toISO(d)
}
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(a).getTime() - parseISO(b).getTime()) / DAY_MS)
}
export function weekStart(s: ISODate): ISODate {
  const d = parseISO(s)
  const dow = (d.getDay() + 6) % 7 // Monday = 0
  d.setDate(d.getDate() - dow)
  return toISO(d)
}
export function weekDays(monday: ISODate): ISODate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}
export function monthOf(s: ISODate): string {
  return s.slice(0, 7)
}
export function monthRange(ym: string): { from: ISODate; to: ISODate } {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}
export function minISO(a: ISODate, b: ISODate) {
  return a < b ? a : b
}
export function maxISO(a: ISODate, b: ISODate) {
  return a > b ? a : b
}

function holidaySet(h: CalendarCtx['holidays']): Set<string> {
  if (h instanceof Set) return h
  return new Set(h.filter((x) => !x.optional).map((x) => x.date))
}

const cache = new WeakMap<object, Set<string>>()
function hs(ctx: CalendarCtx) {
  if (ctx.holidays instanceof Set) return ctx.holidays
  let s = cache.get(ctx.holidays)
  if (!s) {
    s = holidaySet(ctx.holidays)
    cache.set(ctx.holidays, s)
  }
  return s
}

/** nth Saturday of the month (1..5) */
export function saturdayOrdinal(s: ISODate): number {
  return Math.ceil(parseISO(s).getDate() / 7)
}

export function isWeeklyOff(s: ISODate, ctx: CalendarCtx): boolean {
  const dow = parseISO(s).getDay()
  if (dow === 6) {
    const rule = ctx.settings['calendar.saturday_rule']
    if (rule === 'all_off') return true
    if (rule === 'all_on') return ctx.settings['calendar.weekly_off'].includes(6)
    return ctx.settings['calendar.saturday_off_weeks'].includes(saturdayOrdinal(s))
  }
  return ctx.settings['calendar.weekly_off'].includes(dow)
}

export type DayKind = 'working' | 'weekly_off' | 'holiday' | 'leave'
export function dayKind(s: ISODate, ctx: CalendarCtx): DayKind {
  if (isWeeklyOff(s, ctx)) return 'weekly_off'
  if (hs(ctx).has(s)) return 'holiday'
  if (ctx.leaveDates?.has(s)) return 'leave'
  return 'working'
}

/** BR-01: not a weekly off, not a holiday and not the person's approved leave. */
export function isWorkingDay(s: ISODate, ctx: CalendarCtx): boolean {
  return dayKind(s, ctx) === 'working'
}

export function workingDaysBetween(from: ISODate, to: ISODate, ctx: CalendarCtx): number {
  if (to < from) return 0
  let n = 0
  for (let d = from; d <= to; d = addDays(d, 1)) if (isWorkingDay(d, ctx)) n++
  return n
}

export function workingDaysInMonth(ym: string, ctx: CalendarCtx): number {
  const { from, to } = monthRange(ym)
  return workingDaysBetween(from, to, { ...ctx, leaveDates: undefined })
}

/** Adds n working days (n>=0). Used for approval SLA due dates (BR-10). */
export function addWorkingDays(from: ISODate, n: number, ctx: CalendarCtx): ISODate {
  let d = from
  let left = n
  while (left > 0) {
    d = addDays(d, 1)
    if (isWorkingDay(d, ctx)) left--
  }
  return d
}

/* ---------- Financial year & periods ---------- */
export function fyStartYear(s: ISODate, fyStartMonth = 4): number {
  const d = parseISO(s)
  return d.getMonth() + 1 >= fyStartMonth ? d.getFullYear() : d.getFullYear() - 1
}
export function fyLabel(startYear: number): string {
  return `FY${String(startYear % 100).padStart(2, '0')}-${String((startYear + 1) % 100).padStart(2, '0')}`
}
export function fyRange(startYear: number, fyStartMonth = 4) {
  const from = `${startYear}-${String(fyStartMonth).padStart(2, '0')}-01`
  const to = addDays(addMonths(from, 12), -1)
  return { from, to }
}
export function quarterOf(s: ISODate, fyStartMonth = 4) {
  const y = fyStartYear(s, fyStartMonth)
  const d = parseISO(s)
  const monthsIn = (d.getFullYear() * 12 + d.getMonth()) - (y * 12 + fyStartMonth - 1)
  const q = Math.floor(monthsIn / 3) + 1
  const from = addMonths(`${y}-${String(fyStartMonth).padStart(2, '0')}-01`, (q - 1) * 3)
  const to = addDays(addMonths(from, 3), -1)
  return { q, fy: y, label: `Q${q} ${fyLabel(y)}`, from, to }
}

export type PeriodKind = 'month' | 'quarter' | 'fy'
export function periodRange(kind: PeriodKind, anchor: ISODate, fyStartMonth = 4) {
  if (kind === 'month') {
    const r = monthRange(monthOf(anchor))
    return { ...r, label: parseISO(anchor).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) }
  }
  if (kind === 'quarter') {
    const q = quarterOf(anchor, fyStartMonth)
    return { from: q.from, to: q.to, label: q.label }
  }
  const y = fyStartYear(anchor, fyStartMonth)
  return { ...fyRange(y, fyStartMonth), label: fyLabel(y) }
}
export function previousPeriod(kind: PeriodKind, anchor: ISODate, fyStartMonth = 4) {
  const cur = periodRange(kind, anchor, fyStartMonth)
  return periodRange(kind, addDays(cur.from, -1), fyStartMonth)
}

/* ---------- Display ---------- */
export function fmtDate(s: ISODate | null | undefined, opts: 'short' | 'long' | 'day' = 'short'): string {
  if (!s) return '—'
  const d = parseISO(s)
  if (opts === 'day') return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric' })
  if (opts === 'long') return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}
export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}
export function relTime(s: string | null | undefined): string {
  if (!s) return '—'
  const ms = Date.now() - new Date(s).getTime()
  const m = Math.round(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return fmtDate(s.slice(0, 10))
}
export function weekLabel(monday: ISODate): string {
  const end = addDays(monday, 6)
  const a = parseISO(monday)
  const b = parseISO(end)
  const sameMonth = a.getMonth() === b.getMonth()
  const left = a.toLocaleDateString('en-IN', { day: 'numeric', ...(sameMonth ? {} : { month: 'short' }) })
  const right = b.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${left} – ${right}`
}

/** Average working days per month over a financial year, after weekly offs and holidays (one decimal).
 *  Feature Guide §16: "23.8 working days a month on average this financial year" — the divisor for cost per day. */
export function avgWorkingDaysPerMonth(fyStart: number, ctx: CalendarCtx, fyStartMonth = 4): number {
  const { from } = fyRange(fyStart, fyStartMonth)
  let total = 0
  for (let i = 0; i < 12; i++) total += workingDaysInMonth(monthOf(addMonths(from, i)), ctx)
  return Math.round((total / 12) * 10) / 10
}
