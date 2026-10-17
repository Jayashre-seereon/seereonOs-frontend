// v4 access client: roles & permissions, users & employees, setup checklist, master-data pickers.
import { http } from './http'
import { useApi } from './query'
import { changesApi, type Proposed } from './changes'
import type { ChangeEntity, CostCentre, Department, Designation, EmailMessage, Grade, Location, OrgProfile, Shift } from '@/types/access'
import type { Role } from '@/types/entities'
import type { RoleRow, SetupStep } from '@/mock/routes/access'
import type { CreatedEmployee, UserRow } from '@/mock/routes/people'
import type { PermissionDef, PermissionModule } from '@/domain/permissionCatalog'

export type { RoleRow, SetupStep, CreatedEmployee, UserRow }

export interface RoleMember {
  id: string
  name: string
  email: string
  title: string
  status: 'active' | 'deactivated' | 'invited'
  avatar_hue: number
  extra_permissions: string[]
  revoked_permissions: string[]
  last_login_at: string | null
}
export interface RoleDetail extends RoleRow {
  members: RoleMember[]
  created_by_name: string | null
}
export interface RoleInput {
  name: string
  description: string
  persona: Role
  permissions: string[]
  active?: boolean
  copy_from?: string | null
}
export interface SetupStatus {
  steps: SetupStep[]
  done: number
  total: number
  complete: boolean
  company: string
}
export interface EmployeeInput {
  name: string
  email: string
  personal_email: string
  phone: string
  joined_on: string
  employment_type: 'full_time' | 'part_time' | 'contract' | 'intern'
  department_id: string | null
  designation_id: string | null
  grade_id: string | null
  location_id: string | null
  shift_id: string | null
  cost_centre_id: string | null
  reports_to_id: string | null
  role_key: string
  extra_permissions: string[]
  monthly_ctc_paise: number | null
  send_welcome: boolean
}
export interface JobPatch {
  name?: string
  title?: string
  phone?: string | null
  personal_email?: string | null
  joined_on?: string
  employment_type?: EmployeeInput['employment_type'] | null
  department_id?: string | null
  designation_id?: string | null
  grade_id?: string | null
  location_id?: string | null
  shift_id?: string | null
  cost_centre_id?: string | null
  reports_to_id?: string | null
}
export interface AccessPatch {
  role_key?: string
  extra_permissions?: string[]
  revoked_permissions?: string[]
}
export interface PasswordReset {
  user: UserRow
  temp_password: string
  login_email: string
  email: EmailMessage | null
}

/** Guarded write result; when pending, who can approve it. */
export type ProposedNamed<R> = Proposed<R> & { checker_names?: string[] }

export const EMPLOYMENT_TYPE_LABEL: Record<EmployeeInput['employment_type'], string> = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', intern: 'Intern' }

/** Keep rule warnings for useMut to toast, but leave "sent for approval" to the screen's own message. */
const quiet = <T,>(p: Promise<{ data: T; warnings: { code: string; message: string }[] }>) => p.then((r) => ({ ...r, warnings: r.warnings.filter((w) => w.code !== 'PENDING_APPROVAL') }))

export const accessApi = {
  catalogue: () => http.get<{ module: PermissionModule; label: string; permissions: PermissionDef[] }[]>('/permissions'),
  roles: () => http.get<RoleRow[]>('/roles'),
  role: (key: string) => http.get<RoleDetail>(`/roles/${key}`),
  createRole: (b: RoleInput) => quiet(http.full<ProposedNamed<RoleRow>>('POST', '/roles', { body: b })),
  cloneRole: (key: string, name?: string) => quiet(http.full<ProposedNamed<RoleRow>>('POST', `/roles/${key}/clone`, { body: { name } })),
  updateRole: (key: string, b: Partial<RoleInput>, version?: number) => quiet(http.full<ProposedNamed<RoleRow>>('PATCH', `/roles/${key}`, { body: b, ifMatch: version })),
  deleteRole: (key: string) => quiet(http.full<ProposedNamed<{ ok: true }>>('DELETE', `/roles/${key}`)),
  setupStatus: () => http.get<SetupStatus>('/setup/status'),

  users: () => http.get<UserRow[]>('/users'),
  user: (id: string) => http.get<UserRow>(`/users/${id}`),
  patchUser: (id: string, b: JobPatch & AccessPatch, version?: number) => quiet(http.full<{ user: UserRow; access: ProposedNamed<UserRow> | null }>('PATCH', `/users/${id}`, { body: b, ifMatch: version })),
  createEmployee: (b: EmployeeInput) => quiet(http.full<ProposedNamed<CreatedEmployee>>('POST', '/employees', { body: b })),
  resetPassword: (id: string) => quiet(http.full<PasswordReset>('POST', `/users/${id}/reset-password`)),
  resetTwoFactor: (id: string) => http.post<{ user: UserRow }>(`/users/${id}/2fa/reset`),
  deactivate: (id: string) => quiet(http.full<ProposedNamed<UserRow>>('POST', `/users/${id}/deactivate`)),
  reactivate: (id: string) => quiet(http.full<UserRow>('POST', `/users/${id}/reactivate`)),

  departments: () => http.get<Department[]>('/master/departments'),
  designations: () => http.get<Designation[]>('/master/designations'),
  grades: () => http.get<Grade[]>('/master/grades'),
  locations: () => http.get<Location[]>('/master/locations'),
  shifts: () => http.get<Shift[]>('/master/shifts'),
  costCentres: () => http.get<CostCentre[]>('/master/cost-centres'),
  org: () => http.get<OrgProfile | null>('/master/org'),
}

export const useRoles = (enabled = true) => useApi(['roles'], accessApi.roles, { enabled })
export const useRole = (key: string) => useApi(['roles', key], () => accessApi.role(key))
export const useSetupStatus = (enabled = true) => useApi(['setup-status'], accessApi.setupStatus, { enabled })
export const useUserRows = () => useApi(['users'], accessApi.users)
export const usePendingChanges = (entity: ChangeEntity, enabled = true) => useApi(['changes', 'pending', entity], () => changesApi.list({ status: 'pending', entity, scope: 'all' }), { enabled })

/** Master-data lists for pickers (read-only for everyone in the tenant). */
export function useMasterData() {
  const opts = { staleTime: 60_000 }
  return {
    departments: useApi(['master', 'departments'], accessApi.departments, opts),
    designations: useApi(['master', 'designations'], accessApi.designations, opts),
    grades: useApi(['master', 'grades'], accessApi.grades, opts),
    locations: useApi(['master', 'locations'], accessApi.locations, opts),
    shifts: useApi(['master', 'shifts'], accessApi.shifts, opts),
    costCentres: useApi(['master', 'cost-centres'], accessApi.costCentres, opts),
  }
}
export const useOrgProfile = () => useApi(['master', 'org'], accessApi.org, { staleTime: 60_000 })

/** Query keys to refresh after any people/role change. */
export const PEOPLE_KEYS = [['users'], ['directory'], ['roles'], ['setup-status'], ['changes'], ['team'], ['onboarding'], ['invites']]
