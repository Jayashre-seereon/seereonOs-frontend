// Employee view (Feature Guide §1, screenshot 001): person picker for managers, "Tagged you" (comments that
// mention the person), "Covering" (tasks they back up while a colleague is on leave), their numbers for the
// header week, then today / this week, the week's timesheet, blockers and who is waiting on them.
import { Fragment } from 'react'
import { Link } from 'react-router-dom'
import { useEmployeeDashboard, type EmployeeDashboard, type MentionRow } from '@/api/dashboards'
import { useUI, useWeek } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { Avatar, Badge, Button, ErrorState, Field, Select, SkeletonCards, SkeletonRows, StatusBadge, Tooltip, useCan } from '@/ui'
import { CreateTaskButton } from '@/modules/work/TaskForm'
import { fmtDate, todayISO } from '@/domain/calendar'
import { WEEK_STATUS } from '@/domain/labels'
import { fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { ListEmpty, MetricGrid, Panel, SeeAll, TaskLine, scoreTone } from '../kit'
import { TaskDeliveryPanel } from '@/modules/work/taskDelivery'

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
/** Comment text with @mentions highlighted. */
function MentionBody({ text }: { text: string }) {
  const parts = text.split(/(@[A-Z][\w’'-]*(?: [A-Z][\w’'-]*)?)/g)
  return (
    <>
      {parts.map((p, i) => (p.startsWith('@') ? <span key={i} className="font-semibold text-brand-text">{p}</span> : <Fragment key={i}>{p}</Fragment>))}
    </>
  )
}
function TaggedYou({ list, self }: { list: MentionRow[]; self: boolean }) {
  const openTask = useUI((s) => s.openTask)
  return (
    <Panel title="Tagged you" subtitle={self ? 'Comments where someone mentioned you with @' : 'Comments that mention this person'} flush>
      {list.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {list.map((m) => (
            <li key={m.id} className="px-4 py-3 md:px-5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px]">
                <span className="tnum font-semibold text-brand-text">{m.task_code}</span>
                <span className="min-w-0 font-medium text-ink">{m.task_title}</span>
                {m.tag && <Badge size="sm" tone={m.tag_tone ?? 'neutral'}>{m.tag}</Badge>}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                <span className="font-medium text-ink-2">{m.author}</span>, {when(m.at)}: <MentionBody text={m.body} />
              </p>
              <p className="mt-0.5 truncate text-[12px] text-ink-3">{m.project}</p>
              <Button size="sm" className="mt-2" onClick={() => openTask(m.task_id)}>
                Open task
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <ListEmpty>No one has mentioned {self ? 'you' : 'them'} recently.</ListEmpty>
      )}
    </Panel>
  )
}
function Numbers({ d }: { d: EmployeeDashboard }) {
  const n = d.numbers
  const can = useCan()
  return (
    <Panel title={d.person.name} subtitle={`${d.person.title} · numbers for the week in the header`} action={can('insights.view') ? <SeeAll to="/scorecard">Scorecard</SeeAll> : <SeeAll to="/performance">My performance</SeeAll>}>
      <MetricGrid
        items={[
          { label: 'This week’s score', value: n.score ?? '—', tone: n.score === null ? undefined : scoreTone(n.score), hint: n.score_cells.length ? n.score_cells.map((c) => `${c.label}: ${c.value === null ? 'n/a' : c.value + '%'}`).join(' · ') : 'Nothing to score yet this week.' },
          { label: 'On-time delivery', value: fmtPct(n.on_time, 0), tone: n.on_time === null ? undefined : n.on_time >= 0.9 ? 'success' : n.on_time >= 0.75 ? 'warning' : 'danger' },
          { label: 'Effort ratio (actual ÷ estimate)', value: n.effort_ratio === null ? '—' : `×${n.effort_ratio.toFixed(2)}`, tone: n.effort_ratio === null ? undefined : n.effort_ratio <= 1.1 ? 'success' : n.effort_ratio <= 1.3 ? 'warning' : 'danger' },
          { label: 'Utilisation, next 10 working days', value: fmtPct(n.utilisation, 0), tone: n.utilisation === null ? undefined : n.utilisation > 1 ? 'danger' : n.utilisation >= 0.6 ? 'success' : 'warning', sub: `${n.booked}h of ${n.capacity}h` },
          { label: 'Open tasks', value: n.open },
          { label: 'Average lateness (days)', value: n.avg_lateness === null ? '—' : `${fmtNum(n.avg_lateness, 1)}d`, tone: n.avg_lateness ? 'warning' : 'success' },
          { label: 'Overdue', value: n.overdue, tone: n.overdue ? 'danger' : 'success' },
          { label: 'Tasks forecast to breach', value: n.forecast_breach, tone: n.forecast_breach ? 'warning' : 'success' },
        ]}
      />
    </Panel>
  )
}

export default function EmployeeHome({ person, onPerson }: { person?: string | null; onPerson?: (id: string | null) => void }) {
  const week = useWeek()
  const { user } = useSession()
  const q = useEmployeeDashboard(true, person, week)
  const d = q.data
  if (q.isLoading && !d)
    return (
      <div className="space-y-4">
        <SkeletonCards n={4} />
        <SkeletonRows rows={6} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const ts = d.timesheet
  const s = d.stats
  const today = todayISO()
  const short = ts.expected_to_date - ts.days.filter((x) => x.date < today).reduce((a, x) => a + x.hours, 0)
  const self = d.is_self
  const me = user?.id
  return (
    <div className="space-y-4 md:space-y-5">
      {d.viewable.length > 1 && onPerson && (
        <div className="rounded-lg border border-line bg-surface p-4 md:p-5">
          <Field label="Employee">
            <Select value={d.person.id} onChange={(e) => onPerson(e.target.value === me ? null : e.target.value)} options={d.viewable.map((u) => ({ value: u.id, label: u.id === me ? `${u.name} (you)` : `${u.name} · ${u.title}` }))} aria-label="Employee" />
          </Field>
        </div>
      )}
      <TaggedYou list={d.mentions} self={self} />
      {d.covering.length > 0 && (
        <Panel title="Covering" subtitle={self ? 'Tasks you cover this week while a colleague is away; you can log time on them' : 'Tasks they cover this week while a colleague is away'} flush>
          <div className="divide-y divide-line border-t border-line">
            {d.covering.map((t) => (
              <TaskLine key={t.id} t={{ ...t, reason: t.why }} />
            ))}
          </div>
        </Panel>
      )}
      <Numbers d={d} />
      {self && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-[13.5px]">
            <span className="font-medium text-ink">Quick actions.</span> <span className="text-ink-2">Create a task for yourself (your manager reviews it) or log this week’s hours.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link to={`/timesheet/${week}`}>
              <Button size="sm">Log time</Button>
            </Link>
            <CreateTaskButton />
          </div>
        </div>
      )}
      {self && !d.daily.submitted_today && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-[13.5px]">
            <span className="font-medium text-ink">Post today’s update.</span> <span className="text-ink-2">What you finished{d.daily.proof_required ? ', with a proof link' : ''}, and anything blocking you.{d.daily.last_date ? ` Last update: ${fmtDate(d.daily.last_date)}.` : ''}</span>
          </div>
          <Link to="/daily">
            <Button size="sm" variant="primary" block>
              Write update
            </Button>
          </Link>
        </div>
      )}

      <p className="text-[12.5px] text-ink-3">
        Done in the last 4 weeks: <span className="tnum font-semibold text-ink">{s.done_4w}</span> (previous 4 weeks: {s.done_prev_4w}) · allocated {fmtPct(s.allocation_10d, 0)} of the next 10 working days
      </p>

      {self && <TaskDeliveryPanel variant="employee" />}

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="min-w-0 space-y-4 md:space-y-5 xl:col-span-7">
          <Panel title="Today" subtitle={d.overdue.length ? `${d.overdue.length} overdue first` : 'Due today'} action={<SeeAll to="/my-tasks">My tasks</SeeAll>} flush>
            {d.overdue.length + d.today.length ? (
              <div className="divide-y divide-line border-t border-line">
                {[...d.overdue, ...d.today].map((t) => (
                  <TaskLine key={t.id} t={t} />
                ))}
              </div>
            ) : (
              <ListEmpty>Nothing due today. Pick up the next task from this week.</ListEmpty>
            )}
          </Panel>
          <Panel title="This week" subtitle="Still to do in the week in the header" flush>
            {d.week.length ? (
              <div className="divide-y divide-line border-t border-line">
                {d.week.map((t) => (
                  <TaskLine key={t.id} t={t} />
                ))}
              </div>
            ) : (
              <ListEmpty>No other tasks due this week.</ListEmpty>
            )}
          </Panel>
        </div>
        <div className="min-w-0 space-y-4 md:space-y-5 xl:col-span-5">
          <Panel
            title={self ? 'My timesheet for the week' : 'Timesheet for the week'}
            subtitle={`${fmtNum(ts.total, 1)}h logged · minimum ${ts.min_per_day}h per working day`}
           
            action={<StatusBadge map={{ ...WEEK_STATUS, missing: { label: 'Not started', tone: 'neutral' } } as never} value={ts.status as never} size="sm" />}
          >
            <div className="grid grid-cols-7 gap-1.5">
              {ts.days.map((x) => {
                const below = x.working && x.date < today && x.hours < x.min
                const h = x.min ? Math.min(1, x.hours / x.min) : x.hours ? 1 : 0
                return (
                  <Tooltip key={x.date} content={`${fmtDate(x.date, 'long')}: ${fmtNum(x.hours, 1)}h${x.working ? ` of ${x.min}h` : ' (off)'}`}>
                    <div className="flex flex-col items-center gap-1">
                      <div className={cn('relative h-20 w-full overflow-hidden rounded-md', x.working ? 'bg-surface-2' : 'bg-surface-2/40 bg-[repeating-linear-gradient(45deg,transparent,transparent_4px,var(--line)_4px,var(--line)_5px)]')}>
                        <div className={cn('absolute inset-x-0 bottom-0 rounded-md', below ? 'bg-danger/80' : x.hours >= x.min && x.min ? 'bg-success' : 'bg-brand/70')} style={{ height: `${h * 100}%` }} />
                      </div>
                      <span className={cn('tnum text-[11.5px] font-semibold', below ? 'text-danger-text' : 'text-ink-2')}>{x.hours ? fmtNum(x.hours, 1) : x.date < today && x.working ? '0' : ''}</span>
                      <span className="text-[10.5px] uppercase text-ink-3">{new Date(x.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' }).slice(0, 2)}</span>
                    </div>
                  </Tooltip>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-[12.5px] text-ink-3">{short > 0 ? <span className="font-semibold text-danger-text">{fmtNum(short, 1)}h short so far</span> : 'On track for the week'}</span>
              {self && (
                <Link to={`/timesheet/${ts.week_start}`}>
                  <Button size="sm" variant={ts.status === 'open' || ts.status === 'missing' || ts.status === 'rejected' ? 'primary' : 'secondary'}>
                    {ts.status === 'submitted' || ts.status === 'approved' ? 'View week' : 'Fill timesheet'}
                  </Button>
                </Link>
              )}
            </div>
          </Panel>
          <Panel title="Blockers" subtitle={self ? 'Tasks you can’t move yet' : 'Tasks they can’t move yet'} flush>
            {d.blocked.length ? (
              <div className="divide-y divide-line border-t border-line">
                {d.blocked.map((t) => (
                  <TaskLine key={t.id} t={t} />
                ))}
              </div>
            ) : (
              <ListEmpty>Nothing is blocking {self ? 'you' : 'them'}.</ListEmpty>
            )}
          </Panel>
          <Panel title={self ? 'Others are waiting on you' : 'Others are waiting on them'} flush>
            {d.waiting_on_me.length ? (
              <div className="divide-y divide-line border-t border-line">
                {d.waiting_on_me.map((t) => (
                  <TaskLine
                    key={t.id}
                    t={{ ...t, reason: `${t.waiting.map((w) => w.owner ?? 'someone').join(', ')} can start once this is done` }}
                    meta={<Badge size="sm" tone="warning">{t.waiting.length} waiting</Badge>}
                  />
                ))}
              </div>
            ) : (
              <ListEmpty>No one is waiting on {self ? 'your' : 'their'} tasks.</ListEmpty>
            )}
          </Panel>
        </div>
      </div>
    </div>
  )
}
