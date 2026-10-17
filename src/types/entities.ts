// Entity types mirror the API contract in the Technical Design (section 7 tables).
// Field names stay snake_case so the real FastAPI responses drop in unchanged.
// Money is always integer paise (`*_paise`). Dates are ISO `YYYY-MM-DD`; timestamps ISO UTC.

export type ID = string
export type ISODate = string
export type ISODateTime = string
export type Paise = number

export interface Base {
  id: ID
  tenant_id: ID
  created_at: ISODateTime
  updated_at: ISODateTime
  created_by?: ID | null
  version: number
}

/* ---------- platform ---------- */
export type TenantStatus = 'trial' | 'active' | 'read_only' | 'suspended'
export type Industry = 'it_services' | 'sap_consulting' | 'product' | 'other'

export interface ThemeConfig {
  preset: string // preset id or 'custom'
  primary: string // hex
  accent: string // hex
  radius: 'sharp' | 'soft' | 'round'
  density: 'compact' | 'comfortable'
  font: 'plex' | 'inter' | 'source' | 'system' | 'geist' | 'manrope' // geist/manrope kept for stored themes
  mode: 'system' | 'light' | 'dark' // tenant default; each user may override
  sidebar: 'tinted' | 'light' | 'dark'
}

export interface Tenant {
  id: ID
  name: string
  slug: string
  status: TenantStatus
  industry: Industry
  trial_ends_on: ISODate | null
  time_zone: string
  plan_code: string
  seats: number
  created_at: ISODateTime
  logo_data_url: string | null
  theme: ThemeConfig
  settings: TenantSettings
  version: number
  // v4
  org?: import('./access').OrgProfile
  maker_checker?: import('./access').MakerCheckerConfig
  // v7 GST invoicing settings (series prefix, bank account in full, defaults) — owner: invoices
  invoicing?: import('./v7').InvoiceSettings
}

export interface TenantSettings {
  'company.fy_start_month': number
  'company.currency': 'INR'
  'calendar.weekly_off': number[] // 0=Sun..6=Sat (Saturday handled by saturday_rule)
  'calendar.saturday_rule': 'all_on' | 'all_off' | 'some_off'
  'calendar.saturday_off_weeks': number[]
  'calendar.min_hours_per_day': number
  'finance.cost_loading_pct'?: number // overheads loaded on salary cost (cost per day = CTC ÷ avg working days × (1 + loading))
  'team.default_productive_hours'?: number // hours of task work a day planning assumes
  'calendar.max_hours_per_day': number
  'calendar.breaks_count': boolean
  'timesheet.hours_step': 0.25 | 0.5 | 1
  'timesheet.allow_future_entries': boolean
  'timesheet.internal_note_required': boolean
  'timesheet.weekly_lock': boolean
  'timesheet.unlock_max_days': number
  'approval.sla_working_days': number
  'approval.bulk_approve': boolean
  'pay.deduct_unapproved_days': boolean
  'pay.variable_default_pct': number
  'pay.target_default': 'ctc' | 'manual'
  'pay.variable_threshold_pct': number
  'projects.code_prefix': string
  'projects.empty_milestone_days': number
  'projects.margin_floor_pct': number
  'projects.effort_ratio_alert': number
  'allocation.max_pct_per_person': number
  'allocation.block_over': boolean
  'daily.proof_required': boolean
  'sales.stale_deal_days': number
  'notify.friday_nudge_time': string
  'notify.sla_digest_time': string
  'security.password_min_length': number
  'security.lockout_attempts': number
  'security.lockout_minutes': number
  'security.session_idle_minutes': number
  'security.require_2fa_admins': boolean
  'ai.enabled': boolean
  'finance.opening_cash_paise': number
  'finance.monthly_overheads_paise': number
}

export interface Plan {
  code: string
  name: string
  price_per_user_paise: number
  billing_period: 'monthly' | 'yearly'
  max_users: number | null
  features: string[]
}

export interface Subscription extends Base {
  plan_code: string
  status: 'trialing' | 'active' | 'past_due' | 'cancelled'
  current_period_end: ISODate
  seats: number
  razorpay_subscription_id: string | null
}

export interface BillingInvoice extends Base {
  number: string
  period: string
  amount_paise: Paise
  status: 'paid' | 'due' | 'failed'
  issued_on: ISODate
}

/* ---------- people & access ---------- */
export type Role = 'admin' | 'pm' | 'sales' | 'ops' | 'employee'
export type Grant = 'margins' | 'salaries'

export interface User extends Base {
  email: string
  name: string
  title: string
  role: Role
  reports_to_id: ID | null
  grants: Grant[]
  status: 'active' | 'deactivated' | 'invited'
  last_login_at: ISODateTime | null
  avatar_hue: number
  phone: string | null
  joined_on: ISODate
  department: 'management' | 'delivery' | 'sales' | 'operations'
  two_factor: boolean
  prefs: { theme_mode?: 'system' | 'light' | 'dark'; home_view?: string; email_muted?: string[] }
  is_super_admin?: boolean
  // v4 access — `role` above is the persona derived from the role definition
  role_key: string // RoleDef.key
  extra_permissions: string[] // granted on top of the role
  revoked_permissions: string[] // removed from the role for this person
  must_change_password?: boolean // set by Create Employee; forces a change on first login
  // v4 employment master-data references
  employee_code?: string | null
  department_id?: ID | null
  designation_id?: ID | null
  grade_id?: ID | null
  location_id?: ID | null
  shift_id?: ID | null
  cost_centre_id?: ID | null
  employment_type?: 'full_time' | 'part_time' | 'contract' | 'intern' | null
  productive_hours?: number | null // hours of task work per day planning/forecasts assume (Feature Guide §16); null = tenant default
  date_of_birth?: ISODate | null
  personal_email?: string | null
  // computed by the server on /me and login (never stored)
  permissions?: string[]
  role_name?: string
}

export interface Invite extends Base {
  email: string
  name: string
  role: Role
  role_key?: string
  reports_to_id: ID | null
  token: string
  expires_at: ISODateTime
  accepted_at: ISODateTime | null
}

export interface Holiday extends Base {
  date: ISODate
  name: string
  optional: boolean
}

export interface Delegation extends Base {
  from_user_id: ID
  to_user_id: ID
  from_on: ISODate
  to_on: ISODate
  reason: string
  project_id?: ID | null // scope: null = all projects
  include_tasks?: boolean // also hand over open-task follow-ups (default true)
}

/* ---------- delivery ---------- */
export type ProjectStatus = 'initiated' | 'active' | 'on_hold' | 'npa' | 'completed' | 'closed'
export type ProjectType = 'product' | 'service' | 'saas' | 'ams'
export type BillingModel = 'fixed' | 'tm' | 'subscription' | 'ams_retainer'
export type RevenueStream = 'sap_consulting' | 'products' | 'services' | 'saas' | 'ams'

export interface Project extends Base {
  code: string
  name: string
  client: string
  type: ProjectType
  status: ProjectStatus
  pm_id: ID | null
  start_on: ISODate
  end_on: ISODate
  contract_value_paise: Paise
  billing_model: BillingModel
  stream: RevenueStream
  description: string
  priority: number // 1 (highest) … 5, see PROJECT_PRIORITY
  deal_id: ID | null
  baseline_end_on: ISODate | null
  color_hue: number
  costing?: ProjectCosting | null // the saved project cost calculator (Feature Guide §3, §6)
}

/** Project cost calculator. Resources are the project's Allocation rows; this holds everything else. */
export interface ProjectCosting {
  additional_costs: { id: string; category: string; description: string; amount_paise: Paise }[]
  maintenance_paise: Paise // maintenance / support cost
  contingency_pct: number // % of resources + additional costs
  markup_pct: number // price = cost × (1 + markup)
  price_paise: Paise // agreed project price (may differ from the markup suggestion)
  saved_at: ISODateTime | null
  saved_by: ID | null
}

export interface ProjectStatusHistory extends Base {
  project_id: ID
  from_status: ProjectStatus | null
  to_status: ProjectStatus
  reason: string | null
  changed_by: ID
  changed_at: ISODateTime
}

export type MilestoneBilling = 'none' | 'invoiced' | 'paid'
export interface Milestone extends Base {
  project_id: ID
  no: number
  name: string
  planned_start: ISODate
  planned_end: ISODate
  baseline_end: ISODate
  billing_amount_paise: Paise
  billing_status: MilestoneBilling
  achieved_on: ISODate | null
  empty_since: ISODate | null
  deleted_at: ISODateTime | null
}

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done'
export type Complexity = 'low' | 'medium' | 'high' | 'very_high'
/** Detailed delivery stage (Feature Guide §7). `status` stays the summary state every rule uses; stage maps onto it. */
export type TaskStage = 'new' | 'selected' | 'in_development' | 'unit_testing' | 'functional_testing' | 'uat' | 'waiting_feedback' | 'on_hold' | 'blocked' | 'completed'
export type TaskTag = 'feature' | 'bug' | 'improvement' | 'documentation' | 'support' | 'meeting'
export interface Task extends Base {
  project_id: ID
  milestone_id: ID | null
  no: number
  title: string
  owner_id: ID | null
  backup_id: ID | null
  est_hours: number
  start_on: ISODate
  due_on: ISODate
  done_on: ISODate | null
  complexity: Complexity
  status: TaskStatus
  description: string
  blocked_reason: string | null
  // v3 task governance (optional so older rows stay valid)
  kind?: 'project' | 'general' // general = assigned by a line manager outside client projects
  assigned_by?: ID | null
  reviewer_id?: ID | null // who approves completion (PM for project tasks, assigner/manager otherwise)
  submitted_on?: ISODate | null // last submission for review
  approved_by?: ID | null
  approved_on?: ISODate | null
  review_round?: number
  timeliness?: 'early' | 'on_time' | 'late' | null // set on approval: done_on vs due_on
  variance_days?: number | null // working days, negative = early
  delay_reason_code?: string | null
  delay_reason?: string | null
  // Feature Guide v5 delivery detail
  stage?: TaskStage // detailed workflow stage; status is derived from it
  progress?: number // 0–100 % complete (earned hours = est × progress)
  tag?: TaskTag | null // e.g. Bug
  actual_start_on?: ISODate | null // first day work started (first hour logged or moved into development)
  target_revisions?: { from: ISODate; to: ISODate; at: ISODateTime; by: ID; reason: string }[] // every move of due_on after baseline
  baseline_due_on?: ISODate | null // the original target end
  slip_flagged_on?: ISODate | null // owner/PM flagged a likely slip early (early warning)
  slip_note?: string | null
  cancelled_on?: ISODate | null // cancelled with hours logged (kept on cost, out of delivery stats)
  cancel_reason?: string | null
  cr_id?: ID | null // created from an approved change request
  quality_rating?: number | null // 1–5 from the reviewer
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  // v7 professional task fields (all optional; older rows stay valid)
  concerned_manager_id?: ID | null // accountable line manager (default: owner's reporting manager)
  watcher_ids?: ID[] // followers notified of changes
  acceptance_criteria?: { text: string; done: boolean }[] // definition of done checklist
  labels?: string[]
  billable?: boolean
  recurrence?: 'none' | 'weekly' | 'monthly' | null // creates the next occurrence on completion
  recurrence_of?: ID | null // the task this one repeats
  attachments?: { id: string; name: string; size: number; type: string; data_url?: string | null; uploaded_by: ID; at: string }[]
  parent_task_id?: ID | null // sub-task / follow-up of another task
}

export interface TaskDependency extends Base {
  task_id: ID
  depends_on_task_id: ID
}

export interface Comment extends Base {
  task_id: ID
  body: string
  mentions: ID[]
  author_id: ID
  parent_id: ID | null
}

export type NotificationType =
  | 'NTF-01' | 'NTF-02' | 'NTF-03' | 'NTF-04' | 'NTF-05' | 'NTF-06' | 'NTF-07' | 'NTF-08' | 'NTF-09'
  | 'NTF-10' | 'NTF-11' | 'NTF-12' | 'NTF-13' | 'NTF-14' | 'NTF-15' | 'NTF-16' | 'NTF-17'
export interface Notification extends Base {
  user_id: ID
  type: NotificationType
  title: string
  body: string
  link: string | null
  read_at: ISODateTime | null
}

/* ---------- time & leave ---------- */
export type WeekStatus = 'open' | 'submitted' | 'approved' | 'rejected' | 'locked'
export interface TimesheetWeek extends Base {
  user_id: ID
  week_start: ISODate // Monday
  status: WeekStatus
  submitted_at: ISODateTime | null
  approver_id: ID | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  late: boolean
  reject_reason: string | null
  unlock_requested_at: ISODateTime | null
  unlock_reason: string | null
  unlock_until: ISODate | null
}

export type EntryKind = 'task' | 'leave' | 'internal'
export interface TimesheetEntry extends Base {
  week_id: ID
  user_id: ID
  work_date: ISODate
  kind: EntryKind
  task_id: ID | null
  internal_code: string | null // e.g. 'meeting' | 'learning' | 'presales' | 'admin'
  leave_type: LeaveType | null
  hours: number
  note: string
  project_id?: ID | null // activities (internal time) may name the project they were for (v5 timesheet)
}

export type LeaveType = 'casual' | 'sick' | 'earned' | 'compensatory' | 'lwp' | 'optional_holiday'
export interface Leave extends Base {
  user_id: ID
  date: ISODate
  type: LeaveType
  portion: 'full' | 'half'
  source: 'timesheet' | 'hr'
  approved_by: ID | null
}

export interface DailyUpdate extends Base {
  user_id: ID
  date: ISODate
  done: string
  proof_url: string
  blocker: string
  demo_shown: boolean
  demo_note?: string // what was demoed (Friday demo)
}

/* ---------- cost & money ---------- */
export interface CostRate extends Base {
  user_id: ID
  monthly_ctc_paise: Paise
  variable_pct: number
  sales_target_paise: Paise | null
  effective_from: ISODate
}

export interface Allocation extends Base {
  project_id: ID
  milestone_id: ID | null // null = all milestones (follows the project's forecast end)
  user_id: ID
  pct: number
  from_on: ISODate
  to_on: ISODate
}

export interface FileRef extends Base {
  name: string
  mime: string
  size_bytes: number
  entity: string
  entity_id: ID
  data_url: string | null
}

export interface Invoice extends Base {
  project_id: ID
  /** First milestone billed; '' for ad-hoc invoices, drafts and cancelled invoices (full list in milestone_ids). */
  milestone_id: ID
  number: string
  invoiced_on: ISODate
  /** Revenue = taxable value (ex-GST). 0 while draft or after cancellation. Every revenue/margin calc reads this. */
  amount_paise: Paise
  /** Revenue share of what has been settled (cash received + TDS), on the same ex-GST basis as amount_paise. */
  paid_amount_paise: Paise
  paid_on: ISODate | null
  due_on: ISODate
  file_id: ID | null
  // v7 GST invoice detail (optional so older rows stay valid; GST is a liability, never revenue)
  status?: 'draft' | 'issued' | 'partially_paid' | 'paid' | 'cancelled'
  client_id?: ID | null
  milestone_ids?: ID[]
  bill_to?: import('./v7').InvoiceParty | null
  ship_to?: import('./v7').InvoiceParty | null
  seller?: import('./v7').InvoiceParty | null
  bank?: { bank_name: string; account_name: string; account_number: string; ifsc: string; branch: string; upi?: string } | null
  place_of_supply?: string | null // GST state code, e.g. "21" (Odisha); "96" = outside India
  tax_mode?: 'intra' | 'inter' | 'export' | null // CGST+SGST vs IGST vs zero-rated export (LUT)
  reverse_charge?: boolean
  lines?: import('./v7').InvoiceLine[]
  subtotal_paise?: Paise // sum of qty × rate before discount
  discount_paise?: Paise
  taxable_paise?: Paise // kept after cancellation (amount_paise drops to 0)
  cgst_paise?: Paise
  sgst_paise?: Paise
  igst_paise?: Paise
  round_off_paise?: Paise
  tds_pct?: number
  total_paise?: Paise // grand total incl. GST, rounded to the rupee
  received_paise?: Paise // cash received against total_paise
  tds_received_paise?: Paise // TDS the client deducted (counts as settled)
  notes?: string
  terms?: string
  po_reference?: string | null
  po_date?: ISODate | null
  signatory?: { name: string; title: string } | null
  draft_no?: number
  issued_on?: ISODate | null
  issued_by?: ID | null
  cancelled_on?: ISODate | null
  cancel_reason?: string | null
  credit_note?: { number: string; date: ISODate; taxable_paise: Paise; total_paise: Paise } | null
  emails?: { to: string; at: ISODateTime; by: ID; outbox_id: ID | null }[]
  duplicated_from?: ID | null
}

export interface Payment extends Base {
  invoice_id: ID
  /** Revenue share settled by this payment (ex-GST basis, sums to invoice.amount_paise when paid in full). */
  amount_paise: Paise
  paid_on: ISODate
  reference: string
  // v7 GST invoices (optional): what actually arrived and the TDS the client deducted
  gross_paise?: Paise
  tds_paise?: Paise
  mode?: string
}

export interface PayrollRun extends Base {
  month: string // YYYY-MM
  status: 'draft' | 'final'
  finalised_by: ID | null
  finalised_at: ISODateTime | null
  warnings: string[]
}

export interface PayrollLine extends Base {
  run_id: ID
  user_id: ID
  monthly_ctc_paise: Paise
  base_paise: Paise
  working_days: number
  approved_days: number
  unapproved_days: number
  unapproved_weeks: ISODate[]
  lwp_days: number
  deduction_paise: Paise
  variable_paise: Paise
  net_paise: Paise
}

export type LedgerKind = 'income' | 'expense'
export interface LedgerEntry extends Base {
  kind: LedgerKind
  category: string
  description: string
  amount_paise: Paise
  date: ISODate
  recurring: boolean
  until_on: ISODate | null
  status: 'expected' | 'received' | 'paid'
  project_id: ID | null
  milestone_id: ID | null
  invoice_id: ID | null
  stream: RevenueStream | null
  locked: boolean // auto-created from invoice: cannot delete
}

/* ---------- sales & operations ---------- */
export type DealStage = 'lead' | 'qualified' | 'demo' | 'proposal' | 'negotiation' | 'won' | 'lost'
export type DealSource = 'referral' | 'bni' | 'website' | 'cold_call' | 'event' | 'partner' | 'existing_client' | 'other'
export interface Deal extends Base {
  title: string
  client: string
  contact: string
  phone: string
  email: string
  product: string
  source: DealSource
  owner_id: ID
  stage: DealStage
  value_paise: Paise
  mrr_paise: Paise
  expected_close: ISODate
  won_on: ISODate | null
  lost_on: ISODate | null
  lost_reason: string | null
  project_id: ID | null
  last_activity_on: ISODate
  notes: string
  // v5 Feature Guide §11 (optional; older rows may not have them)
  first_conversation?: string | null // how the lead came in / first conversation
  next_step?: string | null
  next_step_on?: ISODate | null
}

export type ActivityType = 'call' | 'meeting' | 'demo' | 'email' | 'proposal' | 'follow_up' | 'whatsapp'
export interface DealActivity extends Base {
  deal_id: ID
  date: ISODate
  type: ActivityType
  note: string
  by: ID
}

export interface DealStageHistory extends Base {
  deal_id: ID
  from_stage: DealStage | null
  to_stage: DealStage
  by: ID
  at: ISODateTime
  reason: string | null
}

export type CRStatus = 'raised' | 'estimated' | 'approved' | 'rejected' | 'done'
export interface ChangeRequest extends Base {
  project_id: ID
  title: string
  description: string
  hours: number
  value_paise: Paise
  status: CRStatus
  raised_by: ID
  milestone_id: ID | null
  decided_by: ID | null
  decided_at: ISODateTime | null
  number?: number // CR-n per project
  requested_by_client?: string // who at the client asked
  requested_on?: ISODate | null
  impact_days?: number // working days impact on the schedule
  note?: string
  proposed_tasks?: { title: string; est_hours: number; owner_id: ID | null }[] // added to the WBS on approval
  tasks_added_on?: ISODateTime | null
}

export interface Opening extends Base {
  role: string
  project_id: ID | null
  count: number
  status: 'open' | 'interviewing' | 'offered' | 'filled' | 'on_hold'
  owner_id: ID
  needed_by: ISODate | null
  notes: string
}

export type Recurrence = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
export interface OpsItem extends Base {
  item: string
  category: 'payroll' | 'compliance' | 'finance' | 'admin' | 'hr' | 'it'
  owner_id: ID
  due_on: ISODate
  recurring: Recurrence
  status: 'open' | 'done'
  last_done_on: ISODate | null
  notes: string
}

export interface ActivityLog extends Base {
  entity: string
  entity_id: ID
  action: string
  summary: string
  actor_id: ID
  at: ISODateTime
}

/* ---------- reports ---------- */
export interface SavedReport extends Base {
  name: string
  description: string
  spec: import('./reports').ReportSpec
  owner_id: ID
  shared: boolean
  pinned: boolean
  source: 'builder' | 'ai' | 'system'
  schedule: 'none' | 'weekly' | 'monthly'
  last_run_at: ISODateTime | null
}

export interface DataExport extends Base {
  requested_by: ID
  status: 'queued' | 'ready' | 'expired'
  ready_at: ISODateTime | null
  expires_at: ISODateTime | null
  size_bytes: number
}
