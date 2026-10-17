// One label + tone map for every status in the product (CMP-05 StatusBadge).
import type {
  ActivityType, BillingModel, CRStatus, Complexity, DealSource, DealStage, LeaveType, ProjectStatus, ProjectType,
  RevenueStream, TaskStatus, WeekStatus,
} from '@/types/entities'

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand' | 'accent'

export const PROJECT_STATUS: Record<ProjectStatus, { label: string; tone: Tone; needsReason?: boolean }> = {
  initiated: { label: 'Initiated', tone: 'neutral' },
  active: { label: 'Active', tone: 'info' },
  on_hold: { label: 'On hold', tone: 'warning', needsReason: true },
  npa: { label: 'NPA', tone: 'danger', needsReason: true },
  completed: { label: 'Completed', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral', needsReason: true },
}
export const PROJECT_TYPE: Record<ProjectType, string> = { product: 'Product', service: 'Service', saas: 'SaaS', ams: 'AMS' }
export const BILLING_MODEL: Record<BillingModel, string> = { fixed: 'Fixed price', tm: 'Time & material', subscription: 'Subscription', ams_retainer: 'AMS retainer' }
export const STREAM: Record<RevenueStream, string> = { sap_consulting: 'SAP consulting', products: 'Products', services: 'Services', saas: 'Subscriptions', ams: 'AMS' }

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone }> = {
  todo: { label: 'To do', tone: 'neutral' },
  in_progress: { label: 'In progress', tone: 'info' },
  blocked: { label: 'Blocked', tone: 'danger' },
  in_review: { label: 'In review', tone: 'accent' },
  done: { label: 'Done', tone: 'success' },
}
export const COMPLEXITY: Record<Complexity, { label: string; tone: Tone }> = {
  low: { label: 'Low', tone: 'neutral' },
  medium: { label: 'Medium', tone: 'warning' },
  high: { label: 'High', tone: 'danger' },
  very_high: { label: 'Very high', tone: 'danger' },
}

export const WEEK_STATUS: Record<WeekStatus, { label: string; tone: Tone }> = {
  open: { label: 'Draft', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  locked: { label: 'Locked', tone: 'danger' },
}

export const LEAVE_TYPE: Record<LeaveType, string> = { casual: 'Casual', sick: 'Sick', earned: 'Earned', compensatory: 'Comp-off', lwp: 'Leave without pay', optional_holiday: 'Optional holiday' }

export const DEAL_STAGE: Record<DealStage, { label: string; tone: Tone; chance: number; order: number }> = {
  lead: { label: 'Lead', tone: 'neutral', chance: 0.1, order: 0 },
  qualified: { label: 'Qualified', tone: 'info', chance: 0.2, order: 1 },
  demo: { label: 'Demo', tone: 'info', chance: 0.35, order: 2 },
  proposal: { label: 'Proposal', tone: 'accent', chance: 0.5, order: 3 },
  negotiation: { label: 'Negotiation', tone: 'warning', chance: 0.7, order: 4 },
  won: { label: 'Won', tone: 'success', chance: 1, order: 5 },
  lost: { label: 'Lost', tone: 'danger', chance: 0, order: 6 },
}
export const DEAL_STAGES_OPEN: DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation']
export const DEAL_SOURCE: Record<DealSource, string> = {
  referral: 'Referral', bni: 'BNI', website: 'Website', cold_call: 'Cold call', event: 'Event', partner: 'Partner', existing_client: 'Existing client', other: 'Other',
}
export const ACTIVITY_TYPE: Record<ActivityType, string> = { call: 'Call', meeting: 'Meeting', demo: 'Demo', email: 'Email', proposal: 'Proposal', follow_up: 'Follow-up', whatsapp: 'WhatsApp' }

export const CR_STATUS: Record<CRStatus, { label: string; tone: Tone }> = {
  raised: { label: 'Raised', tone: 'neutral' },
  estimated: { label: 'Estimated', tone: 'info' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  done: { label: 'Done', tone: 'brand' },
}

export const HEALTH: Record<'on_track' | 'at_risk' | 'off_track', { label: string; tone: Tone }> = {
  on_track: { label: 'On track', tone: 'success' },
  at_risk: { label: 'At risk', tone: 'warning' },
  off_track: { label: 'Off track', tone: 'danger' },
}

export const INTERNAL_CODES: Record<string, string> = {
  meeting: 'Internal meeting', learning: 'Learning', presales: 'Pre-sales', admin: 'Admin', interview: 'Interviewing', bench: 'Bench', breaks: 'Lunch, tea and stand-up',
}

/* ---------------- v5 task stages and tags (Feature Guide §7) ---------------- */
import { TASK_STAGES as V5_STAGES, TASK_TAG as V5_TAGS } from './delivery'
import type { TaskStage, TaskTag } from '@/types/entities'
/** StatusBadge map for the 10 delivery stages. */
export const TASK_STAGE: Record<TaskStage, { label: string; tone: Tone }> = Object.fromEntries(V5_STAGES.map((s) => [s.key, { label: s.label, tone: s.tone }])) as Record<TaskStage, { label: string; tone: Tone }>
export const TASK_STAGE_ORDER: TaskStage[] = V5_STAGES.map((s) => s.key)
export const TASK_TAG_LABEL: Record<TaskTag, { label: string; tone: Tone }> = V5_TAGS
export const COMPLEXITY_ORDER: Complexity[] = ['low', 'medium', 'high', 'very_high']
