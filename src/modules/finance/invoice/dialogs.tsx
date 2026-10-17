// Record payment (cash + TDS against the GST total), email to client, and invoice settings.
import { useEffect, useState } from 'react'
import { Button, Dialog, Field, Input, MoneyInput, Select, Sheet, Textarea } from '@/ui'
import { useApi, useMut } from '@/api/query'
import type { ApiError } from '@/api/http'
import { INVOICE_INVALIDATE, invoicesApi, type InvoiceDetail, type InvoiceSettings } from '@/api/invoices'
import { todayISO } from '@/domain/calendar'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { fileNameOf, inr, PAY_MODES } from './labels'

/* ---------------- record payment ---------------- */
export function PaymentDialog({ d, open, onClose }: { d: InvoiceDetail; open: boolean; onClose: () => void }) {
  const [received, setReceived] = useState(0)
  const [tds, setTds] = useState(0)
  const [date, setDate] = useState(todayISO())
  const [mode, setMode] = useState('NEFT')
  const [ref, setRef] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setTds(d.suggested_tds_paise)
    setReceived(Math.max(0, d.balance_paise - d.suggested_tds_paise))
    setDate(todayISO())
    setMode('NEFT')
    setRef('')
    setErrors({})
  }, [open, d.balance_paise, d.suggested_tds_paise])
  const mut = useMut(() => invoicesApi.pay(d.invoice.id, { received_paise: received, tds_paise: tds, paid_on: date, reference: ref.trim(), mode }, d.invoice.version), {
    invalidate: INVOICE_INVALIDATE,
    success: (r) => (r.fully_paid ? `${d.invoice.number} paid in full` : `Part payment recorded on ${d.invoice.number}`),
    onSuccess: onClose,
    onError: (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field === 'received_paise' ? 'received' : e.field === 'tds_paise' ? 'tds' : e.field === 'paid_on' ? 'date' : e.field!]: e.message })),
  })
  const settle = received + tds
  const left = d.balance_paise - settle
  const submit = () => {
    const e: Record<string, string> = {}
    if (settle <= 0) e.received = 'Enter the amount received.'
    else if (left < 0) e.received = `Received + TDS is more than the ${inr(d.balance_paise)} due.`
    if (!date) e.date = 'Pick the date the money arrived.'
    else if (date > todayISO()) e.date = 'The date can’t be in the future.'
    else if (date < d.invoice.invoiced_on) e.date = 'The date can’t be before the invoice date.'
    setErrors(e)
    if (!Object.values(e).some(Boolean)) mut.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Record payment"
      description={`${d.invoice.number} · ${d.invoice.bill_to?.name ?? ''}. Cash received plus TDS deducted settle the invoice; paid in full marks ${d.milestones.length ? 'the milestone' : 'the invoice'} Paid.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>Record payment</Button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-3 divide-x divide-line rounded-md border border-line text-center [&>div]:min-w-0 [&>div]:px-1.5 [&>div]:py-2.5">
        <div><div className="text-[11.5px] text-ink-3">Invoice total</div><div className="tnum whitespace-nowrap text-[12.5px] font-semibold sm:text-[13.5px]">{inr(d.totals.total)}</div></div>
        <div><div className="text-[11.5px] text-ink-3">Settled</div><div className="tnum whitespace-nowrap text-[12.5px] font-semibold sm:text-[13.5px]">{inr(d.settled_paise)}</div></div>
        <div><div className="text-[11.5px] text-ink-3">Balance due</div><div className="tnum whitespace-nowrap text-[12.5px] font-semibold sm:text-[13.5px]">{inr(d.balance_paise)}</div></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount received" required error={errors.received} aside={<button type="button" className="text-[12.5px] font-semibold text-brand-text hover:underline" onClick={() => setReceived(Math.max(0, d.balance_paise - tds))}>Rest of balance</button>}>
          <MoneyInput value={received} onChange={(v) => { setReceived(v); setErrors((x) => ({ ...x, received: '' })) }} invalid={!!errors.received || left < 0} />
        </Field>
        <Field label="TDS deducted by client" error={errors.tds} hint={d.invoice.tds_pct ? `Expected ${d.invoice.tds_pct}% of the taxable value` : 'Leave 0 if no TDS'}>
          <MoneyInput value={tds} onChange={(v) => { setTds(v); setErrors((x) => ({ ...x, tds: '' })) }} invalid={!!errors.tds} />
        </Field>
        <Field label="Date received" required error={errors.date}>
          <Input type="date" value={date} min={d.invoice.invoiced_on} max={todayISO()} onChange={(e) => setDate(e.target.value)} invalid={!!errors.date} />
        </Field>
        <Field label="Mode">
          <Select value={mode} onChange={(e) => setMode(e.target.value)} options={PAY_MODES} />
        </Field>
        <Field label="Reference" hint="UTR, cheque or UPI reference" className="sm:col-span-2">
          <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="e.g. UTR HDFCN26287441712" />
        </Field>
      </div>
      <p className="mt-3 text-[12.5px] text-ink-3">
        {left > 0 ? `Part payment — ${inr(left)} will remain due.` : left === 0 && settle > 0 ? 'Settles the invoice in full.' : ''} Revenue was booked at the taxable value on the invoice date; payments update collections, the ledger row and the milestone.
      </p>
      {d.payments.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-[13px] font-semibold text-ink">Earlier payments</div>
          <ul className="divide-y divide-line rounded-lg border border-line text-[13px]">
            {d.payments.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate text-ink-2">{fmtDate(p.paid_on)}{p.reference && <span className="text-ink-3"> · {p.reference}</span>}</span>
                <span className="tnum shrink-0 font-semibold">{inr(p.gross_paise)}{p.tds_paise ? <span className="font-normal text-ink-3"> + {inr(p.tds_paise)} TDS</span> : null}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  )
}

/* ---------------- email to client ---------------- */
export function EmailDialog({ d, open, onClose }: { d: InvoiceDetail; open: boolean; onClose: () => void }) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    const inv = d.invoice
    setTo(d.client_email)
    setCc('')
    setSubject(`Tax invoice ${inv.number} from ${inv.seller?.name ?? ''}`)
    setMessage(`Dear ${inv.bill_to?.contact || inv.bill_to?.name || 'Sir/Madam'},\n\nPlease find attached our tax invoice ${inv.number} dated ${fmtDate(inv.invoiced_on, 'long')} for ${inr(d.totals.total)} (including GST), due on ${fmtDate(inv.due_on, 'long')}.\n\nKindly arrange payment to the bank account shown on the invoice and share the TDS certificate when available.\n\nRegards,\n${inv.signatory?.name || inv.seller?.name || ''}`)
    setErrors({})
  }, [open, d])
  const mut = useMut(() => invoicesApi.email(d.invoice.id, { to: to.trim(), cc: cc.trim(), subject: subject.trim(), message: message.trim() }), {
    invalidate: INVOICE_INVALIDATE,
    success: () => `Invoice emailed to ${to.trim()}`,
    onSuccess: onClose,
    onError: (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message })),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim())) e.to = 'Enter the client’s email address.'
    if (message.trim().length < 5) e.message = 'Write a short message.'
    setErrors(e)
    if (!Object.keys(e).length) mut.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Email invoice to client"
      description={`The PDF (${fileNameOf(d.invoice.number)}) is attached. Sent mail is kept under Setup → Emails → Sent.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={submit}>Send email</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="To" required error={errors.to}>
          <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} invalid={!!errors.to} placeholder="accounts@client.com" />
        </Field>
        <Field label="Cc" error={errors.cc} hint="Separate addresses with commas">
          <Input value={cc} onChange={(e) => setCc(e.target.value)} invalid={!!errors.cc} />
        </Field>
        <Field label="Subject" className="sm:col-span-2">
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Message" required error={errors.message} className="sm:col-span-2">
          <Textarea rows={8} value={message} onChange={(e) => setMessage(e.target.value)} invalid={!!errors.message} />
        </Field>
      </div>
      {d.emails.length > 0 && (
        <p className="mt-3 text-[12.5px] text-ink-3">Sent before: {d.emails.map((e) => `${e.to} on ${fmtDateTime(e.at)}`).join(' · ')}</p>
      )}
    </Dialog>
  )
}

/* ---------------- invoice settings ---------------- */
type SettingsForm = InvoiceSettings
export function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const q = useApi(['invoices', 'settings'], invoicesApi.settings, { enabled: open, staleTime: 0 })
  const [f, setF] = useState<SettingsForm | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (open && q.data) {
      setF(q.data)
      setErrors({})
    }
  }, [open, q.data])
  const canEdit = !!q.data?.can_edit
  const mut = useMut(() => invoicesApi.saveSettings(f!), {
    invalidate: [['invoices'], ['invoice'], ['setup'], ['org']],
    success: 'Invoice settings saved',
    onSuccess: onClose,
    onError: (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message })),
  })
  const set = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) => setF((x) => (x ? { ...x, [k]: v } : x))
  const setBank = (k: keyof SettingsForm['bank'], v: string) => setF((x) => (x ? { ...x, bank: { ...x.bank, [k]: v } } : x))
  const example = f ? `${f.prefix || 'INV'}/26-27/0001` : ''
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Invoice settings"
      subtitle="Numbering, defaults and the bank account printed on every invoice. The full account number is visible only to people who raise invoices."
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!f || !canEdit} loading={mut.isPending} onClick={() => mut.mutate(undefined)}>Save settings</Button>
        </>
      }
    >
      {!f ? (
        <p className="text-[13px] text-ink-3">Loading…</p>
      ) : (
        <div className="space-y-6">
          <section className="grid gap-4 sm:grid-cols-2">
            <h3 className="text-[13.5px] font-semibold text-ink sm:col-span-2">Numbering and defaults</h3>
            <Field label="Invoice prefix" required error={errors.prefix} hint={`Numbers run per financial year: ${example}`}>
              <Input value={f.prefix} disabled={!canEdit} onChange={(e) => set('prefix', e.target.value.toUpperCase())} invalid={!!errors.prefix} />
            </Field>
            <Field label="Credit-note prefix" error={errors.credit_note_prefix}>
              <Input value={f.credit_note_prefix} disabled={!canEdit} onChange={(e) => set('credit_note_prefix', e.target.value.toUpperCase())} invalid={!!errors.credit_note_prefix} />
            </Field>
            <Field label="Payment terms (days)" error={errors.payment_terms_days} hint="Used when the client has no terms of its own">
              <Input type="number" min={0} max={180} value={f.payment_terms_days} disabled={!canEdit} onChange={(e) => set('payment_terms_days', Number(e.target.value))} invalid={!!errors.payment_terms_days} />
            </Field>
            <Field label="Default HSN/SAC" error={errors.default_sac} hint="998314 = IT consulting and support services">
              <Input value={f.default_sac} disabled={!canEdit} onChange={(e) => set('default_sac', e.target.value)} invalid={!!errors.default_sac} />
            </Field>
            <Field label="Default GST rate" error={errors.default_gst_rate}>
              <Select value={String(f.default_gst_rate)} disabled={!canEdit} onChange={(e) => set('default_gst_rate', Number(e.target.value))} options={['0', '5', '12', '18', '28'].map((x) => ({ value: x, label: `${x}%` }))} />
            </Field>
            <Field label="TDS expected (%)" error={errors.default_tds_pct} hint="Shown on the invoice for information">
              <Input type="number" min={0} max={20} step={0.5} value={f.default_tds_pct} disabled={!canEdit} onChange={(e) => set('default_tds_pct', Number(e.target.value))} invalid={!!errors.default_tds_pct} />
            </Field>
            <Field label="LUT number" hint="Letter of Undertaking for zero-rated exports" className="sm:col-span-2">
              <Input value={f.lut_number} disabled={!canEdit} onChange={(e) => set('lut_number', e.target.value.toUpperCase())} />
            </Field>
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <h3 className="text-[13.5px] font-semibold text-ink sm:col-span-2">Bank account on invoices</h3>
            <Field label="Bank name" error={errors['bank.bank_name']}>
              <Input value={f.bank.bank_name} disabled={!canEdit} onChange={(e) => setBank('bank_name', e.target.value)} />
            </Field>
            <Field label="Account name">
              <Input value={f.bank.account_name} disabled={!canEdit} onChange={(e) => setBank('account_name', e.target.value)} />
            </Field>
            <Field label="Account number" error={errors['bank.account_number']} hint={canEdit ? 'Sensitive: only finance editors see it in full' : `On file: ${q.data?.account_masked || '—'}`}>
              <Input inputMode="numeric" value={f.bank.account_number} disabled={!canEdit} onChange={(e) => setBank('account_number', e.target.value.replace(/\s+/g, ''))} invalid={!!errors['bank.account_number']} />
            </Field>
            <Field label="IFSC" error={errors['bank.ifsc']}>
              <Input value={f.bank.ifsc} disabled={!canEdit} onChange={(e) => setBank('ifsc', e.target.value.toUpperCase())} invalid={!!errors['bank.ifsc']} />
            </Field>
            <Field label="Branch">
              <Input value={f.bank.branch} disabled={!canEdit} onChange={(e) => setBank('branch', e.target.value)} />
            </Field>
            <Field label="UPI ID" error={errors['bank.upi']}>
              <Input value={f.bank.upi} disabled={!canEdit} onChange={(e) => setBank('upi', e.target.value)} invalid={!!errors['bank.upi']} />
            </Field>
          </section>
          <section className="grid gap-4 sm:grid-cols-2">
            <h3 className="text-[13.5px] font-semibold text-ink sm:col-span-2">Signature, notes and terms</h3>
            <Field label="Authorised signatory">
              <Input value={f.signatory_name} disabled={!canEdit} onChange={(e) => set('signatory_name', e.target.value)} />
            </Field>
            <Field label="Designation">
              <Input value={f.signatory_title} disabled={!canEdit} onChange={(e) => set('signatory_title', e.target.value)} />
            </Field>
            <Field label="Default notes" className="sm:col-span-2">
              <Input value={f.default_notes} disabled={!canEdit} onChange={(e) => set('default_notes', e.target.value)} />
            </Field>
            <Field label="Default terms and conditions" hint="One term per line" className="sm:col-span-2">
              <Textarea rows={5} value={f.default_terms} disabled={!canEdit} onChange={(e) => set('default_terms', e.target.value)} />
            </Field>
          </section>
        </div>
      )}
    </Sheet>
  )
}
