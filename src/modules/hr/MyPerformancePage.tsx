// /performance and /performance/:userId — a person's performance profile built from real work data:
// task timeliness and review quality, timesheet compliance, allocation, goals, feedback and appraisal history.
import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useApi } from '@/api/query'
import { hrApi, type PerfTaskRow, type PerformanceProfile } from '@/api/hr'
import { periodRange } from '@/domain/calendar'
import { fmtDate } from '@/domain/calendar'
import { TASK_STATUS } from '@/domain/labels'
import { fmtNum } from '@/domain/money'
import { useUI } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { cn } from '@/lib/utils'
import {
  Avatar, Badge, Card, CardHeader, ChartTable, Combobox, DataTable, EmptyState, ErrorState, LineChart, PageHeader, PeriodSwitch, Segmented, SkeletonCards, SkeletonRows, StatCard, StatusBadge, usePeriod, type Column,
} from '@/ui'
import { GoalsPanel, FeedbackPanel } from './GoalsPanel'
import { APPRAISAL_STATUS, Rating, Timeliness, days, pct, pctTone } from './components'
import { Link } from 'react-router-dom'

export default function MyPerformancePage() {
  const { userId } = useParams()
  const nav = useNavigate()
  const me = useSession((s) => s.user)
  const [period, setPeriod] = usePeriod('fy')
  const r = periodRange(period.kind, period.anchor)
  const q = useApi(['performance', userId ?? 'me', r.from, r.to], () => hrApi.performance(userId, r.from, r.to))
  const people = useApi(['performance', 'people'], hrApi.performancePeople, { staleTime: 60_000 })
  const d = q.data
  const opts = useMemo(() => (people.data ?? []).map((p) => ({ value: p.id, label: p.name, hint: p.title, leading: <Avatar name={p.name} hue={p.avatar_hue} size={22} /> })), [people.data])
  const showPicker = (people.data?.length ?? 0) > 1
  const forbidden = (q.error as { status?: number } | null)?.status === 403

  return (
    <div>
      <PageHeader
        title={d && !d.is_self ? d.user.name : 'My performance'}
        subtitle={d ? `${d.user.title}${d.user.manager_name ? ` · reports to ${d.user.manager_name}` : ''} · numbers come from approved tasks, reviews and timesheets` : 'Delivery, quality and goals from your real work data.'}
        back={userId ? { to: '/performance', label: 'My performance' } : undefined}
        actions={
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            {showPicker && (
              <div className="w-full sm:w-[240px]">
                <Combobox value={d?.user.id ?? null} onChange={(v) => v && nav(v === me?.id ? '/performance' : `/performance/${v}`)} options={opts} placeholder="Choose a person" searchPlaceholder="Search people" />
              </div>
            )}
            <PeriodSwitch value={period} onChange={setPeriod} />
          </div>
        }
      />
      {q.isLoading ? (
        <div className="space-y-4">
          <SkeletonCards n={8} />
          <SkeletonRows rows={6} />
        </div>
      ) : forbidden ? (
        <ErrorState error={{ code: 'FORBIDDEN', message: 'You can see your own performance and that of people who report to you.' }} />
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Profile d={d} />
      )}
    </div>
  )
}

function Profile({ d }: { d: PerformanceProfile }) {
  const k = d.kpis
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const trend = d.trend.map((t) => ({ label: t.label, on_time: t.on_time_pct, completed: t.completed }))
  const hasTrend = d.trend.some((t) => t.completed > 0)
  return (
    <div className="space-y-4 md:space-y-5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
        <StatCard label="On-time delivery" value={pct(k.on_time_pct)} tone={pctTone(k.on_time_pct)} sub={`${k.completed} done · ${k.late} late`} hint="Early or on-time completions ÷ completed tasks in the period." />
        <StatCard label="Average slip" value={days(k.avg_variance_days)} tone={k.avg_variance_days !== null && k.avg_variance_days > 1 ? 'warning' : undefined} sub="working days vs due" hint="Average working days between due date and completion. Negative means early." />
        <StatCard label="First-pass approval" value={pct(k.first_pass_pct)} tone={pctTone(k.first_pass_pct)} sub="approved without send-back" />
        <StatCard label="Review quality" value={k.avg_quality === null ? '—' : `${fmtNum(k.avg_quality, 1)} / 5`} tone={k.avg_quality !== null && k.avg_quality < 3 ? 'warning' : undefined} sub="reviewer rating" />
        <StatCard label="Timesheet compliance" value={pct(k.timesheet_compliance)} tone={pctTone(k.timesheet_compliance, 0.9, 0.75)} sub={`${k.approved_weeks}/${k.expected_weeks} weeks · ${k.late_submissions} late`} />
        <StatCard label="Allocation" value={pct(k.utilisation)} tone={k.utilisation !== null && k.utilisation > 1 ? 'danger' : undefined} sub="average across working days" />
        <StatCard label="Goals achieved" value={`${k.goals_achieved}/${k.goals_total}`} sub={k.goals_score === null ? 'no agreed goals' : `${pct(k.goals_score)} weighted progress`} />
        {k.approval_sla_pct !== null ? (
          <StatCard label="Approvals on time" value={pct(k.approval_sla_pct)} tone={pctTone(k.approval_sla_pct)} sub="timesheets decided within SLA" />
        ) : (
          <StatCard label="Open tasks" value={k.open} tone={k.overdue_open ? 'danger' : undefined} sub={k.overdue_open ? `${k.overdue_open} overdue` : 'none overdue'} />
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-12 md:gap-5">
        <Card className="min-w-0 lg:col-span-7">
          <CardHeader
            title="On-time delivery by month"
            subtitle="Last six months, tasks completed early or on the due date"
            action={<Segmented size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />}
          />
          {!hasTrend ? (
            <EmptyState compact title="No completed tasks yet" body="The trend appears once tasks are approved." />
          ) : view === 'chart' ? (
            <LineChart data={trend} x="label" series={[{ key: 'on_time', label: 'On time' }]} format="percent" height={240} />
          ) : (
            <ChartTable data={trend} x="label" xLabel="Month" series={[{ key: 'on_time', label: 'On time', format: 'percent' }, { key: 'completed', label: 'Completed', format: 'number' }]} />
          )}
        </Card>
        <Card className="min-w-0 lg:col-span-5">
          <CardHeader title="Why tasks slipped" subtitle="Delay reasons given at submission" />
          {d.delay_reasons.length ? (
            <ul className="space-y-2.5">
              {d.delay_reasons.map((r) => {
                const max = d.delay_reasons[0].count
                return (
                  <li key={r.code} className="min-w-0">
                    <div className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="truncate text-ink-2">{r.label}</span>
                      <span className="tnum shrink-0 font-medium">{r.count}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${(r.count / max) * 100}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            <EmptyState compact title="No delays recorded" body="When a task is submitted late, the reason given shows up here." />
          )}
        </Card>
      </div>

      <TasksCard tasks={d.tasks} />

      <div className="grid gap-4 lg:grid-cols-12 md:gap-5">
        <GoalsPanel className="lg:col-span-7" goals={d.goals} userId={d.user.id} cycles={d.cycles} canAdd={d.can_add_goal} subtitle="Agreed with the manager; weights total 100% per cycle" />
        <FeedbackPanel className="lg:col-span-5" items={d.feedback} toUserId={d.user.id} toName={d.user.name} canGive={d.can_give_feedback} />
      </div>

      <Card pad={false} className="min-w-0">
        <div className="px-4 pt-4 md:px-5">
          <CardHeader title="Appraisal history" subtitle="Final ratings are visible once HR completes the review" />
        </div>
        {d.appraisals.length ? (
          <ul className="divide-y divide-line border-t border-line">
            {d.appraisals.map((a) => (
              <li key={a.id}>
                <Link to={`/appraisals/${a.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2 md:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium">{a.cycle_name}</div>
                    <div className="truncate text-[12px] text-ink-3">
                      {fmtDate(a.period_from)} – {fmtDate(a.period_to)}
                      {a.increment_pct !== null ? ` · increment ${a.increment_pct}%` : ''}
                      {a.promotion_to ? ` · promoted to ${a.promotion_to}` : ''}
                    </div>
                  </div>
                  {a.status === 'completed' ? <Rating value={a.final_rating} /> : <StatusBadge size="sm" map={APPRAISAL_STATUS} value={a.status} />}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 pb-4 md:px-5">
            <EmptyState compact title="No appraisals yet" body="Appraisals appear here once HR launches a cycle." />
          </div>
        )}
      </Card>
    </div>
  )
}

function TasksCard({ tasks }: { tasks: PerfTaskRow[] }) {
  const openTask = useUI((s) => s.openTask)
  const [f, setF] = useState<'all' | 'late' | 'open'>('all')
  const rows = tasks.filter((t) => (f === 'all' ? true : f === 'late' ? t.timeliness === 'late' || t.overdue_days > 0 : t.status !== 'done'))
  const cols: Column<PerfTaskRow>[] = [
    {
      key: 'task', header: 'Task', sortValue: (t) => t.title,
      cell: (t) => (
        <div className="min-w-0 max-w-[420px]">
          <div className="truncate font-medium text-ink">{t.title}</div>
          <div className="truncate text-[12px] text-ink-3">{t.code} · {t.project}</div>
        </div>
      ),
    },
    { key: 'due', header: 'Due', sortValue: (t) => t.due_on, cell: (t) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(t.due_on)}</span> },
    { key: 'done', header: 'Done', sortValue: (t) => t.done_on ?? '', cell: (t) => <span className="tnum whitespace-nowrap text-ink-2">{t.done_on ? fmtDate(t.done_on) : '—'}</span>, hideBelow: 'lg' },
    { key: 'time', header: 'Timeliness', cell: (t) => (t.status === 'done' ? <Timeliness t={t.timeliness} variance={t.variance_days} /> : t.overdue_days ? <Badge size="sm" tone="danger">{t.overdue_days}d overdue</Badge> : <StatusBadge size="sm" map={TASK_STATUS} value={t.status as keyof typeof TASK_STATUS} />) },
    { key: 'q', header: 'Quality', align: 'right', sortValue: (t) => t.quality_rating ?? -1, cell: (t) => (t.quality_rating ? <span className="tnum">{t.quality_rating}/5</span> : <span className="text-ink-3">—</span>), hideBelow: 'md' },
    { key: 'why', header: 'Delay reason', cell: (t) => <span className="block max-w-[260px] truncate text-[12.5px] text-ink-2">{t.delay_reason ?? '—'}</span>, hideBelow: 'xl' },
  ]
  return (
    <Card pad={false} className="min-w-0">
      <div className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between md:px-5">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold">Recent tasks</h3>
          <p className="text-[12.5px] text-ink-3">Due or completed in the period</p>
        </div>
        <Segmented size="sm" value={f} onChange={setF} options={[{ value: 'all', label: 'All', count: tasks.length }, { value: 'late', label: 'Late', count: tasks.filter((t) => t.timeliness === 'late' || t.overdue_days > 0).length }, { value: 'open', label: 'Open', count: tasks.filter((t) => t.status !== 'done').length }]} />
      </div>
      <div className={cn('p-4 md:p-5')}>
        <DataTable
          rows={rows}
          columns={cols}
          rowKey={(t) => t.id}
          onRowClick={(t) => openTask(t.id)}
          initialSort={{ key: 'due', dir: 'desc' }}
          pageSize={12}
          empty={<EmptyState compact title="No tasks in this period" body="Switch the period to see earlier work." />}
          mobileCard={(t) => (
            <div className="space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 text-[14px] font-medium">{t.title}</span>
                {t.status === 'done' ? <Timeliness t={t.timeliness} variance={t.variance_days} /> : t.overdue_days ? <Badge size="sm" tone="danger">{t.overdue_days}d overdue</Badge> : null}
              </div>
              <div className="text-[12.5px] text-ink-3">{t.code} · due {fmtDate(t.due_on)}{t.done_on ? ` · done ${fmtDate(t.done_on)}` : ''}{t.quality_rating ? ` · quality ${t.quality_rating}/5` : ''}</div>
              {t.delay_reason && <div className="text-[12.5px] text-ink-2">{t.delay_reason}</div>}
            </div>
          )}
        />
      </div>
    </Card>
  )
}
