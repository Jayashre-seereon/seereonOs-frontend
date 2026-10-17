// /delivery/schedule — schedule & critical path of any project from the sidebar (same Schedule tab as the project page).
import { PageHeader } from '@/ui'
import { ScheduleTab } from '@/modules/projects/tabs/ScheduleTab'
import { ProjectPickerCard, ProjectsGate, useDeliveryProjects, useProjectChoice, WithProject } from './shared'

export default function DeliverySchedulePage() {
  const { q, items } = useDeliveryProjects()
  const { id, choose } = useProjectChoice(items)
  return (
    <div>
      <PageHeader title="Schedule & critical path" subtitle="Gantt, forecast dates, float and the critical path of a project, with the tasks that put a milestone at risk." />
      <ProjectsGate q={q} items={items}>
        <ProjectPickerCard projects={items} id={id} onChange={choose} tab="schedule" />
        <WithProject id={id}>{(d) => <ScheduleTab d={d} />}</WithProject>
      </ProjectsGate>
    </div>
  )
}
