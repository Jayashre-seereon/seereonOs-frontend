// Compact HR summary for the CEO dashboard: headcount, joiners/exits this quarter, attrition, open positions,
// appraisal cycle progress, pending leave approvals and company-wide on-time delivery.
import { Link } from 'react-router-dom'
import { useHrDashboard } from '@/api/hr'
import { Card, CardHeader, Progress, Skeleton, useCan } from '@/ui'
import { cn } from '@/lib/utils'
import { pct, pctTone } from './components'
import type { ReactNode } from 'react'

function Mini({ label, value, sub, to, tone }: { label: string; value: ReactNode; sub?: ReactNode; to: string; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <Link to={to} className="min-w-0 rounded-md border border-line px-3 py-2.5 transition hover:border-line-strong hover:bg-surface-2/50">
      <div className="text-[12px] leading-tight text-ink-3">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap text-[18px] font-semibold leading-none', tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : tone === 'success' ? 'text-success-text' : 'text-ink')}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11.5px] text-ink-3">{sub}</div>}
    </Link>
  )
}

export default function PeopleSummaryPanel() {
  const can = useCan()
  const allowed = can('people.manage')
  const q = useHrDashboard(allowed)
  if (!allowed) return null
  const d = q.data
  return (
    <Card className="min-w-0">
      <CardHeader title="People" subtitle={d ? `${d.quarter_label} · from HR records and work data` : 'Headcount, hiring, appraisals and leave'} action={<Link to="/appraisals" className="whitespace-nowrap text-[12.5px] font-medium text-brand-text hover:underline">Appraisals</Link>} />
      {q.isLoading || !d ? (
        q.error ? <p className="text-[13px] text-ink-3">People data is unavailable right now.</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] rounded-md" />)}</div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Mini label="Headcount" value={d.headcount} sub={`+${d.joiners_q} joining · −${d.exits_q} leaving`} to="/lifecycle" />
            <Mini label="Attrition (12 mo)" value={pct(d.attrition_pct, 1)} tone={d.attrition_pct !== null && d.attrition_pct > 0.15 ? 'danger' : undefined} to="/lifecycle" />
            <Mini label="Open positions" value={d.open_positions} sub={`${d.candidates_by_stage.filter((s) => s.stage !== 'hired').reduce((s, x) => s + x.count, 0)} in pipeline`} to="/recruitment" />
            <Mini label="On-time delivery" value={pct(d.on_time_pct)} tone={pctTone(d.on_time_pct) === 'success' ? 'success' : pctTone(d.on_time_pct) === 'danger' ? 'danger' : pctTone(d.on_time_pct) === 'warning' ? 'warning' : undefined} sub="company, last 90 days" to="/scorecard" />
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <Link to="/appraisals" className="min-w-0 rounded-md border border-line px-3 py-2.5 hover:bg-surface-2/50">
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="truncate text-ink-2">{d.cycle ? `Appraisals · ${d.cycle.name}` : 'No appraisal cycle'}</span>
                {d.cycle && <span className="tnum shrink-0 font-medium">{d.cycle.completed}/{d.cycle.total}</span>}
              </div>
              <Progress className="mt-2" value={d.cycle && d.cycle.total ? d.cycle.completed / d.cycle.total : 0} tone={d.cycle && d.cycle.completed === d.cycle.total ? 'success' : 'brand'} height={5} />
            </Link>
            <Link to="/leave" className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-line px-3 py-2.5 hover:bg-surface-2/50">
              <span className="truncate text-[12.5px] text-ink-2">Leave waiting for approval</span>
              <span className={cn('tnum shrink-0 text-[16px] font-semibold', d.pending_leave ? 'text-warning-text' : 'text-ink')}>{d.pending_leave}</span>
            </Link>
          </div>
        </>
      )}
    </Card>
  )
}
