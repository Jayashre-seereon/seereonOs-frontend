// Setup checklist: the administrator's path from an empty workspace to people signing in.
import { Link } from 'react-router-dom'
import { Check, ChevronRight } from '@/ui/icons'
import { useSetupStatus, type SetupStep } from '@/api/access'
import { Badge, ErrorState, PageHeader, Progress, SkeletonRows, useCan } from '@/ui'
import { cn } from '@/lib/utils'

export default function SetupOverviewPage() {
  const q = useSetupStatus()
  const c = useCan()
  const d = q.data
  const next = d?.steps.find((s) => !s.done && s.links.some((l) => c(l.action)))
  return (
    <div>
      <PageHeader
        title="Setup checklist"
        subtitle="Fill in your organisation’s master data, review roles, then create employees. Each person gets a login and sees the screens their role allows."
      />
      <div className="mb-4 xl:hidden">
        <Link to="/setup?list=1" className="inline-flex items-center gap-1 text-[13.5px] font-medium text-brand-text hover:underline">
          All setup sections <ChevronRight className="size-3.5" />
        </Link>
      </div>
      {q.isLoading ? (
        <SkeletonRows rows={7} />
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <section className="overflow-hidden rounded-lg border border-line bg-surface">
          <div className="flex flex-col gap-2 border-b border-line px-4 py-4 sm:flex-row sm:items-center sm:gap-4 md:px-5">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">{d.complete ? `${d.company} is set up` : `${d.done} of ${d.total} steps done`}</div>
              <div className="text-[12.5px] text-ink-3">{d.complete ? 'Everything is in place. Revisit any step when something changes.' : next ? `Next: ${next.title}` : 'The remaining steps need someone with the right access.'}</div>
            </div>
            <Progress value={d.done / d.total} tone={d.complete ? 'success' : 'brand'} className="sm:max-w-[240px]" />
          </div>
          <ol className="divide-y divide-line">
            {d.steps.map((s, i) => (
              <StepRow key={s.key} step={s} n={i + 1} isNext={s === next} />
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

function StepRow({ step: s, n, isNext }: { step: SetupStep; n: number; isNext: boolean }) {
  const c = useCan()
  const links = s.links.filter((l) => c(l.action))
  return (
    <li className={cn('flex gap-3 px-4 py-4 md:gap-4 md:px-5', isNext && 'bg-brand-soft/40')}>
      <span
        className={cn(
          'tnum grid size-7 shrink-0 place-items-center rounded-full text-[12.5px] font-medium',
          s.done ? 'bg-success-soft text-success-text' : isNext ? 'border border-brand text-brand-text' : 'border border-line-strong text-ink-3',
        )}
        aria-label={s.done ? 'Done' : `Step ${n}`}
      >
        {s.done ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn('text-[14px] font-medium', s.done ? 'text-ink-2' : 'text-ink')}>{s.title}</span>
          {s.done ? <Badge tone="success" size="sm">Done</Badge> : isNext ? <Badge tone="brand" size="sm">Next</Badge> : null}
        </div>
        <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{s.body}</p>
        <p className="tnum mt-1 text-[12.5px] text-ink-2">{s.meta}</p>
        {links.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
            {links.map((l) => (
              <Link key={l.to} to={l.to} className="inline-flex min-h-[32px] items-center gap-0.5 text-[13px] font-medium text-brand-text hover:underline">
                {l.label}
                <ChevronRight className="size-3.5" />
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-1.5 text-[12.5px] text-ink-3">Needs someone with access to this area.</p>
        )}
      </div>
    </li>
  )
}
