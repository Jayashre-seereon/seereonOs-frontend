// Module C API client — notifications, timesheets, approvals, team grid, daily updates, leave, payroll.
import { http } from './http'
import type { Page } from './http'
import type { DayKind } from '@/domain/calendar'
import type { DailyUpdate, EntryKind, Holiday, LeaveType, Notification, PayrollLine, PayrollRun, WeekStatus } from '@/types/entities'

/* ---------------- notifications ---------------- */
export type NotificationPage = Page<Notification> & { unread: number }

/* ---------------- timesheets ---------------- */
export interface WeekDay {
  date: string
  kind: DayKind
  holiday: string | null
  leave: { id: string; type: LeaveType; portion: 'full' | 'half'; source: 'timesheet' | 'hr' } | null
  total: number
  min_required: number // 0 on weekly off, holiday and full-day leave
  below_min: boolean // past working day under the minimum (VAL-C01)
  future: boolean
  entry_allowed: boolean // false for future days when future entries are off (VAL-C04)
  /** v5: Sunday is hidden unless the company calendar makes it a working day (or hours were logged on it) */
  hidden?: boolean
  /** v5: 'Holiday' | 'Weekly off' | 'Leave' | 'Half-day leave' | null */
  label?: string | null
  /** v5: hours that count toward the minimum (breaks only when calendar.breaks_count) */
  counted?: number
}
export interface WeekRow {
  key: string
  kind: EntryKind
  task_id: string | null
  internal_code: string | null
  leave_type: LeaveType | null
  note: string
  label: string
  sublabel: string
  wbs: string | null
  project_code: string | null
  project_hue: number | null
  task_status: string | null
  est_hours: number | null
  logged_hours: number | null // all-time hours on the task (all weeks)
  hours: Record<string, number>
  total: number
  locked_reason: string | null // e.g. leave entered by HR
  /** v5: activity rows may name a project (task rows carry their task's project) */
  project_id?: string | null
}
export interface WeekRules {
  min_hours: number
  max_hours: number
  step: number
  allow_future: boolean
  note_required: boolean
  unlock_max_days: number
  bulk_approve: boolean
  /** v5: lunch, tea and stand-up count toward the daily minimum */
  breaks_count?: boolean
}
export interface WeekView {
  id: string | null
  version: number
  user: { id: string; name: string; title: string }
  is_self: boolean
  week_start: string
  week_end: string
  status: WeekStatus
  editable: boolean
  unlocked_until: string | null
  submitted_at: string | null
  decided_at: string | null
  decided_by: { id: string; name: string } | null
  approver: { id: string; name: string } | null
  auto_approved: boolean
  reject_reason: string | null
  unlock_requested_at: string | null
  unlock_reason: string | null
  sla_due: string | null
  late: boolean
  days: WeekDay[]
  rows: WeekRow[]
  total: number
  target: number
  below_min_days: number
  rules: WeekRules
  can_submit: boolean
  can_request_unlock: boolean
  // v5 (Feature Guide §8)
  target_to_date?: number
  counted?: number
  submit_by?: string
  activity_projects?: { id: string; code: string; name: string }[]
  optional_holidays?: { date: string; name: string }[]
}
export interface RowInput {
  kind: EntryKind
  task_id: string | null
  internal_code: string | null
  leave_type: LeaveType | null
  note: string
  hours: Record<string, number>
  project_id?: string | null
}
export interface WorkItem {
  key: string // task:<id> | internal:<code> | leave:<type>
  kind: EntryKind
  task_id: string | null
  internal_code: string | null
  leave_type: LeaveType | null
  label: string
  hint: string
  group: string
  wbs: string | null
  project_code: string | null
}

/* ---------------- approvals ---------------- */
export interface ApprovalItem {
  week_id: string
  version: number
  user: { id: string; name: string; title: string; avatar_hue: number }
  week_start: string
  status: WeekStatus
  total: number
  day_totals: { date: string; total: number; below_min: boolean; kind: DayKind; hidden?: boolean }[]
  days_below_min: number
  submitted_at: string | null
  days_waiting: number
  sla_due: string | null
  overdue: boolean
  via_delegation: boolean
  unlock_requested_at: string | null
  unlock_reason: string | null
}
export interface ApprovalsView {
  pending: ApprovalItem[]
  unlock_requests: ApprovalItem[]
  recent: (ApprovalItem & { decided_at: string | null; late: boolean })[]
  bulk_enabled: boolean
  unlock_max_days: number
  sla_days: number
  /** v5: the viewer's approval KPI (last 30 days; delegates are credited for their own decisions) */
  kpi?: ApprovalKpiView
  can_unlock_any?: boolean
}
export interface ApprovalKpiView {
  user_id: string
  window_days: number
  decided: number
  on_time: number
  late: number
  overdue_now: number
  waiting_within: number
  lapses: number
  on_time_pct: number | null
}
/** v5: "My team's timesheets" grid inside Approvals. */
export interface ApprovalTeamView {
  weeks: string[]
  unlock_max_days: number
  people: {
    user: { id: string; name: string; title: string; avatar_hue: number }
    approver_name: string | null
    via_delegation: boolean
    cells: { week_start: string; status: WeekStatus | 'upcoming'; week_id: string | null; hours: number; unlock_requested: boolean; unlock_reason: string | null; unlocked_until: string | null; can_unlock: boolean }[]
  }[]
}

/* ---------------- team ---------------- */
export type TeamCellStatus = WeekStatus | 'missing' | 'upcoming'
export interface TeamGrid {
  weeks: string[]
  people: {
    user: { id: string; name: string; title: string; avatar_hue: number; role: string; reports_to_id: string | null }
    cells: { week_start: string; status: TeamCellStatus; hours: number; week_id: string | null; late: boolean }[]
    utilisation: number | null // task hours ÷ capacity this week
    hours_this_week: number
  }[]
  managers: { user: { id: string; name: string; avatar_hue: number }; decided: number; on_time: number; late: number; overdue: number; pending: number; score: number }[]
}

/* ---------------- daily ---------------- */
export interface DailyView {
  date: string
  mine: DailyUpdate | null
  recent: DailyUpdate[]
  proof_required: boolean
  team: { user: { id: string; name: string; title: string; avatar_hue: number }; update: DailyUpdate | null; on_leave: boolean }[] | null
  /** v5: this week's Friday demo (stored on Friday, or the working day before it) */
  demo?: { date: string; week_start: string; shown: boolean; note: string; editable: boolean }
}
/** v5: leave taken this financial year, person × type. */
export interface LeaveSummary {
  fy_label: string
  from: string
  to: string
  min_hours: number
  types: LeaveType[]
  rows: { user: { id: string; name: string; title: string; avatar_hue: number }; by_type: Record<LeaveType, number>; half_days: number; timesheet_days: number; total: number }[]
}

/* ---------------- leave ---------------- */
export interface LeaveRow {
  id: string
  user_id: string
  user_name: string
  date: string
  type: LeaveType
  portion: 'full' | 'half'
  source: 'timesheet' | 'hr'
  week_status: WeekStatus | null
  can_delete: boolean
}
export interface LeaveView {
  items: LeaveRow[]
  holidays: Pick<Holiday, 'date' | 'name' | 'optional'>[]
  can_hr_entry: boolean
  /** May use the "Everyone" scope (leave.hr_entry or people.view_all). */
  can_see_all?: boolean
  scope: 'mine' | 'team' | 'all'
}

/* ---------------- payroll ---------------- */
export interface PayrollLineView extends PayrollLine {
  user: { id: string; name: string; title: string; role: string; avatar_hue: number }
  unapproved_detail: { week_start: string; days: number; status: WeekStatus | 'missing' }[]
  would_deduct_paise: number // BR-12 amount even when deduction is switched off
  deduct_applied: boolean
  sales: { target_paise: number; achieved_paise: number; achievement: number; variable_at_stake_paise: number; threshold_pct: number } | null
  no_rate: boolean
  // v5 (Feature Guide §10)
  /** days in weeks not over yet, or submitted and waiting for the manager — not deducted (yet) */
  pending_days?: number
  /** `unapproved_days` = not approved: the week ended and is locked, rejected, still a draft or missing */
  approver_name?: string | null
  self_approves?: boolean
  employee_code?: string | null
  /** reasons to chase before paying (unsubmitted / unapproved weeks) */
  flags?: string[]
}
export interface PayrollRunView {
  run: PayrollRun
  lines: PayrollLineView[]
  totals: { ctc: number; base: number; deduction: number; would_deduct: number; variable: number; net: number; unapproved_days: number; lwp_days: number; pending_days?: number }
  deduct_enabled: boolean
  working_days: number
}
export interface PayrollListItem extends PayrollRun {
  people: number
  net_paise: number
}

export const workApi = {
  // notifications
  notifications: (q: { limit?: number; filter?: 'unread' | 'all'; page?: number } = {}) => http.get<NotificationPage>('/notifications', q),
  readNotification: (id: string) => http.post(`/notifications/${id}/read`),
  readAll: () => http.post<{ updated: number }>('/notifications/read-all'),

  // timesheets
  week: (week: string, user?: string) => http.get<WeekView>(`/timesheets/${week}`, user ? { user } : undefined),
  saveWeek: (week: string, rows: RowInput[], version?: number) => http.full<WeekView>('PUT', `/timesheets/${week}`, { body: { rows }, ifMatch: version }),
  submitWeek: (week: string, rows: RowInput[] | null, version?: number) => http.full<WeekView>('POST', `/timesheets/${week}/submit`, { body: { rows }, ifMatch: version }),
  requestUnlock: (week: string, reason: string) => http.full<WeekView>('POST', `/timesheets/${week}/unlock-request`, { body: { reason } }),
  copyPrevious: (week: string, with_hours: boolean) => http.full<WeekView>('POST', `/timesheets/${week}/copy-previous`, { body: { with_hours } }),
  workItems: (week: string) => http.get<WorkItem[]>('/timesheet/work-items', { week }),

  // approvals
  approvals: () => http.get<ApprovalsView>('/approvals'),
  approvalSummary: () => http.get<{ pending: number; overdue: number }>('/approvals/summary'),
  approve: (weekId: string) => http.full<{ id: string }>('POST', `/approvals/${weekId}/approve`),
  reject: (weekId: string, reason: string) => http.full<{ id: string }>('POST', `/approvals/${weekId}/reject`, { body: { reason } }),
  bulkApprove: (ids: string[]) => http.full<{ approved: string[]; skipped: { id: string; reason: string }[] }>('POST', '/approvals/bulk-approve', { body: { ids } }),
  unlock: (weekId: string, days: number) => http.full<{ id: string; unlock_until: string }>('POST', `/approvals/${weekId}/unlock`, { body: { days } }),
  denyUnlock: (weekId: string, reason: string) => http.full<{ id: string }>('POST', `/approvals/${weekId}/deny-unlock`, { body: { reason } }),

  // team
  teamGrid: (weeks = 8) => http.get<TeamGrid>('/team/grid', { weeks }),

  // daily
  daily: (date: string) => http.get<DailyView>('/daily', { date }),
  postDaily: (b: { date: string; done: string; proof_url: string; blocker: string; demo_shown?: boolean }) => http.full<DailyUpdate>('POST', '/daily', { body: b }),

  // leave
  leave: (q: { user?: string; from?: string; to?: string; scope?: 'mine' | 'team' | 'all' } = {}) => http.get<LeaveView>('/leave', q),
  addLeave: (b: { user_id?: string; from: string; to?: string; type: LeaveType; portion: 'full' | 'half' }) => http.full<{ created: number }>('POST', '/leave', { body: b }),
  deleteLeave: (id: string) => http.del(`/leave/${id}`),
  holidays: (from: string, to: string) => http.get<Pick<Holiday, 'date' | 'name' | 'optional'>[]>('/holidays-lite', { from, to }),

  // payroll
  payrollRuns: () => http.get<PayrollListItem[]>('/payroll'),
  runPayroll: (month: string) => http.full<PayrollRunView>('POST', '/payroll/run', { body: { month } }),
  payrollRun: (id: string) => http.get<PayrollRunView>(`/payroll/${id}`),
  recompute: (id: string) => http.full<PayrollRunView>('POST', `/payroll/${id}/recompute`),
  finalise: (id: string, version?: number) => http.full<PayrollRunView>('POST', `/payroll/${id}/finalise`, { ifMatch: version }),
}

/* ---------------- v5 (Feature Guide §8–10, §16): time, approvals team grid, demo, leave summary ---------------- */
export const timeApi = {
  approvalTeam: (weeks = 4) => http.get<ApprovalTeamView>('/approvals/team', { weeks }),
  /** Unlock a locked week (with or without the person's request). `reason` is required without a request. */
  unlock: (weekId: string, days: number, reason: string) => http.full<{ id: string; unlock_until: string; user_name: string }>('POST', `/approvals/${weekId}/unlock`, { body: { days, reason } }),
  /** Unlock a week that ended with no timesheet at all. */
  unlockMissing: (userId: string, weekStart: string, days: number, reason: string) =>
    http.full<{ id: string; unlock_until: string; user_name: string }>('POST', '/approvals/unlock-week', { body: { user_id: userId, week_start: weekStart, days, reason } }),
  saveDemo: (b: { date: string; demo_shown: boolean; demo_note: string }) => http.full<DailyUpdate>('POST', '/daily/demo', { body: b }),
  leaveSummary: (fy?: number) => http.get<LeaveSummary>('/leave/summary', fy ? { fy } : undefined),
}

/* ---------------- v5 delivery: task stages, all tasks, risks, mentions, estimate check (workstream B) ---------------- */
import type { Complexity as CxV5, Task as TaskV5Row, TaskStage as StageV5, TaskStatus as StatusV5, TaskTag as TagV5 } from '@/types/entities'
import type { MyTask as MyTaskBase, TaskDetailV3 } from './tasks'
import type { EstimateHint } from '@/mock/analytics'
export type { EstimateHint }

/** A dependency link with owner, stage and dates (Waiting on / Blocks). */
export interface RiskTaskLink {
  id: string
  wbs: string
  title: string
  owner_id: string | null
  stage: StageV5
  progress: number
  done: boolean
  start_on: string
  due_on: string
  done_on: string | null
  forecast_start: string
  forecast_end: string
  /** waits: this open dependency ends on/after our forecast start · blocks: the dependent starts before we finish */
  held_up: boolean
}
export interface TaskDetailV5 extends TaskDetailV3 {
  stage: StageV5
  progress: number
  stage_since: string
  forecast_start: string | null
  forecast_end: string | null
  float_days: number | null
  critical: boolean
  waiting_on: RiskTaskLink[]
  blocks: RiskTaskLink[]
  cancelled: boolean
}
export interface MyTaskV5 extends MyTaskBase {
  stage: StageV5
  progress: number
  tag: TagV5 | null
  backup_id: string | null
  can_submit: boolean
  can_review: boolean
  covering_days?: string[]
  covering_reason?: 'leave' | 'delegation'
}
export interface MyTasksV5 {
  tasks: MyTaskV5[]
  covering: MyTaskV5[]
  hours_this_week?: number
  backing?: number
  week?: string
}
export interface AllTaskRow {
  id: string
  wbs: string
  title: string
  project_id: string
  project_code: string
  project_name: string
  project_hue: number
  general: boolean
  milestone_id: string | null
  milestone_label: string | null
  owner_id: string | null
  backup_id: string | null
  reviewer_id: string | null
  stage: StageV5
  progress: number
  status: StatusV5
  tag: TagV5 | null
  complexity: CxV5
  est_hours: number
  logged_hours: number
  start_on: string
  due_on: string
  done_on: string | null
  overdue_days: number
  forecast_end: string | null
  critical: boolean
  blocked_by: number
  comments: number
  version: number
  can_move: boolean
  can_edit: boolean
  can_submit: boolean
  can_review: boolean
  /** v6 (Tasks tab): dependencies with owner and stage; `blocking` = the open ones */
  depends_on?: TaskDepLink[]
  blocking?: TaskDepLink[]
  /** v6: the owner's leave days in the viewed week (backup covers on those days) */
  owner_leave_days?: string[]
  /** v6: set when I'm covering this task for the owner */
  covering?: { days: string[]; reason: 'leave' | 'delegation'; from_user_id: string } | null
  tagged?: boolean
  can_log_time?: boolean
  /** v7: why the viewer can see it (covering, reviewer …), professional fields */
  relation?: TaskRelationV7 | null
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  concerned_manager_id?: string | null
  watcher_ids?: string[]
  labels?: string[]
  billable?: boolean
  recurrence?: 'none' | 'weekly' | 'monthly'
  criteria_total?: number
  criteria_done?: number
  attachments?: number
  owner_department?: string | null
}
export interface TaskDepLink {
  id: string
  wbs: string
  title: string
  owner_id: string | null
  stage: StageV5
  done: boolean
}
export type TaskChip = '' | 'mine' | 'covering' | 'tagged' | 'overdue' | 'blocked'
export interface AllTasksResponse {
  items: AllTaskRow[]
  total: number
  facets: { projects: { id: string; code: string; name: string }[]; milestones: { id: string; project_id: string; label: string }[]; people: string[]; departments?: { id: string; name: string; count: number }[]; labels?: { name: string; count: number }[] }
  wide: boolean
  /** v6: the filters the server applied ('all' = everyone), and counts for the chips / status selects */
  person?: string
  status?: string
  stage?: string
  chip?: string
  week?: string
  manager?: boolean
  counts?: { all: number; mine: number; covering: number; tagged: number; overdue: number; blocked: number }
  status_counts?: Record<string, number>
  stage_counts?: Record<string, number>
  /** v7 */
  view_all?: boolean
  department?: string
  label?: string
  group?: string
  groups?: TaskEmployeeGroup[]
  scope_note?: string | null
}
export interface TaskEmployeeGroup {
  user_id: string | null
  name: string
  department: string | null
  open: number
  overdue: number
  done_week: number
  total: number
  est_open: number
}
export interface AllTasksQuery {
  q?: string
  /** 'all' = everyone, 'me', or a user id (owner). Omitted = server default (me for employees, everyone for managers). */
  person?: string
  /** v6: 'open' (default) | 'all' | todo | in_progress | blocked | in_review | done */
  status?: string
  chip?: TaskChip
  week?: string
  project?: string
  milestone?: string
  stage?: string // 'open' (default) | 'all' | 'done' | 'in_review' | a stage key
  tag?: string
  complexity?: string
  overdue?: '1' | ''
  /** v7 */
  department?: string
  label?: string
  group?: 'employee' | ''
}
export interface RiskRow {
  id: string
  wbs: string
  title: string
  project_id: string
  project_code: string
  project_name: string
  general: boolean
  milestone_id: string | null
  milestone_label: string | null
  milestone_no: number | null
  owner_id: string | null
  backup_id: string | null
  reviewer_id: string | null
  complexity: CxV5
  tag: TagV5 | null
  est_hours: number
  logged_hours: number
  stage: StageV5
  progress: number
  status: StatusV5
  start_on: string
  due_on: string
  baseline_due_on: string | null
  revised_on: string | null
  revisions: number
  slip_flagged_on: string | null
  slip_note: string | null
  actual_start_on: string | null
  forecast_start: string
  forecast_end: string
  note: string | null
  stage_since: string | null
  breached: boolean
  high_risk: boolean
  critical: boolean
  float_days: number
  reasons: string[]
  headline: string
  waiting_on: RiskTaskLink[]
  blocks: RiskTaskLink[]
  comments: number
  version: number
  can_move: boolean
  can_edit: boolean
  can_submit: boolean
  can_review: boolean
}
export interface MentionRow {
  id: string
  task_id: string
  wbs: string
  title: string
  tag: TagV5 | null
  stage: StageV5
  project_id: string
  project_code: string
  project_name: string
  author_id: string
  at: string
  body: string
}
export interface TaskPatchV5 {
  title?: string
  owner_id?: string | null
  backup_id?: string | null
  est_hours?: number
  start_on?: string
  due_on?: string
  complexity?: CxV5
  tag?: TagV5 | null
  description?: string
  milestone_id?: string | null
  due_change_reason?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  reviewer_id?: string | null
}

export const deliveryApi = {
  allTasks: (q: AllTasksQuery = {}) => http.get<AllTasksResponse>('/tasks', q as Record<string, unknown>),
  myTasks: (week?: string) => http.get<MyTasksV5>('/my-tasks', week ? { week } : undefined),
  detail: (id: string) => http.get<TaskDetailV5>(`/tasks/${id}`),
  risks: (projectId?: string) => http.get<RiskRow[]>('/delivery/risks', projectId ? { project_id: projectId } : undefined),
  mentions: (user?: string, limit = 10) => http.get<MentionRow[]>('/tasks/mentions', { ...(user ? { user } : {}), limit }),
  estimateHint: (q: { owner_id?: string | null; complexity: CxV5; est?: number | null }) =>
    http.get<EstimateHint>('/tasks/estimate-hint', { owner_id: q.owner_id ?? '', complexity: q.complexity, est: q.est ?? '' }),
  setStage: (id: string, b: { stage: StageV5; progress?: number | null; note?: string | null; quality_rating?: number }) => http.full<TaskV5Row>('POST', `/tasks/${id}/stage`, { body: b }),
  setProgress: (id: string, b: { progress: number; note?: string }) => http.full<TaskV5Row>('POST', `/tasks/${id}/progress`, { body: b }),
  flagSlip: (id: string, b: { note: string; new_due_on?: string | null }) => http.full<TaskV5Row>('POST', `/tasks/${id}/flag-slip`, { body: b }),
  cancel: (id: string, reason: string) => http.full<TaskV5Row>('POST', `/tasks/${id}/cancel`, { body: { reason } }),
  update: (id: string, patch: TaskPatchV5, version?: number) => http.full<TaskV5Row>('PATCH', `/tasks/${id}`, { body: patch, ifMatch: version }),
}
/** Extra fields the team-task rows carry in v5. */
export interface TeamTaskRowV5 {
  stage: StageV5
  progress: number
  tag: TagV5 | null
  complexity: CxV5
  backup_id: string | null
  version: number
  can_move: boolean
  can_submit: boolean
  can_review: boolean
}

/* ---------------- v6: Tasks tab and task page (Feature Guide §7) ---------------- */
export interface TaskDetailV6 extends TaskDetailV5 {
  downstream_ids?: string[]
  owner_leave_days?: string[]
  covering_me?: { days: string[]; reason: 'leave' | 'delegation'; from_user_id: string } | null
  can_log_time?: boolean
  comments_count?: number
}
export const tasksTabApi = {
  list: (q: AllTasksQuery = {}) => http.get<AllTasksResponse>('/tasks', q as Record<string, unknown>),
  detail: (id: string) => http.get<TaskDetailV6>(`/tasks/${id}`),
}

/* ---------------- v7: task visibility + professional create form ---------------- */
export type TaskRelationV7 = 'owner' | 'covering' | 'backup' | 'reviewer' | 'concerned_manager' | 'project_manager' | 'assigned_by' | 'watcher' | 'tagged'
export const TASK_RELATION: Record<TaskRelationV7, { label: string; tone: 'neutral' | 'info' | 'warning' | 'success' | 'brand' }> = {
  owner: { label: 'Mine', tone: 'neutral' },
  covering: { label: 'Covering', tone: 'warning' },
  backup: { label: 'Backup', tone: 'neutral' },
  reviewer: { label: 'Reviewer', tone: 'info' },
  concerned_manager: { label: 'Concerned manager', tone: 'info' },
  project_manager: { label: 'Project manager', tone: 'info' },
  assigned_by: { label: 'Assigned by me', tone: 'neutral' },
  watcher: { label: 'Watching', tone: 'neutral' },
  tagged: { label: 'Tagged me', tone: 'info' },
}
export type TaskPriorityV7 = 'low' | 'normal' | 'high' | 'urgent'
/** P1–P4 labels over the stored priority values. */
export const PRIORITY_P: Record<TaskPriorityV7, { code: string; label: string; tone: 'danger' | 'warning' | 'neutral' | 'info' }> = {
  urgent: { code: 'P1', label: 'P1 · Urgent', tone: 'danger' },
  high: { code: 'P2', label: 'P2 · High', tone: 'warning' },
  normal: { code: 'P3', label: 'P3 · Normal', tone: 'neutral' },
  low: { code: 'P4', label: 'P4 · Low', tone: 'info' },
}
export interface TaskAttachment { id: string; name: string; size: number; type: string; data_url?: string | null; uploaded_by: string; at: string }
export interface TaskCriterion { text: string; done: boolean }
export interface TaskDetailV7 extends TaskDetailV6 {
  relation?: TaskRelationV7 | null
  relation_label?: string | null
  concerned_manager_id?: string | null
  concerned_manager_default?: boolean
  watcher_ids?: string[]
  watching?: boolean
  acceptance_criteria?: TaskCriterion[]
  criteria_done?: number
  labels?: string[]
  billable?: boolean
  recurrence?: 'none' | 'weekly' | 'monthly'
  recurrence_of?: { id: string; wbs: string; title: string } | null
  next_occurrence?: { id: string; wbs: string; title: string; due_on: string } | null
  attachments?: TaskAttachment[]
  parent?: { id: string; wbs: string; title: string } | null
  children?: { id: string; wbs: string; title: string; status: string; owner_id: string | null; due_on: string }[]
  priority?: TaskPriorityV7
  can_tick_criteria?: boolean
  can_attach?: boolean
  can_create_followup?: boolean
}
export interface TaskCreateOptionMilestone { id: string; no: number; name: string; planned_start: string; planned_end: string; next_wbs: string }
export interface TaskCreateOptionProject {
  id: string
  code: string
  name: string
  general: boolean
  status: string
  start_on: string
  end_on: string
  pm_id: string | null
  /** I can create tasks here for anyone (PM / admin with tasks.edit) */
  anyone: boolean
  /** I can create here only for myself or my reports (general work) */
  team_only: boolean
  milestones: TaskCreateOptionMilestone[]
  milestone_required: boolean
  next_wbs_none: string
  tasks: { id: string; wbs: string; title: string; status: string; owner_id: string | null; milestone_id: string | null }[]
  team_ids: string[]
}
export interface TaskCreateOptions {
  me: string
  my_manager_id: string | null
  general_project_id: string
  view_all: boolean
  can_assign_team: boolean
  team_ids: string[]
  projects: TaskCreateOptionProject[]
  labels: string[]
  min_hours_per_day: number
  productive_hours: Record<string, number>
}
export interface TaskCreateBody {
  title: string
  description?: string
  project_id: string
  milestone_id?: string | null
  tag?: string | null
  owner_id: string
  backup_id?: string | null
  reviewer_id: string
  concerned_manager_id?: string | null
  priority?: TaskPriorityV7
  complexity?: string
  est_hours: number
  start_on: string
  due_on: string
  depends_on?: string[]
  watcher_ids?: string[]
  acceptance_criteria?: string[]
  attachments?: { name: string; size: number; type: string; data_url: string | null }[]
  labels?: string[]
  billable?: boolean
  recurrence?: 'none' | 'weekly' | 'monthly'
  parent_task_id?: string | null
}
export interface TaskPatchV7 extends TaskPatchV5 {
  concerned_manager_id?: string | null
  watcher_ids?: string[]
  acceptance_criteria?: TaskCriterion[]
  labels?: string[]
  billable?: boolean
  recurrence?: 'none' | 'weekly' | 'monthly'
}
export const taskV7Api = {
  options: (projectId?: string) => http.get<TaskCreateOptions>('/tasks/create-options', projectId ? { project_id: projectId } : undefined),
  create: (b: TaskCreateBody) => http.full<import('@/types/entities').Task & { wbs: string }>('POST', '/tasks', { body: b }),
  detail: (id: string) => http.get<TaskDetailV7>(`/tasks/${id}`),
  update: (id: string, patch: TaskPatchV7, version?: number) => http.full<import('@/types/entities').Task>('PATCH', `/tasks/${id}`, { body: patch, ifMatch: version }),
  watch: (id: string, watch: boolean) => http.full<TaskDetailV7>('POST', `/tasks/${id}/watch`, { body: { watch } }),
  tickCriterion: (id: string, index: number, done: boolean) => http.full<TaskDetailV7>('POST', `/tasks/${id}/criteria`, { body: { index, done } }),
  attach: (id: string, file: { name: string; size: number; type: string; data_url: string | null }) => http.full<TaskDetailV7>('POST', `/tasks/${id}/attachments`, { body: file }),
  removeAttachment: (id: string, aid: string) => http.full<TaskDetailV7>('DELETE', `/tasks/${id}/attachments/${aid}`),
}
