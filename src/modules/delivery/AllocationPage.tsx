// /delivery/allocation — resource allocation across projects: every allocation row (person, project, milestone, %,
// dates), each person's company-wide load from the server's load calculation, and add / edit / remove through the
// project's own allocation dialog (milestone required, Feature Guide §6). Or one project's Team & allocation tab.
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { MoreHorizontal, Pencil, Plus, Trash2 } from '@/ui/icons'
import { projectsApi, type AllocationView, type PersonLoad, type ProjectDetail, type ProjectListItem, type ProjectLoad } from '@/api/projects'
import { useMut, useScopeKey } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { fmtDate } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, DataTable, Dialog, EmptyState, Field, IconButton, Menu, PageHeader, PeoplePicker, PersonName, Select, useCan, useConfirm, useReadOnly, type Column } from '@/ui'
import { AllocationDialog, TeamTab } from '@/modules/projects/tabs/TeamTab'
import { ModeSwitch, ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, useProjectDetail, useProjectDetails, useViewMode, WithProject } from './shared'

interface Row {
  a: AllocationView
  d: ProjectDetail
}
interface LoadRow {
  user_id: string
  today: number
  avg: number
  over_days: number
  projects: number
}

export default function DeliveryAllocationPage() {
  const { q, items } = useDeliveryProjects({ filter: (p) => !['closed'].includes(p.status) })
  const { mode, setMode } = useViewMode(true)
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Resource allocation" subtitle="Who works on which project and milestone, what % of their time and when, with each person’s load across all projects." />
      <ProjectsGate q={q} items={items}>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'all' ? (
          <Overview projects={items} />
        ) : (
          <>
            <ProjectPickerCard projects={items} id={id} onChange={choose} tab="team" />
            <WithProject id={id}>{(d) => <TeamTab d={d} />}</WithProject>
          </>
        )}
      </ProjectsGate>
    </div>
  )
}

function Overview({ projects }: { projects: ProjectListItem[] }) {
  const nav = useNavigate()
  const scope = useScopeKey()
  const can = useCan()
  const readOnly = useReadOnly()
  const people = usePeopleMap()
  const { confirm } = useConfirm()
  const ids = projects.map((p) => p.id)
  const det = useProjectDetails(ids)
  const loads = useQueries({ queries: ids.map((id) => ({ queryKey: [...scope, 'project', id, 'load'], queryFn: () => projectsApi.load(id), retry: false })) })
  const [person, setPerson] = useState<string | null>(null)
  const [project, setProject] = useState('')
  const [edit, setEdit] = useState<Row | null>(null)
  const [adding, setAdding] = useState(false)
  const [addFor, setAddFor] = useState<string | null>(null)
  const del = useMut((r: Row) => projectsApi.deleteAllocation(r.a.id), { invalidate: [['project'], ['projects'], ['margins']], success: 'Allocation removed' })
  const editableProjects = det.data.filter((d) => d.can_edit && d.milestones.length > 0)
  const canAllocate = can('allocation.edit') && !readOnly && editableProjects.length > 0

  const all: Row[] = useMemo(() => det.data.flatMap((d) => d.allocations.map((a) => ({ a, d }))), [det.data])
  const rows = all.filter((r) => (!person || r.a.user_id === person) && (!project || r.d.project.id === project))

  // load per person: the server's company-wide figures (same for a person on every project), merged across projects
  const loadRows: LoadRow[] = useMemo(() => {
    const by = new Map<string, LoadRow>()
    loads.forEach((l) => {
      const data = l.data as ProjectLoad | undefined
      if (!data) return
      data.people.forEach((p: PersonLoad) => {
        const cur = by.get(p.user_id)
        const projectsFor = new Set(all.filter((r) => r.a.user_id === p.user_id).map((r) => r.d.project.id)).size
        const row = { user_id: p.user_id, today: p.days[0]?.total_pct ?? 0, avg: p.avg_pct, over_days: p.over_days.length, projects: projectsFor }
        if (!cur || row.over_days > cur.over_days) by.set(p.user_id, row)
      })
    })
    return [...by.values()].filter((r) => r.projects > 0).sort((a, b) => b.today - a.today || (people.get(a.user_id)?.name ?? '').localeCompare(people.get(b.user_id)?.name ?? ''))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loads.map((l) => l.dataUpdatedAt).join(), all, people])
  const maxPct = (loads.find((l) => l.data)?.data as ProjectLoad | undefined)?.max_pct ?? 100

  const columns: Column<Row>[] = [
    { key: 'person', header: 'Person', sortValue: (r) => people.get(r.a.user_id)?.name ?? '', cell: (r) => <PersonName id={r.a.user_id} size={24} /> },
    { key: 'project', header: 'Project', sortValue: (r) => r.d.project.code, cell: (r) => <div className="min-w-0"><div className="tnum text-[12px] text-ink-3">{r.d.project.code}</div><div className="truncate text-[13.5px]">{r.d.project.name}</div></div> },
    { key: 'ms', header: 'Milestone', sortValue: (r) => `${r.d.project.code}${r.a.ms_code}`, cell: (r) => <span className="text-[13px]"><span className="tnum text-ink-3">{r.a.ms_code}</span> {r.a.ms_name}</span> },
    { key: 'pct', header: 'Allocation', align: 'right', sortValue: (r) => r.a.pct, cell: (r) => <span className="tnum font-medium">{r.a.pct}%</span> },
    { key: 'from', header: 'From', sortValue: (r) => r.a.from_on, cell: (r) => <span className="tnum whitespace-nowrap">{fmtDate(r.a.from_on)}</span> },
    { key: 'to', header: 'To', sortValue: (r) => r.a.to_on, cell: (r) => <span className="tnum whitespace-nowrap">{fmtDate(r.a.to_on)}</span> },
    {
      key: 'menu', header: '', width: '44px',
      cell: (r) =>
        r.d.can_edit && can('allocation.edit') && !readOnly ? (
          <div onClick={(e) => e.stopPropagation()}>
            <Menu
              label="Allocation actions"
              trigger={<IconButton size="sm" label="Allocation actions"><MoreHorizontal className="size-4" /></IconButton>}
              items={[
                { label: 'Edit allocation', icon: <Pencil />, onSelect: () => setEdit(r) },
                { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: async () => (await confirm({ title: 'Remove this allocation?', body: 'Planned cost and resource load update straight away.', confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(r) },
              ]}
            />
          </div>
        ) : null,
    },
  ]
  const loadCols: Column<LoadRow>[] = [
    { key: 'person', header: 'Person', sortValue: (r) => people.get(r.user_id)?.name ?? '', cell: (r) => <PersonName id={r.user_id} size={24} /> },
    { key: 'today', header: 'Current load', align: 'right', sortValue: (r) => r.today, cell: (r) => <span className={cn('tnum font-medium', r.today > maxPct && 'text-danger-text')}>{r.today}%</span> },
    { key: 'avg', header: 'Next 10 days', align: 'right', sortValue: (r) => r.avg, cell: (r) => <span className="tnum">{fmtNum(r.avg, 0)}%</span> },
    { key: 'projects', header: 'Projects', align: 'right', sortValue: (r) => r.projects, cell: (r) => <span className="tnum">{r.projects}</span> },
    { key: 'over', header: `Days over ${maxPct}%`, align: 'right', sortValue: (r) => r.over_days, cell: (r) => (r.over_days ? <Badge tone="danger" size="sm">{r.over_days}</Badge> : <span className="tnum text-ink-3">0</span>) },
  ]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 2xl:grid-cols-12">
        <Card pad={false} className="min-w-0 2xl:col-span-8">
          <div className="flex flex-col gap-3 border-b border-line p-4 md:px-5">
            <CardHeader
              className="mb-0"
              title="Allocations"
              subtitle={`${all.length} allocation row${all.length === 1 ? '' : 's'} across ${det.data.length} project${det.data.length === 1 ? '' : 's'}. Every row lands on a milestone.`}
              action={canAllocate ? <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>Allocate</Button> : undefined}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Person">
                <PeoplePicker value={person} onChange={setPerson} clearable placeholder="Everyone" />
              </Field>
              <Field label="Project">
                <Select value={project} onChange={(e) => setProject(e.target.value)} options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: `${p.code} · ${p.name}` }))]} aria-label="Filter by project" />
              </Field>
            </div>
          </div>
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.a.id}
            loading={det.loading && !all.length}
            error={det.error}
            onRetry={det.refetch}
            initialSort={{ key: 'person', dir: 'asc' }}
            onRowClick={(r) => nav(`/projects/${r.d.project.id}/team`)}
            empty={<EmptyState compact title="No allocations match" body={person || project ? 'Change the person or project filter.' : 'Allocate people to project milestones to plan cost and load.'} />}
            mobileCard={(r) => (
              <div className="flex min-w-0 items-start justify-between gap-2">
                <div className="min-w-0">
                  <PersonName id={r.a.user_id} size={24} />
                  <div className="mt-1 text-[12.5px] text-ink-3"><span className="tnum">{r.d.project.code}</span> · {r.a.ms_code} {r.a.ms_name}</div>
                  <div className="tnum text-[12.5px] text-ink-3">{fmtDate(r.a.from_on)} – {fmtDate(r.a.to_on)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="tnum text-[14px] font-semibold">{r.a.pct}%</span>
                  {columns[6].cell(r)}
                </div>
              </div>
            )}
          />
        </Card>
        <Card pad={false} className="min-w-0 2xl:col-span-4">
          <div className="border-b border-line p-4 md:px-5">
            <CardHeader className="mb-0" title="Load per person" subtitle={`Total allocation across all projects; over ${maxPct}% is over capacity.`} />
          </div>
          <DataTable
            rows={loadRows}
            columns={loadCols}
            rowKey={(r) => r.user_id}
            dense
            loading={loads.some((l) => l.isLoading) && !loadRows.length}
            initialSort={{ key: 'today', dir: 'desc' }}
            onRowClick={(r) => setPerson(r.user_id)}
            empty={<EmptyState compact title="No one allocated" body="Load appears once people are allocated to milestones." />}
            mobileCard={(r) => (
              <div className="flex items-center justify-between gap-2">
                <PersonName id={r.user_id} size={24} />
                <span className="tnum whitespace-nowrap text-[13px]">
                  <span className={cn('font-semibold', r.today > maxPct && 'text-danger-text')}>{r.today}%</span>
                  <span className="text-ink-3"> today · {fmtNum(r.avg, 0)}% next 10 days</span>
                </span>
              </div>
            )}
          />
        </Card>
      </div>
      {edit && <AllocationDialog d={edit.d} open={!!edit} a={edit.a} onOpenChange={(o) => !o && setEdit(null)} />}
      <ChooseProjectDialog
        open={adding}
        projects={editableProjects}
        onClose={() => setAdding(false)}
        onPick={(pid) => {
          setAdding(false)
          setAddFor(pid)
        }}
      />
      {addFor && <AddFor id={addFor} onClose={() => setAddFor(null)} />}
    </div>
  )
}

/** Allocate needs a project first (its milestones and dates); then the project's own allocation dialog opens. */
function ChooseProjectDialog({ open, projects, onClose, onPick }: { open: boolean; projects: ProjectDetail[]; onClose: () => void; onPick: (id: string) => void }) {
  const [id, setId] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose()
        setError(null)
      }}
      title="Allocate a person"
      description="Choose the project first. Only projects you manage that have milestones are listed: every allocation lands on a milestone."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              if (!id) return setError('Choose the project.')
              onPick(id)
              setId('')
            }}
          >
            Continue
          </Button>
        </>
      }
    >
      <Field label="Project" required error={error}>
        <Select value={id} invalid={!!error} placeholder="Choose…" onChange={(e) => { setId(e.target.value); setError(null) }} options={projects.map((d) => ({ value: d.project.id, label: `${d.project.code} · ${d.project.name}` }))} aria-label="Project" />
      </Field>
    </Dialog>
  )
}

function AddFor({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useProjectDetail(id)
  if (!q.data) return null
  return <AllocationDialog d={q.data} open a={null} onOpenChange={(o) => !o && onClose()} />
}
