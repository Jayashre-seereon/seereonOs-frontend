// Module E — report engine, saved reports and the AI endpoints.
import { http } from './http'
import { useApi } from './query'
import type { PeriodPreset, ReportSpec } from '@/types/reports'
import type { DatasetDefX } from '@/reports/datasets'
import type { ReportResultX } from '@/reports/engine'
import type { SavedReportView } from '@/mock/routes/reports'
import type { PlannerEntities } from '@/reports/planner'
import type { SavedReport } from '@/types/entities'

export type { SavedReportView } from '@/mock/routes/reports'
export type { ReportResultX } from '@/reports/engine'
export type { DatasetDefX, FieldDefX } from '@/reports/datasets'

export interface AiContext {
  enabled: boolean
  today: string
  fy_start_month: number
  datasets: DatasetDefX[]
  entities: PlannerEntities
  suggestions: string[]
  me: string
  tenant: string
  currency: 'INR'
  money_unit: 'paise'
}
export interface AiPlan {
  spec: ReportSpec
  explanation: string
  confidence: number
  intent: string
  source: 'rules' | 'llm'
}
export interface AiAnswer {
  spec: ReportSpec
  explanation: string
  confidence: number
  source: 'rules' | 'llm'
  result: ReportResultX
  narrative: string
  described: { dataset: string; measures: string[]; dimensions: string[]; filters: string[]; period: string; sort: string | null }
}
export interface SaveReportInput {
  name: string
  description?: string
  spec: ReportSpec
  shared?: boolean
  pinned?: boolean
  schedule?: SavedReport['schedule']
  source?: 'builder' | 'ai'
}

export const reportsApi = {
  datasets: () => http.get<DatasetDefX[]>('/reports/datasets'),
  run: (spec: ReportSpec) => http.post<ReportResultX>('/reports/run', { spec }),
  list: (q?: string, preview = true) => http.get<SavedReportView[]>('/reports', { q, preview: preview ? '1' : '0' }),
  get: (id: string) => http.get<SavedReportView>(`/reports/${id}`),
  create: (b: SaveReportInput) => http.full<SavedReportView>('POST', '/reports', { body: b }),
  update: (id: string, b: Partial<SaveReportInput>, version?: number) => http.full<SavedReportView>('PATCH', `/reports/${id}`, { body: b, ifMatch: version }),
  remove: (id: string, version?: number) => http.del<{ ok: true }>(`/reports/${id}`, version),
  pin: (id: string, pinned?: boolean) => http.post<SavedReportView>(`/reports/${id}/pin`, { pinned }),
  share: (id: string, shared?: boolean) => http.post<SavedReportView>(`/reports/${id}/share`, { shared }),
  duplicate: (id: string) => http.post<SavedReportView>(`/reports/${id}/duplicate`),
  runSaved: (id: string, over?: { period?: { preset?: PeriodPreset; from?: string; to?: string }; compare?: 'previous_period' | 'none' }) => http.post<ReportResultX>(`/reports/${id}/run`, over ?? {}),
  aiContext: () => http.get<AiContext>('/ai/context'),
  aiPlan: (question: string) => http.post<AiPlan>('/ai/plan', { question }),
  aiAnswer: (b: { question?: string; spec?: ReportSpec; explanation?: string; source?: 'rules' | 'llm' }) => http.post<AiAnswer>('/ai/answer', b),
  toolProjectHealth: () => http.get<unknown>('/ai/tools/project_health'),
  toolPipeline: () => http.get<unknown>('/ai/tools/pipeline'),
  toolApprovals: () => http.get<unknown>('/ai/tools/approvals'),
  toolEntities: (kind: string) => http.get<unknown>('/ai/tools/entities', { kind }),
}

export const useDatasets = () => useApi(['reports', 'datasets'], reportsApi.datasets, { staleTime: 5 * 60_000 })
export const useSavedReports = (q?: string) => useApi(['reports', 'list', q ?? ''], () => reportsApi.list(q), { placeholderData: (p) => p })
export const useSavedReport = (id: string | undefined) => useApi(['reports', 'one', id], () => reportsApi.get(id!), { enabled: !!id })
export const useAiContext = (enabled = true) => useApi(['ai', 'context'], reportsApi.aiContext, { staleTime: 5 * 60_000, enabled, retry: false })
