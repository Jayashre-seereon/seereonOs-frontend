import { useState } from 'react'
import { Activity } from '@/ui/icons'
import { projectsApi, type ActivityItem, type ProjectDetail } from '@/api/projects'
import { useApi } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { fmtDate, fmtDateTime, relTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Avatar, Card, EmptyState, ErrorState, FilterChips, SkeletonRows } from '@/ui'

type F = 'all' | 'status' | 'tasks' | 'money' | 'plan'
const group = (a: ActivityItem): F => {
  if (a.kind === 'status') return 'status'
  if (a.action.startsWith('task') || a.action.startsWith('wbs') || a.action.startsWith('comment')) return 'tasks'
  if (a.action.startsWith('invoice') || a.action.startsWith('payment') || a.action.startsWith('cr.')) return 'money'
  return 'plan'
}
export function ActivityTab({ d }: { d: ProjectDetail }) {
  const q = useApi(['project', d.project.id, 'activity'], () => projectsApi.activity(d.project.id))
  const people = usePeopleMap()
  const [f, setF] = useState<F>('all')
  if (q.isLoading) return <Card><SkeletonRows rows={6} /></Card>
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
  const items = q.data.filter((a) => f === 'all' || group(a) === f)
  const count = (x: F) => (x === 'all' ? q.data.length : q.data.filter((a) => group(a) === x).length)
  // group by day
  const days: { day: string; items: ActivityItem[] }[] = []
  for (const a of items) {
    const day = a.at.slice(0, 10)
    if (days[days.length - 1]?.day !== day) days.push({ day, items: [] })
    days[days.length - 1].items.push(a)
  }
  return (
    <Card>
      <FilterChips
        className="mb-4"
        value={f}
        onChange={setF}
        options={[
          { value: 'all', label: 'Everything', count: count('all') },
          { value: 'status', label: 'Status history', count: count('status') },
          { value: 'tasks', label: 'Tasks', count: count('tasks') },
          { value: 'plan', label: 'Plan & team', count: count('plan') },
          { value: 'money', label: 'Money & changes', count: count('money') },
        ]}
      />
      {!items.length ? (
        <EmptyState compact icon={<Activity />} title="No activity here yet" />
      ) : (
        <div className="space-y-5">
          {days.map((g) => (
            <section key={g.day}>
              <h3 className="mb-2 text-[13px] font-semibold text-ink-2">{fmtDate(g.day, 'long')}</h3>
              <ol className="relative ml-3 border-l border-line">
                {g.items.map((a) => {
                  const u = people.get(a.actor_id)
                  return (
                    <li key={a.id} className="relative pb-4 pl-5 last:pb-0">
                      <span className={cn('absolute -left-[4.5px] top-[6px] size-2 rounded-full ring-4 ring-surface', a.kind === 'status' ? 'bg-brand' : 'bg-line-strong')} />
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className={cn('text-[13.5px] leading-snug text-ink', a.kind === 'status' && 'font-medium')}>{a.title}</p>
                          {a.detail && <p className="mt-1 border-l-2 border-line pl-2.5 text-[13px] text-ink-2">“{a.detail}”</p>}
                          <p className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-3">
                            {u && <Avatar name={u.name} hue={u.avatar_hue} size={16} />}
                            {u?.name ?? 'System'}
                          </p>
                        </div>
                        <time className="tnum shrink-0 text-[12px] text-ink-3" title={fmtDateTime(a.at)} dateTime={a.at}>
                          {relTime(a.at)}
                        </time>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </section>
          ))}
        </div>
      )}
    </Card>
  )
}
