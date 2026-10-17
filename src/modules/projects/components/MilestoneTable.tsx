// G4.01–G4.08 — the Milestones table (Feature Guide screenshot 006): progress, automatic deadline with baseline and slip,
// achieved / forecast end, delivery status, billing state, edit / delete and the inline "Add milestone" row.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock } from '@/ui/icons'
import { milestoneApi, projectsApi, type MilestoneInput, type MilestoneView, type ProjectDetail } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { addDays, fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, Dialog, Field, Input, MoneyInput, Progress, Select, useConfirm, useReadOnly } from '@/ui'
import { MS_STATE } from './shared'

const BILL_LABEL = { none: 'Not due', invoiced: 'Invoiced', paid: 'Paid' } as const
type Bill = keyof typeof BILL_LABEL

export function MilestoneTable({ d, className }: { d: ProjectDetail; className?: string }) {
  const readOnly = useReadOnly()
  const editable = d.can_edit && !readOnly
  const showBilling = !!d.billing_summary
  const [edit, setEdit] = useState<MilestoneView | null>(null)
  const nav = useNavigate()
  // v7: Invoiced / Paid open the GST invoice editor (prefilled with the milestone) or the invoice's payment dialog
  const onInvoice = (m: MilestoneView) => nav(`/finance/invoices/new?project=${d.project.id}&milestone=${m.id}`)
  const onPay = (m: MilestoneView) => (m.invoice ? nav(`/finance/invoices/${m.invoice.id}?pay=1`) : onInvoice(m))
  const bs = d.billing_summary
  return (
    <Card pad={false} className={cn('min-w-0', className)}>
      <div className="px-4 pb-3 pt-4 md:px-5 md:pt-5">
        <h2 className="text-[14px] font-semibold text-ink">Milestones</h2>
        <p className="mt-0.5 max-w-[110ch] text-[12.5px] leading-snug text-ink-3">
          A milestone’s deadline is always the target end of its last task. Numbers are fixed once given (M1, M2… and 1.1, 1.2…). A milestone with no tasks is removed automatically after 7 days, unless it has been invoiced.
        </p>
      </div>
      {!d.milestones.length ? (
        <p className="border-t border-line px-4 py-6 text-center text-[13px] text-ink-3 md:px-5">No milestones yet. Add the first one below — a name is enough.</p>
      ) : (
        <>
          {/* desktop / tablet table */}
          <div className="hidden overflow-x-auto border-t border-line md:block scroll-thin">
            <table className="w-full min-w-[860px] border-collapse text-[13.5px]">
              <thead>
                <tr className="border-b border-line bg-surface-2/70 text-left text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                  <th className="h-9 pl-4 pr-3 md:pl-5">Milestone</th>
                  <th className="w-[130px] px-3">Progress</th>
                  <th className="w-[150px] px-3 text-right">Deadline</th>
                  <th className="w-[96px] px-3 text-right">End</th>
                  <th className="w-[150px] px-3">Status</th>
                  {showBilling && <th className="w-[150px] px-3 text-right">Billing</th>}
                  {editable && <th aria-label="Actions" className="w-[150px] pl-3 pr-4 md:pr-5" />}
                </tr>
              </thead>
              <tbody>
                {d.milestones.map((m) => (
                  <tr key={m.id} className="border-b border-line last:border-0 align-middle">
                    <td className="py-2.5 pl-4 pr-3 md:pl-5">
                      <div className="min-w-0">
                        <span className="tnum mr-1.5 font-semibold text-ink">M{m.no}</span>
                        <span className="text-ink">{m.name}</span>
                      </div>
                      <div className="text-[12.5px] text-ink-3">
                        {m.task_count} task{m.task_count === 1 ? '' : 's'}
                        {m.auto_delete_on && <span className="text-warning-text"> · no tasks: removed {fmtDate(m.auto_delete_on)}</span>}
                      </div>
                    </td>
                    <td className="px-3">
                      <Progress value={m.progress} height={6} tone={progressTone(m)} />
                      <div className="tnum mt-1 text-[12.5px] text-ink-2">{fmtPct(m.progress, 0)}</div>
                    </td>
                    <td className="px-3 text-right">
                      <Deadline m={m} />
                    </td>
                    <td className="px-3 text-right">
                      <EndCell m={m} />
                    </td>
                    <td className="px-3">
                      <StateBadge m={m} />
                    </td>
                    {showBilling && (
                      <td className="px-3 text-right">
                        <div className="tnum whitespace-nowrap text-ink">{m.billing_amount_paise ? fmtMoney(m.billing_amount_paise) : '—'}</div>
                        <BillingControl d={d} m={m} onInvoice={() => onInvoice(m)} onPay={() => onPay(m)} />
                      </td>
                    )}
                    {editable && (
                      <td className="pl-3 pr-4 md:pr-5">
                        <RowActions d={d} m={m} onEdit={() => setEdit(m)} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* phones: stacked rows */}
          <ul className="divide-y divide-line border-t border-line md:hidden">
            {d.milestones.map((m) => (
              <li key={m.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[14px] leading-snug">
                      <span className="tnum mr-1.5 font-semibold">M{m.no}</span>
                      {m.name}
                    </div>
                    <div className="text-[12.5px] text-ink-3">{m.task_count} task{m.task_count === 1 ? '' : 's'}</div>
                  </div>
                  <StateBadge m={m} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Progress value={m.progress} height={5} tone={progressTone(m)} className="flex-1" />
                  <span className="tnum w-10 text-right text-[12.5px] text-ink-2">{fmtPct(m.progress, 0)}</span>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 text-[13px]">
                  <div>
                    <div className="text-[12px] text-ink-3">Deadline</div>
                    <Deadline m={m} align="left" />
                  </div>
                  <div>
                    <div className="text-[12px] text-ink-3">End</div>
                    <EndCell m={m} align="left" />
                  </div>
                </div>
                {(showBilling || editable) && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {showBilling && (
                      <div className="flex items-center gap-2">
                        <span className="tnum text-[13px] text-ink">{m.billing_amount_paise ? fmtMoney(m.billing_amount_paise) : 'Not billed'}</span>
                        <BillingControl d={d} m={m} onInvoice={() => onInvoice(m)} onPay={() => onPay(m)} />
                      </div>
                    )}
                    {editable && (
                      <div className="ml-auto">
                        <RowActions d={d} m={m} onEdit={() => setEdit(m)} />
                      </div>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {bs && bs.total > 0 && (
        <p className="border-t border-line px-4 py-3 text-[13px] leading-relaxed text-ink-2 md:px-5">
          Billing: <span className="tnum font-semibold text-ink">{fmtMoney(bs.paid)}</span> paid, <span className="tnum font-semibold text-ink">{fmtMoney(bs.invoiced_unpaid)}</span> invoiced and unpaid,{' '}
          <span className={cn('tnum font-semibold', bs.achieved_not_invoiced ? 'text-warning-text' : 'text-ink')}>{fmtMoney(bs.achieved_not_invoiced)}</span> achieved but not invoiced, of <span className="tnum">{fmtMoney(bs.total)}</span>.
        </p>
      )}
      {editable && <AddMilestoneRow d={d} />}
      <MilestoneDialog d={d} open={!!edit} ms={edit} onOpenChange={(o) => !o && setEdit(null)} />
    </Card>
  )
}

const progressTone = (m: MilestoneView) => (m.state === 'achieved_late' || m.state === 'overdue' ? 'danger' : m.state === 'achieved_on_time' ? 'success' : m.state === 'at_risk' ? 'warning' : 'brand')

function Deadline({ m, align = 'right' }: { m: MilestoneView; align?: 'left' | 'right' }) {
  return (
    <div className={cn('tnum whitespace-nowrap', align === 'right' ? 'text-right' : 'text-left')}>
      <div className="text-ink">{fmtDate(m.planned_end)}</div>
      <div className="text-[12px] text-ink-3">
        baseline {fmtDate(m.baseline_end)}
        {m.slip > 0 && <span className="font-semibold text-danger-text">, +{m.slip}d</span>}
      </div>
      {!m.task_count && <div className="text-[11.5px] text-ink-3">provisional</div>}
    </div>
  )
}
function EndCell({ m, align = 'right' }: { m: MilestoneView; align?: 'left' | 'right' }) {
  if (!m.end_on) return <span className="text-ink-3">—</span>
  const late = m.end_on > m.planned_end
  return (
    <div className={cn('tnum whitespace-nowrap', align === 'right' ? 'text-right' : 'text-left')}>
      <div className={cn(late ? 'font-semibold text-danger-text' : 'text-ink')}>{fmtDate(m.end_on)}</div>
      <div className={cn('text-[12px]', late ? 'font-medium text-ink-2' : 'text-ink-3')}>{m.end_kind}</div>
    </div>
  )
}
function StateBadge({ m }: { m: MilestoneView }) {
  const s = MS_STATE[m.state]
  return (
    <Badge tone={m.state === 'achieved_late' ? 'danger' : s.tone} size="sm">
      {s.label}
    </Badge>
  )
}

function BillingControl({ d, m, onInvoice, onPay }: { d: ProjectDetail; m: MilestoneView; onInvoice: () => void; onPay: () => void }) {
  const ro = useReadOnly()
  const tone = m.billing_status === 'paid' ? 'success' : m.billing_status === 'invoiced' ? 'info' : 'neutral'
  if (!d.can_bill || ro || (!m.billing_amount_paise && m.billing_status === 'none'))
    return (
      <Badge tone={tone} size="sm" className="mt-1">
        {m.billing_status === 'invoiced' && m.invoice ? `Invoiced ${m.invoice.number}` : BILL_LABEL[m.billing_status]}
      </Badge>
    )
  return (
    <Select
      aria-label={`Billing state for M${m.no}`}
      className="ml-auto mt-1 w-[128px] [--ctl-h:32px] text-[13px]"
      value={m.billing_status}
      onChange={(e) => {
        const v = e.target.value as Bill
        if (v === m.billing_status) return
        if (v === 'invoiced' && m.billing_status === 'none') onInvoice()
        else if (v === 'paid' && m.billing_status === 'none') onInvoice()
        else if (v === 'paid' && m.billing_status === 'invoiced') onPay()
      }}
      options={[
        { value: 'none', label: 'Not due', disabled: m.billing_status !== 'none' },
        { value: 'invoiced', label: 'Invoiced', disabled: m.billing_status === 'paid' },
        { value: 'paid', label: 'Paid' },
      ]}
    />
  )
}

function RowActions({ d, m, onEdit }: { d: ProjectDetail; m: MilestoneView; onEdit: () => void }) {
  const { confirm } = useConfirm()
  const del = useMut(() => projectsApi.deleteMilestone(m.id), {
    invalidate: [['project', d.project.id], ['projects'], ['delivery']],
    success: (r) => (r.moved_tasks ? `M${m.no} deleted · ${r.moved_tasks} task${r.moved_tasks === 1 ? '' : 's'} moved to No milestone` : `M${m.no} deleted`),
  })
  const invoiced = m.billing_status !== 'none'
  return (
    <div className="flex justify-end gap-1.5">
      <Button size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button
        size="sm"
        variant={invoiced ? 'secondary' : 'outline-danger'}
        disabled={invoiced || del.isPending}
        icon={invoiced ? <Lock className="size-3.5" /> : undefined}
        title={invoiced ? 'Invoiced milestones can’t be deleted' : undefined}
        className="min-w-[84px] justify-center"
        onClick={async () => {
          const ok = await confirm({
            title: `Delete M${m.no} ${m.name}?`,
            body: m.task_count ? `${m.task_count === 1 ? 'Its task stays' : `Its ${m.task_count} tasks stay`} in the project under “No milestone” and keep their numbers (${m.no}.1, ${m.no}.2 …); allocations on it are removed. M${m.no} won’t be reused.` : `Allocations on it are removed. M${m.no} won’t be reused.`,
            confirmLabel: 'Delete milestone',
            tone: 'danger',
          })
          if (ok) del.mutate(undefined)
        }}
      >
        Delete
      </Button>
    </div>
  )
}

function AddMilestoneRow({ d }: { d: ProjectDetail }) {
  const [name, setName] = useState('')
  const [amt, setAmt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const add = useMut((b: { name: string; billing_amount_paise: number }) => milestoneApi.addQuick(d.project.id, b), {
    invalidate: [['project', d.project.id], ['projects']],
    success: (m) => `M${m.no} added`,
    onSuccess: () => {
      setName('')
      setAmt(0)
      setError(null)
    },
    onError: (e: ApiError) => setError(e.message),
  })
  const submit = () => {
    if (!name.trim()) return setError('Give the milestone a name.')
    add.mutate({ name: name.trim(), billing_amount_paise: amt })
  }
  return (
    <div className="border-t border-line px-4 py-3 md:px-5">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          aria-label="New milestone name"
          value={name}
          invalid={!!error}
          placeholder="New milestone, e.g. UAT sign-off"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <MoneyInput value={amt} onChange={setAmt} placeholder="Billing amount (optional)" />
        <Button variant="primary" loading={add.isPending} onClick={submit}>
          Add milestone
        </Button>
      </div>
      {error ? <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{error}</p> : <p className="mt-1.5 text-[12.5px] text-ink-3">No dates needed: it gets provisional dates after the last milestone until its tasks set the deadline.</p>}
    </div>
  )
}

/* ---------------- edit milestone ---------------- */
export function MilestoneDialog({ d, open, ms, onOpenChange }: { d: ProjectDetail; open: boolean; ms: MilestoneView | null; onOpenChange: (o: boolean) => void }) {
  const last = d.milestones[d.milestones.length - 1]
  const blank = (): MilestoneInput => {
    const s = last ? addDays(last.planned_end, 1) : d.project.start_on
    const e = addDays(s, 20)
    return { name: '', planned_start: s, planned_end: e, billing_amount_paise: 0 }
  }
  const [f, setF] = useState<MilestoneInput>(blank)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setErrors({})
    setF(ms ? { name: ms.name, planned_start: ms.planned_start, planned_end: ms.planned_end, billing_amount_paise: ms.billing_amount_paise } : blank())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ms?.id])
  const onError = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const inv = [['project', d.project.id], ['projects']]
  const add = useMut((b: MilestoneInput) => projectsApi.addMilestone(d.project.id, b), { invalidate: inv, success: (m) => `M${m.no} added`, onSuccess: () => onOpenChange(false), onError })
  const save = useMut((b: Partial<MilestoneInput>) => projectsApi.updateMilestone(ms!.id, b, ms!.version), { invalidate: inv, success: 'Milestone updated', onSuccess: () => onOpenChange(false), onError })
  const invoiced = !!ms && ms.billing_status !== 'none'
  const auto = !!ms && ms.task_count > 0
  const nextNo = Math.max(0, ...d.milestones.map((m) => m.no)) + 1
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.name.trim()) e.name = 'Give the milestone a name.'
    if (!auto) {
      if (!f.planned_start) e.planned_start = 'Pick a start date.'
      if (!f.planned_end) e.planned_end = 'Pick an end date.'
      if (f.planned_start && f.planned_end && f.planned_end < f.planned_start) e.planned_end = 'The end date is before the start date.'
    }
    setErrors(e)
    if (Object.keys(e).length) return
    const body: Partial<MilestoneInput> = { name: f.name.trim() }
    if (!auto) Object.assign(body, { planned_start: f.planned_start, planned_end: f.planned_end })
    if (!invoiced) body.billing_amount_paise = f.billing_amount_paise
    if (ms) save.mutate(body)
    else add.mutate(f)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={ms ? `Edit M${ms.no}` : `New milestone M${nextNo}`}
      description={ms ? `Baseline ${fmtDate(ms.baseline_end)}. ${auto ? 'The deadline follows the target end of its last task.' : 'Dates are provisional until it has tasks.'}` : 'The number is assigned in order and never reused.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>
            {ms ? 'Save milestone' : 'Add milestone'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required error={errors.name} className="sm:col-span-2">
          <Input autoFocus value={f.name} invalid={!!errors.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. UAT sign-off" />
        </Field>
        <Field label="Start" required={!auto} error={errors.planned_start} hint={auto ? 'Earliest task start' : undefined}>
          <Input type="date" value={f.planned_start} disabled={auto} invalid={!!errors.planned_start} onChange={(e) => setF({ ...f, planned_start: e.target.value })} />
        </Field>
        <Field label="Deadline" required={!auto} error={errors.planned_end} hint={auto ? 'Target end of its last task' : undefined}>
          <Input type="date" value={f.planned_end} min={f.planned_start} disabled={auto} invalid={!!errors.planned_end} onChange={(e) => setF({ ...f, planned_end: e.target.value })} />
        </Field>
        <Field label="Billing amount" error={errors.billing_amount_paise} hint={invoiced ? `Invoiced for ${fmtMoney(ms!.billing_amount_paise)}: the amount is fixed.` : 'Leave empty if this milestone isn’t billed.'} className="sm:col-span-2">
          <MoneyInput value={f.billing_amount_paise} disabled={invoiced} onChange={(v) => setF({ ...f, billing_amount_paise: v })} invalid={!!errors.billing_amount_paise} />
        </Field>
      </div>
    </Dialog>
  )
}
