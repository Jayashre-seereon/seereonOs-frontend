// v4 access, master data, workflow and maker-checker entities.
import type { Base, ID, ISODate, ISODateTime, Paise, Role } from './entities'

/* ---------------- Roles & permissions ---------------- */
export interface RoleDef extends Base {
  key: string // stable slug, e.g. "hr_manager"
  name: string // "HR Manager"
  description: string
  persona: Role // which home dashboard and default data views the role gets
  permissions: string[] // permission keys from domain/permissionCatalog
  is_system: boolean // shipped default (can be edited, not deleted)
  active: boolean
}

/* ---------------- Maker-checker ---------------- */
export type ChangeEntity =
  | 'role' | 'user_access' | 'employee' | 'cost_rate' | 'workflow' | 'org_profile' | 'master_record' | 'shift'
  | 'vendor' | 'budget' | 'payroll_finalise' | 'settings' | 'makerchecker_config'
export interface ChangeSet extends Base {
  entity: ChangeEntity
  entity_id: ID | null // null for creates
  action: 'create' | 'update' | 'delete' | 'execute'
  summary: string // human sentence: "Change HR Executive permissions: +expenses.pay"
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  payload: Record<string, unknown> // what the applier needs to perform the change
  maker_id: ID
  /** The checker must also hold this permission (you can only check what you could have done). */
  required_permission: string
  /** Version of the target when the maker proposed it; a newer version at approval time fails the change. */
  base_version: number | null
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'failed'
  checker_id: ID | null
  decided_at: ISODateTime | null
  reason: string | null // rejection reason (required) or approval note
  applied_at: ISODateTime | null
  result_id: ID | null // id of the record created/updated on apply
  error: string | null
}

export interface MakerCheckerConfig {
  enabled: boolean
  /** Entities whose changes need a second person. `makerchecker_config` is always checked when enabled. */
  entities: ChangeEntity[]
  /** Changes that wait longer than this many working days are flagged overdue in the inbox. */
  sla_days: number
}
export const CHANGE_ENTITY_LABEL: Record<ChangeEntity, string> = {
  role: 'Roles & permissions',
  user_access: 'User access (role, extra permissions)',
  employee: 'Employee creation & deactivation',
  cost_rate: 'Salaries & cost rates',
  workflow: 'Approval workflows',
  org_profile: 'Organisation profile',
  master_record: 'Master data (departments, grades…)',
  shift: 'Shifts',
  vendor: 'Vendor bank & tax details',
  budget: 'Budgets',
  payroll_finalise: 'Payroll finalisation',
  settings: 'Company settings',
  makerchecker_config: 'Maker-checker settings',
}

/* ---------------- Approval workflows ---------------- */
export type WorkflowProcess = 'leave' | 'expense' | 'purchase_order' | 'vendor_bill' | 'timesheet' | 'task_review'
export type ApproverType = 'reports_to' | 'skip_level' | 'role' | 'user' | 'project_pm' | 'project_pm_or_manager' | 'department_head' | 'task_reviewer'
export interface WorkflowStep {
  id: string
  name: string // "Manager approval"
  approver: ApproverType
  role_id?: string | null // when approver = role
  user_id?: string | null // when approver = user
  min_amount_paise?: Paise | null // step applies only when amount ≥ this
  sla_days: number // working days
  escalate_to?: { approver: ApproverType; role_id?: string | null; user_id?: string | null } | null
  allow_self?: boolean // if the resolved approver is the requester, skip to next step (default false = skip)
}
export interface ApprovalWorkflow extends Base {
  process: WorkflowProcess
  name: string
  description: string
  active: boolean
  steps: WorkflowStep[]
  require_reason_on_reject: boolean
  notify_requester: boolean
}

/* ---------------- Organisation master data ---------------- */
export interface OrgProfile {
  legal_name: string
  brand_name: string
  cin: string
  gstin: string
  pan: string
  tan: string
  registered_address: string
  corporate_address: string
  city: string
  state: string
  pincode: string
  country: string
  phone: string
  email: string
  website: string
  incorporated_on: ISODate | null
  employee_code_prefix: string // e.g. "SEE"
  employee_code_next: number
  bank_name: string
  bank_account_masked: string // last 4 only in the UI
  ifsc: string
}
export interface Location extends Base {
  name: string
  code: string
  address: string
  city: string
  state: string
  timezone: string
  holiday_calendar: string // name; holidays table is tenant-wide in v1
  is_head_office: boolean
  active: boolean
}
export interface Department extends Base {
  name: string
  code: string
  head_id: ID | null
  parent_id: ID | null
  cost_centre_id: ID | null
  kind: 'management' | 'delivery' | 'sales' | 'operations' // maps to User.department for analytics
  active: boolean
}
export interface Grade extends Base {
  code: string // L1…L7
  name: string
  min_ctc_paise: Paise | null
  max_ctc_paise: Paise | null
  leave_multiplier: number
  active: boolean
}
export interface Designation extends Base {
  name: string
  department_id: ID | null
  grade_id: ID | null
  default_role_id: ID | null
  active: boolean
}
export interface CostCentre extends Base {
  code: string
  name: string
  owner_id: ID | null
  active: boolean
}
export interface Shift extends Base {
  name: string
  code: string
  start_time: string // "09:30"
  end_time: string // "18:30"
  break_minutes: number
  grace_minutes: number
  working_days: number[] // 0=Sun..6=Sat
  night_shift: boolean
  min_hours: number
  is_default: boolean
  active: boolean
}
export interface EmailTemplate extends Base {
  key: 'welcome' | 'password_reset' | 'leave_decision' | 'expense_decision' | 'task_assigned' | 'payslip' | 'appraisal_completed' | 'appraisal_letter' | 'custom'
  name: string
  subject: string
  body: string // supports {{employee_name}}, {{company}}, {{login_url}}, {{username}}, {{temp_password}}, {{manager_name}}, {{joining_date}}…
  active: boolean
}
export interface EmailMessage extends Base {
  to: string
  to_user_id: ID | null
  subject: string
  body: string
  template_key: string
  related_entity: string | null
  related_id: ID | null
  status: 'sent' | 'failed'
  sent_at: ISODateTime
}
