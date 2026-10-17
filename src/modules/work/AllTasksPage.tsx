// Feature Guide §7 — "The Tasks tab lists every task with filters by person, project and status."
// For everyone; the server scopes the list (v7, CEO point 5): people with tasks.view_all (managers, HR, admins, CXOs)
// see every task and can filter by employee and department or group by employee; everyone else sees only tasks they
// own, cover, back up, review, are the concerned manager of, assigned, watch or were tagged on — each row says why.
// Filters: Person (owner), Project, Status (+ detailed stage), search, and quick chips Mine / Covering / Tagged me /
// Overdue / Blocked. Desktop table (optional columns), phone cards, CSV export, Create task.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { CalendarClock, Columns3, Download, ListChecks, MessageSquare, Users } from '@/ui/icons'
import { PRIORITY_P, TASK_RELATION, tasksTabApi, type AllTaskRow, type AllTasksQuery, type TaskChip, type TaskDepLink, type TaskEmployeeGroup } from '@/api/work'
import { useApi } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { COMPLEXITY, TASK_STAGE, TASK_STAGE_ORDER, TASK_STATUS } from '@/domain/labels'
import { STAGE } from '@/domain/delivery'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { useUI, useWeek } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { storage } from '@/lib/storage'
import { cn, saveFile, toCSV } from '@/lib/utils'
import type { TaskStatus } from '@/types/entities'
import { Badge, Button, Card, Checkbox, DataTable, EmptyState, FilterChips, PageHeader, PersonName, Popover, Progress, SearchInput, Segmented, Select, StatusBadge, toast, type Column } from '@/ui'
import { CreateTaskButton } from './TaskForm'
import { StageSelect, TagBadge, type StageTask } from './taskStage'
import { weekdays } from './TaskDrawerHost'

const KEY = 'seereonos.tasks.filters.v6'
const COLS_KEY = 'seereonos.tasks.columns.v7'
type Filters = { person?: string; project?: string; status?: string; stage?: string; chip?: TaskChip; department?: string; label?: string; group?: 'employee' | '' }
/** v7 optional columns (the guide's columns always show). */
const EXTRA_COLS = [
  { key: 'reviewer', label: 'Reviewer' },
  { key: 'cm', label: 'Concerned manager' },
  { key: 'priority', label: 'Priority' },
  { key: 'labels', label: 'Labels' },
  { key: 'dod', label: 'Definition of done' },
  { key: 'billable', label: 'Billable' },
] as const
type ExtraCol = (typeof EXTRA_COLS)[number]['key']
const initialCols = (): ExtraCol[] => {
  try {
    return storage.get<ExtraCol[]>(COLS_KEY, ['reviewer', 'priority']) ?? ['reviewer', 'priority']
  } catch {
    return ['reviewer', 'priority']
  }
}
const initial = (): Filters => {
  try {
    return storage.get<Filters>(KEY, {}) ?? {}
  } catch {
    return {}
  }
}
const SUMMARY: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done']

const toStage = (r: AllTaskRow): StageTask => ({
  id: r.id, title: r.title, wbs: r.wbs, due_on: r.due_on, start_on: r.start_on, stage: r.stage, progress: r.progress, status: r.status, version: r.version,
  can_move: r.can_move, can_submit: r.can_submit, can_review: r.can_review, can_edit: r.can_edit, owner_id: r.owner_id, backup_id: r.backup_id, logged_hours: r.logged_hours,
})

export default function AllTasksPage() {
  const openTask = useUI((s) => s.openTask)
  const navigate = useNavigate()
  const people = usePeopleMap()
  const me = useSession((s) => s.user)
  const week = useWeek()
  // Deep links from dashboards (e.g. /tasks?chip=overdue) pre-set the matching filters; otherwise the saved ones apply.
  const [sp] = useSearchParams()
  const [f, setF] = useState<Filters>(() => {
    const url: Filters = {}
    for (const k of ['person', 'project', 'status', 'stage', 'chip', 'department', 'label'] as const) {
      const v = sp.get(k)
      if (v) (url as Record<string, string>)[k] = v
    }
    return Object.keys(url).length ? { ...initial(), ...url } : initial()
  })
  const [extra, setExtra] = useState<ExtraCol[]>(initialCols)
  useEffect(() => {
    try {
      storage.set(COLS_KEY, extra)
    } catch {
      /* per-viewer convenience only */
    }
  }, [extra])
  const [qText, setQText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const h = setTimeout(() => setQ(qText.trim()), 250)
    return () => clearTimeout(h)
  }, [qText])
  useEffect(() => {
    try {
      storage.set(KEY, f)
    } catch {
      /* per-viewer convenience only */
    }
  }, [f])
  const query = useMemo(() => Object.fromEntries(Object.entries({ ...f, q, week }).filter(([, v]) => v)) as AllTasksQuery, [f, q, week])
  const res = useApi(['tasks', 'tab', query], () => tasksTabApi.list(query), { placeholderData: (prev) => prev })
  const d = res.data
  const rows = d?.items ?? []
  const today = todayISO()
  const set = (patch: Filters) => setF((x) => ({ ...x, ...patch }))
  const status = d?.status ?? f.status ?? 'open'
  const person = d?.person ?? 'all'
  const chip = (f.chip ?? '') as TaskChip
  const personChip = chip === 'mine' || chip === 'covering' || chip === 'tagged'
  const name = (id: string | null | undefined) => people.get(id)?.name ?? 'Unassigned'
  const first = (id: string | null | undefined) => name(id).split(' ')[0]

  const stagesFor = (s: string) => TASK_STAGE_ORDER.filter((k) => (s === 'open' ? k !== 'completed' : s === 'all' || s === 'in_review' ? true : STAGE[k].status === s))
  const sc = d?.status_counts ?? {}
  const openCount = SUMMARY.filter((s) => s !== 'done').reduce((a, s) => a + (sc[s] ?? 0), 0)
  const allCount = SUMMARY.reduce((a, s) => a + (sc[s] ?? 0), 0)
  const reset = () => {
    setQText('')
    setF({})
  }
  const dirty = !!(f.person || f.project || f.status || f.stage || f.chip || f.department || f.label || q)
  const viewAll = !!d?.view_all
  const grouped = viewAll && f.group === 'employee'

  const exportCsv = async () => {
    const head = ['WBS', 'Task', 'Tag', 'Project', 'Milestone', 'Owner', 'Backup', 'Estimated h', 'Actual h', 'Start', 'Due', 'Complexity', 'Status', 'Stage', 'Progress %', 'Depends on', 'Blocked by', 'Comments', 'Reviewer', 'Concerned manager', 'Priority', 'Labels', 'Billable', 'Definition of done', 'Department']
    const body = rows.map((r) => [
      r.wbs, r.title, r.tag ?? '', r.general ? 'General & admin' : `${r.project_code} ${r.project_name}`, r.milestone_label ?? '', name(r.owner_id), r.backup_id ? name(r.backup_id) : '', r.est_hours, r.logged_hours, r.start_on, r.due_on,
      COMPLEXITY[r.complexity].label, TASK_STATUS[r.status].label, TASK_STAGE[r.stage].label, r.progress, (r.depends_on ?? []).map((x) => x.wbs).join(' '), (r.blocking ?? []).map((x) => `${x.wbs} (${name(x.owner_id)})`).join(' '), r.comments,
      r.reviewer_id ? name(r.reviewer_id) : '', r.concerned_manager_id ? name(r.concerned_manager_id) : '', PRIORITY_P[r.priority ?? 'normal'].code, (r.labels ?? []).join(' '), r.billable ? 'Yes' : 'No',
      r.criteria_total ? `${r.criteria_done}/${r.criteria_total}` : '', r.owner_department ?? '',
    ])
    const out = await saveFile(`tasks-${today}.csv`, toCSV([head, ...body]), 'text/csv')
    if (out === 'saved') toast.success(`Exported ${rows.length} task${rows.length === 1 ? '' : 's'}`)
  }

  /* ---------- cells ---------- */
  const ownerCell = (r: AllTaskRow, compact?: boolean) => (
    <div className="min-w-0">
      {compact ? <span className="text-[13px] font-medium text-ink">{name(r.owner_id)}</span> : <PersonName id={r.owner_id} size={22} />}
      {r.covering ? (
        <div className="mt-0.5 text-[12px] font-medium text-warning-text">
          {r.covering.reason === 'leave' ? `Covering for ${first(r.owner_id)} (on leave ${weekdays(r.covering.days)})` : `Covering for ${first(r.owner_id)} (delegated)`}
        </div>
      ) : r.backup_id ? (
        <div className={cn('mt-0.5 text-[12px]', r.owner_leave_days?.length ? 'text-warning-text' : 'text-ink-3')}>
          backup {name(r.backup_id)}
          {r.owner_leave_days?.length ? ` · covers ${weekdays(r.owner_leave_days)}` : ''}
        </div>
      ) : (
        <div className={cn('mt-0.5 text-[12px]', r.owner_leave_days?.length ? 'text-danger-text' : 'text-ink-3')}>{r.owner_leave_days?.length ? `On leave ${weekdays(r.owner_leave_days)}, no backup` : 'no backup'}</div>
      )}
    </div>
  )
  const depLine = (x: TaskDepLink) => `${x.wbs} (${first(x.owner_id)}, ${x.done ? 'Done' : TASK_STAGE[x.stage].label})`
  const depsCell = (r: AllTaskRow) => {
    const deps = r.depends_on ?? []
    const blk = r.blocking ?? []
    if (!deps.length) return <span className="text-[12.5px] text-ink-3">—</span>
    return (
      <div className="min-w-0 space-y-0.5 text-[12.5px]">
        {blk.length > 0 && (
          <div className="font-medium text-danger-text">
            Blocked by {blk.map((x) => `${x.wbs} — owner ${name(x.owner_id)}`).join('; ')}
          </div>
        )}
        <div className="text-ink-3">after {deps.map(depLine).join(', ')}</div>
      </div>
    )
  }
  const statusCell = (r: AllTaskRow) => (
    <div className="w-[176px] space-y-1.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between gap-2">
        <StatusBadge map={TASK_STATUS} value={r.status} size="sm" />
        <span className="tnum text-[12px] text-ink-3">{r.progress}%</span>
      </div>
      <StageSelect size="sm" t={toStage(r)} label={`Stage of ${r.wbs}`} />
      <Progress value={r.progress} max={100} height={3} tone={r.status === 'done' ? 'success' : r.status === 'blocked' ? 'warning' : 'brand'} />
    </div>
  )
  const effortCell = (r: AllTaskRow) => (
    <span className="tnum whitespace-nowrap">
      {fmtNum(r.est_hours, 1)}h / <span className={cn(r.logged_hours > r.est_hours * 1.2 && 'font-medium text-danger-text')}>{fmtNum(r.logged_hours, 1)}h</span>
    </span>
  )
  const dueCell = (r: AllTaskRow) => (
    <div className="whitespace-nowrap">
      <div className={cn('tnum', r.overdue_days ? 'font-medium text-danger-text' : 'text-ink-2')}>{fmtDate(r.due_on)}</div>
      {r.overdue_days > 0 ? <div className="tnum text-[12px] text-danger-text">{r.overdue_days}d overdue</div> : r.forecast_end && r.forecast_end > r.due_on ? <div className="tnum text-[12px] text-danger-text">forecast {fmtDate(r.forecast_end)}</div> : r.done_on ? <div className="tnum text-[12px] text-ink-3">done {fmtDate(r.done_on)}</div> : null}
    </div>
  )
  const threadBtn = (r: AllTaskRow, label?: boolean) => (
    <Button
      size="xs"
      variant={label ? 'secondary' : 'ghost'}
      icon={<MessageSquare className="size-3.5" />}
      aria-label={`Open the thread of ${r.wbs} (${r.comments} comments)`}
      onClick={(e) => {
        e.stopPropagation()
        navigate(`/tasks/${r.id}?focus=thread`)
      }}
      className={cn(r.tagged && 'text-brand-text')}
    >
      {label ? `Thread (${r.comments})` : <span className="tnum">{r.comments}</span>}
    </Button>
  )

  const cols: Column<AllTaskRow>[] = [
    {
      key: 'task', header: 'Task · depends on', sortValue: (r) => `${r.project_code} ${r.wbs.padStart(6, '0')}`,
      cell: (r) => (
        <div className="min-w-[240px] max-w-[300px]">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="tnum shrink-0 text-[12.5px] font-medium text-brand-text">{r.wbs}</span>
            <span className={cn('min-w-0 font-medium leading-snug text-ink', r.status === 'done' && 'text-ink-2')} title={r.title}>{r.title}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <TagBadge tag={r.tag} />
            {r.critical && <Badge tone="danger" size="sm">Critical</Badge>}
            {r.tagged && <Badge tone="info" size="sm">Tagged you</Badge>}
            <RelationBadge r={r} />
            <span className="ml-auto">{threadBtn(r)}</span>
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
            {r.general ? 'General & admin' : `${r.project_code} · ${r.project_name}`}
            {r.milestone_label ? ` / ${r.milestone_label}` : ''}
          </div>
          {(r.depends_on?.length ?? 0) > 0 && (
            <div className="mt-1 border-t border-dashed border-line pt-1">
              <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-3">Depends on </span>
              {depsCell(r)}
            </div>
          )}
        </div>
      ),
    },
    { key: 'owner', header: 'Owner / backup', sortValue: (r) => name(r.owner_id), cell: (r) => <div className="min-w-[130px] max-w-[170px]">{ownerCell(r)}</div> },
    { key: 'effort', header: 'Est. / actual', align: 'right', sortValue: (r) => r.est_hours, cell: effortCell },
    {
      key: 'due', header: 'Start · due', sortValue: (r) => r.due_on,
      cell: (r) => (
        <div className="whitespace-nowrap">
          <div className="tnum text-[12px] text-ink-3">Start {fmtDate(r.start_on)}</div>
          {dueCell(r)}
        </div>
      ),
    },
    { key: 'cx', header: 'Complexity', sortValue: (r) => ['low', 'medium', 'high', 'very_high'].indexOf(r.complexity), cell: (r) => <StatusBadge map={COMPLEXITY} value={r.complexity} size="sm" /> },
    { key: 'status', header: 'Status', sortValue: (r) => SUMMARY.indexOf(r.status) * 20 + TASK_STAGE_ORDER.indexOf(r.stage), cell: statusCell },
  ]
  // v7 optional columns
  const extraCols: Record<ExtraCol, Column<AllTaskRow>> = {
    reviewer: { key: 'reviewer', header: 'Reviewer', sortValue: (r) => name(r.reviewer_id), cell: (r) => <div className="min-w-[120px] max-w-[160px]">{r.reviewer_id ? <PersonName id={r.reviewer_id} size={20} /> : <span className="text-ink-3">—</span>}</div> },
    cm: { key: 'cm', header: 'Concerned manager', sortValue: (r) => name(r.concerned_manager_id), cell: (r) => <div className="min-w-[120px] max-w-[160px]">{r.concerned_manager_id ? <PersonName id={r.concerned_manager_id} size={20} /> : <span className="text-ink-3">—</span>}</div> },
    priority: { key: 'priority', header: 'Priority', sortValue: (r) => ['urgent', 'high', 'normal', 'low'].indexOf(r.priority ?? 'normal'), cell: (r) => <Badge size="sm" tone={PRIORITY_P[r.priority ?? 'normal'].tone}>{PRIORITY_P[r.priority ?? 'normal'].code}</Badge> },
    labels: { key: 'labels', header: 'Labels', cell: (r) => (r.labels?.length ? <div className="flex min-w-[110px] max-w-[180px] flex-wrap gap-1">{r.labels.map((l) => <Badge key={l} size="sm">{l}</Badge>)}</div> : <span className="text-ink-3">—</span>) },
    dod: { key: 'dod', header: 'Done criteria', align: 'right', sortValue: (r) => (r.criteria_total ? (r.criteria_done ?? 0) / r.criteria_total : -1), cell: (r) => (r.criteria_total ? <span className={cn('tnum whitespace-nowrap', r.criteria_done === r.criteria_total ? 'text-success-text' : 'text-ink-2')}>{r.criteria_done}/{r.criteria_total}</span> : <span className="text-ink-3">—</span>) },
    billable: { key: 'billable', header: 'Billable', sortValue: (r) => (r.billable ? 1 : 0), cell: (r) => <span className={cn('whitespace-nowrap', r.billable ? 'text-ink-2' : 'text-ink-3')}>{r.billable ? 'Billable' : 'Internal'}</span> },
  }
  const allCols = [...cols, ...EXTRA_COLS.filter((c) => extra.includes(c.key)).map((c) => extraCols[c.key])]

  const chipOpts: { value: TaskChip; label: string; count?: number }[] = [
    { value: '', label: 'All', count: d?.counts?.all },
    { value: 'mine', label: 'Mine', count: d?.counts?.mine },
    { value: 'covering', label: 'Covering', count: d?.counts?.covering },
    { value: 'tagged', label: 'Tagged me', count: d?.counts?.tagged },
    { value: 'overdue', label: 'Overdue', count: d?.counts?.overdue },
    { value: 'blocked', label: 'Blocked', count: d?.counts?.blocked },
  ]
  const personOpts = [
    { value: 'all', label: 'Everyone' },
    ...(me ? [{ value: me.id, label: `${me.name} (me)` }] : []),
    ...(d?.facets.people ?? []).filter((id) => id !== me?.id).map((id) => ({ value: id, label: name(id) })).sort((a, b) => a.label.localeCompare(b.label)),
  ]
  const stageOpts = [{ value: '', label: 'Any stage' }, ...stagesFor(status).map((k) => ({ value: k, label: `${TASK_STAGE[k].label}${d?.stage_counts?.[k] !== undefined ? ` (${d.stage_counts[k]})` : ''}` }))]

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Every task with its owner and backup, estimate, dates, complexity, status, dependencies and thread. Filter by person, project and status."
        actions={
          <>
            <Link to="/my-tasks">
              <Button size="sm">My tasks</Button>
            </Link>
            <Button size="sm" icon={<Download className="size-4" />} disabled={!rows.length} onClick={exportCsv}>
              Export CSV
            </Button>
            <CreateTaskButton prefill={f.project ? { project_id: f.project } : undefined} />
          </>
        }
      />
      <Card className="mb-4" pad={false}>
        <div className="grid grid-cols-2 gap-2 p-3 md:grid-cols-4 xl:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,1fr))_auto] xl:items-end">
          <FilterField label="Search" className="col-span-2 md:col-span-4 xl:col-span-1">
            <SearchInput value={qText} onChange={setQText} placeholder="Task, WBS no, project or owner" />
          </FilterField>
          <FilterField label="Person (owner)">
            <Select
              aria-label="Person"
              value={personChip ? (me?.id ?? 'all') : person === 'all' ? 'all' : person}
              disabled={personChip}
              title={personChip ? 'The chip picks the person: clear it to filter by owner' : undefined}
              onChange={(e) => set({ person: e.target.value })}
              options={personOpts}
            />
          </FilterField>
          <FilterField label="Project">
            <Select aria-label="Project" value={f.project ?? ''} onChange={(e) => set({ project: e.target.value || undefined })} options={[{ value: '', label: 'All projects' }, ...(d?.facets.projects ?? []).map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} />
          </FilterField>
          <FilterField label="Status">
            <Select
              aria-label="Status"
              value={status}
              onChange={(e) => set({ status: e.target.value, stage: undefined })}
              options={[
                { value: 'open', label: `Open (not done)${d ? ` · ${openCount}` : ''}` },
                { value: 'all', label: `All statuses${d ? ` · ${allCount}` : ''}` },
                ...SUMMARY.map((s) => ({ value: s, label: `${TASK_STATUS[s].label}${d ? ` · ${sc[s] ?? 0}` : ''}` })),
              ]}
            />
          </FilterField>
          <FilterField label="Stage">
            <Select aria-label="Stage" value={f.stage ?? ''} onChange={(e) => set({ stage: e.target.value || undefined })} options={stageOpts} />
          </FilterField>
          <div className="col-span-2 flex items-end md:col-span-4 xl:col-span-1">
            {dirty && (
              <Button size="sm" variant="ghost" onClick={reset}>
                Reset
              </Button>
            )}
          </div>
        </div>
        {(viewAll || (d?.facets.labels?.length ?? 0) > 0) && (
          <div className="grid grid-cols-2 gap-2 border-t border-line p-3 md:grid-cols-4 xl:grid-cols-[repeat(3,minmax(0,1fr))_auto] xl:items-end">
            {viewAll && (
              <FilterField label="Department">
                <Select aria-label="Department" value={f.department ?? ''} onChange={(e) => set({ department: e.target.value || undefined })} options={[{ value: '', label: 'All departments' }, ...(d?.facets.departments ?? []).map((x) => ({ value: x.id, label: `${x.name} · ${x.count}` }))]} />
              </FilterField>
            )}
            <FilterField label="Label">
              <Select aria-label="Label" value={f.label ?? ''} onChange={(e) => set({ label: e.target.value || undefined })} options={[{ value: '', label: 'Any label' }, ...(d?.facets.labels ?? []).map((x) => ({ value: x.name, label: `${x.name} · ${x.count}` }))]} />
            </FilterField>
            {viewAll && (
              <FilterField label="View" className="col-span-2 md:col-span-1">
                <Segmented<'list' | 'employee'> block size="sm" value={grouped ? 'employee' : 'list'} onChange={(v) => set({ group: v === 'employee' ? 'employee' : '' })} options={[{ value: 'list', label: 'Task list' }, { value: 'employee', label: 'By employee' }]} />
              </FilterField>
            )}
            <div className="col-span-2 flex items-end justify-end md:col-span-1">
              {!grouped && <ColumnPicker extra={extra} setExtra={setExtra} />}
            </div>
          </div>
        )}
        <div className="border-t border-line px-3 py-2.5">
          <FilterChips value={chip} onChange={(v) => set({ chip: v === chip ? '' : v })} options={chipOpts} />
        </div>
      </Card>
      {d && !viewAll && d.scope_note && <p className="mb-2 text-[12.5px] text-ink-3">{d.scope_note}</p>}
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[12.5px] text-ink-3">
        <span className="tnum">
          {res.isLoading ? 'Loading…' : `${rows.length} task${rows.length === 1 ? '' : 's'}`}
          {d && !personChip ? ` · ${person === 'all' ? 'everyone' : person === me?.id ? 'owned by me' : `owned by ${name(person)}`}` : ''}
          {chip === 'covering' ? ' · covering for colleagues on leave this week' : chip === 'tagged' ? ' · tasks where someone @mentioned you' : ''}
        </span>
        <span className="hidden md:inline">A task can’t start while a task it depends on is open. Click a row for details; the speech bubble opens the thread.</span>
      </div>
      {grouped ? (
        <EmployeeGroups groups={d?.groups ?? []} loading={res.isLoading} onPick={(id) => set({ person: id ?? 'all', group: '', chip: '' })} />
      ) : (
      <DataTable
        rows={d ? rows : undefined}
        columns={allCols}
        rowKey={(r) => r.id}
        loading={res.isLoading}
        error={res.error}
        onRetry={() => res.refetch()}
        onRowClick={(r) => openTask(r.id)}
        pageSize={100}
        dense
        rowClassName={(r: AllTaskRow) => (r.blocking?.length && r.status !== 'done' ? 'bg-danger-soft/20' : '')}
        empty={
          <EmptyState
            compact
            icon={<ListChecks />}
            title={chip === 'covering' ? 'Nothing to cover this week' : chip === 'tagged' ? 'Nobody has tagged you' : 'No tasks match'}
            body={chip === 'covering' ? 'When an owner you back up is on leave, their tasks appear here on those days and you can log time on them.' : 'Change the filters, or set Status to All statuses.'}
            action={dirty ? <Button size="sm" onClick={reset}>Reset filters</Button> : undefined}
          />
        }
        mobileCard={(r) => <MobileCard r={r} ownerCell={ownerCell} depsCell={depsCell} effortCell={effortCell} dueCell={dueCell} threadBtn={threadBtn} week={week} />}
      />
      )}
    </div>
  )
}

/** Why a person without tasks.view_all sees a row (Covering is already shown under the owner). */
function RelationBadge({ r }: { r: AllTaskRow }) {
  const rel = r.relation
  if (!rel || rel === 'owner' || rel === 'covering') return null
  const x = TASK_RELATION[rel]
  return <Badge size="sm" tone={x.tone === 'brand' ? 'info' : x.tone}>{x.label}</Badge>
}

function ColumnPicker({ extra, setExtra }: { extra: ExtraCol[]; setExtra: (v: ExtraCol[]) => void }) {
  return (
    <Popover
      align="end"
      className="w-[240px] p-2"
      trigger={
        <Button size="sm" variant="secondary" icon={<Columns3 className="size-4" />} className="hidden lg:inline-flex">
          Columns
        </Button>
      }
    >
      <div className="px-1 pb-1 text-[12px] font-medium text-ink-3">Optional columns</div>
      <div className="space-y-0.5">
        {EXTRA_COLS.map((c) => (
          <div key={c.key} className="rounded-md px-1 py-1 hover:bg-surface-2">
            <Checkbox checked={extra.includes(c.key)} onChange={(v) => setExtra(v ? [...extra, c.key] : extra.filter((x) => x !== c.key))} label={<span className="text-[13px]">{c.label}</span>} />
          </div>
        ))}
      </div>
    </Popover>
  )
}

/** v7 group-by-employee view: per-person open, overdue, done this week (click a row to see that person's tasks). */
function EmployeeGroups({ groups, loading, onPick }: { groups: TaskEmployeeGroup[]; loading: boolean; onPick: (id: string | null) => void }) {
  const cols: Column<TaskEmployeeGroup>[] = [
    { key: 'name', header: 'Employee', sortValue: (g) => g.name, cell: (g) => (g.user_id ? <PersonName id={g.user_id} size={24} subtitle={g.department ?? undefined} /> : <span className="text-ink-3">Unassigned</span>) },
    { key: 'open', header: 'Open', align: 'right', sortValue: (g) => g.open, cell: (g) => <span className="tnum">{g.open}</span> },
    { key: 'overdue', header: 'Overdue', align: 'right', sortValue: (g) => g.overdue, cell: (g) => <span className={cn('tnum', g.overdue ? 'font-medium text-danger-text' : 'text-ink-3')}>{g.overdue}</span> },
    { key: 'done', header: 'Done this week', align: 'right', sortValue: (g) => g.done_week, cell: (g) => <span className={cn('tnum', g.done_week ? 'text-success-text' : 'text-ink-3')}>{g.done_week}</span> },
    { key: 'est', header: 'Open estimate', align: 'right', sortValue: (g) => g.est_open, cell: (g) => <span className="tnum whitespace-nowrap">{fmtNum(g.est_open, 1)}h</span> },
    { key: 'total', header: 'All tasks', align: 'right', sortValue: (g) => g.total, cell: (g) => <span className="tnum text-ink-3">{g.total}</span> },
  ]
  return (
    <DataTable
      rows={loading ? undefined : groups}
      columns={cols}
      rowKey={(g) => g.user_id ?? 'none'}
      loading={loading}
      onRowClick={(g) => onPick(g.user_id)}
      initialSort={{ key: 'overdue', dir: 'desc' }}
      empty={<EmptyState compact icon={<Users />} title="No tasks match" body="Change the project, department or search filters." />}
      mobileCard={(g) => (
        <div className="min-w-0 space-y-2">
          {g.user_id ? <PersonName id={g.user_id} size={24} subtitle={g.department ?? undefined} /> : <span className="text-ink-3">Unassigned</span>}
          <div className="grid grid-cols-4 gap-2 text-[12.5px]">
            <div><div className="text-ink-3">Open</div><span className="tnum font-medium">{g.open}</span></div>
            <div><div className="text-ink-3">Overdue</div><span className={cn('tnum font-medium', g.overdue && 'text-danger-text')}>{g.overdue}</span></div>
            <div><div className="text-ink-3">Done wk</div><span className="tnum font-medium">{g.done_week}</span></div>
            <div><div className="text-ink-3">Est.</div><span className="tnum font-medium">{fmtNum(g.est_open, 0)}h</span></div>
          </div>
        </div>
      )}
    />
  )
}

function FilterField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block min-w-0', className)}>
      <span className="mb-1 block text-[12px] font-medium text-ink-3">{label}</span>
      {children}
    </label>
  )
}

function MobileCard({
  r, ownerCell, depsCell, effortCell, dueCell, threadBtn, week,
}: {
  r: AllTaskRow
  ownerCell: (r: AllTaskRow, compact?: boolean) => ReactNode
  depsCell: (r: AllTaskRow) => ReactNode
  effortCell: (r: AllTaskRow) => ReactNode
  dueCell: (r: AllTaskRow) => ReactNode
  threadBtn: (r: AllTaskRow, label?: boolean) => ReactNode
  week: string
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div>
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tnum shrink-0 text-[12.5px] font-medium text-brand-text">{r.wbs}</span>
          <span className="min-w-0 text-[14px] font-medium leading-snug text-ink">{r.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          <TagBadge tag={r.tag} />
          {r.critical && <Badge tone="danger" size="sm">Critical</Badge>}
          {r.tagged && <Badge tone="info" size="sm">Tagged you</Badge>}
          <RelationBadge r={r} />
          {r.priority && r.priority !== 'normal' && <Badge tone={PRIORITY_P[r.priority].tone} size="sm">{PRIORITY_P[r.priority].code}</Badge>}
        </div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
          {r.general ? 'General & admin' : `${r.project_code} · ${r.project_name}`}
          {r.milestone_label ? ` / ${r.milestone_label}` : ''}
        </div>
      </div>
      {ownerCell(r, true)}
      <div className="grid grid-cols-3 gap-2 text-[12.5px]">
        <div className="min-w-0">
          <div className="text-ink-3">Est. / actual</div>
          {effortCell(r)}
        </div>
        <div className="min-w-0">
          <div className="text-ink-3">Start</div>
          <span className="tnum">{fmtDate(r.start_on)}</span>
        </div>
        <div className="min-w-0">
          <div className="text-ink-3">Due</div>
          {dueCell(r)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <StatusBadge map={TASK_STATUS} value={r.status} size="sm" />
        <span className="text-ink-3">{TASK_STAGE[r.stage].label} · {r.progress}%</span>
        <span className="text-ink-3">·</span>
        <span className="text-ink-3">Complexity</span>
        <StatusBadge map={COMPLEXITY} value={r.complexity} size="sm" />
      </div>
      {(r.depends_on?.length ?? 0) > 0 && depsCell(r)}
      <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
        {r.can_move && (
          <div className="min-w-[180px] flex-1">
            <StageSelect size="sm" t={toStage(r)} label={`Stage of ${r.wbs}`} />
          </div>
        )}
        {threadBtn(r, true)}
        {r.can_log_time && (
          <Link to={`/timesheet/${week}?task=${r.id}`}>
            <Button size="xs" variant="secondary" icon={<CalendarClock className="size-3.5" />}>
              Log time
            </Button>
          </Link>
        )}
      </div>
    </div>
  )
}
