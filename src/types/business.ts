// Business-process entities added in v3 (task governance, documents, people, spend, clients, company).
// Same conventions as entities.ts: snake_case, money in paise, ISO dates, every row carries tenant_id.
import type { Base, ID, ISODate, ISODateTime, Paise, LeaveType } from './entities'

/* ---------------- Task governance ---------------- */
export type Timeliness = 'early' | 'on_time' | 'late'
export type DelayReasonCode =
  | 'scope_change' | 'dependency' | 'client_delay' | 'underestimated' | 'leave_absence' | 'priority_change' | 'technical_issue' | 'resource_shortage' | 'other'

export interface TaskReview extends Base {
  task_id: ID
  round: number
  submitted_by: ID
  submitted_at: ISODateTime
  submission_note: string
  proof_url: string | null
  delay_reason_code: DelayReasonCode | null
  delay_reason: string | null
  decision: 'approved' | 'sent_back' | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  decision_reason: string | null // required when sent back
  quality_rating: number | null // 1–5, set on approval
}

/* ---------------- Documents ---------------- */
export type DocCategory = 'requirements' | 'design' | 'technical' | 'test' | 'contract' | 'meeting_notes' | 'process' | 'policy' | 'training' | 'other'
export type DocVisibility = 'project' | 'company' | 'managers'
export interface DocumentRec extends Base {
  project_id: ID | null // null = company library
  title: string
  description: string
  category: DocCategory
  visibility: DocVisibility
  must_read: boolean
  tags: string[]
  owner_id: ID
  current_version: number
  archived: boolean
  /** v7: policy effective date (company library only) */
  effective_on?: string | null
}
export interface DocumentVersion extends Base {
  document_id: ID
  version: number
  file_id: ID | null // files table (data_url) or null when a link
  url: string | null // external link (Drive/SharePoint) instead of upload
  file_name: string
  size_bytes: number
  mime: string
  note: string
  uploaded_by: ID
  uploaded_at: ISODateTime
}
export interface DocumentAck extends Base {
  document_id: ID
  version: number
  user_id: ID
  at: ISODateTime
}
export interface DocumentView extends Base {
  document_id: ID
  user_id: ID
  at: ISODateTime
}

/* ---------------- People ---------------- */
export interface LeaveRequest extends Base {
  user_id: ID
  from_on: ISODate
  to_on: ISODate
  type: LeaveType
  portion: 'full' | 'half'
  days: number
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  approver_id: ID | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  decision_reason: string | null
}
export interface LeavePolicy extends Base {
  type: LeaveType
  annual_days: number
  carry_forward_max: number
  accrual: 'upfront' | 'monthly'
}

export type AppraisalCycleStatus = 'draft' | 'goal_setting' | 'self_review' | 'manager_review' | 'hr_review' | 'closed'
export interface AppraisalCycle extends Base {
  name: string // e.g. "H1 FY26-27"
  period_from: ISODate
  period_to: ISODate
  status: AppraisalCycleStatus
  self_due: ISODate
  manager_due: ISODate
  hr_due: ISODate
  weights: { goals: number; tasks: number; timesheets: number; behaviour: number } // percent, sum 100
}
export type AppraisalStatus = 'not_started' | 'self_pending' | 'manager_pending' | 'hr_pending' | 'completed'
export interface Appraisal extends Base {
  cycle_id: ID
  user_id: ID
  manager_id: ID | null
  status: AppraisalStatus
  self_rating: number | null // 1–5
  self_comments: string
  manager_rating: number | null
  manager_comments: string
  hr_rating: number | null
  hr_comments: string
  final_rating: number | null
  increment_pct: number | null
  promotion_to: string | null
  metrics: Record<string, number | null> // snapshot: on_time_pct, avg_quality, timesheet_compliance, goals_score…
  submitted_self_at: ISODateTime | null
  submitted_manager_at: ISODateTime | null
  closed_at: ISODateTime | null
}
export interface Goal extends Base {
  user_id: ID
  cycle_id: ID | null
  title: string
  kra: string // key result area
  weight: number // % within the person's goals
  measure: string
  target: number
  current: number
  unit: string
  due_on: ISODate
  status: 'draft' | 'agreed' | 'on_track' | 'at_risk' | 'achieved' | 'missed'
  manager_approved: boolean
}
export interface Feedback extends Base {
  to_user_id: ID
  from_user_id: ID
  kind: 'praise' | 'improvement' | 'one_on_one'
  body: string
  visibility: 'private' | 'manager' | 'public'
  at: ISODateTime
}

export type CandidateStage = 'applied' | 'screening' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn'
export interface Candidate extends Base {
  opening_id: ID
  name: string
  email: string
  phone: string
  source: 'referral' | 'job_portal' | 'linkedin' | 'campus' | 'agency' | 'website' | 'other'
  stage: CandidateStage
  experience_years: number
  current_ctc_paise: Paise | null
  expected_ctc_paise: Paise | null
  offer_ctc_paise: Paise | null
  notice_days: number | null
  resume_file_id: ID | null
  rating: number | null
  notes: string
  rejected_reason: string | null
  joining_on: ISODate | null
  user_id: ID | null // set when hired and converted to a user
}
export interface Interview extends Base {
  candidate_id: ID
  round: number
  kind: 'technical' | 'hr' | 'manager' | 'assignment' | 'final'
  scheduled_at: ISODateTime
  interviewer_id: ID
  result: 'pending' | 'pass' | 'fail' | 'no_show'
  rating: number | null
  feedback: string
}
export interface ChecklistItem {
  id: string
  label: string
  owner_role: 'admin' | 'pm' | 'ops' | 'employee' | 'manager' | 'it' | 'finance'
  due_offset_days: number
  done_on: ISODate | null
  done_by: ID | null
}
export interface LifecycleChecklist extends Base {
  user_id: ID
  kind: 'onboarding' | 'offboarding'
  status: 'open' | 'completed'
  start_on: ISODate // joining date or resignation date
  last_day: ISODate | null
  exit_reason: string | null
  exit_type: 'resignation' | 'termination' | 'contract_end' | 'retirement' | null
  rehire_eligible: boolean | null
  items: ChecklistItem[]
}
export interface Asset extends Base {
  tag: string // e.g. SEE-LAP-012
  name: string
  category: 'laptop' | 'monitor' | 'phone' | 'licence' | 'furniture' | 'other'
  serial: string
  status: 'in_stock' | 'assigned' | 'repair' | 'retired' | 'lost'
  assigned_to: ID | null
  assigned_on: ISODate | null
  purchase_on: ISODate
  purchase_cost_paise: Paise
  warranty_until: ISODate | null
  notes: string
}

/* ---------------- Spend & commercial ---------------- */
export type ExpenseStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid'
export interface ExpenseClaim extends Base {
  user_id: ID
  project_id: ID | null
  category: 'travel' | 'food' | 'lodging' | 'client_entertainment' | 'software' | 'hardware' | 'internet_phone' | 'training' | 'office' | 'other'
  description: string
  amount_paise: Paise
  spent_on: ISODate
  receipt_file_id: ID | null
  billable_to_client: boolean
  status: ExpenseStatus
  approver_id: ID | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  decision_reason: string | null
  paid_on: ISODate | null
  ledger_entry_id: ID | null
  in_budget: boolean | null // computed at approval against budgets
}
export interface Vendor extends Base {
  name: string
  category: string
  gstin: string
  pan: string
  contact: string
  email: string
  phone: string
  payment_terms_days: number
  status: 'active' | 'blocked'
}
export interface POLine {
  description: string
  qty: number
  rate_paise: Paise
}
export interface PurchaseOrder extends Base {
  number: string
  vendor_id: ID
  project_id: ID | null
  budget_category: string
  lines: POLine[]
  amount_paise: Paise
  gst_pct: number
  status: 'draft' | 'pending' | 'approved' | 'rejected' | 'closed'
  requested_by: ID
  approver_id: ID | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  decision_reason: string | null
  needed_by: ISODate | null
}
export interface VendorBill extends Base {
  vendor_id: ID
  po_id: ID | null
  number: string
  bill_date: ISODate
  due_on: ISODate
  amount_paise: Paise
  gst_paise: Paise
  tds_paise: Paise
  status: 'received' | 'approved' | 'paid' | 'disputed'
  paid_on: ISODate | null
  file_id: ID | null
  ledger_entry_id: ID | null
}
export interface Budget extends Base {
  fy_start_year: number
  kind: 'expense' | 'revenue'
  category: string // matches ledger categories / expense categories / revenue streams
  owner_id: ID | null
  monthly_paise: Paise[] // 12 entries, FY order
  notes: string
}
export interface Client extends Base {
  name: string
  industry: string
  country: string
  gstin: string
  billing_address: string
  primary_contact: string
  email: string
  phone: string
  owner_id: ID | null // account manager
  status: 'prospect' | 'active' | 'dormant' | 'churned'
  since: ISODate | null
  payment_terms_days: number
  health: 'good' | 'watch' | 'at_risk' | null
}
export interface Contract extends Base {
  client_id: ID
  project_id: ID | null
  title: string
  kind: 'msa' | 'sow' | 'amc' | 'licence' | 'nda' | 'retainer'
  value_paise: Paise
  start_on: ISODate
  end_on: ISODate
  renewal_on: ISODate | null
  auto_renew: boolean
  status: 'draft' | 'active' | 'expiring' | 'expired' | 'terminated' | 'renewed'
  file_id: ID | null
  notes: string
}
export type LeakageKind = 'lost_deal' | 'write_off' | 'discount' | 'credit_note' | 'penalty' | 'unbilled_hours' | 'scope_creep' | 'bad_debt' | 'churn'
export interface RevenueLeakage extends Base {
  kind: LeakageKind
  amount_paise: Paise
  date: ISODate
  client: string
  project_id: ID | null
  deal_id: ID | null
  reason: string
  recorded_by: ID
  recoverable: boolean
  status: 'open' | 'recovered' | 'accepted'
  recovered_paise: Paise
  auto: boolean // generated from system data (lost deals, unbilled hours)
}

/* ---------------- Company ---------------- */
export interface Objective extends Base {
  title: string
  level: 'company' | 'team' | 'person'
  owner_id: ID
  period: string // e.g. "Q3 FY26-27"
  period_from: ISODate
  period_to: ISODate
  parent_id: ID | null
  status: 'on_track' | 'at_risk' | 'off_track' | 'done'
}
export interface KeyResult extends Base {
  objective_id: ID
  title: string
  metric: 'manual' | 'revenue_billed' | 'revenue_collected' | 'deals_won_value' | 'on_time_task_pct' | 'timesheet_compliance' | 'margin_pct' | 'headcount' | 'leakage'
  start_value: number
  target: number
  current: number
  unit: string
  owner_id: ID
}
