// v7 Documents hub: letter templates, issuing (single + bulk, drafts, revoke, re-issue, acknowledgement),
// payslips from finalised payroll runs, and employee documents with HR verification.
// Permissions (server-enforced):
//   templates + issuing + the issued register ........ documents.templates
//   employee documents of others, verify / reject ...... documents.employee_files
//   own issued documents (not drafts), own uploads ...... everyone (self only)
//   payslip generation ................................. payroll.run or documents.templates
import type { DocTemplate, EmployeeDocument, IssuedDocument } from '@/types/v7'
import type { User } from '@/types/entities'
import type { EmpDocRow, EmployeeFile, EmployeeSummaryRow, IssuedDetail, IssuedRow, IssuePreviewItem, Letterhead, PayslipResult, PayslipStatus, TemplateRow } from '@/api/docs'
import { err, find, getDb, has, hasAny, insert, logActivity, notify, nowISO, persist, remove, requireAction, requireAny, rows, update, userName, usersWith, warn, type Ctx, type Router } from '../server'
import { announceIssued, ensureDocDefaults, issueDocument, longDate, renderBody, standardVars } from '../docgen'
import { CATEGORY_LABEL, CATEGORY_PLACEHOLDERS, knownPlaceholders, labelOf, placeholdersIn, processPlaceholders, rupeesInWords, STANDARD_KEYS, TEMPLATE_CATEGORIES } from '../docMarkup'
import { payrollRunLines } from './payroll'
import { addDays, monthRange, parseISO } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { rateOn } from '@/domain/costing'

const CATS = TEMPLATE_CATEGORIES as DocTemplate['category'][]
const KINDS: EmployeeDocument['kind'][] = ['id_proof', 'address_proof', 'pan', 'aadhaar', 'passport', 'education', 'experience', 'bank', 'photo', 'other']
const MANDATORY: EmployeeDocument['kind'][] = ['pan', 'aadhaar', 'education', 'bank']
const EXT_MIME: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
const MAX_EMP_BYTES = 5 * 1024 * 1024
const monthLabel = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
const shortDate = (iso: string) => parseISO(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

/* ---------------- lazy defaults & demo payslips ---------------- */
function boot(ctx: Ctx) {
  ensureDocDefaults(ctx)
  ensureSeedPayslips(ctx)
}
/** The first time the documents area is used, issue payslips for the last finalised payroll run (the demo seed). */
function ensureSeedPayslips(ctx: Ctx) {
  const db = getDb()
  if (db.number_sequences.some((s) => s.tenant_id === ctx.tenant.id && s.scope === 'docs_v7_payslips')) return
  db.number_sequences.push({ tenant_id: ctx.tenant.id, scope: 'docs_v7_payslips', next_value: 1 })
  persist()
  const run = rows(ctx, 'payroll_runs')
    .filter((r) => r.status === 'final')
    .sort((a, b) => b.month.localeCompare(a.month))[0]
  if (!run || !rows(ctx, 'doc_templates').some((t) => t.key === 'payslip' && t.active)) return
  const by = rows(ctx, 'users').find((u) => u.id === run.finalised_by) ?? ctx.user
  try {
    generatePayslips({ ...ctx, user: by, warnings: [] }, run.id, { notify: false, issued_on: run.finalised_at?.slice(0, 10) ?? ctx.today })
  } catch {
    /* demo seed only */
  }
}

/* ---------------- views ---------------- */
function letterheadOf(ctx: Ctx): Letterhead {
  const t = getDb().tenants.find((x) => x.id === ctx.tenant.id)
  const o = t?.org
  return {
    legal_name: o?.legal_name || t?.name || '',
    brand_name: o?.brand_name || t?.name || '',
    address: [o?.registered_address, o?.city, [o?.state, o?.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    cin: o?.cin ?? '',
    gstin: o?.gstin ?? '',
    email: o?.email ?? '',
    phone: o?.phone ?? '',
    website: o?.website ?? '',
    logo: t?.slug === 'seereon' ? 'seereon' : t?.logo_data_url ?? null,
  }
}
function templateRow(ctx: Ctx, t: DocTemplate, issued = rows(ctx, 'issued_documents')): TemplateRow {
  const mine = issued.filter((d) => d.template_id === t.id && d.status !== 'draft')
  const last = mine.map((d) => d.issued_on ?? '').sort().pop() || null
  return { ...t, placeholders: placeholdersIn(t.body), issued_count: mine.length, last_used_on: last, process_placeholders: processPlaceholders(t.body, t.category, t.custom_placeholders ?? []).map((p) => p.key) }
}
function issuedRow(ctx: Ctx, d: IssuedDocument, users = new Map(rows(ctx, 'users').map((u) => [u.id, u])), tpls = new Map(rows(ctx, 'doc_templates').map((t) => [t.id, t]))): IssuedRow {
  const u = users.get(d.employee_id)
  return {
    id: d.id, version: d.version, title: d.title, category: d.category, template_id: d.template_id, template_name: d.template_id ? tpls.get(d.template_id)?.name ?? null : null,
    employee_id: d.employee_id, employee_name: u?.name ?? '—', employee_code: u?.employee_code ?? '', ref_no: d.ref_no ?? '', period: d.period, status: d.status,
    issued_on: d.issued_on, acknowledged_on: d.acknowledged_on, issued_by: d.issued_by, source: d.source, revoked_on: d.revoked_on ?? null, created_at: d.created_at,
  }
}
export function canSeeIssued(ctx: Ctx, d: IssuedDocument) {
  if (has(ctx, 'documents.templates')) return true
  if (d.status === 'draft') return false
  return d.employee_id === ctx.user.id || has(ctx, 'documents.employee_files')
}
function loadIssued(ctx: Ctx, id: string): IssuedDocument {
  const d = find(ctx, 'issued_documents', id, 'Document')
  if (!canSeeIssued(ctx, d)) err(404, 'NOT_FOUND', 'Document not found.')
  return d
}
function issuedDetail(ctx: Ctx, d: IssuedDocument): IssuedDetail {
  const u = rows(ctx, 'users').find((x) => x.id === d.employee_id)
  const tpl = d.template_id ? rows(ctx, 'doc_templates').find((t) => t.id === d.template_id) : null
  const ref = (id: string | null | undefined) => {
    const x = id ? rows(ctx, 'issued_documents').find((y) => y.id === id) : null
    return x && canSeeIssued(ctx, x) ? { id: x.id, ref_no: x.ref_no ?? '' } : null
  }
  return {
    doc: { ...d, employee_name: u?.name ?? '—', employee_code: u?.employee_code ?? '', template_name: tpl?.name ?? null },
    letterhead: d.letterhead === false ? null : letterheadOf(ctx),
    can_manage: has(ctx, 'documents.templates'),
    can_ack: d.employee_id === ctx.user.id && d.status === 'issued',
    replaces: ref(d.replaces_id),
    replaced_by: ref(d.replaced_by_id),
    process_fields: tpl ? processPlaceholders(tpl.body, tpl.category, tpl.custom_placeholders ?? []).map((p) => ({ key: p.key, label: p.label, type: p.type })) : [],
  }
}
function expiryState(d: EmployeeDocument, today: string): EmpDocRow['expiry_state'] {
  if (!d.expires_on) return null
  if (d.expires_on < today) return 'expired'
  if (d.expires_on <= addDays(today, 60)) return 'expiring'
  return 'ok'
}
function empDocRow(ctx: Ctx, d: EmployeeDocument): EmpDocRow {
  return { ...d, uploaded_by_name: userName(ctx, d.uploaded_by), verified_by_name: d.verified_by ? userName(ctx, d.verified_by) : null, expiry_state: expiryState(d, ctx.today) }
}
const missingOf = (docs: EmployeeDocument[]) => MANDATORY.filter((k) => !docs.some((d) => d.kind === k && d.status !== 'rejected'))
const masterName = (ctx: Ctx, table: 'departments' | 'designations', id: string | null | undefined) => (id ? (rows(ctx, table) as { id: string; name: string }[]).find((x) => x.id === id)?.name ?? '' : '')

/* ---------------- template validation ---------------- */
function readTemplate(ctx: Ctx, b: Record<string, unknown>, cur?: DocTemplate) {
  const name = b.name !== undefined ? String(b.name ?? '').trim() : cur!.name
  if (name.length < 3 || name.length > 80) err(422, 'VALIDATION', 'Give the template a name of 3 to 80 characters.', 'name')
  if (rows(ctx, 'doc_templates').some((t) => t.id !== cur?.id && t.name.toLowerCase() === name.toLowerCase())) err(409, 'DUPLICATE', `A template called “${name}” already exists. Choose another name.`, 'name')
  const category = (b.category !== undefined ? String(b.category) : cur!.category) as DocTemplate['category']
  if (!CATS.includes(category)) err(422, 'VALIDATION', 'Choose a category.', 'category')
  const body = b.body !== undefined ? String(b.body ?? '').replace(/\r\n/g, '\n').trim() : cur!.body
  if (body.length < 20) err(422, 'VALIDATION', 'Write the letter: the body needs at least a few sentences.', 'body')
  if (body.length > 20000) err(422, 'VALIDATION', 'Keep the body under 20,000 characters.', 'body')
  const custom = b.custom_placeholders !== undefined ? [...new Set((Array.isArray(b.custom_placeholders) ? b.custom_placeholders : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))] : cur?.custom_placeholders ?? []
  for (const c of custom) if (!/^[a-z][a-z0-9_]{1,39}$/.test(c)) err(422, 'VALIDATION', `“${c}” isn’t a valid placeholder name. Use lowercase letters, digits and underscores, e.g. bonus_amount.`, 'custom_placeholders')
  const known = knownPlaceholders(category, custom)
  const unknown = placeholdersIn(body).filter((p) => !known.has(p))
  if (unknown.length)
    err(422, 'UNKNOWN_PLACEHOLDER', `${unknown.map((u) => `{{${u}}}`).join(', ')} ${unknown.length === 1 ? 'isn’t a known placeholder' : 'aren’t known placeholders'} for ${CATEGORY_LABEL[category]} templates. Pick one from the placeholder list, or add it as a custom field.`, 'body')
  if (category === 'payslip' && !placeholdersIn(body).includes('net_pay')) err(422, 'VALIDATION', 'A payslip template must show {{net_pay}}.', 'body')
  return {
    name, category, body, custom_placeholders: custom,
    description: b.description !== undefined ? String(b.description ?? '').trim().slice(0, 300) : cur?.description ?? '',
    letterhead: b.letterhead !== undefined ? !!b.letterhead : cur?.letterhead ?? true,
    active: b.active !== undefined ? !!b.active : cur?.active ?? true,
  }
}
function slug(ctx: Ctx, name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'template'
  let k = base
  let i = 2
  while (rows(ctx, 'doc_templates').some((t) => t.key === k)) k = `${base}_${i++}`
  return k
}

/* ---------------- suggestions (defaults from the employee's records) ---------------- */
/** Process values the system can fill from records: CTC from cost rates (only for viewers who may see salaries),
 *  designation, probation dates from the joining date, shift timings, exit date from the offboarding checklist. */
export function suggestVars(ctx: Ctx, userId: string): Record<string, string> {
  const u = rows(ctx, 'users').find((x) => x.id === userId)
  if (!u) return {}
  const out: Record<string, string> = {}
  const desig = masterName(ctx, 'designations', u.designation_id) || u.title
  out.offer_designation = desig
  out.new_designation = desig
  out.last_designation = desig
  out.proposed_joining_date = longDate(u.joined_on)
  out.probation_months = '6'
  out.notice_period_days = '60'
  const end = addDays(u.joined_on, 182)
  out.probation_end_date = longDate(addDays(end, -1))
  out.confirmation_date = longDate(end)
  out.offer_valid_until = longDate(addDays(ctx.today, 7))
  out.effective_date = longDate(ctx.today)
  out.term_years = '3'
  const org = getDb().tenants.find((t) => t.id === ctx.tenant.id)?.org
  if (org?.city) out.governing_city = org.city
  const shift = rows(ctx, 'shifts').find((x) => x.id === u.shift_id) ?? rows(ctx, 'shifts').find((x) => x.is_default && x.active)
  if (shift) {
    out.reporting_time = hm(shift.start_time)
    const days = [...shift.working_days].sort()
    const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
    out.working_hours = `${hm(shift.start_time)} to ${hm(shift.end_time)}, ${contiguous && days.length > 1 ? `${DAY[days[0]]} to ${DAY[days[days.length - 1]]}` : days.map((d) => DAY[d]).join(', ')}`
  }
  const exit = rows(ctx, 'lifecycle_checklists').find((c) => c.kind === 'offboarding' && c.user_id === u.id && c.last_day)
  if (exit?.last_day) out.last_working_day = longDate(exit.last_day)
  if (has(ctx, 'cost_rates.view')) {
    const rates = rows(ctx, 'cost_rates').filter((r) => r.user_id === u.id).sort((a, b) => a.effective_from.localeCompare(b.effective_from))
    const cur = rateOn(rates, u.id, ctx.today)
    if (cur) {
      out.ctc_monthly = fmtMoney(cur.monthly_ctc_paise)
      out.ctc_annual = fmtMoney(cur.monthly_ctc_paise * 12)
      const prev = rates.filter((r) => r.effective_from < cur.effective_from).pop()
      out.new_ctc = out.ctc_annual
      if (prev) {
        out.old_ctc = fmtMoney(prev.monthly_ctc_paise * 12)
        out.hike_pct = (((cur.monthly_ctc_paise - prev.monthly_ctc_paise) / prev.monthly_ctc_paise) * 100).toFixed(1)
        out.effective_from = longDate(cur.effective_from)
        const fy = Number(cur.effective_from.slice(0, 4)) - (Number(cur.effective_from.slice(5, 7)) < 4 ? 1 : 0)
        out.appraisal_period = `FY ${fy - 1}-${String(fy).slice(2)}`
      }
    }
  }
  return out
}

/* ---------------- issuing ---------------- */
const cleanVars = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => /^\w+$/.test(k) && !STANDARD_KEYS.has(k)).map(([k, x]) => [k, String(x ?? '').trim().slice(0, 2000)])) : {}

/** Only the suggestions this template actually uses. */
function pick(sug: Record<string, string>, t: DocTemplate) {
  const used = new Set(placeholdersIn(t.body))
  return Object.fromEntries(Object.entries(sug).filter(([k]) => used.has(k)))
}
function readIssue(ctx: Ctx, t: DocTemplate, b: Record<string, unknown>) {
  if (!t.active) err(409, 'TEMPLATE_INACTIVE', 'This template is switched off. Turn it on before issuing.')
  const ids = [...new Set((Array.isArray(b.employee_ids) ? b.employee_ids : []).map(String))]
  if (!ids.length) err(422, 'VALIDATION', 'Choose at least one employee.', 'employee_ids')
  if (ids.length > 100) err(422, 'VALIDATION', 'Issue to at most 100 employees at a time.', 'employee_ids')
  const people = ids.map((id) => {
    const u = rows(ctx, 'users').find((x) => x.id === id && !x.is_super_admin)
    if (!u) err(422, 'VALIDATION', 'One of the chosen employees no longer exists.', 'employee_ids')
    return u!
  })
  const shared = cleanVars(b.vars)
  const per = (b.per_employee && typeof b.per_employee === 'object' ? b.per_employee : {}) as Record<string, unknown>
  const fields = processPlaceholders(t.body, t.category, t.custom_placeholders ?? [])
  return { people, shared, per, fields }
}
function varsFor(shared: Record<string, string>, per: Record<string, unknown>, id: string, suggested: Record<string, string> = {}) {
  const own = cleanVars(per[id])
  const out: Record<string, string> = { ...suggested }
  for (const [k, v] of Object.entries({ ...shared, ...own })) if (v) out[k] = v
  return out
}

/* ---------------- payslips ---------------- */
export function generatePayslips(ctx: Ctx, runId: string, opts: { notify?: boolean; issued_on?: string } = {}): PayslipResult {
  ensureDocDefaults(ctx)
  const { run, lines } = payrollRunLines(ctx, runId)
  if (run.status !== 'final') err(409, 'PAY_NOT_FINAL', 'Finalise the payroll run first. Payslips are issued only from a final run.')
  const tpl = rows(ctx, 'doc_templates').find((t) => t.key === 'payslip' && t.active) ?? rows(ctx, 'doc_templates').find((t) => t.category === 'payslip' && t.active)
  if (!tpl) err(422, 'TEMPLATE_MISSING', 'There is no active payslip template. Turn one on under Documents → Templates.')
  const existing = rows(ctx, 'issued_documents').filter((d) => d.source.kind === 'payroll' && d.source.ref_id === run.id && d.status !== 'revoked')
  const { from, to } = monthRange(run.month)
  const org = getDb().tenants.find((t) => t.id === ctx.tenant.id)?.org
  const out: PayslipResult = { created: 0, skipped_existing: 0, skipped_no_ctc: [], total: lines.length }
  const m = (p: number) => fmtMoney(p, { decimals: true })
  const days = (n: number) => (n % 1 ? n.toFixed(1) : String(n))
  for (const l of lines) {
    if (existing.some((d) => d.employee_id === l.user_id)) {
      out.skipped_existing++
      continue
    }
    if (l.no_rate || !l.monthly_ctc_paise) {
      out.skipped_no_ctc.push(l.user.name)
      continue
    }
    const base = l.base_paise
    const basic = Math.round(base * 0.5)
    const hra = Math.round(base * 0.2)
    const special = base - basic - hra
    const pending = l.pending_days ?? 0
    const unapp = l.deduct_applied ? l.unapproved_days + pending : 0
    const totalDays = l.lwp_days + unapp
    const lwpDed = totalDays ? Math.round((l.deduction_paise * l.lwp_days) / totalDays) : 0
    const unappDed = l.deduction_paise - lwpDed
    const earnings = [`| Basic (50% of fixed pay) | ${m(basic)} |`, `| House rent allowance (20% of fixed pay) | ${m(hra)} |`, `| Special allowance | ${m(special)} |`]
    if (l.variable_paise) earnings.push(`| Sales variable pay | ${m(l.variable_paise)} |`)
    const deductions = [`| Leave without pay (${days(l.lwp_days)} days) | ${m(lwpDed)} |`]
    if (l.deduct_applied) deductions.push(`| Unapproved timesheet days (${days(unapp)} days) | ${m(unappDed)} |`)
    const gross = base + l.variable_paise
    const paid = Math.max(0, l.working_days - l.lwp_days - unapp)
    issueDocument(ctx, {
      template_id: tpl!.id, employee_id: l.user_id, period: run.month, title: `Payslip — ${monthLabel(run.month)}`, source: { kind: 'payroll', ref_id: run.id },
      notify: opts.notify, issued_on: opts.issued_on,
      vars: {
        month_label: monthLabel(run.month), pay_period: `${shortDate(from)} – ${shortDate(to)}`, working_days: days(l.working_days), paid_days: days(paid), lwp_days: days(l.lwp_days), unapproved_days: days(unapp),
        earnings_rows: earnings.join('\n'), deductions_rows: deductions.join('\n'), monthly_ctc: m(l.monthly_ctc_paise), gross_earnings: m(gross), total_deductions: m(l.deduction_paise), variable_pay: m(l.variable_paise),
        net_pay: m(l.net_paise), net_pay_words: rupeesInWords(l.net_paise), bank_name: org?.bank_name ? `Bank transfer from ${org.bank_name}` : 'Bank transfer', pay_date: longDate(run.finalised_at?.slice(0, 10) ?? ctx.today),
      },
    })
    out.created++
  }
  if (out.created) logActivity(ctx, 'payroll_run', run.id, 'payslips', `Issued ${out.created} payslip${out.created === 1 ? '' : 's'} for ${monthLabel(run.month)}`)
  return out
}

/* ---------------- onboarding ---------------- */
const hm = (t: string) => {
  const [h, m] = t.split(':').map(Number)
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
}
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** Joining letter for a new employee (Create employee → "Issue joining letter"). Vars come from their shift and CTC. */
export function issueJoiningLetter(ctx: Ctx, userId: string, monthlyCtcPaise: number | null): IssuedDocument {
  const u = find(ctx, 'users', userId, 'Employee')
  const shift = rows(ctx, 'shifts').find((x) => x.id === u.shift_id) ?? rows(ctx, 'shifts').find((x) => x.is_default && x.active)
  const days = shift ? [...shift.working_days].sort() : [1, 2, 3, 4, 5]
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const dayText = contiguous && days.length > 1 ? `${DAY[days[0]]} to ${DAY[days[days.length - 1]]}` : days.map((d) => DAY[d]).join(', ')
  return issueDocument(ctx, {
    template_key: 'joining_letter', employee_id: u.id, source: { kind: 'onboarding', ref_id: u.id },
    vars: {
      ctc_annual: monthlyCtcPaise ? fmtMoney(monthlyCtcPaise * 12) : 'As per your offer letter', ctc_monthly: monthlyCtcPaise ? fmtMoney(monthlyCtcPaise) : 'As per your offer letter',
      reporting_time: shift ? hm(shift.start_time) : '9:30 AM', working_hours: shift ? `${hm(shift.start_time)} to ${hm(shift.end_time)}, ${dayText}` : '9:30 AM to 6:30 PM, Monday to Friday',
      probation_months: '6', notice_period_days: '60',
    },
  })
}

/* ---------------- routes ---------------- */
export function register(r: Router) {
  /* ---- templates ---- */
  r.get('/doc-templates', ({ ctx }) => {
    requireAction(ctx, 'documents.templates', 'Document templates are for HR.')
    boot(ctx)
    const issued = rows(ctx, 'issued_documents')
    return rows(ctx, 'doc_templates')
      .map((t) => templateRow(ctx, t, issued))
      .sort((a, b) => Number(b.active) - Number(a.active) || CATS.indexOf(a.category) - CATS.indexOf(b.category) || a.name.localeCompare(b.name))
  })
  r.get('/doc-templates/sample/:employeeId', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Document templates are for HR.')
    find(ctx, 'users', params.employeeId, 'Employee')
    return { ...standardVars(ctx, params.employeeId), ref_no: 'Assigned when issued' }
  })
  r.get('/doc-templates/suggest/:employeeId', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Document templates are for HR.')
    find(ctx, 'users', params.employeeId, 'Employee')
    return suggestVars(ctx, params.employeeId)
  })
  r.get('/doc-templates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Document templates are for HR.')
    boot(ctx)
    return templateRow(ctx, find(ctx, 'doc_templates', params.id, 'Template'))
  })
  r.post('/doc-templates', ({ ctx, body }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can create document templates.')
    const v = readTemplate(ctx, body)
    const t = insert(ctx, 'doc_templates', { key: slug(ctx, v.name), ...v, placeholders: placeholdersIn(v.body), updated_by: ctx.user.id } as never) as DocTemplate
    logActivity(ctx, 'doc_template', t.id, 'created', `Created the “${t.name}” template`)
    return templateRow(ctx, t)
  })
  r.patch('/doc-templates/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can edit document templates.')
    const cur = find(ctx, 'doc_templates', params.id, 'Template')
    const v = readTemplate(ctx, body, cur)
    if (cur.key === 'payslip' && v.category !== 'payslip') err(409, 'VALIDATION', 'The payroll payslip template must stay in the Payslip category.', 'category')
    const t = update(ctx, 'doc_templates', cur.id, { ...v, placeholders: placeholdersIn(v.body), updated_by: ctx.user.id }, ifMatch)
    logActivity(ctx, 'doc_template', t.id, 'updated', `${v.active !== cur.active ? (v.active ? 'Turned on' : 'Turned off') : 'Edited'} the “${t.name}” template`)
    return templateRow(ctx, t)
  })
  r.post('/doc-templates/:id/duplicate', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can create document templates.')
    const cur = find(ctx, 'doc_templates', params.id, 'Template')
    let name = `${cur.name} (copy)`
    for (let i = 2; rows(ctx, 'doc_templates').some((t) => t.name.toLowerCase() === name.toLowerCase()); i++) name = `${cur.name} (copy ${i})`
    const t = insert(ctx, 'doc_templates', { key: slug(ctx, name), name, category: cur.category, body: cur.body, description: cur.description ?? '', placeholders: placeholdersIn(cur.body), custom_placeholders: [...(cur.custom_placeholders ?? [])], letterhead: cur.letterhead, active: false, updated_by: ctx.user.id } as never) as DocTemplate
    logActivity(ctx, 'doc_template', t.id, 'created', `Duplicated “${cur.name}” as “${name}”`)
    return templateRow(ctx, t)
  })
  r.del('/doc-templates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can delete document templates.')
    const t = find(ctx, 'doc_templates', params.id, 'Template')
    if (rows(ctx, 'issued_documents').some((d) => d.template_id === t.id)) err(409, 'TEMPLATE_IN_USE', 'Documents were issued from this template, so it can’t be deleted. Turn it off instead.')
    if (t.key === 'payslip') err(409, 'TEMPLATE_IN_USE', 'Payroll issues payslips from this template. Edit it instead of deleting it.')
    remove(ctx, 'doc_templates', t.id)
    logActivity(ctx, 'doc_template', t.id, 'deleted', `Deleted the “${t.name}” template`)
    return { ok: true }
  })

  r.post('/doc-templates/:id/preview', ({ ctx, params, body }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can issue documents.')
    const t = find(ctx, 'doc_templates', params.id, 'Template')
    const { people, shared, per } = readIssue(ctx, { ...t, active: true }, body)
    return people.map<IssuePreviewItem>((u) => {
      const vars = { ...standardVars(ctx, u.id), ref_no: 'Assigned when issued', ...varsFor(shared, per, u.id, pick(suggestVars(ctx, u.id), t)) }
      const { body_html, missing } = renderBody(t.body, vars)
      return { employee_id: u.id, name: u.name, title: String(body.title ?? '').trim() || `${t.name} — ${u.name}`, body_html, missing: missing.filter((k) => k !== 'ref_no') }
    })
  }, { allowViewAsWrite: true })

  r.post('/doc-templates/:id/issue', ({ ctx, params, body }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can issue documents.')
    const t = find(ctx, 'doc_templates', params.id, 'Template')
    const { people, shared, per, fields } = readIssue(ctx, t, body)
    const status = body.status === 'draft' ? 'draft' : 'issued'
    if (t.category === 'payslip' && status === 'issued' && !body.allow_manual_payslip) warn(ctx, 'MANUAL_PAYSLIP', 'Payslips are normally issued from a finalised payroll run, so the numbers match payroll.')
    if (status === 'issued')
      for (const u of people) {
        const v = varsFor(shared, per, u.id, pick(suggestVars(ctx, u.id), t))
        const missing = fields.filter((f) => !v[f.key])
        if (missing.length) err(422, 'VALIDATION', `Fill ${missing.map((f) => f.label.toLowerCase()).join(', ')}${people.length > 1 ? ` for ${u.name}` : ''} before issuing, or save as a draft.`, missing[0].key)
      }
    const title = String(body.title ?? '').trim().slice(0, 140)
    const created = people.map((u) => issueDocument(ctx, { template_id: t.id, employee_id: u.id, vars: varsFor(shared, per, u.id, pick(suggestVars(ctx, u.id), t)), status, title: title ? (people.length > 1 ? `${title} — ${u.name}` : title) : undefined }))
    const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
    return { created: created.map((d) => issuedRow(ctx, d, users)), emailed: created.filter((d) => d.emailed_to).length }
  })

  /* ---- issued documents ---- */
  r.get('/issued-docs', ({ ctx, query }) => {
    boot(ctx)
    const mine = !!query.mine
    const emp = query.employee_id ? String(query.employee_id) : null
    if (!mine && !has(ctx, 'documents.templates') && !(emp && (emp === ctx.user.id || has(ctx, 'documents.employee_files')))) err(403, 'FORBIDDEN', 'You can see only your own documents.')
    let list = rows(ctx, 'issued_documents').filter((d) => canSeeIssued(ctx, d))
    if (mine) list = list.filter((d) => d.employee_id === ctx.user.id && d.status !== 'draft')
    if (emp) list = list.filter((d) => d.employee_id === emp)
    if (query.category) list = list.filter((d) => d.category === query.category)
    if (query.status) list = list.filter((d) => d.status === query.status)
    if (query.run_id) list = list.filter((d) => d.source.kind === 'payroll' && d.source.ref_id === query.run_id)
    const day = (d: IssuedDocument) => d.issued_on ?? d.created_at.slice(0, 10)
    if (query.from) list = list.filter((d) => day(d) >= String(query.from))
    if (query.to) list = list.filter((d) => day(d) <= String(query.to))
    const users = new Map(rows(ctx, 'users').map((u) => [u.id, u]))
    let out = list.map((d) => issuedRow(ctx, d, users))
    const q = String(query.q ?? '').trim().toLowerCase()
    if (q) out = out.filter((d) => [d.title, d.employee_name, d.employee_code, d.ref_no, d.template_name ?? ''].join(' ').toLowerCase().includes(q))
    return out.sort((a, b) => (b.issued_on ?? b.created_at).localeCompare(a.issued_on ?? a.created_at) || b.created_at.localeCompare(a.created_at))
  })
  r.get('/issued-docs/:id', ({ ctx, params }) => issuedDetail(ctx, loadIssued(ctx, params.id)))

  r.patch('/issued-docs/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can edit documents.')
    const d = loadIssued(ctx, params.id)
    if (d.status !== 'draft') err(409, 'NOT_DRAFT', 'Only drafts can be edited. Re-issue the document to correct it.')
    const tpl = d.template_id ? rows(ctx, 'doc_templates').find((t) => t.id === d.template_id) : null
    if (!tpl) err(409, 'TEMPLATE_MISSING', 'The template of this draft no longer exists.')
    const vars = { ...(d.vars ?? {}), ...cleanVars(body.vars) }
    const title = body.title !== undefined ? String(body.title ?? '').trim().slice(0, 140) : d.title
    if (title.length < 3) err(422, 'VALIDATION', 'Give the document a title.', 'title')
    const { body_md, body_html } = renderBody(tpl!.body, { ...standardVars(ctx, d.employee_id), ...vars })
    const u = update(ctx, 'issued_documents', d.id, { vars, title, body_md, body_html }, ifMatch)
    logActivity(ctx, 'issued_document', d.id, 'updated', `Edited the draft “${title}”`)
    return issuedDetail(ctx, u)
  })
  r.post('/issued-docs/:id/issue', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can issue documents.')
    const d = loadIssued(ctx, params.id)
    if (d.status !== 'draft') err(409, 'NOT_DRAFT', 'This document is already issued.')
    const tpl = d.template_id ? rows(ctx, 'doc_templates').find((t) => t.id === d.template_id) : null
    if (!tpl) err(409, 'TEMPLATE_MISSING', 'The template of this draft no longer exists.')
    const missing = processPlaceholders(tpl!.body, tpl!.category, tpl!.custom_placeholders ?? []).filter((f) => !d.vars?.[f.key])
    if (missing.length) err(422, 'VALIDATION', `Fill ${missing.map((f) => f.label.toLowerCase()).join(', ')} before issuing.`, missing[0].key)
    const { body_md, body_html } = renderBody(tpl!.body, { ...standardVars(ctx, d.employee_id), ...(d.vars ?? {}) })
    const u = update(ctx, 'issued_documents', d.id, { status: 'issued', issued_on: ctx.today, issued_by: ctx.user.id, body_md, body_html })
    logActivity(ctx, 'issued_document', d.id, 'issued', `Issued “${d.title}” (${d.ref_no}) to ${userName(ctx, d.employee_id)}`)
    announceIssued(ctx, u)
    persist()
    return issuedDetail(ctx, u)
  })
  r.post('/issued-docs/:id/revoke', ({ ctx, params, body }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can revoke documents.')
    const d = loadIssued(ctx, params.id)
    if (d.status === 'draft') err(409, 'NOT_ISSUED', 'Drafts are deleted, not revoked.')
    if (d.status === 'revoked') err(409, 'REVOKED', 'This document is already revoked.')
    const reason = String(body.reason ?? '').trim()
    if (reason.length < 5) err(422, 'VALIDATION', 'Say why the document is revoked (at least 5 characters).', 'reason')
    const u = update(ctx, 'issued_documents', d.id, { status: 'revoked', revoked_on: ctx.today, revoked_by: ctx.user.id, revoke_reason: reason.slice(0, 500) })
    notify(ctx, d.employee_id, 'NTF-06', 'Document revoked', `“${d.title}” was revoked by ${ctx.user.name}: ${reason}`, `/documents/issued/${d.id}`)
    logActivity(ctx, 'issued_document', d.id, 'revoked', `Revoked “${d.title}” (${d.ref_no}): ${reason}`)
    return issuedDetail(ctx, u)
  })
  r.post('/issued-docs/:id/reissue', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can issue documents.')
    const d = loadIssued(ctx, params.id)
    if (d.status === 'draft') err(409, 'NOT_ISSUED', 'Issue the draft instead.')
    if (d.replaced_by_id) err(409, 'ALREADY_REISSUED', 'This document was already re-issued. Open the newer copy.')
    const tpl = d.template_id ? rows(ctx, 'doc_templates').find((t) => t.id === d.template_id && t.active) : null
    if (!tpl) err(409, 'TEMPLATE_INACTIVE', 'The template is switched off or deleted. Turn it on to re-issue.')
    const vars = Object.fromEntries(Object.entries(d.vars ?? {}).filter(([k]) => k !== 'ref_no'))
    const n = issueDocument(ctx, { template_id: tpl!.id, employee_id: d.employee_id, vars, title: d.title, period: d.period, source: d.source })
    n.replaces_id = d.id
    const old = update(ctx, 'issued_documents', d.id, { replaced_by_id: n.id, ...(d.status !== 'revoked' ? { status: 'revoked' as const, revoked_on: ctx.today, revoked_by: ctx.user.id, revoke_reason: `Replaced by ${n.ref_no}` } : {}) })
    void old
    persist()
    logActivity(ctx, 'issued_document', n.id, 'reissued', `Re-issued “${d.title}” as ${n.ref_no} (replaces ${d.ref_no})`)
    return issuedDetail(ctx, n)
  })
  r.post('/issued-docs/:id/ack', ({ ctx, params }) => {
    const d = loadIssued(ctx, params.id)
    if (d.employee_id !== ctx.user.id) err(403, 'FORBIDDEN', 'Only the employee it was issued to can acknowledge a document.')
    if (d.status === 'acknowledged') return issuedDetail(ctx, d)
    if (d.status !== 'issued') err(409, 'NOT_ISSUED', d.status === 'revoked' ? 'This document was revoked and no longer needs acknowledgement.' : 'This document has not been issued yet.')
    const u = update(ctx, 'issued_documents', d.id, { status: 'acknowledged', acknowledged_on: ctx.today })
    logActivity(ctx, 'issued_document', d.id, 'acknowledged', `${ctx.user.name} acknowledged “${d.title}” (${d.ref_no})`)
    if (d.issued_by !== ctx.user.id) notify(ctx, d.issued_by, 'NTF-05', 'Document acknowledged', `${ctx.user.name} acknowledged “${d.title}”.`, `/documents/issued/${d.id}`)
    return issuedDetail(ctx, u)
  })
  r.del('/issued-docs/:id', ({ ctx, params }) => {
    requireAction(ctx, 'documents.templates', 'Only HR can delete drafts.')
    const d = loadIssued(ctx, params.id)
    if (d.status !== 'draft') err(409, 'NOT_DRAFT', 'Issued documents can’t be deleted. Revoke it instead.')
    remove(ctx, 'issued_documents', d.id)
    logActivity(ctx, 'issued_document', d.id, 'deleted', `Deleted the draft “${d.title}”`)
    return { ok: true }
  })

  /* ---- payslips from payroll ---- */
  r.get('/payroll/:id/payslips', ({ ctx, params }) => {
    requireAny(ctx, ['payroll.run', 'documents.templates'], 'Payslips are for payroll and HR.')
    boot(ctx)
    const run = find(ctx, 'payroll_runs', params.id, 'Payroll run')
    const lines = rows(ctx, 'payroll_lines').filter((l) => l.run_id === run.id && l.monthly_ctc_paise > 0)
    const docs = rows(ctx, 'issued_documents').filter((d) => d.source.kind === 'payroll' && d.source.ref_id === run.id && d.status !== 'revoked')
    return {
      run_id: run.id, month: run.month, run_status: run.status, eligible: lines.length, issued: docs.length, acknowledged: docs.filter((d) => d.status === 'acknowledged').length,
      can_generate: run.status === 'final' && hasAny(ctx, 'payroll.run', 'documents.templates'),
    } satisfies PayslipStatus
  })
  r.post('/payroll/:id/payslips', ({ ctx, params }) => {
    requireAny(ctx, ['payroll.run', 'documents.templates'], 'Payslips are for payroll and HR.')
    const res = generatePayslips(ctx, params.id)
    if (res.skipped_no_ctc.length) warn(ctx, 'NO_CTC', `No payslip for ${res.skipped_no_ctc.join(', ')}: no CTC on record for the month.`)
    return res
  })

  /* ---- employee documents ---- */
  r.get('/employee-docs/people', ({ ctx, query }) => {
    requireAction(ctx, 'documents.employee_files', 'Employee documents are for HR.')
    boot(ctx)
    const docs = rows(ctx, 'employee_documents')
    const issued = rows(ctx, 'issued_documents').filter((d) => d.status !== 'draft' && d.status !== 'revoked')
    return rows(ctx, 'users')
      .filter((u) => !u.is_super_admin && (query.all ? true : u.status === 'active'))
      .map<EmployeeSummaryRow>((u) => {
        const mine = docs.filter((d) => d.employee_id === u.id)
        return {
          user_id: u.id, name: u.name, code: u.employee_code ?? '', department: masterName(ctx, 'departments', u.department_id), designation: masterName(ctx, 'designations', u.designation_id) || u.title,
          avatar_hue: u.avatar_hue, docs: mine.length, verified: mine.filter((d) => d.status === 'verified').length, pending: mine.filter((d) => d.status === 'pending').length,
          rejected: mine.filter((d) => d.status === 'rejected').length, expiring: mine.filter((d) => ['expiring', 'expired'].includes(expiryState(d, ctx.today) ?? '')).length,
          missing: missingOf(mine), issued: issued.filter((d) => d.employee_id === u.id).length,
        }
      })
      .sort((a, b) => b.pending - a.pending || b.missing.length - a.missing.length || a.name.localeCompare(b.name))
  })
  r.get('/employee-docs/person/:userId', ({ ctx, params }) => {
    boot(ctx)
    const self = params.userId === ctx.user.id || params.userId === 'me'
    const id = params.userId === 'me' ? ctx.user.id : params.userId
    if (!self && !has(ctx, 'documents.employee_files')) err(403, 'FORBIDDEN', 'You can see only your own documents.')
    const u = find(ctx, 'users', id, 'Employee') as User
    if (u.is_super_admin) err(404, 'NOT_FOUND', 'Employee not found.')
    const docs = rows(ctx, 'employee_documents').filter((d) => d.employee_id === u.id)
    const users = new Map(rows(ctx, 'users').map((x) => [x.id, x]))
    const issued = rows(ctx, 'issued_documents').filter((d) => d.employee_id === u.id && canSeeIssued(ctx, d) && (d.status !== 'draft' || has(ctx, 'documents.templates')))
    return {
      user: { id: u.id, name: u.name, code: u.employee_code ?? '', department: masterName(ctx, 'departments', u.department_id), designation: masterName(ctx, 'designations', u.designation_id) || u.title, email: u.email, joined_on: u.joined_on, manager_name: u.reports_to_id ? userName(ctx, u.reports_to_id) : '', avatar_hue: u.avatar_hue, status: u.status },
      docs: docs.map((d) => empDocRow(ctx, d)).sort((a, b) => (b.uploaded_on ?? b.created_at).localeCompare(a.uploaded_on ?? a.created_at)),
      issued: issued.map((d) => issuedRow(ctx, d, users)).sort((a, b) => (b.issued_on ?? b.created_at).localeCompare(a.issued_on ?? a.created_at)),
      missing: missingOf(docs),
      can_verify: has(ctx, 'documents.employee_files') && u.id !== ctx.user.id,
      can_upload: self || has(ctx, 'documents.employee_files'),
      can_issue: has(ctx, 'documents.templates'),
    } satisfies EmployeeFile
  })
  r.post('/employee-docs', ({ ctx, body }) => {
    const eid = body.employee_id ? String(body.employee_id) : ctx.user.id
    const onBehalf = eid !== ctx.user.id
    if (onBehalf) requireAction(ctx, 'documents.employee_files', 'You can upload only your own documents.')
    const emp = find(ctx, 'users', eid, 'Employee')
    const kind = String(body.kind ?? '') as EmployeeDocument['kind']
    if (!KINDS.includes(kind)) err(422, 'VALIDATION', 'Choose what kind of document this is.', 'kind')
    const title = String(body.title ?? '').trim()
    if (title.length < 3 || title.length > 120) err(422, 'VALIDATION', 'Give the document a title of 3 to 120 characters.', 'title')
    const f = body.file as { name?: string; mime?: string; size_bytes?: number; data_url?: string } | null
    if (!f) err(422, 'VALIDATION', 'Attach the scanned document.', 'file')
    const name = String(f!.name ?? '').trim()
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    if (!EXT_MIME[ext]) err(422, 'FILE_REJECTED', 'Use a PDF, PNG, JPG or DOCX file.', 'file')
    const size = Number(f!.size_bytes ?? 0)
    if (!(size > 0)) err(422, 'FILE_REJECTED', 'The file is empty. Choose another file.', 'file')
    if (size > MAX_EMP_BYTES) err(422, 'FILE_REJECTED', 'The file is larger than 5 MB. Scan at a lower resolution and try again.', 'file')
    if (typeof f!.data_url !== 'string' || !f!.data_url.startsWith('data:')) err(422, 'FILE_REJECTED', 'The file could not be read. Choose it again.', 'file')
    const expires = body.expires_on ? String(body.expires_on) : null
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) err(422, 'VALIDATION', 'Enter a valid expiry date.', 'expires_on')
    if (kind === 'passport' && !expires) err(422, 'VALIDATION', 'Enter the passport’s expiry date.', 'expires_on')
    if (expires && expires < ctx.today) warn(ctx, 'EXPIRED', 'This document has already expired. Upload the renewed one when you have it.')
    const verified = onBehalf // HR uploading on the employee's behalf has checked the original
    const d = insert(ctx, 'employee_documents', {
      employee_id: emp.id, kind, title, file_id: null, uploaded_by: ctx.user.id, verified_by: verified ? ctx.user.id : null, verified_on: verified ? ctx.today : null,
      status: verified ? 'verified' : 'pending', note: String(body.note ?? '').trim().slice(0, 500), expires_on: expires, doc_number: String(body.doc_number ?? '').trim().slice(0, 40) || null,
      file_name: name, mime: EXT_MIME[ext], size_bytes: size, uploaded_on: ctx.today, review_note: null,
    } as never) as EmployeeDocument
    const file = insert(ctx, 'files', { name, mime: EXT_MIME[ext], size_bytes: size, entity: 'employee_document', entity_id: d.id, data_url: f!.data_url } as never)
    d.file_id = file.id
    persist()
    logActivity(ctx, 'employee_document', d.id, 'uploaded', onBehalf ? `Uploaded “${title}” for ${emp.name}` : `Uploaded “${title}” for verification`)
    if (onBehalf) notify(ctx, emp.id, 'NTF-14', 'Document added to your file', `${ctx.user.name} added “${title}” to your employee documents.`, '/documents?tab=mine')
    else
      for (const hr of usersWith(ctx, 'documents.employee_files').filter((u) => u.id !== ctx.user.id && u.role_key !== 'administrator' && u.role_key !== 'ceo'))
        notify(ctx, hr.id, 'NTF-14', 'Document to verify', `${ctx.user.name} uploaded “${title}” (${kind.replace('_', ' ')}).`, `/documents/employees/${ctx.user.id}`)
    return empDocRow(ctx, d)
  })
  for (const action of ['verify', 'reject'] as const)
    r.post(`/employee-docs/:id/${action}`, ({ ctx, params, body }) => {
      requireAction(ctx, 'documents.employee_files', 'Only HR can verify employee documents.')
      const d = find(ctx, 'employee_documents', params.id, 'Document')
      if (d.employee_id === ctx.user.id) err(403, 'SELF_VERIFY', 'Someone else in HR must verify your own documents.')
      if (d.status !== 'pending') err(409, 'NOT_PENDING', `This document is already ${d.status}.`)
      const note = String(body.note ?? '').trim()
      if (action === 'reject' && note.length < 10) err(422, 'VALIDATION', 'Tell the employee what is wrong and what to upload instead (at least 10 characters).', 'note')
      const u = update(ctx, 'employee_documents', d.id, { status: action === 'verify' ? 'verified' : 'rejected', verified_by: ctx.user.id, verified_on: ctx.today, review_note: note || null })
      notify(ctx, d.employee_id, action === 'verify' ? 'NTF-05' : 'NTF-06', action === 'verify' ? 'Document verified' : 'Document rejected', action === 'verify' ? `${ctx.user.name} verified “${d.title}”.` : `${ctx.user.name} rejected “${d.title}”: ${note}`, '/documents?tab=mine')
      logActivity(ctx, 'employee_document', d.id, action === 'verify' ? 'verified' : 'rejected', `${action === 'verify' ? 'Verified' : 'Rejected'} “${d.title}” of ${userName(ctx, d.employee_id)}${note ? `: ${note}` : ''}`)
      return empDocRow(ctx, u)
    })
  r.del('/employee-docs/:id', ({ ctx, params }) => {
    const d = find(ctx, 'employee_documents', params.id, 'Document')
    const own = d.employee_id === ctx.user.id
    if (!own && !has(ctx, 'documents.employee_files')) err(404, 'NOT_FOUND', 'Document not found.')
    if (own && !has(ctx, 'documents.employee_files') && d.status === 'verified') err(409, 'VERIFIED', 'Verified documents can be removed only by HR. Upload a newer copy instead.')
    remove(ctx, 'employee_documents', d.id)
    const db = getDb()
    db.files = db.files.filter((f) => !(f.tenant_id === ctx.tenant.id && f.entity === 'employee_document' && f.entity_id === d.id))
    persist()
    logActivity(ctx, 'employee_document', d.id, 'deleted', `Removed “${d.title}” of ${userName(ctx, d.employee_id)}`)
    return { ok: true }
  })
  r.get('/employee-docs/:id/file', ({ ctx, params }) => {
    const d = find(ctx, 'employee_documents', params.id, 'Document')
    if (d.employee_id !== ctx.user.id && !has(ctx, 'documents.employee_files')) err(404, 'NOT_FOUND', 'Document not found.')
    const f = d.file_id ? getDb().files.find((x) => x.id === d.file_id && x.tenant_id === ctx.tenant.id) : null
    return { file_name: d.file_name ?? f?.name ?? 'document', mime: d.mime ?? f?.mime ?? 'application/octet-stream', data_url: f?.data_url ?? null }
  })

  void nowISO
  void labelOf
  void CATEGORY_PLACEHOLDERS
}
