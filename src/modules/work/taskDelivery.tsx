// Task delivery figures (on-time %, early / on-time / late split, slip, first-pass approvals) shared by
// Team tasks → Performance and the CEO / PM / employee home dashboards. All numbers come from GET /analytics/tasks.
import { Link } from 'react-router-dom'
import { useApi } from '@/api/query'
import { taskflowApi, type TaskAnalytics } from '@/api/tasks'
import { usePeopleMap } from '@/api/core'
import { fmtNum, fmtPct } from '@/domain/money'
import { addDays, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Avatar, Card, CardHeader, ErrorState, Skeleton } from '@/ui'
import { ChevronRight } from '@/ui/icons'
import type { TaskStats } from '@/mock/performance'

export const fmtSlip = (v: number | null | undefined) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const r = Math.round(v * 10) / 10
  return r === 0 ? '0d' : `${r > 0 ? '+' : '−'}${fmtNum(Math.abs(r), 1)}d`
}
export const slipTone = (v: number | null | undefined) => (v === null || v === undefined ? undefined : v > 1 ? 'text-danger-text' : v > 0 ? 'text-warning-text' : 'text-success-text')
export const pctTone = (v: number | null | undefined, good = 0.85, ok = 0.7) => (v === null || v === undefined ? '' : v >= good ? 'text-success-text' : v >= ok ? 'text-warning-text' : 'text-danger-text')

/** Early / on time / late as one proportional bar with a legend. */
export function TimelinessSplit({ s, className, legend = true }: { s: Pick<TaskStats, 'early' | 'on_time' | 'late' | 'completed'>; className?: string; legend?: boolean }) {
  const n = s.early + s.on_time + s.late
  const parts = [
    { k: 'Early', v: s.early, c: 'bg-success' },
    { k: 'On time', v: s.on_time, c: 'bg-info' },
    { k: 'Late', v: s.late, c: 'bg-danger' },
  ]
  return (
    <div className={className}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={parts.map((p) => `${p.k} ${p.v}`).join(', ')}>
        {n > 0 && parts.map((p) => (p.v ? <span key={p.k} className={cn('h-full', p.c)} style={{ width: `${(p.v / n) * 100}%` }} /> : null))}
      </div>
      {legend && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
          {parts.map((p) => (
            <span key={p.k} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className={cn('size-2 rounded-full', p.c)} aria-hidden />
              {p.k} <span className="tnum font-medium text-ink">{p.v}</span>
              <span className="tnum">{n ? `(${Math.round((p.v / n) * 100)}%)` : ''}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Fig({ label, value, sub, cls }: { label: string; value: string | number; sub?: string; cls?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] leading-tight text-ink-3">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap text-[19px] font-semibold leading-none', cls ?? 'text-ink')}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  )
}

/** Last 90 days, server-scoped. */
export function useTaskDelivery(scope: 'me' | 'team' | 'company') {
  const to = todayISO()
  const from = addDays(to, -90)
  return useApi(['task-analytics', scope, from], () => taskflowApi.analytics({ from, to, scope, group: 'person' }), { staleTime: 15_000 })
}

/** "Task delivery" panel for the home dashboards. */
export function TaskDeliveryPanel({ variant, className }: { variant: 'ceo' | 'pm' | 'employee' | 'hr'; className?: string }) {
  const scope = variant === 'ceo' || variant === 'hr' ? 'company' : variant === 'pm' ? 'team' : 'me'
  const q = useTaskDelivery(scope)
  const people = usePeopleMap()
  const d = q.data
  const title = variant === 'employee' ? 'My delivery' : 'Task delivery'
  const subtitle = variant === 'ceo' || variant === 'hr' ? 'Company · last 90 days · completion vs due date' : variant === 'pm' ? 'My team · last 90 days' : 'Last 90 days · approved tasks vs due date'
  const link = variant === 'employee' ? '/my-tasks' : '/team-tasks?tab=performance'
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={
          <Link to={link} className="inline-flex items-center gap-0.5 whitespace-nowrap text-[12.5px] font-medium text-brand-text hover:underline">
            {variant === 'employee' ? 'My tasks' : 'Performance'}
            <ChevronRight className="size-3.5" />
          </Link>
        }
      />
      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-3" />
          <Skeleton className="h-20" />
        </div>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Body d={d} variant={variant} nameOf={(id) => people.get(id)} />
      )}
    </Card>
  )
}

function Body({ d, variant, nameOf }: { d: TaskAnalytics; variant: 'ceo' | 'pm' | 'employee' | 'hr'; nameOf: (id: string) => { name: string; avatar_hue: number } | undefined }) {
  const s = d.total
  const figs =
    variant === 'employee'
      ? [
          { label: 'On time', value: fmtPct(s.on_time_pct, 0), sub: `${s.early + s.on_time} of ${s.completed} approved`, cls: pctTone(s.on_time_pct) },
          { label: 'Sent back to me', value: d.mine.my_sent_back_open, sub: 'Needs changes now', cls: d.mine.my_sent_back_open ? 'text-danger-text' : undefined },
          { label: 'Waiting for review', value: d.mine.my_in_review, sub: 'Submitted by me' },
          { label: 'Ready to submit', value: d.mine.my_to_submit, sub: d.mine.my_overdue_open ? `${d.mine.my_overdue_open} past due` : 'In progress', cls: d.mine.my_overdue_open ? 'text-warning-text' : undefined },
        ]
      : [
          { label: 'On time', value: fmtPct(s.on_time_pct, 0), sub: `${s.completed} completed`, cls: pctTone(s.on_time_pct) },
          { label: 'Avg slip', value: fmtSlip(s.avg_variance_days), sub: 'Working days vs due', cls: slipTone(s.avg_variance_days) },
          { label: 'First-pass approval', value: fmtPct(s.first_pass_pct, 0), sub: `${s.sent_back} sent back` },
          variant === 'pm'
            ? { label: 'Waiting for my review', value: d.mine.review_queue, sub: `${s.overdue_open} open past due`, cls: d.mine.review_queue ? 'text-accent-text' : undefined }
            : { label: 'Open past due', value: s.overdue_open, sub: `${s.in_review} in review`, cls: s.overdue_open ? 'text-danger-text' : undefined },
        ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
        {figs.map((f) => (
          <Fig key={f.label} {...f} />
        ))}
      </div>
      <TimelinessSplit s={s} />
      {variant !== 'employee' && (
        <div className="grid gap-4 border-t border-line pt-3 md:grid-cols-2">
          <div className="min-w-0">
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Most late completions</div>
            {d.top_late.length ? (
              <ul className="space-y-1">
                {d.top_late.map((r) => {
                  const p = nameOf(r.user_id)
                  return (
                    <li key={r.user_id}>
                      <Link to={`/performance/${r.user_id}`} className="-mx-1.5 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-2">
                        <Avatar name={p?.name ?? '?'} hue={p?.avatar_hue ?? 150} size={22} />
                        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{p?.name ?? '—'}</span>
                        <span className="tnum shrink-0 whitespace-nowrap text-[12.5px] text-ink-3">
                          <span className="font-medium text-danger-text">{r.late}</span> of {r.completed} · {fmtSlip(r.avg_variance_days)}
                        </span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">No late completions in this period.</p>
            )}
          </div>
          <div className="min-w-0">
            <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Top delay reasons</div>
            {d.delay_reasons.length ? (
              <ul className="space-y-1.5">
                {d.delay_reasons.slice(0, 5).map((r) => {
                  const max = d.delay_reasons[0].count || 1
                  return (
                    <li key={r.code} className="min-w-0">
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="min-w-0 truncate text-ink">{r.label}</span>
                        <span className="tnum shrink-0 text-ink-3">{r.count}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${(r.count / max) * 100}%` }} />
                      </div>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p className="text-[13px] text-ink-3">No delays reported.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
