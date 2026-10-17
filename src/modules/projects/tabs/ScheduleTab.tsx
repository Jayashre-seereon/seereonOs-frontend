import { useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, ChevronRight, Route, UserRound } from '@/ui/icons'
import { projectsApi, type ProjectDetail, type Schedule, type ScheduleTask } from '@/api/projects'
import { tasksApi } from '@/api/tasks'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { addDays, diffDays, fmtDate, parseISO } from '@/domain/calendar'
import { TASK_STATUS } from '@/domain/labels'
import { useUI } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { Badge, Button, Callout, Card, CardHeader, EmptyState, Field, Input, PeoplePicker, PersonName, Popover, Segmented, Skeleton, StatusBadge, ErrorState, Textarea, useConfirm, useReadOnly } from '@/ui'
import { Legend, MsStateBadge, MS_STATE } from '../components/shared'
import { BreachRiskList } from '../components/BreachRiskList'

/** G5.02 — “Critical path: 1.1 (1 Jun to 5 Jun) › 1.2 (…) … Ends 13 Nov.” */
export function CriticalPathText({ s, className }: { s: Schedule; className?: string }) {
  const byId = new Map(s.tasks.map((t) => [t.id, t]))
  const chain = s.critical_path.map((id) => byId.get(id)).filter(Boolean) as ScheduleTask[]
  if (!chain.length) return null
  const last = chain[chain.length - 1]
  const end = last.status === 'done' ? last.done_on ?? last.due_on : last.due_on
  return (
    <p className={cn('text-[13px] leading-relaxed text-ink-2', className)}>
      <span className="font-semibold text-ink">Critical path: </span>
      {chain.map((t, i) => (
        <span key={t.id}>
          {i > 0 && <span className="text-ink-3"> › </span>}
          <span className={cn('tnum', t.status !== 'done' && 'text-danger-text')}>{t.wbs}</span>{' '}
          <span className="tnum text-ink-3">({fmtDate(t.start_on)} to {fmtDate(t.due_on)})</span>
        </span>
      ))}
      . Ends <span className="tnum font-semibold text-ink">{fmtDate(end)}</span>
      {s.forecast_finish && s.forecast_finish > end ? <span className="tnum text-danger-text"> (forecast {fmtDate(s.forecast_finish)})</span> : null}.
    </p>
  )
}

type Zoom = 'day' | 'week' | 'month'
const PX: Record<Zoom, number> = { day: 26, week: 11, month: 4.2 }
const ROW = 34
const MS_ROW = 36
const HEAD = 44

export function ScheduleTab({ d }: { d: ProjectDetail }) {
  const q = useApi(['project', d.project.id, 'schedule'], () => projectsApi.schedule(d.project.id))
  if (q.isLoading)
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-[360px] w-full rounded-lg" />
      </div>
    )
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  const s = q.data
  if (!s.tasks.length)
    return (
      <Card>
        <EmptyState icon={<Route />} title="Nothing to schedule yet" body="Add tasks with start and due dates in the WBS tab. The Gantt, critical path and breach forecast build themselves from them." />
      </Card>
    )
  return (
    <div className="space-y-4">
      <SummaryStrip s={s} />
      <Gantt s={s} />
      <BreachRiskList projectId={d.project.id} />
      <CriticalPath s={s} />
    </div>
  )
}

function SummaryStrip({ s }: { s: Schedule }) {
  const late = s.forecast_finish && s.forecast_finish > s.project_end ? diffDays(s.forecast_finish, s.project_end) : 0
  // Same definition as the risk list and the dashboards: breached = open task already past its target end.
  const breached = s.tasks.filter((t) => t.breach?.kind === 'overdue').length
  const atRisk = s.tasks.filter((t) => t.breach && t.breach.kind !== 'overdue').length
  return (
    <Card pad={false}>
      <div className="grid grid-cols-2 gap-4 px-4 py-3 md:grid-cols-4 md:px-5">
        <Stat label="Planned end" value={fmtDate(s.project_end)} sub={s.cpm_finish ? `Tasks end ${fmtDate(s.cpm_finish)}` : undefined} danger={!!s.cpm_finish && s.cpm_finish > s.project_end} />
        <Stat label="Forecast end" value={fmtDate(s.forecast_finish)} sub={late ? `+${late}d late` : 'On plan'} danger={late > 0} />
        <Stat label="Critical tasks open" value={String(s.tasks.filter((t) => t.critical && t.status !== 'done').length)} sub={`of ${s.tasks.length} tasks`} />
        <Stat label="Breached" value={String(breached)} sub={[`${atRisk} forecast late or blocked`, s.conflicts.length ? `${s.conflicts.length} dependency conflict${s.conflicts.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ')} danger={breached > 0} />
      </div>
    </Card>
  )
}
function Stat({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[12px] font-medium leading-tight text-ink-3">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap text-[18px] font-semibold tracking-[-0.01em]', danger ? 'text-danger-text' : 'text-ink')}>{value}</div>
      {sub && <div className={cn('text-[12px]', danger ? 'text-danger-text' : 'text-ink-3')}>{sub}</div>}
    </div>
  )
}

/* ---------------------------------------------------------------- */
/* Gantt (SVG, no library)                                           */
/* ---------------------------------------------------------------- */
type Row = { kind: 'ms'; id: string; label: string; code: string; ms: Schedule['milestones'][number] | null } | { kind: 'task'; t: ScheduleTask }

function Gantt({ s }: { s: Schedule }) {
  const openTask = useUI((x) => x.openTask)
  const [zoom, setZoom] = useState<Zoom>(() => (diffDays(s.to, s.from) > 150 ? 'month' : 'week'))
  const px = PX[zoom]
  const days = diffDays(s.to, s.from) + 1
  const W = Math.max(320, Math.round(days * px))
  const x = (d: string) => diffDays(d, s.from) * px
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    for (const m of s.milestones) {
      out.push({ kind: 'ms', id: m.id, label: m.name, code: `M${m.no}`, ms: m })
      for (const t of s.tasks.filter((t) => t.milestone_id === m.id)) out.push({ kind: 'task', t })
    }
    const orphan = s.tasks.filter((t) => !t.milestone_id)
    if (orphan.length) {
      out.push({ kind: 'ms', id: 'none', label: 'No milestone', code: '—', ms: null })
      for (const t of orphan) out.push({ kind: 'task', t })
    }
    return out
  }, [s])
  const yOf = new Map<string, number>()
  let y = 0
  const tops: number[] = []
  for (const r of rows) {
    tops.push(y)
    if (r.kind === 'task') yOf.set(r.t.id, y + ROW / 2)
    y += r.kind === 'ms' ? MS_ROW : ROW
  }
  const H = y
  const byId = new Map(s.tasks.map((t) => [t.id, t]))
  const critSet = new Set(s.critical_path)

  // header ticks
  const months: { x: number; label: string }[] = []
  const ticks: { x: number; label: string; weekend?: boolean }[] = []
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) {
    const dt = parseISO(d)
    if (dt.getDate() === 1 || d === s.from) months.push({ x: x(d), label: dt.toLocaleDateString('en-IN', { month: 'short', year: zoom === 'month' || dt.getMonth() === 0 || d === s.from ? '2-digit' : undefined }) })
    if (zoom === 'day') ticks.push({ x: x(d), label: String(dt.getDate()), weekend: dt.getDay() === 0 })
    else if (zoom === 'week' && dt.getDay() === 1) ticks.push({ x: x(d), label: String(dt.getDate()) })
  }
  const todayX = x(s.today) + px / 2
  const showToday = s.today >= s.from && s.today <= s.to
  // month labels: shift right past the Today pill if they collide, hide if there's no room before the next month
  const monthLabels = months.map((m, i) => {
    const w = m.label.length * 6.8 + 4
    let lx = m.x + 5
    const next = months[i + 1]?.x ?? W
    if (showToday && lx < todayX + 22 && lx + w > todayX - 22) lx = todayX + 24
    return { ...m, lx, hidden: lx + w > next - 2 || lx + w > W }
  })
  const barColor = (t: ScheduleTask) => (t.status === 'done' ? (t.done_on && t.done_on > t.due_on ? 'var(--warning)' : 'var(--success)') : t.breach ? 'var(--danger)' : 'var(--brand)')

  return (
    <Card pad={false}>
      <div className="flex flex-col gap-3 p-4 pb-3 md:flex-row md:items-start md:justify-between md:p-5 md:pb-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold">Schedule</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Planned bars use your dates as entered; filled bars are actual or forecast. Tap a task for details.</p>
        </div>
        <Segmented size="sm" value={zoom} onChange={setZoom} options={[{ value: 'day', label: 'Days' }, { value: 'week', label: 'Weeks' }, { value: 'month', label: 'Months' }]} />
      </div>
      <div className="space-y-2 px-4 pb-3 md:px-5">
        <Legend
          items={[
            { label: 'Planned', swatch: <span className="h-2.5 w-5 rounded-[3px] border-[1.5px] border-ink-3" /> },
            { label: 'Critical', swatch: <span className="h-2.5 w-5 rounded-[3px] border-[1.5px] border-danger" /> },
            { label: 'Actual or forecast', swatch: <span className="h-2.5 w-5 rounded-[3px] bg-brand" /> },
            { label: 'Breach', swatch: <span className="h-2.5 w-5 rounded-[3px] bg-danger" /> },
            { label: 'Today', swatch: <span className="h-3 w-px bg-brand" /> },
            { label: 'Baseline', swatch: <span className="h-3 w-0 border-l-[1.5px] border-dashed border-ink-3" /> },
            { label: 'Milestone deadline', swatch: <span className="size-2.5 rotate-45 border-[1.5px] border-ink-2" /> },
            { label: 'Forecast / achieved', swatch: <span className="size-2.5 rotate-45 bg-warning" /> },
          ]}
        />
        <CriticalPathText s={s} />
      </div>
      <div className="relative overflow-x-auto border-t border-line scroll-thin" role="region" aria-label="Gantt chart" tabIndex={0}>
        <div className="flex min-w-max">
          {/* sticky label column */}
          <div className="sticky left-0 z-[2] w-[136px] shrink-0 border-r border-line bg-surface md:w-[260px]">
            <div style={{ height: HEAD }} className="flex items-end border-b border-line bg-surface-2/70 px-3 pb-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
              Task
            </div>
            {rows.map((r, i) =>
              r.kind === 'ms' ? (
                <div key={r.id + i} style={{ height: MS_ROW }} className="flex items-center gap-1.5 border-b border-line bg-surface-2/70 px-3">
                  <span className="tnum shrink-0 text-[12px] font-semibold text-ink-2">{r.code}</span>
                  <span className="truncate text-[13px] font-semibold text-ink">{r.label}</span>
                </div>
              ) : (
                <button
                  type="button"
                  key={r.t.id}
                  onClick={() => openTask(r.t.id)}
                  style={{ height: ROW }}
                  className="flex w-full items-center gap-1.5 border-b border-line pl-5 pr-3 text-left hover:bg-surface-2"
                  title={`${r.t.wbs} ${r.t.title}`}
                >
                  <span className={cn('tnum w-7 shrink-0 text-[12px]', r.t.critical && r.t.status !== 'done' ? 'text-danger-text' : 'text-ink-3')}>{r.t.wbs}</span>
                  <span className={cn('truncate text-[13px]', r.t.status === 'done' ? 'text-ink-3 line-through' : 'text-ink')}>{r.t.title}</span>
                </button>
              ),
            )}
          </div>
          {/* chart */}
          <svg width={W} height={HEAD + H} className="block shrink-0 select-none" role="img" aria-label="Planned and forecast bars per task">
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--ink-3)" />
              </marker>
              <marker id="gantt-arrow-crit" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
              </marker>
            </defs>
            {/* header */}
            <rect x={0} y={0} width={W} height={HEAD} fill="var(--surface)" />
            {monthLabels.map((m, i) => (
              <g key={i}>
                <line x1={m.x} x2={m.x} y1={0} y2={HEAD + H} stroke="var(--line-strong)" />
                {!m.hidden && (
                  <text x={m.lx} y={17} fontSize={11.5} fontWeight={600} fill="var(--ink-2)">
                    {m.label}
                  </text>
                )}
              </g>
            ))}
            {ticks.map((t, i) => (
              <g key={i}>
                {t.weekend && <rect x={t.x} y={HEAD} width={px} height={H} fill="var(--surface-2)" opacity={0.7} />}
                <text x={t.x + (zoom === 'day' ? px / 2 : 2)} y={37} fontSize={10.5} textAnchor={zoom === 'day' ? 'middle' : 'start'} fill="var(--ink-3)" className="tnum">
                  {t.label}
                </text>
                {zoom === 'week' && <line x1={t.x} x2={t.x} y1={HEAD} y2={HEAD + H} stroke="var(--line)" />}
              </g>
            ))}
            <line x1={0} x2={W} y1={HEAD - 0.5} y2={HEAD - 0.5} stroke="var(--line)" />
            <g transform={`translate(0 ${HEAD})`}>
              {/* row backgrounds */}
              {rows.map((r, i) => (
                <g key={i}>
                  {r.kind === 'ms' && <rect x={0} y={tops[i]} width={W} height={MS_ROW} fill="var(--surface-2)" opacity={0.6} />}
                  <line x1={0} x2={W} y1={tops[i] + (r.kind === 'ms' ? MS_ROW : ROW) - 0.5} y2={tops[i] + (r.kind === 'ms' ? MS_ROW : ROW) - 0.5} stroke="var(--line)" />
                </g>
              ))}
              {/* dependency arrows */}
              {s.tasks.flatMap((t) =>
                t.deps.map((dep) => {
                  const p = byId.get(dep)
                  if (!p || !yOf.has(t.id) || !yOf.has(dep)) return null
                  const x1 = x(p.due_on) + px
                  const y1 = yOf.get(dep)!
                  const x2 = x(t.start_on)
                  const y2 = yOf.get(t.id)!
                  const crit = critSet.has(t.id) && critSet.has(dep)
                  const midX = Math.max(x1 + 6, Math.min(x2 - 6, x1 + 10))
                  const path = x2 >= x1 + 12 ? `M${x1},${y1} H${midX} V${y2} H${x2 - 1}` : `M${x1},${y1} h6 V${y1 + (y2 > y1 ? ROW / 2 : -ROW / 2)} H${x2 - 8} V${y2} H${x2 - 1}`
                  return <path key={t.id + dep} d={path} fill="none" stroke={crit ? 'var(--danger)' : 'var(--ink-3)'} strokeWidth={crit ? 1.4 : 1} opacity={crit ? 0.85 : 0.55} markerEnd={`url(#${crit ? 'gantt-arrow-crit' : 'gantt-arrow'})`} />
                }),
              )}
              {/* bars */}
              {rows.map((r, i) => {
                if (r.kind === 'ms') {
                  if (!r.ms) return null
                  const m = r.ms
                  const cy = tops[i] + MS_ROW / 2
                  const dx = x(m.planned_end) + px / 2
                  const f = m.achieved_on ?? m.forecast_end
                  const fx = f ? x(f) + px / 2 : null
                  const tone = MS_STATE[m.state].tone
                  const color = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--info)'
                  return (
                    <g key={r.id}>
                      <line x1={x(m.planned_start)} x2={x(m.planned_end) + px} y1={cy} y2={cy} stroke="var(--ink-3)" strokeWidth={2} opacity={0.35} strokeLinecap="round" />
                      {m.baseline_end !== m.planned_end && <rect x={x(m.baseline_end) + px / 2 - 4} y={cy - 4} width={8} height={8} transform={`rotate(45 ${x(m.baseline_end) + px / 2} ${cy})`} fill="none" stroke="var(--ink-3)" strokeDasharray="2 2" />}
                      <rect x={dx - 5.5} y={cy - 5.5} width={11} height={11} transform={`rotate(45 ${dx} ${cy})`} fill="var(--surface)" stroke="var(--ink-2)" strokeWidth={1.6} />
                      {fx !== null && Math.abs(fx - dx) > 1 && <rect x={fx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${fx} ${cy})`} fill={color} />}
                      {fx !== null && Math.abs(fx - dx) <= 1 && <rect x={dx - 3} y={cy - 3} width={6} height={6} transform={`rotate(45 ${dx} ${cy})`} fill={color} />}
                      <title>{`M${m.no} ${m.name}: deadline ${fmtDate(m.planned_end)}${f ? `, ${m.achieved_on ? 'achieved' : 'forecast'} ${fmtDate(f)}` : ''} · ${MS_STATE[m.state].label}`}</title>
                    </g>
                  )
                }
                const t = r.t
                const top = tops[i]
                const px1 = x(t.start_on)
                const pw = Math.max(px, x(t.due_on) + px - px1)
                const f1 = x(t.forecast_start)
                const fend = t.status === 'done' ? t.done_on ?? t.due_on : t.forecast_end
                const fw = Math.max(px * 0.8, x(fend) + px - f1)
                const crit = t.critical && t.status !== 'done'
                return (
                  <g key={t.id} className="cursor-pointer" onClick={() => openTask(t.id)}>
                    <rect x={px1} y={top + 6} width={pw} height={ROW - 12} rx={4} fill="none" stroke={crit ? 'var(--danger)' : 'var(--ink-3)'} strokeWidth={crit ? 1.6 : 1.1} opacity={crit ? 1 : 0.7} />
                    <rect x={f1} y={top + 11} width={fw} height={ROW - 22} rx={3} fill={barColor(t)} opacity={t.status === 'done' ? 0.9 : 0.78} />
                    {t.status !== 'done' && fend > t.due_on && <line x1={x(t.due_on) + px} x2={x(t.due_on) + px} y1={top + 5} y2={top + ROW - 5} stroke="var(--danger)" strokeWidth={1.5} />}
                    {t.baseline_due_on && t.baseline_due_on !== t.due_on && <line x1={x(t.baseline_due_on) + px} x2={x(t.baseline_due_on) + px} y1={top + 3} y2={top + ROW - 3} stroke="var(--ink-3)" strokeWidth={1.2} strokeDasharray="2 2"><title>{`Baseline end ${fmtDate(t.baseline_due_on)}`}</title></line>}
                    {zoom !== 'month' && (
                      <text x={Math.max(px1 + pw, f1 + fw) + 5} y={top + ROW / 2 + 4} fontSize={10.5} fill={crit ? 'var(--danger)' : 'var(--ink-3)'} className="tnum" fontWeight={crit ? 600 : 400}>
                        {fmtDate(fend)}
                      </text>
                    )}
                    <title>{`${t.wbs} ${t.title} · ${t.stage.replace(/_/g, ' ')} ${t.progress}%\nPlanned ${fmtDate(t.start_on)} – ${fmtDate(t.due_on)}\n${t.status === 'done' ? 'Done' : 'Forecast'} ${fmtDate(t.forecast_start)} – ${fmtDate(fend)}\nFloat ${t.float_days} working day${t.float_days === 1 ? '' : 's'}${t.breach ? `\n${t.breach.message}` : ''}`}</title>
                  </g>
                )
              })}
              {/* today */}
              {showToday && (
                <g>
                  <line x1={todayX} x2={todayX} y1={-HEAD + 20} y2={H} stroke="var(--brand)" strokeWidth={1.25} />
                  <rect x={todayX - 20} y={-HEAD + 4} width={40} height={16} rx={3} fill="var(--brand)" />
                  <text x={todayX} y={-HEAD + 15.5} fontSize={10.5} fontWeight={600} textAnchor="middle" fill="var(--surface)">
                    Today
                  </text>
                </g>
              )}
            </g>
          </svg>
        </div>
      </div>
    </Card>
  )
}

/* ---------------------------------------------------------------- */
/* Critical path                                                      */
/* ---------------------------------------------------------------- */
function CriticalPath({ s }: { s: Schedule }) {
  const openTask = useUI((x) => x.openTask)
  const byId = new Map(s.tasks.map((t) => [t.id, t]))
  const perMs = s.milestones
    .map((m) => ({ m, crit: s.tasks.filter((t) => t.milestone_id === m.id && t.critical), next: s.tasks.filter((t) => t.milestone_id === m.id && !t.critical).sort((a, b) => a.float_days - b.float_days)[0] }))
    .filter((x) => x.crit.length)
  return (
    <Card>
      <CardHeader title="Critical path" subtitle="In each milestone, tasks with no float set the deadline. A predecessor that pushes a critical task is critical too." />
      {s.critical_path.length > 0 && (
        <>
          <div className="mb-1.5 text-[12.5px] font-medium text-ink-2">Longest dependency chain to the end</div>
          <div className="mb-4 flex min-w-0 flex-wrap items-center gap-1">
            {s.critical_path.map((id, i) => {
              const t = byId.get(id)
              if (!t) return null
              return (
                <span key={id} className="inline-flex min-w-0 max-w-full items-center gap-1">
                  {i > 0 && <ChevronRight className="size-3.5 text-ink-3" />}
                  <button
                    type="button"
                    onClick={() => openTask(id)}
                    className={cn('inline-flex h-6 min-w-0 max-w-[220px] items-center gap-1 rounded-sm px-2 text-[12px] transition hover:brightness-95', t.status === 'done' ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text')}
                  >
                    <span className="tnum shrink-0 font-medium">{t.wbs}</span>
                    <span className="truncate">{t.title}</span>
                  </button>
                </span>
              )
            })}
          </div>
          <p className="-mt-2 mb-4 text-[12.5px] text-ink-3">Ends {fmtDate(s.cpm_finish)}{s.forecast_finish && s.forecast_finish !== s.cpm_finish ? ` · forecast ${fmtDate(s.forecast_finish)}` : ''}.</p>
        </>
      )}
      <ul className="divide-y divide-line rounded-lg border border-line">
        {perMs.map(({ m, crit, next }) => (
          <li key={m.id} className="px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium">
                M{m.no} {m.name}
              </span>
              <span className="tnum shrink-0 whitespace-nowrap text-[12px] text-ink-3">Due {fmtDate(m.planned_end)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px]">
              {crit.map((t) => (
                <button type="button" key={t.id} onClick={() => openTask(t.id)} className={cn('min-w-0 text-left hover:underline', t.status === 'done' ? 'text-ink-3' : 'text-danger-text')}>
                  <span className="tnum font-medium">{t.wbs}</span> {t.title}
                  {t.status === 'done' ? ' ✓' : ` · ends ${fmtDate(t.due_on)}`}
                </button>
              ))}
            </div>
            {next && <div className="mt-0.5 text-[12px] text-ink-3">Next closest: {next.wbs} with {next.float_days} working day{next.float_days === 1 ? '' : 's'} of float</div>}
          </li>
        ))}
      </ul>
      {(s.conflicts.length > 0 || s.cycles.length > 0) && (
        <div className="mt-4 space-y-2">
          <div className="text-[12.5px] font-medium text-ink-2">Dependency conflicts</div>
          {s.cycles.length > 0 && <Callout tone="danger" icon={<AlertTriangle />}>Circular dependency between {s.cycles.join(', ')}. Remove one link.</Callout>}
          {s.conflicts.slice(0, 6).map((c) => (
            <Callout key={c.task_id + c.depends_on_id} tone="warning" icon={<AlertTriangle />}>
              {c.message}
            </Callout>
          ))}
        </div>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------- */
/* Breaches with one-click actions                                   */
/* ---------------------------------------------------------------- */
function Breaches({ s, d }: { s: Schedule; d: ProjectDetail }) {
  const list = s.tasks.filter((t) => t.breach).sort((a, b) => (a.breach!.kind === 'overdue' ? 0 : 1) - (b.breach!.kind === 'overdue' ? 0 : 1) || a.due_on.localeCompare(b.due_on))
  return (
    <Card>
      <CardHeader title="Breaches and forecast risks" subtitle="Tasks overdue, blocked, or forecast to end after their due date or milestone deadline." action={list.length ? <Badge tone="danger">{list.length}</Badge> : undefined} />
      {!list.length ? (
        <EmptyState compact title="Nothing on the schedule is at risk" body="Every open task is forecast to finish by its due date and milestone deadline." />
      ) : (
        <ul className="space-y-2">
          {list.map((t) => (
            <BreachRow key={t.id} t={t} d={d} canEdit={s.can_edit} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function BreachRow({ t, d, canEdit }: { t: ScheduleTask; d: ProjectDetail; canEdit: boolean }) {
  const openTask = useUI((x) => x.openTask)
  const readOnly = useReadOnly()
  const people = usePeopleMap()
  const { askReason } = useConfirm()
  const [ownerOpen, setOwnerOpen] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const [due, setDue] = useState(t.forecast_end > t.due_on ? t.forecast_end : t.due_on)
  const [dueReason, setDueReason] = useState('')
  const inv = [['project', d.project.id], ['projects'], ['task', t.id], ['my-tasks']]
  const taskVersion = d.tasks.find((x) => x.id === t.id)?.version
  const patch = useMut((b: { owner_id?: string | null; due_on?: string; due_change_reason?: string }) => tasksApi.update(t.id, b, taskVersion), {
    invalidate: inv,
    success: (_r, b) => (b.owner_id ? `${t.wbs} reassigned to ${people.get(b.owner_id)?.name ?? 'new owner'}` : `${t.wbs} now due ${fmtDate(b.due_on)}`),
    onSuccess: () => {
      setOwnerOpen(false)
      setDateOpen(false)
    },
  })
  const block = useMut((reason: string) => tasksApi.setStatus(t.id, 'blocked', reason), { invalidate: inv, success: `${t.wbs} marked blocked` })
  const tone = t.breach!.kind === 'overdue' || t.breach!.kind === 'blocked' ? 'danger' : 'warning'
  const editable = canEdit && !readOnly
  return (
    <li className="rounded-lg border border-line p-3">
      <button type="button" onClick={() => openTask(t.id)} className="block w-full text-left">
        <div className="flex items-start gap-2">
          <span className="tnum mt-px shrink-0 text-[12px] text-ink-3">{t.wbs}</span>
          <span className="min-w-0 flex-1 text-[13.5px] font-medium leading-snug text-ink">{t.title}</span>
          <StatusBadge map={TASK_STATUS} value={t.status} size="sm" />
        </div>
        <p className={cn('mt-1 text-[12.5px]', tone === 'danger' ? 'text-danger-text' : 'text-warning-text')}>{t.breach!.message}</p>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-3">
          <PersonName id={t.owner_id} size={18} />
          <span className="tnum whitespace-nowrap">· {Math.round(t.remaining_hours * 10) / 10}h left</span>
        </div>
      </button>
      {editable && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <Popover
            open={ownerOpen}
            onOpenChange={setOwnerOpen}
            className="w-[300px]"
            trigger={
              <Button size="xs" icon={<UserRound className="size-3.5" />}>
                Reassign
              </Button>
            }
          >
            <Field label="New owner">
              <PeoplePicker value={t.owner_id} onChange={(v) => v && v !== t.owner_id && patch.mutate({ owner_id: v })} filter={(p) => p.department === 'delivery' || p.department === 'management'} />
            </Field>
            <p className="mt-2 text-[12px] text-ink-3">They get a “task assigned” notification.</p>
          </Popover>
          <Popover
            open={dateOpen}
            onOpenChange={setDateOpen}
            className="w-[260px]"
            trigger={
              <Button size="xs" icon={<CalendarClock className="size-3.5" />}>
                Move due date
              </Button>
            }
          >
            <Field label="Due date" hint={t.forecast_end > t.due_on ? `Forecast end is ${fmtDate(t.forecast_end)}.` : undefined}>
              <Input type="date" value={due} min={t.start_on} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Why is it moving?" className="mt-2" hint="At least 10 characters. Kept in the task history.">
              <Textarea rows={2} value={dueReason} onChange={(e) => setDueReason(e.target.value)} placeholder="e.g. Waiting on client test data" />
            </Field>
            <Button size="sm" variant="primary" block className="mt-3" loading={patch.isPending} disabled={!due || due === t.due_on || dueReason.trim().length < 10} onClick={() => patch.mutate({ due_on: due, due_change_reason: dueReason.trim() })}>
              Save due date
            </Button>
          </Popover>
          {t.status !== 'blocked' && (
            <Button
              size="xs"
              variant="outline-danger"
              icon={<AlertTriangle className="size-3.5" />}
              loading={block.isPending}
              onClick={async () => {
                const r = await askReason({ title: `Block ${t.wbs}?`, body: 'Say what it’s waiting for so it shows on the PM’s risk list.', label: 'Blocked because', minLength: 3, confirmLabel: 'Mark blocked' })
                if (r) block.mutate(r)
              }}
            >
              Mark blocked
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

export { MsStateBadge }
