// Dashboard building blocks shared by Home, Insights and Scorecard.
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ChevronRight, Sparkles } from '@/ui/icons'
import { useUI } from '@/stores/ui'
import { Avatar, Badge, Card, CardHeader, Progress, Tooltip } from '@/ui'
import { cn } from '@/lib/utils'
import { fmtDate } from '@/domain/calendar'
import { HEALTH, TASK_STATUS, type Tone } from '@/domain/labels'
import type { ProjectPill, TaskRow } from '@/api/dashboards'
import { fmtPct } from '@/domain/money'

/** Card with header; body padding off so lists/tables can run edge to edge. */
export function Panel({ title, subtitle, action, children, className, flush, id }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; flush?: boolean; id?: string }) {
  return (
    <Card className={cn('flex min-w-0 flex-col', flush && 'pb-0', className)} >
      <div id={id} />
      <CardHeader title={title} subtitle={subtitle} action={action} />
      <div className={cn('min-w-0 flex-1', flush && '-mx-4 md:-mx-5')}>{children}</div>
    </Card>
  )
}

export function SeeAll({ to, children = 'See all' }: { to: string; children?: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12.5px] font-medium text-brand-text hover:underline">
      {children}
      <ChevronRight className="size-3.5" />
    </Link>
  )
}

export function HealthDot({ health }: { health: keyof typeof HEALTH }) {
  const c = { on_track: 'bg-success', at_risk: 'bg-warning', off_track: 'bg-danger' }[health]
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', c)} aria-label={HEALTH[health].label} />
}

/** Active projects as pills coloured by health with progress, SPI / effort and margin. */
export function ProjectHealthStrip({ projects, showMargin, emptyText = 'No active projects.' }: { projects: ProjectPill[]; showMargin?: boolean; emptyText?: string }) {
  if (!projects.length) return <p className="px-1 py-6 text-center text-[13px] text-ink-3">{emptyText}</p>
  return (
    <div className="-mx-4 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0 xl:grid-cols-3 2xl:grid-cols-4">
      {projects.map((p) => {
        return (
          <Link key={p.id} to={`/projects/${p.id}`} className="group block w-[270px] min-w-0 shrink-0 snap-start overflow-hidden rounded-lg border border-line bg-surface p-3.5 transition hover:border-line-strong hover:bg-surface-2/50 md:w-auto">
            <div className="flex min-w-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-semibold text-ink" title={p.name}>{p.name}</div>
                <div className="truncate text-[11.5px] text-ink-3">
                  {p.code} · {p.client}
                </div>
              </div>
              <Badge size="sm" tone={HEALTH[p.health].tone}>
                {HEALTH[p.health].label}
              </Badge>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Progress value={p.progress} tone={p.health === 'off_track' ? 'danger' : p.health === 'at_risk' ? 'warning' : 'success'} className="flex-1" />
              <span className="tnum w-10 shrink-0 whitespace-nowrap text-right text-[12px] font-medium text-ink-2">{fmtPct(p.progress, 0)}</span>
            </div>
            <dl className="mt-2.5 grid grid-cols-3 gap-2 text-[12px]">
              <div>
                <dt className="text-ink-3">SPI</dt>
                <dd className={cn('tnum font-medium', p.spi !== null && p.spi < 0.9 ? 'text-danger-text' : 'text-ink')}>{p.spi === null ? '—' : p.spi.toFixed(2)}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Effort</dt>
                <dd className={cn('tnum font-medium', p.effort_ratio !== null && p.effort_ratio > 1.2 ? 'text-danger-text' : 'text-ink')}>{p.effort_ratio === null ? '—' : `×${p.effort_ratio.toFixed(2)}`}</dd>
              </div>
              <div>
                <dt className="text-ink-3">{showMargin ? 'Margin' : 'Overdue'}</dt>
                <dd className={cn('tnum font-medium', showMargin ? (p.projected_margin !== null && p.projected_margin < 0.25 ? 'text-danger-text' : 'text-ink') : p.overdue_tasks ? 'text-danger-text' : 'text-ink')}>
                  {showMargin ? fmtPct(p.projected_margin, 0) : p.overdue_tasks}
                </dd>
              </div>
            </dl>
            {p.next_milestone && (
              <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line pt-2 text-[11.5px]">
                <span className="truncate text-ink-2">Next: {p.next_milestone.label}</span>
                <span className={cn('tnum shrink-0 font-semibold', p.next_milestone.days < 0 ? 'text-danger-text' : p.next_milestone.days <= 7 ? 'text-warning-text' : 'text-ink-3')}>{p.next_milestone.days < 0 ? `${-p.next_milestone.days}d late` : p.next_milestone.days === 0 ? 'today' : `in ${p.next_milestone.days}d`}</span>
              </div>
            )}
          </Link>
        )
      })}
    </div>
  )
}

/** Task line used across dashboards: opens the task drawer. */
export function TaskLine({ t, meta, dense }: { t: TaskRow; meta?: ReactNode; dense?: boolean }) {
  const openTask = useUI((s) => s.openTask)
  const late = t.days < 0
  return (
    <button onClick={() => openTask(t.id)} className={cn('flex w-full items-center gap-3 px-4 text-left transition hover:bg-surface-2 md:px-5', dense ? 'py-2' : 'py-2.5')}>
      <span className="tnum w-9 shrink-0 text-[11.5px] font-semibold text-ink-3">{t.code}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-ink">{t.title}</span>
        <span className="block truncate text-[12px] text-ink-3">
          {t.project}
          {t.owner ? ` · ${t.owner}` : ''}
          {t.reason ? ` · ${t.reason}` : ''}
        </span>
      </span>
      {meta ?? (
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <Badge size="sm" tone={TASK_STATUS[t.status].tone}>
            {TASK_STATUS[t.status].label}
          </Badge>
          <span className={cn('tnum text-[11.5px]', late ? 'font-semibold text-danger-text' : 'text-ink-3')}>{late ? `${-t.days}d late` : t.days === 0 ? 'Due today' : fmtDate(t.due_on)}</span>
        </span>
      )}
    </button>
  )
}

export function ListEmpty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-center text-[13px] text-ink-3 md:px-5">{children}</p>
}

/** Compact KPI tile (2 per row on phones, 4 on desktop). Labels wrap rather than truncate. */
export function Kpi({ label, value, sub, tone, to, hint, onClick }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; to?: string; hint?: ReactNode; icon?: ReactNode; onClick?: () => void }) {
  const tc = tone ? { neutral: 'text-ink', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }[tone] : 'text-ink'
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 text-[12.5px] leading-snug text-ink-3">{label}</span>
        {hint && (
          <Tooltip content={hint}>
            <span className="grid size-4 shrink-0 place-items-center rounded-full border border-line-strong text-[10px] font-medium text-ink-3">?</span>
          </Tooltip>
        )}
      </div>
      <div className={cn('tnum mt-2 truncate whitespace-nowrap text-[20px] font-semibold leading-none tracking-[-0.01em] md:text-[22px]', tc)}>{value}</div>
      {sub && <div className="mt-1.5 text-[12px] leading-snug text-ink-3 md:truncate">{sub}</div>}
    </>
  )
  const cls = 'block min-w-0 rounded-lg border border-line bg-surface p-3.5 text-left transition md:p-4'
  if (to)
    return (
      <Link to={to} className={cn(cls, 'hover:border-line-strong')}>
        {body}
      </Link>
    )
  if (onClick)
    return (
      <button onClick={onClick} className={cn(cls, 'hover:border-line-strong')}>
        {body}
      </button>
    )
  return <div className={cls}>{body}</div>
}

/** Horizontal meter bars (revenue ahead, pipeline by stage…). */
export function Bars({ items, format, max: maxIn }: { items: { label: ReactNode; value: number; sub?: ReactNode; tone?: 'brand' | 'accent' | 'muted'; to?: string }[]; format: (v: number) => string; max?: number }) {
  const max = maxIn ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <ul className="space-y-3">
      {items.map((it, i) => {
        const bar = (
          <>
            <div className="flex items-baseline justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate text-ink-2">{it.label}</span>
              <span className="tnum shrink-0 whitespace-nowrap font-medium text-ink">{format(it.value)}</span>
            </div>
            <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-sm bg-surface-2">
              <div className={cn('h-full rounded-sm', it.tone === 'accent' ? 'bg-accent' : it.tone === 'muted' ? 'bg-ink-3/50' : 'bg-brand')} style={{ width: `${Math.max(it.value > 0 ? 2 : 0, (it.value / max) * 100)}%` }} />
            </div>
            {it.sub && <div className="mt-0.5 text-[11.5px] text-ink-3">{it.sub}</div>}
          </>
        )
        return <li key={i}>{it.to ? <Link to={it.to} className="block rounded-md hover:opacity-90">{bar}</Link> : bar}</li>
      })}
    </ul>
  )
}

/** "Ask AI" prompt bar with role-aware suggestion chips. */
export function AskBar({ suggestions, placeholder = 'Ask anything about your business…' }: { suggestions: string[]; placeholder?: string }) {
  const openAI = useUI((s) => s.openAI)
  const [q, setQ] = useState('')
  const go = (text: string) => {
    if (!text.trim()) return openAI()
    openAI(text.trim())
    setQ('')
  }
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface p-3 md:p-4">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          go(q)
        }}
        className="flex items-center gap-2 rounded-md border border-line-strong/70 bg-surface px-3 focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15"
      >
        <Sparkles className="size-4 shrink-0 text-ink-3" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label="Ask Seereon AI" className="h-10 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3 md:text-[14px]" />
        <button type="submit" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-brand px-3 text-[13px] font-medium text-brand-ink hover:brightness-105">
          Ask <ArrowRight className="size-3.5" />
        </button>
      </form>
      {suggestions.length > 0 && (
        <div className="-mx-3 mt-2.5 flex gap-1.5 overflow-x-auto px-3 no-scrollbar md:mx-0 md:flex-wrap md:px-0">
          {suggestions.map((s) => (
            <button key={s} onClick={() => go(s)} className="h-8 shrink-0 whitespace-nowrap rounded-md border border-line bg-surface px-3 text-[12.5px] text-ink-2 transition hover:border-line-strong hover:bg-surface-2 hover:text-ink">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function PersonChip({ name, hue, size = 22 }: { name: string; hue: number; size?: number }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={name} hue={hue} size={size} />
      <span className="truncate text-[13px] font-medium text-ink">{name}</span>
    </span>
  )
}

/** Coloured score chip by threshold (90 green, 75 amber). */
export function scoreTone(v: number | null | undefined, green = 90, amber = 75): Tone {
  if (v === null || v === undefined) return 'neutral'
  return v >= green ? 'success' : v >= amber ? 'warning' : 'danger'
}

/** Dense KPI block from the Feature Guide: a big number with its plain label underneath (2 per row on phones, 4 on desktop). */
export function MetricGrid({ items, cols = 4, className }: { items: { label: ReactNode; value: ReactNode; tone?: Tone; sub?: ReactNode; to?: string; hint?: ReactNode }[]; cols?: 3 | 4; className?: string }) {
  const tc = (t?: Tone) => (t ? { neutral: 'text-ink', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }[t] : 'text-ink')
  return (
    <dl className={cn('grid grid-cols-2 gap-x-4 gap-y-4', cols === 4 ? 'lg:grid-cols-4' : 'md:grid-cols-3', className)}>
      {items.map((it, i) => {
        const body = (
          <>
            <dd className={cn('tnum truncate whitespace-nowrap text-[22px] font-semibold leading-none tracking-[-0.01em] md:text-[24px]', tc(it.tone))}>{it.value}</dd>
            <dt className="mt-1.5 text-[12.5px] leading-snug text-ink-3">
              {it.label}
              {it.hint && (
                <Tooltip content={it.hint}>
                  <span className="ml-1 inline-grid size-3.5 translate-y-[1px] place-items-center rounded-full border border-line-strong text-[9px] font-medium text-ink-3">?</span>
                </Tooltip>
              )}
            </dt>
            {it.sub && <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3">{it.sub}</div>}
          </>
        )
        return (
          <div key={i} className="min-w-0">
            {it.to ? (
              <Link to={it.to} className="flex min-w-0 flex-col rounded-md hover:opacity-80">
                {body}
              </Link>
            ) : (
              <div className="flex min-w-0 flex-col">{body}</div>
            )}
          </div>
        )
      })}
    </dl>
  )
}

/** Signed change with a ▲/▼ arrow, e.g. "▲ 61% vs last month". */
export function ChangeText({ value, label, invert }: { value: number | null | undefined; label?: string; invert?: boolean }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className="text-[12px] text-ink-3">—{label ? <span className="block text-[11.5px]">{label}</span> : null}</span>
  const up = value >= 0
  const good = invert ? !up : up
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className={cn('tnum whitespace-nowrap text-[12.5px] font-semibold', value === 0 ? 'text-ink-3' : good ? 'text-success-text' : 'text-danger-text')}>
        {value === 0 ? '' : up ? '▲ ' : '▼ '}
        {fmtPct(Math.abs(value), 0)}
      </span>
      {label && <span className="whitespace-nowrap text-[11.5px] text-ink-3">{label}</span>}
    </span>
  )
}
