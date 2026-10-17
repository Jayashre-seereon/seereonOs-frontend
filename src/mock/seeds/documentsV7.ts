// v7 Documents hub seed: default letter templates (every workspace), issued letters and employee documents
// for the Seereon demo, a light set for Kalinga. Payslips are not seeded here: they are issued from the last
// finalised payroll run the first time the documents area is opened (see docsV7.ts ensureSeedPayslips), so
// every number on them comes from the payroll lines.
import type { DB } from '../server'
import type { SeedHelpers } from './index'
import type { DocTemplate, EmployeeDocument, IssuedDocument } from '@/types/v7'
import { addDays } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { provisionDocDefaults, renderBody, standardVarsFor, longDate } from '../docgen'

type TplDef = Pick<DocTemplate, 'key' | 'name' | 'category' | 'body' | 'description'>

const SIGN = `Yours sincerely,

**{{signatory_name}}**
{{signatory_designation}}
For {{company}}`

const HEAD = `:::right
Ref: {{ref_no}}
Date: {{today}}
:::`

export const DEFAULT_DOC_TEMPLATES: TplDef[] = [
  {
    key: 'offer_letter', name: 'Offer letter', category: 'offer_letter',
    description: 'Offer of employment with CTC, joining date, probation and notice period.',
    body: `${HEAD}

**{{employee_name}}**
{{employee_email}}

## Offer of employment — {{offer_designation}}

Dear {{employee_first_name}},

We are pleased to offer you the position of **{{offer_designation}}** in the {{department}} team at {{company}}. This letter sets out the main terms of our offer.

| Term | Detail |
|---|---|
| Designation | {{offer_designation}} |
| Department | {{department}} |
| Reporting to | {{manager_name}} |
| Work location | {{location}} |
| Proposed joining date | {{proposed_joining_date}} |
| Annual cost to company (CTC) | {{ctc_annual}} |
| Monthly CTC | {{ctc_monthly}} |
| Probation | {{probation_months}} months |
| Notice period | {{notice_period_days}} days |

### Conditions of this offer
- The offer is subject to satisfactory verification of your educational and employment documents.
- On your joining day, bring your PAN, Aadhaar, educational certificates, the relieving letter from your last employer and your last three payslips.
- Your detailed terms of employment, including leave and confidentiality obligations, are set out in your appointment letter.

Please confirm your acceptance by acknowledging this letter in SeereonOS on or before **{{offer_valid_until}}**, after which this offer lapses.

We look forward to welcoming you to {{company_brand}}.

${SIGN}`,
  },
  {
    key: 'joining_letter', name: 'Joining letter', category: 'joining_letter',
    description: 'Welcome letter confirming the joining date, reporting details and first-day checklist.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}}

## Joining letter

Dear {{employee_first_name}},

Welcome to {{company_brand}}. We confirm that you have joined {{company}} on **{{joining_date}}** as **{{designation}}** in the {{department}} department.

| Detail | |
|---|---|
| Employee code | {{employee_code}} |
| Designation | {{designation}} |
| Department | {{department}} |
| Reporting manager | {{manager_name}} |
| Work location | {{location}} |
| Employment type | {{employment_type}} |
| Annual CTC | {{ctc_annual}} |
| Working hours | {{working_hours}} |
| Reporting time on day one | {{reporting_time}} |

### Your first week
1. Sign in to SeereonOS with the login details sent to {{employee_email}} and set your own password.
2. Upload your PAN, Aadhaar, education certificates, bank details and a photograph under Documents → My documents.
3. Read and acknowledge the company policies marked "Read required".
4. Submit your first weekly timesheet by Friday evening.

You will be on probation for {{probation_months}} months from your joining date. The notice period during and after probation is {{notice_period_days}} days.

We are glad to have you with us.

${SIGN}`,
  },
  {
    key: 'appointment_letter', name: 'Appointment letter', category: 'joining_letter',
    description: 'Formal terms of employment: compensation, probation, leave, confidentiality and termination.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}}

## Letter of appointment

Dear {{employee_first_name}},

With reference to your acceptance of our offer, we are pleased to appoint you as **{{designation}}** at {{company}} with effect from **{{joining_date}}**, on the following terms and conditions.

### 1. Compensation
Your annual cost to company is **{{ctc_annual}}** ({{ctc_monthly}} per month), paid monthly in arrears to your registered bank account. Salary is paid for days covered by approved timesheets, in line with the company payroll policy.

### 2. Probation and confirmation
You will be on probation for {{probation_months}} months. On satisfactory completion you will be confirmed in writing. The company may extend probation once by up to three months.

### 3. Working hours and location
Your working hours are {{working_hours}}. Your place of work is {{location}}. You may be deputed to client sites or other locations as business requires.

### 4. Leave
You are entitled to leave as per the company leave policy in force, available under Documents → Policies.

### 5. Confidentiality and intellectual property
You will keep confidential all information about the company, its clients and its products, during and after your employment. All work you produce in the course of employment belongs to the company.

### 6. Notice period
Either party may end this appointment with {{notice_period_days}} days' written notice, or salary in lieu of notice.

### 7. Conduct
You will follow the company's code of conduct, policies and lawful instructions as amended from time to time.

Please acknowledge this letter in SeereonOS as your acceptance of these terms.

${SIGN}`,
  },
  {
    key: 'appraisal_letter', name: 'Appraisal letter', category: 'appraisal_letter',
    description: 'Revised compensation after the appraisal cycle: rating, old and new CTC, hike and effective date.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}} · {{department}}

## Annual appraisal — {{appraisal_period}}

Dear {{employee_first_name}},

Thank you for your contribution during {{appraisal_period}}. Based on your performance review, your overall rating is **{{rating}}**.

We are pleased to revise your compensation as follows, effective **{{effective_from}}**:

| Component | Amount |
|---|---|
| Current annual CTC | {{old_ctc}} |
| Revised annual CTC | {{new_ctc}} |
| Increase | {{hike_pct}}% |
| Designation | {{new_designation}} |

All other terms of your appointment remain unchanged. The revised salary will be reflected in the payroll from the effective date.

We look forward to your continued contribution.

${SIGN}`,
  },
  {
    key: 'confirmation_letter', name: 'Probation confirmation', category: 'confirmation_letter',
    description: 'Confirms the employee after successful completion of probation.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}}

## Confirmation of employment

Dear {{employee_first_name}},

We are pleased to inform you that you have successfully completed your probation period, which ended on **{{probation_end_date}}**. You are confirmed as **{{designation}}** with effect from **{{confirmation_date}}**.

From the date of confirmation, the notice period applicable to you is {{notice_period_days}} days. All other terms of your appointment letter remain unchanged.

Congratulations, and thank you for your work so far.

${SIGN}`,
  },
  {
    key: 'relieving_letter', name: 'Relieving letter', category: 'relieving_letter',
    description: 'Confirms acceptance of resignation and release from duties on the last working day.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}}

## Relieving letter

Dear {{employee_first_name}},

This is with reference to your resignation dated {{resignation_date}}. We confirm that your resignation has been accepted and that you are relieved from your duties as **{{designation}}** at the close of business on **{{last_working_day}}**.

We confirm that you have handed over your responsibilities and company assets, and that your full and final settlement will be processed as per company policy.

Your obligations of confidentiality towards the company and its clients continue after you leave.

We thank you for your contribution and wish you success in the future.

${SIGN}`,
  },
  {
    key: 'experience_letter', name: 'Experience certificate', category: 'experience_letter',
    description: 'To-whom-it-may-concern certificate of service, dates and designation.',
    body: `${HEAD}

:::center
## To whom it may concern
:::

This is to certify that **{{employee_name}}** (employee code {{employee_code}}) was employed with {{company}} from **{{joining_date}}** to **{{last_working_day}}**.

At the time of leaving, {{employee_first_name}} held the position of **{{last_designation}}** in the {{department}} department, and worked on {{key_work}}.

During this period we found {{employee_first_name}} sincere, hardworking and professional. We wish {{employee_first_name}} every success in future endeavours.

${SIGN}`,
  },
  {
    key: 'warning_letter', name: 'Warning letter', category: 'warning_letter',
    description: 'Formal written warning with the incident, expected correction and review date.',
    body: `${HEAD}

**{{employee_name}}**
Employee code: {{employee_code}} · {{department}}

## Written warning

Dear {{employee_first_name}},

This letter is a formal warning regarding the following, observed on {{incident_date}}: {{issue_description}}.

This is not in line with the standards expected of you as {{designation}}. We expect you to {{expected_correction}}. Your manager, {{manager_name}}, will review your progress on **{{review_date}}**.

Please treat this matter seriously. A repeat may lead to further disciplinary action as per company policy. If you would like to discuss this letter, speak to HR or your manager.

${SIGN}`,
  },
  {
    key: 'nda', name: 'Non-disclosure agreement', category: 'nda',
    description: 'Employee confidentiality and non-disclosure agreement for client work.',
    body: `${HEAD}

## Non-disclosure agreement

This agreement is made on **{{effective_date}}** between **{{company}}**, {{company_address}} (the "Company"), and **{{employee_name}}**, employee code {{employee_code}}, {{designation}} (the "Employee").

### 1. Confidential information
"Confidential information" means any non-public information about the Company, its clients, products, source code, designs, pricing, plans and personal data, whether written, electronic or oral.

### 2. Obligations
The Employee will:
- use confidential information only to perform their duties;
- not disclose it to anyone outside the Company without written permission;
- not copy client code or data to personal devices or accounts;
- return or delete all confidential information when their employment ends.

### 3. Term
These obligations apply during employment and for **{{term_years}} years** after it ends.

### 4. Governing law
This agreement is governed by the laws of India. Courts in {{governing_city}} have exclusive jurisdiction.

| For the Company | Employee |
|---|---|
| {{signatory_name}} | {{employee_name}} |
| {{signatory_designation}} | {{designation}} |
| Date: {{today}} | Acknowledged in SeereonOS |`,
  },
  {
    key: 'payslip', name: 'Payslip', category: 'payslip',
    description: 'Monthly payslip generated from the finalised payroll run.',
    body: `## Payslip for {{month_label}}

| Employee | {{employee_name}} | Employee code | {{employee_code}} |
| Designation | {{designation}} | Department | {{department}} |
| Pay period | {{pay_period}} | Pay date | {{pay_date}} |
| Working days | {{working_days}} | Paid days | {{paid_days}} |
| Leave without pay | {{lwp_days}} days | Unapproved days | {{unapproved_days}} days |
| Bank | {{bank_name}} | Monthly CTC | {{monthly_ctc}} |

| Earnings | Amount |
|---|---|
{{earnings_rows}}
| **Gross earnings** | **{{gross_earnings}}** |

| Deductions | Amount |
|---|---|
{{deductions_rows}}
| **Total deductions** | **{{total_deductions}}** |

| Net pay | Amount |
|---|---|
| **Net pay for {{month_label}}** | **{{net_pay}}** |

*{{net_pay_words}}*

Days are paid only when the week's timesheet is approved. Questions about this payslip go to HR at {{company_email}}.

:::center
*This is a system-generated payslip and does not need a signature.*
:::`,
  },
]

/* ---------------- tiny files ---------------- */
function pdfURL(title: string, lines: string[]): { url: string; size: number } {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '-')
  let stream = 'BT /F1 16 Tf 56 770 Td (' + esc(title) + ') Tj ET\n'
  lines.forEach((l, i) => (stream += 'BT /F1 11 Tf 56 ' + (736 - i * 18) + ' Td (' + esc(l) + ') Tj ET\n'))
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += i + 1 + ' 0 obj\n' + o + '\nendobj\n'
  })
  const xref = out.length
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
  return { url: 'data:application/pdf;base64,' + btoa(out), size: out.length }
}
// 48×60 placeholder head-and-shoulders photograph
const PHOTO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAA8CAIAAACvoq6rAAAAqElEQVR42u3XsQ2AMAwEwN9/FEpqxqGgYgbogZA45GOHlzzASZb8b6zb7mogkEACCSSQQJ1A07z0B52Ip2GDEpRKFtppbCY01RhMwUEGTalJoJFBZk2RSSsTiAtSdERMe499yGNjdNqp9QYJJNAfQd9exSGiw1Ha+yr5lZp8E2iaTBOYmhwTyJpXE/iatAldNAlTEBBB82SKAKJpbk0ClYLImqtJoHCgA4BubGNEXaAgAAAAAElFTkSuQmCC'

/* ---------------- seed ---------------- */
export function seed(db: DB, h: SeedHelpers) {
  for (const t of db.tenants) {
    provisionDocDefaults(db, t.id, () => h.base(t.id))
    db.number_sequences.push({ tenant_id: t.id, scope: 'docs_v7_defaults', next_value: 1 })
  }
  // Policies in the company library get an effective date: the day their current version was published.
  for (const d of db.documents)
    if (!d.project_id && (d.category === 'policy' || d.category === 'process')) {
      const v = db.document_versions.filter((x) => x.document_id === d.id && x.version === d.current_version)[0]
      d.effective_on = v ? v.uploaded_at.slice(0, 10) : d.created_at.slice(0, 10)
    }
  const T1 = db.tenants.find((t) => t.slug === 'seereon')?.id
  if (T1) seedSeereon(db, h, T1)
  const T2 = db.tenants.find((t) => t.slug !== 'seereon' && db.users.some((u) => u.tenant_id === t.id && u.id === 'u_k_rakesh'))?.id
  if (T2) seedKalinga(db, h, T2)
}

function issuedSeed(db: DB, h: SeedHelpers, tid: string, opts: { key: string; emp: string; by: string; on: string; vars: Record<string, string>; status: IssuedDocument['status']; acked?: string | null; source?: IssuedDocument['source']; title?: string }, refSeq: { n: number }) {
  const tpl = db.doc_templates.find((x) => x.tenant_id === tid && x.key === opts.key)!
  const prefix = db.tenants.find((t) => t.id === tid)?.org?.employee_code_prefix || 'DOC'
  const ref_no = `${prefix}/HR/${opts.on.slice(0, 4)}/${String(refSeq.n++).padStart(4, '0')}`
  const std = standardVarsFor(db, tid, opts.emp, opts.by, opts.on)
  const vars = { ...std, ref_no, ...opts.vars }
  const { body_md, body_html } = renderBody(tpl.body, vars)
  const at = `${opts.on}T10:30:00.000Z`
  const doc: IssuedDocument = {
    ...h.base(tid), created_at: at, updated_at: opts.acked ? `${opts.acked}T11:00:00.000Z` : at,
    template_id: tpl.id, category: tpl.category, title: opts.title ?? `${tpl.name} — ${std.employee_name}`, employee_id: opts.emp, body_html, body_md, vars: { ref_no, ...opts.vars },
    letterhead: true, ref_no, period: null, status: opts.status, issued_by: opts.by, issued_on: opts.status === 'draft' ? null : opts.on, acknowledged_on: opts.acked ?? null,
    source: opts.source ?? { kind: 'manual', ref_id: null }, revoked_on: null, revoked_by: null, revoke_reason: null, replaces_id: null, replaced_by_id: null,
    emailed_to: opts.status === 'draft' ? null : db.users.find((u) => u.id === opts.emp)?.email ?? null,
  }
  db.issued_documents.push(doc)
  return doc
}

const annual = (monthly: number) => fmtMoney(monthly * 12)

function seedSeereon(db: DB, h: SeedHelpers, tid: string) {
  const today = h.today
  const users = db.users.filter((u) => u.tenant_id === tid && !u.is_super_admin)
  const U = (k: string) => users.find((u) => u.id === `u_${k}`)
  const ratesOf = (id: string) => db.cost_rates.filter((r) => r.tenant_id === tid && r.user_id === id).sort((a, b) => a.effective_from.localeCompare(b.effective_from))
  const refSeq = { n: 1 }
  const priya = 'u_priya'
  const santosh = 'u_santosh'
  const desigOf = (id: string) => standardVarsFor(db, tid, id, null, today).designation

  // Offer + appointment letters for the delivery and sales team, issued around their joining dates.
  for (const k of ['hritesh', 'bijaya', 'jagannath', 'jayashree', 'pragyasmita', 'subham']) {
    const u = U(k)
    if (!u) continue
    const first = ratesOf(u.id)[0]
    if (!first) continue
    const ctc = { ctc_annual: annual(first.monthly_ctc_paise), ctc_monthly: fmtMoney(first.monthly_ctc_paise) }
    const offerOn = addDays(u.joined_on, -21)
    const issuer = u.joined_on < addDays(today, -300) ? santosh : priya
    issuedSeed(db, h, tid, {
      key: 'offer_letter', emp: u.id, by: issuer, on: offerOn, status: 'acknowledged', acked: addDays(offerOn, 2),
      vars: { ...ctc, offer_designation: desigOf(u.id), proposed_joining_date: longDate(u.joined_on), probation_months: '6', notice_period_days: '60', offer_valid_until: longDate(addDays(offerOn, 7)) },
    }, refSeq)
    const recent = k === 'subham' || k === 'jayashree'
    issuedSeed(db, h, tid, {
      key: 'appointment_letter', emp: u.id, by: issuer, on: u.joined_on, status: k === 'jayashree' ? 'issued' : 'acknowledged', acked: k === 'jayashree' ? null : addDays(u.joined_on, 1),
      vars: { ...ctc, probation_months: '6', notice_period_days: '60', working_hours: '9:30 AM to 6:30 PM, Monday to Friday, and alternate Saturdays' },
      source: { kind: 'onboarding', ref_id: u.id },
    }, refSeq)
    if (recent)
      issuedSeed(db, h, tid, {
        key: 'joining_letter', emp: u.id, by: priya, on: u.joined_on, status: 'acknowledged', acked: u.joined_on,
        vars: { ...ctc, reporting_time: '9:30 AM', probation_months: '6', notice_period_days: '60', working_hours: '9:30 AM to 6:30 PM, Monday to Friday, and alternate Saturdays' },
        source: { kind: 'onboarding', ref_id: u.id },
      }, refSeq)
  }

  // Appraisal letters for people whose CTC was revised after at least six months' service (from the cost-rate history).
  for (const u of users) {
    const rs = ratesOf(u.id)
    if (rs.length < 2) continue
    const [a, b] = rs
    if (a.effective_from > addDays(b.effective_from, -180) || b.effective_from > today) continue
    const hike = ((b.monthly_ctc_paise - a.monthly_ctc_paise) / a.monthly_ctc_paise) * 100
    const on = addDays(b.effective_from, -4)
    const fyEnd = Number(b.effective_from.slice(0, 4))
    issuedSeed(db, h, tid, {
      key: 'appraisal_letter', emp: u.id, by: santosh, on, status: u.id === 'u_hritesh' ? 'issued' : 'acknowledged', acked: u.id === 'u_hritesh' ? null : addDays(on, 3),
      vars: { appraisal_period: `FY ${fyEnd - 1}-${String(fyEnd).slice(2)}`, rating: hike >= 9 ? 'Exceeds expectations' : 'Meets expectations', old_ctc: annual(a.monthly_ctc_paise), new_ctc: annual(b.monthly_ctc_paise), hike_pct: hike.toFixed(1), new_designation: desigOf(u.id), effective_from: longDate(b.effective_from) },
    }, refSeq)
  }

  // Probation confirmations: six months after joining, for those already past it.
  for (const k of ['jagannath', 'jayashree', 'pragyasmita']) {
    const u = U(k)
    if (!u) continue
    const end = addDays(u.joined_on, 182)
    if (end >= today) continue
    issuedSeed(db, h, tid, {
      key: 'confirmation_letter', emp: u.id, by: priya, on: addDays(end, 1), status: k === 'pragyasmita' ? 'issued' : 'acknowledged', acked: k === 'pragyasmita' ? null : addDays(end, 2),
      vars: { probation_end_date: longDate(end), confirmation_date: longDate(addDays(end, 1)), notice_period_days: '60' },
    }, refSeq)
  }

  // Client NDAs for the SAP / ERP delivery team, and one draft waiting to be issued.
  for (const k of ['hritesh', 'bijaya']) {
    const u = U(k)
    if (!u) continue
    const on = addDays(today, -95)
    issuedSeed(db, h, tid, { key: 'nda', emp: u.id, by: priya, on, status: 'acknowledged', acked: addDays(on, 1), vars: { effective_date: longDate(on), term_years: '3', governing_city: 'Bhubaneswar' } }, refSeq)
  }
  const subham = U('subham')
  if (subham) issuedSeed(db, h, tid, { key: 'nda', emp: subham.id, by: priya, on: today, status: 'draft', vars: { effective_date: longDate(addDays(today, 3)), term_years: '3', governing_city: 'Bhubaneswar' } }, refSeq)
  db.number_sequences.push({ tenant_id: tid, scope: 'doc_ref', next_value: refSeq.n })

  /* ---------------- employee documents ---------------- */
  type K = EmployeeDocument['kind']
  const files = (eid: string, docId: string, name: string, title: string, lines: string[], kind: K) => {
    if (kind === 'photo') {
      db.files.push({ ...h.base(tid), name, mime: 'image/png', size_bytes: 225, entity: 'employee_document', entity_id: docId, data_url: PHOTO_PNG })
      return { mime: 'image/png', size: 225 }
    }
    const p = pdfURL(title, lines)
    db.files.push({ ...h.base(tid), name, mime: 'application/pdf', size_bytes: p.size, entity: 'employee_document', entity_id: docId, data_url: p.url })
    return { mime: 'application/pdf', size: p.size }
  }
  interface ED {
    kind: K
    title: string
    status: EmployeeDocument['status']
    ago: number
    note?: string
    review?: string
    expires?: number
    number?: string
  }
  const plan: Record<string, ED[]> = {
    hritesh: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 375, number: 'XXXXX4821K' },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 375, number: 'XXXX XXXX 6614' },
      { kind: 'education', title: 'B.Tech (Computer Science) degree certificate', status: 'verified', ago: 374 },
      { kind: 'experience', title: 'Relieving letter — previous employer', status: 'verified', ago: 374 },
      { kind: 'bank', title: 'Cancelled cheque — HDFC Bank', status: 'verified', ago: 370 },
      { kind: 'photo', title: 'Passport-size photograph', status: 'verified', ago: 375 },
      { kind: 'passport', title: 'Passport', status: 'verified', ago: 120, expires: 41, number: 'XXXXX7310', note: 'For the Pune client-site visit.' },
    ],
    bijaya: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 296 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 296 },
      { kind: 'education', title: 'MCA degree certificate', status: 'verified', ago: 295 },
      { kind: 'bank', title: 'Bank passbook front page — SBI', status: 'verified', ago: 290 },
      { kind: 'photo', title: 'Photograph', status: 'verified', ago: 296 },
    ],
    jagannath: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 286 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 286 },
      { kind: 'education', title: 'B.Sc (IT) marksheet', status: 'rejected', ago: 9, review: 'The scan is blurred and the university seal is not readable. Upload a clear colour scan of the final-year marksheet.' },
      { kind: 'bank', title: 'Cancelled cheque — Axis Bank', status: 'verified', ago: 280 },
    ],
    jayashree: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 246 },
      { kind: 'aadhaar', title: 'Aadhaar card (updated address)', status: 'pending', ago: 2, note: 'Address changed after moving to Patia.' },
      { kind: 'education', title: 'B.Tech degree certificate', status: 'verified', ago: 245 },
      { kind: 'bank', title: 'Cancelled cheque — ICICI Bank', status: 'verified', ago: 240 },
      { kind: 'photo', title: 'Photograph', status: 'verified', ago: 246 },
    ],
    pragyasmita: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 196 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 196 },
      { kind: 'education', title: 'MCA provisional certificate', status: 'pending', ago: 4, note: 'Final degree certificate received from the university.' },
      { kind: 'experience', title: 'Experience letter — previous employer', status: 'verified', ago: 195 },
      { kind: 'bank', title: 'Cancelled cheque — HDFC Bank', status: 'verified', ago: 190 },
    ],
    subham: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 158 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'pending', ago: 6 },
      { kind: 'photo', title: 'Photograph', status: 'verified', ago: 158 },
    ],
    baishali: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 326 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 326 },
      { kind: 'education', title: 'MBA (Marketing) degree certificate', status: 'verified', ago: 325 },
      { kind: 'bank', title: 'Cancelled cheque — Kotak Bank', status: 'verified', ago: 320 },
    ],
    priya: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 305 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 305 },
      { kind: 'education', title: 'M.Com degree certificate', status: 'verified', ago: 305 },
      { kind: 'bank', title: 'Cancelled cheque — SBI', status: 'verified', ago: 300 },
    ],
    subhankar: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 415 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 415 },
      { kind: 'education', title: 'B.Tech degree certificate', status: 'verified', ago: 414 },
      { kind: 'bank', title: 'Cancelled cheque — HDFC Bank', status: 'verified', ago: 410 },
      { kind: 'experience', title: 'Relieving letter — previous employer', status: 'verified', ago: 414 },
    ],
    debasish: [
      { kind: 'pan', title: 'PAN card', status: 'verified', ago: 276 },
      { kind: 'aadhaar', title: 'Aadhaar card', status: 'verified', ago: 276 },
      { kind: 'bank', title: 'Cancelled cheque — Union Bank', status: 'verified', ago: 270 },
    ],
  }
  for (const [k, list] of Object.entries(plan)) {
    const u = U(k)
    if (!u) continue
    for (const d of list) {
      const on = addDays(today, -d.ago) < u.joined_on ? u.joined_on : addDays(today, -d.ago)
      const id = h.id('edoc')
      const ext = d.kind === 'photo' ? 'png' : 'pdf'
      const name = `${u.name.split(' ')[0].toLowerCase()}-${d.kind}.${ext}`
      const f = files(u.id, id, name, `${d.title} - ${u.name}`, ['Scanned copy submitted to HR', `Employee: ${u.name} (${u.employee_code ?? ''})`, `Uploaded on ${on}`], d.kind)
      const file = db.files[db.files.length - 1]
      const verifier = d.status === 'pending' ? null : u.id === priya ? santosh : priya
      db.employee_documents.push({
        ...h.base(tid), id, created_at: `${on}T09:00:00.000Z`, updated_at: `${on}T09:00:00.000Z`,
        employee_id: u.id, kind: d.kind, title: d.title, file_id: file.id, uploaded_by: u.id, verified_by: verifier, verified_on: verifier ? addDays(on, 1) > today ? today : addDays(on, 1) : null,
        status: d.status, note: d.note ?? '', expires_on: d.expires !== undefined ? addDays(today, d.expires) : null, doc_number: d.number ?? null,
        file_name: name, mime: f.mime, size_bytes: f.size, uploaded_on: on, review_note: d.review ?? null,
      })
    }
  }
}

function seedKalinga(db: DB, h: SeedHelpers, tid: string) {
  const rakesh = db.users.find((u) => u.id === 'u_k_rakesh')
  const ananya = db.users.find((u) => u.id === 'u_k_ananya')
  if (!rakesh || !ananya) return
  const rate = db.cost_rates.find((r) => r.tenant_id === tid && r.user_id === rakesh.id)
  const refSeq = { n: 1 }
  issuedSeed(db, h, tid, {
    key: 'appointment_letter', emp: rakesh.id, by: ananya.id, on: rakesh.joined_on, status: 'issued',
    vars: { ctc_annual: rate ? annual(rate.monthly_ctc_paise) : '', ctc_monthly: rate ? fmtMoney(rate.monthly_ctc_paise) : '', probation_months: '6', notice_period_days: '30', working_hours: '9:00 AM to 6:00 PM, Monday to Friday' },
    source: { kind: 'onboarding', ref_id: rakesh.id },
  }, refSeq)
  db.number_sequences.push({ tenant_id: tid, scope: 'doc_ref', next_value: refSeq.n })
}
