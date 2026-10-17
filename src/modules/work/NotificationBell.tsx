import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { workApi } from '@/api/work'
import { Button, IconButton, Popover, Skeleton } from '@/ui'
import type { Notification } from '@/types/entities'
import { EmptyInbox, NotificationItem, useOpenLink } from './notificationParts'

/** UI-14 — header bell with unread badge (polled every 30 s) and a popover inbox. */
export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const q = useApi(['notifications', 'bell'], () => workApi.notifications({ limit: 20 }), { refetchInterval: 30_000, retry: false, staleTime: 10_000 })
  const openLink = useOpenLink()
  const inv = [['notifications']]
  const readOne = useMut((id: string) => workApi.readNotification(id), { invalidate: inv, silentError: true })
  const readAll = useMut(() => workApi.readAll(), { invalidate: inv, success: (r) => (r.updated ? 'All caught up' : null) })
  const unread = q.data?.unread ?? 0

  const onOpen = (n: Notification) => {
    if (!n.read_at) readOne.mutate(n.id)
    setOpen(false)
    openLink(n.link)
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[min(380px,calc(100vw-24px))] p-0"
      trigger={
        <IconButton label={unread ? `Notifications, ${unread} unread` : 'Notifications'} className="relative">
          <Bell className="size-[19px]" />
          {unread > 0 && (
            <span className="tnum absolute right-1 top-1 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-danger px-1 text-[10.5px] font-semibold leading-none text-white ring-2 ring-surface">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </IconButton>
      }
    >
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">Notifications</div>
          <div className="text-[12px] text-ink-3">{unread ? `${unread} unread` : 'Nothing new'}</div>
        </div>
        <Button size="xs" variant="ghost" disabled={!unread} loading={readAll.isPending} onClick={() => readAll.mutate(undefined)}>
          Mark all read
        </Button>
      </div>
      <div className="max-h-[min(460px,65dvh)] overflow-y-auto p-1.5 scroll-thin">
        {q.isLoading ? (
          <div className="space-y-3 p-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-4 rounded-sm" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/3" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : q.error ? (
          <div className="px-4 py-8 text-center text-[13px] text-ink-3">
            Couldn’t load notifications.{' '}
            <button className="font-semibold text-brand-text hover:underline" onClick={() => q.refetch()}>
              Try again
            </button>
          </div>
        ) : !q.data?.items.length ? (
          <EmptyInbox />
        ) : (
          q.data.items.map((n) => <NotificationItem key={n.id} n={n} onOpen={onOpen} compact />)
        )}
      </div>
      <div className="border-t border-line p-1.5">
        <Link to="/notifications" onClick={() => setOpen(false)} className="flex h-9 items-center justify-center rounded-md text-[13px] font-medium text-brand-text hover:bg-surface-2">
          See all notifications
        </Link>
      </div>
    </Popover>
  )
}
