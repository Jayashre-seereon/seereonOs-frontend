import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, ExternalLink, Eye, Flag, MessageSquareText, Users } from '@/ui/icons'
import type { ProjectDetail, TaskView } from '@/api/projects'
import { usePeopleMap } from '@/api/core'
import { fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney, fmtPct } from '@/domain/money'
import { STREAM, TASK_STATUS } from '@/domain/labels'
import { useUI } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, KV, PersonName, StatusBadge, Tooltip } from '@/ui'
import { MS_STATE, MsStateBadge } from '../components/shared'
import { StageBadge } from '@/modules/work/taskStage'
import { progressOf, stageOf } from '@/domain/delivery'
import { ProjectReviews } from '../components/ProjectReviews'

export function OverviewTab({ d }: { d: ProjectDetail }) {
  const nav = useNavigate()
  const p = d.project
  const risk = d.tasks.filter((t) => t.risk).sort((a, b) => rank(a) - rank(b) || a.due_on.localeCompare(b.due_on))
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <Card>
          <CardHeader title="About" />
          {p.description ? <p className="max-w-[72ch] text-[14px] leading-relaxed text-ink-2">{p.description}</p> : <p className="text-[13.5px] text-ink-3">No description yet.</p>}
          <KV
            className="mt-4 border-t border-line pt-4"
            cols={4}
            items={[
              { label: 'Revenue stream', value: STREAM[p.stream] },
              { label: 'Start', value: fmtDate(p.start_on) },
              { label: 'Planned end', value: fmtDate(p.end_on), hint: p.baseline_end_on && p.baseline_end_on !== p.end_on ? `Baseline ${fmtDate(p.baseline_end_on)}` : undefined },
              ...(d.metrics.contract_value !== null ? [{ label: 'Contract', value: fmtMoney(d.metrics.contract_value) }] : []),
            ]}
          />
        </Card>
        <MilestoneStrip d={d} />
        <RiskList d={d} tasks={risk} />
      </div>
      <div className="min-w-0 space-y-4">
        <ProjectReviews d={d} />
        <Team d={d} />
        <Updates d={d} />
      </div>
    </div>
  )
}

const rank = (t: TaskView) => (t.risk === 'overdue' ? 0 : t.risk === 'blocked' ? 1 : 2)

function MilestoneStrip({ d }: { d: ProjectDetail }) {
  const today = todayISO()
  if (!d.milestones.length)
    return (
      <Card>
        <CardHeader title="Milestones" />
        <EmptyState compact title="No milestones yet" body="Add milestones in the WBS tab or import a WBS." action={d.can_edit ? <Link to={`/projects/${d.project.id}/wbs`} className="text-[13px] font-medium text-brand-text hover:underline">Go to WBS</Link> : undefined} />
      </Card>
    )
  const first = d.milestones[0].planned_start < d.project.start_on ? d.milestones[0].planned_start : d.project.start_on
  const last = d.milestones.reduce((m, x) => (x.planned_end > m ? x.planned_end : m), d.project.end_on)
  const span = Math.max(1, (new Date(last).getTime() - new Date(first).getTime()) / 864e5)
  const pos = (s: string) => Math.max(0, Math.min(100, ((new Date(s).getTime() - new Date(first).getTime()) / 864e5 / span) * 100))
  return (
    <Card>
      <CardHeader title="Milestones" subtitle={`${d.milestones.filter((m) => m.state.startsWith('achieved')).length} of ${d.milestones.length} achieved`} action={<Link to={`/projects/${d.project.id}/wbs`} className="text-[13px] font-medium text-brand-text hover:underline">Open WBS</Link>} />
      {/* timeline strip (md+) */}
      <div className="relative mb-5 hidden h-10 md:block" aria-hidden>
        <div className="absolute inset-x-0 top-[18px] h-px bg-line-strong" />
        {today >= first && today <= last && <div className="absolute top-2 h-5 w-px bg-brand" style={{ left: `${pos(today)}%` }} />}
        {d.milestones.map((m) => {
          const tone = MS_STATE[m.state].tone
          const bg = tone === 'success' ? 'bg-success' : tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : tone === 'info' ? 'bg-info' : 'bg-ink-3'
          return (
            <Tooltip key={m.id} content={`M${m.no} ${m.name} · ${fmtDate(m.planned_end)} · ${MS_STATE[m.state].label}`}>
              <span className="absolute top-[13px] -translate-x-1/2" style={{ left: `${pos(m.planned_end)}%` }}>
                <span className={cn('block size-3 rotate-45 rounded-[2px]', bg)} />
                <span className="tnum absolute left-1/2 top-5 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-ink-3">M{m.no}</span>
              </span>
            </Tooltip>
          )
        })}
      </div>
      <ul className="-mx-1 divide-y divide-line">
        {d.milestones.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-1 py-2.5">
            <span className="tnum w-8 shrink-0 text-[12px] font-medium text-ink-3">M{m.no}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px]">{m.name}</div>
              <div className="tnum text-[12px] text-ink-3">
                Deadline {fmtDate(m.planned_end)}
                {m.slip > 0 && <span className="ml-1 font-semibold text-danger-text">+{m.slip}d</span>}
                {m.end_on && <span className={cn(m.end_on > m.planned_end && 'font-semibold text-danger-text')}> · {m.end_kind} {fmtDate(m.end_on)}</span>} · {fmtPct(m.progress, 0)}
              </div>
            </div>
            <MsStateBadge state={m.state} size="sm" />
          </li>
        ))}
      </ul>
    </Card>
  )
}

function RiskList({ d, tasks }: { d: ProjectDetail; tasks: TaskView[] }) {
  const openTask = useUI((s) => s.openTask)
  return (
    <Card>
      <CardHeader title="Tasks at risk" subtitle="Overdue, blocked, or due within 3 days and not started." action={tasks.length ? <Badge tone="danger">{tasks.length}</Badge> : undefined} />
      {!tasks.length ? (
        <EmptyState compact title="Nothing at risk" body="Every open task is on schedule." />
      ) : (
        <ul className="-mx-1 divide-y divide-line">
          {tasks.slice(0, 8).map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => openTask(t.id)} className="flex w-full items-center gap-3 rounded-md px-1 py-2.5 text-left hover:bg-surface-2/60">
                <span className="tnum w-8 shrink-0 text-[12px] font-medium text-ink-3">{t.wbs}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{t.title}</span>
                  <span className={cn('block text-[12px]', t.risk === 'overdue' ? 'text-danger-text' : t.risk === 'blocked' ? 'text-danger-text' : 'text-warning-text')}>
                    {t.risk === 'overdue' ? `Overdue since ${fmtDate(t.due_on)}` : t.risk === 'blocked' ? (t.blockers.length ? `Waits on ${t.blockers.map((b) => b.wbs).join(', ')}` : t.blocked_reason ?? 'Blocked') : `Due ${fmtDate(t.due_on)}, not started`}
                  </span>
                </span>
                <span className="shrink-0"><StageBadge stage={stageOf(t)} progress={progressOf(t)} /></span>
                <span className="hidden w-[150px] shrink-0 2xl:block"><PersonName id={t.owner_id} withAvatar size={22} className="max-w-full" /></span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {tasks.length > 8 && <Link to={`/projects/${d.project.id}/schedule`} className="mt-2 inline-block text-[13px] font-medium text-brand-text hover:underline">See all {tasks.length} on the schedule</Link>}
    </Card>
  )
}

function Team({ d }: { d: ProjectDetail }) {
  const people = usePeopleMap()
  const today = todayISO()
  const rows = d.team_ids
    .map((id) => {
      const p = people.get(id)
      const now = d.allocations.filter((a) => a.user_id === id && a.from_on <= today && a.to_on >= today).reduce((s, a) => s + a.pct, 0)
      const open = d.tasks.filter((t) => t.owner_id === id && t.status !== 'done').length
      return { id, p, now, open }
    })
    .filter((x) => x.p)
    .sort((a, b) => b.now - a.now || b.open - a.open)
  return (
    <Card>
      <CardHeader title="Team" subtitle="Allocation on this project today" action={<Link to={`/projects/${d.project.id}/team`} className="text-[13px] font-medium text-brand-text hover:underline">Manage</Link>} />
      {!rows.length ? (
        <EmptyState compact title="No team yet" body="Assign task owners or allocate people." />
      ) : (
        <ul className="-my-1 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[28px_minmax(0,1fr)_44px] items-center gap-3 py-2">
              <Avatar name={r.p!.name} hue={r.p!.avatar_hue} size={28} />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13.5px] font-medium">{r.p!.name}</span>
                  {r.id === d.project.pm_id && <Badge size="sm" tone="neutral">PM</Badge>}
                </div>
                <div className="truncate text-[12px] text-ink-3">{r.p!.title}</div>
                <div className="text-[12px] text-ink-3">{r.open} open task{r.open === 1 ? '' : 's'}</div>
              </div>
              <span className={cn('tnum whitespace-nowrap text-right text-[13px] font-medium', r.now ? 'text-ink' : 'text-ink-3')}>{r.now ? `${r.now}%` : '—'}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function Updates({ d }: { d: ProjectDetail }) {
  const people = usePeopleMap()
  return (
    <Card>
      <CardHeader title="Recent daily updates" subtitle="From people on this project, last 10 days" />
      {!d.recent_updates.length ? (
        <EmptyState compact title="No updates yet" />
      ) : (
        <ul className="space-y-3.5">
          {d.recent_updates.slice(0, 5).map((u) => {
            const p = people.get(u.user_id)
            return (
              <li key={u.id} className="flex gap-2.5">
                {p && <Avatar name={p.name} hue={p.avatar_hue} size={26} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">{p?.name ?? '—'}</span>
                    <span className="tnum shrink-0 text-[11.5px] text-ink-3">{fmtDate(u.date)}</span>
                  </div>
                  <p className="mt-0.5 line-clamp-3 text-[13px] leading-snug text-ink-2">{u.done}</p>
                  {u.blocker && <p className="mt-1 text-[12.5px] text-danger-text">Blocker: {u.blocker}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {u.proof_url && (
                      <a href={u.proof_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-text hover:underline">
                        Proof <ExternalLink className="size-3" />
                      </a>
                    )}
                    {u.demo_shown && <Badge size="sm">Demo shown</Badge>}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
