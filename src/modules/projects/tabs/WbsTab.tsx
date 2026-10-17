import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileUp, ListTree, Plus } from '@/ui/icons'
import type { Complexity, TaskTag } from '@/types/entities'
import { wbsApi, type MilestoneView, type ProjectDetail, type TaskView } from '@/api/projects'
import { useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { ApiError } from '@/api/http'
import { COMPLEXITY, COMPLEXITY_ORDER, TASK_TAG_LABEL } from '@/domain/labels'
import { progressOf, stageOf } from '@/domain/delivery'
import { addDays, fmtDate, todayISO } from '@/domain/calendar'
import { fmtNum, fmtPct } from '@/domain/money'
import { useSession } from '@/stores/session'
import { useUI } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { Button, Card, Checkbox, Dialog, EmptyState, Field, IconButton, Input, PeoplePicker, Progress, Select, Textarea, useReadOnly } from '@/ui'
import { MilestoneTable } from '../components/MilestoneTable'
import { StageSelect, TagBadge, type StageTask } from '@/modules/work/taskStage'
import { TaskFormSheet } from '@/modules/work/TaskForm'

export { MilestoneDialog } from '../components/MilestoneTable'

type Group = { ms: MilestoneView | null; tasks: TaskView[] }

export function WbsTab({ d }: { d: ProjectDetail }) {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const editable = d.can_edit && !readOnly
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [hideDone, setHideDone] = useState(false)
  const [addTo, setAddTo] = useState<{ open: boolean; ms: MilestoneView | null }>({ open: false, ms: null })
  const orphan = d.tasks.filter((t) => !t.milestone_id || !d.milestones.some((m) => m.id === t.milestone_id))
  const groups: Group[] = [...d.milestones.map((m) => ({ ms: m, tasks: d.tasks.filter((t) => t.milestone_id === m.id) })), ...(orphan.length ? [{ ms: null, tasks: orphan }] : [])]
  const allIds = groups.map((g) => g.ms?.id ?? 'none')
  const allCollapsed = allIds.length > 0 && allIds.every((x) => collapsed.has(x))
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const visible = (g: Group) => (hideDone ? g.tasks.filter((t) => t.status !== 'done') : g.tasks)

  return (
    <div className="space-y-4">
      <MilestoneTable d={d} />
      <Card pad={false} className="min-w-0">
        <div className="flex flex-col gap-3 px-4 pb-3 pt-4 md:flex-row md:items-center md:justify-between md:px-5 md:pt-5">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-ink">Work breakdown structure</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-3">Float is how many working days a task can slip before it moves its milestone (0 marks the critical tasks); the second figure is the spare days before it delays the project end.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            {editable && (
              <Button size="sm" icon={<FileUp className="size-4" />} onClick={() => nav(`/projects/${d.project.id}/import`)}>
                Import WBS
              </Button>
            )}
            <Checkbox checked={hideDone} onChange={setHideDone} label={<span className="text-[13px]">Hide done</span>} />
            <IconButton size="sm" label={allCollapsed ? 'Expand all' : 'Collapse all'} onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(allIds))}>
              {allCollapsed ? <ChevronsUpDown className="size-4" /> : <ChevronsDownUp className="size-4" />}
            </IconButton>
          </div>
        </div>
        {!d.tasks.length && !d.milestones.length ? (
          <EmptyState
            icon={<ListTree />}
            title="No work breakdown yet"
            body="Add milestones above, then their tasks — or import the whole WBS from a spreadsheet."
            action={editable ? <Button icon={<FileUp className="size-4" />} onClick={() => nav(`/projects/${d.project.id}/import`)}>Import WBS</Button> : undefined}
          />
        ) : (
          <>
            {/* lg+: the WBS table */}
            <div className="hidden overflow-x-auto border-t border-line lg:block scroll-thin" role="region" aria-label="Work breakdown structure" tabIndex={0}>
              <table className="w-full min-w-[1140px] border-collapse text-[13.5px]">
                <thead>
                  <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                    <th className="h-9 w-[58px] pl-4 pr-2">WBS</th>
                    <th className="px-2">Milestone / task</th>
                    <th className="w-[130px] px-2">Owner</th>
                    <th className="w-[214px] px-2">Stage</th>
                    <th className="w-[60px] px-2 text-right">Done</th>
                    <th className="w-[100px] px-2 text-right">Effort est / actual</th>
                    <th className="w-[92px] px-2 text-right">Start plan / actual</th>
                    <th className="w-[88px] px-2 text-right">Target end</th>
                    <th className="w-[84px] px-2 text-right">End</th>
                    <th className="w-[92px] pl-2 pr-4 text-right">Float to milestone</th>
                  </tr>
                </thead>
                {groups.map((g) => {
                  const key = g.ms?.id ?? 'none'
                  const open = !collapsed.has(key)
                  const rows = visible(g)
                  return (
                    <tbody key={key}>
                      <MilestoneRow d={d} g={g} open={open} onToggle={() => toggle(key)} onAdd={editable && g.ms ? () => setAddTo({ open: true, ms: g.ms }) : undefined} />
                      {open && rows.map((t) => <TaskRow key={t.id} d={d} t={t} />)}
                      {open && !rows.length && (
                        <tr className="border-b border-line">
                          <td />
                          <td colSpan={9} className="px-2 py-3 text-[13px] text-ink-3">
                            {g.tasks.length ? 'All tasks here are done.' : editable ? 'No tasks yet. Use + Task to add the first one; its target end becomes the deadline.' : 'No tasks yet.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  )
                })}
              </table>
            </div>
            {/* below lg: stacked cards grouped by milestone */}
            <div className="space-y-3 border-t border-line p-3 lg:hidden">
              {groups.map((g) => {
                const key = g.ms?.id ?? 'none'
                const open = !collapsed.has(key)
                const rows = visible(g)
                return (
                  <section key={key} className="overflow-hidden rounded-lg border border-line">
                    <MilestoneCard d={d} g={g} open={open} onToggle={() => toggle(key)} onAdd={editable && g.ms ? () => setAddTo({ open: true, ms: g.ms }) : undefined} />
                    {open && (
                      <ul className="divide-y divide-line border-t border-line">
                        {rows.map((t) => (
                          <TaskCard key={t.id} d={d} t={t} />
                        ))}
                        {!rows.length && <li className="px-3 py-3 text-[13px] text-ink-3">{g.tasks.length ? 'All tasks here are done.' : 'No tasks yet.'}</li>}
                      </ul>
                    )}
                  </section>
                )
              })}
            </div>
          </>
        )}
      </Card>
      <p className="text-[12.5px] text-ink-3">Numbers are fixed once given (M1, M2… and 1.1, 1.2…) and never reused. Red-edged rows are critical: any delay moves the milestone.</p>
      {/* v7: + Task opens the shared professional Create task form, prefilled with this project and milestone */}
      <TaskFormSheet
        open={addTo.open}
        onOpenChange={(o) => setAddTo((x) => ({ ...x, open: o }))}
        prefill={{ project_id: d.project.id, milestone_id: addTo.ms?.id ?? null }}
        lockProject
        lockMilestone={!!addTo.ms}
        title="New task"
        subtitle={addTo.ms ? `In M${addTo.ms.no} ${addTo.ms.name}. If it ends after ${fmtDate(addTo.ms.planned_end)}, the milestone deadline moves with it.` : `In ${d.project.code} · ${d.project.name}.`}
      />
    </div>
  )
}

/* ---------------- rows ---------------- */
function rollup(g: Group) {
  const est = g.tasks.reduce((s, t) => s + t.est_hours, 0)
  const act = g.tasks.reduce((s, t) => s + t.actual_hours, 0)
  return { est, act }
}
function useStageTask(d: ProjectDetail) {
  const { user } = useSession()
  return (t: TaskView): StageTask => ({
    id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on, start_on: t.start_on, stage: stageOf(t), progress: progressOf(t), status: t.status, version: t.version,
    can_move: d.can_edit || t.owner_id === user?.id || t.backup_id === user?.id,
    can_submit: (t.owner_id === user?.id || t.backup_id === user?.id) && ['todo', 'in_progress', 'blocked'].includes(t.status),
    can_review: t.owner_id !== user?.id && (d.can_edit || t.reviewer_id === user?.id),
    can_edit: d.can_edit, owner_id: t.owner_id, backup_id: t.backup_id, logged_hours: t.actual_hours,
  })
}

function EndCell({ t, align = 'right' }: { t: TaskView; align?: 'left' | 'right' }) {
  const done = t.status === 'done'
  const end = done ? t.done_on : t.forecast_end
  if (!end) return <span className="text-ink-3">—</span>
  const late = end > t.due_on
  return (
    <span className={cn('tnum block whitespace-nowrap', align === 'right' ? 'text-right' : 'text-left')}>
      <span className={cn('block', done ? (late ? 'font-semibold text-danger-text' : 'font-semibold text-success-text') : late ? 'font-semibold text-danger-text' : 'text-ink-2')}>{fmtDate(end)}</span>
      <span className={cn('block text-[11.5px]', done ? 'font-medium text-ink-3' : 'text-ink-3')}>{done ? 'actual' : 'forecast'}</span>
    </span>
  )
}
function FloatCell({ t }: { t: TaskView }) {
  const pf = t.project_float_days
  const proj = pf === null || pf === undefined || t.status === 'done' ? null : <span className="block text-[11.5px] text-ink-3">{pf <= 0 ? 'project: 0' : `project: ${pf}d`}</span>
  let main
  if (t.status === 'done' && !t.critical) main = <span className="tnum text-ink-3">{t.float_days ?? '—'}{t.float_days !== null && t.float_days !== undefined ? 'd' : ''}</span>
  else if (t.float_days === null || t.float_days === undefined) main = <span className="text-ink-3">—</span>
  else main = t.float_days <= 0 ? <span className="tnum font-semibold text-danger-text">0</span> : <span className="tnum text-ink-2">{t.float_days}d</span>
  return <span className="tnum block whitespace-nowrap">{main}{proj}</span>
}

function MilestoneRow({ d, g, open, onToggle, onAdd }: { d: ProjectDetail; g: Group; open: boolean; onToggle: () => void; onAdd?: () => void }) {
  const m = g.ms
  const r = rollup(g)
  const doneShare = m ? m.progress : r.est ? g.tasks.reduce((s, t) => s + (t.est_hours * progressOf(t)) / 100, 0) / r.est : 0
  const endLate = m && m.end_on && m.end_on > m.planned_end
  return (
    <tr className="border-b border-line bg-surface-2/60 font-semibold">
      <td className="py-2.5 pl-4 pr-2 align-middle">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} className="inline-flex items-center gap-1 text-ink">
          {open ? <ChevronDown className="size-3.5 text-ink-3" /> : <ChevronRight className="size-3.5 text-ink-3" />}
          <span className="tnum">{m ? `M${m.no}` : '—'}</span>
        </button>
      </td>
      <td className="px-2 align-middle text-ink">
        {m ? m.name : 'No milestone'}
        <span className="ml-2 text-[12px] font-normal text-ink-3">
          {g.tasks.length} task{g.tasks.length === 1 ? '' : 's'}
        </span>
      </td>
      <td className="px-2" />
      <td className="px-2" />
      <td className="tnum px-2 text-right">{fmtPct(doneShare, 0)}</td>
      <td className="tnum whitespace-nowrap px-2 text-right">
        {fmtNum(m ? m.est_hours : r.est, 0)}h / {fmtNum(m ? m.logged_hours : r.act, 0)}h
      </td>
      <td className="tnum whitespace-nowrap px-2 text-right">{m ? fmtDate(m.planned_start) : '—'}</td>
      <td className="tnum whitespace-nowrap px-2 text-right">{m ? fmtDate(m.planned_end) : '—'}</td>
      <td className={cn('tnum whitespace-nowrap px-2 text-right', endLate ? 'text-danger-text' : 'text-ink')}>{m?.end_on ? fmtDate(m.end_on) : '—'}</td>
      <td className="pl-2 pr-4 text-right">
        {onAdd && (
          <Button size="xs" icon={<Plus className="size-3.5" />} onClick={onAdd}>
            Task
          </Button>
        )}
      </td>
    </tr>
  )
}

function TaskRow({ d, t }: { d: ProjectDetail; t: TaskView }) {
  const openTask = useUI((s) => s.openTask)
  const people = usePeopleMap()
  const toStage = useStageTask(d)
  const owner = people.get(t.owner_id)
  const crit = !!t.critical && t.status !== 'done'
  const critDone = !!t.critical && t.status === 'done'
  return (
    <tr onClick={() => openTask(t.id)} className={cn('group cursor-pointer border-b border-line align-top transition-colors hover:bg-surface-2/50', t.status === 'done' && 'text-ink-2')}>
      <td className={cn('tnum py-2.5 pl-4 pr-2 text-ink-3', (crit || critDone) && 'shadow-[inset_3px_0_0_var(--danger)]')}>{t.wbs}</td>
      <td className="min-w-0 px-2 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-ink group-hover:text-brand-text">{t.title}</span>
          <TagBadge tag={t.tag} />
        </div>
        {(t.dep_wbs ?? []).length > 0 && <div className="text-[12px] text-ink-3">after {(t.dep_wbs ?? []).join(', ')}</div>}
      </td>
      <td className="px-2 py-2.5 text-ink-2">{owner?.name ?? <span className="text-ink-3">Unassigned</span>}</td>
      <td className="px-2 py-2" onClick={(e) => e.stopPropagation()}>
        <StageSelect t={toStage(t)} size="sm" />
      </td>
      <td className="tnum px-2 py-2.5 text-right">{progressOf(t)}%</td>
      <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">
        {fmtNum(t.est_hours, 1)}h / <span className={cn(t.actual_hours > t.est_hours * 1.2 && 'text-danger-text')}>{t.actual_hours ? `${fmtNum(t.actual_hours, 1)}h` : '—'}</span>
      </td>
      <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">
        <span className="block">{fmtDate(t.start_on)}</span>
        <span className="block text-[11.5px] text-ink-3">{t.actual_start_on ? fmtDate(t.actual_start_on) : '—'}</span>
      </td>
      <td className="tnum whitespace-nowrap px-2 py-2.5 text-right">
        <span className={cn('block', t.status !== 'done' && t.due_on < todayISO() && 'text-danger-text')}>{fmtDate(t.baseline_due_on && t.revised_on ? t.baseline_due_on : t.due_on)}</span>
        {t.revised_on && t.baseline_due_on && t.baseline_due_on !== t.due_on && <span className="block text-[11.5px] text-ink-3">rev {fmtDate(t.due_on)}</span>}
      </td>
      <td className="px-2 py-2.5">
        <EndCell t={t} />
      </td>
      <td className="pl-2 pr-4 py-2.5 text-right">
        <FloatCell t={t} />
      </td>
    </tr>
  )
}

function MilestoneCard({ d, g, open, onToggle, onAdd }: { d: ProjectDetail; g: Group; open: boolean; onToggle: () => void; onAdd?: () => void }) {
  const m = g.ms
  const r = rollup(g)
  void d
  return (
    <div className="bg-surface-2/60 px-3 py-2.5">
      <div className="flex items-start gap-2">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-1.5 text-left">
          {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-ink-3" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-ink-3" />}
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-snug">
              <span className="tnum mr-1.5">{m ? `M${m.no}` : '—'}</span>
              {m ? m.name : 'No milestone'}
            </span>
            <span className="tnum mt-0.5 block text-[12.5px] text-ink-3">
              {g.tasks.length} task{g.tasks.length === 1 ? '' : 's'} · {fmtNum(m ? m.est_hours : r.est, 0)}h / {fmtNum(m ? m.logged_hours : r.act, 0)}h
              {m ? ` · ${fmtDate(m.planned_start)} – ${fmtDate(m.planned_end)}` : ''}
            </span>
          </span>
        </button>
        {onAdd && (
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={onAdd} className="shrink-0">
            Task
          </Button>
        )}
      </div>
      {m && (
        <div className="mt-2 flex items-center gap-2">
          <Progress value={m.progress} height={4} className="flex-1" tone={m.state === 'at_risk' ? 'warning' : m.state === 'overdue' || m.state === 'achieved_late' ? 'danger' : 'brand'} />
          <span className="tnum text-[12px] text-ink-2">{fmtPct(m.progress, 0)}</span>
          {m.end_on && <span className={cn('tnum text-[12px]', m.end_on > m.planned_end ? 'font-semibold text-danger-text' : 'text-ink-3')}>end {fmtDate(m.end_on)}</span>}
        </div>
      )}
    </div>
  )
}

function TaskCard({ d, t }: { d: ProjectDetail; t: TaskView }) {
  const openTask = useUI((s) => s.openTask)
  const people = usePeopleMap()
  const toStage = useStageTask(d)
  const crit = !!t.critical && t.status !== 'done'
  return (
    <li className={cn('px-3 py-3', crit && 'shadow-[inset_3px_0_0_var(--danger)]')}>
      <button type="button" onClick={() => openTask(t.id)} className="block w-full text-left">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tnum shrink-0 text-[12.5px] text-ink-3">{t.wbs}</span>
          <span className="min-w-0 text-[14px] leading-snug text-ink">{t.title}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
          <span>{people.get(t.owner_id)?.name ?? 'Unassigned'}</span>
          {(t.dep_wbs ?? []).length > 0 && <span>· after {(t.dep_wbs ?? []).join(', ')}</span>}
          <TagBadge tag={t.tag} />
        </div>
      </button>
      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
        <StageSelect t={toStage(t)} size="sm" />
        <span className="tnum text-[13px] font-medium text-ink">{progressOf(t)}%</span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-[12.5px]">
        <div className="min-w-0">
          <dt className="text-ink-3">Effort</dt>
          <dd className="tnum whitespace-nowrap text-ink-2">
            {fmtNum(t.est_hours, 1)}h / {t.actual_hours ? `${fmtNum(t.actual_hours, 1)}h` : '—'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-3">Target end</dt>
          <dd className="tnum whitespace-nowrap text-ink-2">
            {fmtDate(t.due_on)}
            {t.revised_on && t.baseline_due_on && t.baseline_due_on !== t.due_on ? <span className="block text-[11.5px] text-ink-3">was {fmtDate(t.baseline_due_on)}</span> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-3">End · float</dt>
          <dd className="flex items-start gap-1.5">
            <EndCell t={t} align="left" />
            <span className="pt-px">
              <FloatCell t={t} />
            </span>
          </dd>
        </div>
      </dl>
    </li>
  )
}
