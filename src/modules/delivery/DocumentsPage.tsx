// /delivery/documents — a project's document library (SOW, contracts, specs) from the sidebar; same panel as the project's Documents tab.
import { PageHeader } from '@/ui'
import ProjectDocumentsPanel from '@/modules/documents/ProjectDocumentsPanel'
import { ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, WithProject } from './shared'

export default function DeliveryDocumentsPage() {
  const { q, items } = useDeliveryProjects()
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Project documents" subtitle="Statements of work, contracts, specifications and sign-offs, kept with the project they belong to." />
      <ProjectsGate q={q} items={items}>
        <ProjectPickerCard projects={items} id={id} onChange={choose} tab="documents" />
        <WithProject id={id}>{(d) => <ProjectDocumentsPanel projectId={d.project.id} />}</WithProject>
      </ProjectsGate>
    </div>
  )
}
