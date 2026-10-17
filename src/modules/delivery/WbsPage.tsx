// /delivery/wbs — the WBS of any project from the sidebar: choose a project, get the same WBS tab as /projects/:id/wbs.
import { PageHeader } from '@/ui'
import { WbsTab } from '@/modules/projects/tabs/WbsTab'
import { ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, WithProject } from './shared'

export default function DeliveryWbsPage() {
  const { q, items } = useDeliveryProjects({ general: true })
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="WBS" subtitle="Work breakdown of a project: milestones, tasks, owners, estimates, dependencies and forecast dates." />
      <ProjectsGate q={q} items={items}>
        <ProjectPickerCard projects={items} id={id} onChange={choose} tab="wbs" />
        <WithProject id={id}>{(d) => <WbsTab d={d} />}</WithProject>
      </ProjectsGate>
    </div>
  )
}
