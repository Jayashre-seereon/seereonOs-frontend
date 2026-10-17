// Feature Guide §7 — a task on its own page (/tasks/:id): deep-linkable from notifications, "Tagged you" and the Tasks tab.
// Same sections as the drawer, in the guide's order: Owner and backup · Estimate and dates · Status · Depends on · Thread.
import { useEffect } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { ChevronLeft } from '@/ui/icons'
import { useUI } from '@/stores/ui'
import { TaskHeader, TaskSections } from './TaskDrawerHost'

export default function TaskPage() {
  const { id = '' } = useParams()
  const loc = useLocation()
  const focus = new URLSearchParams(loc.search).get('focus')
  // a drawer left open from another screen would cover the page
  useEffect(() => useUI.getState().openTask(null), [id])
  useEffect(() => {
    if (focus !== 'thread') return
    let tries = 0
    const h = setInterval(() => {
      const el = document.getElementById('thread')
      if (el || ++tries > 30) {
        clearInterval(h)
        el?.scrollIntoView({ block: 'start' })
      }
    }, 100)
    return () => clearInterval(h)
  }, [focus, id])
  return (
    <div className="mx-auto max-w-[880px]">
      <Link to="/tasks" className="-ml-0.5 mb-2 inline-flex items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink">
        <ChevronLeft className="size-3.5" />
        Tasks
      </Link>
      <div className="mb-5">
        <TaskHeader id={id} page />
      </div>
      <div className="rounded-lg border border-line bg-surface p-4 sm:p-6">
        <TaskSections key={id} id={id} mode="page" />
      </div>
    </div>
  )
}
