// Module D — Sales CRM client (UI-27..30).
import { http, type Page } from './http'
import { useApi } from './query'
import type { ActivityType, DealActivity, DealSource, DealStage, ProjectType, RevenueStream, BillingModel } from '@/types/entities'
import type { ActivityLog, CompensationResult, DealDetail, DealView, SalesPerformance, SalesSummary } from '@/mock/routes/sales'
import type { CostRate } from '@/types/entities'
import type { PeriodKind } from '@/domain/calendar'
import { guarded } from './changes'

export type { ActivityLog, ActivityLogItem, CompensationResult, CompPerson, CompMonth, DealDetail, DealView, FunnelStage, PersonPerformance, SalesPerformance, SalesSummary, SixMonthRow, TimelineItem } from '@/mock/routes/sales'
export { dealValue } from '@/domain/sales'

export const PRODUCTS = ['EduReon', 'SeerHR', 'LeadSync', 'Munim AI', 'MineReon', 'SAP consulting', 'Custom software'] as const

export interface DealFilters {
  owner_id?: string
  stage?: DealStage | ''
  source?: DealSource | ''
  product?: string
  q?: string
}
export interface DealInput {
  title: string
  client: string
  contact: string
  phone: string
  email: string
  product: string
  source: DealSource
  owner_id: string
  stage?: DealStage
  value_paise: number
  mrr_paise: number
  expected_close: string
  notes: string
  first_conversation?: string | null
  next_step?: string | null
  next_step_on?: string | null
}
export interface CreateProjectInput {
  name: string
  client: string
  contract_value_paise: number
  type: ProjectType
  stream?: RevenueStream
  billing_model?: BillingModel
  start_on: string
  end_on: string
  pm_id?: string | null
}

export const salesApi = {
  deals: (f: DealFilters = {}) => http.get<Page<DealView>>('/sales/deals', f as Record<string, unknown>),
  summary: (owner_id?: string, week?: string) => http.get<SalesSummary>('/sales/summary', { owner_id, week }),
  activity: (f: { days?: number; user_id?: string; from?: string; to?: string } = {}) => http.get<ActivityLog>('/sales/activity', f as Record<string, unknown>),
  deal: (id: string) => http.get<DealDetail>(`/sales/deals/${id}`),
  create: (b: DealInput) => http.full<DealView>('POST', '/sales/deals', { body: b }),
  update: (id: string, b: Partial<DealInput>, version?: number) => http.full<DealView>('PATCH', `/sales/deals/${id}`, { body: b, ifMatch: version }),
  move: (id: string, stage: DealStage, reason?: string) => http.full<DealView>('POST', `/sales/deals/${id}/stage`, { body: { stage, reason } }),
  logActivity: (id: string, b: { type: ActivityType; note: string; date?: string; next_step?: string; next_step_on?: string | null }) => http.full<DealActivity>('POST', `/sales/deals/${id}/activities`, { body: b }),
  createProject: (id: string, b: CreateProjectInput) => http.full<{ id: string; code: string; name: string }>('POST', `/sales/deals/${id}/create-project`, { body: b }),
  remove: (id: string, version?: number) => http.del<{ ok: true }>(`/sales/deals/${id}`, version),
  performance: (from: string, to: string) => http.get<SalesPerformance>('/sales/performance', { from, to }),
  compensation: (kind: PeriodKind, anchor: string) => http.get<CompensationResult>('/sales/compensation', { kind, anchor }),
  /** Variable % / monthly target change = a new cost-rate row (maker-checked entity cost_rate). */
  saveComp: (b: { user_id: string; monthly_ctc_paise: number; variable_pct: number; sales_target_paise: number | null; effective_from: string }) => guarded<CostRate>('POST', '/cost-rates', b),
}

export const SALES_KEYS = { deals: ['deals'], summary: ['deals', 'summary'], deal: ['deal'], perf: ['sales', 'performance'], comp: ['sales', 'compensation'], log: ['deals', 'activity-log'] }
/** Everything that changes when a deal changes (stage moves feed performance, pay, pipeline-based revenue ahead). */
export const SALES_INVALIDATE = [['deals'], ['deal'], ['sales'], ['pnl'], ['notifications'], ['projects'], ['project'], ['dash'], ['insights']]

export function useDeals(f: DealFilters) {
  return useApi([...SALES_KEYS.deals, f], () => salesApi.deals(f))
}
export function useSalesSummary(owner_id?: string, week?: string) {
  return useApi([...SALES_KEYS.summary, owner_id ?? 'all', week ?? ''], () => salesApi.summary(owner_id, week))
}
export function useSalesActivity(f: { days?: number; user_id?: string }) {
  return useApi([...SALES_KEYS.log, f], () => salesApi.activity(f))
}
export function useDeal(id: string | undefined) {
  return useApi([...SALES_KEYS.deal, id], () => salesApi.deal(id!), { enabled: !!id })
}
export function useSalesPerformance(from: string, to: string) {
  return useApi([...SALES_KEYS.perf, from, to], () => salesApi.performance(from, to))
}
export function useCompensation(kind: PeriodKind, anchor: string) {
  return useApi([...SALES_KEYS.comp, kind, anchor], () => salesApi.compensation(kind, anchor))
}
/** Saving pay settings touches cost rates, payroll and the compensation screens. */
export const COMP_INVALIDATE = [['sales'], ['cost-rates'], ['payroll'], ['changes'], ['dash']]
