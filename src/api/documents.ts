// Documents: project document libraries + the company library (policies, processes, templates).
// Server rules live in src/mock/routes/documents.ts.
import { http } from './http'
import { useApi } from './query'
import type { DocCategory, DocVisibility, DocumentVersion } from '@/types/business'

export type DocScope = 'project' | 'company' | 'mine'
export type MyAck = 'acknowledged' | 'pending' | null

export interface DocListItem {
  id: string
  version: number // row version (If-Match)
  project_id: string | null
  project_name: string | null
  project_code: string | null
  title: string
  description: string
  category: DocCategory
  visibility: DocVisibility
  must_read: boolean
  tags: string[]
  owner_id: string
  current_version: number
  archived: boolean
  file_name: string
  mime: string
  size_bytes: number
  is_link: boolean
  updated_by: string
  updated_at: string
  effective_on: string | null // v7: policy effective date (company library)
  my_ack: MyAck // null when not must-read
  ack_stats: { acked: number; total: number } | null // managers only, must-read docs
  can_manage: boolean
}
export interface DocList {
  items: DocListItem[]
  pending_count: number // must-read docs I still have to acknowledge
  can_upload: boolean // for the requested scope / project
}
export interface DocVersionView extends DocumentVersion {
  is_link: boolean
}
export interface AudienceRow {
  user_id: string
  acked_at: string | null // ack of the current version
  acked_version: number | null // latest version they acknowledged (may be older)
  last_viewed_at: string | null
}
export interface DocDetail {
  doc: DocListItem
  versions: DocVersionView[]
  my_ack_at: string | null
  view_count: number
  audience: AudienceRow[] | null // managers only
}
export interface DocProject {
  id: string
  code: string
  name: string
  status: string
  doc_count: number
  pending: number
  can_manage: boolean
}
export interface FilePayload {
  name: string
  mime: string
  size_bytes: number
  data_url: string
}
export interface DocCreateInput {
  project_id: string | null
  title: string
  description?: string
  category: DocCategory
  visibility: DocVisibility
  must_read: boolean
  tags?: string[]
  effective_on?: string | null
  file?: FilePayload | null
  url?: string | null
  note?: string
}
export interface DocVersionInput {
  note: string
  file?: FilePayload | null
  url?: string | null
}
export type DocPatch = Partial<Pick<DocListItem, 'title' | 'description' | 'category' | 'visibility' | 'must_read' | 'tags' | 'effective_on'>>
/** v7: acknowledgement status of must-read company policies, per policy and per person (managers). */
export interface PolicyStatus {
  policies: { id: string; title: string; current_version: number; effective_on: string | null; acked: number; total: number }[]
  people: { user_id: string; name: string; required: number; acked: number; pending: { id: string; title: string }[] }[]
}
export interface DocDownload {
  file_name: string
  mime: string
  data_url: string | null
  url: string | null
}
export interface DocQuery {
  project_id?: string
  q?: string
  category?: string
  scope?: DocScope
  archived?: boolean
}

export const documentsApi = {
  list: (q: DocQuery) => http.get<DocList>('/documents', q as Record<string, unknown>),
  projects: () => http.get<DocProject[]>('/documents/projects'),
  get: (id: string) => http.get<DocDetail>(`/documents/${id}`),
  create: (b: DocCreateInput) => http.full<DocListItem>('POST', '/documents', { body: b }),
  addVersion: (id: string, b: DocVersionInput) => http.full<DocListItem>('POST', `/documents/${id}/versions`, { body: b }),
  patch: (id: string, b: DocPatch, version?: number) => http.full<DocListItem>('PATCH', `/documents/${id}`, { body: b, ifMatch: version }),
  archive: (id: string) => http.post<DocListItem>(`/documents/${id}/archive`),
  restore: (id: string) => http.post<DocListItem>(`/documents/${id}/restore`),
  ack: (id: string) => http.post<{ version: number; at: string }>(`/documents/${id}/ack`),
  view: (id: string) => http.post(`/documents/${id}/view`),
  policyStatus: () => http.get<PolicyStatus>('/documents/policy-status'),
  download: (id: string, version?: number, preview = false) => http.get<DocDownload>(`/documents/${id}/download`, { version, preview: preview ? 1 : undefined }),
}

export const DOCS_INVALIDATE = [['documents']]

export function useDocuments(q: DocQuery) {
  return useApi(['documents', 'list', q], () => documentsApi.list(q))
}
export function useDocProjects() {
  return useApi(['documents', 'projects'], documentsApi.projects)
}
export function useDocument(id: string | null) {
  return useApi(['documents', 'detail', id], () => documentsApi.get(id!), { enabled: !!id })
}

export const DOC_CATEGORY: Record<DocCategory, string> = {
  requirements: 'Requirements',
  design: 'Design',
  technical: 'Technical',
  test: 'Testing',
  contract: 'Contracts',
  meeting_notes: 'Meeting notes',
  process: 'Processes',
  policy: 'Policies',
  training: 'Training',
  other: 'Templates & other',
}
export const PROJECT_CATEGORIES: DocCategory[] = ['requirements', 'design', 'technical', 'test', 'contract', 'meeting_notes', 'other']
export const COMPANY_CATEGORIES: DocCategory[] = ['policy', 'process', 'training', 'other']
export const DOC_VISIBILITY: Record<DocVisibility, { label: string; hint: string }> = {
  project: { label: 'Project team', hint: 'PM, admins, HR & operations and everyone with a task or allocation on the project.' },
  managers: { label: 'Managers only', hint: 'Admins, the project PM and HR & operations.' },
  company: { label: 'Everyone', hint: 'Every active person in the workspace.' },
}
export const ALLOWED_EXT = ['pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'csv', 'txt', 'md']
export const ACCEPT_ATTR = '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.csv,.txt,.md'
export const MAX_DOC_BYTES = 10 * 1024 * 1024
