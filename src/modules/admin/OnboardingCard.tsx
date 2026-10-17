// Getting-started checklist (UI-25). Default export is embeddable on Home (Module E):
// renders nothing for non-admins, while loading, when complete, or when dismissed.
import { Link } from 'react-router-dom'
import { CheckCircle2, ChevronRight, X } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, useOnboarding, type OnboardingState } from '@/api/admin'
import { useSetupStatus } from '@/api/access'
import { Button, Progress, useCan, useConfirm, useReadOnly } from '@/ui'
import { cn } from '@/lib/utils'

export function OnboardingChecklist({ data, compact }: { data: OnboardingState; compact?: boolean }) {
  const next = data.steps.find((s) => !s.done)
  return (
    <ol className="divide-y divide-line">
      {data.steps.map((s, i) => (
        <li key={s.key}>
          <Link to={s.to} className={cn('group flex items-center gap-3 px-4 transition hover:bg-surface-2 md:px-5', compact ? 'py-2.5' : 'py-3.5')}>
            <span className={cn('tnum grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-medium', s.done ? 'text-success-text' : s === next ? 'border border-brand text-brand-text' : 'border border-line-strong text-ink-3')}>
              {s.done ? <CheckCircle2 className="size-5" /> : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block text-[14px] font-medium', s.done && 'text-ink-3')}>{s.title}</span>
              {!compact && <span className="block text-[12.5px] text-ink-3">{s.body}</span>}
            </span>
            {s === next && <span className="hidden text-[12.5px] font-medium text-brand-text sm:inline">Start</span>}
            <ChevronRight className="size-4 shrink-0 text-ink-3" />
          </Link>
        </li>
      ))}
    </ol>
  )
}

/** Organisation setup progress for people who run setup (master data → roles → employees). */
function SetupCard() {
  const q = useSetupStatus()
  const c = useCan()
  const d = q.data
  if (!d || d.complete) return null
  const next = d.steps.find((s) => !s.done && s.links.some((l) => c(l.action)))
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Set up your organisation</h2>
          <p className="text-[12.5px] text-ink-3">
            {d.done} of {d.total} done{next ? ` · next: ${next.title.toLowerCase()}` : ''}
          </p>
          <Progress value={d.done / d.total} className="mt-2 max-w-[260px]" />
        </div>
      </div>
      <ol className="divide-y divide-line border-t border-line">
        {d.steps.filter((s) => !s.done).slice(0, 3).map((s) => {
          const to = s.links.find((l) => c(l.action))?.to ?? '/setup'
          return (
            <li key={s.key}>
              <Link to={to} className="group flex items-center gap-3 px-4 py-2.5 transition hover:bg-surface-2 md:px-5">
                <span className={cn('grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-medium', s === next ? 'border border-brand text-brand-text' : 'border border-line-strong text-ink-3')}>
                  {d.steps.indexOf(s) + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{s.title}</span>
                <ChevronRight className="size-4 shrink-0 text-ink-3" />
              </Link>
            </li>
          )
        })}
      </ol>
      <div className="border-t border-line px-4 py-2.5 md:px-5">
        <Link to="/setup" className="text-[13px] font-medium text-brand-text hover:underline">
          Open setup checklist
        </Link>
      </div>
    </section>
  )
}

export default function OnboardingCard() {
  const c = useCan()
  if (c('master.view') && c('roles.view')) return <SetupCard />
  return <LegacyOnboardingCard />
}

function LegacyOnboardingCard() {
  const c = useCan()
  const isAdmin = c('settings.edit')
  const readOnly = useReadOnly()
  const q = useOnboarding(isAdmin)
  const { confirm } = useConfirm()
  const dismiss = useMut(() => adminApi.dismissOnboarding(), { invalidate: [['onboarding']], success: 'Checklist hidden. Find it again under Get started.' })
  const sample = useMut(() => adminApi.loadSample(), { invalidate: [['onboarding'], ['directory'], ['projects'], ['holidays'], ['users']], success: 'Sample data loaded' })
  if (!isAdmin || !q.data || q.data.complete || q.data.dismissed) return null
  const d = q.data
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-start gap-3 px-4 pb-3 pt-4 md:px-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Get your workspace ready</h2>
          <p className="text-[12.5px] text-ink-3">
            {d.done} of {d.total} done
          </p>
          <Progress value={d.done / d.total} className="mt-2 max-w-[260px]" />
        </div>
        {!readOnly && (
          <button type="button" aria-label="Dismiss checklist" onClick={() => dismiss.mutate(undefined)} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="border-t border-line">
        <OnboardingChecklist data={d} compact />
      </div>
      {d.can_load_sample && !readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 md:px-5">
          <span className="text-[12.5px] text-ink-3">Want to look around first?</span>
          <Button
            size="sm"
            variant="secondary"
            loading={sample.isPending}
            onClick={async () => (await confirm({ title: 'Load sample data?', body: 'Adds four sample people, a project with milestones and tasks, and this year’s holidays — only in your workspace. You can delete them later.', confirmLabel: 'Load sample data' })) && sample.mutate(undefined)}
          >
            Load sample data
          </Button>
        </div>
      )}
    </section>
  )
}
