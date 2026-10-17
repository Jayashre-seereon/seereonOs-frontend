import { create } from 'zustand'
import { storage } from '@/lib/storage'
import type { Role, Tenant, User } from '@/types/entities'

/** A role being previewed with "View as" (read-only). */
export interface ViewAsRole {
  key: string
  name: string
  persona: Role
  permissions: string[]
}

export interface SessionState {
  token: string | null
  user: User | null
  tenant: Tenant | null
  viewAs: ViewAsRole | null
  setSession: (s: { token: string; user: User; tenant: Tenant | null }) => void
  patchUser: (u: Partial<User>) => void
  setTenant: (t: Tenant | null) => void
  setViewAs: (r: ViewAsRole | null) => void
  logout: () => void
}

const KEY = 'seereonos.session.v4'
const saved = storage.get<{ token: string | null; user: User | null; tenant: Tenant | null }>(KEY, { token: null, user: null, tenant: null })

export const useSession = create<SessionState>((set, get) => ({
  token: saved.token,
  user: saved.user,
  tenant: saved.tenant,
  viewAs: null,
  setSession: ({ token, user, tenant }) => {
    storage.set(KEY, { token, user, tenant })
    set({ token, user, tenant, viewAs: null })
  },
  patchUser: (u) => {
    const user = get().user ? { ...get().user!, ...u } : null
    storage.set(KEY, { token: get().token, user, tenant: get().tenant })
    set({ user })
  },
  setTenant: (tenant) => {
    storage.set(KEY, { token: get().token, user: get().user, tenant })
    set({ tenant })
  },
  setViewAs: (viewAs) => set({ viewAs }),
  logout: () => {
    storage.remove(KEY)
    set({ token: null, user: null, tenant: null, viewAs: null })
  },
}))

/** Effective persona for rendering (home dashboard, mobile tabs): the View-as role's persona when set. */
export function useEffectiveRole(): Role | null {
  const { user, viewAs } = useSession()
  return viewAs?.persona ?? user?.role ?? null
}
/** Effective permission keys: the View-as role's when previewing, otherwise the signed-in user's. */
export function useEffectivePermissions(): string[] {
  const { user, viewAs } = useSession()
  return viewAs?.permissions ?? user?.permissions ?? []
}
/** Display name of the effective role ("HR Manager"). */
export function useEffectiveRoleName(): string {
  const { user, viewAs } = useSession()
  return viewAs?.name ?? user?.role_name ?? user?.title ?? ''
}
