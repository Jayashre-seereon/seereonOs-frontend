// HR panels for the HR & operations home: leave to approve, onboarding/exit items due, appraisal progress,
// hiring pipeline and assets due back from leavers.
import { Link } from 'react-router-dom'
import { useHrDashboard } from '@/api/hr'
import { fmtDate } from '@/domain/calendar'
import { LEAVE_TYPE } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Avatar, Badge, ErrorState, Progress, Skeleton, useCan } from '@/ui'
import { ListEmpty, MetricGrid, Panel, SeeAll } from '@/modules/insights/kit'
import { APPRAISAL_STATUS, CANDIDATE_STAGE } from './components'
import type { AppraisalStatus } from '@/types/business'

/** v7 — "Needs attention" for HR: who needs HR's action today, each count linking to the screen that clears it. */
export function HrNeedsAttention() {
  const can = useCan()
  // HR Executives (people.view_all) act on leave/docs/workflow steps too, so they get the card as well.
  const allowed = can('people.manage') || can('people.view_all')
  const q = useHrDashboard(allowed)
  if (!allowed || q.isLoading || q.error || !q.data?.attention) return null
  const items = q.data.attention
  const total = items.reduce((s, a) => s + a.count, 0)
  return (
    <Panel title="Needs attention" subtitle={total ? `${total} item${total === 1 ? '' : 's'} need HR action today` : 'Nothing needs HR action right now'}>
      <MetricGrid cols={3} items={items.map((a) => ({ label: a.label, value: a.count, tone: a.count ? ('warning' as const) : ('success' as const), to: a.to, hint: a.hint }))} />
    </Panel>
  )
}

export function HrPanels() {
  const can = useCan()
  const allowed = can('people.manage')
  const q = useHrDashboard(allowed)
  if (!allowed) return null
  if (q.isLoading) return <Skeleton className="h-[240px] rounded-lg" />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const maxStage = Math.max(1, ...d.candidates_by_stage.map((s) => s.count))
  return (
    <div className="space-y-4 md:space-y-5">
      <h2 className="pt-1 text-[13.5px] font-semibold text-ink-2">People & HR</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Panel title="Leave to approve" subtitle={`${d.pending_leave} pending across the company`} action={<SeeAll to="/leave" />} flush>
          {d.pending_leave_items.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.pending_leave_items.map((l) => (
                <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <Avatar name={l.name} hue={l.hue} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{l.name}</span>
                    <span className="block truncate text-[12px] text-ink-3">{LEAVE_TYPE[l.type]} · {fmtDate(l.from_on)}{l.to_on !== l.from_on ? ` – ${fmtDate(l.to_on)}` : ''} · {l.approver ?? '—'}</span>
                  </span>
                  <span className="tnum shrink-0 text-[12.5px] font-medium text-ink-2">{l.days}d</span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No leave waiting for approval.</ListEmpty>
          )}
        </Panel>

        <Panel title="Onboarding & exits" subtitle="Items overdue or due in 7 days" action={<SeeAll to="/lifecycle" />} flush>
          {d.lifecycle_due.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.lifecycle_due.map((i, k) => (
                <li key={k} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{i.label}</span>
                    <span className="block truncate text-[12px] text-ink-3">{i.person} · {i.kind === 'onboarding' ? 'joining' : 'exit'}</span>
                  </span>
                  <span className={cn('tnum shrink-0 text-[12.5px] font-semibold', i.days < 0 ? 'text-danger-text' : i.days <= 2 ? 'text-warning-text' : 'text-ink-3')}>
                    {i.days < 0 ? `${-i.days}d overdue` : i.days === 0 ? 'Today' : fmtDate(i.due_on)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>Nothing due this week.</ListEmpty>
          )}
        </Panel>

        <Panel title="Appraisal cycle" subtitle={d.cycle ? d.cycle.name : 'No cycle running'} action={<SeeAll to="/appraisals" />}>
          {d.cycle ? (
            <div>
              <div className="flex items-center gap-3">
                <Progress value={d.cycle.total ? d.cycle.completed / d.cycle.total : 0} className="flex-1" tone={d.cycle.completed === d.cycle.total ? 'success' : 'brand'} />
                <span className="tnum shrink-0 text-[12.5px] font-medium">{d.cycle.completed}/{d.cycle.total}</span>
              </div>
              <ul className="mt-3 space-y-2">
                {(['self_pending', 'manager_pending', 'hr_pending', 'completed'] as AppraisalStatus[]).map((s) => (
                  <li key={s} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="text-ink-2">{APPRAISAL_STATUS[s].label}</span>
                    <Badge size="sm" tone={d.cycle!.counts[s] && s !== 'completed' ? APPRAISAL_STATUS[s].tone : 'neutral'}>{d.cycle!.counts[s]}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <ListEmpty>Launch a cycle from Appraisals.</ListEmpty>
          )}
        </Panel>

        <Panel title="Hiring pipeline" subtitle={`${d.open_positions} open position${d.open_positions === 1 ? '' : 's'}`} action={<SeeAll to="/recruitment" />}>
          <ul className="space-y-2.5">
            {d.candidates_by_stage.map((s) => (
              <li key={s.stage} className="grid grid-cols-[84px_minmax(0,1fr)_28px] items-center gap-2 text-[13px]">
                <span className="truncate text-ink-2">{CANDIDATE_STAGE[s.stage].label}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-brand" style={{ width: `${(s.count / maxStage) * 100}%` }} /></span>
                <span className="tnum text-right font-medium">{s.count}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel title="Assets due back" subtitle="Held by people who left or are leaving" action={<SeeAll to="/assets" />} flush className="md:col-span-2 xl:col-span-2">
          {d.assets_due_back.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.assets_due_back.map((a) => (
                <li key={a.id}>
                  <Link to="/assets" className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium"><span className="tnum">{a.tag}</span> · {a.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{a.person}{a.last_day ? ` · last day ${fmtDate(a.last_day)}` : ''}</span>
                    </span>
                    <Badge size="sm" tone="danger">Collect</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>Every asset is accounted for.</ListEmpty>
          )}
        </Panel>
      </div>
    </div>
  )
}
