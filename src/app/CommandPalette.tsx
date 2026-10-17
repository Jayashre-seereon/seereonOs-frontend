import { useEffect, useState } from 'react'
import { Command } from 'cmdk'
import * as RD from '@radix-ui/react-dialog'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Briefcase, Calculator, CheckSquare, CornerDownLeft, FileText, Receipt, Search, Sparkles, Target, User, Workflow } from '@/ui/icons'
import { useUI } from '@/stores/ui'
import { http } from '@/api/http'
import { useApi } from '@/api/query'
import { filterNav, flattenNav, NAV } from './nav'
import { useCan } from '@/ui'

type Hit = { kind: string; id: string; title: string; subtitle: string; to: string }
const ICON: Record<string, typeof Briefcase> = { Project: Briefcase, Task: CheckSquare, Deal: Target, Person: User, Estimate: Calculator, Invoice: Receipt, Document: FileText, Template: FileText, Workflow }

export default function CommandPalette() {
  const { command, setCommand, openTask, openAI } = useUI()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const nav = useNavigate()
  const c = useCan()
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 180)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    if (!command) setQ('')
  }, [command])
  const hits = useApi(['search', debounced], () => http.get<Hit[]>('/search', { q: debounced }), { enabled: command && debounced.length >= 2 })
  const pages = flattenNav(filterNav(NAV, c))
  const go = (to: string) => {
    setCommand(false)
    if (to.startsWith('task:')) openTask(to.slice(5))
    else nav(to)
  }
  const item = 'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-[14px] data-[selected=true]:bg-surface-2'
  return (
    <RD.Root open={command} onOpenChange={setCommand}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-[rgba(8,12,10,.4)] backdrop-blur-[2px] animate-[fade_.15s_ease]" />
        <RD.Content className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top,0px))] z-50 mx-auto max-w-[640px] overflow-hidden rounded-lg border border-line bg-elevated shadow-lg outline-none animate-[fade_.15s_ease] md:top-[12vh]">
          <RD.Title className="sr-only">Search</RD.Title>
          <RD.Description className="sr-only">Search pages, projects, tasks, deals, people, invoices, estimates, documents and workflows, or ask AI.</RD.Description>
          <Command shouldFilter={false} loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Search className="size-[18px] text-ink-3" />
              <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Search or ask a question…" className="h-14 flex-1 bg-transparent text-[16px] outline-none placeholder:text-ink-3" />
              <kbd className="hidden rounded border border-line px-1.5 text-[11px] text-ink-3 md:inline">Esc</kbd>
            </div>
            <Command.List className="max-h-[min(60vh,460px)] overflow-y-auto p-2 scroll-thin">
              {q.trim().length > 2 && c('ai.use') && (
                <Command.Group heading="Seereon AI" className="cmdk-group">
                  <Command.Item value="ai" onSelect={() => { setCommand(false); openAI(q) }} className={item}>
                    <span className="grid size-7 place-items-center rounded-md bg-brand text-brand-ink"><Sparkles className="size-4" /></span>
                    <span className="min-w-0 flex-1 truncate">Ask AI: <span className="font-semibold">{q}</span></span>
                    <CornerDownLeft className="size-4 text-ink-3" />
                  </Command.Item>
                </Command.Group>
              )}
              {(hits.data ?? []).length > 0 && (
                <Command.Group heading="Results" className="cmdk-group">
                  {hits.data!.map((h) => {
                    const I = ICON[h.kind] ?? Search
                    return (
                      <Command.Item key={h.kind + h.id} value={h.kind + h.id} onSelect={() => go(h.to)} className={item}>
                        <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-ink-2"><I className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{h.title}</span>
                          <span className="block truncate text-[12px] text-ink-3">{h.kind} · {h.subtitle}</span>
                        </span>
                      </Command.Item>
                    )
                  })}
                </Command.Group>
              )}
              <Command.Group heading="Go to" className="cmdk-group">
                {pages
                  .filter((p) => {
                    if (!q) return true
                    const hay = `${p.label} ${p.group ?? ''} ${p.keywords ?? ''}`.toLowerCase()
                    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))
                  })
                  .map((p) => (
                    <Command.Item key={p.to} value={'nav' + p.to} onSelect={() => go(p.to)} className={item}>
                      <span className="grid size-7 place-items-center rounded-md bg-surface-2 text-ink-2"><p.icon className="size-4" /></span>
                      <span className="min-w-0 flex-1 truncate">
                        {p.label}
                        {p.group && <span className="text-ink-3"> · {p.group}</span>}
                      </span>
                      <ArrowRight className="size-4 text-ink-3" />
                    </Command.Item>
                  ))}
              </Command.Group>
            </Command.List>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}
