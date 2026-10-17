// /team-tasks — line managers assign work, review what their team submits, and track on-time delivery.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, CornerDownLeft, ExternalLink, Inbox, Plus, Users } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import type { ApiError } from '@/api/http'
import { taskflowApi, type AssignBody, type Priority, type ReviewQueueRow, type TaskAnalyticsRow, type TeamTaskRow } from '@/api/tasks'
import { usePeopleMap } from '@/api/core'
import { useUI } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { COMPLEXITY, COMPLEXITY_ORDER, TASK_STAGE_ORDER, TASK_STATUS, TASK_TAG_LABEL } from '@/domain/labels'
import type { Complexity, TaskTag } from '@/types/entities'
import type { TeamTaskRowV5 } from '@/api/work'
import { EstimateHintLine, StageBadge, StageSelect, type StageTask } from './taskStage'
import { addDays, fmtDate, parseISO, periodRange, relTime, todayISO } from '@/domain/calendar'
import { fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import {
  Avatar, Badge, Button, Callout, Card, CardHeader, DataTable, EmptyState, ErrorState, Field, FilterChips, Input, PageHeader, PeoplePicker, PeriodSwitch, PersonName,
  Segmented, Select, SkeletonRows, StatCard, StatusBadge, Tabs, Textarea, useCan, usePeriod, useReadOnly, type Column,
} from '@/ui'
import { ApproveForm, LateBadge, PRIORITY, RatingText, ReviewDialog, SendBackForm, TimelinessBadge, delayLabel } from './taskReview'
import { TimelinessSplit, fmtSlip, pctTone, slipTone } from './taskDelivery'
import { useTaskInvalidate } from './TaskDrawerHost'
import { TaskForm } from './TaskForm'

/** n weekdays after a date (default due date for a new task; the server warns on holidays). */
function addWorkingDaysSimple(from: string, n: number) {
  let d = from
  while (n > 0) {
    d = addDays(d, 1)
    const w = parseISO(d).getDay()
    if (w !== 0 && w !== 6) n--
  }
  return d
}

type Tab = 'review' | 'assign' | 'team' | 'performance'
const TABS: Tab[] = ['review', 'assign', 'team', 'performance']

export default function TeamTasksPage() {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get('tab') as Tab | null
  const tab: Tab = raw && TABS.includes(raw) ? raw : 'review'
  const setTab = (t: Tab) => setSp((p) => {
    const n = new URLSearchParams(p)
    n.set('tab', t)
    return n
  }, { replace: true })
  const ro = useReadOnly()
  const can = useCan()
  // Company-wide oversight mirrors the server (people.view_all); company analytics also needs tasks.analytics.
  const wide = can('people.view_all')
  const wideAnalytics = wide && can('tasks.analytics')
  const [all, setAll] = useState(false)
  const queue = useApi(['team-tasks', 'queue', all], () => taskflowApi.reviewQueue(all), { refetchInterval: 60_000 })
  const team = useApi(['team-tasks', 'list'], () => taskflowApi.teamTasks())
  const overdue = (team.data ?? []).filter((t) => t.overdue_days > 0).length

  return (
    <div>
      <PageHeader
        title="Team tasks"
        subtitle="Assign work to your team, review what they submit and track delivery against due dates."
        actions={
          tab !== 'assign' && !ro ? (
            <Button variant={tab === 'review' ? 'secondary' : 'primary'} icon={<Plus className="size-4" />} onClick={() => setTab('assign')}>
              Assign task
            </Button>
          ) : undefined
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'review', label: 'Review queue', count: queue.data?.length },
          { value: 'assign', label: 'Assign' },
          { value: 'team', label: 'Team tasks', count: overdue || undefined },
          { value: 'performance', label: 'Performance' },
        ]}
      />
      {tab === 'review' && <ReviewQueue q={queue} wide={wide} all={all} setAll={setAll} />}
      {tab === 'assign' && <AssignTab onAssigned={() => setTab('team')} />}
      {tab === 'team' && <TeamList q={team} />}
      {tab === 'performance' && <Performance wide={wideAnalytics} />}
    </div>
  )
}

/* ================================================================== */
/* Review queue                                                        */
/* ================================================================== */
function ReviewQueue({ q, wide, all, setAll }: { q: { data?: ReviewQueueRow[]; isLoading: boolean; error: unknown; refetch: () => unknown }; wide: boolean; all: boolean; setAll: (v: boolean) => void }) {
  const rows = q.data ?? []
  const late = rows.filter((r) => r.late_at_submission > 0).length
  const resub = rows.filter((r) => r.latest?.round > 1).length
  const oldest = rows.reduce<string | null>((m, r) => (r.submitted_on && (!m || r.submitted_on < m) ? r.submitted_on : m), null)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Waiting for review" value={rows.length} />
        <StatCard label="Submitted late" value={late} tone={late ? 'danger' : undefined} hint="Submitted after the due date — the owner gave a delay reason." />
        <StatCard label="Resubmissions" value={resub} hint="Sent back earlier and submitted again." />
        <StatCard label="Oldest waiting" value={oldest ? relTime(`${oldest}T09:00:00`) : '—'} sub={oldest ? `since ${fmtDate(oldest)}` : undefined} />
      </div>
      {wide && (
        <div className="flex items-center justify-between gap-3">
          <Segmented size="sm" value={all ? 'all' : 'mine'} onChange={(v) => setAll(v === 'all')} options={[{ value: 'mine', label: 'Waiting for me' }, { value: 'all', label: 'All reviewers' }]} />
        </div>
      )}
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon={<CheckCircle2 />} title="Nothing waiting for your review" body="When someone submits a task you review, it shows here with their note, proof and any delay reason." />
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <ReviewCard key={r.id} r={r} />
          ))}
        </ul>
      )}
    </div>
  )
}

function ReviewCard({ r }: { r: ReviewQueueRow }) {
  const openTask = useUI((s) => s.openTask)
  const ro = useReadOnly()
  const people = usePeopleMap()
  const [mode, setMode] = useState<'approve' | 'send_back'>('approve')
  const [dlg, setDlg] = useState<null | 'approve' | 'send_back'>(null)
  const owner = people.get(r.owner_id)
  const rv = r.latest
  const canAct = r.can_review && !ro
  return (
    <li className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className={cn('grid', canAct && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
        <div className="min-w-0 p-4 md:p-5">
          <div className="flex min-w-0 items-start gap-3">
            <Avatar name={owner?.name ?? '?'} hue={owner?.avatar_hue ?? 150} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-ink-3">
                <span className="font-medium text-ink-2">{owner?.name ?? 'Unassigned'}</span>
                <span>submitted {relTime(rv?.submitted_at)}</span>
                {rv && rv.round > 1 && <Badge size="sm" tone="info">Round {rv.round}</Badge>}
              </div>
              <button type="button" onClick={() => openTask(r.id)} className="mt-0.5 block max-w-full text-left text-[15px] font-semibold leading-snug text-ink hover:text-brand-text">
                <span className="tnum mr-1.5 text-[13px] font-normal text-ink-3">{r.wbs}</span>
                {r.title}
              </button>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
                <span className="min-w-0 truncate">{r.project_code} · {r.project_name}</span>
                <span className="tnum whitespace-nowrap">Due {fmtDate(r.due_on)}</span>
                <span className="tnum whitespace-nowrap">Submitted {fmtDate(r.submitted_on)}</span>
                {r.late_at_submission > 0 ? <LateBadge days={r.late_at_submission} /> : <Badge size="sm" tone="success">On time</Badge>}
                {r.priority !== 'normal' && <Badge size="sm" tone={PRIORITY[r.priority].tone}>{PRIORITY[r.priority].label}</Badge>}
              </div>
            </div>
          </div>
          {rv?.submission_note && <p className="mt-3 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">{rv.submission_note}</p>}
          {r.late_at_submission > 0 && (rv?.delay_reason_code || r.delay_reason_code) && (
            <div className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-[13px] text-warning-text">
              <span className="font-medium">Delay — {delayLabel(rv?.delay_reason_code ?? r.delay_reason_code)}:</span> {rv?.delay_reason ?? r.delay_reason}
            </div>
          )}
          {r.sent_back_count > 0 && r.last_sent_back_reason && (
            <p className="mt-2 text-[12.5px] text-ink-3">
              <span className="font-medium text-ink-2">Last sent back:</span> {r.last_sent_back_reason}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
            {rv?.proof_url && (
              <a href={rv.proof_url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[13px] font-medium text-brand-text hover:underline">
                <ExternalLink className="size-3.5 shrink-0" />
                <span className="truncate">Open proof</span>
              </a>
            )}
            <button type="button" onClick={() => openTask(r.id)} className="text-[13px] font-medium text-ink-3 hover:text-ink">
              Task details & history
            </button>
            {!r.can_review && <span className="text-[12.5px] text-ink-3">Reviewer: {people.get(r.reviewer_id)?.name ?? '—'}</span>}
          </div>
          {canAct && (
            <div className="mt-4 grid grid-cols-2 gap-2 lg:hidden">
              <Button variant="secondary" icon={<CornerDownLeft className="size-4" />} onClick={() => setDlg('send_back')}>
                Send back
              </Button>
              <Button variant="primary" onClick={() => setDlg('approve')}>
                Approve
              </Button>
            </div>
          )}
        </div>
        {canAct && (
          <div className="hidden border-l border-line bg-surface-2/40 p-4 lg:block">
            <Segmented block size="sm" value={mode} onChange={setMode} options={[{ value: 'approve', label: 'Approve' }, { value: 'send_back', label: 'Send back' }]} className="mb-3" />
            {mode === 'approve' ? <ApproveForm key={`a${r.id}`} taskId={r.id} compact /> : <SendBackForm key={`s${r.id}`} taskId={r.id} dueOn={r.due_on} compact />}
          </div>
        )}
      </div>
      <ReviewDialog mode={dlg ?? 'approve'} open={!!dlg} onOpenChange={(o) => !o && setDlg(null)} task={{ id: r.id, title: r.title, wbs: r.wbs, due_on: r.due_on }} />
    </li>
  )
}

/* ================================================================== */
/* Assign                                                              */
/* ================================================================== */
function AssignTab({ onAssigned }: { onAssigned: () => void }) {
  // v7: the shared professional Create task form, with the chosen owner's workload alongside.
  const opts = useApi(['team-tasks', 'options'], () => taskflowApi.options(), { staleTime: 30_000 })
  const team = useApi(['team-tasks', 'list'], () => taskflowApi.teamTasks())
  const people = usePeopleMap()
  const [ownerId, setOwnerId] = useState<string | null>(null)
  const [formKey, setFormKey] = useState(0)
  const onOwner = useCallback((id: string | null) => setOwnerId(id), [])
  const o = opts.data
  const ownerOpen = (team.data ?? []).filter((t) => t.owner_id === ownerId && t.status !== 'done')
  const ownerDone = (team.data ?? []).filter((t) => t.owner_id === ownerId && t.status === 'done')
  const ownerLate = ownerDone.filter((t) => t.timeliness === 'late').length

  if (opts.isLoading) return <SkeletonRows rows={6} />
  if (opts.error || !o) return <ErrorState error={opts.error} onRetry={() => opts.refetch()} />
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Card className="min-w-0 lg:col-span-8">
        <CardHeader title="New task" subtitle="The owner, reviewer, concerned manager and watchers are notified. The owner submits it for review when done; the reviewer approves it with a quality rating." />
        <TaskForm
          key={formKey}
          variant="inline"
          onOwnerChange={onOwner}
          onCreated={(t, open) => {
            setFormKey((k) => k + 1)
            if (open) useUI.getState().openTask(t.id)
            onAssigned()
          }}
        />
      </Card>
      <Card className="lg:col-span-4 lg:self-start">
        <CardHeader title={ownerId ? `${people.get(ownerId)?.name ?? 'Owner'}’s workload` : 'Workload'} subtitle={ownerId ? 'Open tasks you can see' : 'Choose a person to see what they already have.'} />
        {ownerId ? (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[12px] text-ink-3">Open</div>
                <div className="tnum text-[18px] font-semibold">{ownerOpen.length}</div>
              </div>
              <div>
                <div className="text-[12px] text-ink-3">Past due</div>
                <div className={cn('tnum text-[18px] font-semibold', ownerOpen.some((t) => t.overdue_days) && 'text-danger-text')}>{ownerOpen.filter((t) => t.overdue_days > 0).length}</div>
              </div>
              <div>
                <div className="text-[12px] text-ink-3">Late (120d)</div>
                <div className="tnum text-[18px] font-semibold">{ownerLate}/{ownerDone.length}</div>
              </div>
            </div>
            <ul className="mt-3 divide-y divide-line border-t border-line">
              {ownerOpen.slice(0, 8).map((t) => (
                <li key={t.id} className="flex min-w-0 items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink" title={t.title}>{t.title}</span>
                  <span className={cn('tnum shrink-0 whitespace-nowrap text-[12px]', t.overdue_days ? 'text-danger-text' : 'text-ink-3')}>{fmtDate(t.due_on)}</span>
                </li>
              ))}
              {!ownerOpen.length && <li className="py-3 text-[13px] text-ink-3">Nothing open right now.</li>}
            </ul>
          </>
        ) : (
          <p className="text-[13px] text-ink-3">{o.team_ids.length} {o.team_ids.length === 1 ? 'person reports' : 'people report'} to you{o.projects.some((p) => p.anyone && !p.general) ? '; on projects you manage you can assign anyone.' : '.'} You can always create a task for yourself.</p>
        )}
      </Card>
    </div>
  )
}

/* ================================================================== */
/* Team tasks list                                                     */
/* ================================================================== */
type StatusFilter = 'open' | 'overdue' | 'in_review' | 'done' | 'all'
type V5Row = TeamTaskRow & TeamTaskRowV5
const STAGE_RANK = Object.fromEntries(TASK_STAGE_ORDER.map((s, i) => [s, i])) as Record<string, number>
const stageTask = (r0: TeamTaskRow): StageTask => {
  const r = r0 as V5Row
  return { id: r.id, title: r.title, wbs: r.wbs, due_on: r.due_on, start_on: r.start_on, stage: r.stage, progress: r.progress, status: r.status, version: r.version, can_move: r.can_move, can_submit: r.can_submit, can_review: r.can_review, owner_id: r.owner_id, backup_id: r.backup_id }
}

function TeamList({ q }: { q: { data?: TeamTaskRow[]; isLoading: boolean; error: unknown; refetch: () => unknown } }) {
  const openTask = useUI((s) => s.openTask)
  const people = usePeopleMap()
  const [person, setPerson] = useState('')
  const [status, setStatus] = useState<StatusFilter>('open')
  const [tl, setTl] = useState('')
  const rows = q.data ?? []
  const owners = useMemo(() => [...new Set(rows.map((r) => r.owner_id).filter(Boolean) as string[])].map((id) => ({ value: id, label: people.get(id)?.name ?? '—' })).sort((a, b) => a.label.localeCompare(b.label)), [rows, people])
  const byStatus = (r: TeamTaskRow, s: StatusFilter) =>
    s === 'all' ? true : s === 'open' ? r.status !== 'done' : s === 'overdue' ? r.overdue_days > 0 : r.status === s
  const base = rows.filter((r) => (!person || r.owner_id === person) && (!tl || r.timeliness === tl))
  const list = base
    .filter((r) => byStatus(r, status))
    .sort((a, b) => b.overdue_days - a.overdue_days || (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || a.due_on.localeCompare(b.due_on))
  const cols: Column<TeamTaskRow>[] = [
    {
      key: 'task', header: 'Task', sortValue: (r) => r.title,
      cell: (r) => (
        <div className="min-w-0 max-w-[420px]">
          <div className="truncate font-medium text-ink" title={r.title}><span className="tnum mr-1.5 font-normal text-ink-3">{r.wbs}</span>{r.title}</div>
          <div className="truncate text-[12.5px] text-ink-3">{r.general ? 'General & admin' : `${r.project_code} · ${r.project_name}`}{r.reschedule_count ? ` · rescheduled ${r.reschedule_count}×` : ''}</div>
        </div>
      ),
    },
    { key: 'owner', header: 'Owner', sortValue: (r) => people.get(r.owner_id)?.name ?? '', cell: (r) => <PersonName id={r.owner_id} size={22} /> },
    { key: 'status', header: 'Stage', sortValue: (r) => STAGE_RANK[(r as V5Row).stage] ?? 0, cell: (r) => <div className="w-[200px]" onClick={(e) => e.stopPropagation()}><StageSelect size="sm" t={stageTask(r)} /></div> },
    { key: 'progress', header: 'Done', align: 'right', hideBelow: 'lg', sortValue: (r) => (r as V5Row).progress, cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{(r as V5Row).progress}%</span> },
    {
      key: 'due', header: 'Due', sortValue: (r) => r.due_on,
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className={cn('tnum', r.overdue_days ? 'text-danger-text' : 'text-ink-2')}>{fmtDate(r.due_on)}</div>
          {r.overdue_days > 0 && <div className="tnum text-[12px] text-danger-text">{r.overdue_days}d overdue</div>}
        </div>
      ),
    },
    {
      key: 'outcome', header: 'Outcome', sortValue: (r) => r.variance_days ?? -99,
      cell: (r) => (r.status === 'done' ? (
        <div className="flex flex-col items-start gap-0.5">
          <TimelinessBadge timeliness={r.timeliness} variance={r.variance_days} />
          <RatingText value={r.quality_rating} className="text-[12px] text-ink-3" />
        </div>
      ) : r.sent_back_count ? <span className="whitespace-nowrap text-[12.5px] text-ink-3">Sent back {r.sent_back_count}×</span> : <span className="text-ink-3">—</span>),
    },
    { key: 'reviewer', header: 'Reviewer', hideBelow: 'xl', sortValue: (r) => people.get(r.reviewer_id)?.name ?? '', cell: (r) => <span className="truncate text-[13px] text-ink-2">{people.get(r.reviewer_id)?.name ?? '—'}</span> },
  ]
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <FilterChips
          value={status}
          onChange={setStatus}
          options={(['open', 'overdue', 'in_review', 'done', 'all'] as StatusFilter[]).map((s) => ({ value: s, label: s === 'open' ? 'Open' : s === 'overdue' ? 'Overdue' : s === 'in_review' ? 'In review' : s === 'done' ? 'Done' : 'All', count: base.filter((r) => byStatus(r, s)).length }))}
        />
        <div className="grid grid-cols-2 gap-2 lg:flex lg:shrink-0">
          <Select className="lg:w-[200px]" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Everyone" options={[{ value: '', label: 'Everyone' }, ...owners]} />
          <Select className="lg:w-[170px]" value={tl} onChange={(e) => setTl(e.target.value)} options={[{ value: '', label: 'Any timeliness' }, { value: 'early', label: 'Early' }, { value: 'on_time', label: 'On time' }, { value: 'late', label: 'Late' }]} />
        </div>
      </div>
      <DataTable
        rows={list}
        columns={cols}
        rowKey={(r) => r.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        onRowClick={(r) => openTask(r.id)}
        empty={<EmptyState compact icon={<Inbox />} title="No tasks match" body="Change the filters, or assign a task to someone in your team." />}
        mobileCard={(r) => (
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-[14px] font-medium leading-snug text-ink">{r.title}</div>
              <StageBadge stage={(r as V5Row).stage} progress={(r as V5Row).progress} />
            </div>
            <div className="mt-2" onClick={(e) => e.stopPropagation()}>
              <StageSelect size="sm" t={stageTask(r)} />
            </div>
            <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{people.get(r.owner_id)?.name ?? 'Unassigned'} · {r.general ? 'General & admin' : r.project_code}</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
              <span className={cn('tnum whitespace-nowrap', r.overdue_days && 'text-danger-text')}>Due {fmtDate(r.due_on)}{r.overdue_days ? ` · ${r.overdue_days}d overdue` : ''}</span>
              {r.status === 'done' && <TimelinessBadge timeliness={r.timeliness} variance={r.variance_days} />}
              {r.status === 'done' && <RatingText value={r.quality_rating} />}
              {r.sent_back_count > 0 && r.status !== 'done' && <span>Sent back {r.sent_back_count}×</span>}
            </div>
          </div>
        )}
      />
    </div>
  )
}

/* ================================================================== */
/* Performance                                                         */
/* ================================================================== */
function Performance({ wide }: { wide: boolean }) {
  const [period, setPeriod] = usePeriod('fy')
  const fy = useSession((s) => s.tenant?.settings['company.fy_start_month']) ?? 4
  const [group, setGroup] = useState<'person' | 'project'>('person')
  const r = periodRange(period.kind, period.anchor, fy)
  const scope = wide ? 'company' : 'team'
  const q = useApi(['task-analytics', 'perf', scope, group, r.from, r.to], () => taskflowApi.analytics({ from: r.from, to: r.to, scope, group }))
  const d = q.data
  const s = d?.total
  const cols: Column<TaskAnalyticsRow>[] = [
    {
      key: 'label', header: group === 'person' ? 'Person' : 'Project', sortValue: (x) => x.label,
      cell: (x) => {
        const reasons = x.top_reasons.map((t) => `${t.label} (${t.count})`).join(', ')
        return (
          <div className="min-w-0 max-w-[280px]">
            {x.user_id ? (
              <Link to={`/performance/${x.user_id}`} onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0 max-w-full hover:underline">
                <PersonName id={x.user_id} size={22} />
              </Link>
            ) : (
              <span className="block truncate font-medium text-ink" title={x.label}>{x.label}</span>
            )}
            {reasons && <div className="mt-0.5 truncate text-[12px] text-ink-3" title={`Delay reasons: ${reasons}`}>Delays: {reasons}</div>}
          </div>
        )
      },
    },
    { key: 'assigned', header: 'Assigned', align: 'right', sortValue: (x) => x.stats.assigned, cell: (x) => <span className="tnum">{x.stats.assigned}</span> },
    { key: 'completed', header: 'Done', align: 'right', sortValue: (x) => x.stats.completed, cell: (x) => <span className="tnum">{x.stats.completed}</span> },
    {
      key: 'split', header: 'Early · on time · late', hideBelow: 'xl', sortValue: (x) => x.stats.late,
      cell: (x) => (
        <div className="w-[120px]">
          <TimelinessSplit s={x.stats} legend={false} />
          <div className="tnum mt-1 text-[12px] text-ink-3"><span className="text-success-text">{x.stats.early}</span> · <span className="text-info-text">{x.stats.on_time}</span> · <span className="text-danger-text">{x.stats.late}</span></div>
        </div>
      ),
    },
    { key: 'pct', header: 'On time', align: 'right', sortValue: (x) => x.stats.on_time_pct ?? -1, cell: (x) => <span className={cn('tnum font-medium', pctTone(x.stats.on_time_pct))}>{fmtPct(x.stats.on_time_pct, 0)}</span> },
    { key: 'slip', header: 'Avg slip', align: 'right', sortValue: (x) => x.stats.avg_variance_days ?? -99, cell: (x) => <span className={cn('tnum', slipTone(x.stats.avg_variance_days))}>{fmtSlip(x.stats.avg_variance_days)}</span> },
    { key: 'fp', header: 'First pass', align: 'right', hideBelow: 'md', sortValue: (x) => x.stats.first_pass_pct ?? -1, cell: (x) => <span className="tnum">{fmtPct(x.stats.first_pass_pct, 0)}</span> },
    { key: 'q', header: 'Quality', align: 'right', hideBelow: 'md', sortValue: (x) => x.stats.avg_quality ?? -1, cell: (x) => <span className="tnum">{x.stats.avg_quality ? `${fmtNum(x.stats.avg_quality, 1)}/5` : '—'}</span> },
    { key: 'open', header: 'Overdue', align: 'right', hideBelow: 'lg', sortValue: (x) => x.stats.overdue_open, cell: (x) => <span className={cn('tnum', x.stats.overdue_open && 'text-danger-text')}>{x.stats.overdue_open}</span> },
  ]
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <PeriodSwitch value={period} onChange={setPeriod} fyStartMonth={fy} />
        <Segmented size="sm" value={group} onChange={setGroup} options={[{ value: 'person', label: 'By person' }, { value: 'project', label: 'By project' }]} />
      </div>
      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.error || !d || !s ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Completed" value={s.completed} sub={`of ${s.assigned} due or done`} />
            <StatCard label="On time" value={fmtPct(s.on_time_pct, 0)} tone={s.on_time_pct === null ? undefined : s.on_time_pct >= 0.85 ? 'success' : s.on_time_pct >= 0.7 ? 'warning' : 'danger'} sub="Early + on time" />
            <StatCard label="Avg slip" value={fmtSlip(s.avg_variance_days)} sub="Working days vs due" hint="Average of (finished − due) in working days. Negative means early." />
            <StatCard label="First-pass approval" value={fmtPct(s.first_pass_pct, 0)} sub={`${s.sent_back} sent back`} />
            <StatCard label="Avg quality" value={s.avg_quality ? `${fmtNum(s.avg_quality, 1)}/5` : '—'} sub="Reviewer rating" />
            <StatCard label="Overdue open" value={s.overdue_open} tone={s.overdue_open ? 'danger' : undefined} sub={`${s.in_review} in review`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-12">
            <Card className="xl:col-span-8">
              <CardHeader title="Completion vs due date" subtitle={`${r.label} · ${d.scope === 'company' ? 'whole company' : 'your team'}`} />
              <TimelinessSplit s={s} />
            </Card>
            <Card className="xl:col-span-4">
              <CardHeader title="Delay reasons" subtitle="Given by owners when submitting late" />
              {d.delay_reasons.length ? (
                <ul className="space-y-2">
                  {d.delay_reasons.slice(0, 6).map((x) => (
                    <li key={x.code}>
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="min-w-0 truncate">{x.label}</span>
                        <span className="tnum shrink-0 text-ink-3">{x.count}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
                        <span className="block h-full rounded-full bg-brand" style={{ width: `${(x.count / d.delay_reasons[0].count) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-ink-3">No delays reported in this period.</p>
              )}
            </Card>
          </div>
          <DataTable
            rows={d.rows}
            columns={cols}
            rowKey={(x) => x.key}
            initialSort={{ key: 'assigned', dir: 'desc' }}
            empty={<EmptyState compact title="No tasks due or completed in this period" body="Pick a longer period." />}
            mobileCard={(x) => (
              <div className="min-w-0">
                <div className="flex items-center justify-between gap-2">
                  {x.user_id ? (
                    <Link to={`/performance/${x.user_id}`} className="min-w-0"><PersonName id={x.user_id} size={22} /></Link>
                  ) : (
                    <span className="min-w-0 truncate font-medium">{x.label}</span>
                  )}
                  <span className={cn('tnum shrink-0 font-semibold', pctTone(x.stats.on_time_pct))}>{fmtPct(x.stats.on_time_pct, 0)}</span>
                </div>
                <TimelinessSplit s={x.stats} legend={false} className="mt-2" />
                <div className="tnum mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-ink-3">
                  <span>{x.stats.completed}/{x.stats.assigned} done</span>
                  <span>Early {x.stats.early} · on time {x.stats.on_time} · late {x.stats.late}</span>
                  <span>Slip {fmtSlip(x.stats.avg_variance_days)}</span>
                  <span>First pass {fmtPct(x.stats.first_pass_pct, 0)}</span>
                  {x.stats.avg_quality ? <span>Quality {fmtNum(x.stats.avg_quality, 1)}/5</span> : null}
                </div>
              </div>
            )}
          />
        </>
      )}
    </div>
  )
}

