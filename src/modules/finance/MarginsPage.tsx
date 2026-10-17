// /finance/margins — CEO profit margins across projects (Feature Guide §6, checklist G6.10, G6.11; route gated margins.view).
import { useState } from 'react'
import type { PortfolioMargins } from '@/api/projects'
import { fmtMoney } from '@/domain/money'
import { ExportMenu } from '@/reports/ExportMenu'
import { Badge, Card, CardHeader, ErrorState, PageHeader, Segmented, SkeletonRows, StatCard } from '@/ui'
import { MarginKpis, MarginsTable, marginsExport, useMargins } from './MarginsPanel'

export default function MarginsPage() {
  const [scope, setScope] = useState<PortfolioMargins['scope']>('active')
  const q = useMargins(scope)
  const d = q.data
  return (
    <div>
      <PageHeader
        title="Profit margins"
        subtitle="CEO view of profit margins across all projects: the same numbers for every project in one table. Visible only to the CEO and anyone given the margins permission."
        actions={<ExportMenu table={d ? () => marginsExport(d) : null} filename={`profit-margins-${scope}`} />}
      />
      <Segmented
        className="mb-4 w-full sm:w-auto"
        value={scope}
        onChange={setScope}
        options={[
          { value: 'active', label: 'Active' },
          { value: 'open', label: 'All open' },
          { value: 'all', label: 'All projects' },
        ]}
      />
      {q.isLoading ? (
        <Card><SkeletonRows rows={6} /></Card>
      ) : q.error || !d ? (
        <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
      ) : (
        <div className="space-y-4">
          <Card>
            <MarginKpis d={d} size="lg" />
          </Card>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
            <StatCard label="Achieved, not invoiced" value={fmtMoney(d.cash.achieved_not_invoiced)} tone={d.cash.achieved_not_invoiced > 0 ? 'warning' : undefined} sub="Milestones done but not billed" />
            <StatCard label="Invoiced, awaiting payment" value={fmtMoney(d.cash.invoiced_awaiting_payment)} sub="Outstanding on raised invoices" />
            <StatCard label="Billable in the next 30 days" value={fmtMoney(d.cash.billable_next_30)} sub="Open milestones due soon" className="col-span-2 lg:col-span-1" />
          </div>
          <Card>
            <CardHeader title={<span className="inline-flex flex-wrap items-center gap-2">Profit margins by project <Badge size="sm">CEO and margins permission</Badge></span>} subtitle={`Projected margin shows the change against planned in points. Decisions use margin; floor ${d.floor_pct}%.`} />
            <MarginsTable d={d} />
          </Card>
        </div>
      )}
    </div>
  )
}
