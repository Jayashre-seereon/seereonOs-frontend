// Project manager dashboard (Feature Guide §14, screenshots 024/025): delivery control, the task pipeline by
// stage, critical-path and breach risks, resource load in hours for the next 10 working days, then tasks at
// risk, blocked, approvals waiting on me, change requests, team timesheet compliance and upcoming milestones.
import { lazy, Suspense, type ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { usePmDashboard, type PmDashboard } from '@/api/dashboards'
import { useWeek } from '@/stores/ui'
import { Avatar, Badge, Button, ErrorState, Money, SkeletonCards, SkeletonRows, StatusBadge, Tooltip } from '@/ui'
import { CreateTaskButton } from '@/modules/work/TaskForm'
import { fmtDate, weekLabel } from '@/domain/calendar'
import { CR_STATUS, WEEK_STATUS } from '@/domain/labels'
import { fmtPct } from '@/domain/money'
import { MILESTONE_STATE } from '@/reports/datasets'
import { cn } from '@/lib/utils'
import { Kpi, ListEmpty, MetricGrid, Panel, ProjectHealthStrip, SeeAll, TaskLine } from '../kit'
import { TaskDeliveryPanel } from '@/modules/work/taskDelivery'

/** Breach-risk list from the projects module (workstream B), loaded when it exists. */
const breachModule = import.meta.glob<Record<string, unknown>>('/src/modules/projects/components/BreachRiskList.tsx')
const BreachRiskList = (() => {
  const load = breachModule['/src/modules/projects/components/BreachRiskList.tsx']
  if (!load) return null
  return lazy(async () => {
    const m = await load()
    const C = (m.BreachRiskList ?? m.default) as ComponentType<Record<string, unknown>> | undefined
    return { default: C ?? (() => null) }
  })
})()

const BAR_TONE: Record<string, string> = { neutral: 'bg-ink-3/60', info: 'bg-info', accent: 'bg-accent', warning: 'bg-warning', danger: 'bg-danger', success: 'bg-success', brand: 'bg-brand' }

/** v7 — "Needs attention": the six counts a PM clears daily, each linking to the filtered screen. */
const ATTENTION_TONE: Record<string, 'danger' | 'warning'> = { overdue: 'danger', blocked: 'danger', timesheets: 'warning', milestones: 'warning', reviews: 'warning', crs: 'warning' }
function NeedsAttention({ d }: { d: PmDashboard }) {
  const total = d.attention.reduce((s, a) => s + a.count, 0)
  return (
    <Panel title="Needs attention" subtitle={total ? `${total} item${total === 1 ? '' : 's'} need action across your projects` : 'Nothing needs you right now'}>
      <MetricGrid
        cols={3}
        items={d.attention.map((a) => ({
          label: a.label,
          value: a.count,
          tone: a.count ? (ATTENTION_TONE[a.key] ?? 'warning') : 'success',
          to: a.to,
          hint: a.hint,
        }))}
      />
    </Panel>
  )
}
function DeliveryControl({ d }: { d: PmDashboard }) {
  const c = d.control
  const tn = (v: number, bad: 'danger' | 'warning' = 'danger') => (v ? bad : 'success') as 'danger' | 'warning' | 'success'
  return (
    <Panel title="Delivery control" subtitle="Live projects you manage" action={<SeeAll to="/projects">Projects</SeeAll>}>
      <MetricGrid
        items={[
          { label: 'Active projects', value: c.active_projects, to: '/projects' },
          { label: 'Critical-path tasks at risk', value: c.critical_at_risk, tone: tn(c.critical_at_risk), hint: 'Tasks that set a milestone deadline (no float) that are overdue, waiting or forecast to finish late.' },
          { label: 'Blocked, on hold or waiting', value: c.blocked_waiting, tone: tn(c.blocked_waiting), to: '/insights/blocked' },
          { label: 'Tasks past planned start, not started', value: c.past_start, tone: tn(c.past_start, 'warning') },
          { label: 'Open bugs', value: c.open_bugs, tone: tn(c.open_bugs) },
          { label: 'In unit or functional testing', value: c.in_testing },
          { label: 'In UAT with the client', value: c.in_uat },
          { label: 'Waiting for feedback', value: c.waiting_feedback, tone: tn(c.waiting_feedback, 'warning') },
          { label: 'Tasks with no estimate', value: c.no_estimate, tone: tn(c.no_estimate, 'warning') },
          { label: 'Scheduling conflicts', value: c.conflicts, tone: tn(c.conflicts), hint: 'A task planned to start before a task it depends on ends, or a person booked over 100% in the next 10 working days.' },
        ]}
      />
      {(c.critical_list.length > 0 || c.conflict_list.length > 0) && (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {c.critical_list.length > 0 && (
            <section className="min-w-0">
              <h3 className="mb-1.5 text-[13px] font-semibold">Critical-path tasks at risk</h3>
              <div className="-mx-4 divide-y divide-line border-y border-line md:-mx-5 lg:mx-0 lg:rounded-md lg:border">
                {c.critical_list.slice(0, 6).map((t) => (
                  <TaskLine key={t.id} t={t} dense />
                ))}
              </div>
            </section>
          )}
          {c.conflict_list.length > 0 && (
            <section className="min-w-0">
              <h3 className="mb-1.5 text-[13px] font-semibold">Scheduling conflicts ({c.conflict_list.length})</h3>
              <ul className="max-h-[440px] space-y-1.5 overflow-y-auto scroll-thin">
                {c.conflict_list.map((x) => (
                  <li key={x.id} className="flex gap-2 rounded-md border border-line px-3 py-2 text-[12.5px] leading-snug text-ink-2">
                    <Badge size="sm" tone={x.kind === 'double_booked' ? 'warning' : 'danger'} className="mt-px shrink-0">
                      {x.kind === 'double_booked' ? 'Double-booked' : 'Dependency'}
                    </Badge>
                    <span className="min-w-0">{x.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Panel>
  )
}
function TaskPipeline({ d }: { d: PmDashboard }) {
  const max = Math.max(1, ...d.pipeline.map((p) => p.count))
  return (
    <Panel title="Task pipeline" subtitle={`How many open tasks sit in each status · In review = sent for approval · ${d.done_count} completed`} action={<SeeAll to="/tasks">Tasks</SeeAll>}>
      <ul className="space-y-2">
        {d.pipeline.map((p) => (
          <li key={p.stage} className="grid grid-cols-[minmax(0,118px)_minmax(0,1fr)_32px] items-center gap-3 sm:grid-cols-[170px_minmax(0,1fr)_36px]">
            <span className="text-[13px] leading-tight text-ink-2">{p.label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-surface-2">
              <span className={cn('block h-full rounded-full', BAR_TONE[p.group === 'review' ? 'accent' : p.group === 'waiting' ? (p.stage === 'on_hold' ? 'warning' : 'danger') : p.group === 'not_started' ? 'warning' : 'success'])} style={{ width: `${p.count ? Math.max(2, (p.count / max) * 100) : 0}%` }} />
            </span>
            <span className="tnum text-right text-[13px] font-semibold">{p.count}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
function ResourceLoad({ d }: { d: PmDashboard }) {
  const L = d.load_hours
  return (
    <Panel title="Resource load, next 10 working days" subtitle={`Booked hours against capacity · ${fmtDate(L.from)} – ${fmtDate(L.to)} · over 100% is double-booked`} action={<SeeAll to="/team">Team</SeeAll>}>
      {L.people.length ? (
        <ul className="space-y-3">
          {L.people.map((p) => {
            const pct = p.pct ?? 0
            const tone = p.double_booked ? 'bg-danger' : pct >= 0.85 ? 'bg-warning' : 'bg-success'
            return (
              <li key={p.id} className="min-w-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="flex min-w-0 shrink-0 items-center gap-2">
                    <span className="truncate text-[13.5px] font-semibold">{p.name}</span>
                    {p.double_booked && <Badge size="sm" tone="danger">Double-booked</Badge>}
                    {p.leave_days > 0 && <span className="hidden whitespace-nowrap text-[11.5px] text-ink-3 sm:inline">{p.leave_days}d leave</span>}
                  </span>
                  <span className={cn('tnum whitespace-nowrap text-[13px] font-semibold', p.double_booked ? 'text-danger-text' : pct >= 0.85 ? 'text-warning-text' : 'text-success-text')}>
                    {p.booked}h of {p.capacity}h ({p.pct === null ? '—' : pct >= 3 ? `≈${Math.round(p.booked / Math.max(1, L.days))}h/day vs ${Math.round((p.capacity / Math.max(1, L.days)) * 2) / 2}h focus` : fmtPct(p.pct, 0)})
                  </span>
                </div>
                <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-surface-2">
                  <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.min(100, pct * 100)}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <ListEmpty>No team members to plan yet.</ListEmpty>
      )}
    </Panel>
  )
}

function loadTone(p: number) {
  return p > 1.1 ? 'bg-danger' : p > 0.85 ? 'bg-warning' : p >= 0.5 ? 'bg-success' : p > 0 ? 'bg-success/50' : 'bg-surface-2'
}

export default function PmHome() {
  const week = useWeek()
  const q = usePmDashboard(true, week)
  const d = q.data
  if (q.isLoading && !d)
    return (
      <div className="space-y-4">
        <SkeletonCards n={4} />
        <SkeletonRows rows={6} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const k = d.kpis
  return (
    <div className="space-y-4 md:space-y-5">
      {/* v7 quick action: the shared professional Create task form */}
      <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1 text-[13.5px]">
          <span className="font-medium text-ink">Quick actions.</span> <span className="text-ink-2">Assign a task with owner, reviewer, dates and definition of done, or review the team’s work.</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/team-tasks?tab=review">
            <Button size="sm">Review queue</Button>
          </Link>
          <CreateTaskButton />
        </div>
      </div>
      <NeedsAttention d={d} />
      <DeliveryControl d={d} />
      <div className="grid gap-4 xl:grid-cols-2">
        <TaskPipeline d={d} />
        <ResourceLoad d={d} />
      </div>
      {BreachRiskList && (
        <Suspense fallback={<div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={4} /></div>}>
          <BreachRiskList />
        </Suspense>
      )}

      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
        <Kpi label="Live projects" value={k.active} sub={`${k.at_risk} need attention`} tone={k.at_risk ? 'warning' : 'success'} to="/projects" />
        <Kpi label="Overdue tasks" value={k.overdue_tasks} tone={k.overdue_tasks ? 'danger' : 'success'} to="/insights/tasks_at_risk" />
        <Kpi label="Blocked" value={k.blocked} tone={k.blocked ? 'warning' : 'success'} to="/insights/blocked" />
        <Kpi label="Due in 3 days" value={k.due_3d} sub={`${d.due_week} due in the selected week`} />
        <Kpi label="Approvals for me" value={k.pending_approvals} tone={d.approvals.some((a) => a.overdue) ? 'danger' : undefined} to="/approvals" />
        <Kpi label="Change requests" value={k.open_crs} sub="awaiting decision" />
        <Kpi label="TS compliance" value={fmtPct(k.compliance, 0)} sub="team, 8 weeks" tone={k.compliance === null ? undefined : k.compliance >= 0.9 ? 'success' : k.compliance >= 0.75 ? 'warning' : 'danger'} to="/insights/timesheet_compliance" />
        <Kpi label="Team" value={d.load.people.length} sub={`${d.load.people.filter((p) => p.avg > 1.1).length} over 110%`} to="/insights/allocation" />
      </div>

      <Panel title="Project health" subtitle="My live projects by health, progress and next milestone" action={<SeeAll to="/projects" />}>
        <ProjectHealthStrip projects={d.projects} emptyText="You don’t manage any live projects yet." />
      </Panel>

      <TaskDeliveryPanel variant="pm" />

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel className="xl:col-span-7" title="Tasks at risk" subtitle="Overdue, or due within 3 days and not started" action={<SeeAll to="/insights/tasks_at_risk" />} flush>
          {d.at_risk.length ? (
            <div className="divide-y divide-line border-t border-line">
              {d.at_risk.slice(0, 8).map((t) => (
                <TaskLine key={t.id} t={t} />
              ))}
            </div>
          ) : (
            <ListEmpty>Nothing at risk. Every near-term task is moving.</ListEmpty>
          )}
        </Panel>
        <Panel className="xl:col-span-5" title="Blocked" subtitle="Clear the oldest first" action={<SeeAll to="/insights/blocked" />} flush>
          {d.blocked.length ? (
            <div className="divide-y divide-line border-t border-line">
              {d.blocked.slice(0, 6).map((t) => (
                <TaskLine key={t.id} t={t} />
              ))}
            </div>
          ) : (
            <ListEmpty>No blocked tasks.</ListEmpty>
          )}
        </Panel>
      </div>

      <Panel title="Allocation by day" subtitle="Allocation % per person per day, next 10 working days · green ≤85% · amber ≤110% · red over" action={<SeeAll to="/team">Team</SeeAll>} flush>
        {d.load.people.length ? (
          <div className="overflow-x-auto border-t border-line scroll-thin">
            <table className="w-full min-w-[640px] text-[12.5px]">
              <thead>
                <tr className="bg-surface-2 text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
                  <th className="sticky left-0 z-[1] h-9 w-[200px] bg-surface-2 pl-4 text-left font-semibold md:pl-5">Person</th>
                  {d.load.dates.map((dt) => (
                    <th key={dt} className="px-1 text-center font-semibold normal-case tracking-normal">
                      {new Date(dt + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }).slice(0, 2)}
                      <div className="text-[10.5px] font-medium text-ink-3">{dt.slice(8)}</div>
                    </th>
                  ))}
                  <th className="pr-4 text-right font-semibold md:pr-5">Avg</th>
                </tr>
              </thead>
              <tbody>
                {d.load.people.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="sticky left-0 z-[1] bg-surface py-2 pl-4 md:pl-5">
                      <span className="flex items-center gap-2">
                        <Avatar name={p.name} hue={p.hue} size={24} />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold">{p.name}</span>
                          <span className="block truncate text-[11px] text-ink-3">{p.title}</span>
                        </span>
                      </span>
                    </td>
                    {p.days.map((x) => (
                      <td key={x.date} className="px-1 py-2 text-center">
                        <Tooltip content={`${fmtDate(x.date, 'long')}: ${fmtPct(x.pct, 0)} allocated`}>
                          <span className={cn('tnum mx-auto grid h-7 w-full min-w-[34px] place-items-center rounded-md text-[11px] font-semibold', loadTone(x.pct), x.pct > 0.85 || x.pct >= 0.5 ? 'text-white' : 'text-ink-2')}>{Math.round(x.pct * 100)}</span>
                        </Tooltip>
                      </td>
                    ))}
                    <td className={cn('tnum pr-4 text-right font-semibold md:pr-5', p.avg > 1.1 ? 'text-danger-text' : p.avg < 0.8 ? 'text-warning-text' : 'text-ink')}>{fmtPct(p.avg, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <ListEmpty>No team members with allocations yet.</ListEmpty>
        )}
      </Panel>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        <Panel className="xl:col-span-4" title="Approvals for me" subtitle={d.approvals.length ? `${d.approvals.filter((a) => a.overdue).length} past the SLA` : undefined} action={<SeeAll to="/approvals">Approve</SeeAll>} flush>
          {d.approvals.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.approvals.slice(0, 6).map((a) => (
                <li key={a.id}>
                  <Link to="/approvals" className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <Avatar name={a.person} hue={a.hue} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{a.person}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {weekLabel(a.week_start)} · {a.hours}h
                      </span>
                    </span>
                    {a.overdue ? <Badge tone="danger" size="sm">Overdue</Badge> : a.due ? <span className="text-[11.5px] text-ink-3">by {fmtDate(a.due)}</span> : null}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>Nothing waiting for your approval.</ListEmpty>
          )}
        </Panel>
        <Panel className="xl:col-span-4" title="Change requests" subtitle="Awaiting a decision" flush>
          {d.change_requests.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.change_requests.map((c) => (
                <li key={c.id}>
                  <Link to={`/projects/${c.project_id}/changes`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{c.title}</span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {c.project} · {c.hours}h · {c.age_days}d old
                      </span>
                    </span>
                    <span className="text-right">
                      {c.value !== null && <Money value={c.value} compact className="block text-[13px] font-semibold" />}
                      <StatusBadge map={CR_STATUS} value={c.status} size="sm" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No change requests waiting.</ListEmpty>
          )}
        </Panel>
        <Panel className="md:col-span-2 xl:col-span-4" title="Team timesheet compliance" subtitle="Last 8 completed weeks" action={<SeeAll to="/insights/timesheet_compliance" />} flush>
          {d.compliance.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.compliance.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-center gap-3 px-4 py-2 md:px-5">
                  <Avatar name={p.name} hue={p.hue} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.name}</span>
                  <span className="hidden gap-0.5 sm:flex">
                    {p.weeks.map((w, i) => (
                      <Tooltip key={i} content={w === 'missing' ? 'Not started' : WEEK_STATUS[w].label}>
                        <span className={cn('h-4 w-2 rounded-sm', w === 'approved' ? 'bg-success' : w === 'submitted' ? 'bg-warning' : w === 'open' ? 'bg-info/60' : 'bg-danger')} />
                      </Tooltip>
                    ))}
                  </span>
                  <span className={cn('tnum w-11 text-right text-[13px] font-semibold', p.pct >= 0.9 ? 'text-success-text' : p.pct >= 0.75 ? 'text-warning-text' : 'text-danger-text')}>{fmtPct(p.pct, 0)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No team members yet.</ListEmpty>
          )}
        </Panel>
      </div>

      <Panel title="Upcoming milestones" subtitle="Next 45 days" flush>
        {d.milestones.length ? (
          <ul className="divide-y divide-line border-t border-line md:grid md:grid-cols-2 md:divide-y-0">
            {d.milestones.map((m) => (
              <li key={m.id} className="md:border-b md:border-line md:odd:border-r">
                <Link to={`/projects/${m.project_id}/schedule`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{m.label}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {m.project} · {fmtPct(m.progress, 0)} done
                    </span>
                  </span>
                  <span className="text-right">
                    <span className={cn('tnum block text-[12.5px] font-semibold', m.days < 0 ? 'text-danger-text' : 'text-ink-2')}>{m.days < 0 ? `${-m.days}d late` : fmtDate(m.planned_end)}</span>
                    <StatusBadge map={MILESTONE_STATE as never} value={m.state as never} size="sm" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <ListEmpty>No milestones due in the next 45 days.</ListEmpty>
        )}
      </Panel>
    </div>
  )
}
