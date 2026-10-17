// v7 entities: standalone cost estimates, configurable multi-stage workflows, document templates & issued
// documents, employee documents, and GST invoice detail. Each workstream may EXTEND (add optional fields to)
// the interface it owns; never remove fields other modules rely on.
import type { Base, ID, ISODate, ISODateTime, Paise } from './entities'

/* ---------------- Project cost calculator (standalone estimates) — owner: estimates ---------------- */
export interface CostEstimate extends Base {
  name: string
  client: string
  deal_id: ID | null // prospect in the pipeline (optional)
  project_id: ID | null // set once converted into a project
  status: 'draft' | 'shared' | 'won' | 'lost' | 'converted'
  start_on: ISODate
  end_on: ISODate
  type: string
  billing_model: string
  milestones: { key: string; name: string; billing_amount_paise: Paise; start_on: ISODate | null; end_on: ISODate | null }[]
  /** user_id = a named person (CTC from cost rates); otherwise role_label + an assumed monthly CTC (not hired yet).
   *  from_on / to_on null = follow the milestone's dates. */
  resources: { id: string; user_id: ID | null; role_label: string | null; monthly_ctc_paise: Paise | null; milestone_key: string; pct: number; from_on: ISODate | null; to_on: ISODate | null }[]
  additional_costs: { id: string; category: string; description: string; amount_paise: Paise }[]
  maintenance_paise: Paise
  contingency_pct: number
  markup_pct: number | null // null only in responses redacted for viewers without salary access
  price_paise: Paise
  notes: string
  owner_id: ID
  // v7 estimates workstream (optional for older rows)
  number?: string // EST-001
  client_id?: ID | null // picked from the clients master (client keeps the display name)
  stream?: string | null // revenue stream suggested for the project
  description?: string
  scenario_of?: ID | null // root estimate this scenario was duplicated from
  scenario_label?: string | null // e.g. "Scenario B"
  shared_on?: ISODate | null
  decided_on?: ISODate | null // won / lost
  lost_reason?: string | null
  converted_on?: ISODate | null
  /** one entry per save: what the numbers were at that version (internal; never sent to viewers without estimates.manage) */
  revisions?: { version: number; at: ISODateTime; by: ID; note: string; price_paise: Paise; total_cost_paise: Paise | null; man_days: number }[]
}

/* ---------------- Workflow management (multi-stage, per-stage parameters) — owner: workflows ---------------- */
export type WfFieldType = 'rating' | 'text' | 'textarea' | 'number' | 'percent' | 'money' | 'select' | 'date' | 'checkbox' | 'file'
export interface WfField {
  key: string
  label: string
  type: WfFieldType
  required: boolean
  options?: string[]
  help?: string
  min?: number
  max?: number
  /** stage keys (or 'all' / 'subject') that may SEE this field's value; the owning stage always sees it */
  visible_to: string[]
  /** numeric cap taken from an earlier stage's field ("stage.field"), e.g. approved hike ≤ normalised hike */
  max_from?: string | null
  /** this stage's text field that must explain going above `max_from` (an override needs a reason) */
  override_field?: string | null
}
export type WfAssignee = 'subject' | 'reports_to' | 'skip_level' | 'department_head' | 'role' | 'user' | 'initiator'
export interface WfStage {
  key: string
  name: string // e.g. "Manager review"
  assignee: WfAssignee
  role_key?: string | null
  user_id?: ID | null
  sla_days: number
  fields: WfField[] // the parameters this reviewer fills
  can_send_back: boolean
  instructions?: string
  /** this stage sees compensation facts (current CTC, recommended / normalised hike, new CTC, budget impact) */
  sees_compensation?: boolean
}
export interface WfAction {
  type: 'generate_document' | 'send_email' | 'update_ctc' | 'notify' | 'create_task'
  template_key?: string | null // doc / email template
  config?: Record<string, unknown>
}
export type WfProcess = 'appraisal' | 'onboarding' | 'exit' | 'confirmation' | 'promotion' | 'expense' | 'leave' | 'document_approval' | 'general'
export interface WfTemplate extends Base {
  name: string
  process: WfProcess
  description: string
  active: boolean
  stages: WfStage[]
  on_complete: WfAction[]
  on_reject: WfAction[]
  /** structural revision; bumps on every saved change. Running instances keep the revision they started with. */
  rev?: number
  /** stable slug for built-in templates (e.g. annual_appraisal) */
  key?: string | null
  /** employees may start it about themselves without workflows.start */
  self_service?: boolean
  updated_by?: ID | null
}
export interface WfSnapshot {
  name: string
  process: WfProcess
  stages: WfStage[]
  on_complete: WfAction[]
  on_reject: WfAction[]
}
export interface WfInstance extends Base {
  template_id: ID
  title: string
  subject_user_id: ID | null // the employee the workflow is about (e.g. appraisee)
  initiated_by: ID
  status: 'in_progress' | 'completed' | 'rejected' | 'cancelled'
  current_stage: number
  current_assignee_id: ID | null
  stage_due_on: ISODate | null
  values: Record<string, Record<string, unknown>> // stage key → field key → value
  history: { stage_key: string; by: ID; action: 'submitted' | 'approved' | 'sent_back' | 'rejected' | 'reassigned' | 'started' | 'completed' | 'escalated' | 'cancelled'; note: string; at: ISODateTime; to?: ID | null }[]
  context: Record<string, unknown> // e.g. { cycle_id, appraisal_id, current_ctc_paise }
  outputs: { kind: string; ref_id: ID; label: string }[] // generated letters, emails, rate changes
  // v7 engine detail
  template_rev?: number
  snapshot?: WfSnapshot // the template as it was when the instance started
  stage_started_at?: ISODateTime | null
  escalated_stage?: number | null // stage index already escalated for SLA
  comments?: { id: string; by: ID; at: ISODateTime; body: string }[]
  completed_at?: ISODateTime | null
}

/* ---------------- Documents: templates, issued documents, employee documents — owner: documents ---------------- */
export interface DocTemplate extends Base {
  key: string // stable slug e.g. offer_letter
  name: string
  category: 'payslip' | 'offer_letter' | 'joining_letter' | 'appraisal_letter' | 'relieving_letter' | 'experience_letter' | 'confirmation_letter' | 'warning_letter' | 'nda' | 'policy' | 'other'
  body: string // rich text with {{placeholders}}
  placeholders: string[]
  letterhead: boolean
  active: boolean
  /** v7 documents: optional extras */
  description?: string
  custom_placeholders?: string[] // issuer-filled placeholders the author declared beyond the catalogue
  updated_by?: ID | null
}
export interface IssuedDocument extends Base {
  template_id: ID | null
  category: DocTemplate['category']
  title: string
  employee_id: ID
  body_html: string // rendered content
  period: string | null // e.g. payslip month "2026-09"
  status: 'draft' | 'issued' | 'acknowledged' | 'revoked'
  issued_by: ID
  issued_on: ISODate | null
  acknowledged_on: ISODate | null
  source: { kind: 'manual' | 'payroll' | 'workflow' | 'onboarding'; ref_id: ID | null }
  /** v7 documents: optional extras */
  ref_no?: string // e.g. SCI/HR/2026/0012
  body_md?: string // rendered markup (placeholders filled) — the PDF renderer lays this out
  vars?: Record<string, string> // values used to render (re-issue / edit draft)
  letterhead?: boolean
  revoked_on?: ISODate | null
  revoked_by?: ID | null
  revoke_reason?: string | null
  replaces_id?: ID | null // re-issued from this document
  replaced_by_id?: ID | null
  emailed_to?: string | null
}
export interface EmployeeDocument extends Base {
  employee_id: ID
  kind: 'id_proof' | 'address_proof' | 'pan' | 'aadhaar' | 'passport' | 'education' | 'experience' | 'bank' | 'photo' | 'other'
  title: string
  file_id: ID | null
  uploaded_by: ID
  verified_by: ID | null
  verified_on: ISODate | null
  status: 'pending' | 'verified' | 'rejected'
  note: string
  expires_on: ISODate | null
  /** v7 documents: optional extras */
  doc_number?: string | null // e.g. PAN / passport number (masked in lists)
  file_name?: string
  mime?: string
  size_bytes?: number
  uploaded_on?: ISODate
  review_note?: string | null // verifier's note (reason for rejection)
}

/* ---------------- GST invoices — owner: invoices (extends E.Invoice rows via optional fields) ---------------- */
export interface InvoiceLine {
  id: string
  item: string
  description: string
  hsn_sac: string
  qty: number
  unit: string
  rate_paise: Paise
  discount_pct: number
  gst_rate: number // 0, 5, 12, 18, 28
  /** where the line came from: a milestone, approved timesheet hours, or typed in */
  source?: { kind: 'milestone' | 'hours' | 'manual'; milestone_id?: ID | null; user_id?: ID | null; from?: ISODate | null; to?: ISODate | null; hours?: number | null } | null
}
export interface InvoiceParty {
  name: string
  address: string
  city: string
  state: string
  state_code: string
  pincode: string
  country: string
  gstin: string
  pan: string
  email: string
  phone: string
  contact: string
  cin?: string
  website?: string
}
/** Tenant invoicing settings (tenant.invoicing). The full bank account number is sensitive: finance.edit only. */
export interface InvoiceSettings {
  prefix: string // series prefix, e.g. "SCI" → SCI/26-27/0012
  credit_note_prefix: string // e.g. "CN" → CN/26-27/0001
  payment_terms_days: number
  default_sac: string
  default_gst_rate: number
  default_tds_pct: number
  default_unit: string
  bank: { bank_name: string; account_name: string; account_number: string; ifsc: string; branch: string; upi: string }
  signatory_name: string
  signatory_title: string
  lut_number: string // Letter of Undertaking for zero-rated exports
  default_notes: string
  default_terms: string
  updated_at?: ISODateTime | null
  updated_by?: ID | null
}
