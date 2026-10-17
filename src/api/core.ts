import { http } from './http'
import { useApi } from './query'
import type { Role, Tenant, ThemeConfig, User } from '@/types/entities'
import type { DirectoryPerson } from '@/mock/routes/auth'

export type { DirectoryPerson }

export interface AuthResult {
  token: string
  user: User
  tenant: Tenant | null
}
/** POST /auth/login when the account uses two-step verification: no session yet, finish with loginMfa() */
export interface MfaChallenge {
  mfa_required: true
  mfa_token: string
  expires_in: number
}
export const isMfaChallenge = (r: AuthResult | MfaChallenge): r is MfaChallenge => (r as MfaChallenge).mfa_required === true

export interface Me {
  user: User
  tenant: Tenant | null
  role: Role
  real_role: Role
  grants: User['grants']
  view_as: string | null
  is_super_admin: boolean
  permissions: string[]
  role_def: { key: string; name: string; persona: Role } | null
}

export const authApi = {
  login: (email: string, password: string) => http.post<AuthResult | MfaChallenge>('/auth/login', { email, password }),
  loginMfa: (mfa_token: string, second: { code: string } | { recovery_code: string }) => http.post<AuthResult & { recovery_codes_left?: number }>('/auth/login/mfa', { mfa_token, ...second }),
  signup: (b: { company: string; name: string; email: string; password: string; industry?: string }) => http.post<AuthResult>('/auth/signup', b),
  logout: () => http.post('/auth/logout'),
  resetRequest: (email: string) => http.post<{ accepted: boolean; demo_token: string | null }>('/auth/reset-request', { email }),
  reset: (token: string, password: string) => http.post('/auth/reset', { token, password }),
  invite: (token: string) => http.get<{ email: string; name: string; role: Role; company: string; reports_to: string | null; theme: ThemeConfig; logo_data_url: string | null }>(`/invites/${token}`),
  acceptInvite: (token: string, b: { name: string; password: string; title?: string }) => http.post<AuthResult>(`/invites/${token}/accept`, b),
  me: () => http.get<Me>('/me'),
  prefs: (p: User['prefs']) => http.patch<User>('/me/prefs', p),
  profile: (p: Partial<Pick<User, 'name' | 'phone' | 'title'>>) => http.patch<User>('/me/profile', p),
  password: (current: string, next: string) => http.post('/me/password', { current, next }),
  resetDemo: () => http.post('/demo/reset'),
}

export const coreApi = {
  directory: () => http.get<DirectoryPerson[]>('/directory'),
  /** Ids of active people holding ANY of the permissions (for pickers: deal owners, project managers…). */
  holders: (perms: string[]) => http.get<string[]>('/directory/holders', { perm: perms.join(',') }),
  tenant: () => http.get<Tenant>('/tenant'),
  saveTheme: (t: Partial<ThemeConfig>, version?: number) => http.put<Tenant>('/tenant/theme', t, version),
  saveLogo: (data_url: string | null) => http.put<Tenant>('/tenant/logo', { data_url }),
}

export function useDirectory() {
  return useApi(['directory'], coreApi.directory, { staleTime: 60_000 })
}
export function usePeopleMap() {
  const q = useDirectory()
  const map = new Map((q.data ?? []).map((p) => [p.id, p]))
  return { ...q, map, get: (id: string | null | undefined) => (id ? map.get(id) : undefined) }
}
/** Set of people who hold any of the permissions (null while loading). Use to filter PeoplePicker by capability. */
export function usePermissionHolders(...perms: string[]) {
  const key = [...perms].sort().join(',')
  const q = useApi(['directory', 'holders', key], () => coreApi.holders(perms), { staleTime: 60_000 })
  return q.data ? new Set(q.data) : null
}
export function useTenant() {
  return useApi(['tenant'], coreApi.tenant, { staleTime: 30_000 })
}
