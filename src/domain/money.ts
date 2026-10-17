// Money is integer paise everywhere. These helpers only FORMAT and CONVERT.
import type { Paise } from '@/types/entities'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function rupees(p: Paise | null | undefined): number {
  return (p ?? 0) / 100
}
export function paise(rupeesValue: number | string): Paise {
  const n = typeof rupeesValue === 'string' ? Number(rupeesValue.replace(/[,₹\s]/g, '')) : rupeesValue
  return Math.round((Number.isFinite(n) ? n : 0) * 100)
}

/** ₹1,20,000 (Indian grouping). `decimals` shows paise. */
export function fmtMoney(p: Paise | null | undefined, opts: { decimals?: boolean; sign?: boolean } = {}): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '—'
  const r = p / 100
  const s = (opts.decimals ? inr2 : inr).format(Math.abs(r))
  const sign = r < 0 ? '−' : opts.sign && r > 0 ? '+' : ''
  return `${sign}₹${s}`
}

/** Compact Indian units: ₹950, ₹12.4K, ₹1.2L, ₹3.45Cr */
export function fmtMoneyCompact(p: Paise | null | undefined): string {
  if (p === null || p === undefined || Number.isNaN(p)) return '—'
  const r = p / 100
  const a = Math.abs(r)
  const sign = r < 0 ? '−' : ''
  const trim = (n: number, d: number) => n.toFixed(d).replace(/\.0+$|(\.\d*?)0+$/, '$1')
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7, 2)}Cr`
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5, 2)}L`
  if (a >= 1e3) return `${sign}₹${trim(a / 1e3, 1)}K`
  return `${sign}₹${inr.format(a)}`
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return `${(v * 100).toFixed(digits).replace(/\.0$/, '')}%`
}
export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v)
}
export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return '—'
  return `${fmtNum(h, 2)}h`
}
/** Relative change between two values, e.g. +12.4% */
export function change(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0
  return (cur - prev) / Math.abs(prev)
}
