import { AtSign, Bell, CalendarClock, CheckCircle2, CircleDollarSign, ClipboardCheck, Download, KeyRound, LockOpen, Mail, Send, Timer, TrendingDown, Undo2, UserPlus, Wrench, Trash2, CreditCard } from '@/ui/icons'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Notification, NotificationType } from '@/types/entities'
import type { Tone } from '@/domain/labels'
import { relTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { useUI } from '@/stores/ui'

export const NTF_META: Record<NotificationType, { icon: ReactNode; tone: Tone; label: string }> = {
  'NTF-01': { icon: <KeyRound />, tone: 'neutral', label: 'Password reset' },
  'NTF-02': { icon: <UserPlus />, tone: 'brand', label: 'Invitation' },
  'NTF-03': { icon: <AtSign />, tone: 'info', label: 'Mention' },
  'NTF-04': { icon: <Send />, tone: 'warning', label: 'Timesheet submitted' },
  'NTF-05': { icon: <CheckCircle2 />, tone: 'success', label: 'Timesheet approved' },
  'NTF-06': { icon: <Undo2 />, tone: 'danger', label: 'Timesheet sent back' },
  'NTF-07': { icon: <KeyRound />, tone: 'warning', label: 'Unlock requested' },
  'NTF-08': { icon: <LockOpen />, tone: 'success', label: 'Timesheet unlocked' },
  'NTF-09': { icon: <CalendarClock />, tone: 'info', label: 'Reminder' },
  'NTF-10': { icon: <Timer />, tone: 'danger', label: 'Approvals overdue' },
  'NTF-11': { icon: <CreditCard />, tone: 'warning', label: 'Trial ending' },
  'NTF-12': { icon: <TrendingDown />, tone: 'warning', label: 'Deal stale' },
  'NTF-13': { icon: <Wrench />, tone: 'warning', label: 'Ops item due' },
  'NTF-14': { icon: <ClipboardCheck />, tone: 'brand', label: 'Task assigned' },
  'NTF-15': { icon: <Trash2 />, tone: 'neutral', label: 'Milestone removed' },
  'NTF-16': { icon: <CircleDollarSign />, tone: 'danger', label: 'Payment failed' },
  'NTF-17': { icon: <Download />, tone: 'success', label: 'Export ready' },
}
/** Plain 16px glyph, no tile — the title carries the meaning. */
export function NotificationIcon({ type, size = 20 }: { type: NotificationType; size?: number }) {
  const m = NTF_META[type] ?? { icon: <Bell />, tone: 'neutral' as Tone }
  return (
    <span style={{ width: size, height: size }} className="grid shrink-0 place-items-center text-ink-3 [&>svg]:size-4" aria-hidden>
      {m.icon}
    </span>
  )
}

/** Navigate for a notification link; /tasks/:id opens the global task drawer. */
export function useOpenLink() {
  const navigate = useNavigate()
  const openTask = useUI((s) => s.openTask)
  return (link: string | null) => {
    if (!link) return
    const m = link.match(/^\/tasks\/([^/?#]+)/)
    if (m) openTask(m[1])
    else navigate(link)
  }
}

export function NotificationItem({ n, onOpen, compact }: { n: Notification; onOpen: (n: Notification) => void; compact?: boolean }) {
  const unread = !n.read_at
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cn('group relative flex w-full items-start gap-3 text-left transition', compact ? 'rounded-md px-2.5 py-2.5 hover:bg-surface-2' : 'px-4 py-3 hover:bg-surface-2/70')}
    >
      <span className="pt-px"><NotificationIcon type={n.type} /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn('min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-semibold text-ink' : 'text-ink-2')}>{n.title}</span>
          <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-3">{relTime(n.created_at)}</span>
        </span>
        <span className={cn('mt-0.5 block text-[12.5px] leading-snug text-ink-3', compact && 'line-clamp-2')}>{n.body}</span>
      </span>
      <span className={cn('mt-[7px] size-1.5 shrink-0 rounded-full', unread ? 'bg-brand' : 'bg-transparent')} aria-label={unread ? 'Unread' : undefined} />
    </button>
  )
}

export const EmptyInbox = ({ unreadOnly }: { unreadOnly?: boolean }) => (
  <div className="flex flex-col items-center px-6 py-10 text-center">
    <Mail className="mb-3 size-5 text-ink-3" />
    <p className="text-[14px] font-semibold text-ink">{unreadOnly ? 'You’re all caught up' : 'No notifications yet'}</p>
    <p className="mt-1 max-w-[30ch] text-[12.5px] text-ink-3">{unreadOnly ? 'New mentions, approvals and reminders will show up here.' : 'Mentions, timesheet decisions and reminders land here.'}</p>
  </div>
)
