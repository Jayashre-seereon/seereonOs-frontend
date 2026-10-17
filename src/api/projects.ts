// Module B — projects & delivery API client (UI-08..11, 18..20, 34, 35, 39, client view).
// Every figure is computed by the (mock) server; screens only format.
import { http, requestFull } from './http'
import type {
  Allocation, BillingModel, ChangeRequest, Complexity, DailyUpdate, Invoice, Milestone, Opening, Payment, Project, ProjectStatus, ProjectStatusHistory,
  ProjectType, RevenueStream, Task, TaskStage, TaskStatus,
} from '@/types/entities'
import type { ProjectMetrics, MilestoneDelivery } from '@/mock/analytics'
import type { TaskDetail } from './tasks'

export type { ProjectMetrics, MilestoneDelivery }

/* ---------------- list ---------------- */
export interface ProjectListItem extends Project {
  metrics: ProjectMetrics
  can_edit: boolean
  team_ids: string[]
  /** v5 list columns: % complete, tasks done, forecast end, contract incl. CRs */
  row?: ProjectRowInfo
}
export interface ProjectList {
  items: ProjectListItem[]
  counts: Record<ProjectStatus | 'all', number>
  total: number
}
export interface ProjectListQuery {
  status?: ProjectStatus | 'all'
  q?: string
  type?: ProjectType | ''
  sort?: 'priority' | 'name' | 'end' | 'health' | 'progress'
}

/* ---------------- detail ---------------- */
export interface MilestoneView extends Milestone {
  state: MilestoneDelivery
  slip: number
  progress: number
  task_count: number
  open_count: number
  est_hours: number
  logged_hours: number
  invoice_id: string | null
  auto_delete_on: string | null
  // v5: deadline = target end of the last task (planned_end, kept in sync); end = achieved or forecast
  forecast_end: string | null
  end_kind: 'achieved' | 'forecast' | null
  end_on: string | null
  earned_hours: number
  /** finance viewers: the invoice behind Invoiced / Paid */
  invoice?: { id: string; number: string; amount_paise: number; outstanding_paise: number } | null
}
export interface BillingSummary {
  total: number
  paid: number
  invoiced_unpaid: number
  achieved_not_invoiced: number
  not_due: number
}
export type TaskRisk = 'overdue' | 'blocked' | 'due_soon' | null
export interface TaskView extends Task {
  wbs: string
  actual_hours: number
  approved_hours: number
  dep_ids: string[]
  blockers: { id: string; wbs: string; title: string; owner_id: string | null }[]
  risk: TaskRisk
  // v5 WBS columns (from the schedule)
  dep_wbs?: string[]
  forecast_start?: string | null
  forecast_end?: string | null
  float_days?: number | null
  project_float_days?: number | null
  critical?: boolean
  revised_on?: string | null
}
export interface AllocationView extends Allocation {
  ms_code: string
  ms_name: string
}
export interface ProjectDetail {
  project: Project
  metrics: ProjectMetrics
  can_edit: boolean
  can_see_money: boolean
  is_admin: boolean
  milestones: MilestoneView[]
  tasks: TaskView[]
  allocations: AllocationView[]
  change_requests: ChangeRequest[]
  status_history: ProjectStatusHistory[]
  recent_updates: DailyUpdate[]
  team_ids: string[]
  /** v3: task delivery on this project (timeliness, review queue) */
  delivery?: ProjectDelivery
  /** v5: milestone billing totals (null when the viewer can't see billing) */
  billing_summary?: BillingSummary | null
  can_bill?: boolean
}
export interface ProjectDelivery {
  completed: number
  early: number
  on_time: number
  late: number
  on_time_pct: number | null
  avg_variance_days: number | null
  first_pass_pct: number | null
  avg_quality: number | null
  sent_back: number
  awaiting_review: { id: string; wbs: string; title: string; owner_id: string | null; reviewer_id: string | null; submitted_on: string | null; due_on: string; round: number; late: boolean; can_review: boolean }[]
}

/* ---------------- schedule ---------------- */
export interface ScheduleTask {
  id: string
  wbs: string
  title: string
  owner_id: string | null
  status: TaskStatus
  milestone_id: string | null
  start_on: string
  due_on: string
  done_on: string | null
  forecast_start: string
  forecast_end: string
  float_days: number
  project_float_days?: number // working days a task can slip before it delays the project end
  critical: boolean
  deps: string[]
  remaining_hours: number
  breach: { kind: 'overdue' | 'forecast_late' | 'milestone' | 'blocked'; message: string } | null
  // v5 delivery detail
  stage: TaskStage
  progress: number
  est_hours: number
  logged_hours: number
  baseline_due_on: string | null
  revised_on: string | null // when the target end was last revised
  actual_start_on: string | null
  waiting_on_id: string | null // the dependency that pushes the forecast start
}
export interface ScheduleMilestone {
  id: string
  no: number
  name: string
  planned_start: string
  planned_end: string
  baseline_end: string
  forecast_end: string | null
  achieved_on: string | null
  state: MilestoneDelivery
}
export interface Schedule {
  from: string
  to: string
  today: string
  project_start: string
  project_end: string
  cpm_finish: string | null
  forecast_finish: string | null
  tasks: ScheduleTask[]
  milestones: ScheduleMilestone[]
  critical_path: string[]
  conflicts: { task_id: string; depends_on_id: string; message: string }[]
  cycles: string[]
  can_edit: boolean
}

/* ---------------- team load ---------------- */
export interface LoadDay {
  date: string
  total_pct: number
  project_pct: number
}
export interface PersonLoad {
  user_id: string
  days: LoadDay[]
  over_days: { date: string; pct: number }[]
  avg_pct: number
}
export interface ProjectLoad {
  max_pct: number
  block_over: boolean
  people: PersonLoad[]
}

/* ---------------- money ---------------- */
export interface MoneyTriple {
  revenue: number
  cost: number
  margin: number | null
  markup: number | null
}
export interface InvoiceView extends Invoice {
  payments: Payment[]
  file: { id: string; name: string; data_url: string | null } | null
  outstanding: number
}
export interface BillingRow {
  milestone_id: string
  no: number
  name: string
  amount: number
  billing_status: Milestone['billing_status']
  state: MilestoneDelivery
  planned_end: string
  invoice: InvoiceView | null
}
export interface ProjectMoney {
  floor_pct: number
  contract: number
  planned: MoneyTriple
  projected: MoneyTriple
  actual: MoneyTriple
  invoiced: number | null
  collected: number | null
  by_person: { user_id: string; est_hours: number; hours: number; approved_hours: number; rate_ph: number; planned_cost: number; cost: number }[]
  by_milestone: { id: string | null; code: string; name: string; est_hours: number; logged_hours: number; variance_hours: number; planned_cost: number; logged_cost: number }[]
  billing: BillingRow[] | null
  can_invoice: boolean
  /** v5 costing & margin analysis (planned / projected / actual, bridge, variance, allocated vs logged) */
  analysis?: CostingAnalysis
}

/* ---------------- activity & client view ---------------- */
export interface ActivityItem {
  id: string
  kind: 'status' | 'log'
  at: string
  actor_id: string | null
  title: string
  detail: string | null
  action: string
}
export interface ClientView {
  company: string
  generated_on: string
  project: { code: string; name: string; client: string; start_on: string; end_on: string; status: ProjectStatus; description: string }
  progress: number
  forecast_end: string | null
  late_days: number
  milestones: { no: number; name: string; target: string; status: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral'; note: string | null; progress: number }[]
  completed: { wbs: string; title: string; done_on: string }[]
  upcoming: { wbs: string; title: string; due_on: string }[]
  inputs: string[]
}

/* ---------------- import ---------------- */
export interface ImportRow {
  line: number
  milestone: string
  milestone_code: string
  milestone_new: boolean
  wbs: string
  title: string
  owner_id: string | null
  owner_label: string
  est_hours: number | null
  start_on: string | null
  due_on: string | null
  complexity: Complexity | null
  depends_on: string[]
  billing_paise: number | null
  errors: string[]
}
export interface ImportPreview {
  token: string
  rows: ImportRow[]
  error_count: number
  task_count: number
  new_milestones: { code: string; name: string; billing_paise: number }[]
  max_rows: number
}

/* ---------------- payloads ---------------- */
export interface ProjectInput {
  name: string
  client: string
  type: ProjectType
  billing_model: BillingModel
  stream: RevenueStream
  pm_id: string | null
  start_on: string
  end_on: string
  contract_value_paise: number
  priority: number
  description: string
  milestones?: { name: string; planned_end?: string | null; billing_amount_paise: number }[]
  /** v5: the project cost calculator (resources reference milestones by index in `milestones`, null = all) */
  costing?: CostingInput | null
  /** v5: documents uploaded with the create form (PDF, images, text, CSV; up to 20 MB each) */
  documents?: { name: string; mime: string; size_bytes: number; data_url: string }[]
}
export interface MilestoneInput {
  name: string
  planned_start: string
  planned_end: string
  billing_amount_paise: number
}
export interface AllocationInput {
  user_id: string | null
  milestone_id: string | null
  pct: number | null
  from_on: string | null
  to_on: string | null
}
export interface TaskCreateInput {
  title: string
  milestone_id: string | null
  owner_id?: string | null
  est_hours?: number
  start_on?: string
  due_on?: string
  complexity?: Complexity
}
export interface OpeningView extends Opening {
  project_code: string | null
  project_name: string | null
}
export type OpeningInput = Pick<Opening, 'role' | 'project_id' | 'count' | 'status' | 'owner_id' | 'needed_by' | 'notes'>

export const projectsApi = {
  list: (q: ProjectListQuery = {}) => http.get<ProjectList>('/projects', q as Record<string, unknown>),
  detail: (id: string) => http.get<ProjectDetail>(`/projects/${id}`),
  create: (b: ProjectInput) => requestFull<Project>('POST', '/projects', { body: b }),
  update: (id: string, b: Partial<ProjectInput>, version?: number) => requestFull<Project>('PATCH', `/projects/${id}`, { body: b, ifMatch: version }),
  setStatus: (id: string, status: ProjectStatus, reason: string | null) => requestFull<Project>('POST', `/projects/${id}/status`, { body: { status, reason } }),

  addMilestone: (id: string, b: MilestoneInput) => requestFull<Milestone>('POST', `/projects/${id}/milestones`, { body: b }),
  updateMilestone: (id: string, b: Partial<MilestoneInput>, version?: number) => requestFull<Milestone>('PATCH', `/milestones/${id}`, { body: b, ifMatch: version }),
  deleteMilestone: (id: string) => requestFull<{ moved_tasks: number; removed_allocations: number }>('DELETE', `/milestones/${id}`),

  createTask: (projectId: string, b: TaskCreateInput) => requestFull<Task>('POST', `/projects/${projectId}/tasks`, { body: b }),
  setDependencies: (taskId: string, depends_on: string[]) => requestFull<TaskDetail>('PUT', `/tasks/${taskId}/dependencies`, { body: { depends_on } }),

  schedule: (id: string) => http.get<Schedule>(`/projects/${id}/schedule`),
  load: (id: string) => http.get<ProjectLoad>(`/projects/${id}/load`),
  addAllocation: (id: string, b: AllocationInput) => requestFull<Allocation>('POST', `/projects/${id}/allocations`, { body: b }),
  updateAllocation: (id: string, b: AllocationInput, version?: number) => requestFull<Allocation>('PATCH', `/allocations/${id}`, { body: b, ifMatch: version }),
  deleteAllocation: (id: string) => requestFull<null>('DELETE', `/allocations/${id}`),

  money: (id: string) => http.get<ProjectMoney | null>(`/projects/${id}/money`),
  nextInvoiceNumber: () => http.get<{ number: string }>('/invoices/next-number'),
  raiseInvoice: (milestoneId: string, b: { number: string; invoiced_on: string; due_on: string; amount_paise: number; file: { name: string; mime: string; size_bytes: number; data_url: string } | null }) =>
    requestFull<Invoice>('POST', `/milestones/${milestoneId}/invoice`, { body: b }),
  recordPayment: (invoiceId: string, b: { amount_paise: number; paid_on: string; reference: string }) => requestFull<Invoice>('POST', `/invoices/${invoiceId}/payments`, { body: b }),

  addChange: (id: string, b: { title: string; description: string; hours: number; value_paise: number }) => requestFull<ChangeRequest>('POST', `/projects/${id}/change-requests`, { body: b }),
  updateChange: (id: string, b: { title?: string; description?: string; hours?: number; value_paise?: number; status?: 'estimated' | 'done' }, version?: number) =>
    requestFull<ChangeRequest>('PATCH', `/change-requests/${id}`, { body: b, ifMatch: version }),
  decideChange: (id: string, b: { decision: 'approve' | 'reject'; add_to_contract: boolean; milestone: { name: string; planned_end: string } | null; reason?: string | null }) =>
    requestFull<ChangeRequest>('POST', `/change-requests/${id}/decision`, { body: b }),

  activity: (id: string) => http.get<ActivityItem[]>(`/projects/${id}/activity`),
  clientView: (id: string) => http.get<ClientView>(`/projects/${id}/client-view`),

  importPreview: (id: string, text: string) => requestFull<ImportPreview>('POST', `/projects/${id}/import`, { query: { mode: 'preview' }, body: { text } }),
  importCommit: (id: string, token: string) => requestFull<{ tasks: number; milestones: number; dependencies: number }>('POST', `/projects/${id}/import`, { query: { mode: 'commit' }, body: { token } }),

  openings: () => http.get<OpeningView[]>('/openings'),
  addOpening: (b: OpeningInput) => requestFull<Opening>('POST', '/openings', { body: b }),
  updateOpening: (id: string, b: Partial<OpeningInput>, version?: number) => requestFull<Opening>('PATCH', `/openings/${id}`, { body: b, ifMatch: version }),
  deleteOpening: (id: string) => requestFull<null>('DELETE', `/openings/${id}`),
}

export const WBS_COLUMNS = ['Milestone', 'Task', 'Owner', 'Estimated hours', 'Start', 'End', 'Complexity', 'Depends on', 'Milestone billing'] as const

/* ================================================================== */
/* v5 — costing, cost calculator, margins (workstream A)               */
/* ================================================================== */
export interface CalendarSummary {
  from: string
  to: string
  calendar_days: number
  weekend_days: number
  holidays: number
  working_days: number
  holiday_list: { date: string; name: string }[]
}
export interface CostingResourceInput {
  key?: string
  id?: string | null // existing allocation id (project costing editor)
  user_id: string | null
  milestone_id?: string | null // existing milestone; null with no index = all milestones
  milestone_index?: number | null // create form: 0-based index into `milestones`
  pct: number | null
  from_on: string | null
  to_on: string | null
}
export interface CostingAdditionalInput {
  id?: string
  category: string
  description: string
  amount_paise: number
}
export interface CostingInput {
  resources: CostingResourceInput[]
  additional_costs: CostingAdditionalInput[]
  maintenance_paise: number
  contingency_pct: number
  markup_pct: number | null
  price_paise: number | null
  /** which of markup / price the user typed last; the other is computed */
  price_mode: 'markup' | 'price'
}
export interface CostingPreviewInput extends CostingInput {
  project_id?: string | null
  start_on: string
  end_on: string
  milestones?: { name: string; billing_amount_paise: number }[]
}
export interface CostingRowView {
  key: string
  id: string | null
  user_id: string | null
  milestone_id: string | null
  milestone_index: number | null
  ms_code: string // M1… or All
  pct: number | null
  from_on: string | null
  to_on: string | null
  working_days: number
  man_days: number
  hours?: number // v6: working days × alloc % × minimum hours per day
  cost_per_hour?: number | null // v6: only with cost_rates.view (rate in the From month)
  cost_per_day: number | null // only with cost_rates.view
  cost: number | null // only with cost_rates.view
  error: string | null
}
export interface CostingTotals {
  resources: number | null
  additional: number | null
  maintenance: number | null
  contingency: number | null
  total_cost: number | null
  price: number | null
  profit: number | null
  margin: number | null
  markup: number | null
  man_days: number
  resource_rows: number
  people: number
}
export interface PlannedMilestone {
  index: number
  id: string | null
  code: string
  name: string
  billing_amount_paise: number
  planned_start: string
  planned_end: string
}
export interface CostingPreview {
  summary: CalendarSummary | null
  milestones: PlannedMilestone[]
  rows: CostingRowView[]
  totals: CostingTotals
  additional_costs: CostingAdditionalInput[]
  maintenance_paise: number
  contingency_pct: number
  markup_pct: number | null
  price_paise: number | null
  floor_pct: number
  below_floor: boolean
  can_see_rates: boolean
  can_see_money: boolean
  loading_pct: number
  avg_working_days_per_month: number | null
  /** v6: cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day); cost/day = minimum hours × cost per hour */
  min_hours?: number
  saved_at: string | null
  saved_by: string | null
  warnings: string[]
}
export interface MarginColumn {
  revenue: number
  cost: number
  profit: number
  margin: number | null
  markup: number | null
}
export interface MarginBridgeLine {
  key: 'planned' | 'crs' | 'logged' | 'late_hours' | 'breach' | 'early' | 'extra' | 'estimates' | 'unplanned' | 'other' | 'contingency' | 'projected'
  label: string
  amount: number
}
export interface MilestoneVarianceRow {
  id: string
  code: string
  name: string
  done: boolean
  deadline: string
  end: string | null
  end_kind: 'actual' | 'forecast' | 'deadline'
  slip_days: number // working days; + late, − early
  planned_cost: number | null
  projected_cost: number | null
  change: number | null
  est_hours: number
  actual_hours: number
  effort_ratio: number | null
  /** v6 */
  planned_hours?: number
  logged_hours?: number
  allocated?: boolean
  spent_to_date?: number | null
  left?: number | null
}
export interface ResourceUseRow {
  user_id: string
  allocated_man_days: number
  allocated_to_date: number
  logged_hours: number
  logged_days: number
  used: number | null // logged ÷ allocated to date
  unplanned: boolean // logged time with no allocation
  planned_cost: number | null // only with cost_rates.view
  /** v6: hours (allocated hours = working days × % × minimum hours per day) */
  allocated_hours?: number
  allocated_hours_to_date?: number
  logged_hours_to_date?: number
  approved_hours?: number
}
export interface EffortTaskRow {
  id: string
  wbs: string
  title: string
  owner_id: string | null
  est_hours: number
  actual_hours: number
  earned_hours: number
  ratio: number | null
  /** v6 */
  milestone_code?: string | null
  done?: boolean
  progress?: number
}
/** v6: one resource-allocation row with its hours and cost (Feature Guide §6 "Resource allocation by milestone"). */
export interface AllocationCostRow {
  id: string
  version: number
  user_id: string
  milestone_id: string | null
  ms_code: string
  ms_name: string
  pct: number
  from_on: string
  to_on: string
  working_days: number
  hours: number
  cost: number | null // only with cost_rates.view
}
/** v6: cost per hour = monthly CTC ÷ (working days in the month × minimum hours per day). */
export interface CostPerHourInfo {
  min_hours: number
  month: string // YYYY-MM (this month)
  working_days: number // in this month, company calendar
  example: { ctc: number; working_days: number; min_hours: number; per_hour: number }
  people: { user_id: string; monthly_ctc: number; cost_per_hour: number }[] // only with cost_rates.view
}
export interface ActualBasis {
  invoiced: number
  invoices: number
  contract: number
  approved_hours: number
  approved_cost: number
  pending_hours: number // logged but not yet approved (not in actual)
  pending_cost: number
  earned_value: number // contract × % complete (secondary)
  next_billing: { code: string; name: string; amount: number; due: string } | null
  additional_excluded: number // plan extras (additional, maintenance) — not in actual, which uses approved hours only
}
export interface CostingAnalysis {
  basis: 'costing' | 'allocations' | 'estimates'
  description: string
  pct_complete: number
  approved_crs: number
  planned: MarginColumn
  projected: MarginColumn
  actual: MarginColumn
  bridge: MarginBridgeLine[]
  contingency_held: number
  profit_if_released: number
  forecast_end: string | null
  milestones: MilestoneVarianceRow[]
  resources: ResourceUseRow[]
  effort: { alert: number; project: number | null; flagged: number; tasks: EffortTaskRow[]; est_hours?: number; actual_hours?: number }
  floor_pct: number
  /** v6 */
  planned_basis?: { allocation_cost: number; estimate_cost: number; additional: number; maintenance: number; contingency: number }
  projected_basis?: { cost_so_far: number; hours_so_far: number; whats_left: number }
  actual_basis?: ActualBasis
  allocations?: AllocationCostRow[]
  rate?: CostPerHourInfo
}
export interface ProjectCostingView {
  can_edit: boolean
  preview: CostingPreview
}
export interface ProjectRowInfo {
  pct_complete: number
  tasks_total: number
  tasks_done: number
  forecast_end: string | null
  slip_days: number | null // working days vs planned end; + late, − early
  contract_incl_crs: number | null
  projected_margin: number | null
}
export interface ProjectSummary {
  project_id: string
  pm_id: string | null
  start_on: string
  end_on: string
  forecast_end: string | null
  milestones: { id: string; code: string; name: string; deadline: string; end: string | null; end_kind: 'actual' | 'forecast' | 'deadline'; state: MilestoneDelivery; billing_amount_paise: number | null; billing_status: Milestone['billing_status'] }[]
  open_tasks: { id: string; wbs: string; title: string; owner_id: string | null; due_on: string; overdue: boolean }[]
  open_count: number
  risks: { id: string; wbs: string; title: string; message: string; critical: boolean }[]
  team_ids: string[]
}
export interface PortfolioMarginRow {
  project_id: string
  code: string
  name: string
  client: string
  status: ProjectStatus
  type: ProjectType
  billing_model: BillingModel
  pct_complete: number
  contract: number
  planned_cost: number
  planned_margin: number | null
  projected_margin: number | null
  margin_delta_pts: number | null
  actual_margin: number | null
  projected_profit: number
  cost_to_date: number
  projected_cost: number
  earned: number
  basis: CostingAnalysis['basis']
  invoiced?: number
  effort_ratio?: number | null
}
export interface PortfolioMargins {
  scope: 'active' | 'open' | 'all'
  floor_pct: number
  kpis: { contract_value: number; projects: number; projected_profit: number; projected_margin: number | null; actual_margin: number | null; earned_to_date: number; cost_to_date: number; planned_margin?: number | null; invoiced?: number; projected_cost?: number }
  cash: { achieved_not_invoiced: number; invoiced_awaiting_payment: number; billable_next_30: number }
  rows: PortfolioMarginRow[]
}
export interface CostRateDay {
  /** v6: cost per hour = CTC ÷ (working days in the month × minimum hours per day) */
  min_hours?: number
  month?: string
  month_working_days?: number
  loading_pct: number
  fy_label: string
  fy_working_days: number
  avg_working_days_per_month: number
  people: { user_id: string; monthly_ctc_paise: number | null; cost_per_day_paise: number | null; cost_per_hour_paise?: number | null }[]
}

export const costingApi = {
  preview: (b: CostingPreviewInput) => http.post<CostingPreview>('/projects/costing/preview', b),
  nextCode: () => http.get<{ code: string }>('/projects/next-code'),
  calendar: (from: string, to: string) => http.get<CalendarSummary>('/projects/calendar-summary', { from, to }),
  get: (projectId: string) => http.get<ProjectCostingView>(`/projects/${projectId}/costing`),
  save: (projectId: string, b: CostingInput) => requestFull<CostingPreview>('PUT', `/projects/${projectId}/costing`, { body: b }),
  summary: (projectId: string) => http.get<ProjectSummary>(`/projects/${projectId}/summary`),
  margins: (scope: PortfolioMargins['scope'] = 'active') => http.get<PortfolioMargins>('/finance/margins', { scope }),
  rateDays: () => http.get<CostRateDay>('/costing/rates'),
}

/* ---------------- v5 change requests (G5.04, workstream B) ---------------- */
export interface CrProposedTask {
  title: string
  est_hours: number
  owner_id: string | null
}
export interface ChangeRequestInput {
  title: string
  description?: string
  requested_by_client: string
  requested_on: string
  hours: number
  impact_days: number
  value_paise: number
  note: string
  proposed_tasks: CrProposedTask[]
}
export interface ChangeRequestList {
  items: ChangeRequest[]
  raised: number
  awaiting: number
  approved_hours: number
  approved_value: number
  baseline_hours: number
  scope_growth: number | null
  next_number: number
  can_manage: boolean
}
export const crApi = {
  list: (projectId: string) => http.get<ChangeRequestList>(`/projects/${projectId}/change-requests`),
  raise: (projectId: string, b: ChangeRequestInput) => requestFull<ChangeRequest>('POST', `/projects/${projectId}/change-requests`, { body: b }),
  update: (id: string, b: Partial<ChangeRequestInput> & { status?: 'estimated' | 'done' }, version?: number) => requestFull<ChangeRequest>('PATCH', `/change-requests/${id}`, { body: b, ifMatch: version }),
  approve: (id: string, b: { add_to_contract: boolean; milestone: { name: string; planned_end: string } | null }) => requestFull<ChangeRequest>('POST', `/change-requests/${id}/decision`, { body: { decision: 'approve', ...b } }),
  reject: (id: string, reason: string) => requestFull<ChangeRequest>('POST', `/change-requests/${id}/decision`, { body: { decision: 'reject', reason, add_to_contract: false, milestone: null } }),
  addTasks: (id: string, b: { milestone_id: string | 'new' | null; tasks: CrProposedTask[] }) =>
    requestFull<{ change_request: ChangeRequest; milestone_id: string; tasks: number }>('POST', `/change-requests/${id}/add-tasks`, { body: b }),
}
/** Milestone add without dates (G4.08: provisional dates after the last milestone). */
export const milestoneApi = {
  addQuick: (projectId: string, b: { name: string; billing_amount_paise: number }) => requestFull<Milestone>('POST', `/projects/${projectId}/milestones`, { body: b }),
}
export interface TaskCreateInputV5 extends TaskCreateInput {
  tag?: import('@/types/entities').TaskTag | null
  backup_id?: string | null
  description?: string
}
export const wbsApi = {
  createTask: (projectId: string, b: TaskCreateInputV5) => requestFull<Task>('POST', `/projects/${projectId}/tasks`, { body: b }),
}
