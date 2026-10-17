// Recurring duties (Feature Guide §14, screenshot 026): the four KPIs and the due & overdue list with
// Mark done (rolls the duty to its next date; the server records on-time vs late for the 90-day rate).
// Used by the Operations page, the Operations dashboard and the CEO dashboard's Operations tab.
import { Link } from 'react-router-dom'
import { useOpsSummary, type OpsOccurrence, type OpsSummary } from '@/api/dashboards'
import { opsApi } from '@/api/finance'
import { useMut } from '@/api/query'
import { Badge, Button, ErrorState, SkeletonRows, Tooltip, useCan, useReadOnly } from '@/ui'
import { fmtDate } from '@/domain/calendar'
import { fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { ListEmpty, MetricGrid, Panel, SeeAll } from '../kit'

export const OPS_CATEGORY: Record<string, string> = { payroll: 'Payroll', compliance: 'Compliance', finance: 'Finance', admin: 'Admin', hr: 'HR', it: 'IT' }
export const OPS_RECUR: Record<string, string> = { none: 'one-off', weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' }
const INVALIDATE = [['ops'], ['notifications'], ['dash'], ['insights'], ['scorecard']]

export function DutiesKpis({ s }: { s: OpsSummary }) {
  const k = s.kpis
  return (
    <MetricGrid
      items={[
        { label: 'Duties done on time, last 90 days', value: fmtPct(k.on_time_90, 0), tone: k.on_time_90 === null ? undefined : k.on_time_90 >= 0.9 ? 'success' : k.on_time_90 >= 0.75 ? 'warning' : 'danger', hint: `${k.on_time_90_count} of ${k.done_90} completions on or before the due date; overdue duties count as missed.` },
        { label: 'Overdue now', value: k.overdue_now, tone: k.overdue_now ? 'danger' : 'success' },
        { label: 'Due in the next 10 days', value: k.due_10 },
        { label: 'Recurring responsibilities tracked', value: k.tracked },
      ]}
    />
  )
}

function OccurrenceRow({ o, canEdit, busy, onDone }: { o: OpsOccurrence; canEdit: boolean; busy: boolean; onDone: () => void }) {
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3 sm:flex-row sm:items-center md:px-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words text-[14px] font-medium text-ink">{o.item}</span>
          <Badge size="sm" tone={o.status === 'overdue' ? 'danger' : 'neutral'}>{o.status === 'overdue' ? 'Overdue' : 'Upcoming'}</Badge>
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">
          {OPS_CATEGORY[o.category]}, {OPS_RECUR[o.recurring]}, owner {o.owner_name}. <span className={cn('tnum', o.status === 'overdue' && 'font-medium text-danger-text')}>Due {fmtDate(o.due_on)}</span> for <span className="tnum">{o.period}</span>.
        </p>
      </div>
      {canEdit &&
        (o.current ? (
          <Button size="sm" variant="primary" loading={busy} onClick={onDone} className="w-full shrink-0 sm:w-auto">
            Mark done
          </Button>
        ) : (
          <Tooltip content="Mark the earlier occurrence done first; it then rolls forward to this date.">
            <span className="w-full shrink-0 sm:w-auto">
              <Button size="sm" variant="secondary" disabled className="w-full sm:w-auto">
                Mark done
              </Button>
            </span>
          </Tooltip>
        ))}
    </li>
  )
}

/** KPIs + due & overdue list. `limit` trims the list (dashboards); the Operations page shows all. */
export function DutiesPanel({ limit, showLink, className }: { limit?: number; showLink?: boolean; className?: string }) {
  const q = useOpsSummary()
  const can = useCan()
  const readOnly = useReadOnly()
  const canEdit = can('ops.manage') && !readOnly
  const done = useMut((o: OpsOccurrence) => opsApi.done(o.id), {
    invalidate: INVALIDATE,
    success: (r) => (r.late ? `Marked done late${r.next_due ? ` · next due ${fmtDate(r.next_due)}` : ''}` : r.next_due ? `Marked done · next due ${fmtDate(r.next_due)}` : 'Marked done'),
  })
  const s = q.data
  const list = s ? (limit ? s.occurrences.slice(0, limit) : s.occurrences) : []
  return (
    <div className={cn('min-w-0 space-y-4', className)}>
      <Panel title="Recurring duties" subtitle="Jobs that repeat every week, month or quarter, such as payroll, PF and ESI, GST, TDS and invoicing. Each has an owner and a due day. When it’s done, the owner clicks Mark done; anything late or missing shows up here." action={showLink ? <SeeAll to="/operations">Operations</SeeAll> : undefined}>
        {q.isLoading ? <SkeletonRows rows={2} /> : q.error || !s ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <DutiesKpis s={s} />}
      </Panel>
      <Panel title="Due and overdue" subtitle={s ? `${s.kpis.overdue_now} overdue · ${s.kpis.due_10} due in the next 10 days` : undefined} action={limit && s && s.occurrences.length > limit ? <SeeAll to="/operations">All {s.occurrences.length}</SeeAll> : undefined} flush>
        {q.isLoading ? (
          <div className="px-4 pb-4 md:px-5"><SkeletonRows rows={4} /></div>
        ) : !s ? null : list.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {list.map((o) => (
              <OccurrenceRow key={o.key} o={o} canEdit={canEdit} busy={done.isPending && done.variables?.id === o.id} onDone={() => done.mutate(o)} />
            ))}
          </ul>
        ) : (
          <ListEmpty>
            Nothing overdue or due in the next 10 days. {canEdit && <Link to="/operations" className="font-medium text-brand-text hover:underline">Add a responsibility</Link>}
          </ListEmpty>
        )}
      </Panel>
    </div>
  )
}
