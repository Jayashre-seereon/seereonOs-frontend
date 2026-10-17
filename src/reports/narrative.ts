// Template narrative for a ReportResult. Every number printed here is read from the result the
// engine computed — nothing is estimated. Used by the rules path and as a fallback for the LLM.
import type { ReportResultX, ReportColumnX } from './engine'
import { fmtMoney, fmtMoneyCompact, fmtNum, fmtPct } from '@/domain/money'

export function fmtCell(v: unknown, c: Pick<ReportColumnX, 'type' | 'unit'>, compact = false): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (c.type === 'money' && typeof v === 'number') return compact ? fmtMoneyCompact(v) : fmtMoney(v)
  if (c.type === 'percent' && typeof v === 'number') return fmtPct(v)
  if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const d = new Date(v.slice(0, 10) + 'T00:00:00')
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  }
  if (typeof v === 'number') {
    if (c.unit === 'hours') return `${fmtNum(v, 1)}h`
    if (c.unit === 'days') return `${fmtNum(v, 0)}d`
    return fmtNum(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : 0)
  }
  return String(v)
}

export function narrate(res: ReportResultX, _opts: { fyStart?: number } = {}): string {
  const measures = res.columns.filter((c) => c.role === 'measure')
  const dims = res.columns.filter((c) => c.role === 'dimension')
  const period = res.periodLabel && res.periodLabel !== 'All time' ? ` for ${res.periodLabel.replace(/^This /, 'this ').replace(/^Last /, 'the last ')}` : ''
  const out: string[] = []
  if (!measures.length) {
    const n = res.rowCount
    if (!n) return `Nothing matches${period}. That’s good news if you were looking for problems.`
    const first = res.rows[0]
    const firstCol = res.columns[0]
    const lead = first ? ` The first is ${fmtCell(first[firstCol.key], firstCol)}${res.columns[1] ? ` (${fmtCell(first[res.columns[1].key], res.columns[1])})` : ''}.` : ''
    out.push(`${n} ${n === 1 ? 'row matches' : 'rows match'}${period}.${lead}`)
    const moneyTotal = res.columns.find((c) => c.type === 'money' && res.totals[c.key] !== undefined)
    if (moneyTotal && res.totals[moneyTotal.key]) out.push(`Together they add up to ${fmtCell(res.totals[moneyTotal.key], moneyTotal)} of ${moneyTotal.label.toLowerCase()}.`)
    return out.join(' ')
  }
  const m = measures[0]
  const total = res.totals[m.key]
  const time = dims.find((d) => d.grain)
  if (!dims.length) {
    out.push(`${m.label}${period} is ${fmtCell(total, m)}.`)
    for (const mm of measures.slice(1)) out.push(`${mm.label}: ${fmtCell(res.totals[mm.key], mm)}.`)
  } else if (time && dims.length === 1) {
    const vals = res.rows.map((r) => ({ label: String(r[time.key]), v: typeof r[m.key] === 'number' ? (r[m.key] as number) : null }))
    const nonNull = vals.filter((x) => x.v !== null) as { label: string; v: number }[]
    if (m.key === 'count' || m.key.startsWith('sum_')) out.push(`${m.label}${period} totals ${fmtCell(total, m)}.`)
    if (nonNull.length) {
      const best = nonNull.reduce((a, b) => (b.v > a.v ? b : a))
      const worst = nonNull.reduce((a, b) => (b.v < a.v ? b : a))
      if (nonNull.length > 1) out.push(`The highest ${time.grain === 'week' ? 'week' : time.grain ?? 'period'} was ${best.label} at ${fmtCell(best.v, m)}; the lowest was ${worst.label} at ${fmtCell(worst.v, m)}.`)
      const last = nonNull[nonNull.length - 1]
      const prev = nonNull[nonNull.length - 2]
      if (prev && prev.v) {
        const ch = (last.v - prev.v) / Math.abs(prev.v)
        out.push(`${last.label} is ${ch >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(ch))} on ${prev.label}.`)
      }
    }
    for (const mm of measures.slice(1)) out.push(`${mm.label} over the same period: ${fmtCell(res.totals[mm.key], mm)}.`)
  } else {
    const d = dims[0]
    const sorted = [...res.rows].filter((r) => typeof r[m.key] === 'number').sort((a, b) => (b[m.key] as number) - (a[m.key] as number))
    const groups = res.rowCount
    const additive = m.key === 'count' || m.key.startsWith('sum_')
    if (additive) out.push(`${m.label}${period}: ${fmtCell(total, m)} in total across ${groups} ${d.label.toLowerCase()}${groups === 1 ? '' : ' groups'}.`)
    else out.push(`${m.label}${period} across ${groups} ${d.label.toLowerCase()} groups is ${fmtCell(total, m)} overall.`)
    const top = sorted[0]
    if (top) {
      const share = additive && typeof total === 'number' && total > 0 ? ` (${fmtPct((top[m.key] as number) / total)} of the total)` : ''
      out.push(`${String(top[d.key])} leads with ${fmtCell(top[m.key], m)}${share}.`)
      const second = sorted[1]
      if (second) out.push(`Next is ${String(second[d.key])} at ${fmtCell(second[m.key], m)}.`)
      const low = sorted[sorted.length - 1]
      if (sorted.length > 3 && low) out.push(`${String(low[d.key])} is lowest at ${fmtCell(low[m.key], m)}.`)
    }
    for (const mm of measures.slice(1, 3)) out.push(`${mm.label} in total: ${fmtCell(res.totals[mm.key], mm)}.`)
  }
  if (res.totalsPrev && total !== null && total !== undefined) {
    const prev = res.totalsPrev[m.key]
    if (typeof prev === 'number' && prev !== 0 && typeof total === 'number') {
      const ch = (total - prev) / Math.abs(prev)
      out.push(`That’s ${ch >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(ch))} from ${fmtCell(prev, m)} in ${res.previousLabel ?? 'the previous period'}.`)
    } else if (prev === 0) out.push(`There was nothing in ${res.previousLabel ?? 'the previous period'} to compare with.`)
  }
  if (!res.rowCount) return `No data${period} for this question. Try a longer period or fewer filters.`
  return out.join(' ')
}
