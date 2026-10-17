// Shared bits for the spend & commercial screens.
import { useState, type ReactNode } from 'react'
import { Select } from '@/ui'
import { fyLabel } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/api/http'

/** Financial-year picker: last FY, this FY, next FY. */
export function FyPicker({ value, onChange, current, className }: { value: number; onChange: (fy: number) => void; current: number; className?: string }) {
  const opts = [current - 1, current, current + 1].map((y) => ({ value: String(y), label: `${fyLabel(y)}${y === current ? ' (this FY)' : ''}` }))
  return <Select aria-label="Financial year" value={String(value)} onChange={(e) => onChange(Number(e.target.value))} options={opts} className={cn('w-full sm:w-44', className)} />
}

/** Collects field errors from API errors (422/409 with `field`) so forms can show them inline. */
export function useFieldErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({})
  return {
    errors,
    clear: () => setErrors({}),
    take: (e: ApiError) => {
      if (e?.field) setErrors({ [e.field]: e.message })
    },
    unset: (k: string) => setErrors((x) => {
      if (!(k in x)) return x
      const n = { ...x }
      delete n[k]
      return n
    }),
  }
}

/** Grid of KPI tiles: 2 per row on phones, up to 4 on desktop. */
export function KpiRow({ children, cols = 4 }: { children: ReactNode; cols?: 3 | 4 }) {
  return <div className={cn('grid grid-cols-2 gap-3', cols === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>{children}</div>
}

/** Small "label · value" line used in mobile cards. */
export function Meta({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mt-0.5 truncate text-[12.5px] text-ink-3', className)}>{children}</div>
}

export function pct(v: number | null | undefined) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = (v * 100).toFixed(1).replace(/\.0$/, '')
  return `${v > 0 ? '+' : ''}${s}%`
}
