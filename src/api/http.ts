// Transport layer. Every screen talks to the backend through `api.*` which calls `request()`.
// VITE_API_MODE=mock  -> in-browser mock server (src/mock) that enforces the same contract
// VITE_API_MODE=http  -> the real API (backend/, Python FastAPI + PostgreSQL) at VITE_API_BASE (bearer token + If-Match headers)
import { useSession } from '@/stores/session'

export class ApiError extends Error {
  status: number
  code: string
  field?: string
  constructor(status: number, code: string, message: string, field?: string) {
    super(message)
    this.status = status
    this.code = code
    this.field = field
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>
  body?: unknown
  ifMatch?: number
}

export interface ApiEnvelope<T> {
  data: T
  warnings: { code: string; message: string }[]
}

// Keep local development on the mock unless explicitly switched to HTTP. Production
// builds should use the deployed API by default so a missing Vercel env var cannot
// silently make signup/login run against browser-only demo data.
const MODE = (import.meta.env.VITE_API_MODE as string) || (import.meta.env.PROD ? 'http' : 'mock')
const BASE = (import.meta.env.VITE_API_BASE as string) || (import.meta.env.PROD ? 'https://seereonos-backend.onrender.com/api/v1' : '/api/v1')

let mockHandle: ((method: string, path: string, opts: RequestOptions, headers: Record<string, string>) => Promise<ApiEnvelope<unknown>>) | null = null
async function getMock() {
  if (!mockHandle) {
    const m = await import('@/mock/server')
    mockHandle = m.handle
  }
  return mockHandle
}

function headers(): Record<string, string> {
  const s = useSession.getState()
  const h: Record<string, string> = {}
  if (s.token) h['Authorization'] = `Bearer ${s.token}`
  if (s.viewAs) h['X-View-As'] = s.viewAs.key
  return h
}

/** Low-level call returning data + non-blocking warnings. */
export async function requestFull<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const h = headers()
  if (opts.ifMatch !== undefined) h['If-Match'] = String(opts.ifMatch)
  if (MODE === 'mock') {
    const handle = await getMock()
    try {
      return (await handle(method, path, opts, h)) as ApiEnvelope<T>
    } catch (e) {
      // test hook: an automated crawler may define window.__apiErrors to collect failed calls (no effect otherwise)
      const sink = (globalThis as { __apiErrors?: unknown[] }).__apiErrors
      if (Array.isArray(sink)) sink.push({ method, path, status: (e as ApiError).status, code: (e as ApiError).code, message: (e as Error).message })
      throw e
    }
  }
  const qs = opts.query
    ? '?' + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)])).toString()
    : ''
  const res = await fetch(BASE + path + qs, {
    method,
    credentials: 'same-origin', // auth is the bearer header; no cookies are used
    headers: { 'Content-Type': 'application/json', ...h },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = json?.error ?? {}
    // same crawler test hook as the mock branch above
    const sink = (globalThis as { __apiErrors?: unknown[] }).__apiErrors
    if (Array.isArray(sink)) sink.push({ method, path, status: res.status, code: e.code, message: e.message ?? res.statusText })
    if (res.status === 401) useSession.getState().logout()
    // a 429 from a proxy / load balancer may come without our JSON envelope: still say what to do
    const retry = Number(res.headers.get('Retry-After'))
    const fallback = res.status === 429 ? `Too many requests. Try again in ${retry > 0 ? `${retry} second${retry === 1 ? '' : 's'}` : 'a minute'}.` : res.status >= 500 ? 'Something went wrong on our side. Try again.' : res.statusText
    throw new ApiError(res.status, e.code ?? (res.status === 429 ? 'RATE_LIMITED' : 'HTTP_' + res.status), e.message ?? fallback, e.field)
  }
  const { warnings = [], ...rest } = json as { warnings?: ApiEnvelope<T>['warnings'] }
  const data = 'data' in (json as object) ? (json as { data: T }).data : (rest as T)
  return { data, warnings }
}

export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  return (await requestFull<T>(method, path, opts)).data
}

export const http = {
  get: <T>(path: string, query?: Record<string, unknown>) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, ifMatch?: number) => request<T>('POST', path, { body, ifMatch }),
  patch: <T>(path: string, body?: unknown, ifMatch?: number) => request<T>('PATCH', path, { body, ifMatch }),
  put: <T>(path: string, body?: unknown, ifMatch?: number) => request<T>('PUT', path, { body, ifMatch }),
  del: <T>(path: string, ifMatch?: number) => request<T>('DELETE', path, { ifMatch }),
  full: requestFull,
}

export interface Page<T> {
  items: T[]
  total: number
  page: number
  page_size: number
}
