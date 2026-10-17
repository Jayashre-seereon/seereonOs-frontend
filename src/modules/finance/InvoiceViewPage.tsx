// One GST tax invoice: the printable document, plus Download PDF, Print, Record payment, Email, Duplicate,
// Edit (draft) / Edit notes (issued), Issue (draft), Discard (draft) and Cancel (issued, with a reason → credit note).
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Banknote, Copy, Download, Mail, MoreHorizontal, Pencil, Printer, Send, Trash2, XCircle } from '@/ui/icons'
import { Badge, Button, Card, CardHeader, Dialog, ErrorState, Field, IconButton, Menu, PageHeader, SkeletonCards, Textarea, useCan, useConfirm, useReadOnly } from '@/ui'
import { useMut } from '@/api/query'
import { INVOICE_INVALIDATE, invoicesApi, useInvoice, type InvoiceDetail } from '@/api/invoices'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { InvoiceDocument, PRINT_CSS, useInvoiceLogo } from './invoice/InvoiceDocument'
import { EmailDialog, PaymentDialog } from './invoice/dialogs'
import { downloadInvoicePdf } from './invoice/pdf'
import { INVOICE_STATUS, TAX_MODE, inr } from './invoice/labels'

export default function InvoiceViewPage() {
  const { id } = useParams()
  const q = useInvoice(id)
  if (q.isLoading) return <SkeletonCards n={3} />
  if (q.error || !q.data) return <ErrorState error={q.error ?? new Error('Invoice not found')} onRetry={() => q.refetch()} />
  return <View d={q.data} />
}

function View({ d }: { d: InvoiceDetail }) {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const can = useCan()
  const readOnly = useReadOnly()
  const edit = can('finance.edit') && !readOnly && d.can_edit
  const { confirm, askReason } = useConfirm()
  const logo = useInvoiceLogo()
  const inv = d.invoice
  const draft = d.status === 'draft'
  const cancelled = d.status === 'cancelled'
  const [paying, setPaying] = useState(false)
  const [emailing, setEmailing] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => {
    if (params.get('pay') === '1' && d.can_pay && edit) {
      setPaying(true)
      const p = new URLSearchParams(params)
      p.delete('pay')
      setParams(p, { replace: true })
    }
  }, [params, d.can_pay, edit, setParams])

  const issue = useMut(() => invoicesApi.issue(inv.id), { invalidate: INVOICE_INVALIDATE, success: (r) => `Invoice ${r.invoice.number} issued` })
  const discard = useMut(() => invoicesApi.discard(inv.id, inv.version), { invalidate: INVOICE_INVALIDATE, success: 'Draft discarded', onSuccess: () => nav('/finance/invoices') })
  const cancel = useMut((reason: string) => invoicesApi.cancel(inv.id, reason), { invalidate: INVOICE_INVALIDATE, success: (r) => `Invoice cancelled — credit note ${r.invoice.credit_note?.number ?? ''}` })
  const dup = useMut(() => invoicesApi.duplicate(inv.id), { invalidate: INVOICE_INVALIDATE, success: 'Draft copy created', onSuccess: (r) => nav(`/finance/invoices/${r.invoice.id}/edit`) })

  const pdf = async () => {
    setPdfBusy(true)
    try {
      await downloadInvoicePdf(d, logo)
    } finally {
      setPdfBusy(false)
    }
  }
  const doIssue = async () => {
    if (await confirm({ title: 'Issue this invoice?', body: `It gets the next number in the series (${d.next_number ?? 'auto'}), books ${inr(d.totals.taxable)} revenue in the ledger${d.milestones.length ? ' and marks the milestone Invoiced' : ''}. Only the notes can be changed afterwards.`, confirmLabel: 'Issue invoice', tone: 'primary' })) issue.mutate(undefined)
  }
  const doDiscard = async () => {
    if (await confirm({ title: 'Discard this draft?', body: 'The draft is deleted. Nothing was booked yet.', confirmLabel: 'Discard draft', tone: 'danger' })) discard.mutate(undefined)
  }
  const doCancel = async () => {
    const reason = await askReason({ title: `Cancel ${inv.number}?`, body: `A credit note reverses ${inr(d.totals.taxable)} of revenue today${d.milestones.length ? ' and the milestone goes back to Not due' : ''}. The number stays used.`, label: 'Reason', placeholder: 'e.g. Client asked to bill M2 and M3 together on one invoice', minLength: 10, confirmLabel: 'Cancel invoice', tone: 'danger' })
    if (reason) cancel.mutate(reason)
  }

  const title = draft ? `Draft invoice ${inv.draft_no ?? ''}`.trim() : inv.number
  return (
    <div>
      <style>{PRINT_CSS}</style>
      <PageHeader
        back={{ to: '/finance/invoices', label: 'Invoices' }}
        title={title}
        subtitle={`${inv.bill_to?.name ?? ''} · ${d.project.code} ${d.project.name}`}
        meta={
          <>
            <Badge tone={INVOICE_STATUS[d.status].tone}>{INVOICE_STATUS[d.status].label}</Badge>
            <span className="text-[12.5px] text-ink-3">{TAX_MODE[d.totals.tax_mode].label}</span>
            {d.days_overdue > 0 && <span className="text-[12.5px] font-medium text-danger-text">{d.days_overdue} days overdue</span>}
          </>
        }
        actions={
          <>
            <Button icon={<Download className="size-4" />} loading={pdfBusy} onClick={pdf}>Download PDF</Button>
            <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>Print</Button>
            {draft && edit && <Button icon={<Pencil className="size-4" />} onClick={() => nav(`/finance/invoices/${inv.id}/edit`)}>Edit</Button>}
            {draft && edit && <Button variant="primary" icon={<Send className="size-4" />} loading={issue.isPending} onClick={doIssue}>Issue invoice</Button>}
            {!draft && !cancelled && edit && <Button icon={<Mail className="size-4" />} onClick={() => setEmailing(true)}>Email</Button>}
            {d.can_pay && edit && <Button variant="primary" icon={<Banknote className="size-4" />} onClick={() => setPaying(true)}>Record payment</Button>}
            {edit && (
              <Menu
                label="More actions"
                trigger={<IconButton label="More actions"><MoreHorizontal className="size-4" /></IconButton>}
                items={[
                  { label: 'Duplicate as new draft', icon: <Copy />, onSelect: () => dup.mutate(undefined) },
                  ...(!draft && !cancelled ? [{ label: 'Edit notes', icon: <Pencil />, onSelect: () => setNotesOpen(true) }] : []),
                  ...(draft ? [{ label: 'Discard draft', icon: <Trash2 />, danger: true, onSelect: doDiscard }] : []),
                  ...(!draft && !cancelled ? [{ label: 'Cancel invoice', icon: <XCircle />, danger: true, disabled: !d.can_cancel, hint: d.cancel_block ?? undefined, onSelect: doCancel }] : []),
                ]}
              />
            )}
          </>
        }
      />

      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_340px]">
        <InvoiceDocument d={d} />
        <aside className="grid min-w-0 grid-cols-1 content-start gap-4 lg:grid-cols-3 2xl:grid-cols-1">
          <Card>
            <CardHeader title="Settlement" />
            <dl className="tnum space-y-1.5 text-[13px]">
              {[
                ['Taxable value (revenue)', inr(d.totals.taxable)],
                ['GST', inr(d.totals.tax)],
                ['Invoice total', inr(d.totals.total)],
                ['Received', inr(d.received_paise)],
                ['TDS deducted', inr(d.tds_paise)],
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3">
                  <dt className="min-w-0 text-ink-3">{k}</dt>
                  <dd className="whitespace-nowrap text-ink">{v}</dd>
                </div>
              ))}
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-1.5">
                <dt className="font-medium text-ink">Balance due</dt>
                <dd className={cn('whitespace-nowrap font-semibold', d.balance_paise ? 'text-ink' : 'text-success-text')}>{inr(d.balance_paise)}</dd>
              </div>
            </dl>
            {d.payments.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-t border-line text-[12.5px]">
                {d.payments.map((p) => (
                  <li key={p.id} className="py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-ink-2">{fmtDate(p.paid_on)}{p.mode ? ` · ${p.mode}` : ''}</span>
                      <span className="tnum whitespace-nowrap font-medium">{inr(p.gross_paise)}</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-ink-3">
                      <span className="min-w-0 truncate">{p.reference || 'No reference'}</span>
                      {p.tds_paise > 0 && <span className="tnum whitespace-nowrap">+ {inr(p.tds_paise)} TDS</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Linked records" />
            <ul className="space-y-2 text-[13px]">
              <li className="flex items-baseline justify-between gap-2">
                <span className="text-ink-3">Project</span>
                <Link to={`/projects/${d.project.id}`} className="min-w-0 truncate text-brand-text hover:underline">{d.project.code} {d.project.name}</Link>
              </li>
              {d.milestones.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate text-ink-3">M{m.no} {m.name}</span>
                  <Badge size="sm" tone={m.billing_status === 'paid' ? 'success' : m.billing_status === 'invoiced' ? 'info' : 'neutral'}>{m.billing_status === 'paid' ? 'Paid' : m.billing_status === 'invoiced' ? 'Invoiced' : 'Not due'}</Badge>
                </li>
              ))}
              {d.ledger.map((l) => (
                <li key={l.id} className="flex items-baseline justify-between gap-2">
                  <Link to="/finance/ledger" className="min-w-0 truncate text-ink-3 hover:underline">Ledger · {l.category} · {fmtDate(l.date)}</Link>
                  <span className="tnum whitespace-nowrap">{inr(l.amount_paise)}</span>
                </li>
              ))}
              {inv.credit_note && (
                <li className="flex items-baseline justify-between gap-2">
                  <span className="text-ink-3">Credit note {inv.credit_note.number}</span>
                  <span className="tnum whitespace-nowrap">{inr(-inv.credit_note.total_paise)}</span>
                </li>
              )}
            </ul>
            <p className="mt-3 text-[12px] text-ink-3">Revenue is the taxable value; GST is held separately and never counts as revenue.</p>
          </Card>
          <Card>
            <CardHeader title="Activity" />
            {d.activity.length ? (
              <ol className="space-y-2 text-[12.5px]">
                {d.activity.map((a, i) => (
                  <li key={i}>
                    <div className="text-ink-2">{a.summary}</div>
                    <div className="text-ink-3">{a.actor} · {fmtDateTime(a.at)}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[12.5px] text-ink-3">No activity yet.</p>
            )}
          </Card>
        </aside>
      </div>

      {d.can_pay && <PaymentDialog d={d} open={paying} onClose={() => setPaying(false)} />}
      {!draft && !cancelled && <EmailDialog d={d} open={emailing} onClose={() => setEmailing(false)} />}
      <NotesDialog d={d} open={notesOpen} onClose={() => setNotesOpen(false)} />
    </div>
  )
}

function NotesDialog({ d, open, onClose }: { d: InvoiceDetail; open: boolean; onClose: () => void }) {
  const [notes, setNotes] = useState('')
  useEffect(() => {
    if (open) setNotes(d.invoice.notes ?? '')
  }, [open, d.invoice.notes])
  const mut = useMut(() => invoicesApi.saveNotes(d.invoice.id, notes, d.invoice.version), { invalidate: INVOICE_INVALIDATE, success: 'Notes saved', onSuccess: onClose })
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Edit notes"
      description="An issued invoice is locked except its notes. To change anything else, cancel it and raise a new one."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mut.isPending} onClick={() => mut.mutate(undefined)}>Save notes</Button>
        </>
      }
    >
      <Field label="Notes">
        <Textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </Dialog>
  )
}
