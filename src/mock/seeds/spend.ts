// Spend & commercial demo data: expense claims, vendors, POs and bills, FY budgets, manual revenue
// leakage, clients and contracts. Dates are relative to today so the demo always looks current.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type * as B from '@/types/business'
import type { SeedHelpers } from './index'
import { addDays, fyStartYear } from '@/domain/calendar'
import { EXPENSE_CATEGORY } from '@/modules/spend/labels'

const R = (rupees: number) => Math.round(rupees * 100)
const L = (lakh: number) => Math.round(lakh * 1_00_000 * 100)

export function seed(db: DB, h: SeedHelpers) {
  const today = h.today
  const T1 = 'tn_seereon'
  const T2 = 'tn_kalinga'
  const at = (d: string, hh = 6) => `${d}T${String(hh).padStart(2, '0')}:30:00Z`
  const user = (k: string) => `u_${k}`
  const proj = (k: string) => db.projects.find((p) => p.id === k)
  const fileFor = (tenant: string, name: string, entity: string, entity_id: string, mime = 'application/pdf') => {
    const f = { ...h.base(tenant), id: h.id('file'), name, mime, size_bytes: 48_000 + Math.floor(h.rnd() * 160_000), entity, entity_id, data_url: null } as E.FileRef
    db.files.push(f)
    return f.id
  }
  const ledger = (tenant: string, category: string, description: string, amount: number, date: string, project_id: string | null = null) => {
    const p = project_id ? proj(project_id) : null
    const le: E.LedgerEntry = { ...h.base(tenant), id: h.id('le'), kind: 'expense', category, description, amount_paise: amount, date, recurring: false, until_on: null, status: 'paid', project_id, milestone_id: null, invoice_id: null, stream: p?.stream ?? null, locked: true }
    db.ledger_entries.push(le)
    return le.id
  }
  const log = (tenant: string, entity: string, entity_id: string, action: string, summary: string, actor: string, when: string) =>
    db.activity_log.push({ ...h.base(tenant), entity, entity_id, action, summary, actor_id: actor, at: when } as E.ActivityLog)

  /* ================= Expense claims (Seereon) ================= */
  type EX = { who: string; cat: B.ExpenseClaim['category']; desc: string; amt: number; d: number; status: B.ExpenseStatus; project?: string; billable?: boolean; receipt?: boolean; approver?: string; first?: string; reason?: string; inBudget?: boolean; paidAfter?: number }
  const claims: EX[] = [
    { who: 'subhankar', cat: 'travel', desc: 'Travel to client site, Keonjhar — Mahanadi Minerals payroll workshop (car hire, 2 days)', amt: 6850, d: -20, status: 'paid', project: 'p_hrms', billable: true, approver: 'santosh', paidAfter: 6 },
    { who: 'subhankar', cat: 'lodging', desc: 'Hotel, Keonjhar — 2 nights during client workshop', amt: 4200, d: -19, status: 'paid', project: 'p_hrms', billable: true, approver: 'santosh', paidAfter: 5, inBudget: false },
    { who: 'baishali', cat: 'client_entertainment', desc: 'BNI meeting lunch — follow-up with Mother’s Group of Schools CFO', amt: 1850, d: -12, status: 'approved', approver: 'santosh' },
    { who: 'santosh', cat: 'software', desc: 'AWS invoice reimbursement — Sep hosting paid on personal card', amt: 18640, d: -9, status: 'approved', approver: 'santosh', inBudget: false },
    { who: 'hritesh', cat: 'training', desc: 'Udemy course — Advanced React patterns', amt: 649, d: -15, status: 'paid', approver: 'subhankar', paidAfter: 4 },
    { who: 'jagannath', cat: 'training', desc: 'Udemy course — FastAPI and SQLAlchemy masterclass', amt: 549, d: -6, status: 'submitted', approver: 'subhankar' },
    { who: 'jayashree', cat: 'food', desc: 'Working dinner during MGS go-live weekend (3 people)', amt: 1240, d: -4, status: 'submitted', project: 'p_mgs', approver: 'subhankar' },
    { who: 'pragyasmita', cat: 'travel', desc: 'Cab to MGS campus 2 for teacher training', amt: 780, d: -3, status: 'submitted', project: 'p_mgs', billable: true, approver: 'subhankar' },
    { who: 'subham', cat: 'travel', desc: 'Fuel — BNI chapter meetings and site visits (4 trips)', amt: 1600, d: -10, status: 'approved', approver: 'santosh' },
    { who: 'subham', cat: 'client_entertainment', desc: 'Coffee meeting with Radha Govind Homes', amt: 640, d: -2, status: 'draft' },
    { who: 'bijaya', cat: 'hardware', desc: 'USB-C docking station for dev laptop', amt: 3499, d: -25, status: 'rejected', approver: 'subhankar', reason: 'Raise this as an asset request — IT buys docks centrally.' },
    { who: 'priya', cat: 'office', desc: 'Printer cartridges and stationery for the office', amt: 2150, d: -8, status: 'paid', approver: 'santosh', paidAfter: 2 },
    { who: 'hritesh', cat: 'travel', desc: 'Onsite at Keonjhar mine for payroll parallel run (5 days, train + stay)', amt: 27500, d: -7, status: 'submitted', project: 'p_hrms', billable: true, approver: 'santosh', first: 'subhankar' },
    { who: 'hritesh', cat: 'internet_phone', desc: 'Broadband — September (work from home)', amt: 999, d: -14, status: 'paid', approver: 'subhankar', paidAfter: 3 },
    { who: 'hritesh', cat: 'internet_phone', desc: 'Home broadband bill', amt: 999, d: -14, status: 'submitted', approver: 'subhankar' },
    { who: 'baishali', cat: 'travel', desc: 'Cab to Digitalratha office for phase 2 demo', amt: 420, d: -18, status: 'paid', project: 'p_crm', billable: true, approver: 'subhankar', paidAfter: 4 },
    { who: 'subhankar', cat: 'client_entertainment', desc: 'Lunch with MGS principal after campus 1 go-live', amt: 3600, d: -1, status: 'submitted', project: 'p_mgs', approver: 'santosh' },
    { who: 'santosh', cat: 'travel', desc: 'Flight Bhubaneswar–Mumbai for Semtech RAP workshop', amt: 14800, d: -33, status: 'paid', approver: 'santosh', paidAfter: 3 },
  ]
  for (const c of claims) {
    const spent = addDays(today, c.d)
    const id = h.id('exp')
    const needsReceipt = c.amt > 500 || c.receipt
    const decided = c.status === 'approved' || c.status === 'paid' || c.status === 'rejected'
    const row = {
      ...h.base(T1), id, created_by: user(c.who), created_at: at(spent, 9), user_id: user(c.who), project_id: c.project ?? null, category: c.cat, description: c.desc, amount_paise: R(c.amt), spent_on: spent,
      receipt_file_id: needsReceipt ? fileFor(T1, `receipt-${c.cat}-${spent}.pdf`, 'expense', id) : null, billable_to_client: !!c.billable, status: c.status,
      approver_id: c.status === 'draft' ? null : user(c.approver ?? 'santosh'), decided_by: decided ? user(c.approver ?? 'santosh') : null, decided_at: decided ? at(addDays(spent, 1), 8) : null,
      decision_reason: c.reason ?? null, paid_on: c.status === 'paid' ? addDays(spent, c.paidAfter ?? 3) : null, ledger_entry_id: null as string | null,
      in_budget: c.status === 'approved' || c.status === 'paid' ? c.inBudget ?? true : null, first_approved_by: c.first ? user(c.first) : null, submitted_at: c.status === 'draft' ? null : at(spent, 10),
    }
    if (row.paid_on && row.paid_on > today) row.paid_on = today
    if (c.status === 'paid') row.ledger_entry_id = ledger(T1, EXPENSE_CATEGORY[c.cat], `Expense claim · ${db.users.find((u) => u.id === user(c.who))?.name} · ${c.desc}${c.billable ? ' (re-bill to client)' : ''}`, R(c.amt), row.paid_on!, c.project ?? null)
    db.expense_claims.push(row as B.ExpenseClaim)
    log(T1, 'expense', id, 'submitted', `Submitted ₹${c.amt.toLocaleString('en-IN')} · ${c.desc}`, user(c.who), at(spent, 10))
    if (c.first) log(T1, 'expense', id, 'approved_step1', `Approved by ${db.users.find((u) => u.id === user(c.first!))?.name}; sent to Santosh Nayak (above ₹25,000)`, user(c.first), at(addDays(spent, 1), 7))
    if (decided) log(T1, 'expense', id, c.status === 'rejected' ? 'rejected' : 'approved', c.status === 'rejected' ? `Rejected — ${c.reason}` : `Approved ₹${c.amt.toLocaleString('en-IN')}`, user(c.approver ?? 'santosh'), at(addDays(spent, 1), 8))
    if (c.status === 'paid') log(T1, 'expense', id, 'paid', `Reimbursed ₹${c.amt.toLocaleString('en-IN')}`, user('priya'), at(row.paid_on!, 11))
  }
  // Kalinga: 2 claims
  const kc: [string, B.ExpenseClaim['category'], string, number, number, B.ExpenseStatus, string | null][] = [
    ['u_k_sneha', 'travel', 'Auto to Kalinga Hospital for requirement walkthrough', 340, -2, 'submitted', 'u_k_rakesh'],
    ['u_k_meera', 'client_entertainment', 'Lunch with Sparsh Clinics IT head', 1450, -3, 'approved', 'u_k_ananya'],
  ]
  for (const [who, cat, desc, amt, d, status, approver] of kc) {
    const id = h.id('exp')
    db.expense_claims.push({
      ...h.base(T2), id, created_by: who, user_id: who, project_id: cat === 'travel' ? 'p_k_1' : null, category: cat, description: desc, amount_paise: R(amt), spent_on: addDays(today, d),
      receipt_file_id: amt > 500 ? fileFor(T2, `receipt-${addDays(today, d)}.jpg`, 'expense', id, 'image/jpeg') : null, billable_to_client: false, status, approver_id: approver,
      decided_by: status === 'approved' ? approver : null, decided_at: status === 'approved' ? at(addDays(today, d + 1)) : null, decision_reason: null, paid_on: null, ledger_entry_id: null, in_budget: status === 'approved' ? true : null,
    })
  }

  /* ================= Vendors, POs, bills (Seereon) ================= */
  const V = (key: string, name: string, category: string, gstin: string, contact: string, email: string, terms: number): B.Vendor => {
    const v: B.Vendor = { ...h.base(T1), id: `v_${key}`, name, category, gstin, pan: gstin ? gstin.slice(2, 12) : '', contact, email, phone: '+91 9' + String(Math.floor(100000000 + h.rnd() * 899999999)), payment_terms_days: terms, status: 'active' }
    db.vendors.push(v)
    return v
  }
  V('dell', 'Dell International Services India', 'Equipment', '29AAACD5634K1ZK', 'Corporate sales — East', 'b2b.east@dell.example.in', 30)
  V('aws', 'Amazon Web Services India', 'Tools & software', '29AAJCA5478B1ZQ', 'AWS billing', 'aws-billing@amazon.example.in', 15)
  V('gws', 'Shivani Cloud Solutions (Google Workspace partner)', 'Tools & software', '21AAQFS5678K1Z9', 'Shivani Das', 'accounts@shivanicloud.example.in', 30)
  V('stationery', 'Kalinga Stationery Mart', 'Office supplies', '21ABHPK4321L1Z3', 'Prakash Kar', 'kalingastationery@example.in', 15)
  V('ca', 'Mohanty & Associates, Chartered Accountants', 'Professional fees', '21AAKFM9876Q1ZP', 'CA Ritesh Mohanty', 'ritesh@mohantyassociates.example.in', 30)
  V('landlord', 'Khandagiri Business Centre', 'Rent', '21AAGCK2468M1Z4', 'Office manager', 'rent@kbc.example.in', 7)

  const fy = fyStartYear(today, 4)
  const fyTag = `${String(fy % 100).padStart(2, '0')}-${String((fy + 1) % 100).padStart(2, '0')}`
  type POS = { key: string; vendor: string; title: string; lines: B.POLine[]; gst: number; cat: string; project?: string; status: B.PurchaseOrder['status']; d: number; needed?: number; over?: boolean; just?: string; by?: string }
  const pos: POS[] = [
    { key: 'po1', vendor: 'dell', title: 'Laptops for new QA and Flutter joiners', lines: [{ description: 'Dell Latitude 5450, i7, 16 GB, 512 GB SSD', qty: 2, rate_paise: R(78500) }, { description: 'Dell 3-year ProSupport', qty: 2, rate_paise: R(6200) }], gst: 18, cat: 'Equipment', status: 'closed', d: -32, over: true, just: 'Two new hires join this month; laptops were not in the original equipment budget.', by: 'priya' },
    { key: 'po2', vendor: 'aws', title: 'AWS hosting Q3 — EduReon and SeerHR', lines: [{ description: 'AWS compute, RDS and S3 — Q3 commitment', qty: 1, rate_paise: R(45000) }], gst: 18, cat: 'Tools & software', status: 'approved', d: -40, by: 'priya' },
    { key: 'po3', vendor: 'gws', title: 'Google Workspace renewal — 12 seats × 12 months', lines: [{ description: 'Google Workspace Business Standard (seat-month)', qty: 144, rate_paise: R(136) }], gst: 18, cat: 'Tools & software', status: 'closed', d: -60, by: 'priya' },
    { key: 'po4', vendor: 'ca', title: 'Statutory audit FY25-26 and GST filings', lines: [{ description: 'Statutory audit FY25-26', qty: 1, rate_paise: R(45000) }, { description: 'Monthly GST return filing', qty: 6, rate_paise: R(2500) }], gst: 18, cat: 'Professional fees', status: 'approved', d: -28, by: 'priya' },
    { key: 'po5', vendor: 'stationery', title: 'Office stationery and pantry — quarterly', lines: [{ description: 'Stationery kit', qty: 10, rate_paise: R(450) }, { description: 'Pantry supplies', qty: 1, rate_paise: R(3800) }], gst: 12, cat: 'Office supplies', status: 'approved', d: -18, by: 'priya' },
    { key: 'po6', vendor: 'dell', title: 'External monitors for the delivery team', lines: [{ description: 'Dell P2425H 24" monitor', qty: 4, rate_paise: R(14200) }], gst: 18, cat: 'Equipment', status: 'pending', d: -2, needed: 12, over: true, just: 'Developers on dual-screen setups close tickets faster; monitors were deferred from last quarter.', by: 'priya' },
  ]
  const PO: Record<string, B.PurchaseOrder> = {}
  pos.forEach((p, i) => {
    const amount = p.lines.reduce((a, l) => a + Math.round(l.qty * l.rate_paise), 0)
    const created = addDays(today, p.d)
    const decided = p.status !== 'pending' && p.status !== 'draft'
    const row = {
      ...h.base(T1), id: `po_${p.key}`, created_by: user(p.by ?? 'priya'), created_at: at(created), number: `PO/${fyTag}/${String(i + 1).padStart(4, '0')}`, vendor_id: `v_${p.vendor}`, project_id: p.project ?? null,
      budget_category: p.cat, lines: p.lines, amount_paise: amount, gst_pct: p.gst, status: p.status, requested_by: user(p.by ?? 'priya'), approver_id: user('santosh'),
      decided_by: decided ? user('santosh') : null, decided_at: decided ? at(addDays(created, 1), 9) : null, decision_reason: null, needed_by: p.needed !== undefined ? addDays(today, p.needed) : addDays(created, 10),
      title: p.title, over_budget: !!p.over, justification: p.just ?? null, budget_remaining_paise: p.over ? (p.key === 'po6' ? -R(30000) : R(20000)) : null,
    }
    PO[p.key] = row as B.PurchaseOrder
    db.purchase_orders.push(row as B.PurchaseOrder)
    log(T1, 'purchase_order', row.id, 'submitted', `Submitted ${row.number}`, row.requested_by, at(created))
    if (decided) log(T1, 'purchase_order', row.id, 'approved', `Approved ${row.number}`, user('santosh'), at(addDays(created, 1), 9))
  })
  db.number_sequences.push({ tenant_id: T1, scope: `po-${fy}`, next_value: pos.length + 1 })

  type BL = { po?: string; vendor: string; number: string; d: number; amt: number; gstPct: number; tds?: number; status: B.VendorBill['status']; paidAfter?: number; dispute?: string; cat?: string; desc?: string }
  const bills: BL[] = [
    { po: 'po1', vendor: 'dell', number: 'DL/OD/2026/88412', d: -25, amt: PO.po1.amount_paise / 100, gstPct: 18, status: 'paid', paidAfter: 12 },
    { po: 'po2', vendor: 'aws', number: 'EUINAWS26-0931', d: -8, amt: 47100, gstPct: 18, status: 'approved' }, // 4.7% over PO (within tolerance)
    { po: 'po3', vendor: 'gws', number: 'SCS/26-27/0412', d: -55, amt: PO.po3.amount_paise / 100, gstPct: 18, tds: 392, status: 'paid', paidAfter: 20 },
    { po: 'po4', vendor: 'ca', number: 'MA/112/26-27', d: -10, amt: 62000, gstPct: 18, tds: 6200, status: 'disputed', dispute: 'Bill includes ₹2,000 for ROC filing that was not in the PO scope. Asked for a revised invoice.' },
    { po: 'po5', vendor: 'stationery', number: 'KSM-2291', d: -12, amt: 8300, gstPct: 12, status: 'received' },
    { vendor: 'landlord', number: 'KBC/MNT/Q2', d: -40, amt: 13500, gstPct: 18, tds: 1350, status: 'approved', cat: 'Rent', desc: 'Maintenance and DG charges — Q2' },
  ]
  for (const b of bills) {
    const v = db.vendors.find((x) => x.id === `v_${b.vendor}`)!
    const billDate = addDays(today, b.d)
    const id = h.id('bill')
    const amount = R(b.amt)
    const row = {
      ...h.base(T1), id, created_by: user('priya'), vendor_id: v.id, po_id: b.po ? `po_${b.po}` : null, number: b.number, bill_date: billDate, due_on: addDays(billDate, v.payment_terms_days),
      amount_paise: amount, gst_paise: Math.round((amount * b.gstPct) / 100), tds_paise: R(b.tds ?? 0), status: b.status, paid_on: b.status === 'paid' ? addDays(billDate, b.paidAfter ?? 10) : null,
      file_id: fileFor(T1, `${b.number.replace(/\//g, '-')}.pdf`, 'vendor_bill', id), ledger_entry_id: null as string | null, approved_by: b.status === 'approved' || b.status === 'paid' ? user('santosh') : null,
      dispute_reason: b.dispute ?? null, category: b.cat ?? null, description: b.desc ?? '',
    }
    if (row.status === 'paid') {
      const cat = b.cat ?? PO[b.po!]?.budget_category ?? v.category
      row.ledger_entry_id = ledger(T1, cat, `Vendor bill ${b.number} · ${v.name}${b.po ? ' · ' + PO[b.po].number : ''}`, row.amount_paise + row.gst_paise, row.paid_on!)
    }
    db.vendor_bills.push(row as B.VendorBill)
    log(T1, 'vendor_bill', id, 'created', `Recorded bill ${b.number}`, user('priya'), at(billDate))
  }

  /* ================= Budgets FY (Seereon) ================= */
  const months = (lakhPerMonth: number) => Array.from({ length: 12 }, () => L(lakhPerMonth))
  const phased = (lakh: number, monthIdx: number[]) => Array.from({ length: 12 }, (_, i) => (monthIdx.includes(i) ? Math.round(L(lakh) / monthIdx.length) : 0))
  const expenseBudgets: [string, number[], string, string][] = [
    ['Salaries', months(4.2), 'santosh', 'Team of 10 after April increments; new hires from Q3 need a revision.'],
    ['Rent', months(0.46), 'priya', 'Khandagiri office, includes maintenance.'],
    ['Tools & software', months(0.12), 'santosh', 'AWS, GitHub, Google Workspace, Figma.'],
    ['Marketing', months(0.15), 'baishali', 'BNI, LinkedIn ads, events.'],
    ['Utilities', months(0.065), 'priya', ''],
    ['Internet & phone', months(0.02), 'priya', 'WFH broadband support.'],
    ['Travel', months(0.3), 'subhankar', 'Client site visits (Keonjhar, Kolkata) and BNI.'],
    ['Client entertainment', months(0.03), 'santosh', ''],
    ['Training', months(0.02), 'subhankar', 'Courses and certifications.'],
    ['Office supplies', months(0.04), 'priya', ''],
    ['Equipment', phased(1.2, [3]), 'santosh', 'Laptop refresh in July.'],
    ['Compliance', phased(0.5, [4]), 'priya', 'ISO 9001 surveillance audit.'],
    ['Professional fees', months(0.06), 'priya', 'CA retainer, audit, GST filings.'],
  ]
  for (const [category, m, owner, notes] of expenseBudgets) db.budgets.push({ ...h.base(T1), id: h.id('bud'), fy_start_year: fy, kind: 'expense', category, owner_id: user(owner), monthly_paise: m, notes })
  const revenueBudgets: [E.RevenueStream, number, string][] = [
    ['sap_consulting', 7.5, 'santosh'], ['products', 3.2, 'baishali'], ['services', 1.2, 'subhankar'], ['saas', 0.4, 'baishali'], ['ams', 1.2, 'santosh'],
  ]
  for (const [stream, lakh, owner] of revenueBudgets) db.budgets.push({ ...h.base(T1), id: h.id('bud'), fy_start_year: fy, kind: 'revenue', category: stream, owner_id: user(owner), monthly_paise: months(lakh), notes: '' })
  // last FY (a few lines) so "copy last FY" has history
  for (const [category, lakh] of [['Salaries', 3.6], ['Rent', 0.42], ['Tools & software', 0.1], ['Marketing', 0.1], ['Travel', 0.2]] as [string, number][])
    db.budgets.push({ ...h.base(T1), id: h.id('bud'), fy_start_year: fy - 1, kind: 'expense', category, owner_id: user('santosh'), monthly_paise: months(lakh), notes: '' })
  // Kalinga: a light budget
  db.budgets.push({ ...h.base(T2), id: h.id('bud'), fy_start_year: fy, kind: 'expense', category: 'Travel', owner_id: 'u_k_ananya', monthly_paise: months(0.1), notes: '' })

  /* ================= Manual revenue leakage (Seereon) ================= */
  const leak = (kind: B.LeakageKind, amount: number, d: number, client: string, project: string | null, reason: string, status: B.RevenueLeakage['status'], recoverable: boolean, recovered = 0, deal: string | null = null) =>
    db.revenue_leakage.push({ ...h.base(T1), id: h.id('leak'), created_by: user('santosh'), kind, amount_paise: amount, date: addDays(today, d), client, project_id: project, deal_id: deal, reason, recorded_by: user('santosh'), recoverable, status, recovered_paise: recovered, auto: false })
  leak('discount', L(0.45), -86, "Mother's Group of Schools", 'p_mgs', '10% discount on the EduReon licence to close the two-campus deal before the academic year.', 'accepted', false, 0, 'd_mgs')
  leak('write_off', R(12000), -50, 'SAMET School of Management', 'p_samet', 'Wrote off the balance on the admissions portal after the dispute over payment-gateway charges.', 'accepted', false)
  leak('penalty', R(15000), -40, 'Digitalratha', 'p_crm', 'Late UAT penalty under clause 9.2 — phase 2 build slipped one week. Negotiating a waiver.', 'open', true)
  leak('credit_note', R(18000), -25, 'Infosys', null, 'Credit note for 12 disputed support hours on the SAP AMS sub-contract.', 'open', true, R(9000))
  // Kalinga
  db.revenue_leakage.push({ ...h.base(T2), id: h.id('leak'), kind: 'discount', amount_paise: R(25000), date: addDays(today, -3), client: 'Kalinga Hospital', project_id: 'p_k_1', deal_id: null, reason: 'Launch discount for the first hospital customer.', recorded_by: 'u_k_ananya', recoverable: false, status: 'accepted', recovered_paise: 0, auto: false })

  /* ================= Clients & contracts ================= */
  type CL = { key: string; name: string; industry: string; country: string; gstin?: string; contact: string; email: string; owner: string; terms: number; since?: number; address?: string }
  const clients: CL[] = [
    { key: 'rcu', name: 'Royal Commission for AlUla', industry: 'Government', country: 'Saudi Arabia', contact: 'SAP programme manager', email: 'sap.pmo@rcu.example.sa', owner: 'santosh', terms: 45, since: -560, address: 'AlUla, Madinah Province, Saudi Arabia' },
    { key: 'mgs', name: "Mother's Group of Schools", industry: 'Education', country: 'India', gstin: '21AAETM4455R1ZB', contact: 'Aditya Sabat (CFO)', email: 'cfo@mothersgroup.example.in', owner: 'baishali', terms: 30, since: -85, address: 'Bhubaneswar, Odisha' },
    { key: 'dr', name: 'Digitalratha', industry: 'Marketing services', country: 'India', gstin: '21AAHCD7788P1ZQ', contact: 'Deepak (CEO)', email: 'deepak@digitalratha.example.in', owner: 'baishali', terms: 15, since: -240, address: 'Bhubaneswar, Odisha' },
    { key: 'zoo', name: 'ZooPlus Germany', industry: 'E-commerce', country: 'Germany', contact: 'Integration lead', email: 'sap-integration@zooplus.example.de', owner: 'santosh', terms: 30, since: -400, address: 'Munich, Germany' },
    { key: 'mmg', name: 'Mahanadi Minerals Group', industry: 'Mining', country: 'India', gstin: '21AABCM1122H1Z7', contact: 'HR Head', email: 'hr.head@mahanadiminerals.example.in', owner: 'santosh', terms: 30, since: -60, address: 'Keonjhar, Odisha' },
    { key: 'sem', name: 'Semtech Corporation', industry: 'Semiconductors', country: 'USA', contact: 'SAP program manager', email: 'sap.pm@semtech.example.com', owner: 'santosh', terms: 45, since: -330, address: 'Camarillo, California' },
    { key: 'utkal', name: 'Utkal Tubes Ltd', industry: 'Manufacturing', country: 'India', gstin: '21AACCU3344D1Z2', contact: 'IT Manager', email: 'it@utkaltubes.example.in', owner: 'subham', terms: 30, since: -95, address: 'Cuttack, Odisha' },
    { key: 'samet', name: 'SAMET School of Management', industry: 'Education', country: 'India', contact: 'Principal', email: 'principal@samet.example.in', owner: 'baishali', terms: 15, since: -155, address: 'Bhubaneswar, Odisha' },
    { key: 'infy', name: 'Infosys', industry: 'IT services', country: 'India', gstin: '29AABCI1681G1ZF', contact: 'Delivery manager — SAP AMS', email: 'sap.ams@infosys.example.com', owner: 'santosh', terms: 60, since: -360, address: 'Bengaluru, Karnataka' },
  ]
  const CID: Record<string, string> = {}
  for (const c of clients) {
    const id = `cl_${c.key}`
    CID[c.key] = id
    db.clients.push({
      ...h.base(T1), id, name: c.name, industry: c.industry, country: c.country, gstin: c.gstin ?? '', billing_address: c.address ?? '', primary_contact: c.contact, email: c.email,
      phone: '+91 9' + String(Math.floor(100000000 + h.rnd() * 899999999)), owner_id: user(c.owner), status: 'active', since: c.since !== undefined ? addDays(today, c.since) : null, payment_terms_days: c.terms, health: null,
    })
  }
  // remaining deal-only clients are added by the clients route on first load (synced from the pipeline)
  type CT = { client: string; project?: string; title: string; kind: B.Contract['kind']; value: number; start: number; end: number; renewal?: number; auto?: boolean; notes?: string }
  const contracts: CT[] = [
    { client: 'rcu', project: 'p_rcu', title: 'SAP AMS — annual maintenance contract', kind: 'amc', value: 42, start: -320, end: 45, renewal: 30, notes: 'Renewal decision needed 15 days before term end. Scope expansion to SuccessFactors under discussion.' },
    { client: 'rcu', title: 'Mutual NDA', kind: 'nda', value: 0, start: -560, end: 535 },
    { client: 'mgs', project: 'p_mgs', title: 'EduReon perpetual licence and implementation', kind: 'licence', value: 4.5, start: -85, end: 280, auto: false, notes: 'Includes 10% discount; AMC from year 2 at 18% of licence.' },
    { client: 'dr', project: 'p_crm', title: 'Sales CRM phase 2 — statement of work', kind: 'sow', value: 3, start: -30, end: 40 },
    { client: 'dr', title: 'Master services agreement', kind: 'msa', value: 0, start: -240, end: 490 },
    { client: 'zoo', title: 'SAP CPI support retainer', kind: 'retainer', value: 21.6, start: -12, end: 353, auto: true, notes: 'Monthly retainer ₹1.8L; auto-renews unless either side gives 60 days’ notice.' },
    { client: 'mmg', project: 'p_hrms', title: 'SeerHR perpetual licence', kind: 'licence', value: 15, start: -60, end: 305 },
    { client: 'sem', title: 'SAP RAP extensions — SOW 3', kind: 'sow', value: 8, start: -28, end: 52, notes: 'Follow-on SOW for Q4 in draft.' },
    { client: 'infy', title: 'SAP AMS sub-contract', kind: 'retainer', value: 13.2, start: -360, end: 5, auto: true },
  ]
  for (const c of contracts) {
    const id = h.id('ctr')
    db.contracts.push({
      ...h.base(T1), id, client_id: CID[c.client], project_id: c.project ?? null, title: c.title, kind: c.kind, value_paise: L(c.value), start_on: addDays(today, c.start), end_on: addDays(today, c.end),
      renewal_on: c.kind === 'nda' ? null : addDays(today, c.renewal ?? c.end), auto_renew: !!c.auto, status: 'active', file_id: fileFor(T1, `${c.title.replace(/[^A-Za-z0-9]+/g, '-')}.pdf`, 'contract', id), notes: c.notes ?? '',
    })
  }
  // Kalinga: 2 clients
  db.clients.push(
    { ...h.base(T2), id: 'cl_k_hosp', name: 'Kalinga Hospital', industry: 'Healthcare', country: 'India', gstin: '', billing_address: 'Bhubaneswar, Odisha', primary_contact: 'Hospital administrator', email: 'admin@kalingahospital.example.in', phone: '', owner_id: 'u_k_ananya', status: 'active', since: addDays(today, -4), payment_terms_days: 30, health: null },
    { ...h.base(T2), id: 'cl_k_sparsh', name: 'Sparsh Clinics', industry: 'Healthcare', country: 'India', gstin: '', billing_address: '', primary_contact: 'Dr. Rath', email: '', phone: '', owner_id: 'u_k_meera', status: 'prospect', since: null, payment_terms_days: 30, health: null },
  )
  db.contracts.push({ ...h.base(T2), id: h.id('ctr'), client_id: 'cl_k_hosp', project_id: 'p_k_1', title: 'OPD booking app — fixed-price SOW', kind: 'sow', value_paise: L(5.5), start_on: addDays(today, -4), end_on: addDays(today, 60), renewal_on: addDays(today, 60), auto_renew: false, status: 'active', file_id: null, notes: '' })
}
