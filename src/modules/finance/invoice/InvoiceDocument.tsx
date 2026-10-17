// The printable Indian GST tax invoice (screen + print). Layout follows the usual tax-invoice format:
// letterhead with seller GSTIN/PAN/CIN, invoice particulars, bill-to / ship-to, HSN/SAC line table with
// CGST+SGST or IGST columns, totals with round-off, amount in words, tax summary, bank details, terms and
// the authorised-signatory block. All figures come from the server (InvoiceDetail.totals).
import type { InvoiceDetail, InvoiceParty } from '@/api/invoices'
import { SEEREON_LOGO } from '@/assets/brand'
import { useSession } from '@/stores/session'
import { cn } from '@/lib/utils'
import { fmtQty, inr, invDate, pct } from './labels'

export const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 10mm; }
  body * { visibility: hidden !important; }
  #invoice-doc, #invoice-doc * { visibility: visible !important; }
  #invoice-doc { position: absolute; left: 0; top: 0; width: 100%; border: 0 !important; box-shadow: none !important; }
  #invoice-doc .inv-scroll { overflow: visible !important; }
  #invoice-doc table { min-width: 0 !important; }
}`

export function useInvoiceLogo() {
  const tenant = useSession((s) => s.tenant)
  const isSeereon = tenant?.slug === 'seereon' || /seereon/i.test(tenant?.name ?? '')
  return isSeereon ? SEEREON_LOGO : tenant?.logo_data_url ?? null
}

function PartyBlock({ title, p }: { title: string; p: InvoiceParty }) {
  return (
    <div className="min-w-0 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">{title}</div>
      <div className="mt-1 text-[13.5px] font-semibold text-ink">{p.name || '—'}</div>
      <div className="mt-0.5 whitespace-pre-line text-[12.5px] leading-snug text-ink-2">
        {[p.address, [p.city, p.pincode].filter(Boolean).join(' – '), [p.state, p.country && p.country !== 'India' ? p.country : ''].filter(Boolean).join(', ')].filter(Boolean).join('\n')}
      </div>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
        {p.gstin ? (<><dt className="text-ink-3">GSTIN</dt><dd className="tnum min-w-0 break-all font-medium text-ink">{p.gstin}</dd></>) : (<><dt className="text-ink-3">GSTIN</dt><dd className="text-ink-2">{p.country && p.country !== 'India' ? 'Not applicable (overseas)' : 'Unregistered'}</dd></>)}
        {p.state_code && (<><dt className="text-ink-3">State code</dt><dd className="tnum text-ink-2">{p.state_code}</dd></>)}
        {p.pan && (<><dt className="text-ink-3">PAN</dt><dd className="tnum text-ink-2">{p.pan}</dd></>)}
        {p.contact && (<><dt className="text-ink-3">Contact</dt><dd className="min-w-0 break-words text-ink-2">{p.contact}</dd></>)}
        {p.email && (<><dt className="text-ink-3">Email</dt><dd className="min-w-0 break-all text-ink-2">{p.email}</dd></>)}
        {p.phone && (<><dt className="text-ink-3">Phone</dt><dd className="tnum text-ink-2">{p.phone}</dd></>)}
      </dl>
    </div>
  )
}

export function InvoiceDocument({ d, className }: { d: InvoiceDetail; className?: string }) {
  const inv = d.invoice
  const t = d.totals
  const logo = useInvoiceLogo()
  const s = inv.seller!
  const intra = t.tax_mode === 'intra'
  const inter = t.tax_mode === 'inter'
  const lines = inv.lines ?? []
  const draft = d.status === 'draft'
  const cancelled = d.status === 'cancelled'
  const th = 'px-2.5 py-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3'
  const td = 'px-2.5 py-2 align-top'
  return (
    <article id="invoice-doc" className={cn('relative min-w-0 overflow-hidden rounded-lg border border-line bg-surface text-ink', className)}>
      {(draft || cancelled) && (
        <div className={cn('border-b px-4 py-2 text-center text-[12.5px] font-medium', cancelled ? 'border-danger/30 bg-danger-soft text-danger-text' : 'border-line bg-surface-2 text-ink-2')}>
          {cancelled ? `Cancelled on ${invDate(inv.cancelled_on)} by credit note ${inv.credit_note?.number ?? ''} — ${inv.cancel_reason ?? ''}` : 'Draft — not a valid tax invoice until issued. The number is assigned on issue.'}
        </div>
      )}
      {/* letterhead */}
      <header className="flex flex-col gap-4 border-b border-line px-4 py-4 sm:flex-row sm:items-start sm:justify-between md:px-6">
        <div className="flex min-w-0 items-start gap-3">
          {logo && <img src={logo} alt="" className="h-12 w-auto max-w-[120px] shrink-0 object-contain" />}
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-tight text-ink">{s.name}</div>
            <div className="mt-0.5 text-[12px] leading-snug text-ink-2">{[s.address, [s.city, s.pincode].filter(Boolean).join(' – '), s.state].filter(Boolean).join(', ')}</div>
            <div className="tnum mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[12px] text-ink-2">
              <span>GSTIN <span className="font-medium text-ink">{s.gstin || '—'}</span></span>
              {s.pan && <span>PAN {s.pan}</span>}
              {s.cin && <span className="break-all">CIN {s.cin}</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-ink-3">
              {s.email && <span className="break-all">{s.email}</span>}
              {s.phone && <span className="tnum">{s.phone}</span>}
              {s.website && <span>{s.website}</span>}
            </div>
          </div>
        </div>
        <div className="shrink-0 sm:text-right">
          <div className="text-[18px] font-semibold tracking-[0.06em] text-ink">TAX INVOICE</div>
          <div className="text-[11.5px] text-ink-3">Original for recipient</div>
          {t.tax_mode === 'export' && <div className="mt-1 text-[11.5px] text-ink-2">Export of services under LUT</div>}
        </div>
      </header>

      {/* particulars */}
      <div className="grid grid-cols-2 border-b border-line text-[12.5px] md:grid-cols-4">
        {[
          ['Invoice no.', draft ? 'Assigned on issue' : inv.number],
          ['Invoice date', invDate(inv.invoiced_on)],
          ['Due date', invDate(inv.due_on)],
          ['Place of supply', d.place_of_supply_label],
          ['Reverse charge', inv.reverse_charge ? 'Yes' : 'No'],
          ['PO / work order', inv.po_reference || '—'],
          ['PO date', inv.po_date ? invDate(inv.po_date) : '—'],
          ['Project', `${d.project.code} · ${d.project.name}`],
        ].map(([k, v], i) => (
          <div key={k} className={cn('min-w-0 border-line px-4 py-2', i % 2 === 1 && 'border-l', i >= 2 && 'border-t', 'md:border-t-0', i % 4 !== 0 && 'md:border-l', i >= 4 && 'md:border-t')}>
            <div className="text-[11px] text-ink-3">{k}</div>
            <div className="tnum min-w-0 break-words font-medium text-ink">{v}</div>
          </div>
        ))}
      </div>

      {/* parties */}
      <div className={cn('grid border-b border-line', inv.ship_to ? 'sm:grid-cols-2' : 'sm:grid-cols-2')}>
        <PartyBlock title="Bill to" p={inv.bill_to!} />
        <div className="border-t border-line sm:border-l sm:border-t-0">
          {inv.ship_to ? <PartyBlock title="Ship to" p={inv.ship_to} /> : <PartyBlock title="Ship to" p={{ ...inv.bill_to!, contact: '', email: '', phone: '' }} />}
        </div>
      </div>

      {/* lines */}
      <div className="inv-scroll overflow-x-auto">
        <table className="w-full min-w-[700px] border-collapse text-[12.5px]">
          <thead className="border-b border-line bg-surface-2 text-left">
            <tr>
              <th className={cn(th, 'w-8')}>#</th>
              <th className={th}>Item and description</th>
              <th className={th}>HSN/SAC</th>
              <th className={cn(th, 'text-right')}>Qty</th>
              <th className={cn(th, 'text-right')}>Rate</th>
              <th className={cn(th, 'text-right')}>Disc.</th>
              <th className={cn(th, 'text-right')}>Taxable value</th>
              {intra && <th className={cn(th, 'text-right')}>CGST</th>}
              {intra && <th className={cn(th, 'text-right')}>SGST</th>}
              {inter && <th className={cn(th, 'text-right')}>IGST</th>}
              <th className={cn(th, 'text-right')}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const c = t.lines.find((x) => x.id === l.id) ?? t.lines[i]
              return (
                <tr key={l.id} className="border-b border-line">
                  <td className={cn(td, 'tnum text-ink-3')}>{i + 1}</td>
                  <td className={cn(td, 'min-w-[160px]')}>
                    <div className="font-medium text-ink">{l.item}</div>
                    {l.description && <div className="text-[12px] leading-snug text-ink-3">{l.description}</div>}
                  </td>
                  <td className={cn(td, 'tnum text-ink-2')}>{l.hsn_sac}</td>
                  <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{fmtQty(l.qty)} {l.unit}</td>
                  <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{inr(l.rate_paise)}</td>
                  <td className={cn(td, 'tnum whitespace-nowrap text-right text-ink-2')}>{l.discount_pct ? <>{pct(l.discount_pct)}<div className="text-[11.5px] text-ink-3">{inr(c?.discount)}</div></> : '—'}</td>
                  <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{inr(c?.taxable)}</td>
                  {intra && <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{inr(c?.cgst)}<div className="text-[11.5px] text-ink-3">{pct((c?.rate ?? 0) / 2)}</div></td>}
                  {intra && <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{inr(c?.sgst)}<div className="text-[11.5px] text-ink-3">{pct((c?.rate ?? 0) / 2)}</div></td>}
                  {inter && <td className={cn(td, 'tnum whitespace-nowrap text-right')}>{inr(c?.igst)}<div className="text-[11.5px] text-ink-3">{pct(c?.rate ?? 0)}</div></td>}
                  <td className={cn(td, 'tnum whitespace-nowrap text-right font-medium')}>{inr(c?.total)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* words + totals */}
      <div className="grid border-b border-line md:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-3 px-4 py-3 md:px-6">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Amount in words</div>
            <div className="mt-0.5 text-[13px] font-medium text-ink">{t.words}</div>
          </div>
          {t.tax_mode !== 'export' && t.by_rate.some((r) => r.rate > 0) && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[300px] text-[12px]">
                <thead className="text-left text-ink-3">
                  <tr className="border-b border-line">
                    <th className="py-1 pr-2 font-medium">GST rate</th>
                    <th className="py-1 pr-2 text-right font-medium">Taxable</th>
                    {intra ? <><th className="py-1 pr-2 text-right font-medium">CGST</th><th className="py-1 text-right font-medium">SGST</th></> : <th className="py-1 text-right font-medium">IGST</th>}
                  </tr>
                </thead>
                <tbody>
                  {t.by_rate.map((r) => (
                    <tr key={r.rate} className="border-b border-line/70">
                      <td className="tnum py-1 pr-2">{pct(r.rate)}</td>
                      <td className="tnum py-1 pr-2 text-right">{inr(r.taxable)}</td>
                      {intra ? <><td className="tnum py-1 pr-2 text-right">{inr(r.cgst)}</td><td className="tnum py-1 text-right">{inr(r.sgst)}</td></> : <td className="tnum py-1 text-right">{inr(r.igst)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {t.reverse_charge && <p className="text-[12px] text-ink-2">Tax payable on reverse charge: Yes. GST of {inr(t.tax)} is payable by the recipient and is not included in the total.</p>}
          {t.tax_mode === 'export' && <p className="text-[12px] text-ink-2">Supply meant for export of services under Letter of Undertaking without payment of integrated tax.</p>}
          {!!inv.tds_pct && <p className="text-[12px] text-ink-3">TDS expected at {pct(inv.tds_pct)} on the taxable value ({inr(Math.round(((inv.tds_pct ?? 0) / 100) * t.taxable))}) — please share Form 16A.</p>}
        </div>
        <dl className="tnum border-t border-line px-4 py-3 text-[13px] md:border-l md:border-t-0 md:px-5">
          {[
            ['Subtotal', t.subtotal],
            ...(t.discount ? [['Discount', -t.discount]] : []),
            ['Taxable value', t.taxable],
            ...(intra ? [['CGST', t.cgst], ['SGST', t.sgst]] : []),
            ...(inter ? [['IGST', t.igst]] : []),
            ...(t.round_off ? [['Round off', t.round_off]] : []),
          ].map(([k, v]) => (
            <div key={k as string} className="flex items-baseline justify-between gap-3 py-0.5">
              <dt className="text-ink-2">{k}</dt>
              <dd className="whitespace-nowrap">{inr(v as number)}</dd>
            </div>
          ))}
          <div className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-line pt-2">
            <dt className="font-semibold text-ink">Grand total</dt>
            <dd className="whitespace-nowrap text-[15px] font-semibold text-ink">{inr(t.total)}</dd>
          </div>
          {!draft && !cancelled && d.settled_paise > 0 && (
            <>
              <div className="flex items-baseline justify-between gap-3 py-0.5 text-ink-2"><dt>Received{d.tds_paise ? ' + TDS' : ''}</dt><dd className="whitespace-nowrap">{inr(-d.settled_paise)}</dd></div>
              <div className="flex items-baseline justify-between gap-3 py-0.5 font-medium"><dt>Balance due</dt><dd className="whitespace-nowrap">{inr(d.balance_paise)}</dd></div>
            </>
          )}
        </dl>
      </div>

      {/* bank, terms, signature */}
      <div className="grid md:grid-cols-[1fr_1fr_260px]">
        <div className="min-w-0 px-4 py-3 md:px-6">
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Bank details</div>
          {inv.bank ? (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
              <dt className="text-ink-3">Bank</dt><dd className="min-w-0 text-ink">{inv.bank.bank_name}</dd>
              <dt className="text-ink-3">A/c name</dt><dd className="min-w-0 break-words text-ink">{inv.bank.account_name}</dd>
              <dt className="text-ink-3">A/c no.</dt><dd className="tnum min-w-0 break-all text-ink">{inv.bank.account_number}</dd>
              <dt className="text-ink-3">IFSC</dt><dd className="tnum text-ink">{inv.bank.ifsc}</dd>
              {inv.bank.branch && (<><dt className="text-ink-3">Branch</dt><dd className="min-w-0 text-ink">{inv.bank.branch}</dd></>)}
              {inv.bank.upi && (<><dt className="text-ink-3">UPI</dt><dd className="min-w-0 break-all text-ink">{inv.bank.upi}</dd></>)}
            </dl>
          ) : (
            <p className="mt-1 text-[12px] text-ink-3">—</p>
          )}
        </div>
        <div className="min-w-0 border-t border-line px-4 py-3 md:border-l md:border-t-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Terms and conditions</div>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[12px] leading-snug text-ink-2">
            {(inv.terms ?? '').split('\n').filter((x) => x.trim()).map((x, i) => <li key={i}>{x}</li>)}
          </ol>
          {inv.notes && (
            <>
              <div className="mt-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Notes</div>
              <p className="mt-0.5 whitespace-pre-line text-[12px] text-ink-2">{inv.notes}</p>
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-between border-t border-line px-4 py-3 md:border-l md:border-t-0">
          <div className="text-[12px] text-ink-2">For <span className="font-medium text-ink">{s.name}</span></div>
          <div className="mt-10">
            <div className="border-t border-line pt-1 text-[12.5px] font-medium text-ink">{inv.signatory?.name || '—'}</div>
            <div className="text-[12px] text-ink-3">{inv.signatory?.title || 'Authorised signatory'}</div>
          </div>
        </div>
      </div>
      <footer className="border-t border-line px-4 py-2 text-center text-[11.5px] text-ink-3">This is a computer generated invoice.</footer>
    </article>
  )
}
