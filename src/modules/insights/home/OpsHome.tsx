// Operations dashboard (Feature Guide §14): recurring duties with Mark done, ops items due/overdue, openings,
// leave today, payroll status, compliance calendar.
import { Link } from 'react-router-dom'
import { AlertTriangle, Briefcase, CalendarCheck, CalendarClock, ClipboardList, Coins, Palmtree, Users } from '@/ui/icons'
import { useOpsDashboard } from '@/api/dashboards'
import { Avatar, Badge, ErrorState, SkeletonCards, SkeletonRows } from '@/ui'
import { fmtDate } from '@/domain/calendar'
import { LEAVE_TYPE } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Kpi, ListEmpty, Panel, SeeAll } from '../kit'
import { HrNeedsAttention, HrPanels } from '@/modules/hr/HrPanels'
import { TaskDeliveryPanel } from '@/modules/work/taskDelivery'
import { DutiesPanel } from './OpsDuties'

const OPENING: Record<string, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' }> = { open: { label: 'Open', tone: 'info' }, interviewing: { label: 'Interviewing', tone: 'warning' }, offered: { label: 'Offered', tone: 'success' }, on_hold: { label: 'On hold', tone: 'neutral' }, filled: { label: 'Filled', tone: 'success' } }
const PAY: Record<string, { label: string; tone: 'neutral' | 'warning' | 'success' }> = { not_started: { label: 'Not started', tone: 'neutral' }, draft: { label: 'Draft', tone: 'warning' }, final: { label: 'Final', tone: 'success' } }

export default function OpsHome() {
  const q = useOpsDashboard()
  const d = q.data
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <SkeletonCards n={4} />
        <SkeletonRows rows={6} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const c = d.counts
  return (
    <div className="space-y-4 md:space-y-5">
      <HrNeedsAttention />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-3">
        <Kpi label="Overdue items" value={c.overdue} tone={c.overdue ? 'danger' : 'success'} to="/operations" />
        <Kpi label="Due in 7 days" value={c.due_7} tone={c.due_7 ? 'warning' : undefined} to="/operations" />
        <Kpi label="Due in 30 days" value={c.upcoming_30} to="/operations" />
        <Kpi label="Open positions" value={c.positions} sub={`${c.openings} openings`} to="/openings" />
        <Kpi label="On leave today" value={c.on_leave_today} to="/leave" />
        <Kpi label="Timesheets missing" value={d.timesheets.missing_last_week} sub={`last week · ${d.timesheets.pending_approval} pending approval`} tone={d.timesheets.missing_last_week ? 'warning' : 'success'} to="/insights/timesheet_compliance" />
      </div>

      <DutiesPanel limit={8} showLink />

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel className="xl:col-span-7" title="Ops register" subtitle="Overdue and due in the next 30 days" action={<SeeAll to="/operations">Open register</SeeAll>} flush>
          {d.items.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.items.map((i) => (
                <li key={i.id}>
                  <Link to="/operations" className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <span className={cn('size-2 shrink-0 rounded-full', i.group === 'overdue' ? 'bg-danger' : i.group === 'due' ? 'bg-warning' : 'bg-info')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{i.item}</span>
                      <span className="block truncate text-[12px] capitalize text-ink-3">
                        {i.category} · {i.owner ?? '—'}
                        {i.recurring !== 'none' ? ` · ${i.recurring}` : ''}
                      </span>
                    </span>
                    <span className={cn('tnum shrink-0 text-right text-[12.5px] font-semibold', i.days < 0 ? 'text-danger-text' : i.days <= 7 ? 'text-warning-text' : 'text-ink-3')}>
                      {i.days < 0 ? `${-i.days}d overdue` : i.days === 0 ? 'Today' : fmtDate(i.due_on)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>Nothing due in the next 30 days.</ListEmpty>
          )}
        </Panel>
        <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:col-span-5 xl:grid-cols-1">
          <Panel title="Payroll" subtitle="This month and last" action={<SeeAll to="/payroll">Payroll</SeeAll>}>
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { label: d.payroll.label, s: d.payroll.status, id: d.payroll.run_id },
                { label: d.payroll.last_month.label, s: d.payroll.last_month.status, id: d.payroll.last_month.run_id },
              ].map((p) => (
                <Link key={p.label} to={p.id ? `/payroll/${p.id}` : '/payroll'} className="rounded-lg border border-line p-3 hover:bg-surface-2">
                  <div className="text-[12px] text-ink-3">{p.label}</div>
                  <Badge className="mt-1.5" tone={PAY[p.s].tone}>{PAY[p.s].label}</Badge>
                </Link>
              ))}
            </div>
            {d.payroll.status !== 'final' && <p className="mt-2.5 text-[12px] text-ink-3">Payroll for {d.payroll.label} uses approved timesheet days. {d.timesheets.missing_last_week} {d.timesheets.missing_last_week === 1 ? 'person hasn’t' : 'people haven’t'} submitted last week.</p>}
          </Panel>
          <Panel title="On leave today" flush>
            {d.leave_today.length ? (
              <ul className="divide-y divide-line border-t border-line">
                {d.leave_today.map((l) => (
                  <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                    <Avatar name={l.name} hue={l.hue} size={26} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{l.name}</span>
                    <Badge size="sm">{LEAVE_TYPE[l.type]}{l.portion === 'half' ? ' · half day' : ''}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <ListEmpty>Everyone is in today.</ListEmpty>
            )}
          </Panel>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 md:gap-5">
        <Panel title="Compliance calendar" subtitle="Statutory, payroll and finance duties · next 60 days" flush>
          {d.compliance.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.compliance.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
                  <span className="grid w-11 shrink-0 place-items-center rounded-md border border-line py-1 text-center leading-none">
                    <span className="text-[10px] font-semibold uppercase text-ink-3">{new Date(i.due_on + 'T00:00:00').toLocaleDateString('en-IN', { month: 'short' })}</span>
                    <span className="tnum text-[15px] font-semibold">{i.due_on.slice(8)}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{i.item}</span>
                    <span className="block truncate text-[12px] text-ink-3">{i.owner ?? '—'}</span>
                  </span>
                  {i.status === 'done' ? <Badge size="sm" tone="success">Done</Badge> : i.days < 0 ? <Badge size="sm" tone="danger">{-i.days}d overdue</Badge> : <span className="text-[12px] text-ink-3">in {i.days}d</span>}
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No compliance items scheduled.</ListEmpty>
          )}
        </Panel>
        <Panel title="Openings" subtitle="Hiring in progress" action={<SeeAll to="/openings" />} flush>
          {d.openings.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.openings.map((o) => (
                <li key={o.id}>
                  <Link to="/openings" className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">
                        {o.role}
                        {o.count > 1 ? ` × ${o.count}` : ''}
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {o.project ?? 'General'} · {o.owner ?? '—'}
                        {o.needed_by ? ` · needed by ${fmtDate(o.needed_by)}` : ''}
                      </span>
                    </span>
                    <Badge size="sm" tone={OPENING[o.status].tone}>{OPENING[o.status].label}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No open positions.</ListEmpty>
          )}
        </Panel>
      </div>

      <HrPanels />

      <TaskDeliveryPanel variant="hr" />
    </div>
  )
}
