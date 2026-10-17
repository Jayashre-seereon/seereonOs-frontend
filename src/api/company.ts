// Company layer client: approvals inbox, goals & OKRs, audit trail.
// The inbox's inline decisions call the owning areas' contract endpoints (see CONVENTIONS "v3 shared contracts").
import { http } from './http'
import type { AuditResult, InboxItem, InboxView, KRMetric, MyRequest, OkrView } from '@/mock/routes/company'
import type { KeyResult, Objective } from '@/types/business'

export type { AuditResult, AuditRow, AuditSource, CheckIn, FactType, InboxAction, InboxFact, InboxGroup, InboxItem, InboxKind, InboxView, KRMetric, KRView, MyRequest, ObjectiveView, OkrPeriod, OkrStatus, OkrView, PersonLite, RequestState } from '@/mock/routes/company'

export interface AuditQuery {
  q?: string
  actor?: string
  entity?: string
  from?: string
  to?: string
  page?: number
  all?: 1
}
export interface ObjectiveInput {
  title: string
  level: Objective['level']
  owner_id: string
  period: string
  parent_id: string | null
}
export interface KRInput {
  title: string
  metric: KRMetric
  start_value: number
  target: number
  unit: string
  owner_id: string
}

/** Contract endpoint for a decision on an inbox item (owned by the item's area). */
export function decisionPath(item: InboxItem, action: 'approve' | 'reject' | 'pay' | 'send_back'): string {
  const id = encodeURIComponent(item.entity_id)
  switch (item.kind) {
    case 'timesheet':
      return `/approvals/${id}/${action === 'reject' ? 'reject' : 'approve'}`
    case 'task_review':
      return `/tasks/${id}/${action === 'send_back' ? 'send-back' : 'approve'}`
    case 'leave':
      return `/leave-requests/${id}/${action}`
    case 'expense':
      return `/expenses/${id}/${action}`
    case 'purchase_order':
      return `/purchase-orders/${id}/${action}`
    case 'vendor_bill':
      return `/vendor-bills/${id}/${action}`
    case 'change':
      return `/changes/${id}/${action === 'reject' ? 'reject' : 'approve'}`
    default:
      return ''
  }
}

export const companyApi = {
  inbox: () => http.get<InboxView>('/inbox'),
  inboxSummary: () => http.get<{ pending: number; overdue: number }>('/inbox/summary'),
  myRequests: () => http.get<MyRequest[]>('/inbox/mine'),
  decide: (item: InboxItem, action: 'approve' | 'reject' | 'pay' | 'send_back', body: Record<string, unknown> = {}) => http.full('POST', decisionPath(item, action), { body, ifMatch: item.kind === 'timesheet' ? item.version : undefined }),

  okrs: (period?: string, owner?: string) => http.get<OkrView>('/okrs', { period, owner }),
  createObjective: (b: ObjectiveInput) => http.full<Objective>('POST', '/okrs/objectives', { body: b }),
  updateObjective: (id: string, b: Partial<ObjectiveInput> & { status?: 'done' | 'on_track' }, version?: number) => http.full<Objective>('PATCH', `/okrs/objectives/${id}`, { body: b, ifMatch: version }),
  deleteObjective: (id: string) => http.del<{ ok: true }>(`/okrs/objectives/${id}`),
  addKR: (objectiveId: string, b: KRInput) => http.full<KeyResult>('POST', `/okrs/objectives/${objectiveId}/key-results`, { body: b }),
  updateKR: (id: string, b: Partial<KRInput>, version?: number) => http.full<KeyResult>('PATCH', `/okrs/key-results/${id}`, { body: b, ifMatch: version }),
  deleteKR: (id: string) => http.del<{ ok: true }>(`/okrs/key-results/${id}`),
  checkIn: (id: string, value: number, note: string, version?: number) => http.full<KeyResult>('POST', `/okrs/key-results/${id}/check-in`, { body: { value, note }, ifMatch: version }),

  audit: (q: AuditQuery) => http.get<AuditResult>('/audit', q as Record<string, unknown>),
}

export const METRIC_META: Record<KRMetric, { label: string; unit: string; kind: 'money' | 'percent' | 'number'; rate: boolean; finance: boolean; lowerIsBetter?: boolean }> = {
  manual: { label: 'Manual check-ins', unit: '', kind: 'number', rate: false, finance: false },
  revenue_billed: { label: 'Revenue billed', unit: '₹', kind: 'money', rate: false, finance: true },
  revenue_collected: { label: 'Revenue collected', unit: '₹', kind: 'money', rate: false, finance: true },
  deals_won_value: { label: 'Value of deals won', unit: '₹', kind: 'money', rate: false, finance: true },
  on_time_task_pct: { label: 'Tasks finished on time', unit: '%', kind: 'percent', rate: true, finance: false },
  timesheet_compliance: { label: 'Timesheet compliance', unit: '%', kind: 'percent', rate: true, finance: false },
  margin_pct: { label: 'Net margin', unit: '%', kind: 'percent', rate: true, finance: true },
  headcount: { label: 'Active headcount', unit: 'people', kind: 'number', rate: false, finance: false },
  leakage: { label: 'Revenue leakage', unit: '₹', kind: 'money', rate: false, finance: true, lowerIsBetter: true },
}

export const ENTITY_LABEL: Record<string, string> = {
  project: 'Project', task: 'Task', deal: 'Deal', timesheet_week: 'Timesheet', user: 'Person', invoice: 'Invoice', milestone: 'Milestone', payroll_run: 'Payroll', ledger: 'Ledger', ledger_entry: 'Ledger',
  key_result: 'Key result', objective: 'Objective', document: 'Document', leave_request: 'Leave', expense: 'Expense', expense_claim: 'Expense', purchase_order: 'Purchase order', vendor_bill: 'Vendor bill',
  appraisal: 'Appraisal', settings: 'Settings', tenant: 'Workspace', change_request: 'Change request', ops_item: 'Operations', workspace: 'Workspace', report: 'Report', client: 'Client', contract: 'Contract', vendor: 'Vendor', budget: 'Budget', candidate: 'Candidate', asset: 'Asset',
}
