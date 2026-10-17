// /ai — "Ask Seereon AI" studio. Desktop: conversation in the centre, suggestions + saved AI
// reports on the right. Phone: full-screen chat with the composer pinned above the tab bar.
import { useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BookmarkCheck, FileBarChart, Lightbulb, RotateCcw, ShieldCheck, Sparkles } from '@/ui/icons'
import { useAiContext, useSavedReports } from '@/api/reports'
import { useEffectiveRole } from '@/stores/session'
import { Button, Card, CardHeader, EmptyState, ErrorState, PageHeader, SkeletonRows, useCan } from '@/ui'
import { cn } from '@/lib/utils'
import { relTime } from '@/domain/calendar'
import { AI_NOTE, Composer, ConversationView, EngineBadge, useConversation } from './components/Conversation'

const MORE: Record<string, string[]> = {
  admin: ['Net profit by month this FY', 'Outstanding invoices by client', 'Projects at risk', 'Hours by person last month', 'Deals won this FY by month', 'Revenue this month vs last month', 'Who is over-allocated?', 'Tasks completed last month by project'],
  pm: ['Projects at risk', 'Tasks completed last month by project', 'Hours by project this month', 'Tasks due this week', 'Effort ratio by person'],
  sales: ['Average deal size by product', 'Deals lost this FY by reason', 'Weighted pipeline by owner', 'Sales activities by type last 30 days'],
  ops: ['Overdue compliance items', 'Timesheets waiting for approval', 'Costs by category last 6 months', 'Headcount by role'],
  employee: ['My hours on leave this FY', 'My tasks completed last month', 'My hours by day this week'],
}

export default function AIStudioPage() {
  const role = useEffectiveRole() ?? 'employee'
  const ctx = useAiContext()
  const c = useCan()
  const nav = useNavigate()
  const { busy, send, stop, clear, messages } = useConversation()
  const saved = useSavedReports()
  const aiSaved = useMemo(() => (saved.data ?? []).filter((r) => r.source === 'ai').slice(0, 6), [saved.data])
  const suggestions = useMemo(() => [...(ctx.data?.suggestions ?? []), ...(MORE[role] ?? [])].filter((v, i, a) => a.indexOf(v) === i), [ctx.data, role])
  const enabled = ctx.data?.enabled !== false

  if (ctx.isLoading) return <SkeletonRows rows={6} />
  if (ctx.error) return <ErrorState error={ctx.error} onRetry={() => ctx.refetch()} />
  if (!enabled)
    return (
      <div className="mx-auto max-w-[720px]">
        <PageHeader title="Ask Seereon AI" />
        <Card>
          <EmptyState icon={<Sparkles />} title="AI is turned off for this workspace" body="An admin can turn it on in Settings → Company. Reports and Insights work without it." action={c('settings.edit') ? <Button variant="primary" onClick={() => nav('/settings/company')}>Open company settings</Button> : c('reports.view') ? <Button onClick={() => nav('/reports')}>Go to reports</Button> : undefined} />
        </Card>
      </div>
    )

  return (
    <div className="lg:grid lg:grid-cols-12 lg:gap-6">
      {/* conversation */}
      <section className="flex min-h-[calc(100dvh-210px)] flex-col lg:col-span-8 lg:min-h-[calc(100dvh-150px)] xl:col-span-9">
        <div className="mb-3 flex items-start gap-2 md:mb-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink md:text-[22px]">Ask Seereon AI</h1>
            <p className="mt-1 hidden text-[13.5px] text-ink-3 md:block">Reports and analysis from plain English. {AI_NOTE}</p>
          </div>
          <span className="hidden sm:inline-flex"><EngineBadge /></span>
          {messages.length > 0 && (
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={clear} disabled={busy}>
              <span className="hidden sm:inline">New chat</span>
            </Button>
          )}
        </div>
        <div className="flex-1 pb-28 lg:pb-4">
          <ConversationView />
        </div>
        {/* composer: pinned above the tab bar on phones, sticky at the bottom on desktop */}
        <div className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 border-t border-line bg-bg px-4 py-2.5 lg:sticky lg:bottom-0 lg:border-0 lg:px-0 lg:py-3">
          <Composer onSend={(q) => void send(q)} busy={busy} onStop={stop} autoFocus className="mx-auto max-w-[900px]" />
          <p className="mx-auto mt-1.5 hidden max-w-[900px] px-1 text-[11.5px] text-ink-3 lg:block">Enter to ask · Shift+Enter for a new line · Answers use only data your role can see.</p>
        </div>
      </section>

      {/* side panel (desktop) */}
      <aside className="hidden space-y-4 lg:col-span-4 lg:block xl:col-span-3">
        <Card>
          <CardHeader title="Try asking" />
          <ul className="-mx-2 space-y-0.5">
            {suggestions.slice(0, 12).map((s) => (
              <li key={s}>
                <button onClick={() => void send(s)} disabled={busy} className={cn('w-full rounded-md px-2 py-1.5 text-left text-[13px] text-ink-2 transition hover:bg-surface-2 hover:text-ink disabled:opacity-50')}>
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Saved AI reports" action={c('reports.view') ? <Link to="/reports" className="whitespace-nowrap text-[12.5px] font-medium text-brand-text hover:underline">All reports</Link> : undefined} />
          {saved.isLoading ? (
            <SkeletonRows rows={3} />
          ) : aiSaved.length === 0 ? (
            <p className="text-[13px] text-ink-3">Answers you save appear here. Use “Save report” on any answer.</p>
          ) : (
            <ul className="-mx-2 space-y-0.5">
              {aiSaved.map((r) => (
                <li key={r.id}>
                  <Link to={`/reports/${r.id}`} className="flex items-center gap-2.5 rounded-md px-2 py-2 transition hover:bg-surface-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{r.name}</span>
                      <span className="block truncate text-[12px] text-ink-3">{r.dataset_label} · {relTime(r.updated_at)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <div>
            <div className="text-[12.5px] leading-relaxed text-ink-2">
              <div className="mb-1 text-[14px] font-semibold text-ink">How answers stay right</div>
              The AI only decides <em>what</em> to compute — a report definition you can inspect under “How this was computed”. The report engine computes every rupee and hour from your live data, with the same permissions as the rest of SeereonOS.
            </div>
          </div>
        </Card>
      </aside>
    </div>
  )
}

export { EmptyState }
