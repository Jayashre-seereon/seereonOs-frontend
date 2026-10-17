// CEO dashboard panel: this month's spend vs budget, unbudgeted spend, money owed to staff and
// vendors, lost revenue by kind and contracts renewing in the next 60 days.
import { Link } from 'react-router-dom'
import { Card, CardHeader, EmptyState, ErrorState, Money, Progress, SkeletonRows, useCan } from '@/ui'
import { useSpendSummary } from '@/api/spend'
import { fmtMoneyCompact } from '@/domain/money'
import { parseISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { CONTRACT_KIND } from './labels'

export default function SpendSummaryPanel() {
  const can = useCan()
  const allowed = can('budgets.manage')
  const q = useSpendSummary(allowed)
  if (!allowed) return null
  const d = q.data
  const month = d ? parseISO(`${d.month}-01`).toLocaleDateString('en-IN', { month: 'long' }) : ''
  const used = d ? d.month_spend + d.month_committed : 0
  const ratio = d && d.month_budget ? used / d.month_budget : 0
  return (
    <Card>
      <CardHeader title="Spend & lost revenue" subtitle="Where the money went this month and what slipped away this year" action={<Link to="/budgets" className="text-[13px] font-medium text-brand-text hover:underline">Budgets</Link>} />
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-5">
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="text-[13px] text-ink-2">{month} spend vs budget</span>
              <span className="tnum whitespace-nowrap text-[13px]">
                <span className={cn('font-semibold', ratio > 1 ? 'text-danger-text' : 'text-ink')}>{fmtMoneyCompact(used)}</span>
                <span className="text-ink-3"> of {fmtMoneyCompact(d.month_budget)}</span>
              </span>
            </div>
            <Progress value={Math.min(1, ratio)} tone={ratio > 1 ? 'danger' : ratio > 0.85 ? 'warning' : 'brand'} className="mt-2" />
            {d.month_committed > 0 && <p className="mt-1 text-[12px] text-ink-3">Includes {fmtMoneyCompact(d.month_committed)} approved but not yet paid.</p>}
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-4">
            <Tile to="/budgets" label="Unbudgeted spend this FY" value={d.unbudgeted_fy} tone={d.unbudgeted_fy ? 'warning' : undefined} />
            <Tile to="/expenses?tab=pay" label="Reimbursements due" value={d.pending_reimbursement.amount} sub={`${d.pending_reimbursement.count} approved claims`} />
            <Tile to="/expenses?tab=approve" label="Claims awaiting approval" value={d.awaiting_approval.amount} sub={`${d.awaiting_approval.count} claims`} />
            <Tile to="/purchases?tab=bills" label="Vendor bills payable" value={d.bills_payable.amount} tone={d.bills_payable.overdue ? 'danger' : undefined} sub={d.bills_payable.overdue ? `${fmtMoneyCompact(d.bills_payable.overdue)} overdue` : `${d.bills_payable.count} bills`} />
          </div>

          <div className="border-t border-line pt-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <Link to="/leakage" className="text-[13px] font-medium text-ink hover:underline">Lost revenue this FY</Link>
              <Money value={d.leakage_fy} compact className="text-[14px] font-semibold text-danger-text" />
            </div>
            {d.leakage_top.length ? (
              <ul className="space-y-1.5">
                {d.leakage_top.map((k) => (
                  <li key={k.kind} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <span className="min-w-0 truncate text-ink-2">{k.label}</span>
                    <Money value={k.amount} compact className="text-ink" />
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-3">Nothing lost this year.</p>}
          </div>

          <div className="border-t border-line pt-4">
            <div className="mb-2 text-[13px] font-medium text-ink">Contracts renewing in 60 days</div>
            {d.renewals.length ? (
              <ul className="space-y-2">
                {d.renewals.slice(0, 4).map((r) => (
                  <li key={r.id}>
                    <Link to={`/clients/${r.client_id}`} className="flex items-start justify-between gap-3 rounded-md py-0.5 hover:bg-surface-2/60">
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] text-ink">{r.client}</span>
                        <span className="block truncate text-[12px] text-ink-3">{CONTRACT_KIND[r.kind]} · {r.title}</span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end">
                        <span className={cn('tnum whitespace-nowrap text-[12.5px] font-medium', r.days <= 15 ? 'text-danger-text' : 'text-warning-text')}>{r.days >= 0 ? `in ${r.days}d` : 'overdue'}</span>
                        <span className="tnum text-[12px] text-ink-3">{fmtMoneyCompact(r.value_paise)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No renewals due" compact />}
          </div>
        </div>
      )}
    </Card>
  )
}

function Tile({ to, label, value, sub, tone }: { to: string; label: string; value: number; sub?: string; tone?: 'warning' | 'danger' }) {
  return (
    <Link to={to} className="group min-w-0">
      <div className="text-[12px] leading-tight text-ink-3 group-hover:text-ink-2">{label}</div>
      <div className={cn('tnum mt-1 whitespace-nowrap text-[17px] font-semibold', tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : 'text-ink')}>{fmtMoneyCompact(value)}</div>
      {sub && <div className="truncate text-[12px] text-ink-3">{sub}</div>}
    </Link>
  )
}
