// Client view (Feature Guide §15, screenshot 030): a clean, money-free status report per project — date,
// % complete, forecast vs planned end, milestones, completed in the last two weeks, coming in the next two,
// and decisions needed from the client. The report body and PDF export are shared with /client-view.
import { useParams } from 'react-router-dom'
import { CheckCircle2, CircleDot, Download, Printer } from '@/ui/icons'
import { projectsApi, type ClientView } from '@/api/projects'
import { useApi } from '@/api/query'
import { useSession } from '@/stores/session'
import { exportTable } from '@/reports/export'
import { fmtDate } from '@/domain/calendar'
import { fmtPct } from '@/domain/money'
import { PROJECT_STATUS } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, ErrorState, PageHeader, Progress, Skeleton, TenantMark, toast } from '@/ui'

/** Download the client report as a PDF (money-free). */
export async function exportClientReport(c: ClientView) {
  const r = await exportTable(
      {
        title: `Status report — ${c.project.name}`,
        category: 'Client status report',
        subtitle: `${c.project.client} · ${fmtDate(c.generated_on, 'long')}`,
        kpis: [
          { label: 'Complete', value: fmtPct(c.progress, 0) },
          { label: 'Planned end', value: fmtDate(c.project.end_on) },
          { label: 'Forecast end', value: fmtDate(c.forecast_end) },
        ],
        columns: [
          { key: 'ms', label: 'Milestone', type: 'string' },
          { key: 'target', label: 'Target date', type: 'date' },
          { key: 'status', label: 'Status', type: 'string' },
          { key: 'progress', label: 'Progress', type: 'percent' },
        ],
        rows: c.milestones.map((m) => ({ ms: `M${m.no} ${m.name}`, target: m.target, status: m.note ? `${m.status}. ${m.note}` : m.status, progress: m.status === 'Achieved' ? 1 : m.progress })),
        notes: [
          ...(c.completed.length ? [`Completed in the last two weeks: ${c.completed.map((x) => x.title).join('; ')}.`] : []),
          ...(c.upcoming.length ? [`Coming up in the next two weeks: ${c.upcoming.map((x) => x.title).join('; ')}.`] : []),
          ...(c.inputs.length ? [`Needed from you: ${c.inputs.join('; ')}.`] : []),
        ],
        orientation: 'portrait',
      },
      'pdf',
      `${c.project.code}-status-${c.generated_on}`,
    )
  if (r === 'saved') toast.success('Report downloaded')
  else if (r === 'failed') toast.error('Couldn’t export the report. Try again.')
}

export default function ClientViewPage() {
  const { id = '' } = useParams()
  const q = useApi(['project', id, 'client-view'], () => projectsApi.clientView(id))
  if (q.isLoading)
    return (
      <div className="mx-auto max-w-[860px]">
        <Skeleton className="h-8 w-60" />
        <Skeleton className="mt-6 h-[480px] w-full rounded-lg" />
      </div>
    )
  if (q.error || !q.data)
    return (
      <div className="mx-auto max-w-[860px]">
        <PageHeader title="Client view" back={{ to: `/projects/${id}`, label: 'Project' }} />
        <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
      </div>
    )
  const c = q.data
  return (
    <div className="mx-auto max-w-[860px]">
      <div className="print:hidden">
        <PageHeader
          title="Client view"
          subtitle="A clean status report for the client: milestones, progress, what’s done and what’s next. No people scores, no costs."
          back={{ to: `/projects/${id}`, label: c.project.name }}
          actions={
            <>
              <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>Print</Button>
              <Button variant="primary" icon={<Download className="size-4" />} onClick={() => exportClientReport(c)}>Download report for the client</Button>
            </>
          }
        />
      </div>
      <ClientReport c={c} />
    </div>
  )
}

/** The report itself (no money, no people scores). */
export function ClientReport({ c }: { c: ClientView }) {
  const { tenant } = useSession()
  const done = c.progress >= 0.999
  return (
      <article className="overflow-hidden rounded-lg border border-line bg-surface print:border-0 print:shadow-none">
        <header className="border-b border-line px-5 pb-5 pt-6 md:px-10 md:pt-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <span className="flex min-w-0 items-center gap-2.5">
              <TenantMark name={c.company} logo={tenant?.logo_data_url} size={32} />
              <span className="min-w-0 text-[14px] font-semibold leading-snug">{c.company}</span>
            </span>
            <span className="tnum shrink-0 whitespace-nowrap text-[12.5px] text-ink-3 sm:text-right">
              Status report · {fmtDate(c.generated_on, 'long')}
            </span>
          </div>
          <h1 className="mt-6 text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-[26px]">{c.project.name}</h1>
          <p className="mt-1 text-[14px] text-ink-3">
            Prepared for {c.project.client} · <span className="tnum">{c.project.code}</span>
          </p>
          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="tnum text-[24px] font-semibold tracking-[-0.01em] text-ink">{fmtPct(c.progress, 0)}<span className="ml-1.5 text-[14px] font-normal text-ink-3">complete</span></span>
              {!['active', 'initiated'].includes(c.project.status) && <Badge tone={PROJECT_STATUS[c.project.status].tone}>{PROJECT_STATUS[c.project.status].label}</Badge>}
            </div>
            <Progress value={c.progress} height={6} className="mt-2" />
            <p className="mt-2.5 text-[14px] text-ink-2">
              {done
                ? 'All planned work is complete.'
                : c.late_days > 0
                  ? <>Forecast completion <strong>{fmtDate(c.forecast_end, 'long')}</strong>, {c.late_days} working day{c.late_days === 1 ? '' : 's'} after the planned {fmtDate(c.project.end_on, 'long')}.</>
                  : <>On track to complete by <strong>{fmtDate(c.project.end_on, 'long')}</strong>.</>}
            </p>
          </div>
        </header>
        {c.project.description && <p className="border-b border-line px-5 py-4 text-[14px] leading-relaxed text-ink-2 md:px-10">{c.project.description}</p>}
        <section className="px-5 py-6 md:px-10">
          <h2 className="mb-3 text-[14px] font-semibold text-ink">Milestones</h2>
          {!c.milestones.length ? (
            <p className="text-[14px] text-ink-3">Milestones will be shared once the plan is agreed.</p>
          ) : (
            <table className="w-full table-fixed text-[13.5px]">
              <colgroup>
                <col />
                <col className="w-[76px] sm:w-[112px]" />
                <col className="w-0 sm:w-[96px]" />
                <col className="w-[30%] sm:w-[30%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-line text-left text-[12.5px] text-ink-3">
                  <th className="pb-2 pr-2 font-medium">Milestone</th>
                  <th className="pb-2 pr-3 text-right font-medium">Target date</th>
                  <th className="hidden pb-2 pr-3 text-right font-medium sm:table-cell">Progress</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {c.milestones.map((m) => (
                  <tr key={m.no} className="border-b border-line align-top last:border-0">
                    <td className="py-2.5 pr-2">
                      <div className="break-words font-medium">{m.name}</div>
                      <div className="tnum text-[12.5px] text-ink-3 sm:hidden">Progress {fmtPct(m.status === 'Achieved' ? 1 : m.progress, 0)}</div>
                      {m.status !== 'Achieved' && m.progress > 0 && <Progress value={m.progress} height={4} className="mt-1.5 max-w-[200px]" />}
                    </td>
                    <td className="tnum whitespace-nowrap py-2.5 pr-3 text-right">{fmtDate(m.target)}</td>
                    <td className="tnum hidden whitespace-nowrap py-2.5 pr-3 text-right font-medium sm:table-cell">{fmtPct(m.status === 'Achieved' ? 1 : m.progress, 0)}</td>
                    <td className="py-2.5">
                      <span className={cn('inline-flex items-start gap-1.5', m.tone === 'danger' ? 'text-danger-text' : m.tone === 'warning' ? 'text-warning-text' : m.status === 'Achieved' ? 'text-success-text' : 'text-ink-2')}>
                        {m.status === 'Achieved' ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <CircleDot className="mt-0.5 size-3.5 shrink-0" />}
                        <span className="min-w-0 break-words">
                          {m.status}
                          {m.note ? <span className="text-ink-3">, {m.note.charAt(0).toLowerCase() + m.note.slice(1)}</span> : null}
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <div className="grid gap-0 border-t border-line md:grid-cols-2">
          <section className="px-5 py-6 md:border-r md:border-line md:px-10">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">Completed in the last two weeks</h2>
            {!c.completed.length ? <p className="text-[14px] text-ink-3">Work in progress; nothing closed in this window.</p> : (
              <ul className="space-y-2">
                {c.completed.map((t) => (
                  <li key={t.wbs} className="flex items-start gap-2 text-[14px]">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                    <span className="min-w-0 flex-1">{t.title}</span>
                    <span className="tnum shrink-0 text-[12.5px] text-ink-3">{fmtDate(t.done_on)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="border-t border-line px-5 py-6 md:border-t-0 md:px-10">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">Coming up in the next two weeks</h2>
            {!c.upcoming.length ? <p className="text-[14px] text-ink-3">No deliverables due in this window.</p> : (
              <ul className="space-y-2">
                {c.upcoming.map((t) => (
                  <li key={t.wbs} className="flex items-start gap-2 text-[14px]">
                    <CircleDot className="mt-0.5 size-4 shrink-0 text-ink-3" />
                    <span className="min-w-0 flex-1">{t.title}</span>
                    <span className="tnum shrink-0 text-[12.5px] text-ink-3">{fmtDate(t.due_on)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {c.inputs.length > 0 && (
          <section className="border-t border-line bg-surface-2/60 px-5 py-6 md:px-10">
            <h2 className="mb-3 text-[14px] font-semibold text-ink">Decisions and inputs needed from you</h2>
            <ul className="list-disc space-y-1.5 pl-5 text-[14px] text-ink">
              {c.inputs.map((x, i) => <li key={i}>{x}</li>)}
            </ul>
          </section>
        )}
        <footer className="border-t border-line px-5 py-4 text-[12px] text-ink-3 md:px-10">
          {c.company} · Dates follow our working calendar. Forecasts update as work is logged.
        </footer>
      </article>
  )
}
