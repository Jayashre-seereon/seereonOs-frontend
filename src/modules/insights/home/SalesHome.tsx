// Sales dashboard: pipeline summary, deals needing action, target vs achieved meter (BR-15), activity.
import { Link } from 'react-router-dom'
import { Activity, AlertTriangle, BadgeIndianRupee, Clock3, Flag, Target, TrendingUp, Trophy } from '@/ui/icons'
import { useSalesDashboard } from '@/api/dashboards'
import { Badge, BarChart, ErrorState, Money, SkeletonCards, SkeletonRows } from '@/ui'
import { fmtMoney, fmtMoneyCompact, fmtPct } from '@/domain/money'
import { fmtDate } from '@/domain/calendar'
import { ACTIVITY_TYPE, DEAL_STAGE } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Bars, Kpi, ListEmpty, Panel, SeeAll } from '../kit'

export default function SalesHome() {
  const q = useSalesDashboard()
  const d = q.data
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <SkeletonCards n={4} />
        <SkeletonRows rows={6} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const s = d.summary
  const t = d.target
  const pct = t && t.target > 0 ? t.achieved / t.target : 0
  const thr = (t?.threshold_pct ?? 100) / 100
  return (
    <div className="space-y-4 md:space-y-5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-3">
        <Kpi label={d.scope === 'mine' ? 'My open pipeline' : 'Open pipeline'} value={fmtMoneyCompact(s.open_value)} sub={`${s.open_count} open deals`} to="/sales" />
        <Kpi label="Weighted" value={fmtMoneyCompact(s.weighted_value)} sub="value × stage chance" />
        <Kpi label="Won" value={fmtMoneyCompact(s.won_value)} sub={`${s.won_count} deals`} tone="success" />
        <Kpi label="Win rate" value={fmtPct(s.win_rate, 0)} sub="won ÷ (won + lost)" tone={s.win_rate === null ? undefined : s.win_rate >= 0.4 ? 'success' : s.win_rate >= 0.25 ? 'warning' : 'danger'} />
        <Kpi label="Days to close" value={s.avg_cycle_days ?? '—'} sub="average, won deals" />
        <Kpi label="Stale deals" value={s.stale_count} tone={s.stale_count ? 'warning' : 'success'} to="/insights/stale_deals" />
      </div>

      <div className="grid gap-4 xl:grid-cols-12">
        <Panel className="xl:col-span-5" title={(d.target_scope ?? d.scope) === 'mine' ? 'My target this month' : 'Team target this month'} subtitle={t?.month_label} action={<SeeAll to="/sales/compensation">Compensation</SeeAll>}>
          {t && t.has_rate && t.target > 0 ? (
            <>
              <div className="flex items-end justify-between gap-3">
                <div>
                  <div className="text-[12px] text-ink-3">Achieved</div>
                  <div className="tnum whitespace-nowrap text-[22px] font-semibold tracking-[-0.01em]">{fmtMoneyCompact(t.achieved)}</div>
                  <div className="text-[12.5px] text-ink-3">of {fmtMoney(t.target)} target</div>
                </div>
                <Badge tone={t.hit ? 'success' : pct >= thr * 0.75 ? 'warning' : 'danger'}>{fmtPct(pct, 0)}</Badge>
              </div>
              <div className="relative mt-4 h-3 w-full overflow-visible rounded-full bg-surface-2">
                <div className={cn('h-full rounded-full', t.hit ? 'bg-success' : 'bg-brand')} style={{ width: `${Math.min(100, (pct / Math.max(thr, 1.2)) * 100)}%` }} />
                <div className="absolute -top-1 h-5 w-0.5 bg-ink" style={{ left: `${(thr / Math.max(thr, 1.2)) * 100}%` }} aria-hidden />
              </div>
              <div className="mt-1.5 flex justify-between text-[11.5px] text-ink-3">
                <span>0</span>
                <span style={{ marginLeft: `${(thr / Math.max(thr, 1.2)) * 100 - 20}%` }}>Variable unlocks at {t.threshold_pct}%</span>
              </div>
              <p className="mt-3 rounded-md border border-line px-3 py-2 text-[12.5px] text-ink-2">
                {t.hit ? (
                  <>
                    Target met — variable pay of <strong>{fmtMoney(t.variable_earned)}</strong> is earned this month.
                  </>
                ) : (
                  <>
                    {fmtMoney(Math.max(0, Math.ceil(t.target * thr) - t.achieved))} more in won deals unlocks {fmtMoney(t.variable)} variable pay. It’s paid only at {t.threshold_pct}% or above — no partial payout.
                  </>
                )}
              </p>
              {d.history.length > 1 && (
                <div className="mt-4">
                  <div className="mb-1 text-[12px] font-medium text-ink-3">Last 6 months</div>
                  <BarChart data={d.history} x="label" format="money" height={150} series={[{ key: 'target', label: 'Target', color: 'var(--line-strong)' }, { key: 'achieved', label: 'Achieved' }]} />
                </div>
              )}
            </>
          ) : (
            <ListEmpty>No sales target set. An admin sets it with your cost rate.</ListEmpty>
          )}
        </Panel>
        <Panel className="xl:col-span-7" title="Deals needing action" subtitle="Past close date, stale, overdue next step, or closing this month" action={<SeeAll to="/sales">Pipeline</SeeAll>} flush>
          {d.needs_action.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.needs_action.map((n) => (
                <li key={n.id}>
                  <Link to={`/sales/${n.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <span className={cn('size-2 shrink-0 rounded-full', n.reason === 'overdue_close' ? 'bg-danger' : n.reason === 'stale' ? 'bg-warning' : n.reason === 'next_step' ? 'bg-accent' : 'bg-info')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">
                        {n.title} <span className="font-normal text-ink-3">· {n.client}</span>
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">{n.reason_text}{d.scope === 'team' && n.owner ? ` · ${n.owner}` : ''}</span>
                    </span>
                    <span className="text-right">
                      <Money value={n.value} compact className="block text-[13px] font-semibold" />
                      <Badge size="sm" tone={DEAL_STAGE[n.stage].tone}>{DEAL_STAGE[n.stage].label}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>Nothing needs a nudge today. Every deal has a recent touch and a future close date.</ListEmpty>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        <Panel className="xl:col-span-5" title="Pipeline by stage" subtitle="Open deals">
          <Bars format={(v) => fmtMoneyCompact(v)} items={d.by_stage.map((b) => ({ label: `${b.label} · ${b.count}`, value: b.value, sub: `weighted ${fmtMoneyCompact(b.weighted)}` }))} />
        </Panel>
        <Panel className="xl:col-span-7" title="Recent activity" subtitle={`${d.activity_30d} activities in the last 30 days`} flush>
          {d.activities.length ? (
            <ul className="divide-y divide-line border-t border-line">
              {d.activities.map((a) => (
                <li key={a.id}>
                  <Link to={`/sales/${a.deal_id}`} className="flex items-start gap-3 px-4 py-2.5 hover:bg-surface-2 md:px-5">
                    <Badge size="sm" tone="neutral" className="mt-0.5 shrink-0">{ACTIVITY_TYPE[a.type]}</Badge>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium">{a.deal} <span className="font-normal text-ink-3">· {a.client}</span></span>
                      <span className="line-clamp-1 text-[12px] text-ink-3">{a.note || '—'}</span>
                    </span>
                    <span className="shrink-0 text-right text-[11.5px] text-ink-3">
                      {fmtDate(a.date)}
                      {d.scope === 'team' && a.by && <span className="block">{a.by.split(' ')[0]}</span>}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <ListEmpty>No activities logged yet. Log calls and meetings on each deal.</ListEmpty>
          )}
        </Panel>
      </div>
    </div>
  )
}
