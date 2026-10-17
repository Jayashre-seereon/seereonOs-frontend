// People & HR API client — leave requests, appraisals, goals, feedback, performance profiles,
// recruitment, onboarding/exits, assets and the HR dashboard. View types are shared with the mock routes.
import { http, requestFull } from './http'
import { useApi } from './query'
import type { LeaveType, Role } from '@/types/entities'
import type {
  Appraisal, AppraisalCycle, AppraisalStatus, Asset, Candidate, CandidateStage, ChecklistItem, Feedback, Goal, Interview, LeavePolicy, LeaveRequest, LifecycleChecklist,
} from '@/types/business'

/* ---------------- Leave ---------------- */
export interface LeaveBalance {
  type: LeaveType
  annual: number
  accrued: number
  used: number
  pending: number
  remaining: number
  accrual: 'upfront' | 'monthly'
}
export interface LeaveRequestView extends LeaveRequest {
  user_name: string
  user_hue: number
  approver_name: string | null
  can_approve: boolean
  can_cancel: boolean
  via_delegation: boolean
}
export interface LeaveRequestsView {
  mine: LeaveRequestView[]
  to_approve: LeaveRequestView[]
  team: LeaveRequestView[] // decided + pending requests of people I approve (or everyone for HR)
  balances: LeaveBalance[]
  policies: LeavePolicy[]
  can_manage_policy: boolean
  is_approver: boolean
  fy_label: string
}
export interface LeaveInput {
  from_on: string
  to_on: string
  type: LeaveType
  portion: 'full' | 'half'
  reason: string
}

/* ---------------- Performance ---------------- */
export interface PerfKpis {
  on_time_pct: number | null
  avg_variance_days: number | null
  first_pass_pct: number | null
  avg_quality: number | null
  completed: number
  late: number
  overdue_open: number
  open: number
  timesheet_compliance: number | null
  expected_weeks: number
  approved_weeks: number
  late_submissions: number
  utilisation: number | null // average allocation (0..1+)
  goals_total: number
  goals_achieved: number
  goals_score: number | null
  approval_sla_pct: number | null // only for people who approve timesheets
}
export interface PerfTaskRow {
  id: string
  code: string
  title: string
  project: string
  status: string
  due_on: string
  done_on: string | null
  timeliness: 'early' | 'on_time' | 'late' | null
  variance_days: number | null
  delay_reason: string | null
  quality_rating: number | null
  overdue_days: number
}
export interface GoalView extends Goal {
  user_name: string
  progress: number // current / target (0..∞)
  can_edit: boolean
  can_approve: boolean
  /** may mark the goal achieved or missed (managers and HR) */
  can_close: boolean
}
export interface FeedbackView extends Feedback {
  from_name: string
  from_hue: number
  to_name: string
}
export interface AppraisalHistoryRow {
  id: string
  cycle_name: string
  period_from: string
  period_to: string
  status: AppraisalStatus
  final_rating: number | null
  increment_pct: number | null
  promotion_to: string | null
}
export interface PerformanceProfile {
  user: { id: string; name: string; title: string; role: Role; avatar_hue: number; joined_on: string; manager_name: string | null; department: string }
  from: string
  to: string
  kpis: PerfKpis
  trend: { month: string; label: string; on_time_pct: number | null; completed: number }[]
  tasks: PerfTaskRow[]
  delay_reasons: { code: string; label: string; count: number }[]
  goals: GoalView[]
  feedback: FeedbackView[]
  appraisals: AppraisalHistoryRow[]
  cycles: { id: string; name: string; status: string }[]
  can_add_goal: boolean
  can_give_feedback: boolean
  is_self: boolean
  is_manager: boolean
}
export interface PeopleOption {
  id: string
  name: string
  title: string
  avatar_hue: number
  on_time_pct: number | null
}

/* ---------------- Appraisals ---------------- */
export interface CycleView extends AppraisalCycle {
  counts: Record<AppraisalStatus, number>
  total: number
}
export interface Metrics {
  on_time_pct: number | null
  avg_variance_days: number | null
  first_pass_pct: number | null
  avg_quality: number | null
  tasks_completed: number
  timesheet_compliance: number | null
  late_submissions: number
  goals_score: number | null
  approval_sla_pct: number | null
  score_tasks: number | null
  score_timesheets: number | null
  score_goals: number | null
  score_behaviour: number | null
  suggested: number | null
}
export interface AppraisalRow {
  id: string
  cycle_id: string
  user_id: string
  user_name: string
  user_title: string
  user_hue: number
  manager_id: string | null
  manager_name: string | null
  status: AppraisalStatus
  self_rating: number | null
  manager_rating: number | null
  final_rating: number | null
  suggested: number | null
  on_time_pct: number | null
  increment_pct: number | null
  overdue: boolean
  due_on: string | null
}
export interface AppraisalsView {
  mode: 'hr' | 'manager' | 'self'
  cycles: CycleView[]
  cycle: CycleView | null
  rows: AppraisalRow[]
  distribution: { rating: string; count: number }[]
  overdue: AppraisalRow[]
  can_manage: boolean
}
export interface AppraisalDetail extends Appraisal {
  cycle: AppraisalCycle
  user: { id: string; name: string; title: string; avatar_hue: number; joined_on: string }
  manager_name: string | null
  live: Metrics
  goals: GoalView[]
  stage_for_viewer: 'self' | 'manager' | 'hr' | 'view'
  viewer: { is_self: boolean; is_manager: boolean; is_hr: boolean }
  show_ratings: boolean // employee sees manager/HR ratings only once completed
  sent_back_reason?: string | null
}

/* ---------------- Recruitment ---------------- */
export interface OpeningLite {
  id: string
  role: string
  project: string | null
  status: string
  count: number
  owner_id: string
  owner_name: string
  needed_by: string | null
  candidates: number
  hired: number
}
export interface CandidateRow extends Candidate {
  opening_role: string
  interviews_total: number
  interviews_passed: number
  next_interview: string | null
  resume_name: string | null
  days_in_pipeline: number
}
export interface RecruitmentView {
  openings: OpeningLite[]
  candidates: CandidateRow[]
  metrics: { open_positions: number; active: number; avg_time_to_hire: number | null; hired_90: number; offers_out: number; by_source: { source: string; count: number; hired: number }[] }
}
export interface InterviewView extends Interview {
  interviewer_name: string
}
export interface CandidateDetail extends CandidateRow {
  interviews: InterviewView[]
  resume: { id: string; name: string; size_bytes: number; data_url: string | null } | null
  history: { at: string; summary: string; actor: string }[]
  invite: { id: string; email: string; accepted: boolean } | null
}

/* ---------------- Lifecycle ---------------- */
export interface ChecklistItemView extends ChecklistItem {
  due_on: string
  overdue: boolean
  done_by_name: string | null
  can_toggle: boolean
}
export interface ChecklistView extends Omit<LifecycleChecklist, 'items'> {
  items: ChecklistItemView[]
  person_name: string
  person_title: string
  person_hue: number
  person_status: 'active' | 'deactivated' | 'invited'
  done: number
  total: number
  overdue: number
  assets_out: number
}
export interface LifecycleView {
  items: ChecklistView[]
  people: { id: string; name: string; kind: 'user' | 'invite' }[]
}

/* ---------------- Assets ---------------- */
export interface AssetView extends Asset {
  assignee_name: string | null
  assignee_status: 'active' | 'deactivated' | 'invited' | null
  pending_return: boolean
  warranty_expired: boolean
}
export interface AssetsView {
  mode: 'all' | 'mine'
  items: AssetView[]
  summary: { total: number; assigned: number; in_stock: number; repair: number; pending_return: number; value_paise: number }
}
export interface AssetInput {
  tag: string
  name: string
  category: Asset['category']
  serial: string
  purchase_on: string
  purchase_cost_paise: number
  warranty_until: string | null
  notes: string
}

/* ---------------- Dashboard ---------------- */
export interface HrDashboard {
  headcount: number
  joiners_q: number
  exits_q: number
  attrition_pct: number | null
  quarter_label: string
  open_positions: number
  candidates_by_stage: { stage: CandidateStage; count: number }[]
  pending_leave: number
  pending_leave_items: { id: string; name: string; hue: number; type: LeaveType; from_on: string; to_on: string; days: number; approver: string | null }[]
  on_time_pct: number | null
  cycle: { id: string; name: string; status: string; total: number; completed: number; counts: Record<AppraisalStatus, number> } | null
  lifecycle_due: { checklist_id: string; person: string; kind: 'onboarding' | 'offboarding'; label: string; due_on: string; days: number }[]
  assets_due_back: { id: string; tag: string; name: string; person: string; last_day: string | null }[]
  /** v7 "Needs attention": what needs HR's action today, each count linking to the screen that clears it. */
  attention: { key: string; label: string; count: number; to: string; hint?: string }[]
}

const q = (o: Record<string, unknown>) => o
export const hrApi = {
  // leave
  leaveRequests: () => http.get<LeaveRequestsView>('/leave-requests'),
  applyLeave: (b: LeaveInput) => requestFull<LeaveRequest>('POST', '/leave-requests', { body: b }),
  approveLeave: (id: string) => requestFull<LeaveRequest>('POST', `/leave-requests/${id}/approve`, {}),
  rejectLeave: (id: string, reason: string) => requestFull<LeaveRequest>('POST', `/leave-requests/${id}/reject`, { body: { reason } }),
  cancelLeave: (id: string) => requestFull<LeaveRequest>('POST', `/leave-requests/${id}/cancel`, {}),
  savePolicy: (type: LeaveType, b: Pick<LeavePolicy, 'annual_days' | 'carry_forward_max' | 'accrual'>, version?: number) => requestFull<LeavePolicy>('PUT', `/leave-policies/${type}`, { body: b, ifMatch: version }),
  // performance
  performance: (userId: string | undefined, from: string, to: string) => http.get<PerformanceProfile>(userId ? `/performance/${userId}` : '/performance/me', q({ from, to })),
  performancePeople: () => http.get<PeopleOption[]>('/performance-people'),
  // goals & feedback
  addGoal: (b: Partial<Goal>) => requestFull<Goal>('POST', '/goals', { body: b }),
  updateGoal: (id: string, b: Partial<Goal>, version?: number) => requestFull<Goal>('PATCH', `/goals/${id}`, { body: b, ifMatch: version }),
  approveGoal: (id: string) => requestFull<Goal>('POST', `/goals/${id}/approve`, {}),
  deleteGoal: (id: string) => requestFull<null>('DELETE', `/goals/${id}`, {}),
  addFeedback: (b: Pick<Feedback, 'to_user_id' | 'kind' | 'body' | 'visibility'>) => requestFull<Feedback>('POST', '/feedback', { body: b }),
  // appraisals
  appraisals: (cycleId?: string) => http.get<AppraisalsView>('/appraisals', q({ cycle_id: cycleId })),
  appraisal: (id: string) => http.get<AppraisalDetail>(`/appraisals/${id}`),
  createCycle: (b: Omit<AppraisalCycle, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version' | 'status'>) => requestFull<AppraisalCycle>('POST', '/appraisal-cycles', { body: b }),
  launchCycle: (id: string) => requestFull<{ created: number }>('POST', `/appraisal-cycles/${id}/launch`, {}),
  closeCycle: (id: string) => requestFull<AppraisalCycle>('POST', `/appraisal-cycles/${id}/close`, {}),
  submitSelf: (id: string, b: { rating: number; comments: string }, version?: number) => requestFull<Appraisal>('POST', `/appraisals/${id}/self`, { body: b, ifMatch: version }),
  submitManager: (id: string, b: { rating: number; comments: string }, version?: number) => requestFull<Appraisal>('POST', `/appraisals/${id}/manager`, { body: b, ifMatch: version }),
  submitHr: (id: string, b: { rating: number; comments: string; increment_pct: number; promotion_to: string | null }, version?: number) => requestFull<Appraisal>('POST', `/appraisals/${id}/hr`, { body: b, ifMatch: version }),
  sendBack: (id: string, reason: string) => requestFull<Appraisal>('POST', `/appraisals/${id}/send-back`, { body: { reason } }),
  // recruitment
  recruitment: () => http.get<RecruitmentView>('/recruitment'),
  candidate: (id: string) => http.get<CandidateDetail>(`/candidates/${id}`),
  addCandidate: (b: Partial<Candidate>) => requestFull<Candidate>('POST', '/candidates', { body: b }),
  updateCandidate: (id: string, b: Partial<Candidate>, version?: number) => requestFull<Candidate>('PATCH', `/candidates/${id}`, { body: b, ifMatch: version }),
  moveCandidate: (id: string, b: { stage: CandidateStage; reason?: string; joining_on?: string; offer_ctc_paise?: number | null }) =>
    requestFull<Candidate & { invite_id?: string; checklist_id?: string }>('POST', `/candidates/${id}/move`, { body: b }),
  uploadResume: (id: string, f: { name: string; mime: string; size_bytes: number; data_url: string }) => requestFull<Candidate>('POST', `/candidates/${id}/resume`, { body: f }),
  addInterview: (id: string, b: Pick<Interview, 'kind' | 'scheduled_at' | 'interviewer_id'>) => requestFull<Interview>('POST', `/candidates/${id}/interviews`, { body: b }),
  recordInterview: (id: string, b: Pick<Interview, 'result' | 'rating' | 'feedback'>) => requestFull<Interview>('PATCH', `/interviews/${id}`, { body: b }),
  // lifecycle
  lifecycle: () => http.get<LifecycleView>('/lifecycle'),
  startLifecycle: (b: { kind: 'onboarding' | 'offboarding'; person_id: string; start_on: string; last_day?: string | null; exit_type?: string | null; exit_reason?: string | null; rehire_eligible?: boolean | null }) =>
    requestFull<LifecycleChecklist>('POST', '/lifecycle', { body: b }),
  toggleItem: (id: string, itemId: string, done: boolean) => requestFull<LifecycleChecklist>('POST', `/lifecycle/${id}/items/${itemId}`, { body: { done } }),
  updateLifecycle: (id: string, b: Partial<LifecycleChecklist>, version?: number) => requestFull<LifecycleChecklist>('PATCH', `/lifecycle/${id}`, { body: b, ifMatch: version }),
  // assets
  assets: () => http.get<AssetsView>('/assets'),
  assetHistory: (id: string) => http.get<{ at: string; summary: string; actor: string }[]>(`/assets/${id}/history`),
  addAsset: (b: AssetInput) => requestFull<Asset>('POST', '/assets', { body: b }),
  updateAsset: (id: string, b: Partial<AssetInput> & { status?: Asset['status'] }, version?: number) => requestFull<Asset>('PATCH', `/assets/${id}`, { body: b, ifMatch: version }),
  assignAsset: (id: string, userId: string) => requestFull<Asset>('POST', `/assets/${id}/assign`, { body: { user_id: userId } }),
  returnAsset: (id: string, b: { status: 'in_stock' | 'repair'; note: string }) => requestFull<Asset>('POST', `/assets/${id}/return`, { body: b }),
  // dashboard
  dashboard: () => http.get<HrDashboard>('/hr/dashboard'),
}

export const LEAVE_INVALIDATE = [['leave-requests'], ['leave'], ['timesheet'], ['hr-dashboard'], ['inbox'], ['approvals']]

export function useHrDashboard(enabled = true) {
  return useApi(['hr-dashboard'], hrApi.dashboard, { enabled })
}
