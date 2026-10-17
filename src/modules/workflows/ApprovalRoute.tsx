// Read-only views shared by record screens: the approval route of a multi-step request, and the
// "waiting for approval" note on a record that has a maker-checker change pending.
import { Link } from 'react-router-dom'
import type { RouteStep } from '@/mock/workflows'
import type { PendingBrief } from '@/api/changes'
import { fmtDate, relTime } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Check } from '@/ui/icons'
import { Button, Callout } from '@/ui'

export function ApprovalRoute({ route, dueOn, escalatesTo }: { route: RouteStep[]; dueOn?: string | null; escalatesTo?: string | null }) {
  return (
    <section>
      <div className="mb-1.5 text-[12px] font-medium text-ink-3">Approval route</div>
      <ol className="space-y-1.5">
        {route.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span
              className={cn(
                'tnum mt-px grid size-5 shrink-0 place-items-center rounded-full border text-[11px] font-medium',
                s.state === 'done' ? 'border-success bg-success-soft text-success-text' : s.state === 'current' ? 'border-brand bg-brand-soft text-brand-text' : 'border-line text-ink-3',
              )}
            >
              {s.state === 'done' ? <Check className="size-3" /> : i + 1}
            </span>
            <div className="min-w-0 flex-1 text-[13px]">
              <span className={cn('font-medium', s.state === 'next' || s.state === 'skipped' ? 'text-ink-3' : 'text-ink')}>{s.name}</span>
              <span className="text-ink-2"> · {s.state === 'done' ? `approved by ${s.decided_by_name}` : s.approver_name}</span>
              {s.state === 'current' && <span className="text-ink-3"> · waiting{dueOn ? `, due ${fmtDate(dueOn)}` : ''}</span>}
              {s.escalated_from_name && <span className="text-ink-3"> · escalated from {s.escalated_from_name}</span>}
            </div>
          </li>
        ))}
      </ol>
      {escalatesTo && <p className="mt-1.5 text-[12px] text-ink-3">Escalates to {escalatesTo} if not decided by the deadline.</p>}
    </section>
  )
}

/** "Bank details change waiting for approval" style note for a record with a pending change. */
export function PendingNote({ p, what, className }: { p: PendingBrief; what: string; className?: string }) {
  const who = p.checker_names.length ? (p.checker_names.length > 2 ? `${p.checker_names.slice(0, 2).join(', ')} or another checker` : p.checker_names.join(' or ')) : 'a checker'
  return (
    <Callout
      tone="warning"
      className={className}
      title={`${what} waiting for approval`}
      action={<Link to={`/changes?id=${p.id}`}><Button size="sm">{p.can_check ? 'Review' : 'Open'}</Button></Link>}
    >
      {p.mine ? 'You proposed it' : `${p.maker_name} proposed it`} {relTime(p.created_at)}. It takes effect once {p.can_check ? 'you or ' : ''}{who} approve{p.checker_names.length === 1 && !p.can_check ? 's' : ''} it.
    </Callout>
  )
}
