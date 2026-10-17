// /tasks/new — the full-page Create task form (same shared form as every other entry point).
// Query params prefill it: ?project=&milestone=&owner=&parent=&after=1 (follow-up: depends on the parent).
import { useCallback, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, PageHeader } from '@/ui'
import { TaskForm, type TaskFormPrefill } from './TaskForm'

export default function CreateTaskPage() {
  const [sp] = useSearchParams()
  const nav = useNavigate()
  const [wbs, setWbs] = useState('')
  const onHeading = useCallback((w: string) => setWbs(w), [])
  const parent = sp.get('parent')
  const prefill: TaskFormPrefill = {
    project_id: sp.get('project'),
    milestone_id: sp.get('milestone'),
    owner_id: sp.get('owner'),
    parent_task_id: parent,
    depends_on: parent && sp.get('after') === '1' ? [parent] : [],
  }
  const back = sp.get('back') || '/tasks'
  return (
    <div className="mx-auto max-w-[920px]">
      <PageHeader
        title={`Create task${wbs ? ` ${wbs}` : ''}`}
        subtitle="Owner, reviewer, concerned manager, dates, estimate, dependencies and definition of done. The assignee, reviewer, concerned manager and watchers are notified."
        back={{ to: back, label: back.startsWith('/my-tasks') ? 'My tasks' : back.startsWith('/team-tasks') ? 'Team tasks' : back.startsWith('/projects') ? 'Project' : 'Tasks' }}
      />
      <Card pad={false} className="p-4 sm:p-6">
        <TaskForm prefill={prefill} variant="page" heading={onHeading} onCancel={() => nav(back)} onCreated={(t, open, another) => (open ? nav(`/tasks/${t.id}`) : !another && nav(back))} />
      </Card>
    </div>
  )
}
