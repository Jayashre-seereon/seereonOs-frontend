// v7 — standalone project cost calculator (estimates) client.
import { http, requestFull } from './http'
import { useApi } from './query'
import type { CostEstimate } from '@/types/v7'
import type { Project } from '@/types/entities'
import type { ProjectInput } from './projects'
import type { EstimateCalcInput, EstimateCompareItem, EstimateDetail, EstimateInput, EstimateList, EstimateOptions, EstimatePreview, EstimateStatus } from '@/mock/routes/estimates'

export type { EstimateCalcInput, EstimateCompareItem, EstimateDetail, EstimateInput, EstimateList, EstimateListItem, EstimateMilestoneCash, EstimateOptions, EstimatePreview, EstimateResourceInput, EstimateRowView, EstimateStatus } from '@/mock/routes/estimates'

export const estimatesApi = {
  list: (f: { q?: string; status?: string; owner_id?: string } = {}) => http.get<EstimateList>('/estimates', f as Record<string, unknown>),
  options: () => http.get<EstimateOptions>('/estimates/options'),
  get: (id: string) => http.get<EstimateDetail>(`/estimates/${id}`),
  preview: (b: EstimateCalcInput) => http.post<EstimatePreview>('/estimates/preview', b),
  compare: (ids: string[]) => http.get<EstimateCompareItem[]>('/estimates/compare', { ids: ids.join(',') }),
  create: (b: EstimateInput) => requestFull<CostEstimate>('POST', '/estimates', { body: b }),
  save: (id: string, b: EstimateInput, version: number) => requestFull<CostEstimate>('PUT', `/estimates/${id}`, { body: b, ifMatch: version }),
  duplicate: (id: string, asScenario: boolean) => requestFull<CostEstimate>('POST', `/estimates/${id}/duplicate`, { body: { as_scenario: asScenario } }),
  setStatus: (id: string, status: Exclude<EstimateStatus, 'converted'>, version: number, reason?: string) => requestFull<CostEstimate>('POST', `/estimates/${id}/status`, { body: { status, reason }, ifMatch: version }),
  convert: (id: string, projectId: string) => requestFull<CostEstimate>('POST', `/estimates/${id}/convert`, { body: { project_id: projectId } }),
  remove: (id: string, version: number) => requestFull<{ ok: true }>('DELETE', `/estimates/${id}`, { ifMatch: version }),
  /** POST /projects with the estimate's deal linked (the create-project contract plus deal_id). */
  createProject: (b: ProjectInput & { deal_id: string | null }) => requestFull<Project>('POST', '/projects', { body: b }),
}

/** Everything an estimate change can touch. */
export const ESTIMATES_INVALIDATE = [['estimates'], ['estimate']]

export function useEstimates(f: { q?: string; status?: string; owner_id?: string }) {
  return useApi(['estimates', f], () => estimatesApi.list(f))
}
export function useEstimate(id: string | undefined) {
  return useApi(['estimate', id], () => estimatesApi.get(id!), { enabled: !!id && id !== 'new' })
}
export function useEstimateOptions() {
  return useApi(['estimates', 'options'], estimatesApi.options, { staleTime: 60_000 })
}
