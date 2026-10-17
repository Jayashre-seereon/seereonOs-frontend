// Organisation master data + email templates/outbox — typed client and hooks.
import { http } from './http'
import { useApi } from './query'
import type { Proposed } from './changes'
import type { CostCentre, Department, Designation, EmailMessage, EmailTemplate, Grade, Location, OrgProfile, RoleDef, Shift } from '@/types/access'

export type MasterType = 'locations' | 'departments' | 'designations' | 'grades' | 'cost-centres' | 'shifts'
export interface MasterRowOf {
  locations: Location
  departments: Department
  designations: Designation
  grades: Grade
  'cost-centres': CostCentre
  shifts: Shift
}
export type MasterRow = MasterRowOf[MasterType]
export type Usage = Record<MasterType, Record<string, number>>
export interface MasterPerson {
  id: string
  name: string
  title: string
  avatar_hue: number
  status: string
  employee_code: string | null
  department_id: string | null
  location_id: string | null
  shift_id: string | null
}
export interface TemplateView extends EmailTemplate {
  placeholders: string[]
  required_placeholders: string[]
  is_system: boolean
}
export interface OutboxMessage extends EmailMessage {
  to_name: string | null
}
export interface EmailPreview {
  subject: string
  body: string
  to: string
  unknown: string[]
  missing: string[]
}
/** Org profile body for PUT: profile fields + optional full `bank_account` (stored masked). */
export type OrgPatch = Partial<OrgProfile> & { bank_account?: string }

const full = http.full
export const masterApi = {
  list: <T extends MasterType>(type: T) => http.get<MasterRowOf[T][]>(`/master/${type}`),
  usage: () => http.get<Usage>('/master/usage'),
  people: () => http.get<MasterPerson[]>('/master/people'),
  create: <T extends MasterType>(type: T, body: Partial<MasterRowOf[T]>) => full<Proposed<MasterRowOf[T]>>('POST', `/master/${type}`, { body }),
  update: <T extends MasterType>(type: T, id: string, body: Partial<MasterRowOf[T]>, version?: number) => full<Proposed<MasterRowOf[T]>>('PATCH', `/master/${type}/${id}`, { body, ifMatch: version }),
  remove: (type: MasterType, id: string, version?: number) => full<Proposed<{ id: string; deleted: true }>>('DELETE', `/master/${type}/${id}`, { ifMatch: version }),
  setActive: <T extends MasterType>(type: T, id: string, active: boolean) => full<Proposed<MasterRowOf[T]>>('POST', `/master/${type}/${id}/${active ? 'activate' : 'deactivate'}`),
  shiftMembers: (id: string) => http.get<{ id: string; name: string; title: string; avatar_hue: number; employee_code: string | null }[]>(`/master/shifts/${id}/members`),
  assignShift: (id: string, user_ids: string[]) => full<Proposed<{ moved: number }>>('POST', `/master/shifts/${id}/assign`, { body: { user_ids } }),
  org: () => http.get<OrgProfile | null>('/master/org'),
  orgMeta: () => http.get<{ version: number; maker_checker: boolean }>('/master/org/meta'),
  saveOrg: (body: OrgPatch, version?: number) => full<Proposed<OrgProfile>>('PUT', '/master/org', { body, ifMatch: version }),
  roles: () => http.get<(RoleDef & { user_count: number })[]>('/roles'),
  // emails
  templates: () => http.get<TemplateView[]>('/emails/templates'),
  saveTemplate: (id: string, body: { subject?: string; body?: string; active?: boolean }, version?: number) => full<TemplateView>('PUT', `/emails/templates/${id}`, { body, ifMatch: version }),
  resetTemplate: (id: string, version?: number) => full<TemplateView>('POST', `/emails/templates/${id}/reset`, { ifMatch: version }),
  preview: (id: string, body: { subject: string; body: string }) => http.post<EmailPreview>(`/emails/templates/${id}/preview`, body),
  outbox: (q: { template_key?: string; search?: string } = {}) => http.get<OutboxMessage[]>('/emails/outbox', q),
  message: (id: string) => http.get<OutboxMessage>(`/emails/outbox/${id}`),
}

export const useMasterList = <T extends MasterType>(type: T) => useApi(['master', type], () => masterApi.list(type))
export const useMasterUsage = () => useApi(['master', 'usage'], masterApi.usage)
export const useMasterPeople = () => useApi(['master', 'people'], masterApi.people)
export const useOrgProfile = () => useApi(['master', 'org'], masterApi.org)
export const useOrgMeta = () => useApi(['master', 'org-meta'], masterApi.orgMeta)
export const useRolesLite = (enabled = true) => useApi(['roles'], masterApi.roles, { enabled, retry: false })
export const useEmailTemplates = () => useApi(['emails', 'templates'], masterApi.templates)
export const useOutbox = (q: { template_key?: string; search?: string }) => useApi(['emails', 'outbox', q.template_key ?? '', q.search ?? ''], () => masterApi.outbox(q))

/** PREFIX-NNN — the employee number format (matches the server). */
export function formatEmployeeCode(prefix: string, n: number) {
  return `${prefix || 'EMP'}-${String(Math.max(0, Math.floor(n || 0))).padStart(3, '0')}`
}

export const WEEKDAYS = [
  { d: 1, short: 'Mon', min: 'M' },
  { d: 2, short: 'Tue', min: 'T' },
  { d: 3, short: 'Wed', min: 'W' },
  { d: 4, short: 'Thu', min: 'T' },
  { d: 5, short: 'Fri', min: 'F' },
  { d: 6, short: 'Sat', min: 'S' },
  { d: 0, short: 'Sun', min: 'S' },
]

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]
