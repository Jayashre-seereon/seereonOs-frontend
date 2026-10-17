// A4 tax-invoice PDF (jsPDF + autotable) laid out like the on-screen InvoiceDocument: letterhead with logo,
// TAX INVOICE title, particulars grid, bill-to / ship-to, HSN/SAC line table with CGST+SGST or IGST columns,
// totals with round-off, amount in words, GST summary, bank details, terms, signature and the
// "computer generated" footer. Embeds Carlito so ₹ and Indian grouping render offline.
import type { InvoiceDetail, InvoiceParty } from '@/api/invoices'
import { saveFile } from '@/lib/utils'
import { fileNameOf, fmtQty, inr, invDate, pct } from './labels'

type RGB = [number, number, number]
const INK: RGB = [17, 24, 39]
const MUTED: RGB = [107, 114, 128]
const RULE: RGB = [209, 213, 219]
const FILL: RGB = [243, 244, 246]

async function toPng(src: string): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.crossOrigin = 'anonymous'
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('image'))
      i.src = src
    })
    const w0 = img.naturalWidth || 200
    const h0 = img.naturalHeight || 200
    const k = Math.min(1, 600 / w0)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w0 * k))
    c.height = Math.max(1, Math.round(h0 * k))
    const g = c.getContext('2d')
    if (!g) return null
    g.drawImage(img, 0, 0, c.width, c.height)
    return { data: c.toDataURL('image/png'), w: c.width, h: c.height }
  } catch {
    return null
  }
}

export async function invoicePdfBlob(d: InvoiceDetail, logoSrc: string | null): Promise<Blob> {
  const [{ jsPDF }, autoTableMod, fontMod] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('@/reports/pdfFont')])
  const autoTable = (autoTableMod as unknown as { default: (doc: unknown, o: unknown) => void }).default
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
  let font = 'helvetica'
  try {
    doc.addFileToVFS('Carlito-Regular.ttf', fontMod.CARLITO_REGULAR)
    doc.addFont('Carlito-Regular.ttf', 'Carlito', 'normal')
    doc.addFileToVFS('Carlito-Bold.ttf', fontMod.CARLITO_BOLD)
    doc.addFont('Carlito-Bold.ttf', 'Carlito', 'bold')
    font = 'Carlito'
  } catch {
    font = 'helvetica'
  }
  const tx = (s: string) => (font === 'Carlito' ? s : s.replace(/₹/g, 'Rs. ').replace(/[–—]/g, '-').replace(/·/g, '-').replace(/’/g, "'"))
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 12
  const CW = W - 2 * M
  const set = (size: number, color: RGB = INK, weight: 'normal' | 'bold' = 'normal') => {
    doc.setFont(font, weight)
    doc.setFontSize(size)
    doc.setTextColor(...color)
  }
  const box = (x: number, y: number, w: number, h: number) => {
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.25)
    doc.rect(x, y, w, h, 'S')
  }
  const inv = d.invoice
  const t = d.totals
  const s = inv.seller!
  const intra = t.tax_mode === 'intra'
  const inter = t.tax_mode === 'inter'

  /* ---- letterhead ---- */
  let y = M
  let textX = M
  const logo = logoSrc ? await toPng(logoSrc) : null
  if (logo) {
    const lh = 16
    const lw = Math.min(34, (logo.w / logo.h) * lh)
    const h = (logo.h / logo.w) * lw
    try {
      doc.addImage(logo.data, 'PNG', M, y, lw, h, undefined, 'FAST')
      textX = M + lw + 4
    } catch {
      /* logo optional */
    }
  }
  set(13, INK, 'bold')
  doc.text(tx(s.name), textX, y + 5)
  set(8.5, MUTED)
  const addr = doc.splitTextToSize(tx([s.address, [s.city, s.pincode].filter(Boolean).join(' - '), s.state].filter(Boolean).join(', ')), 110) as string[]
  doc.text(addr, textX, y + 9.5)
  let ly = y + 9.5 + addr.length * 3.6
  set(8.5, INK)
  doc.text(tx(`GSTIN ${s.gstin || '-'}${s.pan ? `   PAN ${s.pan}` : ''}${s.cin ? `   CIN ${s.cin}` : ''}`), textX, ly)
  ly += 3.8
  set(8.5, MUTED)
  doc.text(tx([s.email, s.phone, s.website].filter(Boolean).join('   ')), textX, ly)
  set(15, INK, 'bold')
  doc.text('TAX INVOICE', W - M, y + 5, { align: 'right' })
  set(8, MUTED)
  doc.text('Original for recipient', W - M, y + 9.5, { align: 'right' })
  if (t.tax_mode === 'export') doc.text('Export of services under LUT', W - M, y + 13.5, { align: 'right' })
  if (d.status === 'draft' || d.status === 'cancelled') {
    set(9, [185, 28, 28], 'bold')
    doc.text(d.status === 'draft' ? 'DRAFT — NOT A VALID TAX INVOICE' : `CANCELLED (${inv.credit_note?.number ?? ''})`, W - M, y + 18, { align: 'right' })
  }
  y = Math.max(ly + 4, y + (logo ? 20 : 16))

  /* ---- particulars (4 × 2 grid) ---- */
  const parts: [string, string][] = [
    ['Invoice no.', d.status === 'draft' ? 'Assigned on issue' : inv.number], ['Invoice date', invDate(inv.invoiced_on)], ['Due date', invDate(inv.due_on)], ['Place of supply', d.place_of_supply_label],
    ['Reverse charge', inv.reverse_charge ? 'Yes' : 'No'], ['PO / work order', inv.po_reference || '-'], ['PO date', inv.po_date ? invDate(inv.po_date) : '-'], ['Project', `${d.project.code} - ${d.project.name}`],
  ]
  const cw = CW / 4
  const ph = 10
  parts.forEach(([k, v], i) => {
    const cx = M + (i % 4) * cw
    const cy = y + Math.floor(i / 4) * ph
    box(cx, cy, cw, ph)
    set(7, MUTED)
    doc.text(tx(k), cx + 2, cy + 3.6)
    set(8.5, INK, 'bold')
    doc.text((doc.splitTextToSize(tx(v), cw - 4) as string[])[0], cx + 2, cy + 7.8)
  })
  y += ph * 2

  /* ---- parties ---- */
  const partyLines = (p: InvoiceParty, withContact: boolean) =>
    [
      p.address, [p.city, p.pincode].filter(Boolean).join(' - '), [p.state, p.country && p.country !== 'India' ? p.country : ''].filter(Boolean).join(', '),
      `GSTIN: ${p.gstin || (p.country && p.country !== 'India' ? 'Not applicable (overseas)' : 'Unregistered')}${p.state_code ? `   State code: ${p.state_code}` : ''}`,
      p.pan ? `PAN: ${p.pan}` : '', withContact && p.contact ? `Contact: ${p.contact}` : '', withContact && (p.email || p.phone) ? [p.email, p.phone].filter(Boolean).join('   ') : '',
    ].filter(Boolean)
  const half = CW / 2
  const drawParty = (title: string, p: InvoiceParty, x: number, withContact: boolean) => {
    set(7, MUTED, 'bold')
    doc.text(title.toUpperCase(), x + 2.5, y + 4)
    set(9.5, INK, 'bold')
    doc.text((doc.splitTextToSize(tx(p.name), half - 5) as string[])[0], x + 2.5, y + 8.5)
    set(8, INK)
    let yy = y + 12.5
    for (const line of partyLines(p, withContact)) {
      const ls = doc.splitTextToSize(tx(line), half - 5) as string[]
      doc.text(ls, x + 2.5, yy)
      yy += ls.length * 3.5
    }
    return yy - y
  }
  const hb = drawParty('Bill to', inv.bill_to!, M, true)
  const hs = drawParty('Ship to', inv.ship_to ?? inv.bill_to!, M + half, !!inv.ship_to)
  const partyH = Math.max(hb, hs) + 1.5
  box(M, y, half, partyH)
  box(M + half, y, half, partyH)
  y += partyH + 3

  /* ---- line table ---- */
  const head = ['#', 'Item and description', 'HSN/SAC', 'Qty', 'Rate', 'Disc.', 'Taxable', ...(intra ? ['CGST', 'SGST'] : inter ? ['IGST'] : []), 'Amount']
  const body = (inv.lines ?? []).map((l, i) => {
    const c = t.lines.find((x) => x.id === l.id) ?? t.lines[i]
    return [
      String(i + 1), tx(l.description ? `${l.item}\n${l.description}` : l.item), l.hsn_sac, tx(`${fmtQty(l.qty)} ${l.unit}`), tx(inr(l.rate_paise)), l.discount_pct ? tx(`${pct(l.discount_pct)}\n${inr(c?.discount)}`) : '-', tx(inr(c?.taxable)),
      ...(intra ? [tx(`${inr(c?.cgst)}\n@ ${pct((c?.rate ?? 0) / 2)}`), tx(`${inr(c?.sgst)}\n@ ${pct((c?.rate ?? 0) / 2)}`)] : inter ? [tx(`${inr(c?.igst)}\n@ ${pct(c?.rate ?? 0)}`)] : []),
      tx(inr(c?.total)),
    ]
  })
  const nCols = head.length
  const right: Record<number, { halign: 'right' }> = {}
  for (let i = 3; i < nCols; i++) if (i !== 2) right[i] = { halign: 'right' }
  autoTable(doc, {
    startY: y,
    head: [head],
    body,
    margin: { left: M, right: M },
    theme: 'grid',
    styles: { font, fontSize: 7.8, cellPadding: 1.6, textColor: INK, lineColor: RULE, lineWidth: 0.2, valign: 'top' },
    headStyles: { fillColor: FILL, textColor: MUTED, fontStyle: 'bold', fontSize: 7.2 },
    columnStyles: { 0: { cellWidth: 6 }, 1: { cellWidth: intra ? 48 : inter ? 60 : 72 }, 2: { cellWidth: 14 }, ...right },
  })
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 3

  /* ---- words + totals ---- */
  const totals: [string, number][] = [
    ['Subtotal', t.subtotal], ...(t.discount ? ([['Discount', -t.discount]] as [string, number][]) : []), ['Taxable value', t.taxable],
    ...(intra ? ([['CGST', t.cgst], ['SGST', t.sgst]] as [string, number][]) : []), ...(inter ? ([['IGST', t.igst]] as [string, number][]) : []), ...(t.round_off ? ([['Round off', t.round_off]] as [string, number][]) : []),
  ]
  const tw = 70
  const th = totals.length * 4.6 + 9
  if (y + th + 60 > H - 14) {
    doc.addPage()
    y = M
  }
  box(W - M - tw, y, tw, th)
  let ty = y + 4.5
  for (const [k, v] of totals) {
    set(8.5, MUTED)
    doc.text(k, W - M - tw + 2.5, ty)
    set(8.5, INK)
    doc.text(tx(inr(v)), W - M - 2.5, ty, { align: 'right' })
    ty += 4.6
  }
  doc.setDrawColor(...RULE)
  doc.line(W - M - tw, ty - 2.6, W - M, ty - 2.6)
  set(10, INK, 'bold')
  doc.text('Grand total', W - M - tw + 2.5, ty + 1.8)
  doc.text(tx(inr(t.total)), W - M - 2.5, ty + 1.8, { align: 'right' })
  // left: words, tax summary, notes on export / reverse charge / TDS
  const lw = CW - tw - 4
  set(7, MUTED, 'bold')
  doc.text('AMOUNT IN WORDS', M, y + 3.5)
  set(9, INK, 'bold')
  const words = doc.splitTextToSize(tx(t.words), lw) as string[]
  doc.text(words, M, y + 7.8)
  let wy = y + 7.8 + words.length * 4
  set(8, MUTED)
  const extra: string[] = []
  if (t.tax_mode !== 'export' && t.by_rate.some((r) => r.rate > 0))
    for (const r of t.by_rate) extra.push(`GST ${pct(r.rate)} on ${inr(r.taxable)}: ${intra ? `CGST ${inr(r.cgst)} + SGST ${inr(r.sgst)}` : `IGST ${inr(r.igst)}`}`)
  if (t.reverse_charge) extra.push(`Tax payable on reverse charge: Yes (GST ${inr(t.tax)} payable by the recipient).`)
  if (t.tax_mode === 'export') extra.push('Supply meant for export of services under LUT without payment of integrated tax.')
  if (inv.tds_pct) extra.push(`TDS expected at ${pct(inv.tds_pct)} on the taxable value (${inr(Math.round((inv.tds_pct / 100) * t.taxable))}). Please share Form 16A.`)
  if (d.status !== 'draft' && d.status !== 'cancelled' && d.settled_paise > 0) extra.push(`Received${d.tds_paise ? ' + TDS' : ''}: ${inr(d.settled_paise)}   Balance due: ${inr(d.balance_paise)}`)
  for (const e of extra) {
    const ls = doc.splitTextToSize(tx(e), lw) as string[]
    doc.text(ls, M, wy + 1)
    wy += ls.length * 3.6
  }
  y = Math.max(y + th, wy) + 4

  /* ---- bank | terms | signature ---- */
  const colW = [62, CW - 62 - 56, 56]
  const bank = inv.bank
  const bankLines = bank ? [`Bank: ${bank.bank_name}`, `A/c name: ${bank.account_name}`, `A/c no.: ${bank.account_number}`, `IFSC: ${bank.ifsc}`, bank.branch ? `Branch: ${bank.branch}` : '', bank.upi ? `UPI: ${bank.upi}` : ''].filter(Boolean) : ['-']
  const termLines = (inv.terms ?? '').split('\n').filter((x) => x.trim()).map((x, i) => `${i + 1}. ${x}`)
  set(7.6, INK)
  const wrappedBank = bankLines.flatMap((l) => doc.splitTextToSize(tx(l), colW[0] - 5) as string[])
  const wrappedTerms = [...termLines, ...(inv.notes ? ['', `Notes: ${inv.notes}`] : [])].flatMap((l) => (l ? (doc.splitTextToSize(tx(l), colW[1] - 5) as string[]) : ['']))
  const bh = Math.max(wrappedBank.length, wrappedTerms.length) * 3.4 + 9
  const blockH = Math.max(bh, 32)
  if (y + blockH + 10 > H - 10) {
    doc.addPage()
    y = M
  }
  box(M, y, colW[0], blockH)
  box(M + colW[0], y, colW[1], blockH)
  box(M + colW[0] + colW[1], y, colW[2], blockH)
  set(7, MUTED, 'bold')
  doc.text('BANK DETAILS', M + 2.5, y + 4)
  doc.text('TERMS AND CONDITIONS', M + colW[0] + 2.5, y + 4)
  set(7.6, INK)
  doc.text(wrappedBank, M + 2.5, y + 8)
  doc.text(wrappedTerms, M + colW[0] + 2.5, y + 8)
  const sx = M + colW[0] + colW[1] + 2.5
  set(8, MUTED)
  doc.text(doc.splitTextToSize(tx(`For ${s.name}`), colW[2] - 5) as string[], sx, y + 4.5)
  set(8.5, INK, 'bold')
  doc.text(tx(inv.signatory?.name || ''), sx, y + blockH - 6)
  set(7.6, MUTED)
  doc.text(tx(inv.signatory?.title || 'Authorised signatory'), sx, y + blockH - 2.5)
  doc.setDrawColor(...RULE)
  doc.line(sx, y + blockH - 9.5, sx + colW[2] - 5, y + blockH - 9.5)
  y += blockH + 5
  set(7.5, MUTED)
  doc.text('This is a computer generated invoice.', W / 2, Math.min(y, H - 8), { align: 'center' })
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    set(7, MUTED)
    doc.text(tx(`${d.status === 'draft' ? 'Draft' : inv.number}  ·  Page ${i} of ${pages}`), W - M, H - 5, { align: 'right' })
  }
  return doc.output('blob')
}

export async function downloadInvoicePdf(d: InvoiceDetail, logoSrc: string | null) {
  const blob = await invoicePdfBlob(d, logoSrc)
  return saveFile(d.status === 'draft' ? `draft-invoice-${d.invoice.draft_no ?? ''}.pdf` : fileNameOf(d.invoice.number), blob, 'application/pdf')
}
