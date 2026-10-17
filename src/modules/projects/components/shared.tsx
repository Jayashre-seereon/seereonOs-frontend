import type { ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Circle, Clock, Flag, Info } from '@/ui/icons'
import type { Tone } from '@/domain/labels'
import { PROJECT_STATUS } from '@/domain/labels'
import type { ProjectStatus } from '@/types/entities'
import type { MilestoneDelivery } from '@/api/projects'
import { projectsApi } from '@/api/projects'
import { useMut } from '@/api/query'
import { Badge, Menu, Popover, StatusBadge, useConfirm } from '@/ui'
import { cn } from '@/lib/utils'
import { fmtPct } from '@/domain/money'

export const MS_STATE: Record<MilestoneDelivery, { label: string; tone: Tone; icon: ReactNode }> = {
  achieved_on_time: { label: 'Achieved on time', tone: 'success', icon: <CheckCircle2 /> },
  achieved_late: { label: 'Achieved late', tone: 'warning', icon: <CheckCircle2 /> },
  on_track: { label: 'On track', tone: 'info', icon: <Clock /> },
  at_risk: { label: 'At risk', tone: 'warning', icon: <AlertTriangle /> },
  overdue: { label: 'Overdue', tone: 'danger', icon: <Flag /> },
  not_started: { label: 'Not started', tone: 'neutral', icon: <Circle /> },
}

export const PROJECT_STATUS_ORDER: ProjectStatus[] = ['initiated', 'active', 'on_hold', 'npa', 'completed', 'closed']

/** Feature Guide §3 status table, verbatim ("Status — Means"). */
export const PROJECT_STATUS_MEANING: Record<ProjectStatus, string> = {
  initiated: 'Signed or agreed, work not started',
  active: 'Work in progress',
  on_hold: 'Paused; reason required',
  npa: 'Client not paying or not responding; reason required',
  completed: 'All work delivered, awaiting closure or final payment',
  closed: 'Commercially closed; reason required',
}

/** The guide's status table as a small table (popover next to the status chips). */
export function StatusMeaningsTable({ className }: { className?: string }) {
  return (
    <table className={cn('w-full text-[13px]', className)}>
      <thead>
        <tr className="border-b border-line text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
          <th className="py-1.5 pr-3">Status</th>
          <th className="py-1.5">Means</th>
        </tr>
      </thead>
      <tbody>
        {PROJECT_STATUS_ORDER.map((s) => (
          <tr key={s} className="border-b border-line last:border-0 align-top">
            <td className="whitespace-nowrap py-1.5 pr-3"><StatusBadge map={PROJECT_STATUS} value={s} size="sm" /></td>
            <td className="py-1.5 leading-snug text-ink-2">{PROJECT_STATUS_MEANING[s]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
export function StatusMeaningsPopover() {
  return (
    <Popover
      align="start"
      className="w-[min(380px,calc(100vw-32px))]"
      trigger={
        <button type="button" className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="What each status means">
          <Info className="size-4" />
          <span>What the statuses mean</span>
        </button>
      }
    >
      <div className="mb-1 text-[13px] font-semibold text-ink">Project statuses</div>
      <StatusMeaningsTable />
      <p className="mt-2 text-[12px] leading-snug text-ink-3">Every change is kept in the project’s status history (Activity tab).</p>
    </Popover>
  )
}

/** Status dropdown with the meaning of each status under its name (list rows and the project header). */
export function ProjectStatusMenu({ p, disabled, title, onChange, children, inBox }: { p: { name: string; status: ProjectStatus }; disabled?: boolean; title?: string; onChange: (s: ProjectStatus) => void; children?: ReactNode; inBox?: boolean }) {
  const trigger = (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={`Status of ${p.name}: ${PROJECT_STATUS[p.status].label}. ${PROJECT_STATUS_MEANING[p.status]}`}
      className="inline-flex items-center gap-0.5 rounded-sm disabled:cursor-default"
    >
      {children ?? <StatusBadge map={PROJECT_STATUS} value={p.status} size="sm" />}
      {!disabled && <ChevronDown className={cn('size-3.5 text-ink-3', inBox && '-ml-6 mr-2.5')} />}
    </button>
  )
  if (disabled) return trigger
  return (
    <Menu
      label="Change status"
      align="start"
      trigger={trigger}
      items={PROJECT_STATUS_ORDER.map((s) => ({
        icon: s === p.status ? <Check /> : <span />,
        disabled: s === p.status,
        label: (
          <span className="block max-w-[280px]">
            <span className="block">{s === p.status ? PROJECT_STATUS[s].label : `Move to ${PROJECT_STATUS[s].label}`}</span>
            <span className="block text-[12px] font-normal leading-snug text-ink-3">{PROJECT_STATUS_MEANING[s]}</span>
          </span>
        ),
        onSelect: () => onChange(s),
      }))}
    />
  )
}

export function MsStateBadge({ state, size }: { state: MilestoneDelivery; size?: 'sm' | 'md' }) {
  const s = MS_STATE[state]
  return (
    <Badge tone={s.tone} size={size}>
      {s.label}
    </Badge>
  )
}

/** Colour stripe / dot in the project's identity hue. */
export function hueColor(h: number, l = 46) {
  return `hsl(${h} 58% ${l}%)`
}
export function ProjectDot({ hue, className }: { hue: number; className?: string }) {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full', className)} style={{ background: hueColor(hue) }} />
}

export function ratioTone(v: number | null | undefined, alert = 1.2): Tone {
  if (v === null || v === undefined) return 'neutral'
  return v > alert ? 'danger' : v > 1 ? 'warning' : 'success'
}
export function spiTone(v: number | null | undefined): Tone {
  if (v === null || v === undefined) return 'neutral'
  return v >= 0.95 ? 'success' : v >= 0.8 ? 'warning' : 'danger'
}
export function marginTone(v: number | null | undefined, floorPct = 25): Tone {
  if (v === null || v === undefined) return 'neutral'
  return v < 0 ? 'danger' : v < floorPct / 100 ? 'danger' : v < floorPct / 100 + 0.05 ? 'warning' : 'success'
}
export function fmtRatio(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : `×${v.toFixed(2)}`
}
export function MarginChip({ value, floorPct }: { value: number | null | undefined; floorPct?: number }) {
  if (value === null || value === undefined) return null
  return (
    <Badge tone={marginTone(value, floorPct)} size="sm">
      {fmtPct(value)} margin
    </Badge>
  )
}

/** Status change with the BR-17 reason dialog, shared by the list and the project header. */
export function useProjectStatusChange() {
  const { askReason, confirm } = useConfirm()
  const mut = useMut((v: { id: string; status: ProjectStatus; reason: string | null }) => projectsApi.setStatus(v.id, v.status, v.reason), {
    invalidate: [['projects'], ['project']],
    success: (_r, v) => `Moved to ${PROJECT_STATUS[v.status].label}`,
  })
  const change = async (p: { id: string; name: string; status: ProjectStatus }, to: ProjectStatus) => {
    if (to === p.status) return
    let reason: string | null = null
    if (PROJECT_STATUS[to].needsReason) {
      reason = await askReason({
        title: `Move to ${PROJECT_STATUS[to].label}?`,
        body: `${PROJECT_STATUS[to].label}: ${PROJECT_STATUS_MEANING[to]}. ${p.name} will show as ${PROJECT_STATUS[to].label}, and the reason is kept in the status history.`,
        label: 'Reason',
        placeholder: to === 'on_hold' ? 'e.g. Client has paused UAT until the new fiscal year' : to === 'npa' ? 'e.g. Invoices overdue 90+ days; escalated to client CFO' : 'e.g. Delivered and all invoices collected',
        confirmLabel: `Move to ${PROJECT_STATUS[to].label}`,
        tone: to === 'npa' ? 'danger' : 'primary',
      })
      if (!reason) return
    } else if (to === 'completed') {
      const ok = await confirm({ title: `Mark ${p.name} completed?`, body: `Completed: ${PROJECT_STATUS_MEANING.completed}. Health tracking stops for completed projects. You can reopen it later.`, confirmLabel: 'Mark completed' })
      if (!ok) return
    }
    mut.mutate({ id: p.id, status: to, reason })
  }
  return { change, pending: mut.isPending }
}

export function Legend({ items }: { items: { label: string; swatch: ReactNode }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5">
          {i.swatch}
          {i.label}
        </span>
      ))}
    </div>
  )
}

export function MiniStat({ label, value, tone, sub }: { label: ReactNode; value: ReactNode; tone?: Tone; sub?: ReactNode }) {
  const t = { neutral: 'text-ink', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }[tone ?? 'neutral']
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium leading-tight text-ink-3">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap text-[18px] font-semibold leading-tight tracking-[-0.01em]', t)}>{value}</div>
      {sub && <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{sub}</div>}
    </div>
  )
}
