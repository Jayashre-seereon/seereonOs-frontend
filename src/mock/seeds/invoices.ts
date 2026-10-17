// v7 GST invoices seed (owner: invoices workstream). Runs after every other seed:
// • gives each demo client a full GST billing address (state + GST state code, city, PIN, PAN),
// • stores the tenants' invoicing settings (series prefix, full bank account for invoices, signatory, LUT),
// • migrates the seeded milestone invoices to complete GST tax invoices: seller from the org profile, bill-to from the
//   client master, a line per milestone (SAC 998314, 18% GST — CGST+SGST inside Odisha, IGST across states, zero-rated
//   export under LUT for overseas clients), numbers in the per-FY series (SCI/25-26/0001…, SCI/26-27/0001…), and
//   payments split into cash received + TDS deducted. Revenue (amount_paise, ledger income) stays the taxable value.
// • adds one draft (a change-request invoice) so the register shows the draft state.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type { InvoiceLine, InvoiceParty, InvoiceSettings } from '@/types/v7'
import type { SeedHelpers } from './index'
import { addDays, fyStartYear } from '@/domain/calendar'
import { EXPORT_CODE, clientParty, computeTotals, defaultInvoiceSettings, stateName, taxModeOf, type ClientGst } from '../routes/invoices'

type Addr = { address: string; city: string; state: string; state_code: string; pincode: string; gstin?: string; pan?: string }
const SEEREON_CLIENTS: Record<string, Addr> = {
  cl_rcu: { address: 'Royal Commission for AlUla, Al Ula 43544, Madinah Province', city: 'AlUla', state: 'Madinah Province', state_code: EXPORT_CODE, pincode: '' },
  cl_mgs: { address: 'Plot 12, Nayapalli, near CRP Square', city: 'Bhubaneswar', state: 'Odisha', state_code: '21', pincode: '751012', gstin: '21AAETM4455R1ZB' },
  cl_dr: { address: '3rd floor, Esplanade One, Rasulgarh', city: 'Bhubaneswar', state: 'Odisha', state_code: '21', pincode: '751010', gstin: '21AAHCD7788P1ZQ' },
  cl_zoo: { address: 'Sonnenstraße 15, 80331', city: 'Munich', state: 'Bavaria', state_code: EXPORT_CODE, pincode: '' },
  cl_mmg: { address: 'Mines Office, Joda–Barbil Road', city: 'Keonjhar', state: 'Odisha', state_code: '21', pincode: '758034', gstin: '21AABCM1122H1Z7' },
  cl_sem: { address: '200 Flynn Road, CA 93012', city: 'Camarillo', state: 'California', state_code: EXPORT_CODE, pincode: '' },
  cl_utkal: { address: 'Plot 45, Jagatpur Industrial Estate', city: 'Cuttack', state: 'Odisha', state_code: '21', pincode: '754021', gstin: '21AACCU3344D1Z2' },
  cl_samet: { address: 'SAMET campus, Patrapada', city: 'Bhubaneswar', state: 'Odisha', state_code: '21', pincode: '751019', gstin: '21AAETS6120K1Z4' },
  cl_infy: { address: 'Electronics City, Hosur Road', city: 'Bengaluru', state: 'Karnataka', state_code: '29', pincode: '560100', gstin: '29AABCI1681G1ZF' },
  cl_k_hosp: { address: 'Kalinga Nagar, Ghatikia', city: 'Bhubaneswar', state: 'Odisha', state_code: '21', pincode: '751003', gstin: '21AAATK7781H1Z9' },
}

function sellerOf(t: E.Tenant): InvoiceParty {
  const o = t.org
  const code = o?.gstin ? o.gstin.slice(0, 2) : o?.state === 'Odisha' ? '21' : ''
  return {
    name: o?.legal_name || t.name, address: o?.registered_address || '', city: o?.city ?? '', state: o?.state || stateName(code), state_code: code, pincode: o?.pincode ?? '', country: o?.country || 'India',
    gstin: o?.gstin ?? '', pan: o?.pan ?? '', email: o?.email ?? '', phone: o?.phone ?? '', contact: '', cin: o?.cin ?? '', website: o?.website ?? '',
  }
}
function settingsOf(t: E.Tenant): InvoiceSettings {
  const d = defaultInvoiceSettings(t)
  if (t.slug !== 'seereon') return d
  return {
    ...d,
    prefix: 'SCI',
    bank: { bank_name: 'HDFC Bank', account_name: 'Seereon Consulting & IT Services Pvt. Ltd.', account_number: '50200071824821', ifsc: 'HDFC0001827', branch: 'Khandagiri, Bhubaneswar', upi: 'seereon@hdfcbank' },
    signatory_name: 'Santosh Kumar Nayak',
    signatory_title: 'Director',
    lut_number: 'AD2104260048213',
  }
}

export function seed(db: DB, h: SeedHelpers) {
  // 1 — client billing addresses
  for (const c of db.clients as unknown as ClientGst[]) {
    const a = SEEREON_CLIENTS[c.id]
    if (!a) continue
    Object.assign(c, { billing_address: a.address, city: a.city, state: a.state, state_code: a.state_code, pincode: a.pincode, gstin: a.gstin ?? '', pan: a.pan ?? (a.gstin ? a.gstin.slice(2, 12) : '') })
  }

  for (const t of db.tenants) {
    // 2 — invoicing settings
    const s = settingsOf(t)
    t.invoicing = s
    if (t.org && s.bank.account_number) t.org.bank_account_masked = s.bank.account_number.replace(/\d(?=\d{4})/g, 'X')
    const seller = sellerOf(t)
    const fm = t.settings['company.fy_start_month'] ?? 4
    const fyOf = (d: string) => {
      const y = fyStartYear(d, fm)
      return `${String(y % 100).padStart(2, '0')}-${String((y + 1) % 100).padStart(2, '0')}`
    }
    const clients = (db.clients as unknown as ClientGst[]).filter((c) => c.tenant_id === t.id)
    const clientOf = (p: E.Project) => clients.find((c) => c.name.trim().toLowerCase() === p.client.trim().toLowerCase()) ?? null
    const counters = new Map<string, number>()
    const nextNo = (date: string) => {
      const fy = fyOf(date)
      const n = (counters.get(fy) ?? 0) + 1
      counters.set(fy, n)
      return `${s.prefix}/${fy}/${String(n).padStart(4, '0')}`
    }

    // 3 — migrate the seeded milestone invoices
    const invs = db.invoices.filter((i) => i.tenant_id === t.id).sort((a, b) => a.invoiced_on.localeCompare(b.invoiced_on) || a.number.localeCompare(b.number))
    for (const inv of invs) {
      const p = db.projects.find((x) => x.id === inv.project_id)
      const m = db.milestones.find((x) => x.id === inv.milestone_id)
      if (!p) continue
      const client = clientOf(p)
      const bill = clientParty(client, p.client)
      const pos = bill.state_code || seller.state_code
      const mode = taxModeOf(seller.state_code, pos, bill.country)
      const lines: InvoiceLine[] = [{
        id: 'l1', item: m ? `M${m.no} ${m.name}` : p.name, description: `${p.name} — milestone ${m?.no ?? ''}`.trim(), hsn_sac: s.default_sac, qty: 1, unit: 'Lot', rate_paise: inv.amount_paise,
        discount_pct: 0, gst_rate: mode === 'export' ? 0 : s.default_gst_rate, source: m ? { kind: 'milestone', milestone_id: m.id } : { kind: 'manual' },
      }]
      const tot = computeTotals(lines, mode)
      const oldNo = inv.number
      const number = nextNo(inv.invoiced_on)
      const tdsPct = mode === 'export' ? 0 : s.default_tds_pct
      // payments: the seeded rows hold the revenue share; split into cash received + TDS against the GST total
      const pays = db.payments.filter((x) => x.invoice_id === inv.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on))
      let received = 0, tds = 0, share = 0
      pays.forEach((pay, idx) => {
        share += pay.amount_paise
        const full = share >= inv.amount_paise && idx === pays.length - 1
        const settle = full ? tot.total - received - tds : Math.round((pay.amount_paise * tot.total) / Math.max(1, tot.taxable))
        const tdsHere = Math.round((pay.amount_paise * tdsPct) / 100)
        pay.tds_paise = tdsHere
        pay.gross_paise = settle - tdsHere
        pay.mode = pay.reference.startsWith('UPI') ? 'UPI' : 'NEFT'
        received += pay.gross_paise
        tds += tdsHere
      })
      const paid = inv.paid_amount_paise >= inv.amount_paise && inv.amount_paise > 0
      Object.assign(inv, {
        number, status: paid ? 'paid' : inv.paid_amount_paise > 0 ? 'partially_paid' : 'issued', client_id: client?.id ?? null, milestone_ids: m ? [m.id] : [], seller, bill_to: bill, ship_to: null,
        place_of_supply: pos, tax_mode: mode, reverse_charge: false, lines, subtotal_paise: tot.subtotal, discount_paise: tot.discount, taxable_paise: tot.taxable, cgst_paise: tot.cgst, sgst_paise: tot.sgst,
        igst_paise: tot.igst, round_off_paise: tot.round_off, total_paise: tot.total, received_paise: received, tds_received_paise: tds, tds_pct: tdsPct,
        bank: { ...s.bank }, notes: mode === 'export' ? `Supply meant for export under LUT ${s.lut_number || ''} without payment of IGST.`.replace('  ', ' ') : s.default_notes, terms: s.default_terms,
        po_reference: null, po_date: null, signatory: { name: s.signatory_name, title: s.signatory_title }, issued_on: inv.invoiced_on, issued_by: p.pm_id, emails: [],
      } satisfies Partial<E.Invoice>)
      for (const le of db.ledger_entries) if (le.invoice_id === inv.id) le.description = le.description.replace(oldNo, number)
    }

    // 4 — one draft: a change-request invoice on the Digitalratha CRM project
    const crm = db.projects.find((p) => p.tenant_id === t.id && p.id === 'p_crm')
    if (crm) {
      const client = clientOf(crm)
      const bill = clientParty(client, crm.client)
      const mode = taxModeOf(seller.state_code, bill.state_code || seller.state_code, bill.country)
      const lines: InvoiceLine[] = [
        { id: 'l1', item: 'CR-1 WhatsApp follow-up reminders', description: 'Change request approved by Deepak (CEO): automated WhatsApp reminders for overdue follow-ups', hsn_sac: s.default_sac, qty: 24, unit: 'Hrs', rate_paise: 180000, discount_pct: 0, gst_rate: 18, source: { kind: 'manual' } },
        { id: 'l2', item: 'Field-sales training session', description: 'Half-day on-site training for 12 sales executives', hsn_sac: '999293', qty: 1, unit: 'Nos', rate_paise: 1500000, discount_pct: 10, gst_rate: 18, source: { kind: 'manual' } },
      ]
      const tot = computeTotals(lines, mode)
      db.invoices.push({
        ...h.base(t.id), id: 'inv_draft_crm_cr1', project_id: crm.id, milestone_id: '', number: 'DRAFT-1', draft_no: 1, invoiced_on: h.today, amount_paise: 0, paid_amount_paise: 0, paid_on: null,
        due_on: addDays(h.today, client?.payment_terms_days ?? 15), file_id: null, status: 'draft', client_id: client?.id ?? null, milestone_ids: [], seller, bill_to: bill, ship_to: null,
        place_of_supply: bill.state_code || seller.state_code, tax_mode: mode, reverse_charge: false, lines, subtotal_paise: tot.subtotal, discount_paise: tot.discount, taxable_paise: tot.taxable,
        cgst_paise: tot.cgst, sgst_paise: tot.sgst, igst_paise: tot.igst, round_off_paise: tot.round_off, total_paise: tot.total, received_paise: 0, tds_received_paise: 0, tds_pct: s.default_tds_pct,
        bank: { ...s.bank }, notes: s.default_notes, terms: s.default_terms, po_reference: 'Sales CRM phase 2 — statement of work', po_date: null, signatory: { name: s.signatory_name, title: s.signatory_title }, emails: [],
      })
    }
  }
}
