// /appraisals — HR & admin run cycles (create, launch, track the funnel, rating distribution, overdue reviews);
// managers see their reports' appraisals; employees see their own.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Award, Plus } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { hrApi, type AppraisalRow, type AppraisalsView, type CycleView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { addDays, addMonths, fmtDate, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import {
  Avatar, BarChart, Badge, Button, Callout, Card, CardHeader, ChartTable, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, Progress, Segmented, Select, SkeletonCards, SkeletonRows, StatCard, StatusBadge,
  useConfirm, useReadOnly, type Column,
} from '@/ui'
import { APPRAISAL_STATUS, CYCLE_STATUS, Rating, pct } from './components'
import { LaunchDialog } from './AppraisalWorkflow'

export default function AppraisalsPage() {
  const [cycleId, setCycleId] = useState<string | undefined>(undefined)
  const q = useApi(['appraisals', cycleId ?? 'current'], () => hrApi.appraisals(cycleId))
  const d = q.data
  const [creating, setCreating] = useState(false)
  const ro = useReadOnly()
  const title = d?.mode === 'manager' ? 'Team appraisals' : d?.mode === 'self' ? 'My appraisals' : 'Appraisals'
  return (
    <div>
      <PageHeader
        title={title}
        subtitle={d?.mode === 'hr' ? 'Run review cycles. Ratings are checked against delivery, quality, timesheet and goal data.' : d?.mode === 'manager' ? 'Review the people who report to you. The system score is computed from their real work data.' : 'Your self reviews and completed appraisals.'}
        actions={
          d && d.mode !== 'self' ? (
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {d.cycles.length > 0 && (
                <div className="w-full sm:w-[200px]">
                  <Select aria-label="Cycle" value={d.cycle?.id ?? ''} onChange={(e) => setCycleId(e.target.value)} options={d.cycles.map((c) => ({ value: c.id, label: c.status === 'closed' ? `${c.name} (closed)` : c.status === 'draft' ? `${c.name} (draft)` : c.name }))} />
                </div>
              )}
              {d.can_manage && !ro && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>New cycle</Button>}
            </div>
          ) : undefined
        }
      />
      {q.isLoading ? (
        <div className="space-y-4">
          <SkeletonCards n={4} />
          <SkeletonRows rows={6} />
        </div>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d.mode === 'self' ? (
        <SelfList d={d} />
      ) : !d.cycle ? (
        <Card pad={false}>
          <EmptyState icon={<Award />} title="No appraisal cycles yet" body="Create a cycle with its period, due dates and how goals, tasks, timesheets and behaviour are weighted." action={d.can_manage && !ro && <Button variant="primary" onClick={() => setCreating(true)}>New cycle</Button>} />
        </Card>
      ) : (
        <CycleBoard d={d} cycle={d.cycle} />
      )}
      {creating && <NewCycleDialog onClose={() => setCreating(false)} onCreated={(id) => setCycleId(id)} />}
    </div>
  )
}

function CycleBoard({ d, cycle }: { d: AppraisalsView; cycle: CycleView }) {
  const nav = useNavigate()
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [f, setF] = useState<'all' | 'self_pending' | 'manager_pending' | 'hr_pending' | 'completed' | 'overdue'>('all')
  const [launching, setLaunching] = useState(false)
  const close = useMut(() => hrApi.closeCycle(cycle.id), { invalidate: [['appraisals']], success: 'Cycle closed' })
  const c = cycle.counts
  const done = cycle.total ? c.completed / cycle.total : 0
  const rows = d.rows.filter((r) => f === 'all' || (f === 'overdue' ? r.overdue : r.status === f))
  const w = cycle.weights
  const cols: Column<AppraisalRow>[] = [
    {
      key: 'who', header: 'Person', sortValue: (r) => r.user_name,
      cell: (r) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.user_name} hue={r.user_hue} size={28} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{r.user_name}</span>
            <span className="block truncate text-[12px] text-ink-3">{r.user_title}</span>
          </span>
        </span>
      ),
    },
    { key: 'mgr', header: 'Manager', sortValue: (r) => r.manager_name ?? '', cell: (r) => <span className="text-ink-2">{r.manager_name ?? '—'}</span>, hideBelow: 'xl' },
    { key: 'status', header: 'Stage', sortValue: (r) => r.status, cell: (r) => <span className="inline-flex flex-wrap items-center gap-1.5"><StatusBadge size="sm" map={APPRAISAL_STATUS} value={r.status} />{r.overdue && <Badge size="sm" tone="danger">Overdue</Badge>}</span> },
    { key: 'ot', header: 'On time', align: 'right', sortValue: (r) => r.on_time_pct ?? -1, cell: (r) => <span className="tnum">{pct(r.on_time_pct)}</span>, hideBelow: 'lg' },
    { key: 'self', header: 'Self', align: 'right', sortValue: (r) => r.self_rating ?? -1, cell: (r) => <span className="tnum">{r.self_rating ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'mr', header: 'Mgr', align: 'right', sortValue: (r) => r.manager_rating ?? -1, cell: (r) => <span className="tnum">{r.manager_rating ?? '—'}</span>, hideBelow: 'md' },
    { key: 'sys', header: 'System', align: 'right', sortValue: (r) => r.suggested ?? -1, cell: (r) => <span className="tnum text-ink-2">{r.suggested ?? '—'}</span> },
    { key: 'final', header: 'Final', align: 'right', sortValue: (r) => r.final_rating ?? -1, cell: (r) => <Rating value={r.final_rating} size="sm" suffix={false} /> },
    { key: 'inc', header: 'Increment', align: 'right', sortValue: (r) => r.increment_pct ?? -1, cell: (r) => <span className="tnum">{r.increment_pct === null ? '—' : `${r.increment_pct}%`}</span>, hideBelow: 'xl' },
  ]
  return (
    <div className="space-y-4 md:space-y-5">
      <Card>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[16px] font-semibold">{cycle.name}</h2>
              <StatusBadge size="sm" map={CYCLE_STATUS} value={cycle.status} />
            </div>
            <p className="mt-1 text-[13px] text-ink-3">
              Period {fmtDate(cycle.period_from)} – {fmtDate(cycle.period_to)} · self by {fmtDate(cycle.self_due)} · manager by {fmtDate(cycle.manager_due)} · HR by {fmtDate(cycle.hr_due)}
            </p>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              <Badge size="sm">Goals {w.goals}%</Badge>
              <Badge size="sm">Tasks {w.tasks}%</Badge>
              <Badge size="sm">Timesheets {w.timesheets}%</Badge>
              <Badge size="sm">Behaviour {w.behaviour}%</Badge>
            </div>
          </div>
          {d.can_manage && !ro && (
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
              {cycle.status === 'draft' && (
                <Button variant="primary" onClick={() => setLaunching(true)}>
                  Launch cycle
                </Button>
              )}
              {cycle.status !== 'draft' && cycle.status !== 'closed' && (
                <Button disabled={c.completed < cycle.total} loading={close.isPending} onClick={async () => { if (await confirm({ title: `Close ${cycle.name}?`, body: 'Final ratings are locked and the cycle moves to history.', confirmLabel: 'Close cycle' })) close.mutate(undefined) }}>
                  Close cycle
                </Button>
              )}
            </div>
          )}
        </div>
        {cycle.total > 0 && (
          <div className="mt-4 flex items-center gap-3">
            <Progress value={done} tone={done === 1 ? 'success' : 'brand'} className="flex-1" />
            <span className="tnum shrink-0 whitespace-nowrap text-[12.5px] font-medium text-ink-2">{c.completed} of {cycle.total} completed</span>
          </div>
        )}
      </Card>

      {cycle.status === 'draft' ? (
        <Callout tone="info" title="This cycle is a draft">Launch it to create appraisals for everyone with a manager. Goals for the period can be added from each person’s performance page.</Callout>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
            <StatCard label="Self review" value={c.self_pending} sub="waiting on the person" onClick={() => setF('self_pending')} />
            <StatCard label="Manager review" value={c.manager_pending} sub="waiting on the manager" onClick={() => setF('manager_pending')} />
            <StatCard label="HR calibration" value={c.hr_pending} sub="waiting on HR" onClick={() => setF('hr_pending')} />
            <StatCard label="Overdue reviews" value={d.overdue.length} tone={d.overdue.length ? 'danger' : 'success'} sub="past the stage due date" onClick={() => setF('overdue')} />
          </div>

          <div className="grid gap-4 lg:grid-cols-12 md:gap-5">
            <Card className="min-w-0 lg:col-span-5">
              <CardHeader title="Rating distribution" subtitle="Final rating, or the manager rating until HR calibrates" action={<Segmented size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />} />
              {d.distribution.some((x) => x.count) ? (
                view === 'chart' ? (
                  <BarChart data={d.distribution} x="rating" series={[{ key: 'count', label: 'People' }]} height={220} labelFormatter={(l) => `${l} / 5`} />
                ) : (
                  <ChartTable data={d.distribution} x="rating" xLabel="Rating" series={[{ key: 'count', label: 'People' }]} />
                )
              ) : (
                <EmptyState compact title="No ratings yet" body="Ratings appear as managers submit their reviews." />
              )}
            </Card>
            <Card pad={false} className="min-w-0 lg:col-span-7">
              <div className="px-4 pt-4 md:px-5">
                <CardHeader title="Overdue reviews" subtitle="Chase these first" />
              </div>
              {d.overdue.length ? (
                <ul className="divide-y divide-line border-t border-line">
                  {d.overdue.map((r) => (
                    <li key={r.id}>
                      <Link to={`/appraisals/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                        <Avatar name={r.user_name} hue={r.user_hue} size={26} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium">{r.user_name}</span>
                          <span className="block truncate text-[12px] text-ink-3">{APPRAISAL_STATUS[r.status].label}{r.status === 'manager_pending' && r.manager_name ? ` · ${r.manager_name}` : ''}</span>
                        </span>
                        <span className="tnum shrink-0 text-[12.5px] font-semibold text-danger-text">due {fmtDate(r.due_on)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="px-4 pb-4 md:px-5">
                  <EmptyState compact title="Nothing overdue" body="Every review is within its due date." />
                </div>
              )}
            </Card>
          </div>

          <div>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-[13.5px] font-semibold text-ink-2">People</h3>
              <Segmented
                size="sm"
                value={f}
                onChange={setF}
                options={[
                  { value: 'all', label: 'All', count: d.rows.length },
                  { value: 'self_pending', label: 'Self', count: c.self_pending },
                  { value: 'manager_pending', label: 'Manager', count: c.manager_pending },
                  { value: 'hr_pending', label: 'HR', count: c.hr_pending },
                  { value: 'completed', label: 'Done', count: c.completed },
                ]}
              />
            </div>
            <DataTable
              rows={rows}
              columns={cols}
              rowKey={(r) => r.id}
              onRowClick={(r) => nav(`/appraisals/${r.id}`)}
              initialSort={{ key: 'who', dir: 'asc' }}
              empty={<EmptyState compact title="Nobody in this stage" />}
              mobileCard={(r) => (
                <div className="flex items-start gap-3">
                  <Avatar name={r.user_name} hue={r.user_hue} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-[14px] font-medium">{r.user_name}</span>
                      {r.final_rating !== null ? <Rating value={r.final_rating} size="sm" /> : <StatusBadge size="sm" map={APPRAISAL_STATUS} value={r.status} />}
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-ink-3">
                      Self {r.self_rating ?? '—'} · Manager {r.manager_rating ?? '—'} · System {r.suggested ?? '—'}
                    </div>
                    {r.overdue && <div className="mt-1 text-[12px] font-medium text-danger-text">Overdue since {fmtDate(r.due_on)}</div>}
                  </div>
                </div>
              )}
            />
          </div>
        </>
      )}
      {launching && <LaunchDialog cycle={cycle} onClose={() => setLaunching(false)} />}
    </div>
  )
}

function SelfList({ d }: { d: AppraisalsView }) {
  if (!d.rows.length)
    return (
      <Card pad={false}>
        <EmptyState icon={<Award />} title="No appraisals yet" body="When HR launches a cycle, your self review shows up here." action={<Link to="/performance" className="text-[13px] font-medium text-brand-text hover:underline">See my performance</Link>} />
      </Card>
    )
  const cyc = new Map(d.cycles.map((c) => [c.id, c]))
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {d.rows.map((r) => {
        const c = cyc.get(r.cycle_id)
        return (
          <li key={r.id}>
            <Link to={`/appraisals/${r.id}`} className="block rounded-lg border border-line bg-surface p-4 hover:border-line-strong hover:bg-surface-2/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold">{c?.name ?? 'Appraisal'}</div>
                  <div className="text-[12.5px] text-ink-3">{c ? `${fmtDate(c.period_from)} – ${fmtDate(c.period_to)}` : ''}</div>
                </div>
                {r.final_rating !== null ? <Rating value={r.final_rating} /> : <StatusBadge size="sm" map={APPRAISAL_STATUS} value={r.status} />}
              </div>
              <p className={cn('mt-3 text-[13px]', r.status === 'self_pending' ? 'font-medium text-brand-text' : 'text-ink-2')}>
                {r.status === 'self_pending' ? `Write your self review${r.due_on ? ` by ${fmtDate(r.due_on)}` : ''}` : r.status === 'completed' ? `Completed${r.increment_pct !== null ? ` · increment ${r.increment_pct}%` : ''}` : `With ${r.status === 'manager_pending' ? r.manager_name ?? 'your manager' : 'HR'} for review`}
              </p>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function NewCycleDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = todayISO()
  const [f, setF] = useState({ name: '', period_from: t.slice(0, 8) + '01', period_to: addDays(addMonths(t.slice(0, 8) + '01', 6), -1), self_due: '', manager_due: '', hr_due: '' })
  const [w, setW] = useState({ goals: '35', tasks: '35', timesheets: '15', behaviour: '15' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const sum = Object.values(w).reduce((s, x) => s + (Number(x) || 0), 0)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  const save = useMut(() => hrApi.createCycle({ ...f, weights: { goals: Number(w.goals), tasks: Number(w.tasks), timesheets: Number(w.timesheets), behaviour: Number(w.behaviour) } }), {
    invalidate: [['appraisals']], success: 'Cycle created as a draft', silentError: true,
    onSuccess: (c) => { onCreated(c.id); onClose() },
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog open size="lg" onOpenChange={(o) => !o && onClose()} title="New appraisal cycle" description="It starts as a draft. Launch it when goals are in place." footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Create cycle</Button></>}>
      <div className="space-y-4">
        <Field label="Name" required error={errs.name}>
          <Input value={f.name} invalid={!!errs.name} onChange={set('name')} placeholder="H2 FY26-27" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Period from" required error={errs.period_from}><Input type="date" value={f.period_from} onChange={set('period_from')} /></Field>
          <Field label="Period to" required error={errs.period_to}><Input type="date" value={f.period_to} onChange={set('period_to')} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Self review due" required error={errs.self_due}><Input type="date" value={f.self_due} invalid={!!errs.self_due} onChange={set('self_due')} /></Field>
          <Field label="Manager review due" required error={errs.manager_due}><Input type="date" value={f.manager_due} invalid={!!errs.manager_due} onChange={set('manager_due')} /></Field>
          <Field label="HR review due" required error={errs.hr_due}><Input type="date" value={f.hr_due} invalid={!!errs.hr_due} onChange={set('hr_due')} /></Field>
        </div>
        <Field label="Weights" required error={errs.weights} hint="How the system score is built. Must total 100%." aside={<span className={cn('tnum text-[12.5px] font-semibold', sum === 100 ? 'text-success-text' : 'text-danger-text')}>{sum}%</span>}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(['goals', 'tasks', 'timesheets', 'behaviour'] as const).map((k) => (
              <label key={k} className="min-w-0">
                <span className="mb-1 block text-[12px] capitalize text-ink-3">{k}</span>
                <Input type="number" min={0} max={100} value={w[k]} onChange={(e) => setW((s) => ({ ...s, [k]: e.target.value }))} suffix="%" />
              </label>
            ))}
          </div>
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}
