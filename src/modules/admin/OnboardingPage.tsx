import { Link, useNavigate } from 'react-router-dom'
import { EyeOff } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, useOnboarding } from '@/api/admin'
import { useSession } from '@/stores/session'
import { fmtDate } from '@/domain/calendar'
import { Button, Callout, ErrorState, PageHeader, Progress, SkeletonRows, useConfirm, useReadOnly } from '@/ui'
import { OnboardingChecklist } from './OnboardingCard'

export default function OnboardingPage() {
  const q = useOnboarding()
  const { user, tenant } = useSession()
  const readOnly = useReadOnly()
  const nav = useNavigate()
  const { confirm } = useConfirm()
  const sample = useMut(() => adminApi.loadSample(), { invalidate: [['onboarding'], ['directory'], ['projects'], ['holidays'], ['users']], success: 'Sample data loaded — explore Projects and People' })
  const dismiss = useMut(() => adminApi.dismissOnboarding(), { invalidate: [['onboarding']], success: 'Checklist hidden from Home', onSuccess: () => nav('/home') })
  const restore = useMut(() => adminApi.restoreOnboarding(), { invalidate: [['onboarding']], success: 'Checklist is back on Home' })

  return (
    <div className="max-w-[800px]">
      <PageHeader title={`Welcome${user ? `, ${user.name.split(' ')[0]}` : ''}`} subtitle="Five steps get your team logging time against real projects. Most companies finish in about ten minutes." />
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <section className="overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center gap-4 px-4 py-4 md:px-5">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">{q.data.complete ? 'All set — your workspace is ready' : `${q.data.done} of ${q.data.total} steps done`}</div>
                <Progress value={q.data.done / q.data.total} className="mt-2 max-w-[360px]" tone={q.data.complete ? 'success' : 'brand'} />
              </div>
            </div>
            <div className="border-t border-line">
              <OnboardingChecklist data={q.data} />
            </div>
          </section>

          {q.data.can_load_sample && (
            <section className="mt-5 flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 sm:flex-row sm:items-center md:p-5">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold">Explore with sample data</div>
                <p className="text-[12.5px] text-ink-3">Adds four sample people, a project with three milestones and six tasks, and this year’s holidays. Only in your workspace.</p>
              </div>
              <Button
                variant="secondary"
                loading={sample.isPending}
                disabled={readOnly}
                onClick={async () => (await confirm({ title: 'Load sample data?', body: 'Sample records are marked “(sample)” and can be removed later.', confirmLabel: 'Load sample data' })) && sample.mutate(undefined)}
              >
                Load sample data
              </Button>
            </section>
          )}

          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            {q.data.dismissed ? (
              <Button variant="ghost" loading={restore.isPending} disabled={readOnly} onClick={() => restore.mutate(undefined)}>
                Show checklist on Home again
              </Button>
            ) : (
              <Button variant="ghost" icon={<EyeOff className="size-4" />} loading={dismiss.isPending} disabled={readOnly} onClick={() => dismiss.mutate(undefined)}>
                Dismiss checklist
              </Button>
            )}
            <Link to="/home" className="text-center text-[13.5px] font-medium text-brand-text hover:underline">
              Go to Home
            </Link>
          </div>
          {tenant?.status === 'trial' && (
            <Callout tone="brand" className="mt-6" action={<Link to="/billing" className="text-[13px] font-medium text-brand-text hover:underline">Plans</Link>}>
              You’re on a free trial until {fmtDate(tenant.trial_ends_on, 'long')}. Everything is unlocked.
            </Callout>
          )}
        </>
      )}
    </div>
  )
}
