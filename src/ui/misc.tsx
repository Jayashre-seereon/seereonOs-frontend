import { useRef, useState, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { ChevronLeft, ChevronRight, FileUp, Paperclip, X } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { useSession, useEffectivePermissions } from '@/stores/session'
import { can, type Action } from '@/domain/permissions'
import { addDays, periodRange, previousPeriod, todayISO, type PeriodKind } from '@/domain/calendar'
import { Segmented } from './form'
import { IconButton } from './Button'

/* ---------------- Underline tabs (page-level) ---------------- */
export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; count?: number; hidden?: boolean }[]; className?: string }) {
  return (
    <div className={cn('-mx-4 mb-5 overflow-x-auto border-b border-line px-4 no-scrollbar md:mx-0 md:px-0', className)}>
      <div role="tablist" className="flex gap-5">
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => (
            <button
              key={t.value}
              role="tab"
              type="button"
              aria-selected={value === t.value}
              onClick={() => onChange(t.value)}
              className={cn(
                'relative -mb-px inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 text-[14px] transition',
                value === t.value ? 'border-brand font-medium text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
              )}
            >
              {t.label}
              {t.count !== undefined && <span className={cn('tnum rounded-full px-1.5 text-[11.5px]', value === t.value ? 'bg-brand-soft text-brand-text' : 'bg-surface-2 text-ink-3')}>{t.count}</span>}
            </button>
          ))}
      </div>
    </div>
  )
}
/** Route-driven tabs */
export function NavTabs({ tabs, className }: { tabs: { to: string; label: ReactNode; end?: boolean; hidden?: boolean }[]; className?: string }) {
  return (
    <div className={cn('-mx-4 mb-5 overflow-x-auto border-b border-line px-4 no-scrollbar md:mx-0 md:px-0', className)}>
      <div className="flex gap-5">
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => cn('-mb-px inline-flex h-11 shrink-0 items-center whitespace-nowrap border-b-2 text-[14px] transition', isActive ? 'border-brand font-medium text-ink' : 'border-transparent text-ink-3 hover:text-ink-2')}
            >
              {t.label}
            </NavLink>
          ))}
      </div>
    </div>
  )
}

/* ---------------- Period switch (CMP-20) ---------------- */
export interface PeriodValue {
  kind: PeriodKind
  anchor: string
}
export function usePeriod(kind: PeriodKind = 'month') {
  return useState<PeriodValue>({ kind, anchor: todayISO() })
}
export function PeriodSwitch({ value, onChange, fyStartMonth = 4, className }: { value: PeriodValue; onChange: (v: PeriodValue) => void; fyStartMonth?: number; className?: string }) {
  const r = periodRange(value.kind, value.anchor, fyStartMonth)
  const isCurrent = r.from <= todayISO() && todayISO() <= r.to
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Segmented
        size="sm"
        value={value.kind}
        onChange={(k) => onChange({ kind: k, anchor: todayISO() })}
        options={[
          { value: 'month', label: 'Month' },
          { value: 'quarter', label: 'Quarter' },
          { value: 'fy', label: 'Year' },
        ]}
      />
      <div className="flex items-center rounded-md border border-line bg-surface">
        <IconButton size="sm" label="Previous period" onClick={() => onChange({ ...value, anchor: previousPeriod(value.kind, value.anchor, fyStartMonth).from })}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <span className="tnum min-w-[104px] px-1 text-center text-[13px] font-semibold">{r.label}</span>
        <IconButton size="sm" label="Next period" disabled={isCurrent} onClick={() => onChange({ ...value, anchor: addDays(r.to, 1) })}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
    </div>
  )
}

/* ---------------- File upload (CMP-18) ---------------- */
const OK_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/svg+xml', 'text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
export function FileUpload({ onFile, accept, maxMb = 10, label = 'Drop a file or browse', hint, file, onClear }: { onFile: (f: File) => void; accept?: string; maxMb?: number; label?: string; hint?: string; file?: { name: string; size?: number } | null; onClear?: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const take = (f: File | undefined) => {
    if (!f) return
    if (f.size > maxMb * 1024 * 1024) return setError(`File is larger than ${maxMb} MB.`)
    if (!accept && f.type && !OK_TYPES.includes(f.type) && !/\.(csv|xlsx|docx|pdf|png|jpe?g|svg)$/i.test(f.name)) return setError('Use PDF, PNG, JPG, XLSX, CSV or DOCX.')
    setError(null)
    onFile(f)
  }
  if (file)
    return (
      <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
        <Paperclip className="size-4 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{file.name}</span>
        {file.size !== undefined && <span className="text-[12px] text-ink-3">{Math.max(1, Math.round(file.size / 1024))} KB</span>}
        {onClear && (
          <button type="button" aria-label="Remove file" onClick={onClear} className="grid size-6 place-items-center rounded-full text-ink-3 hover:bg-surface">
            <X className="size-3.5" />
          </button>
        )}
      </div>
    )
  return (
    <div>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDrag(false)
          take(e.dataTransfer.files?.[0])
        }}
        className={cn('flex w-full flex-col items-center gap-1.5 rounded-lg border-2 border-dashed px-4 py-6 text-center transition', drag ? 'border-brand bg-brand-soft' : 'border-line-strong hover:border-ink-3 hover:bg-surface-2')}
      >
        <FileUp className="size-5 text-ink-3" />
        <span className="text-[13.5px] font-semibold text-ink">{label}</span>
        <span className="text-[12px] text-ink-3">{hint ?? `PDF, PNG, JPG, XLSX, CSV or DOCX · up to ${maxMb} MB`}</span>
      </button>
      <input ref={ref} type="file" hidden accept={accept} onChange={(e) => take(e.target.files?.[0])} />
      {error && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{error}</p>}
    </div>
  )
}

/* ---------------- Permission gate (CMP-09) ---------------- */
export function useCan() {
  const perms = useEffectivePermissions()
  return (a: Action) => can(perms, a)
}
export function Can({ action, children, fallback = null }: { action: Action; children: ReactNode; fallback?: ReactNode }) {
  const c = useCan()
  return <>{c(action) ? children : fallback}</>
}
/** True while "View as" is active — every write control should be disabled. */
export function useReadOnly() {
  const { viewAs, tenant } = useSession()
  return !!viewAs || tenant?.status === 'read_only'
}
