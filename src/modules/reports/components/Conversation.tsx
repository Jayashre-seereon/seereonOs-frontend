// The AI conversation used by /ai (studio) and the global assistant sheet. Each answer shows a
// narrative plus the generated report card: chart/table toggle, Open in builder, Save, Export,
// "How this was computed" (the spec as chips) and a source badge (AI / Rules).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowUp, BarChart3, Bot, ChevronDown, Copy, Info, Loader2, PencilRuler, RefreshCw, Save, Sparkles, Square, Table2, User as UserIcon, Wand2 } from '@/ui/icons'
import { askAssistant, llmAvailable } from '@/reports/ai'
import { ExportMenu } from '@/reports/ExportMenu'
import type { AiAnswer } from '@/api/reports'
import { useAiContext } from '@/api/reports'
import { useScopeKey } from '@/api/query'
import { useSession } from '@/stores/session'
import { Badge, Button, IconButton, Segmented, Tooltip, toast, useCan } from '@/ui'
import { cn } from '@/lib/utils'
import { ReportChart, ReportTable, SpecChips, toExportTable } from './ReportVisual'
import { SaveReportDialog } from './SaveReportDialog'
import { mid, useChat, type ChatMessage } from './chatStore'
import { copyText } from '@/modules/admin/kit'

export const AI_NOTE = 'Figures are computed from your data; AI only decides what to compute.'

export function SourceBadge({ source }: { source?: 'llm' | 'rules' }) {
  if (!source) return null
  return (
    <Tooltip content={source === 'llm' ? 'Claude chose what to compute; the report engine computed every figure.' : 'The built-in rules planner chose what to compute; the report engine computed every figure.'}>
      <span>
        <Badge tone="neutral" size="sm">
          {source === 'llm' ? 'AI' : 'Rules'}
        </Badge>
      </span>
    </Tooltip>
  )
}

/** Markdown-lite rendering for assistant text: paragraphs, bullets, **bold**. */
function RichText({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/)
  const inline = (s: string, k: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={k + i} className="font-semibold text-ink">{part.slice(2, -2)}</strong> : <span key={k + i}>{part.replace(/^#+\s*/, '')}</span>))
  return (
    <div className="space-y-2 text-[14px] leading-relaxed text-ink-2">
      {blocks.map((b, i) => {
        const lines = b.split('\n')
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 marker:text-ink-3">
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''), `${i}-${j}-`)}</li>
              ))}
            </ul>
          )
        return <p key={i}>{inline(b, `${i}-`)}</p>
      })}
    </div>
  )
}

export function AnswerCard({ answer, compact }: { answer: AiAnswer; compact?: boolean }) {
  const nav = useNavigate()
  const c = useCan()
  const res = answer.result
  const hasChart = res.spec.chart !== 'table' && res.columns.some((x) => x.role === 'measure')
  const [view, setView] = useState<'chart' | 'table'>(hasChart ? 'chart' : 'table')
  const [how, setHow] = useState(false)
  const [saving, setSaving] = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)
  const isKpi = res.spec.chart === 'kpi' || (!res.columns.some((x) => x.role === 'dimension') && res.columns.some((x) => x.role === 'measure'))
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink">{res.spec.title}</div>
          <div className="text-[12px] text-ink-3">
            {res.periodLabel} · {res.rowCount} {res.rowCount === 1 ? 'row' : 'rows'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasChart && !isKpi && (
            <Segmented
              size="sm"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> },
                { value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> },
              ]}
            />
          )}
          <ExportMenu iconOnly variant="ghost" table={() => toExportTable(res, { chartEl: chartRef.current, notes: [AI_NOTE] })} />
        </div>
      </div>
      <div className={cn(compact ? 'p-3' : 'p-4')}>
        {view === 'chart' && hasChart ? <ReportChart res={res} height={compact ? 220 : 260} chartRef={chartRef} compact={compact} /> : isKpi && res.columns.some((x) => x.role === 'measure') ? <ReportChart res={res} compact={compact} chartRef={chartRef} /> : null}
        {(view === 'table' || !hasChart) && !isKpi && (
          <div className="-mx-3 -mb-3 md:-mx-4 md:-mb-4">
            <ReportTable res={res} maxRows={compact ? 8 : 15} dense />
          </div>
        )}
        {res.warnings.length > 0 && (
          <ul className="mt-3 space-y-1 text-[12px] text-warning-text">
            {res.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
        <Button size="xs" variant="ghost" icon={<Info className="size-3.5" />} onClick={() => setHow((h) => !h)} aria-expanded={how}>
          How this was computed
          <ChevronDown className={cn('size-3.5 transition', how && 'rotate-180')} />
        </Button>
        <span className="flex-1" />
        {c('reports.build') && (
          <>
            <Button size="xs" variant="ghost" icon={<PencilRuler className="size-3.5" />} onClick={() => nav('/reports/new', { state: { spec: res.spec } })}>
              Open in builder
            </Button>
            <Button size="xs" variant="ghost" icon={<Save className="size-3.5" />} onClick={() => setSaving(true)}>
              Save report
            </Button>
          </>
        )}
      </div>
      {how && (
        <div className="space-y-2 border-t border-line px-4 py-3">
          <SpecChips spec={res.spec} />
          {answer.explanation && <p className="text-[12.5px] text-ink-3">{answer.explanation}</p>}
          <p className="text-[12px] text-ink-3">{AI_NOTE}</p>
        </div>
      )}
      <SaveReportDialog open={saving} onOpenChange={setSaving} spec={res.spec} source="ai" />
    </div>
  )
}

function MessageView({ m, compact, onRetry }: { m: ChatMessage; compact?: boolean; onRetry?: () => void }) {
  if (m.role === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] break-words rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-[14px] leading-snug text-ink">{m.content}</div>
      </div>
    )
  return (
    <div className="flex">
      <div className="min-w-0 flex-1 space-y-2.5">
        {m.status === 'pending' && !m.content ? (
          <div className="flex items-center gap-2 py-1.5 text-[13.5px] text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            {m.statusText ?? 'Thinking…'}
          </div>
        ) : m.status === 'error' ? (
          <div className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13.5px] text-ink">
            {m.content}
            {onRetry && (
              <Button size="xs" className="ml-2" icon={<RefreshCw className="size-3" />} onClick={onRetry}>
                Try again
              </Button>
            )}
          </div>
        ) : (
          <RichText text={m.content} />
        )}
        {m.status === 'pending' && m.content && (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <Loader2 className="size-3 animate-spin" />
            {m.statusText ?? 'Writing…'}
          </div>
        )}
        {m.status === 'stopped' && <div className="text-[12px] text-ink-3">Stopped.</div>}
        {m.answer && <AnswerCard answer={m.answer} compact={compact} />}
        {m.status === 'done' && (
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
            <SourceBadge source={m.source} />
            {m.note && <span>{m.note}</span>}
            <button
              className="inline-flex items-center gap-1 rounded px-1 hover:text-ink"
              onClick={() => {
                void copyText(m.content).then((ok) => (ok ? toast.success('Answer copied') : toast.error('Couldn’t copy', { description: 'Your browser blocked the clipboard. Select the text and copy it instead.' })))
              }}
            >
              <Copy className="size-3" /> Copy
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// one in-flight request per session, shared by every view of the conversation
const ctl: { current: AbortController | null } = { current: null }

/** Hook that owns sending/stopping for the shared conversation. */
export function useConversation() {
  const scopeKey = useScopeKey().join(':')
  const { messages, busy, push, patch, setBusy, setScope, clear } = useChat()
  useEffect(() => setScope(scopeKey), [scopeKey, setScope])
  const send = useCallback(
    async (text: string) => {
      const q = text.trim()
      if (!q || useChat.getState().busy) return
      if (q.length > 600) return toast.error('Question too long', { description: 'Keep it under 600 characters.' })
      const history = useChat.getState().messages.filter((m) => m.status !== 'error' && m.status !== 'pending').map((m) => ({ role: m.role, content: m.role === 'assistant' && m.answer ? `${m.content}\n[report: ${m.answer.result.spec.title}]` : m.content }))
      push({ id: mid(), role: 'user', content: q, at: Date.now() })
      const aid = mid()
      push({ id: aid, role: 'assistant', content: '', status: 'pending', statusText: 'Thinking…', at: Date.now() })
      setBusy(true)
      ctl.current = new AbortController()
      try {
        const r = await askAssistant([...history, { role: 'user', content: q }], {
          signal: ctl.current.signal,
          scope: scopeKey,
          onText: (t) => patch(aid, { content: t }),
          onStatus: (s) => patch(aid, { statusText: s }),
        })
        patch(aid, { content: r.text || 'Here is what the data shows.', status: 'done', source: r.source, answer: r.answer, tools: r.tools, note: r.note })
      } catch (e) {
        const code = (e as { code?: string })?.code
        if (code === 'cancelled') patch(aid, { status: 'stopped' })
        else patch(aid, { status: 'error', content: (e as { message?: string })?.message ?? 'The answer couldn’t be produced. Try rephrasing the question.' })
      } finally {
        setBusy(false)
        ctl.current = null
      }
    },
    [push, patch, setBusy, scopeKey],
  )
  const stop = () => ctl.current?.abort()
  return { messages, busy, send, stop, clear }
}

export function Composer({ onSend, busy, onStop, autoFocus, placeholder = 'Ask about revenue, projects, people, pipeline…', className, value, onChange }: { onSend: (q: string) => void; busy: boolean; onStop: () => void; autoFocus?: boolean; placeholder?: string; className?: string; value?: string; onChange?: (v: string) => void }) {
  const [local, setLocal] = useState('')
  const text = value ?? local
  const set = onChange ?? setLocal
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    // Focus without scrolling the page, and only where a hardware keyboard is likely (desktop):
    // on phones autofocus pops the keyboard and scrolls the page under the top bar.
    if (!autoFocus) return
    if (typeof window !== 'undefined' && window.matchMedia?.('(min-width: 1024px)').matches) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(160, el.scrollHeight) + 'px'
  }, [text])
  const submit = () => {
    if (!text.trim() || busy) return
    onSend(text)
    set('')
  }
  return (
    <div className={cn('flex items-end gap-2 rounded-lg border border-line-strong bg-surface p-1.5 focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15', className)}>
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={600}
        onChange={(e) => set(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        placeholder={placeholder}
        aria-label="Ask Seereon AI"
        className="min-h-[40px] min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[15px] leading-snug text-ink outline-none placeholder:text-ink-3 md:text-[14.5px]"
      />
      {busy ? (
        <IconButton label="Stop" variant="secondary" onClick={onStop} className="size-10 rounded-lg">
          <Square className="size-4 fill-current" />
        </IconButton>
      ) : (
        <IconButton label="Ask" variant="primary" onClick={submit} disabled={!text.trim()} className="size-10 rounded-lg">
          <ArrowUp className="size-[18px]" />
        </IconButton>
      )}
    </div>
  )
}

export function useLlmStatus() {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void llmAvailable().then((v) => live && setOn(v))
    return () => {
      live = false
    }
  }, [])
  return on
}

export function EngineBadge() {
  const on = useLlmStatus()
  return (
    <Tooltip content={on ? 'Claude plans reports and writes answers; the report engine computes every figure.' : 'The built-in rules planner turns questions into reports; the report engine computes every figure.'}>
      <span className="inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-sm border border-line bg-surface px-2 text-[12px] text-ink-3">
        {on === null ? 'Connecting…' : on ? 'Claude + report engine' : 'Rules + report engine'}
      </span>
    </Tooltip>
  )
}

/** Message list + empty state with suggestions. */
export function ConversationView({ compact, onPick, emptyExtra }: { compact?: boolean; onPick?: (q: string) => void; emptyExtra?: ReactNode }) {
  const { messages, busy, send } = useConversation()
  const ctx = useAiContext()
  const endRef = useRef<HTMLDivElement>(null)
  const { user } = useSession()
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, messages[messages.length - 1]?.content, messages[messages.length - 1]?.status])
  const retry = (i: number) => {
    const q = [...messages.slice(0, i)].reverse().find((m) => m.role === 'user')
    if (q) void send(q.content)
  }
  if (!messages.length)
    return (
      <div className={cn('flex flex-col', compact ? 'py-4' : 'py-4 md:py-10')}>
        <h2 className={cn('font-semibold text-ink', compact ? 'text-[16px]' : 'text-[16px] md:text-[18px]')}>What do you want to know{user ? `, ${user.name.split(' ')[0]}` : ''}?</h2>
        <p className="mt-1 max-w-[60ch] text-[13.5px] text-ink-3">Ask in plain English. Seereon AI turns it into a report on your live data — every figure is computed by the report engine, never by the AI.</p>
        <div className="mt-4 text-[12.5px] font-medium text-ink-3">Suggested questions</div>
        <div className={cn('mt-2 grid w-full gap-2', compact ? 'grid-cols-1' : 'sm:grid-cols-2')}>
          {(ctx.data?.suggestions ?? []).slice(0, compact ? 5 : 8).map((s) => (
            <button key={s} onClick={() => (onPick ? onPick(s) : void send(s))} disabled={busy} className="flex min-h-10 items-center justify-between gap-2 rounded-md border border-line bg-surface px-3.5 py-2.5 text-left text-[13.5px] text-ink-2 transition hover:border-line-strong hover:bg-surface-2 hover:text-ink">
              <span className="min-w-0 flex-1">{s}</span>
              <ArrowUp className="size-3.5 shrink-0 rotate-45 text-ink-3" />
            </button>
          ))}
        </div>
        {emptyExtra}
      </div>
    )
  return (
    <div className="space-y-5">
      {messages.map((m, i) => (
        <MessageView key={m.id} m={m} compact={compact} onRetry={m.status === 'error' ? () => retry(i) : undefined} />
      ))}
      <div ref={endRef} />
    </div>
  )
}

export { Bot, UserIcon }
