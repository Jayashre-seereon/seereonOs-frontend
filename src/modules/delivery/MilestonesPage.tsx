// /delivery/milestones — Milestones & billing across every project the viewer can see (deadline, forecast, delivery
// status, billing amount and state), with filters; or one project's milestone table (same component as its WBS tab).
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { MilestoneView, ProjectDetail } from '@/api/projects'
import type { MilestoneDelivery } from '@/mock/analytics'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Card, DataTable, EmptyState, Field, PageHeader, Progress, Select, StatCard, type Column } from '@/ui'
import type { Tone } from '@/domain/labels'
import { MilestoneTable } from '@/modules/projects/components/MilestoneTable'
import { MS_STATE, MsStateBadge } from '@/modules/projects/components/shared'
import { ModeSwitch, ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, useProjectDetails, useViewMode, WithProject } from './shared'

type BillState = 'paid' | 'invoiced' | 'achieved' | 'not_due'
const BILL: Record<BillState, { label: string; tone: Tone }> = {
  paid: { label: 'Paid', tone: 'success' },
  invoiced: { label: 'Invoiced', tone: 'info' },
  achieved: { label: 'Achieved, not invoiced', tone: 'warning' },
  not_due: { label: 'Not due', tone: 'neutral' },
}
interface Row {
  key: string
  d: ProjectDetail
  m: MilestoneView
  bill: BillState | null
}
const billOf = (d: ProjectDetail, m: MilestoneView): BillState | null => {
  if (!d.billing_summary) return null
  if (m.billing_status === 'paid') return 'paid'
  if (m.billing_status === 'invoiced') return 'invoiced'
  return m.state === 'achieved_on_time' || m.state === 'achieved_late' ? 'achieved' : 'not_due'
}

export default function DeliveryMilestonesPage() {
  const { q, items } = useDeliveryProjects()
  const { mode, setMode } = useViewMode(true)
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Milestones & billing" subtitle="Every milestone across your projects: deadline, forecast, delivery status and what has been billed and paid." />
      <ProjectsGate q={q} items={items}>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'all' ? (
          <Overview ids={items.map((p) => p.id)} onOpen={(pid) => choose(pid)} />
        ) : (
          <>
            <ProjectPickerCard projects={items} id={id} onChange={choose} tab="wbs" />
            <WithProject id={id}>{(d) => <MilestoneTable d={d} />}</WithProject>
          </>
        )}
      </ProjectsGate>
    </div>
  )
}

function Overview({ ids, onOpen }: { ids: string[]; onOpen: (id: string) => void }) {
  const nav = useNavigate()
  const det = useProjectDetails(ids)
  const [project, setProject] = useState('')
  const [state, setState] = useState<MilestoneDelivery | 'open' | ''>('open')
  const [bill, setBill] = useState<BillState | ''>('')
  const all: Row[] = useMemo(() => det.data.flatMap((d) => d.milestones.map((m) => ({ key: m.id, d, m, bill: billOf(d, m) }))), [det.data])
  const showBilling = all.some((r) => r.bill !== null)
  const rows = all.filter(
    (r) =>
      (!project || r.d.project.id === project) &&
      (!state || (state === 'open' ? !r.m.state.startsWith('achieved') : r.m.state === state)) &&
      (!bill || r.bill === bill),
  )
  const sumBill = (s: BillState) => all.filter((r) => r.bill === s).reduce((t, r) => t + r.m.billing_amount_paise, 0)
  const columns: Column<Row>[] = [
    {
      key: 'project', header: 'Project', sortValue: (r) => r.d.project.code,
      cell: (r) => (
        <div className="min-w-0">
          <div className="tnum text-[12.5px] text-ink-3">{r.d.project.code}</div>
          <div className="truncate text-[13.5px] text-ink">{r.d.project.name}</div>
        </div>
      ),
    },
    {
      key: 'ms', header: 'Milestone', sortValue: (r) => `${r.d.project.code}-${String(r.m.no).padStart(3, '0')}`,
      cell: (r) => (
        <div className="min-w-0">
          <span className="tnum mr-1.5 font-semibold text-ink">M{r.m.no}</span>
          <span className="text-ink">{r.m.name}</span>
          <div className="text-[12px] text-ink-3">{r.m.task_count} task{r.m.task_count === 1 ? '' : 's'}</div>
        </div>
      ),
    },
    { key: 'progress', header: 'Progress', width: '120px', sortValue: (r) => r.m.progress, cell: (r) => <div className="flex items-center gap-2"><Progress value={r.m.progress} className="w-14" /><span className="tnum text-[12.5px] text-ink-2">{fmtPct(r.m.progress, 0)}</span></div> },
    { key: 'deadline', header: 'Deadline', align: 'right', sortValue: (r) => r.m.planned_end, cell: (r) => <span className="tnum whitespace-nowrap">{fmtDate(r.m.planned_end)}</span> },
    {
      key: 'forecast', header: 'Forecast / end', align: 'right', sortValue: (r) => r.m.end_on ?? r.m.forecast_end ?? '',
      cell: (r) => {
        const end = r.m.end_on ?? r.m.forecast_end
        const late = !!end && end > r.m.planned_end
        return (
          <span className="tnum whitespace-nowrap">
            <span className={cn(late && 'text-danger-text')}>{fmtDate(end)}</span>
            {r.m.end_kind === 'achieved' && <span className="ml-1 text-[12px] text-ink-3">done</span>}
          </span>
        )
      },
    },
    { key: 'state', header: 'Status', sortValue: (r) => r.m.state, cell: (r) => <MsStateBadge state={r.m.state} size="sm" /> },
    ...(showBilling
      ? [
          { key: 'amount', header: 'Billing', align: 'right' as const, sortValue: (r: Row) => r.m.billing_amount_paise, cell: (r: Row) => (r.bill === null ? <span className="text-ink-3">—</span> : <span className="tnum whitespace-nowrap">{fmtMoney(r.m.billing_amount_paise)}</span>) },
          { key: 'bill', header: 'Billing state', sortValue: (r: Row) => r.bill ?? '', cell: (r: Row) => (r.bill ? <Badge tone={BILL[r.bill].tone} size="sm">{r.m.invoice?.number ? `${BILL[r.bill].label} · ${r.m.invoice.number}` : BILL[r.bill].label}</Badge> : null) },
        ]
      : []),
  ]
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatCard label="Open milestones" value={String(all.filter((r) => !r.m.state.startsWith('achieved')).length)} sub={`${all.length} in total`} />
        <StatCard label="Overdue" value={String(all.filter((r) => r.m.state === 'overdue').length)} tone={all.some((r) => r.m.state === 'overdue') ? 'danger' : undefined} sub={`${all.filter((r) => r.m.state === 'at_risk').length} at risk`} />
        {showBilling ? (
          <>
            <StatCard label="Achieved, not invoiced" value={fmtMoney(sumBill('achieved'))} tone={sumBill('achieved') > 0 ? 'warning' : undefined} sub="Ready to bill" />
            <StatCard label="Invoiced, awaiting payment" value={fmtMoney(sumBill('invoiced'))} sub={`${fmtMoney(sumBill('paid'))} paid`} />
          </>
        ) : (
          <>
            <StatCard label="Achieved" value={String(all.filter((r) => r.m.state.startsWith('achieved')).length)} sub={`${all.filter((r) => r.m.state === 'achieved_late').length} late`} />
            <StatCard label="Projects" value={String(det.data.length)} sub="With milestones you can see" />
          </>
        )}
      </div>
      <Card pad={false}>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3 md:px-5">
          <Field label="Project">
            <Select value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'All projects' }, ...det.data.map((d) => ({ value: d.project.id, label: `${d.project.code} · ${d.project.name}` }))]} aria-label="Filter by project" />
          </Field>
          <Field label="Delivery status">
            <Select
              value={state}
              onChange={(e) => setState(e.target.value as MilestoneDelivery | 'open' | '')}
              options={[{ value: 'open', label: 'Open (not achieved)' }, { value: '', label: 'All statuses' }, ...(Object.keys(MS_STATE) as MilestoneDelivery[]).map((k) => ({ value: k, label: MS_STATE[k].label }))]}
              aria-label="Filter by delivery status"
            />
          </Field>
          {showBilling && (
            <Field label="Billing state">
              <Select value={bill} onChange={(e) => setBill(e.target.value as BillState | '')} options={[{ value: '', label: 'Any billing state' }, ...(Object.keys(BILL) as BillState[]).map((k) => ({ value: k, label: BILL[k].label }))]} aria-label="Filter by billing state" />
            </Field>
          )}
        </div>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.key}
          loading={det.loading && !all.length}
          error={det.error}
          onRetry={det.refetch}
          initialSort={{ key: 'deadline', dir: 'asc' }}
          onRowClick={(r) => nav(`/projects/${r.d.project.id}/wbs`)}
          empty={<EmptyState compact title="No milestones match" body="Change the filters, or add milestones in a project’s WBS." action={<button type="button" className="text-[13px] font-medium text-brand-text hover:underline" onClick={() => { setProject(''); setState(''); setBill('') }}>Clear filters</button>} />}
          mobileCard={(r) => (
            <div className="min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[12px] text-ink-3"><span className="tnum">{r.d.project.code}</span> · {r.d.project.name}</div>
                  <div className="text-[14px] font-medium text-ink"><span className="tnum">M{r.m.no}</span> {r.m.name}</div>
                </div>
                <MsStateBadge state={r.m.state} size="sm" />
              </div>
              <div className="tnum mt-1 text-[12.5px] text-ink-3">
                Deadline {fmtDate(r.m.planned_end)} · {r.m.end_kind === 'achieved' ? 'done' : 'forecast'} {fmtDate(r.m.end_on ?? r.m.forecast_end)} · {fmtPct(r.m.progress, 0)}
              </div>
              {r.bill && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="tnum font-medium text-ink">{fmtMoney(r.m.billing_amount_paise)}</span>
                  <Badge tone={BILL[r.bill].tone} size="sm">{BILL[r.bill].label}</Badge>
                </div>
              )}
            </div>
          )}
        />
      </Card>
      <p className="text-[12.5px] text-ink-3">
        Click a milestone to open its project’s WBS. To edit milestones or raise an invoice from one, switch to{' '}
        <Link to="?view=project" className="font-medium text-brand-text hover:underline" onClick={(e) => { e.preventDefault(); if (project) onOpen(project); else onOpen(ids[0]) }}>
          One project
        </Link>
        .
      </p>
    </div>
  )
}
