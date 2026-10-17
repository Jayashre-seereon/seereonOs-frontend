// Shared task contract used by Projects (module B) and the task drawer / My tasks (module C).
// Handlers: B implements PATCH/DELETE/status/dependencies in mock/routes/projects.ts;
//           C implements GET detail, comments and my-tasks in mock/routes/tasks.ts.
import { http } from './http'
import type { Comment, Complexity, Task, TaskStatus } from '@/types/entities'
import type { DelayReasonCode, TaskReview } from '@/types/business'
import type { TaskStats } from '@/mock/performance'

export interface TaskRef {
  id: string
  wbs: string // e.g. "2.3" (milestone no . task no); "0.4" when no milestone
  title: string
  status: TaskStatus
  owner_id: string | null
  due_on: string
  project_id: string
}
export interface TaskDetail {
  task: Task
  wbs: string
  project: { id: string; name: string; code: string; status: string; pm_id: string | null }
  milestone: { id: string; no: number; name: string } | null
  dependencies: TaskRef[] // tasks this one waits for
  dependents: TaskRef[] // tasks waiting for this one
  blockers: TaskRef[] // open dependencies (drives the blocking callout)
  actual_hours: number
  approved_hours: number
  can_edit: boolean // PM of the project or admin
  can_change_status: boolean // editors + the owner/backup
  can_comment: boolean
}
export interface MyTask extends TaskRef {
  project_name: string
  project_code: string
  milestone_label: string | null
  est_hours: number
  actual_hours: number
  complexity: Complexity
  is_backup: boolean // I'm covering for the owner (owner on leave today)
  blocked_by: TaskRef[]
  // v3 review state
  reviewer_id?: string | null
  review_round?: number
  submitted_on?: string | null
  sent_back?: { reason: string; by: string | null; at: string | null; round: number } | null
  general?: boolean
}
export interface MyTasksResponse {
  tasks: MyTask[]
  covering: MyTask[]
  hours_this_week?: number
  backing?: number
}
export interface TaskPatch {
  title?: string
  owner_id?: string | null
  backup_id?: string | null
  est_hours?: number
  start_on?: string
  due_on?: string
  complexity?: Complexity
  description?: string
  milestone_id?: string | null
  /** required (≥10 chars) when a manager moves the due date */
  due_change_reason?: string
  priority?: 'low' | 'normal' | 'high' | 'urgent'
  reviewer_id?: string | null
}

export const tasksApi = {
  detail: (id: string) => http.get<TaskDetail>(`/tasks/${id}`),
  mine: () => http.get<MyTasksResponse>('/my-tasks'),
  update: (id: string, patch: TaskPatch, version?: number) => http.full<Task>('PATCH', `/tasks/${id}`, { body: patch, ifMatch: version }),
  setStatus: (id: string, status: TaskStatus, blocked_reason?: string | null, quality_rating?: number) => http.full<Task>('POST', `/tasks/${id}/status`, { body: { status, blocked_reason, quality_rating } }),
  setDependencies: (id: string, depends_on: string[]) => http.put<TaskDetail>(`/tasks/${id}/dependencies`, { depends_on }),
  remove: (id: string, version?: number) => http.del(`/tasks/${id}`, version),
  comments: (id: string) => http.get<Comment[]>(`/tasks/${id}/comments`),
  addComment: (id: string, body: string, mentions: string[], parent_id?: string | null) => http.post<Comment>(`/tasks/${id}/comments`, { body, mentions, parent_id }),
}

/* ------------------------------------------------------------------ */
/* v3 task governance: review flow, team assignment, delivery analytics */
/* ------------------------------------------------------------------ */
export type Timeliness = 'early' | 'on_time' | 'late'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export interface TaskReviewInfo {
  reviewer_id: string | null
  can_submit: boolean // owner / backup and the task is open
  can_review: boolean // reviewer or admin, task in review, not a self-review
  self_review: boolean // I own it and I'd be my own reviewer (not allowed)
  late_now: boolean // submitting today would be after the due date
  late_by_days: number // working days past due (today)
  reviews: TaskReview[]
  reschedules: { at: string; actor_id: string; summary: string }[]
  assigned_by: string | null
}
export interface TaskDetailV3 extends TaskDetail {
  review: TaskReviewInfo
  milestones?: { id: string; no: number; name: string }[]
  project_tasks?: TaskRef[]
  owner_on_leave?: boolean
}
export interface SubmitBody {
  note: string
  proof_url?: string | null
  delay_reason_code?: DelayReasonCode | null
  delay_reason?: string | null
}
export interface TeamTaskRow {
  id: string
  wbs: string
  title: string
  status: TaskStatus
  owner_id: string | null
  reviewer_id: string | null
  assigned_by: string | null
  project_id: string
  project_code: string
  project_name: string
  general: boolean
  priority: Priority
  start_on: string
  due_on: string
  done_on: string | null
  submitted_on: string | null
  est_hours: number
  review_round: number
  timeliness: Timeliness | null
  variance_days: number | null
  overdue_days: number // working days past due for open tasks
  delay_reason_code: string | null
  delay_reason: string | null
  quality_rating: number | null
  sent_back_count: number
  last_sent_back_reason: string | null
  reschedule_count: number
}
export interface ReviewQueueRow extends TeamTaskRow {
  latest: TaskReview
  late_at_submission: number // working days past due when submitted (0 = on time / early)
  can_review: boolean
}
export interface AssignOptions {
  general_project_id: string
  projects: { id: string; code: string; name: string; general: boolean; anyone: boolean; milestones: { id: string; no: number; name: string }[] }[]
  team_ids: string[]
  is_admin: boolean
}
export interface AssignBody {
  owner_id: string
  title: string
  description?: string
  due_on: string
  start_on?: string
  est_hours: number
  priority: Priority
  project_id?: string | null
  milestone_id?: string | null
  reviewer_id?: string | null
}
export type TaskStatsDTO = TaskStats
export interface TaskAnalyticsRow {
  key: string
  label: string
  user_id?: string
  project_id?: string
  stats: TaskStats
  top_reasons: { code: string; label: string; count: number }[]
}
export interface TaskAnalytics {
  scope: 'me' | 'team' | 'company'
  from: string
  to: string
  total: TaskStats
  rows: TaskAnalyticsRow[]
  top_late: { user_id: string; late: number; completed: number; avg_variance_days: number | null }[]
  delay_reasons: { code: string; label: string; count: number }[]
  mine: { review_queue: number; my_in_review: number; my_sent_back_open: number; my_overdue_open: number; my_to_submit: number }
}

export const taskflowApi = {
  submit: (id: string, b: SubmitBody) => http.full<Task>('POST', `/tasks/${id}/submit`, { body: b }),
  approve: (id: string, quality_rating: number, note?: string) => http.full<Task>('POST', `/tasks/${id}/approve`, { body: { quality_rating, note } }),
  sendBack: (id: string, reason: string, new_due_on?: string | null) => http.full<Task>('POST', `/tasks/${id}/send-back`, { body: { reason, new_due_on: new_due_on || undefined } }),
  reviews: (id: string) => http.get<TaskReview[]>(`/tasks/${id}/reviews`),
  reviewQueue: (all = false) => http.get<ReviewQueueRow[]>('/team-tasks/review-queue', all ? { all: 1 } : undefined),
  teamTasks: () => http.get<TeamTaskRow[]>('/team-tasks'),
  options: () => http.get<AssignOptions>('/team-tasks/options'),
  assign: (b: AssignBody) => http.full<Task>('POST', '/team-tasks', { body: b }),
  analytics: (q: { from?: string; to?: string; scope?: 'me' | 'team' | 'company'; group?: 'person' | 'project' | 'manager' }) => http.get<TaskAnalytics>('/analytics/tasks', q),
}
