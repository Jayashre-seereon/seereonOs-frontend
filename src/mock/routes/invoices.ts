// v7 GST tax invoices (owner: invoices workstream).
// One invoice table serves the Feature Guide milestone billing (§4 billing states, §13 ledger income) and the
// full Indian GST tax invoice: seller / bill-to / ship-to parties, place of supply, HSN/SAC lines, CGST+SGST
// (intra-state) or IGST (inter-state) or zero-rated export under LUT, round-off, amount in words, bank details.
//
// Money rules (documented in CONVENTIONS v7 by this workstream):
//   • Revenue = taxable value. `invoice.amount_paise` holds the taxable value of an ISSUED invoice (0 while draft or
//     after cancellation), and the ledger income row is booked at the taxable value. GST is a liability collected for
//     the government: it lives only in the invoice fields (cgst/sgst/igst/total) and never reaches billed revenue,
//     the P&L, the CEO revenue tiles or a project's Actual margin.
//   • Payments: the client settles the GST-inclusive total; cash received + TDS deducted both count as settled.
//     Each payment row stores `gross_paise` (cash) and `tds_paise`, and `amount_paise` = the revenue share of that
//     settlement (settled × taxable ÷ total), so `paid_amount_paise` reaches `amount_paise` exactly when the invoice is
//     paid in full. Collected figures (P&L, CEO dashboard, project Collected) therefore stay on the ex-GST basis.
//   • Issuing a milestone invoice marks the milestone Invoiced; settling it in full marks it Paid (G4.05).
//     Cancelling (no payments yet) returns the milestone to Not due, keeps the number (GST numbers are never reused)
//     and books a credit note: a negative income row on the cancellation date.
import type * as E from '@/types/entities'
import type { InvoiceLine, InvoiceParty, InvoiceSettings } from '@/types/v7'
import { err, find, getDb, has, hasAny, insert, logActivity, nowISO, persist, remove, requireAction, rows, update, userName, warn, type Ctx, type Router } from '../server'
import { costedEntries, currentRatePH, milestoneState } from '../analytics'
import { addDays, diffDays, fyLabel, fyRange, fyStartYear, isRealISODate } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { GSTIN_RE, PAN_RE } from '@/modules/spend/labels'
import { GST_STATES } from '@/domain/gst'

/* ------------------------------------------------------------------ */
/* Reference data                                                      */
/* ------------------------------------------------------------------ */
export { GST_STATES }
const STATE_BY_CODE = new Map(GST_STATES.map((s) => [s.code, s.name]))
export const EXPORT_CODE = '96'
export function stateCodeOf(name: string | null | undefined): string {
  const n = (name ?? '').trim().toLowerCase()
  if (!n) return ''
  const hit = GST_STATES.find((s) => s.name.toLowerCase() === n || (n === 'orissa' && s.code === '21'))
  return hit?.code ?? ''
}
export const stateName = (code: string | null | undefined) => (code ? STATE_BY_CODE.get(code) ?? '' : '')
export const GST_RATES = [0, 5, 12, 18, 28]
export const UNITS = ['Nos', 'Hrs', 'Days', 'Months', 'Lot', 'Licence', 'Users', 'Visits']
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const SAC_RE = /^\d{4,8}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const DATE_RE = { test: (s: string) => isRealISODate(s) }
const isIndia = (c: string | null | undefined) => !c || /^(india|in|bharat)$/i.test(c.trim())

/* ------------------------------------------------------------------ */
/* Settings, seller and client parties                                 */
/* ------------------------------------------------------------------ */
function initials(name: string) {
  const w = name.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean)
  return ((w[0]?.[0] ?? 'I') + (w[1]?.[0] ?? '') + (w[2]?.[0] ?? '')).toUpperCase()
}
export function defaultInvoiceSettings(t: E.Tenant): InvoiceSettings {
  const o = t.org
  return {
    prefix: o?.employee_code_prefix || initials(o?.legal_name || t.name),
    credit_note_prefix: 'CN',
    payment_terms_days: 30,
    default_sac: '998314',
    default_gst_rate: 18,
    default_tds_pct: 10,
    default_unit: 'Nos',
    bank: { bank_name: o?.bank_name ?? '', account_name: o?.legal_name || t.name, account_number: '', ifsc: o?.ifsc ?? '', branch: '', upi: '' },
    signatory_name: '',
    signatory_title: 'Authorised signatory',
    lut_number: '',
    default_notes: 'Thank you for your business.',
    default_terms: [
      'Payment is due within the credit period shown above, by bank transfer to the account below.',
      'Please quote the invoice number with your payment and email the TDS certificate (Form 16A) every quarter.',
      'Interest at 18% a year may be charged on payments received after the due date.',
      'Subject to Bhubaneswar jurisdiction.',
    ].join('\n'),
    updated_at: null,
    updated_by: null,
  }
}
function tenantRow(ctx: Ctx): E.Tenant {
  return getDb().tenants.find((t) => t.id === ctx.tenant.id) ?? ctx.tenant
}
export function invoiceSettings(ctx: Ctx): InvoiceSettings {
  const t = tenantRow(ctx)
  const d = defaultInvoiceSettings(t)
  const s = t.invoicing
  return s ? { ...d, ...s, bank: { ...d.bank, ...s.bank } } : d
}
const mask = (acct: string) => (acct ? acct.replace(/\d(?=\d{4})/g, 'X') : '')
/** Settings as the viewer may see them: the full account number only with finance.edit. */
export function settingsFor(ctx: Ctx): InvoiceSettings & { account_masked: string; can_edit: boolean } {
  const s = invoiceSettings(ctx)
  const full = has(ctx, 'finance.edit')
  const org = tenantRow(ctx).org
  const masked = s.bank.account_number ? mask(s.bank.account_number) : org?.bank_account_masked ?? ''
  return { ...s, bank: { ...s.bank, account_number: full ? s.bank.account_number : masked }, account_masked: masked, can_edit: full }
}

export function sellerParty(ctx: Ctx): InvoiceParty {
  const t = tenantRow(ctx)
  const o = t.org
  const code = (o?.gstin && /^\d{2}/.test(o.gstin) ? o.gstin.slice(0, 2) : '') || stateCodeOf(o?.state)
  return {
    name: o?.legal_name || t.name, address: o?.registered_address || o?.corporate_address || '', city: o?.city ?? '', state: o?.state || stateName(code), state_code: code,
    pincode: o?.pincode ?? '', country: o?.country || 'India', gstin: o?.gstin ?? '', pan: o?.pan ?? '', email: o?.email ?? '', phone: o?.phone ?? '', contact: '',
    cin: o?.cin ?? '', website: o?.website ?? '',
  }
}

/** Client master rows carry optional GST address fields (owned by the clients route). */
export type ClientGst = E.Base & { name: string; country: string; gstin: string; billing_address: string; primary_contact: string; email: string; phone: string; payment_terms_days: number; state?: string; state_code?: string; city?: string; pincode?: string; pan?: string }
const lc = (s: string) => s.trim().toLowerCase()
export function clientForProject(ctx: Ctx, p: E.Project): ClientGst | null {
  return (rows(ctx, 'clients') as unknown as ClientGst[]).find((c) => lc(c.name) === lc(p.client)) ?? null
}
export function clientParty(c: ClientGst | null, fallbackName = ''): InvoiceParty {
  if (!c) return { name: fallbackName, address: '', city: '', state: '', state_code: '', pincode: '', country: 'India', gstin: '', pan: '', email: '', phone: '', contact: '' }
  const india = isIndia(c.country)
  const code = india ? c.state_code || (c.gstin && /^\d{2}/.test(c.gstin) ? c.gstin.slice(0, 2) : '') || stateCodeOf(c.state) : EXPORT_CODE
  return {
    name: c.name, address: c.billing_address ?? '', city: c.city ?? '', state: india ? c.state || stateName(code) : c.state || c.country, state_code: code, pincode: c.pincode ?? '',
    country: c.country || 'India', gstin: c.gstin ?? '', pan: c.pan || (c.gstin && c.gstin.length === 15 ? c.gstin.slice(2, 12) : ''), email: c.email ?? '', phone: c.phone ?? '', contact: c.primary_contact ?? '',
  }
}

/* ------------------------------------------------------------------ */
/* Calculation                                                         */
/* ------------------------------------------------------------------ */
export type TaxMode = 'intra' | 'inter' | 'export'
export function taxModeOf(sellerCode: string, placeOfSupply: string, buyerCountry?: string): TaxMode {
  if (placeOfSupply === EXPORT_CODE || (buyerCountry && !isIndia(buyerCountry))) return 'export'
  return sellerCode && placeOfSupply && sellerCode === placeOfSupply ? 'intra' : 'inter'
}
export interface LineCalc { id: string; gross: number; discount: number; taxable: number; rate: number; cgst: number; sgst: number; igst: number; total: number }
export interface InvoiceTotals {
  tax_mode: TaxMode
  lines: LineCalc[]
  subtotal: number
  discount: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  tax: number
  before_round: number
  round_off: number
  total: number
  reverse_charge: boolean
  by_rate: { rate: number; taxable: number; cgst: number; sgst: number; igst: number }[]
  words: string
}
export function computeTotals(lines: InvoiceLine[], mode: TaxMode, reverseCharge = false): InvoiceTotals {
  const calc: LineCalc[] = lines.map((l) => {
    const gross = Math.round((Number(l.qty) || 0) * (Number(l.rate_paise) || 0))
    const discount = Math.round((gross * Math.min(100, Math.max(0, Number(l.discount_pct) || 0))) / 100)
    const taxable = gross - discount
    const rate = mode === 'export' ? 0 : Number(l.gst_rate) || 0
    const cgst = mode === 'intra' ? Math.round((taxable * rate) / 200) : 0
    const sgst = cgst
    const igst = mode === 'inter' ? Math.round((taxable * rate) / 100) : 0
    return { id: l.id, gross, discount, taxable, rate, cgst, sgst, igst, total: taxable + cgst + sgst + igst }
  })
  const sum = (k: keyof LineCalc) => calc.reduce((s, c) => s + (c[k] as number), 0)
  const taxable = sum('taxable')
  const cgst = sum('cgst'), sgst = sum('sgst'), igst = sum('igst')
  const tax = cgst + sgst + igst
  const before = taxable + (reverseCharge ? 0 : tax)
  const total = Math.round(before / 100) * 100
  const rates = new Map<number, { rate: number; taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const c of calc) {
    const r = rates.get(c.rate) ?? { rate: c.rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    r.taxable += c.taxable
    r.cgst += c.cgst
    r.sgst += c.sgst
    r.igst += c.igst
    rates.set(c.rate, r)
  }
  return {
    tax_mode: mode, lines: calc, subtotal: sum('gross'), discount: sum('discount'), taxable, cgst, sgst, igst, tax, before_round: before, round_off: total - before, total, reverse_charge: reverseCharge,
    by_rate: [...rates.values()].sort((a, b) => a.rate - b.rate), words: amountInWords(total),
  }
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
const two = (n: number) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''))
const three = (n: number) => [n >= 100 ? `${ONES[Math.floor(n / 100)]} Hundred` : '', n % 100 ? two(n % 100) : ''].filter(Boolean).join(' ')
/** Indian numbering: 1,23,45,678 → One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight. */
export function indianWords(n: number): string {
  n = Math.floor(Math.abs(n))
  if (n === 0) return 'Zero'
  const crore = Math.floor(n / 1e7)
  const lakh = Math.floor(n / 1e5) % 100
  const thousand = Math.floor(n / 1e3) % 100
  const rest = n % 1000
  return [crore ? `${indianWords(crore)} Crore` : '', lakh ? `${two(lakh)} Lakh` : '', thousand ? `${two(thousand)} Thousand` : '', rest ? three(rest) : ''].filter(Boolean).join(' ')
}
/** "Indian Rupees One Lakh Eighteen Thousand and Fifty Paise Only" */
export function amountInWords(paise: number): string {
  const a = Math.abs(Math.round(paise))
  const r = Math.floor(a / 100)
  const p = a % 100
  return `${paise < 0 ? 'Minus ' : ''}Indian Rupees ${indianWords(r)}${p ? ` and ${two(p)} Paise` : ''} Only`
}

/* ------------------------------------------------------------------ */
/* Numbering: <prefix>/<yy-yy>/<0001> per financial year               */
/* ------------------------------------------------------------------ */
function fyCode(ctx: Ctx, date: string) {
  const y = fyStartYear(date, ctx.tenant.settings['company.fy_start_month'] ?? 4)
  return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function nextInSeries(taken: string[], prefix: string, fy: string) {
  const re = new RegExp(`^${esc(prefix)}/${esc(fy)}/(\\d+)$`, 'i')
  const max = taken.reduce((m, n) => {
    const x = re.exec(n)
    return x ? Math.max(m, Number(x[1])) : m
  }, 0)
  return `${prefix}/${fy}/${String(max + 1).padStart(4, '0')}`
}
export function nextInvoiceNumber(ctx: Ctx, date: string): string {
  return nextInSeries(rows(ctx, 'invoices').map((i) => i.number), invoiceSettings(ctx).prefix, fyCode(ctx, date))
}
function nextCreditNoteNumber(ctx: Ctx, date: string): string {
  const taken = rows(ctx, 'invoices').map((i) => i.credit_note?.number ?? '').filter(Boolean)
  return nextInSeries(taken, invoiceSettings(ctx).credit_note_prefix || 'CN', fyCode(ctx, date))
}
function nextDraftNo(ctx: Ctx) {
  return rows(ctx, 'invoices').reduce((m, i) => Math.max(m, i.draft_no ?? 0), 0) + 1
}

/* ------------------------------------------------------------------ */
/* Status and legacy upgrade                                           */
/* ------------------------------------------------------------------ */
export type InvoiceDisplayStatus = 'draft' | 'issued' | 'partially_paid' | 'paid' | 'overdue' | 'cancelled'
const rawStatus = (i: E.Invoice): NonNullable<E.Invoice['status']> => i.status ?? (i.paid_amount_paise >= i.amount_paise && i.amount_paise > 0 ? 'paid' : i.paid_amount_paise > 0 ? 'partially_paid' : 'issued')
export const isLive = (i: E.Invoice) => i.status !== 'draft' && i.status !== 'cancelled'
export function settledOf(i: E.Invoice) {
  return (i.received_paise ?? 0) + (i.tds_received_paise ?? 0)
}
export function balanceOf(i: E.Invoice) {
  return isLive(i) ? Math.max(0, (i.total_paise ?? i.amount_paise) - settledOf(i)) : 0
}
export function displayStatus(ctx: Ctx, i: E.Invoice): InvoiceDisplayStatus {
  const s = rawStatus(i)
  if (s === 'draft' || s === 'cancelled' || s === 'paid') return s
  if (balanceOf(i) > 0 && i.due_on < ctx.today) return 'overdue'
  return s
}

const LEGACY_LINE = (ctx: Ctx, m: E.Milestone | undefined, p: E.Project | undefined, amount: number, s: InvoiceSettings, rate: number): InvoiceLine => ({
  id: 'l1', item: m ? `M${m.no} ${m.name}` : p ? p.name : 'Professional services', description: p ? `${p.code} · ${p.name}` : '', hsn_sac: s.default_sac, qty: 1, unit: 'Lot', rate_paise: amount,
  discount_pct: 0, gst_rate: rate, source: m ? { kind: 'milestone', milestone_id: m.id } : { kind: 'manual' },
})
/** Fill GST detail on an invoice that predates v7 (or was raised through the legacy milestone endpoint). */
export function ensureGst(ctx: Ctx, inv: E.Invoice): E.Invoice {
  if (inv.lines && inv.lines.length && inv.total_paise !== undefined && inv.seller && inv.bill_to) return inv
  const s = invoiceSettings(ctx)
  const p = rows(ctx, 'projects').find((x) => x.id === inv.project_id)
  const m = inv.milestone_id ? rows(ctx, 'milestones').find((x) => x.id === inv.milestone_id) : undefined
  const seller = inv.seller ?? sellerParty(ctx)
  const client = p ? clientForProject(ctx, p) : null
  const bill = inv.bill_to ?? clientParty(client, p?.client ?? '')
  const pos = inv.place_of_supply ?? (bill.state_code || seller.state_code)
  const mode = taxModeOf(seller.state_code, pos, bill.country)
  const lines = inv.lines?.length ? inv.lines : [LEGACY_LINE(ctx, m, p, inv.amount_paise, s, mode === 'export' ? 0 : s.default_gst_rate)]
  const t = computeTotals(lines, mode, !!inv.reverse_charge)
  // legacy payments carried only the ex-GST share: gross them up so received + TDS settles the GST total
  const pays = rows(ctx, 'payments').filter((x) => x.invoice_id === inv.id)
  for (const pay of pays) if (pay.gross_paise === undefined) Object.assign(pay, { gross_paise: t.taxable ? Math.round((pay.amount_paise * t.total) / t.taxable) : pay.amount_paise, tds_paise: 0 })
  let received = pays.reduce((a, x) => a + (x.gross_paise ?? 0), 0)
  const tds = pays.reduce((a, x) => a + (x.tds_paise ?? 0), 0)
  if (inv.paid_amount_paise >= inv.amount_paise && inv.amount_paise > 0 && received + tds !== t.total) received = t.total - tds // rounding: fully paid stays fully paid
  Object.assign(inv, {
    status: inv.status ?? rawStatus(inv), client_id: inv.client_id ?? client?.id ?? null, milestone_ids: inv.milestone_ids ?? (inv.milestone_id ? [inv.milestone_id] : []),
    seller, bill_to: bill, ship_to: inv.ship_to ?? null, place_of_supply: pos, tax_mode: mode, reverse_charge: !!inv.reverse_charge, lines,
    bank: inv.bank ?? { ...s.bank }, subtotal_paise: t.subtotal, discount_paise: t.discount, taxable_paise: t.taxable, cgst_paise: t.cgst, sgst_paise: t.sgst, igst_paise: t.igst,
    round_off_paise: t.round_off, total_paise: t.total, received_paise: received, tds_received_paise: tds, tds_pct: inv.tds_pct ?? (mode === 'export' ? 0 : s.default_tds_pct),
    notes: inv.notes ?? s.default_notes, terms: inv.terms ?? s.default_terms, po_reference: inv.po_reference ?? null, signatory: inv.signatory ?? { name: s.signatory_name, title: s.signatory_title },
    issued_on: inv.issued_on ?? inv.invoiced_on, emails: inv.emails ?? [],
  } satisfies Partial<E.Invoice>)
  persist()
  return inv
}

/* ------------------------------------------------------------------ */
/* Draft body: normalise + validate                                    */
/* ------------------------------------------------------------------ */
export interface InvoiceInput {
  project_id: string
  milestone_ids: string[]
  client_id: string | null
  seller: InvoiceParty
  bill_to: InvoiceParty
  ship_to: InvoiceParty | null
  invoiced_on: string
  due_on: string
  place_of_supply: string
  po_reference: string
  po_date: string | null
  reverse_charge: boolean
  lines: InvoiceLine[]
  tds_pct: number
  bank: NonNullable<E.Invoice['bank']>
  notes: string
  terms: string
  signatory: { name: string; title: string }
  number?: string
}
export interface Issue {
  field: string
  message: string
}
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v).trim())
function party(v: unknown): InvoiceParty {
  const o = (v ?? {}) as Record<string, unknown>
  const p: InvoiceParty = {
    name: str(o.name), address: str(o.address), city: str(o.city), state: str(o.state), state_code: str(o.state_code), pincode: str(o.pincode), country: str(o.country) || 'India',
    gstin: str(o.gstin).toUpperCase(), pan: str(o.pan).toUpperCase(), email: str(o.email), phone: str(o.phone), contact: str(o.contact),
  }
  if (o.cin !== undefined) p.cin = str(o.cin).toUpperCase()
  if (o.website !== undefined) p.website = str(o.website)
  if (!p.state && p.state_code) p.state = stateName(p.state_code)
  if (!isIndia(p.country)) p.state_code = EXPORT_CODE
  return p
}
export function normalise(body: Record<string, unknown>): InvoiceInput {
  const b = (body.bank ?? {}) as Record<string, unknown>
  const sig = (body.signatory ?? {}) as Record<string, unknown>
  const lines = Array.isArray(body.lines) ? (body.lines as Record<string, unknown>[]) : []
  return {
    project_id: str(body.project_id),
    milestone_ids: Array.isArray(body.milestone_ids) ? [...new Set((body.milestone_ids as unknown[]).map(str).filter(Boolean))] : [],
    client_id: str(body.client_id) || null,
    seller: party(body.seller),
    bill_to: party(body.bill_to),
    ship_to: body.ship_to ? party(body.ship_to) : null,
    invoiced_on: str(body.invoiced_on),
    due_on: str(body.due_on),
    place_of_supply: str(body.place_of_supply),
    po_reference: str(body.po_reference),
    po_date: str(body.po_date) || null,
    reverse_charge: !!body.reverse_charge,
    lines: lines.map((l, i) => ({
      id: str(l.id) || `l${i + 1}`, item: str(l.item), description: str(l.description), hsn_sac: str(l.hsn_sac), qty: Number(l.qty), unit: str(l.unit) || 'Nos', rate_paise: Math.round(Number(l.rate_paise)),
      discount_pct: Number(l.discount_pct ?? 0) || 0, gst_rate: Number(l.gst_rate), source: (l.source as InvoiceLine['source']) ?? { kind: 'manual' },
    })),
    tds_pct: Number(body.tds_pct ?? 0) || 0,
    bank: { bank_name: str(b.bank_name), account_name: str(b.account_name), account_number: str(b.account_number).replace(/\s+/g, ''), ifsc: str(b.ifsc).toUpperCase(), branch: str(b.branch), upi: str(b.upi) },
    notes: str(body.notes),
    terms: typeof body.terms === 'string' ? body.terms.trim() : '',
    signatory: { name: str(sig.name), title: str(sig.title) },
    number: str(body.number) || undefined,
  }
}

function checkParty(out: Issue[], key: string, p: InvoiceParty, label: string, requireGstin: boolean) {
  if (!p.name) out.push({ field: `${key}.name`, message: `Enter the ${label} name.` })
  if (!p.address) out.push({ field: `${key}.address`, message: `Enter the ${label} address.` })
  const india = isIndia(p.country)
  if (india && !STATE_BY_CODE.has(p.state_code)) out.push({ field: `${key}.state_code`, message: `Choose the ${label} state.` })
  if (india && p.pincode && !/^\d{6}$/.test(p.pincode)) out.push({ field: `${key}.pincode`, message: 'PIN code has 6 digits.' })
  if (p.gstin) {
    if (!GSTIN_RE.test(p.gstin)) out.push({ field: `${key}.gstin`, message: 'GSTIN must be 15 characters, e.g. 21AAKCS4821M1Z5.' })
    else if (india && p.state_code && p.gstin.slice(0, 2) !== p.state_code) out.push({ field: `${key}.gstin`, message: `GSTIN starts with ${p.gstin.slice(0, 2)} (${stateName(p.gstin.slice(0, 2)) || 'unknown state'}) but the state is ${stateName(p.state_code)} (${p.state_code}).` })
    else if (p.pan && p.gstin.slice(2, 12) !== p.pan) out.push({ field: `${key}.pan`, message: `PAN ${p.pan} does not match the PAN inside the GSTIN (${p.gstin.slice(2, 12)}).` })
    if (!india) out.push({ field: `${key}.gstin`, message: 'Overseas parties have no GSTIN. Clear it or set the country to India.' })
  } else if (requireGstin) out.push({ field: `${key}.gstin`, message: `Enter the ${label} GSTIN — a tax invoice needs it.` })
  if (p.pan && !PAN_RE.test(p.pan)) out.push({ field: `${key}.pan`, message: 'PAN is 10 characters, e.g. AAKCS4821M.' })
  if (p.email && !EMAIL_RE.test(p.email)) out.push({ field: `${key}.email`, message: 'Enter a valid email address.' })
}

/** Validate a draft. `issuing` adds the checks a final tax invoice needs. Returns issues (never throws). */
export function validateInput(ctx: Ctx, v: InvoiceInput, opts: { issuing: boolean; selfId?: string }): Issue[] {
  const out: Issue[] = []
  const p = v.project_id ? rows(ctx, 'projects').find((x) => x.id === v.project_id) : undefined
  if (!p) out.push({ field: 'project_id', message: 'Choose the project this invoice is for.' })
  // milestones
  const invs = rows(ctx, 'invoices')
  for (const mid of v.milestone_ids) {
    const m = rows(ctx, 'milestones').find((x) => x.id === mid)
    if (!m || m.deleted_at || (p && m.project_id !== p.id)) {
      out.push({ field: 'milestone_ids', message: 'A selected milestone is not part of this project.' })
      continue
    }
    const other = invs.find((i) => i.id !== opts.selfId && isLive(i) && ((i.milestone_ids ?? (i.milestone_id ? [i.milestone_id] : [])).includes(m.id)))
    if (other) out.push({ field: 'milestone_ids', message: `M${m.no} ${m.name} is already invoiced on ${other.number}.` })
    else if (m.billing_status !== 'none') out.push({ field: 'milestone_ids', message: `M${m.no} ${m.name} is already ${m.billing_status === 'paid' ? 'paid' : 'invoiced'}.` })
  }
  // parties
  checkParty(out, 'seller', v.seller, 'seller', opts.issuing)
  checkParty(out, 'bill_to', v.bill_to, 'client', false)
  if (v.ship_to) checkParty(out, 'ship_to', v.ship_to, 'ship-to', false)
  // details
  if (!DATE_RE.test(v.invoiced_on)) out.push({ field: 'invoiced_on', message: 'Pick the invoice date.' })
  else if (opts.issuing && v.invoiced_on > ctx.today) out.push({ field: 'invoiced_on', message: 'An invoice can’t be dated in the future. Use today or an earlier date.' })
  if (!DATE_RE.test(v.due_on)) out.push({ field: 'due_on', message: 'Pick the due date.' })
  else if (DATE_RE.test(v.invoiced_on) && v.due_on < v.invoiced_on) out.push({ field: 'due_on', message: 'The due date is before the invoice date.' })
  if (!STATE_BY_CODE.has(v.place_of_supply)) out.push({ field: 'place_of_supply', message: 'Choose the place of supply (the client’s state).' })
  else if (v.place_of_supply === EXPORT_CODE && isIndia(v.bill_to.country)) out.push({ field: 'place_of_supply', message: 'Export applies only to clients outside India. Pick the client’s state.' })
  if (v.po_date && !DATE_RE.test(v.po_date)) out.push({ field: 'po_date', message: 'Pick a valid PO date.' })
  if (!(v.tds_pct >= 0 && v.tds_pct <= 20)) out.push({ field: 'tds_pct', message: 'TDS is between 0% and 20%.' })
  // lines
  if (!v.lines.length) out.push({ field: 'lines', message: 'Add at least one line item.' })
  v.lines.forEach((l, i) => {
    const k = `lines.${i}`
    if (!l.item) out.push({ field: `${k}.item`, message: `Line ${i + 1}: enter the item name.` })
    if (!SAC_RE.test(l.hsn_sac)) out.push({ field: `${k}.hsn_sac`, message: `Line ${i + 1}: HSN/SAC is 4–8 digits (IT services: 998314).` })
    if (!(l.qty > 0)) out.push({ field: `${k}.qty`, message: `Line ${i + 1}: quantity must be above zero.` })
    if (!(Number.isFinite(l.rate_paise) && l.rate_paise >= 0)) out.push({ field: `${k}.rate_paise`, message: `Line ${i + 1}: enter the rate.` })
    if (!(l.discount_pct >= 0 && l.discount_pct <= 100)) out.push({ field: `${k}.discount_pct`, message: `Line ${i + 1}: discount is 0–100%.` })
    if (!GST_RATES.includes(l.gst_rate)) out.push({ field: `${k}.gst_rate`, message: `Line ${i + 1}: GST rate is 0, 5, 12, 18 or 28%.` })
  })
  const mode = taxModeOf(v.seller.state_code, v.place_of_supply, v.bill_to.country)
  const t = computeTotals(v.lines, mode, v.reverse_charge)
  if (v.lines.length && t.total <= 0) out.push({ field: 'lines', message: 'The invoice total must be above zero.' })
  // bank (needed on the printed invoice)
  if (opts.issuing) {
    if (!v.bank.bank_name) out.push({ field: 'bank.bank_name', message: 'Enter the bank name.' })
    if (!/^\d{9,18}$/.test(v.bank.account_number)) out.push({ field: 'bank.account_number', message: 'Enter the full account number (9–18 digits).' })
    if (!v.bank.account_name) out.push({ field: 'bank.account_name', message: 'Enter the account name.' })
    if (!v.signatory.name) out.push({ field: 'signatory.name', message: 'Enter the authorised signatory.' })
  }
  if (v.bank.ifsc && !IFSC_RE.test(v.bank.ifsc)) out.push({ field: 'bank.ifsc', message: 'IFSC is 11 characters, e.g. HDFC0001827.' })
  else if (opts.issuing && !v.bank.ifsc) out.push({ field: 'bank.ifsc', message: 'Enter the IFSC.' })
  if (opts.issuing && v.number !== undefined) {
    if (!/^[A-Za-z0-9/\-]{1,16}$/.test(v.number)) out.push({ field: 'number', message: 'Invoice number: up to 16 letters, digits, “/” or “-” (GST rule).' })
    else if (invs.some((i) => i.id !== opts.selfId && lc(i.number) === lc(v.number!))) out.push({ field: 'number', message: `Invoice ${v.number} already exists. Use ${nextInvoiceNumber(ctx, v.invoiced_on || ctx.today)}.` })
  }
  return out
}
function fail(issues: Issue[]): never {
  const f = issues[0]
  err(422, 'VALIDATION', issues.length > 1 ? `${f.message} (${issues.length - 1} more to fix)` : f.message, f.field)
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */
function totalsFields(v: InvoiceInput): Partial<E.Invoice> {
  const mode = taxModeOf(v.seller.state_code, v.place_of_supply, v.bill_to.country)
  const t = computeTotals(v.lines, mode, v.reverse_charge)
  return {
    tax_mode: mode, subtotal_paise: t.subtotal, discount_paise: t.discount, taxable_paise: t.taxable, cgst_paise: t.cgst, sgst_paise: t.sgst, igst_paise: t.igst, round_off_paise: t.round_off, total_paise: t.total,
  }
}
function draftFields(v: InvoiceInput): Partial<E.Invoice> {
  return {
    project_id: v.project_id, milestone_ids: v.milestone_ids, client_id: v.client_id, seller: v.seller, bill_to: v.bill_to, ship_to: v.ship_to, invoiced_on: v.invoiced_on, due_on: v.due_on,
    place_of_supply: v.place_of_supply, po_reference: v.po_reference || null, po_date: v.po_date, reverse_charge: v.reverse_charge, lines: v.lines.map((l, i) => ({ ...l, id: l.id || `l${i + 1}` })),
    tds_pct: v.tds_pct, bank: v.bank, notes: v.notes, terms: v.terms, signatory: v.signatory, ...totalsFields(v),
  }
}
function saveClientBack(ctx: Ctx, v: InvoiceInput) {
  if (!v.client_id) err(422, 'VALIDATION', 'Pick the client in the bill-to block to save these details to the client master.', 'client_id')
  if (!hasAny(ctx, 'clients.manage', 'finance.edit')) err(403, 'FORBIDDEN', 'You can’t edit the client master.')
  const c = find(ctx, 'clients', v.client_id) as unknown as ClientGst
  const b = v.bill_to
  update(ctx, 'clients', c.id, {
    billing_address: b.address, gstin: b.gstin, email: b.email || c.email, phone: b.phone || c.phone, primary_contact: b.contact || c.primary_contact, country: b.country || c.country,
    ...({ city: b.city, state: b.state, state_code: b.state_code, pincode: b.pincode, pan: b.pan } as object),
  } as never)
  logActivity(ctx, 'client', c.id, 'edited', `Billing details updated from an invoice (GSTIN ${b.gstin || '—'}, ${b.state || b.country})`)
}

const STREAM_CATEGORY: Record<string, string> = { sap_consulting: 'SAP consulting', products: 'Product licence', services: 'Services', saas: 'Subscription / AMC', ams: 'AMS' }

/** Final step shared by the editor, the legacy milestone endpoint and the seed: number, revenue, milestones, ledger. */
export function issueInvoice(ctx: Ctx, inv: E.Invoice, numberOverride?: string) {
  const p = find(ctx, 'projects', inv.project_id, 'Project')
  const date = inv.invoiced_on
  let number = numberOverride && numberOverride.trim() ? numberOverride.trim() : nextInvoiceNumber(ctx, date)
  if (rows(ctx, 'invoices').some((i) => i.id !== inv.id && lc(i.number) === lc(number))) number = nextInvoiceNumber(ctx, date)
  const ms = (inv.milestone_ids ?? []).map((id) => find(ctx, 'milestones', id, 'Milestone'))
  const taxable = inv.taxable_paise ?? 0
  const out = update(ctx, 'invoices', inv.id, {
    number, status: 'issued', amount_paise: taxable, paid_amount_paise: 0, paid_on: null, milestone_id: ms[0]?.id ?? '', issued_on: ctx.today, issued_by: ctx.user.id, received_paise: 0, tds_received_paise: 0,
  })
  for (const m of ms) update(ctx, 'milestones', m.id, { billing_status: 'invoiced' })
  const what = ms.length ? ms.map((m) => `M${m.no} ${m.name}`).join(', ') : inv.lines?.[0]?.item ?? 'Services'
  insert(ctx, 'ledger_entries', {
    kind: 'income', category: ms.length ? 'Milestone invoice' : STREAM_CATEGORY[p.stream] ?? 'Services', description: `${number} · ${p.name} · ${what}`, amount_paise: taxable, date, recurring: false, until_on: null,
    status: 'expected', project_id: p.id, milestone_id: ms[0]?.id ?? null, invoice_id: inv.id, stream: p.stream, locked: true,
  })
  for (const m of ms) if (m.billing_amount_paise && m.billing_amount_paise !== sumMilestoneLines(inv, m.id)) warn(ctx, 'INV_AMOUNT_DIFFERS', `M${m.no} is billed at ${fmtMoney(sumMilestoneLines(inv, m.id))} against a milestone billing of ${fmtMoney(m.billing_amount_paise)}.`)
  logActivity(ctx, 'invoice', inv.id, 'issued', `Issued ${number} for ${fmtMoney(inv.total_paise ?? taxable, { decimals: true })} (taxable ${fmtMoney(taxable, { decimals: true })})`)
  logActivity(ctx, 'project', p.id, 'invoice.raised', `Invoice ${number} raised${ms.length ? ` for ${ms.map((m) => `M${m.no}`).join(', ')}` : ''}: ${fmtMoney(taxable)} + GST`)
  return out
}
function sumMilestoneLines(inv: E.Invoice, mid: string) {
  const mode = (inv.tax_mode ?? 'intra') as TaxMode
  const lines = (inv.lines ?? []).filter((l) => l.source?.kind === 'milestone' && l.source.milestone_id === mid)
  return computeTotals(lines, mode).taxable
}

/** Record a settlement: cash received + TDS deducted, against the GST-inclusive total. */
export function applyPayment(ctx: Ctx, inv0: E.Invoice, b: { received: number; tds: number; paid_on: string; reference: string; mode: string }, ifMatch?: number) {
  const inv = ensureGst(ctx, inv0)
  if (!isLive(inv)) err(409, 'INV_NOT_ISSUED', inv.status === 'draft' ? 'Issue the invoice before recording a payment.' : 'This invoice is cancelled.')
  if (!Number.isInteger(b.received) || b.received < 0) err(422, 'MONEY_INVALID', 'Enter the amount received.', 'received_paise')
  if (!Number.isInteger(b.tds) || b.tds < 0) err(422, 'MONEY_INVALID', 'TDS can’t be negative.', 'tds_paise')
  const settle = b.received + b.tds
  if (settle <= 0) err(422, 'MONEY_INVALID', 'Enter the amount received (and any TDS deducted).', 'received_paise')
  if (!DATE_RE.test(b.paid_on)) err(422, 'VALIDATION', 'Pick the date the money arrived.', 'paid_on')
  if (b.paid_on > ctx.today) err(422, 'VALIDATION', 'A payment date can’t be in the future.', 'paid_on')
  if (b.paid_on < inv.invoiced_on) err(422, 'DATE_RANGE', 'The payment date can’t be before the invoice date.', 'paid_on')
  const total = inv.total_paise ?? inv.amount_paise
  const balance = balanceOf(inv)
  if (balance <= 0) err(409, 'INV_OVERPAY', `Invoice ${inv.number} is already fully paid.`)
  if (settle > balance) err(422, 'INV_OVERPAY', `Only ${fmtMoney(balance)} is due on ${inv.number} (incl. GST). Received + TDS must not exceed it.`, 'received_paise')
  const taxableTds = Math.round(((inv.tds_pct ?? 0) / 100) * (inv.taxable_paise ?? inv.amount_paise))
  if (b.tds > Math.max(taxableTds, Math.round((inv.taxable_paise ?? inv.amount_paise) * 0.2)) && b.tds > 0) err(422, 'VALIDATION', `TDS of ${fmtMoney(b.tds)} is more than 20% of the taxable value. Check the figure.`, 'tds_paise')
  const full = settle >= balance
  // revenue share of this settlement; the last settlement takes the remainder so paid = amount exactly
  const share = full ? inv.amount_paise - inv.paid_amount_paise : Math.min(inv.amount_paise - inv.paid_amount_paise, Math.round((settle * inv.amount_paise) / Math.max(1, total)))
  const pay = insert(ctx, 'payments', { invoice_id: inv.id, amount_paise: share, paid_on: b.paid_on, reference: b.reference, gross_paise: b.received, tds_paise: b.tds, mode: b.mode })
  const u = update(ctx, 'invoices', inv.id, {
    paid_amount_paise: inv.paid_amount_paise + share, paid_on: full ? b.paid_on : inv.paid_on, received_paise: (inv.received_paise ?? 0) + b.received, tds_received_paise: (inv.tds_received_paise ?? 0) + b.tds,
    status: full ? 'paid' : 'partially_paid',
  }, ifMatch)
  if (full) {
    for (const mid of inv.milestone_ids ?? (inv.milestone_id ? [inv.milestone_id] : [])) {
      const m = rows(ctx, 'milestones').find((x) => x.id === mid)
      if (m && m.billing_status !== 'paid') update(ctx, 'milestones', m.id, { billing_status: 'paid' })
    }
    for (const le of rows(ctx, 'ledger_entries').filter((x) => x.invoice_id === inv.id && x.amount_paise > 0)) update(ctx, 'ledger_entries', le.id, { status: 'received' })
  }
  const what = `${fmtMoney(b.received)} received${b.tds ? ` + ${fmtMoney(b.tds)} TDS` : ''} on ${inv.number}${full ? ' — paid in full' : ''}`
  logActivity(ctx, 'invoice', inv.id, 'payment', what)
  logActivity(ctx, 'project', inv.project_id, 'payment.recorded', what)
  return { invoice: u, payment: pay, fully_paid: full }
}

/** Legacy POST /milestones/:id/invoice (Costing tab dialog): a complete GST invoice, issued at once. */
export function raiseMilestoneInvoice(ctx: Ctx, m: E.Milestone, b: { number: string; invoiced_on: string; due_on: string; amount_paise: number; file_id: string | null }) {
  const p = find(ctx, 'projects', m.project_id, 'Project')
  const s = invoiceSettings(ctx)
  const seller = sellerParty(ctx)
  const client = clientForProject(ctx, p)
  const bill = clientParty(client, p.client)
  const pos = bill.state_code || seller.state_code
  const mode = taxModeOf(seller.state_code, pos, bill.country)
  const lines = [LEGACY_LINE(ctx, m, p, b.amount_paise, s, mode === 'export' ? 0 : s.default_gst_rate)]
  const v: InvoiceInput = {
    project_id: p.id, milestone_ids: [m.id], client_id: client?.id ?? null, seller, bill_to: bill, ship_to: null, invoiced_on: b.invoiced_on, due_on: b.due_on, place_of_supply: pos, po_reference: '', po_date: null,
    reverse_charge: false, lines, tds_pct: mode === 'export' ? 0 : s.default_tds_pct, bank: { ...s.bank }, notes: s.default_notes, terms: s.default_terms, signatory: { name: s.signatory_name, title: s.signatory_title },
  }
  const inv = insert(ctx, 'invoices', { number: `DRAFT-${nextDraftNo(ctx)}`, draft_no: nextDraftNo(ctx), status: 'draft', amount_paise: 0, paid_amount_paise: 0, paid_on: null, milestone_id: '', file_id: b.file_id, emails: [], ...draftFields(v) } as never) as E.Invoice
  return issueInvoice(ctx, inv, b.number)
}
/** Legacy POST /invoices/:id/payments: the amount is on the ex-GST (revenue) basis — gross it up to cash. */
export function recordRevenuePayment(ctx: Ctx, inv0: E.Invoice, amount: number, paid_on: string, reference: string) {
  const inv = ensureGst(ctx, inv0)
  const outstanding = inv.amount_paise - inv.paid_amount_paise
  if (outstanding <= 0) err(409, 'INV_OVERPAY', `Invoice ${inv.number} is already fully paid.`, 'amount_paise')
  if (amount > outstanding) err(409, 'INV_OVERPAY', `Only ${fmtMoney(outstanding)} (ex-GST) is outstanding on ${inv.number}. Record that amount or less.`, 'amount_paise')
  const gross = amount >= outstanding ? balanceOf(inv) : Math.round((amount * (inv.total_paise ?? amount)) / Math.max(1, inv.amount_paise))
  return applyPayment(ctx, inv, { received: Math.min(gross, balanceOf(inv)), tds: 0, paid_on, reference, mode: 'Bank transfer' }).invoice
}

/* ------------------------------------------------------------------ */
/* Read models                                                         */
/* ------------------------------------------------------------------ */
export type AgeBucket = '0_30' | '31_60' | '61_90' | '90_plus'
const bucketOf = (age: number): AgeBucket => (age <= 30 ? '0_30' : age <= 60 ? '31_60' : age <= 90 ? '61_90' : '90_plus')
export interface InvoiceListRow {
  id: string
  version: number
  number: string
  status: InvoiceDisplayStatus
  project_id: string
  project_code: string
  project_name: string
  client: string
  client_id: string | null
  milestone_label: string
  invoiced_on: string
  due_on: string
  taxable_paise: number
  gst_paise: number
  total_paise: number
  paid_paise: number // received + TDS
  balance_paise: number
  days_overdue: number
  age_days: number
  bucket: AgeBucket | null
  tax_mode: TaxMode
  stream: E.RevenueStream
}
export interface InvoiceListResult {
  items: InvoiceListRow[]
  summary: {
    fy_label: string
    billed_fy: number // taxable value of invoices issued this FY (= revenue)
    gst_fy: number // GST charged on them (liability)
    collected_fy: number // cash + TDS settled this FY (incl. GST)
    outstanding: number
    outstanding_count: number
    overdue: number
    overdue_count: number
    drafts: number
    dso: number | null
    ageing: Record<AgeBucket, { amount: number; count: number }>
  }
  can_edit: boolean
}
function milestoneLabel(ctx: Ctx, i: E.Invoice) {
  const ids = i.milestone_ids?.length ? i.milestone_ids : i.milestone_id ? [i.milestone_id] : []
  const ms = ids.map((id) => rows(ctx, 'milestones').find((m) => m.id === id)).filter(Boolean) as E.Milestone[]
  if (ms.length) return ms.map((m) => `M${m.no} ${m.name}`).join(', ')
  return i.lines?.[0]?.item ?? '—'
}
function listRow(ctx: Ctx, i: E.Invoice, projects: Map<string, E.Project>): InvoiceListRow {
  const p = projects.get(i.project_id)
  const status = displayStatus(ctx, i)
  const balance = balanceOf(i)
  const age = Math.max(0, diffDays(ctx.today, i.invoiced_on))
  return {
    id: i.id, version: i.version, number: i.status === 'draft' ? `Draft ${i.draft_no ?? ''}`.trim() : i.number, status, project_id: i.project_id, project_code: p?.code ?? '', project_name: p?.name ?? '—',
    client: i.bill_to?.name || p?.client || '', client_id: i.client_id ?? null, milestone_label: milestoneLabel(ctx, i), invoiced_on: i.invoiced_on, due_on: i.due_on,
    taxable_paise: i.taxable_paise ?? i.amount_paise, gst_paise: (i.cgst_paise ?? 0) + (i.sgst_paise ?? 0) + (i.igst_paise ?? 0), total_paise: i.total_paise ?? i.amount_paise,
    paid_paise: settledOf(i), balance_paise: balance, days_overdue: balance > 0 && i.due_on < ctx.today ? diffDays(ctx.today, i.due_on) : 0, age_days: age, bucket: balance > 0 ? bucketOf(age) : null,
    tax_mode: (i.tax_mode ?? 'intra') as TaxMode, stream: p?.stream ?? 'services',
  }
}
export function invoiceList(ctx: Ctx): InvoiceListResult {
  const projects = new Map(rows(ctx, 'projects').map((p) => [p.id, p]))
  const all = rows(ctx, 'invoices').map((i) => ensureGst(ctx, i))
  const items = all.map((i) => listRow(ctx, i, projects)).sort((a, b) => b.invoiced_on.localeCompare(a.invoiced_on) || b.number.localeCompare(a.number))
  const fm = ctx.tenant.settings['company.fy_start_month'] ?? 4
  const fy = fyStartYear(ctx.today, fm)
  const fr = fyRange(fy, fm)
  const ageing = { '0_30': { amount: 0, count: 0 }, '31_60': { amount: 0, count: 0 }, '61_90': { amount: 0, count: 0 }, '90_plus': { amount: 0, count: 0 } } as InvoiceListResult['summary']['ageing']
  let outstanding = 0, outCount = 0, overdue = 0, overdueCount = 0
  for (const x of items) {
    if (!x.bucket) continue
    outstanding += x.balance_paise
    outCount++
    ageing[x.bucket].amount += x.balance_paise
    ageing[x.bucket].count++
    if (x.status === 'overdue') {
      overdue += x.balance_paise
      overdueCount++
    }
  }
  const live = items.filter((x) => x.status !== 'draft' && x.status !== 'cancelled')
  const inFy = live.filter((x) => x.invoiced_on >= fr.from && x.invoiced_on <= fr.to)
  const liveIds = new Set(all.filter(isLive).map((i) => i.id))
  const pays = rows(ctx, 'payments').filter((p) => liveIds.has(p.invoice_id) && p.paid_on >= fr.from && p.paid_on <= fr.to)
  const billed90 = live.filter((x) => x.invoiced_on > addDays(ctx.today, -90) && x.invoiced_on <= ctx.today).reduce((s, x) => s + x.total_paise, 0)
  return {
    items,
    summary: {
      fy_label: fyLabel(fy), billed_fy: inFy.reduce((s, x) => s + x.taxable_paise, 0), gst_fy: inFy.reduce((s, x) => s + x.gst_paise, 0),
      collected_fy: pays.reduce((s, p) => s + (p.gross_paise ?? p.amount_paise) + (p.tds_paise ?? 0), 0),
      outstanding, outstanding_count: outCount, overdue, overdue_count: overdueCount, drafts: items.filter((x) => x.status === 'draft').length,
      dso: billed90 > 0 ? Math.round(outstanding / (billed90 / 90)) : null, ageing,
    },
    can_edit: has(ctx, 'finance.edit'),
  }
}

export interface InvoiceDetail {
  invoice: E.Invoice
  status: InvoiceDisplayStatus
  totals: InvoiceTotals
  place_of_supply_label: string
  project: { id: string; code: string; name: string; client: string; billing_model: E.BillingModel; stream: E.RevenueStream }
  milestones: { id: string; no: number; name: string; billing_amount_paise: number; billing_status: E.MilestoneBilling }[]
  payments: { id: string; paid_on: string; reference: string; mode: string; gross_paise: number; tds_paise: number; revenue_paise: number }[]
  settled_paise: number
  received_paise: number
  tds_paise: number
  balance_paise: number
  days_overdue: number
  suggested_tds_paise: number
  ledger: { id: string; date: string; category: string; amount_paise: number; status: string }[]
  activity: { at: string; actor: string; summary: string }[]
  emails: { to: string; at: string; by: string }[]
  client_email: string
  can_edit: boolean
  can_pay: boolean
  can_cancel: boolean
  cancel_block: string | null
  next_number: string | null // the number a draft will get when issued
}
export function invoiceDetail(ctx: Ctx, id: string): InvoiceDetail {
  const inv = ensureGst(ctx, find(ctx, 'invoices', id, 'Invoice'))
  const p = find(ctx, 'projects', inv.project_id, 'Project')
  const mode = (inv.tax_mode ?? 'intra') as TaxMode
  const totals = computeTotals(inv.lines ?? [], mode, !!inv.reverse_charge)
  const pays = rows(ctx, 'payments').filter((x) => x.invoice_id === inv.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on))
  const ids = inv.milestone_ids?.length ? inv.milestone_ids : inv.milestone_id ? [inv.milestone_id] : []
  const balance = balanceOf(inv)
  const edit = has(ctx, 'finance.edit')
  const status = displayStatus(ctx, inv)
  const live = isLive(inv)
  const taxableLeft = live && inv.total_paise ? Math.round((balance * (inv.taxable_paise ?? 0)) / inv.total_paise) : 0
  const client = inv.client_id ? (rows(ctx, 'clients') as unknown as ClientGst[]).find((c) => c.id === inv.client_id) : null
  return {
    invoice: inv,
    status,
    totals,
    place_of_supply_label: inv.place_of_supply ? `${stateName(inv.place_of_supply)} (${inv.place_of_supply})` : '—',
    project: { id: p.id, code: p.code, name: p.name, client: p.client, billing_model: p.billing_model, stream: p.stream },
    milestones: ids.map((mid) => rows(ctx, 'milestones').find((m) => m.id === mid)).filter(Boolean).map((m) => ({ id: m!.id, no: m!.no, name: m!.name, billing_amount_paise: m!.billing_amount_paise, billing_status: m!.billing_status })),
    payments: pays.map((x) => ({ id: x.id, paid_on: x.paid_on, reference: x.reference, mode: x.mode ?? '', gross_paise: x.gross_paise ?? x.amount_paise, tds_paise: x.tds_paise ?? 0, revenue_paise: x.amount_paise })),
    settled_paise: settledOf(inv), received_paise: inv.received_paise ?? 0, tds_paise: inv.tds_received_paise ?? 0, balance_paise: balance,
    days_overdue: balance > 0 && inv.due_on < ctx.today ? diffDays(ctx.today, inv.due_on) : 0,
    suggested_tds_paise: Math.round(((inv.tds_pct ?? 0) / 100) * taxableLeft),
    ledger: rows(ctx, 'ledger_entries').filter((l) => l.invoice_id === inv.id).sort((a, b) => a.date.localeCompare(b.date)).map((l) => ({ id: l.id, date: l.date, category: l.category, amount_paise: l.amount_paise, status: l.status })),
    activity: rows(ctx, 'activity_log').filter((a) => a.entity === 'invoice' && a.entity_id === inv.id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30).map((a) => ({ at: a.at, actor: userName(ctx, a.actor_id), summary: a.summary })),
    emails: (inv.emails ?? []).map((e) => ({ to: e.to, at: e.at, by: userName(ctx, e.by) })),
    client_email: inv.bill_to?.email || client?.email || '',
    can_edit: edit,
    can_pay: edit && live && balance > 0,
    can_cancel: edit && live && settledOf(inv) === 0,
    cancel_block: live && settledOf(inv) > 0 ? 'Payments are recorded on this invoice, so it can’t be cancelled.' : null,
    next_number: inv.status === 'draft' ? nextInvoiceNumber(ctx, inv.invoiced_on <= ctx.today ? inv.invoiced_on : ctx.today) : null,
  }
}

/* ------------------------------------------------------------------ */
/* Prefill and billable hours                                          */
/* ------------------------------------------------------------------ */
function liveMilestones(ctx: Ctx, pid: string) {
  return rows(ctx, 'milestones').filter((m) => m.project_id === pid && !m.deleted_at).sort((a, b) => a.no - b.no)
}
export interface PrefillMilestone { id: string; no: number; name: string; billing_amount_paise: number; billing_status: E.MilestoneBilling; state: string; planned_end: string; invoice_number: string | null; draft_numbers: string[] }
export function milestoneLine(ctx: Ctx, m: E.Milestone, p: E.Project, gst: number): InvoiceLine {
  const s = invoiceSettings(ctx)
  return { id: `ms_${m.id}`, item: `M${m.no} ${m.name}`, description: `${p.name} — milestone ${m.no}`, hsn_sac: s.default_sac, qty: 1, unit: 'Lot', rate_paise: m.billing_amount_paise, discount_pct: 0, gst_rate: gst, source: { kind: 'milestone', milestone_id: m.id } }
}
function prefillMilestones(ctx: Ctx, p: E.Project, selfId?: string): PrefillMilestone[] {
  const tasks = rows(ctx, 'tasks').filter((t) => t.project_id === p.id)
  const invs = rows(ctx, 'invoices').filter((i) => i.project_id === p.id && i.id !== selfId)
  return liveMilestones(ctx, p.id).map((m) => {
    const ownIn = (i: E.Invoice) => (i.milestone_ids ?? (i.milestone_id ? [i.milestone_id] : [])).includes(m.id)
    const live = invs.find((i) => isLive(i) && ownIn(i))
    return {
      id: m.id, no: m.no, name: m.name, billing_amount_paise: m.billing_amount_paise, billing_status: m.billing_status, state: milestoneState(ctx, m, tasks).state, planned_end: m.planned_end,
      invoice_number: live?.number ?? null, draft_numbers: invs.filter((i) => i.status === 'draft' && ownIn(i)).map((i) => `Draft ${i.draft_no ?? ''}`.trim()),
    }
  })
}
export function prefill(ctx: Ctx, projectId: string, milestoneIds: string[]) {
  const p = find(ctx, 'projects', projectId, 'Project')
  const s = invoiceSettings(ctx)
  const seller = sellerParty(ctx)
  const client = clientForProject(ctx, p)
  const bill = clientParty(client, p.client)
  const pos = bill.state_code || seller.state_code
  const mode = taxModeOf(seller.state_code, pos, bill.country)
  const gst = mode === 'export' ? 0 : s.default_gst_rate
  const ms = liveMilestones(ctx, p.id).filter((m) => milestoneIds.includes(m.id))
  const date = ctx.today
  const terms = client?.payment_terms_days ?? s.payment_terms_days
  const contract = rows(ctx, 'contracts').find((c) => c.project_id === p.id && c.status !== 'terminated')
  const draft: InvoiceInput = {
    project_id: p.id, milestone_ids: ms.map((m) => m.id), client_id: client?.id ?? null, seller, bill_to: bill, ship_to: null, invoiced_on: date, due_on: addDays(date, terms), place_of_supply: pos,
    po_reference: contract ? contract.title : '', po_date: contract?.start_on ?? null, reverse_charge: false, lines: ms.map((m) => milestoneLine(ctx, m, p, gst)), tds_pct: mode === 'export' ? 0 : s.default_tds_pct,
    bank: { ...s.bank }, notes: s.default_notes, terms: s.default_terms, signatory: { name: s.signatory_name, title: s.signatory_title },
  }
  return {
    draft,
    project: { id: p.id, code: p.code, name: p.name, client: p.client, billing_model: p.billing_model, stream: p.stream, status: p.status },
    milestones: prefillMilestones(ctx, p),
    payment_terms_days: terms,
    client_found: !!client,
  }
}
export interface BillableHours {
  from: string
  to: string
  people: { user_id: string; name: string; approved_hours: number; billed_hours: number; unbilled_hours: number; pending_hours: number; rate_paise: number }[]
  total_unbilled: number
}
export function billableHours(ctx: Ctx, projectId: string, from: string, to: string, selfId?: string): BillableHours {
  const p = find(ctx, 'projects', projectId, 'Project')
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) err(422, 'VALIDATION', 'Pick the period to bill.', 'from')
  if (to < from) err(422, 'DATE_RANGE', 'The end date is before the start date.', 'to')
  const taskIds = new Set(rows(ctx, 'tasks').filter((t) => t.project_id === p.id).map((t) => t.id))
  const entries = costedEntries(ctx).filter((e) => e.kind === 'task' && e.task_id && taskIds.has(e.task_id) && e.work_date >= from && e.work_date <= to)
  // ranges already billed (issued, not cancelled), per person
  const billed = new Map<string, { from: string; to: string }[]>()
  for (const i of rows(ctx, 'invoices')) {
    if (i.project_id !== p.id || !isLive(i) || i.id === selfId) continue
    for (const l of i.lines ?? []) if (l.source?.kind === 'hours' && l.source.user_id && l.source.from && l.source.to) billed.set(l.source.user_id, [...(billed.get(l.source.user_id) ?? []), { from: l.source.from, to: l.source.to }])
  }
  const covered = (uid: string, d: string) => (billed.get(uid) ?? []).some((r) => d >= r.from && d <= r.to)
  const markup = (p.costing?.markup_pct ?? 35) / 100
  const per = new Map<string, BillableHours['people'][number]>()
  for (const e of entries) {
    const r = per.get(e.user_id) ?? { user_id: e.user_id, name: userName(ctx, e.user_id), approved_hours: 0, billed_hours: 0, unbilled_hours: 0, pending_hours: 0, rate_paise: 0 }
    if (!e.approved) r.pending_hours += e.hours
    else if (covered(e.user_id, e.work_date)) {
      r.approved_hours += e.hours
      r.billed_hours += e.hours
    } else {
      r.approved_hours += e.hours
      r.unbilled_hours += e.hours
    }
    per.set(e.user_id, r)
  }
  for (const r of per.values()) {
    const rate = currentRatePH(ctx, r.user_id) * (1 + markup)
    r.rate_paise = rate > 0 ? Math.max(5000, Math.round(rate / 5000) * 5000) : 150000 // nearest ₹50; ₹1,500/h when no cost rate is on file
    for (const k of ['approved_hours', 'billed_hours', 'unbilled_hours', 'pending_hours'] as const) r[k] = Math.round(r[k] * 100) / 100
  }
  const people = [...per.values()].sort((a, b) => b.unbilled_hours - a.unbilled_hours || a.name.localeCompare(b.name))
  return { from, to, people, total_unbilled: Math.round(people.reduce((s, x) => s + x.unbilled_hours, 0) * 100) / 100 }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */
const VIEW = 'Invoices are visible to finance only (CEO and administrators by default).'
const EDIT = 'Only people who can raise invoices (finance.edit) can do this.'

export function register(r: Router) {
  r.get('/finance/invoices', ({ ctx }) => {
    requireAction(ctx, 'finance.view', VIEW)
    return invoiceList(ctx)
  })
  r.get('/finance/invoices/meta', ({ ctx }) => {
    requireAction(ctx, 'finance.view', VIEW)
    const projects = rows(ctx, 'projects')
      .filter((p) => !p.code.endsWith('GEN'))
      .map((p) => ({ id: p.id, code: p.code, name: p.name, client: p.client, billing_model: p.billing_model, status: p.status }))
      .sort((a, b) => a.code.localeCompare(b.code))
    const clients = (rows(ctx, 'clients') as unknown as ClientGst[]).map((c) => ({ id: c.id, name: c.name, gstin: c.gstin, state: clientParty(c).state, country: c.country })).sort((a, b) => a.name.localeCompare(b.name))
    return { states: GST_STATES, units: UNITS, gst_rates: GST_RATES, settings: settingsFor(ctx), seller: sellerParty(ctx), projects, clients, next_number: nextInvoiceNumber(ctx, ctx.today), today: ctx.today }
  })
  r.get('/finance/invoices/settings', ({ ctx }) => {
    requireAction(ctx, 'finance.view', VIEW)
    return settingsFor(ctx)
  })
  r.put('/finance/invoices/settings', ({ ctx, body }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const cur = invoiceSettings(ctx)
    const b = (body.bank ?? {}) as Record<string, unknown>
    const prefix = str(body.prefix ?? cur.prefix).toUpperCase()
    if (!/^[A-Z0-9-]{1,6}$/.test(prefix)) err(422, 'VALIDATION', 'Prefix: 1–6 letters or digits (e.g. SCI). The number becomes SCI/26-27/0001.', 'prefix')
    const cn = str(body.credit_note_prefix ?? cur.credit_note_prefix).toUpperCase()
    if (!/^[A-Z0-9-]{1,6}$/.test(cn)) err(422, 'VALIDATION', 'Credit-note prefix: 1–6 letters or digits (e.g. CN).', 'credit_note_prefix')
    const terms = Number(body.payment_terms_days ?? cur.payment_terms_days)
    if (!Number.isInteger(terms) || terms < 0 || terms > 180) err(422, 'VALIDATION', 'Payment terms are 0–180 days.', 'payment_terms_days')
    const sac = str(body.default_sac ?? cur.default_sac)
    if (!SAC_RE.test(sac)) err(422, 'VALIDATION', 'HSN/SAC is 4–8 digits (IT services: 998314).', 'default_sac')
    const gst = Number(body.default_gst_rate ?? cur.default_gst_rate)
    if (!GST_RATES.includes(gst)) err(422, 'VALIDATION', 'GST rate is 0, 5, 12, 18 or 28%.', 'default_gst_rate')
    const tds = Number(body.default_tds_pct ?? cur.default_tds_pct)
    if (!(tds >= 0 && tds <= 20)) err(422, 'VALIDATION', 'TDS is between 0% and 20%.', 'default_tds_pct')
    const acct = b.account_number === undefined ? cur.bank.account_number : str(b.account_number).replace(/\s+/g, '')
    if (acct && !/^\d{9,18}$/.test(acct)) err(422, 'VALIDATION', 'Account number is 9–18 digits.', 'bank.account_number')
    const ifsc = str(b.ifsc ?? cur.bank.ifsc).toUpperCase()
    if (ifsc && !IFSC_RE.test(ifsc)) err(422, 'VALIDATION', 'IFSC is 11 characters, e.g. HDFC0001827.', 'bank.ifsc')
    const upi = str(b.upi ?? cur.bank.upi)
    if (upi && !/^[\w.-]{2,}@[A-Za-z]{2,}$/.test(upi)) err(422, 'VALIDATION', 'UPI ID looks like name@bank.', 'bank.upi')
    const next: InvoiceSettings = {
      prefix, credit_note_prefix: cn, payment_terms_days: terms, default_sac: sac, default_gst_rate: gst, default_tds_pct: tds, default_unit: str(body.default_unit ?? cur.default_unit) || 'Nos',
      bank: { bank_name: str(b.bank_name ?? cur.bank.bank_name), account_name: str(b.account_name ?? cur.bank.account_name), account_number: acct, ifsc, branch: str(b.branch ?? cur.bank.branch), upi },
      signatory_name: str(body.signatory_name ?? cur.signatory_name), signatory_title: str(body.signatory_title ?? cur.signatory_title), lut_number: str(body.lut_number ?? cur.lut_number),
      default_notes: str(body.default_notes ?? cur.default_notes), default_terms: typeof body.default_terms === 'string' ? body.default_terms.trim() : cur.default_terms,
      updated_at: nowISO(), updated_by: ctx.user.id,
    }
    const t = tenantRow(ctx)
    t.invoicing = next
    // keep the org profile's masked account + bank in step (shown on Setup → Organisation)
    if (t.org) {
      t.org.bank_name = next.bank.bank_name
      t.org.ifsc = next.bank.ifsc
      if (acct) t.org.bank_account_masked = mask(acct)
    }
    persist()
    logActivity(ctx, 'tenant', t.id, 'invoice.settings', `Invoice settings updated (series ${prefix}, bank ${next.bank.bank_name || '—'} ${acct ? '••' + acct.slice(-4) : ''})`)
    return settingsFor(ctx)
  })
  r.get('/finance/invoices/next-number', ({ ctx, query }) => {
    requireAction(ctx, 'finance.view', VIEW)
    const date = DATE_RE.test(String(query.date ?? '')) ? String(query.date) : ctx.today
    return { number: nextInvoiceNumber(ctx, date) }
  })
  r.get('/finance/invoices/prefill', ({ ctx, query }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const pid = str(query.project_id)
    if (!pid) err(422, 'VALIDATION', 'Choose a project.', 'project_id')
    const mids = str(query.milestone_ids).split(',').map((x) => x.trim()).filter(Boolean)
    return prefill(ctx, pid, mids)
  })
  r.get('/finance/invoices/project-milestones', ({ ctx, query }) => {
    requireAction(ctx, 'finance.view', VIEW)
    const p = find(ctx, 'projects', str(query.project_id), 'Project')
    return prefillMilestones(ctx, p, str(query.invoice_id) || undefined)
  })
  r.get('/finance/invoices/client-party', ({ ctx, query }) => {
    requireAction(ctx, 'finance.view', VIEW)
    const c = find(ctx, 'clients', str(query.client_id), 'Client') as unknown as ClientGst
    return { party: clientParty(c), payment_terms_days: c.payment_terms_days ?? invoiceSettings(ctx).payment_terms_days }
  })
  r.get('/finance/invoices/billable-hours', ({ ctx, query }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    return billableHours(ctx, str(query.project_id), str(query.from), str(query.to), str(query.invoice_id) || undefined)
  })
  r.post('/finance/invoices/preview', ({ ctx, body }) => {
    requireAction(ctx, 'finance.view', VIEW)
    const v = normalise(body)
    const selfId = str(body.id) || undefined
    const mode = taxModeOf(v.seller.state_code, v.place_of_supply, v.bill_to.country)
    const totals = computeTotals(v.lines, mode, v.reverse_charge)
    return { totals, issues: validateInput(ctx, v, { issuing: true, selfId }), next_number: nextInvoiceNumber(ctx, DATE_RE.test(v.invoiced_on) ? v.invoiced_on : ctx.today) }
  })
  r.get('/finance/invoices/:id', ({ ctx, params }) => {
    requireAction(ctx, 'finance.view', VIEW)
    return invoiceDetail(ctx, params.id)
  })
  r.post('/finance/invoices', ({ ctx, body }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const v = normalise(body)
    const issuing = !!body.issue
    const issues = validateInput(ctx, v, { issuing })
    if (issues.length) fail(issues)
    if (body.save_client) saveClientBack(ctx, v)
    const no = nextDraftNo(ctx)
    let inv = insert(ctx, 'invoices', { number: `DRAFT-${no}`, draft_no: no, status: 'draft', amount_paise: 0, paid_amount_paise: 0, paid_on: null, milestone_id: '', file_id: null, emails: [], received_paise: 0, tds_received_paise: 0, ...draftFields(v) } as never) as E.Invoice
    logActivity(ctx, 'invoice', inv.id, 'created', `Draft ${no} created for ${fmtMoney(inv.total_paise ?? 0)}`)
    if (issuing) inv = issueInvoice(ctx, inv, v.number)
    return invoiceDetail(ctx, inv.id)
  })
  r.patch('/finance/invoices/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const inv = find(ctx, 'invoices', params.id, 'Invoice')
    if (inv.status === 'cancelled') err(409, 'INV_LOCKED', 'This invoice is cancelled and can’t be changed.')
    if (inv.status !== 'draft') {
      // issued invoices are locked: notes only
      const extra = Object.keys(body).filter((k) => !['notes', 'id'].includes(k))
      if (extra.length) err(409, 'INV_LOCKED', 'An issued invoice is locked except its notes. Cancel it (with a reason) and raise a new one to change anything else.')
      const u = update(ctx, 'invoices', inv.id, { notes: str(body.notes) }, ifMatch)
      logActivity(ctx, 'invoice', inv.id, 'notes', 'Notes updated')
      return invoiceDetail(ctx, u.id)
    }
    const v = normalise(body)
    const issuing = !!body.issue
    const issues = validateInput(ctx, v, { issuing, selfId: inv.id })
    if (issues.length) fail(issues)
    if (body.save_client) saveClientBack(ctx, v)
    let u = update(ctx, 'invoices', inv.id, draftFields(v), ifMatch)
    logActivity(ctx, 'invoice', inv.id, 'edited', `Draft ${inv.draft_no ?? ''} saved (${fmtMoney(u.total_paise ?? 0)})`)
    if (issuing) u = issueInvoice(ctx, u, v.number)
    return invoiceDetail(ctx, u.id)
  })
  r.post('/finance/invoices/:id/issue', ({ ctx, params, body }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const inv = find(ctx, 'invoices', params.id, 'Invoice')
    if (inv.status !== 'draft') err(409, 'INV_LOCKED', 'Only a draft can be issued.')
    const v = normalise({ ...(inv as unknown as Record<string, unknown>), number: body.number })
    const issues = validateInput(ctx, v, { issuing: true, selfId: inv.id })
    if (issues.length) fail(issues)
    issueInvoice(ctx, inv, v.number)
    return invoiceDetail(ctx, inv.id)
  })
  r.del('/finance/invoices/:id', ({ ctx, params, ifMatch }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const inv = find(ctx, 'invoices', params.id, 'Invoice')
    if (inv.status !== 'draft') err(409, 'INV_LOCKED', 'Only drafts can be discarded. Cancel an issued invoice instead.')
    remove(ctx, 'invoices', inv.id, ifMatch)
    logActivity(ctx, 'project', inv.project_id, 'invoice.discarded', `Draft invoice ${inv.draft_no ?? ''} discarded`)
    return { ok: true }
  })
  r.post('/finance/invoices/:id/cancel', ({ ctx, params, body }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const inv = ensureGst(ctx, find(ctx, 'invoices', params.id, 'Invoice'))
    if (inv.status === 'draft') err(409, 'INV_LOCKED', 'Drafts aren’t cancelled — discard the draft instead.')
    if (inv.status === 'cancelled') err(409, 'INV_LOCKED', 'This invoice is already cancelled.')
    if (settledOf(inv) > 0) err(409, 'INV_PAID', 'Payments are recorded on this invoice, so it can’t be cancelled.')
    const reason = str(body.reason)
    if (reason.length < 10) err(422, 'VALIDATION', 'Give the reason for cancelling (at least 10 characters).', 'reason')
    const p = find(ctx, 'projects', inv.project_id, 'Project')
    const cnNo = nextCreditNoteNumber(ctx, ctx.today)
    const taxable = inv.taxable_paise ?? inv.amount_paise
    const ids = inv.milestone_ids?.length ? inv.milestone_ids : inv.milestone_id ? [inv.milestone_id] : []
    for (const mid of ids) {
      const m = rows(ctx, 'milestones').find((x) => x.id === mid)
      if (m && m.billing_status !== 'none') update(ctx, 'milestones', m.id, { billing_status: 'none' })
    }
    const orig = rows(ctx, 'ledger_entries').find((l) => l.invoice_id === inv.id && l.amount_paise > 0)
    if (orig) update(ctx, 'ledger_entries', orig.id, { description: `${orig.description} · cancelled by ${cnNo}` })
    insert(ctx, 'ledger_entries', {
      kind: 'income', category: 'Credit note', description: `${cnNo} · cancels ${inv.number} · ${p.name} · ${reason}`, amount_paise: -taxable, date: ctx.today, recurring: false, until_on: null,
      status: 'expected', project_id: p.id, milestone_id: null, invoice_id: inv.id, stream: p.stream, locked: true,
    })
    const u = update(ctx, 'invoices', inv.id, {
      status: 'cancelled', amount_paise: 0, paid_amount_paise: 0, milestone_id: '', cancelled_on: ctx.today, cancel_reason: reason,
      credit_note: { number: cnNo, date: ctx.today, taxable_paise: taxable, total_paise: inv.total_paise ?? taxable },
    })
    logActivity(ctx, 'invoice', inv.id, 'cancelled', `Cancelled ${inv.number} — credit note ${cnNo} for ${fmtMoney(inv.total_paise ?? taxable)}. Reason: ${reason}`)
    logActivity(ctx, 'project', p.id, 'invoice.cancelled', `Invoice ${inv.number} cancelled (${cnNo}): ${reason}`)
    return invoiceDetail(ctx, u.id)
  })
  r.post('/finance/invoices/:id/payments', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'finance.edit', 'Only people who can raise invoices can record payments.')
    const inv = find(ctx, 'invoices', params.id, 'Invoice')
    const res = applyPayment(ctx, inv, {
      received: Math.round(Number(body.received_paise ?? 0)), tds: Math.round(Number(body.tds_paise ?? 0)), paid_on: str(body.paid_on), reference: str(body.reference), mode: str(body.mode) || 'Bank transfer',
    }, ifMatch)
    return { ...res, detail: invoiceDetail(ctx, inv.id) }
  })
  r.post('/finance/invoices/:id/email', ({ ctx, params, body }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const inv = ensureGst(ctx, find(ctx, 'invoices', params.id, 'Invoice'))
    if (!isLive(inv)) err(409, 'INV_NOT_ISSUED', inv.status === 'draft' ? 'Issue the invoice before emailing it.' : 'A cancelled invoice can’t be emailed.')
    const to = str(body.to)
    if (!EMAIL_RE.test(to)) err(422, 'VALIDATION', 'Enter the client’s email address.', 'to')
    const cc = str(body.cc)
      .split(/[,;\s]+/)
      .filter(Boolean)
    const badCc = cc.find((x) => !EMAIL_RE.test(x))
    if (badCc) err(422, 'VALIDATION', `${badCc} is not a valid email address.`, 'cc')
    const subject = str(body.subject) || `Tax invoice ${inv.number} from ${inv.seller?.name ?? ''}`
    const message = str(body.message)
    if (message.length < 5) err(422, 'VALIDATION', 'Write a short message to go with the invoice.', 'message')
    const file = `${inv.number.replace(/[^\w-]+/g, '-')}.pdf`
    const bal = balanceOf(inv)
    const bodyText = [
      message, '', `Invoice: ${inv.number} dated ${inv.invoiced_on}`, `Amount: ${fmtMoney(inv.total_paise ?? 0, { decimals: true })} (incl. GST)`, `Balance due: ${fmtMoney(bal, { decimals: true })} by ${inv.due_on}`,
      inv.bank ? `Bank: ${inv.bank.bank_name}, A/c ${inv.bank.account_number}, IFSC ${inv.bank.ifsc}` : '', '', `Attachment: ${file} (tax invoice PDF)`, cc.length ? `Cc: ${cc.join(', ')}` : '',
    ].filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n')
    const msg = insert(ctx, 'email_outbox', {
      to, to_user_id: null, subject, body: bodyText, template_key: 'invoice', related_entity: 'invoice', related_id: inv.id, status: 'sent', sent_at: nowISO(),
    } as never) as { id: string }
    const u = update(ctx, 'invoices', inv.id, { emails: [...(inv.emails ?? []), { to, at: nowISO(), by: ctx.user.id, outbox_id: msg.id }] })
    logActivity(ctx, 'invoice', inv.id, 'emailed', `Emailed to ${to}${cc.length ? ` (cc ${cc.join(', ')})` : ''} with ${file}`)
    return { ok: true, outbox_id: msg.id, detail: invoiceDetail(ctx, u.id) }
  })
  r.post('/finance/invoices/:id/duplicate', ({ ctx, params }) => {
    requireAction(ctx, 'finance.edit', EDIT)
    const src = ensureGst(ctx, find(ctx, 'invoices', params.id, 'Invoice'))
    const s = invoiceSettings(ctx)
    const terms = Math.max(0, diffDays(src.due_on, src.invoiced_on))
    const no = nextDraftNo(ctx)
    // milestones are billed once: the copy keeps the lines as plain items, unlinked from milestones
    const lines = (src.lines ?? []).map((l, i) => ({ ...l, id: `l${i + 1}`, source: { kind: 'manual' as const } }))
    const v = normalise({ ...(src as unknown as Record<string, unknown>), lines, milestone_ids: [], invoiced_on: ctx.today, due_on: addDays(ctx.today, terms || s.payment_terms_days) })
    const inv = insert(ctx, 'invoices', { number: `DRAFT-${no}`, draft_no: no, status: 'draft', amount_paise: 0, paid_amount_paise: 0, paid_on: null, milestone_id: '', file_id: null, emails: [], received_paise: 0, tds_received_paise: 0, duplicated_from: src.id, ...draftFields(v) } as never) as E.Invoice
    logActivity(ctx, 'invoice', inv.id, 'created', `Draft ${no} duplicated from ${src.status === 'draft' ? `draft ${src.draft_no}` : src.number}`)
    return invoiceDetail(ctx, inv.id)
  })
}
