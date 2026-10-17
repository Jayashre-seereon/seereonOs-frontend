import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, requestFull } from './http'
import { useSession } from '@/stores/session'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      retry: (n, e) => !(e instanceof ApiError && [401, 402, 403, 404, 409, 422].includes(e.status)) && n < 2,
      refetchOnWindowFocus: false,
    },
  },
})

/** Query keys are prefixed with tenant + view-as so switching never shows another tenant's cache. */
export function useScopeKey(): string[] {
  const { tenant, viewAs, user } = useSession()
  return [tenant?.id ?? 'none', viewAs?.key ?? user?.role_key ?? user?.role ?? 'anon']
}

export function useApi<T>(key: QueryKey, fn: () => Promise<T>, opts: Omit<UseQueryOptions<T, Error, T, QueryKey>, 'queryKey' | 'queryFn'> = {}) {
  const scope = useScopeKey()
  return useQuery<T, Error, T, QueryKey>({ queryKey: [...scope, ...(key as unknown[])], queryFn: fn, ...opts })
}

export interface MutOpts<V, R> {
  /** query-key prefixes (without scope) to invalidate after success */
  invalidate?: QueryKey[]
  success?: string | ((r: R, v: V) => string | null)
  onSuccess?: (r: R, v: V) => void
  onError?: (e: ApiError, v: V) => void
  silentError?: boolean
}

export function toastError(e: unknown) {
  const err = e as ApiError
  const title =
    err.status === 403 ? 'Not allowed' : err.status === 402 ? 'Workspace is read-only' : err.status === 409 && err.code === 'STALE' ? 'This changed while you were editing' : err.status === 409 ? 'Rule check failed' : err.status === 422 ? 'Check the form' : 'Something went wrong'
  toast.error(title, { description: err.message })
}

/** Mutation with the house behaviour: toasts, warnings[], cache invalidation. */
export function useMut<V, R = unknown>(fn: (v: V) => Promise<{ data: R; warnings: { code: string; message: string }[] } | R>, opts: MutOpts<V, R> = {}) {
  const qc = useQueryClient()
  const scope = useScopeKey()
  return useMutation<R, ApiError, V>({
    mutationFn: async (v) => {
      const res = await fn(v)
      if (res && typeof res === 'object' && 'warnings' in (res as object) && 'data' in (res as object)) {
        const r = res as { data: R; warnings: { code: string; message: string }[] }
        r.warnings.forEach((w) => toast.warning(w.message))
        return r.data
      }
      return res as R
    },
    onSuccess: (r, v) => {
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: [...scope, ...(k as unknown[])] })
      // any decision can change what is waiting in the approvals inbox
      qc.invalidateQueries({ queryKey: [...scope, 'inbox'] })
      const msg = typeof opts.success === 'function' ? opts.success(r, v) : opts.success
      if (msg) toast.success(msg)
      opts.onSuccess?.(r, v)
    },
    onError: (e, v) => {
      if (!opts.silentError) toastError(e)
      opts.onError?.(e, v)
    },
  })
}

/** Helper to call an endpoint and keep warnings (for useMut). */
export const withWarnings = requestFull
