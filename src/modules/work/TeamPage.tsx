import { useMemo, useState } from 'react'
import { useApi } from '@/api/query'
import { workApi, type TeamCellStatus, type TeamGrid } from '@/api/work'
import { addDays, fmtDate, todayISO, weekLabel, weekStart } from '@/domain/calendar'
import { fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { Avatar, Badge, Card, CardHeader, EmptyState, ErrorState, FilterChips, PageHeader, SearchInput, Select, Sheet, Skeleton, SkeletonRows, StatCard, Tooltip } from '@/ui'
import { WeekDetail } from './ApprovalsPage'

type Person = TeamGrid['people'][number]
type Cell = Person['cells'][number]

/** Approved weeks read as plain numbers; only exceptions carry a tint, so problems stand out. */
const CELL: Record<TeamCellStatus, { label: string; cls: string; key: string }> = {
  approved: { label: 'Approved', cls: 'text-ink', key: 'bg-surface ring-1 ring-inset ring-line-strong' },
  submitted: { label: 'Submitted', cls: 'bg-warning-soft text-warning-text', key: 'bg-warning-soft ring-1 ring-inset ring-warning/30' },
  open: { label: 'Draft', cls: 'bg-info-soft text-info-text', key: 'bg-info-soft ring-1 ring-inset ring-info/30' },
  rejected: { label: 'Rejected', cls: 'bg-danger-soft text-danger-text', key: 'bg-danger-soft ring-1 ring-inset ring-danger/30' },
  locked: { label: 'Locked', cls: 'bg-danger-soft text-danger-text', key: 'bg-danger-soft ring-1 ring-inset ring-danger/30' },
  missing: { label: 'Missing', cls: 'text-danger-text ring-1 ring-inset ring-danger/40', key: 'ring-1 ring-inset ring-danger/50' },
  upcoming: { label: 'Not started', cls: 'text-ink-3', key: 'bg-surface-2 ring-1 ring-inset ring-line' },
}
type Filter = 'all' | 'attention' | 'reports'

/** UI-37 — /team: 8-week timesheet grid per person + approval KPI per manager (BR-11). */
export default function TeamPage() {
  const [weeks, setWeeks] = useState(8)
  const q = useApi(['team', 'grid', weeks], () => workApi.teamGrid(weeks))
  const me = useSession((s) => s.user)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<{ user: Person['user']; week: string; status: TeamCellStatus; hours: number } | null>(null)
  const d = q.data
  const thisMon = weekStart(todayISO())

  const needsAttention = (p: Person) => p.cells.some((c) => c.status === 'missing' || c.status === 'locked' || c.status === 'rejected')
  const people = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (d?.people ?? []).filter(
      (p) => (!s || p.user.name.toLowerCase().includes(s) || p.user.title.toLowerCase().includes(s)) && (filter === 'all' || (filter === 'attention' ? needsAttention(p) : p.user.reports_to_id === me?.id)),
    )
  }, [d, search, filter, me?.id])

  const kpi = useMemo(() => {
    if (!d) return null
    const closed = d.weeks.filter((w) => addDays(w, 6) < todayISO())
    let total = 0
    let ok = 0
    for (const p of d.people)
      for (const c of p.cells)
        if (closed.includes(c.week_start)) {
          total++
          if (c.status === 'approved' || c.status === 'submitted') ok++
        }
    const utils = d.people.map((p) => p.utilisation).filter((u): u is number => u !== null)
    const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : null
    const pending = d.managers.reduce((s, m) => s + m.pending, 0)
    const overdue = d.managers.reduce((s, m) => s + m.overdue, 0)
    const missingNow = d.people.filter((p) => p.cells.some((c) => c.status === 'missing' || c.status === 'locked')).length
    return { compliance: total ? ok / total : null, avgUtil, pending, overdue, missingNow }
  }, [d])

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Timesheet compliance, utilisation and approval discipline across your people."
        actions={
          <Select
            className="w-full md:w-[160px]"
            value={String(weeks)}
            onChange={(e) => setWeeks(Number(e.target.value))}
            options={[
              { value: '4', label: 'Last 4 weeks' },
              { value: '8', label: 'Last 8 weeks' },
              { value: '12', label: 'Last 12 weeks' },
            ]}
          />
        }
      />
      {q.isLoading ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}
          </div>
          <SkeletonRows rows={8} className="mt-6" />
        </>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d && kpi ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Submitted on time" value={kpi.compliance === null ? '—' : fmtPct(kpi.compliance, 0)} tone={kpi.compliance !== null && kpi.compliance < 0.8 ? 'warning' : undefined} hint="Share of finished weeks that were submitted or approved." />
            <StatCard label="Utilisation this week" value={kpi.avgUtil === null ? '—' : fmtPct(kpi.avgUtil, 0)} hint="Task hours ÷ capacity (working days so far × minimum hours), averaged across people." />
            <StatCard label="Approvals waiting" value={kpi.pending} sub={kpi.overdue ? `${kpi.overdue} overdue` : 'None overdue'} tone={kpi.overdue ? 'danger' : undefined} />
            <StatCard label="People with gaps" value={kpi.missingNow} tone={kpi.missingNow ? 'warning' : undefined} hint="Someone with a missing, locked or rejected week in this window." />
          </div>

          <div className="mt-5 grid gap-5 2xl:grid-cols-[minmax(0,1fr)_300px]">
            {/* grid */}
            <Card pad={false} className="min-w-0">
              <div className="flex flex-col gap-3 border-b border-line px-4 py-3.5 lg:flex-row lg:flex-wrap lg:items-center">
                <div className="min-w-0 flex-1 lg:basis-[220px]">
                  <h2 className="text-[14px] font-semibold">Timesheet status by week</h2>
                  <p className="text-[12.5px] text-ink-3">Hours per week. Select a week to open it read-only.</p>
                </div>
                <FilterChips
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'Everyone', count: d.people.length },
                    { value: 'attention', label: 'Needs attention', count: d.people.filter(needsAttention).length },
                    { value: 'reports', label: 'My reports', count: d.people.filter((p) => p.user.reports_to_id === me?.id).length },
                  ]}
                />
                <SearchInput value={search} onChange={setSearch} placeholder="Search people" className="lg:w-[200px]" />
              </div>
              {!people.length ? (
                <EmptyState compact title="No one matches" body="Try another name or switch the filter." />
              ) : (
                <>
                  {/* desktop / tablet */}
                  <div className="hidden overflow-x-auto scroll-thin md:block">
                    <table className="w-full border-collapse text-[13px]">
                      <thead>
                        <tr className="border-b border-line bg-surface-2 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                          <th className="sticky left-0 z-[1] min-w-[220px] bg-surface-2 px-4 py-2 text-left">Person</th>
                          {d.weeks.map((w) => (
                            <th key={w} className={cn('w-[72px] min-w-[72px] whitespace-nowrap px-1 py-2 text-right', w === thisMon && 'text-brand-text')}>
                              <span className="pr-2">{w === thisMon ? 'This wk' : fmtDate(w)}</span>
                            </th>
                          ))}
                          <th className="w-[88px] min-w-[88px] whitespace-nowrap px-4 py-2 text-right">Util.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {people.map((p) => (
                          <tr key={p.user.id} className="group border-b border-line last:border-0 hover:bg-surface-2/40">
                            <td className="sticky left-0 z-[1] bg-surface px-4 py-2 group-hover:bg-surface-2">
                              <div className="flex items-center gap-2.5">
                                <Avatar name={p.user.name} hue={p.user.avatar_hue} size={26} />
                                <div className="min-w-0 max-w-[220px]">
                                  <div className="truncate font-medium text-ink">{p.user.name}</div>
                                  <div className="truncate text-[12px] text-ink-3">{p.user.title}</div>
                                </div>
                              </div>
                            </td>
                            {p.cells.map((c) => (
                              <td key={c.week_start} className="px-1 py-1.5 text-right">
                                <CellChip c={c} onOpen={() => setOpen({ user: p.user, week: c.week_start, status: c.status, hours: c.hours })} />
                              </td>
                            ))}
                            <td className="px-4 py-2 text-right">
                              <UtilCell u={p.utilisation} hours={p.hours_this_week} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* phone */}
                  <div className="divide-y divide-line md:hidden">
                    {people.map((p) => (
                      <div key={p.user.id} className="p-4">
                        <div className="flex items-center gap-3">
                          <Avatar name={p.user.name} hue={p.user.avatar_hue} size={32} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[14px] font-medium">{p.user.name}</div>
                            <div className="truncate text-[12.5px] text-ink-3">{p.user.title}</div>
                          </div>
                          <UtilCell u={p.utilisation} hours={p.hours_this_week} />
                        </div>
                        <div className="mt-3 grid grid-cols-4 gap-1.5">
                          {p.cells.slice(-8).map((c) => (
                            <button
                              key={c.week_start}
                              type="button"
                              disabled={!c.week_id}
                              onClick={() => setOpen({ user: p.user, week: c.week_start, status: c.status, hours: c.hours })}
                              className={cn('flex h-12 min-w-0 flex-col items-center justify-center rounded-md', c.status === 'approved' ? 'bg-surface-2/70 text-ink' : CELL[c.status].cls)}
                            >
                              <span className="truncate text-[11px] opacity-80">{c.week_start === thisMon ? 'This wk' : fmtDate(c.week_start)}</span>
                              <span className="tnum text-[13px] font-medium">{c.week_id ? fmtNum(c.hours, 1) : CELL[c.status].label === 'Missing' ? '—' : ''}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-line px-4 py-3 text-[12.5px] text-ink-3">
                {(Object.keys(CELL) as TeamCellStatus[]).map((k) => (
                  <span key={k} className="flex items-center gap-1.5">
                    <span className={cn('size-2.5 rounded-sm', CELL[k].key)} />
                    {CELL[k].label}
                  </span>
                ))}
                <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-warning" />Approved late</span>
              </div>
            </Card>

            {/* approval KPI */}
            <Card pad={false} className="self-start">
              <CardHeader className="px-4 pt-4" title="Approval discipline" subtitle="Score = −(late + overdue pending)" />
              {!d.managers.length ? (
                <EmptyState compact title="No approvals in this window" />
              ) : (
                <div className="divide-y divide-line">
                  {d.managers.map((m, i) => (
                    <div key={m.user.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="tnum w-4 shrink-0 text-[12.5px] text-ink-3">{i + 1}</span>
                      <Avatar name={m.user.name} hue={m.user.avatar_hue} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-medium">{m.user.name}</div>
                        <div className="text-[12.5px] text-ink-3">
                          {m.on_time} on time · {m.late} late · {m.pending} pending{m.overdue ? ` (${m.overdue} overdue)` : ''}
                        </div>
                      </div>
                      <Badge tone={m.score === 0 ? 'success' : m.score >= -2 ? 'warning' : 'danger'} className="tnum">
                        {m.score === 0 ? '0' : m.score}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
              <p className="border-t border-line px-4 py-3 text-[12.5px] leading-snug text-ink-3">Late decisions and pending weeks past the SLA count against the approver. They never block anyone.</p>
            </Card>
          </div>
        </>
      ) : null}

      <Sheet
        open={!!open}
        onOpenChange={(o) => !o && setOpen(null)}
        width={880}
        title={open ? `${open.user.name} · ${weekLabel(open.week)}` : ''}
        subtitle={open ? `${CELL[open.status].label} · ${fmtNum(open.hours, 1)}h logged` : undefined}
      >
        {open && <WeekDetail userId={open.user.id} week={open.week} />}
      </Sheet>
    </div>
  )
}

function CellChip({ c, onOpen }: { c: Cell; onOpen: () => void }) {
  const meta = CELL[c.status]
  const clickable = !!c.week_id
  return (
    <Tooltip content={`${weekLabel(c.week_start)} · ${meta.label}${c.week_id ? ` · ${fmtNum(c.hours, 1)}h` : ''}${c.late ? ' · approved late' : ''}`}>
      <button
        type="button"
        onClick={clickable ? onOpen : undefined}
        aria-disabled={!clickable}
        className={cn(
          'relative ml-auto flex h-8 w-[64px] items-center justify-end rounded-md px-2 text-[13px] transition',
          meta.cls,
          clickable ? 'hover:bg-surface-2 hover:ring-1 hover:ring-inset hover:ring-line-strong' : 'cursor-default',
        )}
      >
        {c.late && <span className="mr-1.5 size-1.5 shrink-0 rounded-full bg-warning" aria-label="Approved late" />}
        <span className="tnum">{c.week_id ? fmtNum(c.hours, 1) : c.status === 'missing' ? 'Missing' : '—'}</span>
      </button>
    </Tooltip>
  )
}

function UtilCell({ u, hours }: { u: number | null; hours: number }) {
  if (u === null) return <span className="text-[12px] text-ink-3">—</span>
  const tone = u < 0.8 ? 'text-warning-text' : u > 1.1 ? 'text-danger-text' : 'text-success-text'
  return (
    <div className="text-right">
      <div className={cn('tnum whitespace-nowrap text-[13.5px] font-medium', tone)}>{fmtPct(u, 0)}</div>
      <div className="tnum whitespace-nowrap text-[12px] text-ink-3">{fmtNum(hours, 1)}h</div>
    </div>
  )
}

