// /delivery/import — "Import WBS" from the sidebar: choose a project you manage, then continue to its import screen.
import { useNavigate } from 'react-router-dom'
import { FileUp } from '@/ui/icons'
import { Button, Callout, PageHeader, useReadOnly } from '@/ui'
import { ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice } from './shared'

export default function DeliveryImportPage() {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const { q, items } = useDeliveryProjects({ filter: (p) => p.can_edit && !['completed', 'closed'].includes(p.status) })
  const { id, choose } = useProjectChoice(items)
  const p = items.find((x) => x.id === id)
  return (
    <div>
      <PageHeader title="Import WBS" subtitle="Bring a work breakdown from Excel or CSV into a project you manage: milestones, tasks, estimates, owners and dependencies." />
      <ProjectsGate q={q} items={items} emptyBody="You don’t manage an open project. Import a WBS into a project where you are the project manager.">
        <ProjectPickerCard
          projects={items}
          id={id}
          onChange={choose}
          tab="wbs"
          extra={
            <Button variant="primary" className="w-full md:w-auto" icon={<FileUp className="size-4" />} disabled={!id || readOnly} onClick={() => nav(`/projects/${id}/import`)}>
              Continue to import
            </Button>
          }
        />
        {p && (
          <Callout tone="info" title={`Importing into ${p.code} ${p.name}`}>
            The next screen shows a preview before anything is saved. Existing milestones keep their numbers; new rows are added after them.
          </Callout>
        )}
      </ProjectsGate>
    </div>
  )
}
