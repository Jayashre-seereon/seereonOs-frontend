// v7 document templates — the light markup used by letter templates, its HTML renderer and the placeholder
// catalogue. Pure (no DB access) so the mock server, the template editor's live preview and the PDF renderer
// all lay a letter out the same way.
//
// Markup:
//   # Heading 1 · ## Heading 2 · ### Heading 3
//   **bold** · *italic*
//   - bullet item · 1. numbered item
//   | a | b |   table rows; a row of dashes (|---|---|) after the first row makes it the header
//   ---         horizontal rule
//   :::center … :::  (also :::right, :::left) aligns the paragraphs inside
//   {{placeholder}}  filled when the document is issued
// A blank line separates paragraphs; a single line break stays a line break.
import type { DocTemplate } from '@/types/v7'

export type DocCategory = DocTemplate['category']
export type Align = 'left' | 'center' | 'right'
export interface Run {
  text: string
  bold: boolean
  italic: boolean
}
export type Block =
  | { type: 'h'; level: 1 | 2 | 3; runs: Run[]; align: Align }
  | { type: 'p'; lines: Run[][]; align: Align }
  | { type: 'ul' | 'ol'; items: Run[][] }
  | { type: 'table'; header: Run[][] | null; rows: Run[][][] }
  | { type: 'hr' }

/* ---------------- inline ---------------- */
export function parseInline(s: string): Run[] {
  const out: Run[] = []
  const re = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ text: s.slice(last, m.index), bold: false, italic: false })
    if (m[2] !== undefined) out.push({ text: m[2], bold: true, italic: false })
    else out.push({ text: m[3], bold: false, italic: true })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last), bold: false, italic: false })
  return out.filter((r) => r.text.length)
}
export const runsText = (rs: Run[]) => rs.map((r) => r.text).join('')

/* ---------------- blocks ---------------- */
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
const isSep = (line: string) => /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim())

export function parseMarkup(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let align: Align = 'left'
  let para: Run[][] = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', lines: para, align })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    const fence = /^:::\s*(center|right|left)?\s*$/.exec(line)
    if (fence) {
      flush()
      align = (fence[1] as Align | undefined) ?? 'left'
      continue
    }
    if (!line) {
      flush()
      continue
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ type: 'h', level: h[1].length as 1 | 2 | 3, runs: parseInline(h[2]), align })
      continue
    }
    if (/^(-{3,}|_{3,})$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      continue
    }
    if (line.startsWith('|')) {
      flush()
      const tbl: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) tbl.push(lines[i++].trim())
      i--
      let header: Run[][] | null = null
      let body = tbl
      if (tbl.length > 1 && isSep(tbl[1])) {
        header = cells(tbl[0]).map(parseInline)
        body = tbl.slice(2)
      }
      blocks.push({ type: 'table', header, rows: body.filter((r) => !isSep(r)).map((r) => cells(r).map(parseInline)) })
      continue
    }
    const ul = /^[-*]\s+(.*)$/.exec(line)
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flush()
      const kind = ul ? 'ul' : 'ol'
      const items: Run[][] = []
      while (i < lines.length) {
        const l = lines[i].trim()
        const mm = kind === 'ul' ? /^[-*]\s+(.*)$/.exec(l) : /^\d+[.)]\s+(.*)$/.exec(l)
        if (!mm) break
        items.push(parseInline(mm[1]))
        i++
      }
      i--
      blocks.push({ type: kind, items })
      continue
    }
    para.push(parseInline(line))
  }
  flush()
  return blocks
}

/* ---------------- HTML ---------------- */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const runsHtml = (rs: Run[]) => rs.map((r) => (r.bold ? `<strong>${esc(r.text)}</strong>` : r.italic ? `<em>${esc(r.text)}</em>` : esc(r.text))).join('')
const alignAttr = (a: Align) => (a === 'left' ? '' : ` style="text-align:${a}"`)
const numericCell = (rs: Run[]) => /^[-−]?\s*(₹|Rs\.?)?\s*[\d,]+(\.\d+)?\s*%?$/.test(runsText(rs).trim())

export function markupToHtml(src: string): string {
  return parseMarkup(src)
    .map((b) => {
      switch (b.type) {
        case 'h':
          return `<h${b.level}${alignAttr(b.align)}>${runsHtml(b.runs)}</h${b.level}>`
        case 'p':
          return `<p${alignAttr(b.align)}>${b.lines.map(runsHtml).join('<br>')}</p>`
        case 'ul':
        case 'ol':
          return `<${b.type}>${b.items.map((it) => `<li>${runsHtml(it)}</li>`).join('')}</${b.type}>`
        case 'hr':
          return '<hr>'
        case 'table': {
          const td = (c: Run[], tag: 'td' | 'th') => `<${tag}${numericCell(c) ? ' class="num"' : ''}>${runsHtml(c)}</${tag}>`
          const head = b.header ? `<thead><tr>${b.header.map((c) => td(c, 'th')).join('')}</tr></thead>` : ''
          return `<table>${head}<tbody>${b.rows.map((r) => `<tr>${r.map((c) => td(c, 'td')).join('')}</tr>`).join('')}</tbody></table>`
        }
      }
    })
    .join('\n')
}

/* ---------------- placeholders ---------------- */
export function placeholdersIn(s: string): string[] {
  return [...new Set([...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]))]
}
/** Fill placeholders. Unknown / empty values become an empty string. */
export function fillPlaceholders(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
}

export interface PlaceholderDef {
  key: string
  label: string
  sample: string
  /** filled automatically from the employee / company record */
  auto?: boolean
  /** markup fragment (e.g. table rows) — generated by the system, not typed by the issuer */
  generated?: boolean
  hint?: string
  type?: 'text' | 'date' | 'money' | 'number' | 'textarea'
}

/** Filled automatically for every document (see standardVars in docgen.ts). */
export const STANDARD_PLACEHOLDERS: PlaceholderDef[] = [
  { key: 'employee_name', label: 'Employee name', sample: 'Hritesh Panda', auto: true },
  { key: 'employee_first_name', label: 'First name', sample: 'Hritesh', auto: true },
  { key: 'employee_code', label: 'Employee code', sample: 'SCI-0003', auto: true },
  { key: 'employee_email', label: 'Work email', sample: 'hritesh@seereon.co.in', auto: true },
  { key: 'employee_phone', label: 'Phone', sample: '+91 94370 12345', auto: true },
  { key: 'designation', label: 'Designation', sample: 'Senior MERN Developer', auto: true },
  { key: 'department', label: 'Department', sample: 'Delivery', auto: true },
  { key: 'grade', label: 'Grade', sample: 'L3 · Senior', auto: true },
  { key: 'location', label: 'Work location', sample: 'Bhubaneswar HQ', auto: true },
  { key: 'employment_type', label: 'Employment type', sample: 'Full-time', auto: true },
  { key: 'joining_date', label: 'Joining date', sample: '1 October 2025', auto: true },
  { key: 'manager_name', label: 'Reporting manager', sample: 'Subhankar Rout', auto: true },
  { key: 'company', label: 'Company legal name', sample: 'Seereon Consulting & IT Services Pvt. Ltd.', auto: true },
  { key: 'company_brand', label: 'Company brand name', sample: 'Seereon', auto: true },
  { key: 'company_address', label: 'Company address', sample: '2nd floor, Khandagiri Square, Khandagiri, Bhubaneswar, Odisha 751030', auto: true },
  { key: 'company_city', label: 'Company city', sample: 'Bhubaneswar', auto: true },
  { key: 'company_cin', label: 'Company CIN', sample: 'U72900OR2025PTC048213', auto: true },
  { key: 'company_gstin', label: 'Company GSTIN', sample: '21AAKCS4821M1Z5', auto: true },
  { key: 'company_email', label: 'Company email', sample: 'hr@seereon.co.in', auto: true },
  { key: 'company_phone', label: 'Company phone', sample: '+91 90907 05533', auto: true },
  { key: 'company_website', label: 'Company website', sample: 'seereon.co.in', auto: true },
  { key: 'signatory_name', label: 'Signatory name', sample: 'Priya Mohapatra', auto: true, hint: 'The person issuing the document' },
  { key: 'signatory_designation', label: 'Signatory designation', sample: 'HR & Accounts', auto: true },
  { key: 'today', label: 'Issue date', sample: '14 October 2026', auto: true },
  { key: 'ref_no', label: 'Reference number', sample: 'SCI/HR/2026/0012', auto: true },
]

const P = (key: string, label: string, sample: string, type: PlaceholderDef['type'] = 'text', hint?: string): PlaceholderDef => ({ key, label, sample, type, hint })
const G = (key: string, label: string, sample: string): PlaceholderDef => ({ key, label, sample, generated: true })

/** Process placeholders per category — the issuer fills these (or the process that issues the document). */
export const CATEGORY_PLACEHOLDERS: Record<DocCategory, PlaceholderDef[]> = {
  offer_letter: [
    P('ctc_annual', 'Annual CTC', '₹8,40,000', 'money'),
    P('ctc_monthly', 'Monthly CTC', '₹70,000', 'money'),
    P('offer_designation', 'Offered designation', 'Senior MERN Developer'),
    P('proposed_joining_date', 'Proposed joining date', '1 November 2026', 'date'),
    P('probation_months', 'Probation (months)', '6', 'number'),
    P('notice_period_days', 'Notice period (days)', '60', 'number'),
    P('offer_valid_until', 'Offer valid until', '21 October 2026', 'date'),
  ],
  joining_letter: [
    P('ctc_annual', 'Annual CTC', '₹8,40,000', 'money'),
    P('ctc_monthly', 'Monthly CTC', '₹70,000', 'money'),
    P('reporting_time', 'Reporting time', '9:30 AM', 'text'),
    P('probation_months', 'Probation (months)', '6', 'number'),
    P('notice_period_days', 'Notice period (days)', '60', 'number'),
    P('working_hours', 'Working hours', '9:30 AM to 6:30 PM, Monday to Friday, and alternate Saturdays'),
  ],
  appraisal_letter: [
    P('appraisal_period', 'Appraisal period', 'FY 2025-26'),
    P('rating', 'Final rating', 'Exceeds expectations'),
    P('old_ctc', 'Current annual CTC', '₹8,40,000', 'money'),
    P('new_ctc', 'Revised annual CTC', '₹9,66,000', 'money'),
    P('hike_pct', 'Hike %', '15', 'number'),
    P('new_designation', 'Designation from effective date', 'Senior MERN Developer'),
    P('effective_from', 'Effective from', '1 April 2026', 'date'),
  ],
  confirmation_letter: [
    P('probation_end_date', 'Probation completed on', '31 March 2026', 'date'),
    P('confirmation_date', 'Confirmed with effect from', '1 April 2026', 'date'),
    P('notice_period_days', 'Notice period (days)', '60', 'number'),
  ],
  relieving_letter: [
    P('resignation_date', 'Resignation date', '15 August 2026', 'date'),
    P('last_working_day', 'Last working day', '14 October 2026', 'date'),
  ],
  experience_letter: [
    P('last_working_day', 'Last working day', '14 October 2026', 'date'),
    P('last_designation', 'Designation at exit', 'Senior MERN Developer'),
    P('key_work', 'Key work (one line)', 'full-stack development of client ERP and CRM products', 'textarea'),
  ],
  warning_letter: [
    P('incident_date', 'Incident date', '8 October 2026', 'date'),
    P('issue_description', 'What happened', 'timesheets for three consecutive weeks were not submitted despite reminders', 'textarea'),
    P('expected_correction', 'Expected correction', 'submit every timesheet by Friday 6 PM', 'textarea'),
    P('review_date', 'Review date', '14 November 2026', 'date'),
  ],
  nda: [
    P('effective_date', 'Effective date', '1 November 2026', 'date'),
    P('term_years', 'Confidentiality term (years)', '3', 'number'),
    P('governing_city', 'Jurisdiction (city)', 'Bhubaneswar'),
  ],
  payslip: [
    P('month_label', 'Pay month', 'September 2026'),
    P('pay_period', 'Pay period', '1 Sep 2026 – 30 Sep 2026'),
    P('working_days', 'Working days', '22', 'number'),
    P('paid_days', 'Paid days', '22', 'number'),
    P('lwp_days', 'Leave without pay (days)', '0', 'number'),
    P('unapproved_days', 'Unapproved timesheet days', '0', 'number'),
    G('earnings_rows', 'Earnings table rows', '| Basic | ₹35,000.00 |\n| House rent allowance | ₹14,000.00 |\n| Special allowance | ₹21,000.00 |'),
    G('deductions_rows', 'Deductions table rows', '| Leave without pay (0 days) | ₹0.00 |\n| Unapproved timesheet days (0 days) | ₹0.00 |'),
    P('monthly_ctc', 'Monthly CTC', '₹70,000.00', 'money'),
    P('gross_earnings', 'Gross earnings', '₹70,000.00', 'money'),
    P('total_deductions', 'Total deductions', '₹0.00', 'money'),
    P('variable_pay', 'Variable pay', '₹0.00', 'money'),
    P('net_pay', 'Net pay', '₹70,000.00', 'money'),
    P('net_pay_words', 'Net pay in words', 'Rupees Seventy Thousand Only'),
    P('bank_name', 'Bank', 'HDFC Bank'),
    P('pay_date', 'Pay date', '1 October 2026', 'date'),
  ],
  policy: [P('policy_name', 'Policy name', 'Leave policy'), P('effective_date', 'Effective date', '1 April 2026', 'date')],
  other: [],
}

export const CATEGORY_LABEL: Record<DocCategory, string> = {
  offer_letter: 'Offer letter',
  joining_letter: 'Joining & appointment',
  appraisal_letter: 'Appraisal letter',
  confirmation_letter: 'Confirmation letter',
  relieving_letter: 'Relieving letter',
  experience_letter: 'Experience certificate',
  warning_letter: 'Warning letter',
  nda: 'NDA',
  payslip: 'Payslip',
  policy: 'Policy',
  other: 'Other',
}
export const TEMPLATE_CATEGORIES: DocCategory[] = ['offer_letter', 'joining_letter', 'appraisal_letter', 'confirmation_letter', 'relieving_letter', 'experience_letter', 'warning_letter', 'nda', 'payslip', 'other']

export const STANDARD_KEYS = new Set(STANDARD_PLACEHOLDERS.map((p) => p.key))
/** Placeholders from every category's catalogue (a letter of one category may reuse another's fields, e.g. a
 *  promotion letter uses new_ctc). System-generated fragments (payslip table rows) stay payslip-only. */
export function catalogueFor(category: DocCategory): PlaceholderDef[] {
  const own = CATEGORY_PLACEHOLDERS[category] ?? []
  const seen = new Set(own.map((p) => p.key))
  const rest: PlaceholderDef[] = []
  for (const list of Object.values(CATEGORY_PLACEHOLDERS))
    for (const p of list)
      if (!seen.has(p.key) && !p.generated) {
        seen.add(p.key)
        rest.push(p)
      }
  return [...own, ...rest]
}
/** Placeholders a template of this category may use (standard + catalogue + declared custom). */
export function knownPlaceholders(category: DocCategory, custom: string[] = []): Set<string> {
  return new Set([...STANDARD_KEYS, ...catalogueFor(category).map((p) => p.key), ...custom])
}
/** Placeholders the issuer must fill: used in the body, not auto-filled, not generated by the system. */
export function processPlaceholders(body: string, category: DocCategory, custom: string[] = []): PlaceholderDef[] {
  const used = placeholdersIn(body)
  const defs = new Map(catalogueFor(category).map((p) => [p.key, p]))
  for (const p of CATEGORY_PLACEHOLDERS[category] ?? []) defs.set(p.key, p)
  return used
    .filter((k) => !STANDARD_KEYS.has(k))
    .map((k) => defs.get(k) ?? (custom.includes(k) ? { key: k, label: labelOf(k), sample: '', type: 'text' as const } : null))
    .filter((p): p is PlaceholderDef => !!p && !p.generated)
}
export function labelOf(key: string): string {
  const all = [...STANDARD_PLACEHOLDERS, ...Object.values(CATEGORY_PLACEHOLDERS).flat()]
  return all.find((p) => p.key === key)?.label ?? key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
export function sampleVars(category: DocCategory, custom: string[] = []): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of [...STANDARD_PLACEHOLDERS, ...catalogueFor(category)]) out[p.key] = p.sample
  for (const c of custom) out[c] ??= `[${labelOf(c)}]`
  return out
}

/* ---------------- Indian number words (for payslips) ---------------- */
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
function twoDigits(n: number): string {
  if (n < 20) return ONES[n]
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`
}
function threeDigits(n: number): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ')
}
export function numberToIndianWords(n: number): string {
  n = Math.floor(Math.abs(n))
  if (n === 0) return 'Zero'
  const parts: string[] = []
  const crore = Math.floor(n / 1_00_00_000)
  n %= 1_00_00_000
  const lakh = Math.floor(n / 1_00_000)
  n %= 1_00_000
  const thousand = Math.floor(n / 1000)
  n %= 1000
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`)
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`)
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`)
  if (n) parts.push(threeDigits(n))
  return parts.join(' ')
}
/** "Rupees Seventy Thousand and Fifty Paise Only" */
export function rupeesInWords(paise: number): string {
  const r = Math.floor(Math.abs(paise) / 100)
  const p = Math.abs(paise) % 100
  return `Rupees ${numberToIndianWords(r)}${p ? ` and ${twoDigits(p)} Paise` : ''} Only`
}
