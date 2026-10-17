// v7 — project-scoped delivery areas reachable from the sidebar without opening a project first (/delivery/<area>).
// Each page offers a cross-project overview where it makes sense and a project picker that renders the SAME tab
// component the project page uses. The chosen project lives in the URL (?project=id) and is remembered per user.
import { useEffect, useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { ArrowUpRight } from '@/ui/icons'
import { projectsApi, type ProjectDetail, type ProjectListItem } from '@/api/projects'
import { useApi, useScopeKey } from '@/api/query'
import { useSession } from '@/stores/session'
import { storage } from '@/lib/storage'
import { Button, Card, EmptyState, ErrorState, Field, Segmented, Select, Skeleton, SkeletonRows } from '@/ui'

const ORDER: Record<string, number> = { active: 0, initiated: 1, on_hold: 2, npa: 3, completed: 4, closed: 5 }
export const isGeneral = (id: string) => id.startsWith('p_general_')

/** Projects the viewer can see (server-scoped), open ones first. `general` keeps the built-in "General & admin" project. */
export function useDeliveryProjects(opts: { general?: boolean; filter?: (p: ProjectListItem) => boolean } = {}) {
  const q = useApi(['projects', 'delivery-list'], () => projectsApi.list({ status: 'all' }))
  const { general = false, filter } = opts
  const items = useMemo(
    () =>
      (q.data?.items ?? [])
        .filter((p) => (general || !isGeneral(p.id)) && (!filter || filter(p)))
        .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.priority - b.priority || a.name.localeCompare(b.name)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.data, general],
  )
  return { q, items }
}

/** ?project= in the URL, else the last project this user chose on any delivery page, else the first one. */
export function useProjectChoice(projects: ProjectListItem[]) {
  const [sp, setSp] = useSearchParams()
  const { user } = useSession()
  const key = `seereonos.delivery.project.${user?.id ?? 'anon'}`
  const fromUrl = sp.get('project')
  const remembered = storage.get<string | null>(key, null)
  const ok = (id: string | null) => !!id && projects.some((p) => p.id === id)
  const id = ok(fromUrl) ? fromUrl! : ok(remembered) ? remembered! : projects[0]?.id ?? ''
  useEffect(() => {
    if (id && ok(fromUrl)) storage.set(key, id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fromUrl, key])
  const choose = (next: string) => {
    const n = new URLSearchParams(sp)
    n.set('project', next)
    n.set('view', 'project')
    storage.set(key, next)
    setSp(n, { replace: true })
  }
  return { id, choose }
}

/** Overview vs one project (?view=all|project). Opening with ?project= goes straight to that project. */
export function useViewMode(hasOverview: boolean) {
  const [sp, setSp] = useSearchParams()
  const raw = sp.get('view')
  const mode: 'all' | 'project' = !hasOverview ? 'project' : raw === 'project' || raw === 'all' ? raw : sp.get('project') ? 'project' : 'all'
  const setMode = (m: 'all' | 'project') => {
    const n = new URLSearchParams(sp)
    n.set('view', m)
    setSp(n, { replace: true })
  }
  return { mode, setMode }
}

export function ModeSwitch({ mode, onChange, allLabel = 'All projects' }: { mode: 'all' | 'project'; onChange: (m: 'all' | 'project') => void; allLabel?: string }) {
  return (
    <Segmented
      className="mb-4 w-full sm:w-auto"
      value={mode}
      onChange={onChange}
      options={[
        { value: 'all', label: allLabel },
        { value: 'project', label: 'One project' },
      ]}
    />
  )
}

/** "Choose a project" card: the picker plus a link to the full project page. */
export function ProjectPickerCard({ projects, id, onChange, tab, extra }: { projects: ProjectListItem[]; id: string; onChange: (id: string) => void; tab?: string; extra?: ReactNode }) {
  return (
    <Card className="mb-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <Field label="Choose a project" className="min-w-0 flex-1">
          <Select value={id} onChange={(e) => onChange(e.target.value)} options={projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name} · ${p.client}` }))} aria-label="Choose a project" />
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row md:shrink-0">
          {extra}
          {id && (
            <Link to={tab ? `/projects/${id}/${tab}` : `/projects/${id}`} className="w-full md:w-auto">
              <Button className="w-full md:w-auto" icon={<ArrowUpRight className="size-4" />}>
                Open project
              </Button>
            </Link>
          )}
        </div>
      </div>
    </Card>
  )
}

/** The project detail (same query key as the project page, so edits made here refresh there and vice versa). */
export function useProjectDetail(id: string) {
  return useApi(['project', id], () => projectsApi.detail(id), { enabled: !!id })
}

/** Details of several projects (each cached under the project page's key). */
export function useProjectDetails(ids: string[], enabled = true) {
  const scope = useScopeKey()
  const qs = useQueries({ queries: ids.map((id) => ({ queryKey: [...scope, 'project', id], queryFn: () => projectsApi.detail(id), enabled })) })
  const loading = qs.some((q) => q.isLoading)
  const error = qs.find((q) => q.error)?.error ?? null
  const data = qs.map((q) => q.data).filter(Boolean) as ProjectDetail[]
  return { loading, error, data, refetch: () => qs.forEach((q) => q.refetch()) }
}

/** Loading / error / empty wrapper for the project list. */
export function ProjectsGate({ q, items, emptyBody, children }: { q: { isLoading: boolean; error: unknown; refetch: () => unknown }; items: ProjectListItem[]; emptyBody?: string; children: ReactNode }) {
  if (q.isLoading)
    return (
      <Card>
        <SkeletonRows rows={6} />
      </Card>
    )
  if (q.error)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  if (!items.length)
    return (
      <Card>
        <EmptyState title="No projects to show" body={emptyBody ?? 'You don’t work on any project yet. Projects you manage or are allocated to appear here.'} action={<Link to="/projects"><Button>Open projects</Button></Link>} />
      </Card>
    )
  return <>{children}</>
}

/** Renders a tab component for the chosen project once its detail has loaded. */
export function WithProject({ id, children }: { id: string; children: (d: ProjectDetail) => ReactNode }) {
  const q = useProjectDetail(id)
  if (!id) return null
  if (q.isLoading)
    return (
      <div aria-busy="true">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="mt-4 h-[360px] w-full rounded-lg" />
      </div>
    )
  if (q.error || !q.data)
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    )
  return <>{children(q.data)}</>
}
