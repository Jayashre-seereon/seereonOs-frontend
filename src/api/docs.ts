// v7 Documents hub client: letter templates, issued documents (letters & payslips), employee documents.
// Server rules live in src/mock/routes/docsV7.ts; policies and project documents keep using ./documents.
import { http } from './http'
import { useApi } from './query'
import type { DocTemplate, EmployeeDocument, IssuedDocument } from '@/types/v7'
import type { FilePayload } from './documents'

export type TemplateCategory = DocTemplate['category']
export type EmpDocKind = EmployeeDocument['kind']

export interface TemplateRow extends DocTemplate {
  issued_count: number
  last_used_on: string | null
  process_placeholders: string[]
}
export interface TemplateInput {
  name: string
  category: TemplateCategory
  body: string
  description?: string
  letterhead: boolean
  active: boolean
  custom_placeholders?: string[]
}
export interface Letterhead {
  legal_name: string
  brand_name: string
  address: string
  cin: string
  gstin: string
  email: string
  phone: string
  website: string
  /** 'seereon' → the official Seereon logo asset; otherwise the tenant's uploaded logo (data URL) or null */
  logo: string | null
}
export interface IssuedRow {
  id: string
  version: number
  title: string
  category: TemplateCategory
  template_id: string | null
  template_name: string | null
  employee_id: string
  employee_name: string
  employee_code: string
  ref_no: string
  period: string | null
  status: IssuedDocument['status']
  issued_on: string | null
  acknowledged_on: string | null
  issued_by: string
  source: IssuedDocument['source']
  revoked_on: string | null
  created_at: string
}
export interface IssuedDetail {
  doc: IssuedDocument & { employee_name: string; employee_code: string; template_name: string | null }
  letterhead: Letterhead | null
  can_manage: boolean
  can_ack: boolean
  replaces: { id: string; ref_no: string } | null
  replaced_by: { id: string; ref_no: string } | null
  process_fields: { key: string; label: string; type?: string }[]
}
export interface IssuePreviewItem {
  employee_id: string
  name: string
  title: string
  body_html: string
  missing: string[]
}
export interface IssueInput {
  employee_ids: string[]
  vars: Record<string, string>
  per_employee?: Record<string, Record<string, string>>
  status: 'draft' | 'issued'
  title?: string
}
export interface IssueResult {
  created: IssuedRow[]
  emailed: number
}
export interface IssuedQuery {
  mine?: boolean
  employee_id?: string
  category?: string
  status?: string
  from?: string
  to?: string
  q?: string
  run_id?: string
}
export interface EmpDocRow extends EmployeeDocument {
  uploaded_by_name: string
  verified_by_name: string | null
  expiry_state: 'ok' | 'expiring' | 'expired' | null
}
export interface EmployeeSummaryRow {
  user_id: string
  name: string
  code: string
  department: string
  designation: string
  avatar_hue: number
  docs: number
  verified: number
  pending: number
  rejected: number
  expiring: number
  missing: EmpDocKind[]
  issued: number
}
export interface EmployeeFile {
  user: { id: string; name: string; code: string; department: string; designation: string; email: string; joined_on: string; manager_name: string; avatar_hue: number; status: string }
  docs: EmpDocRow[]
  issued: IssuedRow[]
  missing: EmpDocKind[]
  can_verify: boolean
  can_upload: boolean
  can_issue: boolean
}
export interface EmpDocInput {
  employee_id?: string
  kind: EmpDocKind
  title: string
  file: FilePayload | null
  expires_on?: string | null
  doc_number?: string | null
  note?: string
}
export interface PayslipStatus {
  run_id: string
  month: string
  run_status: 'draft' | 'final'
  eligible: number
  issued: number
  acknowledged: number
  can_generate: boolean
}
export interface PayslipResult {
  created: number
  skipped_existing: number
  skipped_no_ctc: string[]
  total: number
}

export const docsApi = {
  templates: () => http.get<TemplateRow[]>('/doc-templates'),
  template: (id: string) => http.get<TemplateRow>(`/doc-templates/${id}`),
  createTemplate: (b: TemplateInput) => http.full<TemplateRow>('POST', '/doc-templates', { body: b }),
  saveTemplate: (id: string, b: Partial<TemplateInput>, version?: number) => http.full<TemplateRow>('PATCH', `/doc-templates/${id}`, { body: b, ifMatch: version }),
  duplicateTemplate: (id: string) => http.full<TemplateRow>('POST', `/doc-templates/${id}/duplicate`),
  deleteTemplate: (id: string) => http.del<{ ok: true }>(`/doc-templates/${id}`),
  suggest: (employeeId: string) => http.get<Record<string, string>>(`/doc-templates/suggest/${employeeId}`),
  sampleVars: (employeeId: string) => http.get<Record<string, string>>(`/doc-templates/sample/${employeeId}`),
  previewIssue: (id: string, b: Omit<IssueInput, 'status'>) => http.post<IssuePreviewItem[]>(`/doc-templates/${id}/preview`, b),
  issue: (id: string, b: IssueInput) => http.full<IssueResult>('POST', `/doc-templates/${id}/issue`, { body: b }),

  issued: (q: IssuedQuery) => http.get<IssuedRow[]>('/issued-docs', { ...q, mine: q.mine ? 1 : undefined } as Record<string, unknown>),
  issuedDoc: (id: string) => http.get<IssuedDetail>(`/issued-docs/${id}`),
  saveDraft: (id: string, b: { title?: string; vars?: Record<string, string> }, version?: number) => http.full<IssuedDetail>('PATCH', `/issued-docs/${id}`, { body: b, ifMatch: version }),
  issueDraft: (id: string) => http.full<IssuedDetail>('POST', `/issued-docs/${id}/issue`),
  revoke: (id: string, reason: string) => http.full<IssuedDetail>('POST', `/issued-docs/${id}/revoke`, { body: { reason } }),
  reissue: (id: string) => http.full<IssuedDetail>('POST', `/issued-docs/${id}/reissue`),
  ack: (id: string) => http.full<IssuedDetail>('POST', `/issued-docs/${id}/ack`),
  deleteDraft: (id: string) => http.del<{ ok: true }>(`/issued-docs/${id}`),

  payslipStatus: (runId: string) => http.get<PayslipStatus>(`/payroll/${runId}/payslips`),
  generatePayslips: (runId: string) => http.full<PayslipResult>('POST', `/payroll/${runId}/payslips`),

  people: () => http.get<EmployeeSummaryRow[]>('/employee-docs/people'),
  person: (userId: string) => http.get<EmployeeFile>(`/employee-docs/person/${userId}`),
  uploadEmpDoc: (b: EmpDocInput) => http.full<EmpDocRow>('POST', '/employee-docs', { body: b }),
  verify: (id: string, note?: string) => http.full<EmpDocRow>('POST', `/employee-docs/${id}/verify`, { body: { note } }),
  reject: (id: string, note: string) => http.full<EmpDocRow>('POST', `/employee-docs/${id}/reject`, { body: { note } }),
  deleteEmpDoc: (id: string) => http.del<{ ok: true }>(`/employee-docs/${id}`),
  empDocFile: (id: string) => http.get<{ file_name: string; mime: string; data_url: string | null }>(`/employee-docs/${id}/file`),
}

export const DOCS7_KEYS = [['docs7'], ['documents']]

export const useTemplates = (enabled = true) => useApi(['docs7', 'templates'], docsApi.templates, { enabled })
export const useTemplate = (id: string | null) => useApi(['docs7', 'template', id], () => docsApi.template(id!), { enabled: !!id && id !== 'new' })
export const useIssued = (q: IssuedQuery, enabled = true) => useApi(['docs7', 'issued', q], () => docsApi.issued(q), { enabled })
export const useIssuedDoc = (id: string | null) => useApi(['docs7', 'issued-doc', id], () => docsApi.issuedDoc(id!), { enabled: !!id })
export const useEmpPeople = (enabled = true) => useApi(['docs7', 'people'], docsApi.people, { enabled })
export const useEmpFile = (userId: string | null) => useApi(['docs7', 'person', userId], () => docsApi.person(userId!), { enabled: !!userId })
export const usePayslipStatus = (runId: string | null, enabled = true) => useApi(['docs7', 'payslips', runId], () => docsApi.payslipStatus(runId!), { enabled: !!runId && enabled })

export const ISSUED_STATUS: Record<IssuedDocument['status'], { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Awaiting acknowledgement', tone: 'warning' },
  acknowledged: { label: 'Acknowledged', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'danger' },
}
export const EMP_DOC_STATUS: Record<EmployeeDocument['status'], { label: string; tone: 'warning' | 'success' | 'danger' }> = {
  pending: { label: 'Pending verification', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
}
export const EMP_DOC_KIND: Record<EmpDocKind, string> = {
  pan: 'PAN card',
  aadhaar: 'Aadhaar',
  education: 'Education',
  experience: 'Experience / relieving',
  bank: 'Bank details',
  photo: 'Photograph',
  passport: 'Passport',
  id_proof: 'ID proof',
  address_proof: 'Address proof',
  other: 'Other',
}
export const MANDATORY_KINDS: EmpDocKind[] = ['pan', 'aadhaar', 'education', 'bank']
export const EMP_DOC_ACCEPT = '.pdf,.png,.jpg,.jpeg,.docx'
export const SOURCE_LABEL: Record<IssuedDocument['source']['kind'], string> = { manual: 'Issued by HR', payroll: 'Payroll', workflow: 'Workflow', onboarding: 'Onboarding' }
