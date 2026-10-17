// v7 document generation contract (owner: documents workstream; others call issueDocument).
// Renders a DocTemplate (by key or id) for an employee with {{placeholders}} and stores an IssuedDocument
// that the employee can open under Documents → My documents. Standard placeholders are filled automatically
// (employee_name, employee_code, designation, department, joining_date, company, company_address, today…);
// `vars` adds/overrides process-specific ones (e.g. new_ctc, hike_pct, effective_from).
// When the document is issued (not a draft) the employee is notified in the app and by email.
import type { DocTemplate, IssuedDocument } from '@/types/v7'
import type { User } from '@/types/entities'
import { sendEmail } from './email'
import { err, getDb, insert, logActivity, nextNumber, notify, nowISO, rows, type Ctx, type DB } from './server'
import { fillPlaceholders, markupToHtml, placeholdersIn, STANDARD_KEYS, CATEGORY_LABEL } from './docMarkup'
import { DEFAULT_DOC_TEMPLATES } from './seeds/documentsV7'

export interface IssueInput {
  template_key?: string
  template_id?: string
  employee_id: string
  vars?: Record<string, string | number | null | undefined>
  title?: string
  period?: string | null
  status?: 'draft' | 'issued'
  source?: IssuedDocument['source']
  /** default true: notify + email the employee when issued */
  notify?: boolean
  issued_on?: string
}

const EMPLOYMENT: Record<string, string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', intern: 'Intern' }
export const longDate = (iso: string | null | undefined) =>
  iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : ''

/** Standard placeholders straight from the DB (also used by the seed, which has no request context). */
export function standardVarsFor(db: DB, tenantId: string, employeeId: string, issuerId: string | null, today: string): Record<string, string> {
  const users = db.users.filter((x) => x.tenant_id === tenantId)
  const u = users.find((x) => x.id === employeeId)
  const issuer = issuerId ? users.find((x) => x.id === issuerId) : undefined
  const t = db.tenants.find((x) => x.id === tenantId)
  const o = t?.org
  const byId = <T extends { id: string; tenant_id: string }>(list: T[], id: string | null | undefined) => (id ? list.find((x) => x.id === id && x.tenant_id === tenantId) : undefined)
  const desig = (x: User | undefined) => byId(db.designations, x?.designation_id)?.name || x?.title || ''
  const grade = byId(db.grades, u?.grade_id)
  const address = [o?.registered_address, o?.city, [o?.state, o?.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  return {
    employee_name: u?.name ?? '',
    employee_first_name: (u?.name ?? '').split(' ')[0] ?? '',
    employee_code: u?.employee_code ?? '',
    employee_email: u?.email ?? '',
    employee_phone: u?.phone ?? '',
    designation: desig(u),
    department: byId(db.departments, u?.department_id)?.name ?? '',
    grade: grade ? `${grade.code} · ${grade.name}` : '',
    location: byId(db.locations, u?.location_id)?.name ?? '',
    employment_type: EMPLOYMENT[u?.employment_type ?? 'full_time'] ?? '',
    joining_date: longDate(u?.joined_on),
    manager_name: u?.reports_to_id ? users.find((x) => x.id === u.reports_to_id)?.name ?? '' : '',
    company: o?.legal_name || t?.name || '',
    company_brand: o?.brand_name || t?.name || '',
    company_address: address,
    company_city: o?.city ?? '',
    company_cin: o?.cin ?? '',
    company_gstin: o?.gstin ?? '',
    company_email: o?.email ?? '',
    company_phone: o?.phone ?? '',
    company_website: o?.website ?? '',
    signatory_name: issuer?.name ?? '',
    signatory_designation: desig(issuer),
    today: longDate(today),
  }
}

export function standardVars(ctx: Ctx, employeeId: string): Record<string, string> {
  return standardVarsFor(getDb(), ctx.tenant.id, employeeId, ctx.user.id, ctx.today)
}

/** Render a template body for an employee: fill placeholders, then lay out the markup as HTML. */
export function renderBody(body: string, vars: Record<string, string>) {
  const body_md = fillPlaceholders(body, vars)
  const missing = placeholdersIn(body).filter((k) => !String(vars[k] ?? '').trim())
  return { body_md, body_html: markupToHtml(body_md), missing }
}

const str = (v: Record<string, string | number | null | undefined> = {}) => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => [k, String(x)]))

/** Document reference number: <prefix>/HR/<year>/<seq> — or <prefix>/PAY/<period>/<code> for payslips. */
export function nextRef(ctx: Ctx, category: DocTemplate['category'], period: string | null, employeeCode: string): string {
  const prefix = getDb().tenants.find((t) => t.id === ctx.tenant.id)?.org?.employee_code_prefix || 'DOC'
  if (category === 'payslip' && period) return `${prefix}/PAY/${period}/${employeeCode || 'EMP'}`
  return `${prefix}/HR/${ctx.today.slice(0, 4)}/${String(nextNumber(ctx, 'doc_ref', 1)).padStart(4, '0')}`
}

/** Seed the default letter templates (and the two emails documents send) for a workspace that has none yet. */
export function ensureDocDefaults(ctx: Ctx) {
  const db = getDb()
  const tid = ctx.tenant.id
  const marker = db.number_sequences.find((s) => s.tenant_id === tid && s.scope === 'docs_v7_defaults')
  if (marker) return
  db.number_sequences.push({ tenant_id: tid, scope: 'docs_v7_defaults', next_value: 1 })
  provisionDocDefaults(db, tid, () => ({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, tenant_id: tid, created_at: nowISO(), updated_at: nowISO(), version: 1 }))
}

/** Default templates + document emails for a tenant (idempotent by key). Call from tenant provisioning. */
export function provisionDocDefaults(db: DB, tenantId: string, base: () => { id: string; tenant_id: string; created_at: string; updated_at: string; version: number }) {
  for (const t of DEFAULT_DOC_TEMPLATES)
    if (!db.doc_templates.some((x) => x.tenant_id === tenantId && x.key === t.key))
      db.doc_templates.push({ ...base(), ...t, placeholders: placeholdersIn(t.body), custom_placeholders: [], letterhead: true, active: true, updated_by: null } as DocTemplate)
  const mail = (key: 'payslip' | 'custom', name: string, subject: string, body: string) => {
    if (!db.email_templates.some((x) => x.tenant_id === tenantId && x.key === key)) db.email_templates.push({ ...base(), key, name, subject, body, active: true } as never)
  }
  mail('payslip', 'Payslip issued', 'Your payslip for {{month}} is ready', 'Hi {{employee_name}},\n\nYour payslip for {{month}} is ready. Net pay: {{net_pay}}.\n\nOpen it under Documents → My documents: {{login_url}}\n\n{{company}} HR')
  mail('custom', 'Document issued', 'A new document from {{company}}', 'Hi {{employee_name}},\n\n{{company}} HR has issued a document to you in SeereonOS. Open Documents → My documents to read it, download a PDF copy and acknowledge it:\n{{login_url}}\n\n{{company}} HR')
}

/** In-app notification + email to the employee for an issued document. */
export function announceIssued(ctx: Ctx, doc: IssuedDocument) {
  const u = rows(ctx, 'users').find((x) => x.id === doc.employee_id)
  if (!u) return null
  const isPayslip = doc.category === 'payslip'
  notify(ctx, u.id, 'NTF-14', isPayslip ? 'Payslip issued' : doc.category === 'other' ? 'New document issued' : `New ${CATEGORY_LABEL[doc.category].toLowerCase()}`, `${ctx.user.name} issued “${doc.title}”. Open it and acknowledge.`, `/documents/issued/${doc.id}`)
  const email = isPayslip
    ? sendEmail(ctx, 'payslip', { email: u.email, user_id: u.id }, { employee_name: u.name, month: doc.vars?.month_label ?? doc.period ?? '', net_pay: doc.vars?.net_pay ?? '' }, { entity: 'issued_document', id: doc.id })
    : sendEmail(ctx, 'custom', { email: u.email, user_id: u.id }, { employee_name: u.name }, { entity: 'issued_document', id: doc.id })
  if (email) doc.emailed_to = u.email
  return email
}

export function issueDocument(ctx: Ctx, input: IssueInput): IssuedDocument {
  ensureDocDefaults(ctx)
  const tpl = rows(ctx, 'doc_templates').find((x) => (input.template_id ? x.id === input.template_id : x.key === input.template_key) && x.active)
  if (!tpl) err(422, 'TEMPLATE_MISSING', `No active document template "${input.template_key ?? input.template_id}". Create it under Documents → Templates.`)
  const emp = rows(ctx, 'users').find((u) => u.id === input.employee_id)
  if (!emp) err(404, 'NOT_FOUND', 'Employee not found.')
  const status = input.status ?? 'issued'
  const std = standardVars(ctx, input.employee_id)
  const extra = str(input.vars)
  const ref_no = extra.ref_no || nextRef(ctx, tpl!.category, input.period ?? null, std.employee_code)
  const vars: Record<string, string> = { ...std, ref_no, ...extra }
  const { body_md, body_html } = renderBody(tpl!.body, vars)
  const procVars = Object.fromEntries(Object.entries(vars).filter(([k]) => !STANDARD_KEYS.has(k) || k === 'ref_no'))
  const doc = insert(ctx, 'issued_documents', {
    template_id: tpl!.id, category: tpl!.category, title: input.title ?? `${tpl!.name} — ${vars.employee_name}`, employee_id: input.employee_id,
    body_html, body_md, vars: procVars, letterhead: tpl!.letterhead, ref_no, period: input.period ?? null, status, issued_by: ctx.user.id,
    issued_on: status === 'issued' ? input.issued_on ?? ctx.today : null, acknowledged_on: null, source: input.source ?? { kind: 'manual', ref_id: null },
    revoked_on: null, revoked_by: null, revoke_reason: null, replaces_id: null, replaced_by_id: null, emailed_to: null,
  } as never) as IssuedDocument
  if (status === 'issued') {
    logActivity(ctx, 'issued_document', doc.id, 'issued', `Issued “${doc.title}” (${ref_no}) to ${emp!.name}`)
    if (input.notify !== false) announceIssued(ctx, doc)
  } else logActivity(ctx, 'issued_document', doc.id, 'drafted', `Saved a draft of “${doc.title}” for ${emp!.name}`)
  return doc
}
export const nowStamp = nowISO
