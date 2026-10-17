// Permission checks (v4). Capabilities are permission keys from domain/permissionCatalog; roles are
// tenant data that bundle keys. The UI uses these to HIDE actions and the mock server to ENFORCE them.
// `Role` remains as the *persona* (which home dashboard and default views a role gets).
import type { Role } from '@/types/entities'
import type { PermissionKey } from './permissionCatalog'

export type Action = PermissionKey

export type PermSource = readonly string[] | ReadonlySet<string> | null | undefined
export function can(perms: PermSource, action: Action): boolean {
  if (!perms) return false
  return perms instanceof Set ? perms.has(action) : (perms as readonly string[]).includes(action)
}
export function canAny(perms: PermSource, ...actions: Action[]): boolean {
  return actions.some((a) => can(perms, a))
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: 'Admin (CEO)',
  pm: 'Project manager',
  sales: 'Sales',
  ops: 'HR & operations',
  employee: 'Employee',
}
export const ROLE_SHORT: Record<Role, string> = { admin: 'CEO', pm: 'PM', sales: 'Sales', ops: 'HR & Ops', employee: 'Employee' }
