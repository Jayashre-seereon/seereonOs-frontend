import type { ReactNode } from 'react'
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronLeft, Inbox, RefreshCw } from '@/ui/icons'
import { Link } from 'react-router-dom'
import { cn, initials } from '@/lib/utils'
import type { Tone } from '@/domain/labels'
import { fmtMoney, fmtMoneyCompact, fmtPct } from '@/domain/money'
import { Button } from './Button'
import { Tooltip } from './overlay'

/* ---------------- Card ---------------- */
export function Card({ children, className, pad = true, as: As = 'section' }: { children: ReactNode; className?: string; pad?: boolean; as?: 'section' | 'div' | 'article' }) {
  return <As className={cn('rounded-lg border border-line bg-surface', pad && 'p-4 md:p-5', className)}>{children}</As>
}
export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div className={cn('mb-3.5 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold leading-snug text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
    </div>
  )
}

/* ---------------- Page header ---------------- */
export function PageHeader({ title, subtitle, actions, back, eyebrow, meta }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: { to: string; label: string }; eyebrow?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {back && (
          <Link to={back.to} className="-ml-0.5 mb-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink">
            <ChevronLeft className="size-3.5" />
            {back.label}
          </Link>
        )}
        {eyebrow && <div className="mb-1 text-[12.5px] font-medium text-ink-3">{eyebrow}</div>}
        <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink md:text-[22px]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-[80ch] text-[13.5px] leading-relaxed text-ink-3">{subtitle}</p>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:justify-end">{actions}</div>}
    </header>
  )
}

/* ---------------- Badges ---------------- */
const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-ink-2',
  info: 'bg-info-soft text-info-text',
  success: 'bg-success-soft text-success-text',
  warning: 'bg-warning-soft text-warning-text',
  danger: 'bg-danger-soft text-danger-text',
  brand: 'bg-brand-soft text-brand-text',
  accent: 'bg-accent-soft text-accent-text',
}
export const TONE_TEXT: Record<Tone, string> = { neutral: 'text-ink', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }
const DOT: Record<Tone, string> = { neutral: 'bg-ink-3', info: 'bg-info', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', brand: 'bg-brand', accent: 'bg-accent' }

export function Badge({ tone = 'neutral', children, dot, className, size = 'md' }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string; size?: 'sm' | 'md' }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm font-medium', size === 'sm' ? 'h-5 px-1.5 text-[11px]' : 'h-[22px] px-2 text-[12px]', TONE[tone], className)}>
      {dot && <span className={cn('size-1.5 rounded-full', DOT[tone])} />}
      {children}
    </span>
  )
}
/** CMP-05 — pass one of the maps from domain/labels */
export function StatusBadge<K extends string>({ map, value, size }: { map: Record<K, { label: string; tone: Tone }>; value: K; size?: 'sm' | 'md' }) {
  const m = map[value] ?? { label: String(value), tone: 'neutral' as Tone }
  return (
    <Badge tone={m.tone} size={size}>
      {m.label}
    </Badge>
  )
}
export function Dot({ tone = 'neutral', className }: { tone?: Tone; className?: string }) {
  return <span className={cn('inline-block size-2 rounded-full', DOT[tone], className)} />
}

/* ---------------- Avatar ---------------- */
export function Avatar({ name, hue = 150, size = 32, className, src }: { name: string; hue?: number; size?: number; className?: string; src?: string | null }) {
  const s = { width: size, height: size, fontSize: Math.max(10, size * 0.38) }
  if (src) return <img src={src} alt="" style={s} className={cn('shrink-0 rounded-full object-cover', className)} />
  return (
    <span
      aria-hidden
      style={{ ...s, background: `hsl(${hue} 32% 90%)`, color: `hsl(${hue} 40% 30%)` }}
      className={cn('inline-grid shrink-0 select-none place-items-center rounded-full font-semibold', className)}
    >
      {initials(name)}
    </span>
  )
}
export function AvatarStack({ people, max = 4, size = 26 }: { people: { name: string; hue: number }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max)
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <Tooltip key={i} content={p.name}>
          <span className={cn('rounded-full ring-2 ring-surface', i > 0 && '-ml-2')}>
            <Avatar name={p.name} hue={p.hue} size={size} />
          </span>
        </Tooltip>
      ))}
      {people.length > max && <span className="-ml-2 grid place-items-center rounded-full bg-surface-2 text-[11px] font-semibold text-ink-2 ring-2 ring-surface" style={{ width: size, height: size }}>+{people.length - max}</span>}
    </span>
  )
}

/* ---------------- Money & numbers ---------------- */
export function Money({ value, compact, className, sign, muted }: { value: number | null | undefined; compact?: boolean; className?: string; sign?: boolean; muted?: boolean }) {
  const text = compact ? fmtMoneyCompact(value) : fmtMoney(value, { sign })
  return (
    <span className={cn('tnum whitespace-nowrap', muted && 'text-ink-3', className)} title={compact ? fmtMoney(value) : undefined}>
      {text}
    </span>
  )
}
export function Delta({ value, invert, className }: { value: number | null | undefined; invert?: boolean; className?: string }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cn('text-[12px] text-ink-3', className)}>—</span>
  const up = value >= 0
  const good = invert ? !up : up
  return (
    <span className={cn('tnum inline-flex items-center gap-0.5 text-[12px] font-semibold', good ? 'text-success-text' : 'text-danger-text', className)}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
      {fmtPct(Math.abs(value))}
    </span>
  )
}

/* ---------------- Stat card ---------------- */
export function StatCard({
  label, value, sub, delta, invertDelta, tone, spark, className, onClick, hint,
}: {
  label: ReactNode
  value: ReactNode
  sub?: ReactNode
  delta?: number | null
  invertDelta?: boolean
  tone?: Tone
  icon?: ReactNode
  spark?: number[]
  className?: string
  onClick?: () => void
  hint?: ReactNode
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-lg border border-line bg-surface px-4 py-3.5 text-left transition',
        onClick && 'hover:border-line-strong hover:bg-surface-2/40',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 text-[12.5px] font-medium leading-tight text-ink-3">{label}</span>
        {hint && (
          <Tooltip content={hint}>
            <span className="grid size-4 place-items-center rounded-full border border-line-strong text-[10px] font-semibold text-ink-3">?</span>
          </Tooltip>
        )}
      </div>
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className={cn('tnum truncate whitespace-nowrap text-[20px] font-semibold leading-none tracking-[-0.01em] sm:text-[22px]', tone ? TONE_TEXT[tone] : 'text-ink')}>{value}</div>
        {spark && spark.length > 1 && <Spark data={spark} />}
      </div>
      {(sub || delta !== undefined) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px] text-ink-3">
          {delta !== undefined && <Delta value={delta} invert={invertDelta} />}
          {sub}
        </div>
      )}
    </Comp>
  )
}

export function Spark({ data, w = 72, h = 26, className }: { data: number[]; w?: number; h?: number; className?: string }) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const pts = data.map((v, i) => [(i / (data.length - 1)) * (w - 4) + 2, h - 3 - ((v - min) / span) * (h - 6)])
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className={cn('shrink-0 overflow-visible', className)} aria-hidden>
      <path d={`${d} L${last[0]},${h} L${pts[0][0]},${h} Z`} fill="var(--brand)" opacity=".1" />
      <path d={d} fill="none" stroke="var(--brand)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="var(--brand)" stroke="var(--surface)" strokeWidth="1.5" />
    </svg>
  )
}

/* ---------------- Progress / meter ---------------- */
export function Progress({ value, tone = 'brand', className, height = 6, max = 1 }: { value: number; tone?: Tone; className?: string; height?: number; max?: number }) {
  const pct = Math.max(0, Math.min(1, value / max))
  const bg = { brand: 'bg-brand', success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger', info: 'bg-info', neutral: 'bg-ink-3', accent: 'bg-accent' }[tone]
  return (
    <div className={cn('w-full overflow-hidden rounded-full bg-surface-2', className)} style={{ height }} role="progressbar" aria-valuenow={Math.round(pct * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-500', bg)} style={{ width: `${pct * 100}%` }} />
    </div>
  )
}

/* ---------------- States (CMP-08) ---------------- */
export function EmptyState({ icon, title, body, action, className, compact }: { icon?: ReactNode; title: ReactNode; body?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-surface-2 text-ink-3 [&>svg]:size-5">{icon ?? <Inbox />}</div>
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {body && <p className="mt-1 max-w-[42ch] text-[13.5px] text-ink-3">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const msg = (error as { message?: string })?.message ?? 'Something went wrong.'
  const code = (error as { code?: string })?.code
  return (
    <div className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-danger-soft text-danger-text">
        <AlertTriangle className="size-6" />
      </div>
      <h3 className="text-[15px] font-semibold">{code === 'FORBIDDEN' ? 'You don’t have access to this' : code === 'NOT_FOUND' ? 'Not found' : 'Couldn’t load this'}</h3>
      <p className="mt-1 max-w-[46ch] text-[13.5px] text-ink-3">{msg}</p>
      {onRetry && code !== 'FORBIDDEN' && code !== 'NOT_FOUND' && (
        <Button className="mt-4" size="sm" icon={<RefreshCw className="size-3.5" />} onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('skeleton h-4', className)} style={style} />
}
export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5" style={{ width: `${60 - ((i * 7) % 25)}%` }} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
      ))}
    </div>
  )
}
export function SkeletonCards({ n = 4 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface p-4">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-7 w-28" />
          <Skeleton className="mt-3 h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

/** Wraps a query result into loading / error / empty / content (CMP-08). */
export function QueryState<T>({ q, children, empty, loading, isEmpty }: { q: { data?: T; isLoading: boolean; error: unknown; refetch: () => unknown }; children: (d: T) => ReactNode; empty?: ReactNode; loading?: ReactNode; isEmpty?: (d: T) => boolean }) {
  if (q.isLoading) return <>{loading ?? <SkeletonRows />}</>
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (q.data === undefined) return null
  if (empty && (isEmpty ? isEmpty(q.data) : Array.isArray(q.data) && q.data.length === 0)) return <>{empty}</>
  return <>{children(q.data)}</>
}

/* ---------------- Key-value list ---------------- */
export function KV({ items, cols = 2, className }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; cols?: 1 | 2 | 3 | 4; className?: string }) {
  const c = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-2 lg:grid-cols-3', 4: 'grid-cols-2 lg:grid-cols-4' }[cols]
  return (
    <dl className={cn('grid gap-x-6 gap-y-3.5', c, className)}>
      {items.map((it, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] font-medium text-ink-3">{it.label}</dt>
          <dd className="mt-0.5 break-words text-[14px] font-medium text-ink">{it.value}</dd>
          {it.hint && <dd className="text-[12px] text-ink-3">{it.hint}</dd>}
        </div>
      ))}
    </dl>
  )
}

/* ---------------- Callout / Banner ---------------- */
export function Callout({ tone = 'info', title, children, icon, action, className }: { tone?: Tone; title?: ReactNode; children?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  const t = { neutral: 'bg-surface-2 border-line', info: 'bg-info-soft border-info/20', success: 'bg-success-soft border-success/25', warning: 'bg-warning-soft border-warning/30', danger: 'bg-danger-soft border-danger/25', brand: 'bg-brand-soft border-brand/20', accent: 'bg-accent-soft border-accent/25' }[tone]
  const ic = { neutral: 'text-ink-2', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }[tone]
  return (
    <div className={cn('flex items-start gap-3 rounded-lg border px-3.5 py-3', t, className)}>
      {icon && <span className={cn('mt-0.5 shrink-0 [&>svg]:size-[18px]', ic)}>{icon}</span>}
      <div className="min-w-0 flex-1 text-[13.5px] leading-snug text-ink">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-ink-2')}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/* ---------------- Section title inside pages ---------------- */
export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2.5 mt-7 flex items-center justify-between gap-3 first:mt-0', className)}>
      <h2 className="text-[13.5px] font-semibold text-ink-2">{children}</h2>
      {action}
    </div>
  )
}

/* ---------------- List rows (iOS grouped list) ---------------- */
export function ListGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface', className)}>{children}</div>
}
export function ListRow({ title, subtitle, leading, trailing, onClick, to, className, chevron }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onClick?: () => void; to?: string; className?: string; chevron?: boolean }) {
  const inner = (
    <>
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-[12.5px] text-ink-3">{subtitle}</span>}
      </span>
      {trailing && <span className="shrink-0 text-right">{trailing}</span>}
      {chevron && <svg className="size-4 shrink-0 text-ink-3" viewBox="0 0 16 16" aria-hidden><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </>
  )
  const cls = cn('flex w-full items-center gap-3 px-4 py-3 text-left', (onClick || to) && 'transition hover:bg-surface-2 active:bg-surface-2', className)
  if (to)
    return (
      <Link to={to} className={cls}>
        {inner}
      </Link>
    )
  if (onClick)
    return (
      <button type="button" onClick={onClick} className={cls}>
        {inner}
      </button>
    )
  return <div className={cls}>{inner}</div>
}
