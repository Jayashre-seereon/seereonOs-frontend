// /delivery/costing — Costing & margin from the sidebar: the portfolio margins table (same data as /finance/margins)
// or one project's Costing & margin tab (same component as the project page). Gated by margins.view.
import { useState } from 'react'
import type { PortfolioMargins } from '@/api/projects'
import { fmtMoney } from '@/domain/money'
import { ExportMenu } from '@/reports/ExportMenu'
import { Card, CardHeader, ErrorState, PageHeader, Segmented, SkeletonRows, StatCard } from '@/ui'
import { CostingTab } from '@/modules/projects/tabs/CostingTab'
import { MarginKpis, MarginsTable, marginsExport, useMargins } from '@/modules/finance/MarginsPanel'
import { ModeSwitch, ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, useViewMode, WithProject } from './shared'

export default function DeliveryCostingPage() {
  const { q, items } = useDeliveryProjects()
  const { mode, setMode } = useViewMode(true)
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Costing & margin" subtitle="Planned, projected and actual cost and margin: every project side by side, or one project in full detail." />
      <ProjectsGate q={q} items={items}>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'all' ? (
          <Portfolio />
        ) : (
          <>
            <ProjectPickerCard projects={items} id={id} onChange={choose} tab="costing" />
            <WithProject id={id}>{(d) => <CostingTab d={d} />}</WithProject>
          </>
        )}
      </ProjectsGate>
    </div>
  )
}

function Portfolio() {
  const [scope, setScope] = useState<PortfolioMargins['scope']>('active')
  const q = useMargins(scope)
  const d = q.data
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Segmented
          className="w-full sm:w-auto"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'open', label: 'All open' },
            { value: 'all', label: 'Including closed' },
          ]}
        />
        <ExportMenu table={d ? () => marginsExport(d) : null} filename={`costing-margins-${scope}`} />
      </div>
      {q.isLoading ? (
        <Card>
          <SkeletonRows rows={6} />
        </Card>
      ) : q.error || !d ? (
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      ) : (
        <>
          <Card>
            <MarginKpis d={d} size="lg" />
          </Card>
          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
            <StatCard label="Achieved, not invoiced" value={fmtMoney(d.cash.achieved_not_invoiced)} tone={d.cash.achieved_not_invoiced > 0 ? 'warning' : undefined} sub="Milestones done but not billed" />
            <StatCard label="Invoiced, awaiting payment" value={fmtMoney(d.cash.invoiced_awaiting_payment)} sub="Outstanding on raised invoices" />
            <StatCard label="Billable in the next 30 days" value={fmtMoney(d.cash.billable_next_30)} sub="Open milestones due soon" className="col-span-2 lg:col-span-1" />
          </div>
          <Card>
            <CardHeader title="Margins by project" subtitle={`Click a project for its Costing & margin tab. Decisions use margin; floor ${d.floor_pct}%.`} />
            <MarginsTable d={d} />
          </Card>
        </>
      )}
    </div>
  )
}
