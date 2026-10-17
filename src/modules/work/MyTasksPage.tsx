import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle2, ChevronDown, Send } from '@/ui/icons'
import { deliveryApi, type MyTaskV5 as MyTask } from '@/api/work'
import { useWeek } from '@/stores/ui'
import { STAGE } from '@/domain/delivery'
import { StageSelect, TagBadge } from './taskStage'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { useUI } from '@/stores/ui'
import { COMPLEXITY } from '@/domain/labels'
import { addDays, diffDays, fmtDate, todayISO, weekStart } from '@/domain/calendar'
import { fmtHours, fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, EmptyState, ErrorState, FilterChips, Menu, PageHeader, Progress, Select, SkeletonCards, SkeletonRows, StatCard, StatusBadge, toast, useReadOnly } from '@/ui'
import { useTaskInvalidate } from './TaskDrawerHost'
import { LateBadge, SubmitReviewDialog, type SubmittableTask } from './taskReview'
import { CreateTaskButton } from './TaskForm'
import { useSession } from '@/stores/session'

type Mine = { tasks: MyTask[]; covering: MyTask[]; hours_this_week?: number; backing?: number; week?: string }
type StageFilter = 'all' | 'not_started' | 'active' | 'waiting' | 'in_review'
const stageGroupOf = (t: MyTask): StageFilter => (t.status === 'in_review' ? 'in_review' : STAGE[t.stage].group === 'testing' ? 'active' : (STAGE[t.stage].group as StageFilter))
type Bucket = 'sent_back' | 'review' | 'covering' | 'blocked' | 'overdue' | 'today' | 'week' | 'later' | 'nodate'
const BUCKETS: { key: Exclude<Bucket, 'covering' | 'sent_back' | 'review'>; label: string }[] = [
  { key: 'blocked', label: 'Blocked' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'nodate', label: 'No due date' },
]
type Group = { key: Bucket; label: string; note?: string; items: MyTask[]; covering?: boolean }

const isSentBack = (t: MyTask) => !!t.sent_back && t.status !== 'in_review'
const canSubmitRow = (t: MyTask) => ['todo', 'in_progress', 'blocked'].includes(t.status) && !t.blocked_by.length
function bucketOf(t: MyTask, today: string): Bucket {
  if (t.status === 'in_review') return 'review'
  if (isSentBack(t)) return 'sent_back'
  if (t.status === 'blocked' || t.blocked_by.length) return 'blocked'
  if (!t.due_on) return 'nodate'
  if (t.due_on < today) return 'overdue'
  if (t.due_on === today) return 'today'
  if (t.due_on <= addDays(weekStart(today), 6)) return 'week'
  return 'later'
}

function useMinWidth(px: number) {
  const q = `(min-width: ${px}px)`
  const [m, setM] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches)
  useEffect(() => {
    const mq = window.matchMedia?.(q)
    if (!mq) return
    const h = () => setM(mq.matches)
    h()
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [q])
  return m
}

/** UI-12 — /my-tasks: the personal queue (v3 submit-for-review flow). The Tasks tab (/tasks) is the primary list;
 *  /tasks/:id is the task page. Old links (/my-tasks?task=id) still open the drawer. */
export default function MyTasksPage() {
  const myId = useSession((x) => x.user?.id)
  const [sp] = useSearchParams()
  const id = sp.get('task')
  const openTask = useUI((s) => s.openTask)
  useEffect(() => {
    if (id) openTask(id)
  }, [id, openTask])

  const week = useWeek()
  const q = useApi(['my-tasks', week], () => deliveryApi.myTasks(week) as Promise<Mine>)
  const [project, setProject] = useState('')
  const [status, setStatus] = useState<StageFilter>('all')
  const today = todayISO()
  const xl = useMinWidth(1280)
  const xxl = useMinWidth(1536)

  const all = q.data?.tasks ?? []
  const projects = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of [...all, ...(q.data?.covering ?? [])]) m.set(t.project_id, `${t.project_code} · ${t.project_name}`)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [all, q.data?.covering])
  const filt = (t: MyTask) => (!project || t.project_id === project) && (status === 'all' || stageGroupOf(t) === status)
  const list = all.filter(filt)
  const covering = (q.data?.covering ?? []).filter(filt)
  const sentBack = list.filter((t) => bucketOf(t, today) === 'sent_back')
  const inReview = list.filter((t) => t.status === 'in_review')
  const groups: Group[] = [
    ...(sentBack.length ? [{ key: 'sent_back' as const, label: 'Sent back', note: 'Your reviewer asked for changes. Fix them and resubmit.', items: sentBack }] : []),
    ...(covering.length ? [{ key: 'covering' as const, label: 'Covering', note: 'The owner is on leave (or delegated to you) on the days shown — you can log time on them and move these.', items: covering, covering: true }] : []),
    ...BUCKETS.map((b) => ({ ...b, items: list.filter((t) => bucketOf(t, today) === b.key).sort((a, c) => (a.due_on ?? '').localeCompare(c.due_on ?? '')) })).filter((g) => g.items.length),
    ...(inReview.length ? [{ key: 'review' as const, label: 'In review', note: 'Waiting for your reviewer to approve or send back.', items: inReview }] : []),
  ]
  const [submitFor, setSubmitFor] = useState<SubmittableTask | null>(null)

  const overdue = all.filter((t) => t.status !== 'blocked' && t.status !== 'in_review' && !t.blocked_by.length && t.due_on && t.due_on < today).length
  const blocked = all.filter((t) => t.status === 'blocked' || t.blocked_by.length).length
  const dueWeek = all.filter((t) => t.due_on >= today && t.due_on <= addDays(weekStart(today), 6)).length
  const statusCount = (s: StageFilter) => all.filter((t) => stageGroupOf(t) === s).length
  const inReviewAll = statusCount('in_review')
  const sentBackAll = all.filter(isSentBack).length

  return (
    <div>
      <PageHeader
        title="My tasks"
        subtitle="Your personal queue: everything you own, sorted by what needs you first. The Tasks tab lists every task with filters by person, project and status."
        actions={
          <>
            <Link to="/tasks">
              <Button size="sm">Open the Tasks tab</Button>
            </Link>
            <CreateTaskButton prefill={myId ? { owner_id: myId } : undefined} />
          </>
        }
      />
      {q.isLoading ? (
        <>
          <SkeletonCards n={4} />
          <SkeletonRows rows={6} className="mt-6" />
        </>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Overdue" value={overdue} tone={overdue ? 'danger' : undefined} />
            <StatCard label="Blocked" value={blocked} tone={blocked ? 'warning' : undefined} />
            <StatCard label="Due this week" value={dueWeek} />
            <StatCard label="In review" value={inReviewAll} hint="Submitted and waiting for your reviewer." />
            <StatCard label="Sent back" value={sentBackAll} tone={sentBackAll ? 'danger' : undefined} hint="Your reviewer asked for changes." />
            <StatCard label="Hours this week" value={fmtHours(q.data?.hours_this_week ?? 0)} />
          </div>

          <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <FilterChips
              value={status}
              onChange={setStatus}
              options={[
                { value: 'all', label: 'All', count: all.length },
                ...([['not_started', 'Not started'], ['active', 'In progress'], ['waiting', 'Waiting / blocked'], ['in_review', 'In review']] as [StageFilter, string][]).map(([value, label]) => ({ value, label, count: statusCount(value) })),
              ]}
            />
            {projects.length > 1 && (
              <Select className="md:w-[260px] md:shrink-0" value={project} onChange={(e) => setProject(e.target.value)} placeholder="All projects" options={projects.map(([value, label]) => ({ value, label }))} />
            )}
          </div>

          {!groups.length ? (
            <div className="mt-4 rounded-lg border border-line bg-surface">
              {all.length ? (
                <EmptyState compact title="No tasks match these filters" action={<Button size="sm" onClick={() => { setProject(''); setStatus('all') }}>Clear filters</Button>} />
              ) : (
                <EmptyState icon={<CheckCircle2 />} title="Nothing on your plate" body="When a project manager assigns you a task it shows up here, sorted by due date." />
              )}
            </div>
          ) : (
            <>
              {/* lg+: one grouped table */}
              <div className="mt-4 hidden overflow-hidden rounded-lg border border-line bg-surface lg:block">
                <table className="w-full table-fixed border-collapse text-[13.5px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-2/60 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                      <th className="h-9 pl-4 pr-3">Task</th>
                      <th className="hidden w-[220px] px-3 xl:table-cell">Project</th>
                      <th className="hidden w-[170px] px-3 2xl:table-cell">Milestone</th>
                      <th className="w-[204px] px-3">Stage</th>
                      <th className="w-[112px] px-3">Due</th>
                      <th className="w-[112px] px-3 text-right">Actual / est.</th>
                      <th className="w-[124px] pl-3 pr-4"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  {groups.map((g) => (
                    <tbody key={g.key}>
                      <tr className="border-b border-line bg-surface-2/35">
                        <td colSpan={5 + (xl ? 1 : 0) + (xxl ? 1 : 0)} className="px-4 py-2">
                          <span className="text-[13px] font-semibold text-ink">{g.label}</span>
                          <span className="tnum ml-2 text-[12.5px] text-ink-3">{g.items.length}</span>
                          {g.note && <span className="ml-3 text-[12.5px] text-ink-3">{g.note}</span>}
                        </td>
                      </tr>
                      {g.items.map((t) => <TaskTableRow key={t.id} t={t} covering={g.covering} onSubmit={setSubmitFor} />)}
                    </tbody>
                  ))}
                </table>
              </div>

              {/* below lg: grouped list */}
              <div className="lg:hidden">
                {groups.map((g) => (
                  <section key={g.key} className="mt-5">
                    <div className="mb-2 flex items-baseline gap-2 px-1">
                      <h2 className="text-[13.5px] font-semibold text-ink">{g.label}</h2>
                      <span className="tnum text-[12.5px] text-ink-3">{g.items.length}</span>
                    </div>
                    {g.note && <p className="-mt-1 mb-2 px-1 text-[12.5px] text-ink-3">{g.note}</p>}
                    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                      {g.items.map((t) => <TaskRow key={t.id} t={t} covering={g.covering} onSubmit={setSubmitFor} />)}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <SubmitReviewDialog open={!!submitFor} onOpenChange={(o) => !o && setSubmitFor(null)} task={submitFor} />
    </div>
  )
}

/** The 10-stage select (Completed routes through the review flow). */
function StatusControl({ t }: { t: MyTask; onSubmit?: (t: SubmittableTask) => void }) {
  return (
    <StageSelect
      size="sm"
      className="w-full max-w-[220px]"
      t={{ id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on, stage: t.stage, progress: t.progress, status: t.status, can_move: true, can_submit: t.can_submit, can_review: t.can_review, owner_id: t.owner_id, backup_id: t.backup_id, logged_hours: t.actual_hours }}
    />
  )
}

function dueText(t: MyTask, today: string) {
  if (!t.due_on) return { main: '—', sub: null as string | null, late: false }
  const late = t.due_on < today && t.status !== 'done' && t.status !== 'in_review'
  if (late) return { main: fmtDate(t.due_on), sub: `${diffDays(today, t.due_on)}d late`, late }
  return { main: t.due_on === today ? 'Today' : fmtDate(t.due_on), sub: null, late }
}

function SubmitButton({ t, onSubmit, block }: { t: MyTask; onSubmit: (t: SubmittableTask) => void; block?: boolean }) {
  const ro = useReadOnly()
  if (ro || !canSubmitRow(t)) return null
  return (
    <Button
      size="xs"
      variant={isSentBack(t) ? 'primary' : 'secondary'}
      icon={<Send className="size-3.5" />}
      className={cn('whitespace-nowrap', block && 'h-9')}
      onClick={(e) => {
        e.stopPropagation()
        onSubmit({ id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on })
      }}
    >
      {isSentBack(t) ? 'Resubmit' : 'Submit'}
    </Button>
  )
}

function SentBackNote({ t }: { t: MyTask }) {
  const people = usePeopleMap()
  if (!isSentBack(t) || !t.sent_back) return null
  return (
    <div className="mt-1 text-[12.5px] leading-snug text-danger-text">
      <span className="font-medium">{people.get(t.sent_back.by)?.name ?? 'Reviewer'}:</span> {t.sent_back.reason}
    </div>
  )
}

function TaskTableRow({ t, covering, onSubmit }: { t: MyTask; covering?: boolean; onSubmit: (t: SubmittableTask) => void }) {
  const openTask = useUI((s) => s.openTask)
  const people = usePeopleMap()
  const today = todayISO()
  const due = dueText(t, today)
  const ratio = t.est_hours ? t.actual_hours / t.est_hours : 0
  const waiting = t.blocked_by.map((b) => `${b.wbs} ${b.title} (${people.get(b.owner_id)?.name ?? 'unassigned'})`).join('; ')
  return (
    <tr onClick={() => openTask(t.id)} className="group cursor-pointer border-b border-line align-middle transition-colors last:border-0 hover:bg-surface-2/50">
      <td className="py-2.5 pl-4 pr-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tnum shrink-0 text-[12.5px] text-ink-3">{t.wbs}</span>
          <span className="truncate font-medium text-ink group-hover:text-brand-text" title={t.title}>{t.title}</span>
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
          <span className="xl:hidden">{t.project_code} · {t.project_name}{covering ? ' · ' : ''}</span>
          {covering && <span>Covering {people.get(t.owner_id)?.name ?? 'owner'}{t.covering_days?.length ? ` · ${t.covering_days.map((d) => fmtDate(d, 'day')).join(', ')}` : ''}</span>}
        </div>
        {waiting && <div className="truncate text-[12.5px] text-danger-text" title={waiting}>Waiting on {waiting}</div>}
        <SentBackNote t={t} />
      </td>
      <td className="hidden px-3 xl:table-cell">
        <div className="truncate" title={`${t.project_code} · ${t.project_name}`}>
          <span className="text-ink">{t.project_code}</span> <span className="text-ink-3">{t.project_name}</span>
        </div>
      </td>
      <td className="hidden truncate px-3 text-ink-2 2xl:table-cell">{t.milestone_label ?? <span className="text-ink-3">—</span>}</td>
      <td className="px-3" onClick={(e) => e.stopPropagation()}>
        <StatusControl t={t} onSubmit={onSubmit} />
      </td>
      <td className="whitespace-nowrap px-3">
        <div className={cn('tnum', due.late ? 'text-danger-text' : 'text-ink-2')}>{due.main}</div>
        {due.sub && <div className="tnum text-[12px] text-danger-text">{due.sub}</div>}
      </td>
      <td className="px-3 text-right">
        <div className="whitespace-nowrap">
          <span className={cn('tnum', ratio > 1.2 ? 'text-danger-text' : 'text-ink')}>{fmtNum(t.actual_hours, 1)}</span>
          <span className="tnum text-ink-3"> / {fmtNum(t.est_hours, 1)}h</span>
        </div>
        {t.est_hours > 0 && <Progress className="ml-auto mt-1 w-20" height={3} value={Math.min(1, ratio)} tone={ratio > 1.2 ? 'danger' : ratio > 1 ? 'warning' : 'brand'} />}
      </td>
      <td className="pl-3 pr-4 text-right">
        {t.status === 'in_review' ? <span className="whitespace-nowrap text-[12.5px] text-ink-3">Sent {fmtDate(t.submitted_on)}</span> : <SubmitButton t={t} onSubmit={onSubmit} />}
      </td>
    </tr>
  )
}

function TaskRow({ t, covering, onSubmit }: { t: MyTask; covering?: boolean; onSubmit: (t: SubmittableTask) => void }) {
  const openTask = useUI((s) => s.openTask)
  const people = usePeopleMap()
  const today = todayISO()
  const due = dueText(t, today)
  const ratio = t.est_hours ? t.actual_hours / t.est_hours : 0
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openTask(t.id)}
      onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && openTask(t.id)}
      className="cursor-pointer px-4 py-3 text-left outline-none transition hover:bg-surface-2/60 focus-visible:bg-surface-2 active:bg-surface-2"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="tnum shrink-0 text-[12.5px] text-ink-3">{t.wbs}</span>
        <span className="min-w-0 text-[14px] font-medium leading-snug text-ink">{t.title}</span>
      </div>
      <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
        {t.project_code} · {t.project_name}
        {t.milestone_label ? ` · ${t.milestone_label}` : ''}
        {covering ? ` · covering ${people.get(t.owner_id)?.name ?? 'owner'}${t.covering_days?.length ? ` (${t.covering_days.map((d) => fmtDate(d, 'day')).join(', ')})` : ''}` : ''}
      </div>
      {t.blocked_by.length > 0 && (
        <div className="mt-1 truncate text-[12.5px] text-danger-text">
          Waiting on {t.blocked_by.map((b) => `${b.wbs} ${b.title} (${people.get(b.owner_id)?.name ?? 'unassigned'})`).join('; ')}
        </div>
      )}
      <SentBackNote t={t} />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-ink-3">
        <span onClick={(e) => e.stopPropagation()}>
          <StatusControl t={t} onSubmit={onSubmit} />
        </span>
        <span className={cn('tnum whitespace-nowrap', due.late && 'text-danger-text')}>{t.due_on ? `Due ${due.main}${due.sub ? ` · ${due.sub}` : ''}` : 'No due date'}</span>
        <span className={cn('tnum whitespace-nowrap', ratio > 1.2 && 'text-danger-text')}>
          {fmtNum(t.actual_hours, 1)} / {fmtNum(t.est_hours, 1)}h
        </span>
        {(t.complexity === 'high' || t.complexity === 'very_high') && <Badge tone="neutral" size="sm">{COMPLEXITY[t.complexity].label} complexity</Badge>}
        <TagBadge tag={t.tag} />
        <span className="tnum whitespace-nowrap">{t.progress}% done</span>
        {t.status === 'in_review' && t.submitted_on && <span className="tnum whitespace-nowrap">Submitted {fmtDate(t.submitted_on)}</span>}
      </div>
      {canSubmitRow(t) && (
        <div className="mt-2.5">
          <SubmitButton t={t} onSubmit={onSubmit} block />
        </div>
      )}
    </div>
  )
}
