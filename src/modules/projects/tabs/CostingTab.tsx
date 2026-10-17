// Project "Costing & margin" tab (Feature Guide §6, checklist G6.01–G6.11). Sections in the guide's order:
// (a) Costing and margin — planned | projected | actual with the three-margins legend; (b) Margin vs markup;
// (c) What moved the margin; (d) Milestone variance; (e) Resources: allocated vs logged; (f) Effort ratio;
// (g) Resource allocation by milestone (+ cost per hour); (h) Planned costing. Milestone billing and the logged-cost
// breakdown follow. Visible only with the margins permission (CEO by default).
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertTriangle, BarChart3, Paperclip, Table2 } from '@/ui/icons'
import { projectsApi, type BillingRow, type InvoiceView, type MoneyTriple, type ProjectDetail } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { addDays, fmtDate, todayISO } from '@/domain/calendar'
import { fmtHours, fmtMoney, fmtPct } from '@/domain/money'
import { readFileAsDataURL, cn } from '@/lib/utils'
import {
  Badge, BarChart, Button, Callout, Card, CardHeader, ChartTable, Dialog, EmptyState, ErrorState, Field, FileUpload, IconButton, Input, Money, MoneyInput, PersonName, Skeleton, useReadOnly,
} from '@/ui'
import { MsStateBadge } from '../components/shared'
import { CostingMarginCard, EffortCard, MarginVsMarkupCard, MilestoneVarianceCard, ResourcesUseCard, WhatMovedCard } from '../costing/MarginAnalysis'
import { AllocationByMilestoneCard } from '../costing/AllocationByMilestone'
import { PlannedCostingCard } from '../costing/PlannedCostingCard'

export function CostingTab({ d }: { d: ProjectDetail }) {
  const q = useApi(['project', d.project.id, 'money'], () => projectsApi.money(d.project.id))
  if (q.isLoading)
    return (
      <div className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 rounded-lg" />)}
      </div>
    )
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  const m = q.data
  if (!m) return <Card><EmptyState title="Margins are private" body="Margins are visible only to the CEO and anyone given the margins permission." /></Card>
  const a = m.analysis
  const below = m.projected.margin !== null && m.projected.margin < m.floor_pct / 100
  return (
    <div className="space-y-4">
      {below && (
        <Callout tone="danger" icon={<AlertTriangle />} title={`Projected margin ${fmtPct(m.projected.margin)} is below the ${m.floor_pct}% floor`}>
          Cut remaining scope, raise a change request, or move work to lower-cost people. Health shows At risk until it recovers.
        </Callout>
      )}
      {a && <CostingMarginCard a={a} />}
      {a && <MarginVsMarkupCard a={a} />}
      {a && <WhatMovedCard a={a} />}
      {a && <MilestoneVarianceCard a={a} />}
      {a && <ResourcesUseCard a={a} />}
      {a && <EffortCard a={a} />}
      {a && <AllocationByMilestoneCard d={d} a={a} />}
      <PlannedCostingCard d={d} />
      {m.billing && <Billing d={d} rows={m.billing} canInvoice={m.can_invoice} invoiced={m.invoiced} collected={m.collected} contract={m.contract} />}
      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <ByPerson rows={m.by_person} />
        <Comparison m={{ planned: m.planned, projected: m.projected, actual: m.actual }} />
      </div>
    </div>
  )
}
/** @deprecated v5 name; the tab is "Costing & margin" now. */
export const MoneyTab = CostingTab

function Comparison({ m }: { m: { planned: MoneyTriple; projected: MoneyTriple; actual: MoneyTriple } }) {
  const [table, setTable] = useState(false)
  const data = [
    { name: 'Planned', Revenue: m.planned.revenue, Cost: m.planned.cost },
    { name: 'Projected', Revenue: m.projected.revenue, Cost: m.projected.cost },
    { name: 'Actual', Revenue: m.actual.revenue, Cost: m.actual.cost },
  ]
  const series = [{ key: 'Revenue', label: 'Revenue' }, { key: 'Cost', label: 'Cost' }]
  return (
    <Card>
      <CardHeader
        title="Revenue vs cost"
        subtitle="Planned: contract value vs allocation and estimates. Projected: contract incl. approved CRs vs actual so far + what’s left. Actual: invoiced vs approved hours."
        action={<IconButton size="sm" label={table ? 'Show chart' : 'Show table'} onClick={() => setTable(!table)}>{table ? <BarChart3 className="size-4" /> : <Table2 className="size-4" />}</IconButton>}
      />
      {table ? <ChartTable data={data} x="name" series={series} format="money" /> : <BarChart data={data} x="name" series={series} format="money" height={220} />}
    </Card>
  )
}

function ByPerson({ rows }: { rows: { user_id: string; est_hours: number; hours: number; approved_hours: number; rate_ph: number; planned_cost: number; cost: number }[] }) {
  return (
    <Card>
      <CardHeader title="Logged cost by person" subtitle="Logged hours × cost per hour in the month worked (CTC ÷ (working days × minimum hours))." />
      {!rows.length ? (
        <EmptyState compact title="No hours or estimates yet" />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 scroll-thin md:-mx-5 md:px-5">
          <table className="w-full min-w-[440px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                <th className="py-2 pr-3 text-left font-semibold">Person</th>
                <th className="whitespace-nowrap py-2 pl-3 text-right font-semibold">Rate/h</th>
                <th className="whitespace-nowrap py-2 pl-3 text-right font-semibold">Est</th>
                <th className="whitespace-nowrap py-2 pl-3 text-right font-semibold">Logged</th>
                <th className="whitespace-nowrap py-2 pl-3 text-right font-semibold">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id} className="border-b border-line last:border-0">
                  <td className="max-w-[180px] py-2 pr-3"><PersonName id={r.user_id} size={22} className="max-w-full" /></td>
                  <td className="tnum whitespace-nowrap py-2 pl-3 text-right text-ink-2"><Money value={r.rate_ph} /></td>
                  <td className="tnum whitespace-nowrap py-2 pl-3 text-right text-ink-2">{fmtHours(r.est_hours)}</td>
                  <td className={cn('tnum whitespace-nowrap py-2 pl-3 text-right', r.hours > r.est_hours && r.est_hours > 0 && 'text-danger-text')}>{fmtHours(r.hours)}</td>
                  <td className="tnum py-2 pl-3 text-right font-medium"><Money value={r.cost} /></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <td className="pt-2">Total</td>
                <td />
                <td className="tnum pt-2 text-right">{fmtHours(rows.reduce((s, r) => s + r.est_hours, 0))}</td>
                <td className="tnum pt-2 text-right">{fmtHours(rows.reduce((s, r) => s + r.hours, 0))}</td>
                <td className="tnum pt-2 text-right"><Money value={rows.reduce((s, r) => s + r.cost, 0)} /></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  )
}

/* ---------------- Invoicing (UI-20) ---------------- */
function Billing({ d, rows, canInvoice, invoiced, collected, contract }: { d: ProjectDetail; rows: BillingRow[]; canInvoice: boolean; invoiced: number | null; collected: number | null; contract: number }) {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const [raise, setRaise] = useState<BillingRow | null>(null)
  const [pay, setPay] = useState<InvoiceView | null>(null)
  const total = rows.reduce((s, r) => s + r.amount, 0)
  const achievedNotInvoiced = rows.filter((r) => r.billing_status === 'none' && r.state.startsWith('achieved')).reduce((s, r) => s + r.amount, 0)
  return (
    <Card>
      <CardHeader
        title="Milestone billing"
        subtitle={`${fmtMoney(collected)} collected · ${fmtMoney((invoiced ?? 0) - (collected ?? 0))} outstanding · ${fmtMoney(total - (invoiced ?? 0))} still to invoice of ${fmtMoney(total)}${contract && total !== contract ? ` (contract ${fmtMoney(contract)})` : ''}`}
      />
      {achievedNotInvoiced > 0 && (
        <Callout tone="warning" className="mb-3">
          {fmtMoney(achievedNotInvoiced)} is achieved but not invoiced yet.
        </Callout>
      )}
      {!rows.length ? (
        <EmptyState compact title="No billable milestones" body="Set a billing amount on a milestone in the WBS tab to invoice it here." />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((r) => {
            const inv = r.invoice
            return (
              <li key={r.milestone_id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tnum text-[12px] text-ink-3">M{r.no}</span>
                    <span className="text-[14px] font-medium">{r.name}</span>
                    <MsStateBadge state={r.state} size="sm" />
                  </div>
                  <div className="tnum mt-0.5 text-[12.5px] text-ink-3">
                    {inv ? (
                      <>
                        {inv.number} · {fmtDate(inv.invoiced_on)} · due {fmtDate(inv.due_on)}
                        {inv.file && (
                          <a href={inv.file.data_url ?? '#'} download={inv.file.name} className="ml-2 inline-flex items-center gap-1 text-brand-text hover:underline">
                            <Paperclip className="size-3" />
                            {inv.file.name}
                          </a>
                        )}
                      </>
                    ) : (
                      <>Deadline {fmtDate(r.planned_end)}</>
                    )}
                  </div>
                  {inv && inv.payments.length > 0 && (
                    <div className="tnum mt-0.5 text-[12px] text-ink-3">
                      {inv.payments.map((p) => `${fmtMoney(p.amount_paise)} on ${fmtDate(p.paid_on)}${p.reference ? ` (${p.reference})` : ''}`).join(' · ')}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 md:flex-nowrap md:justify-end">
                  <div className="text-right">
                    <Money value={inv ? inv.amount_paise : r.amount} className="text-[14px] font-medium" />
                    {inv && (
                      <div className="text-[12px]">
                        {inv.outstanding > 0 ? <span className="text-warning-text">{fmtMoney(inv.outstanding)} due</span> : <span className="text-success-text">Paid in full</span>}
                      </div>
                    )}
                  </div>
                  <Badge tone={r.billing_status === 'paid' ? 'success' : r.billing_status === 'invoiced' ? 'info' : 'neutral'} size="sm">
                    {r.billing_status === 'paid' ? 'Paid' : r.billing_status === 'invoiced' ? (inv && inv.paid_amount_paise > 0 ? 'Part paid' : 'Invoiced') : r.state.startsWith('achieved') ? 'To invoice' : 'Not due'}
                  </Badge>
                  {canInvoice && !readOnly && r.billing_status === 'none' && (
                    <Button size="sm" variant="primary" onClick={() => nav(`/finance/invoices/new?project=${d.project.id}&milestone=${r.milestone_id}`)}>
                      Raise invoice
                    </Button>
                  )}
                  {canInvoice && !readOnly && inv && inv.outstanding > 0 && (
                    <Button size="sm" onClick={() => nav(`/finance/invoices/${inv.id}?pay=1`)}>
                      Record payment
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <RaiseInvoiceDialog d={d} row={raise} onClose={() => setRaise(null)} />
      <PaymentDialog d={d} inv={pay} onClose={() => setPay(null)} />
    </Card>
  )
}

function RaiseInvoiceDialog({ d, row, onClose }: { d: ProjectDetail; row: BillingRow | null; onClose: () => void }) {
  const open = !!row
  const next = useApi(['invoice-next'], () => projectsApi.nextInvoiceNumber(), { enabled: open, staleTime: 0 })
  const [number, setNumber] = useState('')
  const [date, setDate] = useState(todayISO())
  const [due, setDue] = useState(addDays(todayISO(), 30))
  const [amount, setAmount] = useState(0)
  const [file, setFile] = useState<File | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!row) return
    setDate(todayISO())
    setDue(addDays(todayISO(), 30))
    setAmount(row.amount)
    setFile(null)
    setErrors({})
    setNumber('')
  }, [row])
  useEffect(() => {
    if (open && next.data && !number) setNumber(next.data.number)
  }, [open, next.data, number])
  const mut = useMut(
    async () => {
      const f = file ? { name: file.name, mime: file.type, size_bytes: file.size, data_url: await readFileAsDataURL(file) } : null
      return projectsApi.raiseInvoice(row!.milestone_id, { number: number.trim(), invoiced_on: date, due_on: due, amount_paise: amount, file: f })
    },
    {
      invalidate: [['project', d.project.id], ['projects'], ['invoice-next'], ['ledger'], ['invoices'], ['pnl'], ['dash']],
      success: (inv) => `Invoice ${inv.number} raised`,
      onSuccess: onClose,
      onError: (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message })),
    },
  )
  const submit = () => {
    const e: Record<string, string> = {}
    if (!number.trim()) e.number = 'Enter the invoice number.'
    if (!date) e.invoiced_on = 'Pick the invoice date.'
    if (due && date && due < date) e.due_on = 'Due date is before the invoice date.'
    if (!amount || amount <= 0) e.amount_paise = 'Enter an amount above zero.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Raise invoice for M${row.no}` : 'Raise invoice'}
      description={row ? `${row.name}. This books income in the ledger (locked) and marks the milestone invoiced.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Raise invoice
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Invoice number" required error={errors.number} hint={next.data && number !== next.data.number ? `Next in sequence: ${next.data.number}` : 'Must be unique.'}>
          <Input value={number} placeholder={next.isLoading ? 'Loading…' : ''} invalid={!!errors.number} onChange={(e) => { setNumber(e.target.value); setErrors((x) => ({ ...x, number: '' })) }} className="tnum" />
        </Field>
        <Field label="Amount" required error={errors.amount_paise} hint={row && amount !== row.amount ? `Milestone billing is ${fmtMoney(row.amount)}.` : 'Excluding GST.'}>
          <MoneyInput value={amount} onChange={setAmount} invalid={!!errors.amount_paise} />
        </Field>
        <Field label="Invoice date" required error={errors.invoiced_on}>
          <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); if (e.target.value) setDue(addDays(e.target.value, 30)) }} invalid={!!errors.invoiced_on} />
        </Field>
        <Field label="Due date" error={errors.due_on}>
          <Input type="date" value={due} min={date} onChange={(e) => setDue(e.target.value)} invalid={!!errors.due_on} />
        </Field>
        <Field label="Invoice file" hint="Optional. PDF or image, up to 10 MB." error={errors.file} className="sm:col-span-2">
          <FileUpload onFile={setFile} file={file ? { name: file.name, size: file.size } : null} onClear={() => setFile(null)} label="Attach the invoice PDF" />
        </Field>
      </div>
    </Dialog>
  )
}

function PaymentDialog({ d, inv, onClose }: { d: ProjectDetail; inv: InvoiceView | null; onClose: () => void }) {
  const [amount, setAmount] = useState(0)
  const [date, setDate] = useState(todayISO())
  const [ref, setRef] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!inv) return
    setAmount(inv.outstanding)
    setDate(todayISO())
    setRef('')
    setErrors({})
  }, [inv])
  const mut = useMut(() => projectsApi.recordPayment(inv!.id, { amount_paise: amount, paid_on: date, reference: ref }), {
    invalidate: [['project', d.project.id], ['projects'], ['ledger'], ['invoices'], ['pnl'], ['dash']],
    success: (r) => (r.paid_amount_paise >= r.amount_paise ? `${r.number} paid in full` : `Payment recorded on ${r.number}`),
    onSuccess: onClose,
    onError: (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message })),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!amount || amount <= 0) e.amount_paise = 'Enter an amount above zero.'
    else if (inv && amount > inv.outstanding) e.amount_paise = `Only ${fmtMoney(inv.outstanding)} is outstanding.`
    if (!date) e.paid_on = 'Pick the payment date.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate(undefined)
  }
  return (
    <Dialog
      open={!!inv}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={inv ? `Record payment on ${inv.number}` : 'Record payment'}
      description={inv ? `${fmtMoney(inv.outstanding)} outstanding of ${fmtMoney(inv.amount_paise)}. Partial payments are fine.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>
            Record payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Amount received" required error={errors.amount_paise}>
          <MoneyInput value={amount} onChange={setAmount} invalid={!!errors.amount_paise} />
        </Field>
        <Field label="Received on" required error={errors.paid_on}>
          <Input type="date" value={date} min={inv?.invoiced_on} onChange={(e) => setDate(e.target.value)} invalid={!!errors.paid_on} />
        </Field>
        <Field label="Reference" hint="UTR, cheque or UPI reference.">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. NEFT 402218873" />
        </Field>
      </div>
    </Dialog>
  )
}
