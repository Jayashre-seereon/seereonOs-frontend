// /projects/new — "Create project" from the sidebar: the projects list with the create dialog open.
// Closing the dialog returns to /projects; creating a project opens it (the dialog navigates there).
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ProjectsPage from '@/modules/projects/ProjectsPage'
import { ProjectFormDialog } from '@/modules/projects/components/ProjectFormDialog'
import { useReadOnly } from '@/ui'

export default function NewProjectPage() {
  const readOnly = useReadOnly()
  const [open, setOpen] = useState(!readOnly)
  const nav = useNavigate()
  const loc = useLocation()
  useEffect(() => {
    if (!open && loc.pathname === '/projects/new') nav('/projects', { replace: true })
  }, [open, loc.pathname, nav])
  return (
    <>
      <ProjectsPage />
      <ProjectFormDialog open={open} onOpenChange={setOpen} />
    </>
  )
}
