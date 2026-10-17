// v7 workflow management client (designer, running workflows, appraisal link).
import { http, requestFull } from './http'
import { useApi } from './query'
import type { WfTemplate } from '@/types/v7'
import type { WfAppraisalBrief, WfDetail, WfFacts, WfIssue, WfListView, WfMeta, WfRow, WfTemplateRow } from '@/mock/routes/workflowsV7'

export type { WfAppraisalBrief, WfDetail, WfFacts, WfFieldView, WfInboxRow, WfIssue, WfListView, WfMeta, WfOutputView, WfPerson, WfRow, WfStageView, WfStatus, WfTemplateRow } from '@/mock/routes/workflowsV7'

export type WfTab = 'waiting' | 'started' | 'about' | 'all'
export type TemplateBody = Pick<WfTemplate, 'name' | 'process' | 'description' | 'active' | 'stages' | 'on_complete' | 'on_reject'> & { self_service?: boolean }

export const wfApi = {
  templates: () => http.get<WfTemplateRow[]>('/wf/templates'),
  template: (id: string) => http.get<WfTemplate & { running: number }>(`/wf/templates/${id}`),
  meta: () => http.get<WfMeta>('/wf/meta'),
  check: (template: TemplateBody, id?: string) => http.post<{ issues: WfIssue[] }>('/wf/templates/check', { template, id }),
  create: (b: { name: string; process: string; description?: string; copy_of?: string | null }) => requestFull<WfTemplate>('POST', '/wf/templates', { body: b }),
  save: (id: string, b: TemplateBody, version?: number) => requestFull<WfTemplate>('PUT', `/wf/templates/${id}`, { body: b, ifMatch: version }),
  duplicate: (id: string) => requestFull<WfTemplate>('POST', `/wf/templates/${id}/duplicate`, {}),

  list: (tab: WfTab, f: { status?: string; template_id?: string } = {}) => http.get<WfListView>('/wf/instances', { tab, ...f }),
  get: (id: string) => http.get<WfDetail>(`/wf/instances/${id}`),
  forAppraisal: (appraisalId: string) => http.get<WfAppraisalBrief | null>(`/wf/appraisal/${appraisalId}`),
  start: (b: { template_id: string; subject_ids: string[]; note?: string; cycle_id?: string | null; title?: string }) => requestFull<{ created: WfRow[] }>('POST', '/wf/instances', { body: b }),
  preview: (id: string, values: Record<string, unknown>) => http.post<{ facts: WfFacts | null }>(`/wf/instances/${id}/preview`, { values }),
  act: (id: string, b: { action: 'submit' | 'send_back' | 'reject'; values?: Record<string, unknown>; reason?: string; note?: string }, version?: number) => requestFull<WfDetail>('POST', `/wf/instances/${id}/act`, { body: b, ifMatch: version }),
  reassign: (id: string, b: { user_id: string; note: string }) => requestFull<WfDetail>('POST', `/wf/instances/${id}/reassign`, { body: b }),
  cancel: (id: string, reason: string) => requestFull<WfDetail>('POST', `/wf/instances/${id}/cancel`, { body: { reason } }),
  comment: (id: string, body: string) => requestFull<WfDetail>('POST', `/wf/instances/${id}/comments`, { body: { body } }),
  /** Appraisal cycle launch with an optional workflow (owned by HR routes; the workflow variant lives here). */
  launchCycle: (cycleId: string, workflowTemplateId: string | null) => requestFull<{ created: number; workflows: number }>('POST', `/appraisal-cycles/${cycleId}/launch`, { body: { workflow_template_id: workflowTemplateId } }),
}

export const WF_INV = [['wf'], ['appraisal'], ['appraisals'], ['changes'], ['documents'], ['notifications'], ['inbox']]

export const useWfTemplates = () => useApi(['wf', 'templates'], wfApi.templates)
export const useWfMeta = () => useApi(['wf', 'meta'], wfApi.meta)
export const useWfList = (tab: WfTab, f: { status?: string; template_id?: string } = {}) => useApi(['wf', 'list', tab, f.status ?? '', f.template_id ?? ''], () => wfApi.list(tab, f))
export const useWfInstance = (id: string) => useApi(['wf', 'instance', id], () => wfApi.get(id))
export const useWfForAppraisal = (appraisalId: string) => useApi(['wf', 'appraisal', appraisalId], () => wfApi.forAppraisal(appraisalId))
