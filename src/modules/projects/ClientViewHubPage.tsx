// /client-view (Feature Guide §15, screenshot 030): pick a project and get the same money-free status report
// as /projects/:id/client-view, with "Download report for the client".
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Download } from '@/ui/icons'
import { projectsApi } from '@/api/projects'
import { useApi } from '@/api/query'
import { Button, Card, EmptyState, ErrorState, Field, PageHeader, Select, Skeleton } from '@/ui'
import { ClientReport, exportClientReport } from './ClientViewPage'

const ORDER: Record<string, number> = { active: 0, initiated: 1, on_hold: 2, npa: 3, completed: 4, closed: 5 }

export default function ClientViewHubPage() {
  const [sp, setSp] = useSearchParams()
  const list = useApi(['projects', 'client-view-hub'], () => projectsApi.list({ status: 'all' }))
  const projects = useMemo(
    () => (list.data?.items ?? []).filter((p) => !p.id.startsWith('p_general_')).sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.name.localeCompare(b.name)),
    [list.data],
  )
  const id = sp.get('project') && projects.some((p) => p.id === sp.get('project')) ? sp.get('project')! : projects[0]?.id ?? ''
  const q = useApi(['project', id, 'client-view'], () => projectsApi.clientView(id), { enabled: !!id })
  return (
    <div className="mx-auto max-w-[860px]">
      <PageHeader title="Client view" subtitle="A clean status report for the client: milestones, progress, what’s done and what’s next. No people scores, no costs." />
      <Card className="mb-4 print:hidden">
        {list.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        ) : !projects.length ? (
          <EmptyState compact title="No projects yet" body="Create a project to share its status with the client." action={<Link to="/projects"><Button variant="primary">Open projects</Button></Link>} />
        ) : (
          <div className="flex flex-col gap-3 md:flex-row md:items-end">
            <Field label="Project" className="min-w-0 flex-1">
              <Select
                value={id}
                onChange={(e) => {
                  const n = new URLSearchParams(sp)
                  n.set('project', e.target.value)
                  setSp(n, { replace: true })
                }}
                options={projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.client}` }))}
                aria-label="Project"
              />
            </Field>
            <Button variant="primary" icon={<Download className="size-4" />} disabled={!q.data} onClick={() => q.data && exportClientReport(q.data)} className="w-full md:w-auto">
              Download report for the client
            </Button>
          </div>
        )}
      </Card>
      {id && (q.isLoading ? <Skeleton className="h-[480px] w-full rounded-lg" /> : q.error || !q.data ? <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card> : <ClientReport c={q.data} />)}
    </div>
  )
}
