import { useState } from 'react'
import { useApi, useMut } from '@/api/query'
import { workApi } from '@/api/work'
import { Button, ErrorState, FilterChips, PageHeader, SkeletonRows } from '@/ui'
import type { Notification } from '@/types/entities'
import { parseISO, todayISO, addDays } from '@/domain/calendar'
import { EmptyInbox, NotificationItem, useOpenLink } from './notificationParts'

function bucket(iso: string) {
  const d = iso.slice(0, 10)
  const local = new Date(iso)
  const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`
  const t = todayISO()
  if (day === t) return 'Today'
  if (day === addDays(t, -1)) return 'Yesterday'
  if (day >= addDays(t, -6)) return 'Earlier this week'
  return parseISO(d).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}

/** UI-14 full page. */
export default function NotificationsPage() {
  const [filter, setFilter] = useState<'all' | 'unread'>('all')
  const [limit, setLimit] = useState(50)
  const q = useApi(['notifications', 'page', filter, limit], () => workApi.notifications({ limit, filter }))
  const openLink = useOpenLink()
  const inv = [['notifications']]
  const readOne = useMut((id: string) => workApi.readNotification(id), { invalidate: inv, silentError: true })
  const readAll = useMut(() => workApi.readAll(), { invalidate: inv, success: 'All notifications marked read' })
  const onOpen = (n: Notification) => {
    if (!n.read_at) readOne.mutate(n.id)
    openLink(n.link)
  }
  const items = q.data?.items ?? []
  const groups: [string, Notification[]][] = []
  for (const n of items) {
    const b = bucket(n.created_at)
    const g = groups.find((x) => x[0] === b)
    if (g) g[1].push(n)
    else groups.push([b, [n]])
  }
  return (
    <div className="mx-auto w-full max-w-[880px]">
      <PageHeader
        title="Notifications"
        subtitle="Mentions, timesheet decisions, unlock requests and reminders."
        actions={
          <Button size="sm" variant="secondary" disabled={!q.data?.unread} loading={readAll.isPending} onClick={() => readAll.mutate(undefined)}>
            Mark all read
          </Button>
        }
      />
      <FilterChips
        className="mb-4"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'unread', label: 'Unread', count: q.data?.unread },
        ]}
      />
      {q.isLoading ? (
        <SkeletonRows rows={7} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !items.length ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyInbox unreadOnly={filter === 'unread'} />
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([label, list]) => (
            <section key={label}>
              <h2 className="mb-2 px-1 text-[13px] font-semibold text-ink-2">{label}</h2>
              <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                {list.map((n) => (
                  <NotificationItem key={n.id} n={n} onOpen={onOpen} />
                ))}
              </div>
            </section>
          ))}
          {q.data && q.data.total > items.length && (
            <div className="flex justify-center">
              <Button size="sm" onClick={() => setLimit((l) => l + 50)}>
                Show older ({q.data.total - items.length})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
