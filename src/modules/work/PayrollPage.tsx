import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, Banknote, CheckCircle2, Download } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { announce, guarded, isPending } from '@/api/changes'
import type { PayrollFinaliseState } from '@/mock/routes/payroll'
import { PendingNote } from '@/modules/workflows/ApprovalRoute'
import PayslipActions from '@/modules/documents/PayslipActions'
import { workApi, type PayrollLineView, type PayrollRunView } from '@/api/work'
import { exportTable, type ExportFormat } from '@/reports/export'
import { fmtDate, fmtDateTime, monthOf, parseISO, todayISO, weekLabel, addMonths } from '@/domain/calendar'
import { WEEK_STATUS } from '@/domain/labels'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { cn, saveFile, toCSV } from '@/lib/utils'
import { Avatar, Badge, Button, Callout, Card, CardHeader, DataTable, EmptyState, ErrorState, KV, Menu, Money, PageHeader, Progress, Select, Sheet, Skeleton, SkeletonRows, StatCard, Tooltip, toast, useConfirm, useReadOnly, type Column } from '@/ui'

const monthName = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
const days = (n: number) => fmtNum(n, n % 1 ? 1 : 0)

/** UI-22 — /payroll and /payroll/:id (Feature Guide §10): pay for approved days. */
export default function PayrollPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const ro = useReadOnly()
  const list = useApi(['payroll', 'list'], workApi.payrollRuns)
  const thisMonth = monthOf(todayISO())
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => monthOf(addMonths(`${thisMonth}-01`, -i))), [thisMonth])
  const runs = list.data ?? []
  const byMonth = new Map(runs.map((r) => [r.month, r]))
  const urlRun = id ? runs.find((r) => r.id === id) : undefined
  const [picked, setPicked] = useState<string | null>(null)
  // month shown: the URL's run, else what was picked, else the latest draft or run, else this month
  const month = urlRun?.month ?? picked ?? runs.find((r) => r.status === 'draft')?.month ?? runs[0]?.month ?? thisMonth
  const monthRun = byMonth.get(month)
  const activeId = urlRun?.id ?? monthRun?.id ?? null

  const run = useMut((m: string) => workApi.runPayroll(m), {
    invalidate: [['payroll']],
    success: (r) => `Payroll calculated for ${monthName(r.run.month)}`,
    onSuccess: (r) => navigate(`/payroll/${r.run.id}`),
  })
  const recompute = useMut((rid: string) => workApi.recompute(rid), { invalidate: [['payroll']], success: 'Payroll recalculated' })
  const pickMonth = (m: string) => {
    setPicked(m)
    const r = byMonth.get(m)
    navigate(r ? `/payroll/${r.id}` : '/payroll')
  }

  return (
    <div>
      <PageHeader title="Payroll" meta={<Badge tone="neutral">Editors only</Badge>} subtitle="Pay for approved days: turns approved timesheets into the amount to pay each person for a month." />
      <Callout tone="neutral" className="mb-4">
        Rule: a working day is paid only if its week’s timesheet was submitted and approved. Unapproved days and leave without pay are deducted from the base salary (base ÷ working days in the month, per day). Sales variable is added only if the month’s target was met.
      </Callout>
      <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label htmlFor="pay-month" className="shrink-0 text-[13.5px] font-semibold text-ink">
          Month
        </label>
        <Select id="pay-month" className="min-w-0 flex-1" value={month} onChange={(e) => pickMonth(e.target.value)} options={months.map((m) => ({ value: m, label: `${monthName(m)}${byMonth.get(m) ? (byMonth.get(m)!.status === 'final' ? ' · final' : ' · draft') : ''}` }))} />
        {!ro &&
          (monthRun?.status === 'final' ? (
            <Button variant="secondary" disabled>
              Final
            </Button>
          ) : monthRun ? (
            <Button variant="primary" loading={recompute.isPending} onClick={() => recompute.mutate(monthRun.id)}>
              Recalculate
            </Button>
          ) : (
            <Button variant="primary" loading={run.isPending} onClick={() => run.mutate(month)}>
              Calculate payroll
            </Button>
          ))}
      </div>
      {list.isLoading ? (
        <SkeletonRows rows={5} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_260px]">
          <div className="min-w-0">
            {activeId ? (
              <RunDetail id={activeId} />
            ) : (
              <Card pad={false}>
                <EmptyState icon={<Banknote />} title={`No payroll for ${monthName(month)} yet`} body="Calculate payroll to see working days, approved and unapproved days, leave without pay, deductions, sales variable and net pay per person." action={!ro && <Button variant="primary" loading={run.isPending} onClick={() => run.mutate(month)}>Calculate payroll</Button>} />
              </Card>
            )}
          </div>
          <Card pad={false} className="self-start">
            <CardHeader className="px-4 pt-4" title="Run history" subtitle="One run per month." />
            {!runs.length ? (
              <EmptyState compact title="No runs yet" />
            ) : (
              <ul className="divide-y divide-line">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => (setPicked(r.month), navigate(`/payroll/${r.id}`))} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-surface-2/60', r.id === activeId && 'bg-brand-soft/60 shadow-[inset_2px_0_0_var(--brand)]')}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-medium">{monthName(r.month)}</span>
                        <span className="block truncate text-[12.5px] text-ink-3">{r.people ? `${r.people} people · ${fmtMoney(r.net_paise)}` : 'Lines generate on open'}</span>
                      </span>
                      <Badge size="sm" tone={r.status === 'final' ? 'success' : (r as { finalise_pending?: boolean }).finalise_pending ? 'info' : 'warning'}>{r.status === 'final' ? 'Final' : (r as { finalise_pending?: boolean }).finalise_pending ? 'Awaiting check' : 'Draft'}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

function RunDetail({ id }: { id: string }) {
  const q = useApi(['payroll', id], () => workApi.payrollRun(id) as Promise<PayrollRunView & Partial<PayrollFinaliseState>>)
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const [open, setOpen] = useState<PayrollLineView | null>(null)
  const d = q.data
  // Finalisation is maker-checked when payroll finalisation needs a second person.
  const finalise = useMut(() => guarded<PayrollRunView>('POST', `/payroll/${id}/finalise`, undefined, d?.run.version), {
    invalidate: [['payroll'], ['changes'], ['cost-rates']],
    onSuccess: (r) => announce(r, isPending(r) ? '' : `${monthName(r.result.run.month)} payroll finalised`),
  })

  if (q.isLoading)
    return (
      <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
        <SkeletonRows rows={8} className="mt-5" />
      </>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  const final = d.run.status === 'final'
  const pendingFin = d.pending_finalise ?? null
  const needsChecker = !!d.finalise_needs_checker
  const canFinalise = d.can_finalise ?? true
  const checkers = d.finalise_checkers ?? []
  const doFinalise = async () => {
    const pending = d.lines.filter((l) => l.unapproved_days > 0 || (l.pending_days ?? 0) > 0).length
    const ok = await confirm({
      title: needsChecker ? `Send ${monthName(d.run.month)} for finalisation?` : `Finalise ${monthName(d.run.month)}?`,
      body: `Net pay of ${fmtMoney(d.totals.net)} for ${d.lines.length} people will be frozen${needsChecker ? ` once ${checkers.length ? checkers.join(' or ') : 'a checker'} approves it` : ''}. ${pending ? `${pending} ${pending === 1 ? 'person still has' : 'people still have'} unapproved or pending days that are deducted — approve those weeks and recalculate first if they should be paid. ` : ''}${needsChecker ? 'You can’t recompute while it waits.' : 'This can’t be undone.'}`,
      confirmLabel: needsChecker ? 'Send for approval' : 'Finalise payroll',
      tone: needsChecker ? 'primary' : 'danger',
    })
    if (ok) finalise.mutate(undefined)
  }
  const doExport = async (f: ExportFormat) => {
    const r = await exportTable(toExport(d), f, `payroll-${d.run.month}`)
    if (r === 'saved') toast.success('Export saved')
    else if (r === 'failed') toast.error('Export failed')
  }

  const pend = (l: PayrollLineView) => l.pending_days ?? 0
  /** Part of the deduction that comes from days still pending (deducted now; chase the approval first). */
  const pendDed = (l: PayrollLineView) => {
    const u = l.unapproved_days + pend(l)
    return l.deduct_applied && u > 0 ? Math.round((l.would_deduct_paise * pend(l)) / u) : 0
  }
  const cols: Column<PayrollLineView>[] = [
    {
      key: 'name', header: 'Person', sortValue: (l) => l.user.name,
      cell: (l) => (
        <div className="flex min-w-0 max-w-[150px] items-start gap-1.5">
          <div className="min-w-0">
            <div className="truncate font-semibold text-ink">{l.user.name}</div>
            <div className="truncate text-[12.5px] text-ink-3">{l.self_approves ? 'self-approves' : l.approver_name ? `approver ${l.approver_name}` : l.user.title}</div>
          </div>
          {(l.no_rate || (l.flags?.length ?? 0) > 0) && (
            <Tooltip content={[...(l.no_rate ? ['No cost rate on file — paid ₹0 in this run.'] : []), ...(l.flags ?? [])].join('\n')}>
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Chase before paying" />
            </Tooltip>
          )}
        </div>
      ),
    },
    // only Person sorts, so all eleven figures fit at 1440 without scrolling
    { key: 'wd', header: 'Working days', align: 'right', width: '72px', cell: (l) => <span className="tnum">{days(l.working_days)}</span> },
    { key: 'ad', header: 'Approved', align: 'right', width: '84px', cell: (l) => <span className="tnum font-semibold text-success-text">{days(l.approved_days)}</span> },
    { key: 'pd', header: 'Pending', align: 'right', width: '72px', cell: (l) => <span className={cn('tnum font-semibold', pend(l) ? 'text-warning-text' : 'text-ink-3')}>{days(pend(l))}</span> },
    {
      key: 'ud', header: 'Not approved', align: 'right', width: '88px',
      cell: (l) =>
        l.unapproved_days ? (
          <Tooltip content={l.unapproved_detail.map((w) => `${weekLabel(w.week_start)}: ${days(w.days)}d (${w.status === 'missing' ? 'no timesheet' : WEEK_STATUS[w.status].label})`).join('\n')}>
            <span className="tnum cursor-help font-semibold text-danger-text underline decoration-dotted underline-offset-2">{days(l.unapproved_days)}</span>
          </Tooltip>
        ) : (
          <span className="tnum text-ink-3">0</span>
        ),
    },
    { key: 'lwp', header: 'LWP', align: 'right', width: '56px', cell: (l) => <span className={cn('tnum', l.lwp_days ? 'font-semibold text-danger-text' : 'text-ink-3')}>{days(l.lwp_days)}</span> },
    {
      key: 'ctc', header: 'CTC / base', align: 'right', width: '104px',
      cell: (l) => (
        <div>
          <Money value={l.monthly_ctc_paise} className="whitespace-nowrap" />
          {l.base_paise !== l.monthly_ctc_paise && <div className="tnum whitespace-nowrap text-[12px] text-ink-3">base {fmtMoney(l.base_paise)}</div>}
        </div>
      ),
    },
    {
      key: 'ded', header: 'Deduction', align: 'right', width: '100px',
      cell: (l) => (
        <div>
          {l.deduction_paise ? <Money value={-l.deduction_paise} className="whitespace-nowrap font-semibold text-danger-text" /> : <span className="tnum text-ink-3">—</span>}
          {pendDed(l) > 0 && (
            <Tooltip content={`${fmtMoney(pendDed(l))} of this is for ${days(pend(l))} pending day${pend(l) === 1 ? '' : 's'}. Chase the approval first, then recalculate.`}>
              <div className="cursor-help whitespace-nowrap text-[11.5px] font-medium text-warning-text">chase first</div>
            </Tooltip>
          )}
          {!l.deduct_applied && l.would_deduct_paise > 0 && <div className="tnum whitespace-nowrap text-[12px] text-ink-3">would be {fmtMoney(l.would_deduct_paise)}</div>}
        </div>
      ),
    },
    {
      key: 'var', header: 'Variable', align: 'right', width: '88px',
      cell: (l) =>
        l.sales ? (
          <Tooltip content={`Won ${fmtMoney(l.sales.achieved_paise)} of ${fmtMoney(l.sales.target_paise)} (${fmtPct(l.sales.achievement, 0)}). Paid only when the month’s target is met.`}>
            <span className={cn('tnum cursor-help whitespace-nowrap', l.variable_paise ? 'text-ink' : 'text-ink-3')}>{l.variable_paise ? fmtMoney(l.variable_paise) : '—'}</span>
          </Tooltip>
        ) : (
          <span className="text-ink-3">—</span>
        ),
    },
    { key: 'net', header: 'Net payable', align: 'right', width: '104px', cell: (l) => <Money value={l.net_paise} className="whitespace-nowrap font-semibold" /> },
  ]
  const flagged = d.lines.filter((l) => (l.flags?.length ?? 0) > 0)
  const doBankCsv = async () => {
    const head = ['Name', 'Employee code', 'Net pay (INR)']
    const body = d.lines.filter((l) => l.net_paise > 0).map((l) => [l.user.name, l.employee_code ?? '', (l.net_paise / 100).toFixed(2)])
    const r = await saveFile(`payroll-${d.run.month}-bank.csv`, toCSV([head, ...body]), 'text/csv')
    if (r === 'saved') toast.success('Bank file saved')
    else if (r === 'failed') toast.error('Export failed')
  }

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-semibold">{monthName(d.run.month)}</h2>
            <Badge tone={final ? 'success' : pendingFin ? 'info' : 'warning'}>{final ? 'Final' : pendingFin ? 'Awaiting check' : 'Draft'}</Badge>
          </div>
          <p className="text-[12.5px] text-ink-3">
            {d.working_days} working days · {final ? `Finalised ${fmtDateTime(d.run.finalised_at)}` : `Last calculated ${fmtDateTime(d.run.updated_at)}`} · deduction for unapproved days is {d.deduct_enabled ? 'on' : 'off'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {final && <PayslipActions runId={d.run.id} />}
          <Menu
            label="Export"
            trigger={<Button variant="secondary" icon={<Download className="size-4" />}>Export</Button>}
            items={[
              { label: 'PDF', onSelect: () => doExport('pdf') },
              { label: 'Excel', onSelect: () => doExport('xlsx') },
              { label: 'CSV (full)', onSelect: () => doExport('csv') },
              { label: 'CSV for the bank', onSelect: doBankCsv },
            ]}
          />
          {!final && !ro && (
            <>
              {canFinalise && !pendingFin && <Button variant="primary" loading={finalise.isPending} onClick={doFinalise}>{needsChecker ? 'Send for finalisation' : 'Finalise'}</Button>}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line lg:grid-cols-4">
        <PayKpi value={<Money value={d.totals.ctc} />} label="Monthly CTC, all staff" />
        <PayKpi value={<Money value={d.totals.deduction} />} danger={d.totals.deduction > 0} label={`Deductions (${days(d.totals.unapproved_days + (d.totals.pending_days ?? 0))} unapproved days, ${days(d.totals.lwp_days)} LWP days)${d.deduct_enabled ? '' : ` · unapproved days not deducted, would be ${fmtMoney(d.totals.would_deduct)}`}`} />
        <PayKpi value={<Money value={d.totals.variable} />} label="Sales variable earned" />
        <PayKpi value={<Money value={d.totals.net} />} label="Net payable" />
      </div>
      {flagged.length > 0 && !final && (
        <Callout tone="warning" className="mt-4" title={`Chase before you pay: ${flagged.length} ${flagged.length === 1 ? 'person has' : 'people have'} unsubmitted or unapproved weeks`} icon={<AlertTriangle />}>
          <ul className="list-disc space-y-0.5 pl-4">
            {flagged.map((l) => (
              <li key={l.id}>
                {l.user.name}: {l.flags!.join('; ')}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {pendingFin && !final && <PendingNote p={pendingFin} what="Finalisation is" className="mt-4" />}
      {!final && !pendingFin && !canFinalise && !ro && (
        <Callout tone="info" className="mt-4">Finalising needs “Finalise payroll”. Ask someone who holds it once the draft is ready.</Callout>
      )}
      {d.run.warnings.length > 0 && !final && (
        <Callout tone="warning" className="mt-4" title="Check before finalising" icon={<AlertTriangle />}>
          <ul className="list-disc space-y-1 pl-4">
            {d.run.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </Callout>
      )}
      {final && (
        <Callout tone="neutral" className="mt-4" icon={<CheckCircle2 />}>
          Finalised — these lines are frozen. Later approvals don’t change this run.
        </Callout>
      )}

      <DataTable
        className="mt-5"
        dense
        rows={d.lines}
        columns={cols}
        rowKey={(l) => l.id}
        onRowClick={setOpen}
        initialSort={{ key: 'name', dir: 'asc' }}
        rowClassName={(l) => (l.no_rate ? 'bg-warning-soft/40' : undefined)}
        empty={<EmptyState compact title="No one on payroll this month" />}
        footer={
          <tr className="whitespace-nowrap text-[13.5px] font-semibold [&>td]:px-3 [&>td]:py-2.5 [&>td:first-child]:pl-4 [&>td:last-child]:pr-4">
            <td>Total · {d.lines.length} people</td>
            <td />
            <td />
            <td className="tnum text-right">{days(d.totals.pending_days ?? 0)}</td>
            <td className="tnum text-right">{days(d.totals.unapproved_days)}</td>
            <td className="tnum text-right">{days(d.totals.lwp_days)}</td>
            <td className="text-right"><Money value={d.totals.ctc} /><div className="tnum text-[12px] font-normal text-ink-3">base {fmtMoney(d.totals.base)}</div></td>
            <td className="text-right">{d.totals.deduction ? <Money value={-d.totals.deduction} /> : <span className="tnum">—</span>}</td>
            <td className="text-right"><Money value={d.totals.variable} /></td>
            <td className="text-right"><Money value={d.totals.net} /></td>
          </tr>
        }
        mobileCard={(l) => (
          <div>
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-[14px] font-semibold"><span className="truncate">{l.user.name}</span>{(l.no_rate || (l.flags?.length ?? 0) > 0) && <AlertTriangle className="size-4 shrink-0 text-warning" />}</div>
                <div className="truncate text-[12.5px] text-ink-3">{l.self_approves ? 'self-approves' : l.approver_name ? `approver ${l.approver_name}` : l.user.title}</div>
              </div>
              <div className="shrink-0 text-right">
                <Money value={l.net_paise} className="whitespace-nowrap text-[15px] font-semibold" />
                <div className="text-[12px] text-ink-3">Net pay</div>
              </div>
            </div>
            <dl className="mt-3 grid grid-cols-4 gap-2 border-t border-line pt-2.5 text-[12.5px]">
              <div className="min-w-0"><dt className="text-ink-3">Approved</dt><dd className="tnum mt-0.5 font-semibold text-success-text">{days(l.approved_days)}<span className="font-normal text-ink-3">/{days(l.working_days)}</span></dd></div>
              <div className="min-w-0"><dt className="text-ink-3">Pending</dt><dd className={cn('tnum mt-0.5 font-semibold', pend(l) ? 'text-warning-text' : 'text-ink-3')}>{days(pend(l))}</dd></div>
              <div className="min-w-0"><dt className="text-ink-3">Not appr.</dt><dd className={cn('tnum mt-0.5 font-semibold', l.unapproved_days ? 'text-danger-text' : 'text-ink-3')}>{days(l.unapproved_days)}</dd></div>
              <div className="min-w-0 text-right"><dt className="text-ink-3">Deduction</dt><dd className={cn('tnum mt-0.5 whitespace-nowrap', l.deduction_paise ? 'text-danger-text' : 'text-ink')}>{l.deduction_paise ? fmtMoney(-l.deduction_paise) : '—'}</dd></div>
            </dl>
          </div>
        )}
      />
      <p className="mt-2 px-1 text-[12.5px] leading-snug text-ink-3">
        Pending = the week isn’t over yet or is waiting for the manager. Run payroll after every week of the month is approved; pending days become deductions if they stay unapproved. Deduction = monthly base ÷ working days in the month ({d.working_days}) × (unapproved days + leave-without-pay days), where unapproved = pending + not approved{d.deduct_enabled ? '; rows marked “chase first” include pending days' : ''}. PF, ESI and TDS are out of scope.
      </p>
      <div className="mt-2 rounded-lg border border-line bg-surface px-3.5 py-3 md:hidden">
        <div className="flex justify-between gap-3 text-[14px] font-semibold"><span className="min-w-0">Total net · {d.lines.length} people</span><Money value={d.totals.net} className="whitespace-nowrap" /></div>
      </div>

      <Payslip line={open} run={d} onClose={() => setOpen(null)} />
    </div>
  )
}

function Payslip({ line: l, run, onClose }: { line: PayrollLineView | null; run: PayrollRunView; onClose: () => void }) {
  // LWP part of the server-computed deduction (unapproved part is would_deduct when applied)
  const lwpDed = l ? Math.max(0, l.deduction_paise - (l.deduct_applied ? l.would_deduct_paise : 0)) : 0
  return (
    <Sheet open={!!l} onOpenChange={(o) => !o && onClose()} width={560} title={l ? l.user.name : ''} subtitle={l ? `${l.user.title} · payslip for ${monthName(run.run.month)}` : undefined}>
      {l && (
        <div className="space-y-5">
          {l.no_rate && <Callout tone="warning" icon={<AlertTriangle />}>No cost rate on file. Add one in Settings → Cost rates and recompute.</Callout>}
          <div className="rounded-lg border border-line">
            <Row label="Monthly CTC" value={<Money value={l.monthly_ctc_paise} />} />
            {l.sales && <Row label="Fixed base (CTC − variable)" value={<Money value={l.monthly_ctc_paise - l.sales.variable_at_stake_paise} />} muted />}
            <Row label={l.working_days < run.working_days ? `Base (prorated ${days(l.working_days)} of ${run.working_days} days)` : 'Base pay'} value={<Money value={l.base_paise} />} />
            <Row label={`LWP · ${days(l.lwp_days)} day${l.lwp_days === 1 ? '' : 's'}`} value={l.lwp_days ? <Money value={-lwpDed} className="text-danger-text" /> : '—'} />
            <Row
              label={`Unapproved · ${days(l.unapproved_days + (l.pending_days ?? 0))} day${l.unapproved_days + (l.pending_days ?? 0) === 1 ? '' : 's'}${l.pending_days ? ` (incl. ${days(l.pending_days)} pending — chase first)` : ''}${l.deduct_applied ? '' : ' (not deducted)'}`}
              value={l.unapproved_days + (l.pending_days ?? 0) ? l.deduct_applied ? <Money value={-l.would_deduct_paise} className="text-danger-text" /> : <span className="tnum text-ink-3">would be {fmtMoney(-l.would_deduct_paise)}</span> : '—'}
            />
            {l.sales && <Row label="Sales variable" value={<Money value={l.variable_paise} className={l.variable_paise ? 'text-success-text' : undefined} />} />}
            <Row label="Net pay" value={<Money value={l.net_paise} className="text-[15px] font-semibold" />} strong />
          </div>
          <p className="text-[12px] text-ink-3">Deduction = monthly base ÷ {run.working_days} working days × (unapproved days + leave-without-pay days). Unapproved includes pending days. Half days count as 0.5.</p>

          {l.unapproved_detail.length > 0 && (
            <div>
              <h3 className="mb-2 text-[13px] font-semibold">Where the unapproved days come from</h3>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {l.unapproved_detail.map((w) => (
                  <li key={w.week_start} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">{weekLabel(w.week_start)}</span>
                    {w.status === 'missing' ? <Badge size="sm" tone="danger">No timesheet</Badge> : <Badge size="sm" tone={WEEK_STATUS[w.status].tone}>{WEEK_STATUS[w.status].label}</Badge>}
                    <span className="tnum w-12 text-right font-semibold">{days(w.days)}d</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {l.sales && (
            <div className="rounded-lg border border-line p-4">
              <h3 className="text-[13px] font-semibold">Sales variable</h3>
              <KV
                className="mt-3"
                cols={2}
                items={[
                  { label: 'Target', value: <Money value={l.sales.target_paise} /> },
                  { label: 'Won this month', value: <Money value={l.sales.achieved_paise} /> },
                  { label: 'At stake', value: <Money value={l.sales.variable_at_stake_paise} /> },
                  { label: 'Threshold', value: `${l.sales.threshold_pct}% of target` },
                ]}
              />
              <Progress className="mt-3" value={Math.min(1, l.sales.achievement)} tone={l.sales.achievement * 100 >= l.sales.threshold_pct ? 'success' : 'warning'} />
              <p className="mt-1.5 text-[12px] text-ink-3">{fmtPct(l.sales.achievement, 0)} achieved — {l.variable_paise ? 'variable paid in full.' : 'no partial variable below the threshold.'}</p>
            </div>
          )}
          <p className="text-[12px] text-ink-3">Run {run.run.status === 'final' ? `finalised ${fmtDate(run.run.finalised_at?.slice(0, 10))}` : 'is a draft'}.</p>
        </div>
      )}
    </Sheet>
  )
}

function PayKpi({ value, label, danger }: { value: React.ReactNode; label: string; danger?: boolean }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <div className={cn('tnum whitespace-nowrap text-[22px] font-semibold leading-tight', danger ? 'text-danger-text' : 'text-ink')}>{value}</div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{label}</div>
    </div>
  )
}

function Row({ label, value, strong, muted }: { label: string; value: React.ReactNode; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 text-[13.5px] last:border-0', strong && 'bg-surface-2/70 font-semibold', muted && 'text-ink-3')}>
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 whitespace-nowrap text-right">{value}</span>
    </div>
  )
}

function toExport(d: PayrollRunView) {
  return {
    title: `Payroll — ${monthName(d.run.month)}`,
    subtitle: `${d.run.status === 'final' ? 'Final' : 'Draft'} · ${d.working_days} working days · deduction for unapproved days ${d.deduct_enabled ? 'on' : 'off'}`,
    orientation: 'landscape' as const,
    columns: [
      { key: 'name', label: 'Person', type: 'string' as const },
      { key: 'ctc', label: 'Monthly CTC', type: 'money' as const },
      { key: 'base', label: 'Base', type: 'money' as const },
      { key: 'wd', label: 'Working days', type: 'number' as const },
      { key: 'ad', label: 'Approved days', type: 'number' as const },
      { key: 'pd', label: 'Pending days', type: 'number' as const },
      { key: 'ud', label: 'Not approved days', type: 'number' as const },
      { key: 'weeks', label: 'Source weeks', type: 'string' as const },
      { key: 'lwp', label: 'LWP days', type: 'number' as const },
      { key: 'ded', label: 'Deduction', type: 'money' as const },
      { key: 'var', label: 'Variable', type: 'money' as const },
      { key: 'net', label: 'Net pay', type: 'money' as const },
    ],
    rows: d.lines.map((l) => ({
      name: l.user.name, ctc: l.monthly_ctc_paise, base: l.base_paise, wd: l.working_days, ad: l.approved_days, pd: l.pending_days ?? 0, ud: l.unapproved_days,
      weeks: l.unapproved_detail.map((w) => `${w.week_start} (${w.days}d)`).join('; '), lwp: l.lwp_days, ded: l.deduction_paise, var: l.variable_paise, net: l.net_paise,
    })),
    totals: { ctc: d.totals.ctc, base: d.totals.base, ud: d.totals.unapproved_days, lwp: d.totals.lwp_days, ded: d.totals.deduction, var: d.totals.variable, net: d.totals.net },
    kpis: [
      { label: 'Net pay', value: fmtMoney(d.totals.net) },
      { label: 'Deductions', value: fmtMoney(d.totals.deduction) },
      { label: 'People', value: String(d.lines.length) },
    ],
    notes: d.run.warnings,
  }
}
