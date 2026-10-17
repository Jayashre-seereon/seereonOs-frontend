// Approval workflow configuration client (Setup → Approval workflows).
import { http } from './http'
import { useApi } from './query'
import { guarded } from './changes'
import type { WorkflowProcess, WorkflowStep } from '@/types/access'
import type { SimulationResult, WorkflowView, WorkflowsResult } from '@/mock/workflows'

export type { SimulatedStep, SimulationResult, WorkflowView, WorkflowsResult } from '@/mock/workflows'

export interface WorkflowInput {
  steps: WorkflowStep[]
  name?: string
  description?: string
  require_reason_on_reject?: boolean
  notify_requester?: boolean
  acknowledge_fallback?: boolean
}

export const workflowsApi = {
  list: () => http.get<WorkflowsResult>('/workflows'),
  save: (process: WorkflowProcess, b: WorkflowInput, version?: number) => guarded<WorkflowView>('PUT', `/workflows/${process}`, b, version),
  reset: (process: WorkflowProcess, version?: number) => guarded<WorkflowView>('POST', `/workflows/${process}/reset`, {}, version),
  simulate: (process: WorkflowProcess, b: { requester_id: string; amount_paise?: number | null; project_id?: string | null; steps?: WorkflowStep[] }) => http.post<SimulationResult>(`/workflows/${process}/simulate`, b),
}

export const useWorkflows = () => useApi(['workflows'], workflowsApi.list)
