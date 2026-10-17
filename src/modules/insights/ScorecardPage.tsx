// /scorecard — weekly scorecard (Feature Guide §15, screenshot 029): team score with green/amber/red counts,
// then one card per person with their score components (Delivery, Updates, Timesheet, Demo, Early warning,
// Approvals…), 8-week trend and flags. The week comes from the header week switcher.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Flag, Gauge, Sparkles } from '@/ui/icons'
import { useScorecard, type ScoreRow } from '@/api/dashboards'
import { useUI, useWeek } from '@/stores/ui'
import { Avatar, Badge, Button, Card, EmptyState, ErrorState, IconButton, PageHeader, Segmented, Select, SkeletonCards, SkeletonRows, Tooltip, useCan } from '@/ui'
import { ExportMenu } from '@/reports/ExportMenu'
import { addDays } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { scoreTone } from './kit'

const toneBg = { success: 'bg-success-soft text-success-text ring-success/25', warning: 'bg-warning-soft text-warning-text ring-warning/30', danger: 'bg-danger-soft text-danger-text ring-danger/25', neutral: 'bg-surface-2 text-ink-3 ring-line', info: '', brand: '', accent: '' } as const

function ScoreChip({ v, big }: { v: number | null; big?: boolean }) {
  const t = scoreTone(v)
  return <span className={cn('tnum inline-grid place-items-center rounded-md font-semibold ring-1', toneBg[t], big ? 'h-10 min-w-[52px] px-2 text-[20px]' : 'h-7 min-w-[40px] px-1.5 text-[13px]')}>{v ?? '—'}</span>
}

function Trend({ data }: { data: (number | null)[] }) {
  const W = 96
  const H = 28
  const pts = data.map((v, i) => (v === null ? null : [(i / Math.max(1, data.length - 1)) * (W - 6) + 3, H - 3 - (v / 100) * (H - 6)] as const))
  const valid = pts.filter((p): p is readonly [number, number] => !!p)
  if (valid.length < 2) return <span className="text-[11.5px] text-ink-3">Not enough weeks</span>
  const d = valid.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const last = valid[valid.length - 1]
  const lastV = data.filter((x) => x !== null).slice(-1)[0] as number
  const color = { success: 'var(--success)', warning: 'var(--warning)', danger: 'var(--danger)', neutral: 'var(--ink-3)' }[scoreTone(lastV) as 'success' | 'warning' | 'danger' | 'neutral']
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label="8-week trend" className="shrink-0 overflow-visible">
      <line x1="0" x2={W} y1={H - 3 - 0.9 * (H - 6)} y2={H - 3 - 0.9 * (H - 6)} stroke="var(--line)" strokeDasharray="2 3" />
      <line x1="0" x2={W} y1={H - 3 - 0.75 * (H - 6)} y2={H - 3 - 0.75 * (H - 6)} stroke="var(--line)" strokeDasharray="2 3" />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill={color} stroke="var(--surface)" strokeWidth="1.4" />
    </svg>
  )
}

/** Component tiles (Delivery, Updates, Timesheet, Demo, Early warning, Approvals…), coloured by threshold. */
function Tiles({ p }: { p: ScoreRow }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
      {p.cells.map((c) => {
        const t = scoreTone(c.value)
        return (
          <Tooltip key={c.key} content={`${c.detail} · weight ${c.weight}%`}>
            <div className={cn('min-w-0 rounded-md px-2.5 py-2', t === 'neutral' ? 'bg-surface-2' : toneBg[t].split(' ').slice(0, 1).join(' '))}>
              <div className={cn('truncate text-[12px]', t === 'neutral' ? 'text-ink-3' : 'font-medium ' + toneBg[t].split(' ')[1])}>{c.label}</div>
              <div className={cn('tnum text-[16px] font-semibold leading-tight', t === 'neutral' ? 'text-ink-3' : toneBg[t].split(' ')[1])}>{c.value === null ? '—' : `${c.value}%`}</div>
              <div className="truncate text-[11px] text-ink-3">{c.detail}</div>
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}

export default function ScorecardPage() {
  const week = useWeek()
  const [filter, setFilter] = useState<'all' | 'red' | 'amber' | 'green'>('all')
  const q = useScorecard(week)
  const d = q.data
  const openAI = useUI((s) => s.openAI)
  const c = useCan()
  const people = useMemo(() => (d?.people ?? []).filter((p) => filter === 'all' || scoreTone(p.score) === ({ red: 'danger', amber: 'warning', green: 'success' } as const)[filter]), [d, filter])

  const exportT = () => {
    const keys = [...new Set((d?.people ?? []).flatMap((p) => p.cells.map((c) => c.key)))]
    const labels = new Map((d?.people ?? []).flatMap((p) => p.cells.map((c) => [c.key, c.label] as const)))
    return {
      title: 'Weekly scorecard',
      subtitle: `Week of ${d!.label}`,
      columns: [{ key: 'name', label: 'Person', type: 'string' as const }, { key: 'role', label: 'Role', type: 'string' as const }, ...keys.map((k) => ({ key: k, label: `${labels.get(k)} %`, type: 'number' as const })), { key: 'score', label: 'Score', type: 'number' as const }, { key: 'flags', label: 'Flags', type: 'string' as const }],
      rows: (d?.people ?? []).map((p) => ({ name: p.name, role: p.role_name, ...Object.fromEntries(p.cells.map((c) => [c.key, c.value])), score: p.score, flags: p.flags.join('; ') })),
      kpis: [
        { label: 'Team score', value: String(d?.team.score ?? '—') },
        { label: 'Green (90+)', value: String(d?.team.green ?? 0) },
        { label: 'Amber (75–89)', value: String(d?.team.amber ?? 0) },
        { label: 'Red (below 75)', value: String(d?.team.red ?? 0) },
      ],
      notes: ['The weekly score is the weighted average of the components that apply to the person; see Rules & KPIs for the weights.'],
    }
  }
  const total = d ? d.team.green + d.team.amber + d.team.red : 0

  return (
    <div>
      <PageHeader
        title="Weekly scorecard"
        subtitle={d ? `Week of ${d.label}. Change the week with the arrows in the header.` : 'Each person’s delivery score for the week in the header.'}
        actions={
          <>
            {c('ai.use') && d && (
              <Button size="sm" onClick={() => openAI('Who needs a 1:1 this week, and why?')}>
                Ask AI
              </Button>
            )}
            <ExportMenu table={d && !d.is_future ? exportT : null} filename={d ? `scorecard-${d.week}` : undefined} />
          </>
        }
      />

      {q.isLoading && !d ? (
        <div className="space-y-4">
          <SkeletonCards n={4} />
          <SkeletonRows rows={8} />
        </div>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d.is_future ? (
        <Card>
          <EmptyState compact title="This week hasn’t started yet" body="Scores are built from finished working days. Move the header back to this week or an earlier one." />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <div>
                <div className="text-[13px] text-ink-3">Team score {d.is_current ? 'this week (so far)' : `· ${d.label}`}</div>
                <div className="mt-1 flex items-center gap-3">
                  <span className={cn('tnum text-[30px] font-semibold leading-none', scoreTone(d.team.score) === 'danger' ? 'text-danger-text' : scoreTone(d.team.score) === 'warning' ? 'text-warning-text' : scoreTone(d.team.score) === 'success' ? 'text-success-text' : 'text-ink')}>{d.team.score ?? '—'}</span>
                  <Trend data={d.team.trend} />
                </div>
              </div>
              <div className="tnum text-[13px] text-ink-2">
                {d.team.green} green, {d.team.amber} amber, {d.team.red} red
                {d.team.none > 0 && <span className="text-ink-3"> · {d.team.none} not scored</span>}
              </div>
            </div>
            <div className="mt-3 flex h-2.5 w-full overflow-hidden rounded-full bg-surface-2" aria-label="Distribution of scores">
              {(['green', 'amber', 'red'] as const).map((k) => {
                const n = d.team[k]
                return n ? <div key={k} className={cn('h-full', k === 'green' ? 'bg-success' : k === 'amber' ? 'bg-warning' : 'bg-danger')} style={{ width: `${(n / (total || 1)) * 100}%` }} /> : null
              })}
            </div>
            <p className="mt-2 text-[12px] text-ink-3">
              {d.thresholds.green}+ green · {d.thresholds.amber}–{d.thresholds.green - 1} amber · below {d.thresholds.amber} red · {d.people.filter((p) => p.red_twice).length} red two weeks running.{' '}
              <Link to="/rules#score" className="font-medium text-brand-text hover:underline">How the score is built</Link>
            </p>
          </Card>

          <Segmented
            size="sm"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: d.people.length },
              { value: 'red', label: 'Red', count: d.team.red },
              { value: 'amber', label: 'Amber', count: d.team.amber },
              { value: 'green', label: 'Green', count: d.team.green },
            ]}
          />

          {people.length === 0 ? (
            <Card>
              <EmptyState compact title={d.people.length ? 'No one in this band' : 'No team members yet'} body={d.people.length ? 'Switch the filter to see everyone.' : 'Invite people from People to start scoring weeks.'} />
            </Card>
          ) : (
            <ul className="space-y-2.5">
              {people.map((p) => {
                const t = scoreTone(p.score)
                return (
                  <li key={p.id} className="rounded-lg border border-line bg-surface p-3.5 md:p-4">
                    <div className="flex items-start gap-3">
                      <Avatar name={p.name} hue={p.hue} size={32} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14.5px] font-semibold">{p.name}</div>
                        <div className="truncate text-[12.5px] text-ink-3">{p.title} · {p.role_name}</div>
                      </div>
                      <div className="hidden sm:block">
                        <Trend data={p.trend} />
                      </div>
                      <span className={cn('tnum shrink-0 text-[24px] font-semibold leading-none', t === 'danger' ? 'text-danger-text' : t === 'warning' ? 'text-warning-text' : t === 'success' ? 'text-success-text' : 'text-ink-3')}>{p.score ?? '—'}</span>
                    </div>
                    {p.cells.length > 0 && (
                      <div className="mt-3">
                        <Tiles p={p} />
                      </div>
                    )}
                    {p.flags.length > 0 && (
                      <ul className="mt-2.5 space-y-0.5">
                        {p.flags.map((f) => (
                          <li key={f} className={cn('text-[12.5px] font-semibold', f.startsWith('Red') || f.includes('overdue') ? 'text-danger-text' : 'text-warning-text')}>
                            {f}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
