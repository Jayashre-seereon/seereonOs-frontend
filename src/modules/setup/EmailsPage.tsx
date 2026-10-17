import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { keepPreviousData } from '@tanstack/react-query'
import { useApi, useMut } from '@/api/query'
import { masterApi, useEmailTemplates, useOutbox, type OutboxMessage, type TemplateView } from '@/api/master'
import { fmtDateTime, relTime } from '@/domain/calendar'
import { Badge, Button, Callout, Card, CardHeader, DataTable, EmptyState, ErrorState, Field, FilterChips, Input, ListGroup, ListRow, PageHeader, SearchInput, Sheet, SkeletonRows, Switch, Tabs, Textarea, useConfirm, useReadOnly } from '@/ui'
import { AlertTriangle, ChevronLeft, Mail, MailCheck, RotateCcw } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { errOf } from './master/kit'

const PH_LABEL: Record<string, string> = {
  employee_name: 'Employee name', company: 'Company', username: 'Username', temp_password: 'Temporary password', login_url: 'Login link', role_name: 'Role', manager_name: 'Manager',
  joining_date: 'Joining date', employee_code: 'Employee code', designation: 'Designation', department: 'Department', decision: 'Decision', from_date: 'From date', to_date: 'To date', reason: 'Reason',
  amount: 'Amount', description: 'Description', approver_name: 'Approver', task_title: 'Task title', due_date: 'Due date', month: 'Month', net_pay: 'Net pay', cycle_name: 'Cycle', rating: 'Rating',
}

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export default function EmailsPage() {
  const [sp, setSp] = useSearchParams()
  const tab = sp.get('tab') === 'sent' ? 'sent' : 'templates'
  const setParams = (p: Record<string, string | null>) => {
    const n = new URLSearchParams(sp)
    for (const [k, v] of Object.entries(p)) (v === null ? n.delete(k) : n.set(k, v))
    setSp(n, { replace: true })
  }
  return (
    <div>
      <PageHeader title="Emails" subtitle="Templates the system uses (welcome, password reset, decisions) and a log of every email it sent." />
      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v === 'sent' ? 'sent' : null, template: null, message: null })}
        tabs={[
          { value: 'templates', label: 'Templates' },
          { value: 'sent', label: 'Sent' },
        ]}
      />
      {tab === 'templates' ? <Templates selected={sp.get('template')} onSelect={(id) => setParams({ template: id })} /> : <Sent openId={sp.get('message')} onOpen={(id) => setParams({ message: id })} />}
    </div>
  )
}

/* ---------------- Templates ---------------- */
function Templates({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const q = useEmailTemplates()
  if (q.isLoading) return <SkeletonRows rows={5} />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const t = selected ? q.data.find((x) => x.id === selected) : null
  if (t) return <TemplateEditor key={`${t.id}:${t.version}`} t={t} onBack={() => onSelect(null)} />
  if (!q.data.length) return <Card pad={false}><EmptyState icon={<Mail />} title="No templates" body="System templates are created with the workspace. Reload the page if this persists." /></Card>
  return (
    <ListGroup>
      {q.data.map((x) => (
        <ListRow
          key={x.id}
          onClick={() => onSelect(x.id)}
          chevron
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{x.name}</span>
              {!x.active && <Badge size="sm">Off</Badge>}
            </span>
          }
          subtitle={x.subject}
          trailing={<span className="hidden text-[12.5px] text-ink-3 sm:inline">Edited {relTime(x.updated_at)}</span>}
        />
      ))}
    </ListGroup>
  )
}

function TemplateEditor({ t, onBack }: { t: TemplateView; onBack: () => void }) {
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const [subject, setSubject] = useState(t.subject)
  const [body, setBody] = useState(t.body)
  const [active, setActive] = useState(t.active)
  const last = useRef<'subject' | 'body'>('body')
  const subjRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const dirty = subject !== t.subject || body !== t.body || active !== t.active
  const ds = useDebounced(subject)
  const db = useDebounced(body)
  const pv = useApi(['emails', 'preview', t.id, ds, db], () => masterApi.preview(t.id, { subject: ds, body: db }), { placeholderData: keepPreviousData, staleTime: 60_000 })
  const save = useMut(() => masterApi.saveTemplate(t.id, { subject, body, active }, t.version), { invalidate: [['emails']], success: 'Template saved' })
  const reset = useMut(() => masterApi.resetTemplate(t.id, t.version), { invalidate: [['emails']], success: 'Default template restored' })
  const e = save.error
  const required = new Set(t.required_placeholders)

  const insert = (ph: string) => {
    const token = `{{${ph}}}`
    if (last.current === 'subject' && subjRef.current) {
      const el = subjRef.current
      const s = el.selectionStart ?? subject.length
      const en = el.selectionEnd ?? s
      setSubject(subject.slice(0, s) + token + subject.slice(en))
      if (save.error) save.reset()
      requestAnimationFrame(() => (el.focus(), el.setSelectionRange(s + token.length, s + token.length)))
    } else if (bodyRef.current) {
      const el = bodyRef.current
      const s = el.selectionStart ?? body.length
      const en = el.selectionEnd ?? s
      setBody(body.slice(0, s) + token + body.slice(en))
      if (save.error) save.reset()
      requestAnimationFrame(() => (el.focus(), el.setSelectionRange(s + token.length, s + token.length)))
    }
  }

  return (
    <div className="pb-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="-ml-1 mb-1 inline-flex items-center gap-0.5 text-[13px] font-medium text-ink-3 hover:text-ink">
            <ChevronLeft className="size-3.5" />
            All templates
          </button>
          <h2 className="truncate text-[17px] font-semibold text-ink">{t.name}</h2>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            {t.is_system && (
              <Button
                size="sm"
                icon={<RotateCcw className="size-3.5" />}
                loading={reset.isPending}
                onClick={async () => (await confirm({ title: 'Restore the default template?', body: 'Your edits to the subject and body are replaced with the built-in text.', confirmLabel: 'Restore default' })) && reset.mutate(undefined)}
              >
                Restore default
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save template
            </Button>
          </div>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader title="Edit" subtitle="Click a placeholder to insert it where the cursor is." />
          <div className="space-y-4">
            <Field label="Subject" htmlFor="tpl-subject" required error={errOf(e, 'subject')}>
              <Input id="tpl-subject" ref={subjRef} value={subject} onFocus={() => (last.current = 'subject')} onChange={(x) => (setSubject(x.target.value), save.error && save.reset())} disabled={readOnly} invalid={!!errOf(e, 'subject')} />
            </Field>
            <Field label="Body" htmlFor="tpl-body" required error={errOf(e, 'body')}>
              <Textarea id="tpl-body" ref={bodyRef} rows={14} value={body} onFocus={() => (last.current = 'body')} onChange={(x) => (setBody(x.target.value), save.error && save.reset())} disabled={readOnly} invalid={!!errOf(e, 'body')} className="min-h-[280px] text-[13.5px]" />
            </Field>
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink-2">Placeholders</div>
              <div className="flex flex-wrap gap-1.5">
                {t.placeholders.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={readOnly}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => insert(p)}
                    title={`Insert {{${p}}}`}
                    className={cn('inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-[12px] font-medium transition disabled:opacity-50', required.has(p) ? 'border-brand/40 bg-brand-soft text-brand-text hover:border-brand' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink')}
                  >
                    {PH_LABEL[p] ?? p}
                  </button>
                ))}
              </div>
              {required.size > 0 && <p className="mt-1.5 text-[12px] text-ink-3">Highlighted ones are required — this email carries the login details.</p>}
            </div>
            {t.required_placeholders.length === 0 && (
              <Switch checked={active} onChange={setActive} disabled={readOnly} label="Send this email" description="When off, the system skips this email." />
            )}
          </div>
        </Card>
        <Card className="min-w-0 lg:sticky lg:top-[76px] lg:self-start">
          <CardHeader title="Preview" subtitle="With sample values." action={pv.isFetching ? <span className="text-[12px] text-ink-3">Updating…</span> : undefined} />
          {pv.error ? (
            <ErrorState error={pv.error} onRetry={() => pv.refetch()} />
          ) : !pv.data ? (
            <SkeletonRows rows={4} />
          ) : (
            <div className="space-y-3">
              {pv.data.unknown.length > 0 && (
                <Callout tone="danger" icon={<AlertTriangle />}>
                  {pv.data.unknown.map((u) => `{{${u}}}`).join(', ')} {pv.data.unknown.length === 1 ? 'is not a known placeholder' : 'are not known placeholders'}. Use the chips instead.
                </Callout>
              )}
              {pv.data.missing.length > 0 && (
                <Callout tone="warning" icon={<AlertTriangle />}>
                  Add {pv.data.missing.map((u) => PH_LABEL[u] ?? u).join(', ')} back — new joiners need {pv.data.missing.length === 1 ? 'it' : 'them'} to sign in.
                </Callout>
              )}
              <EmailView to={pv.data.to} subject={pv.data.subject} body={pv.data.body} />
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function EmailView({ to, subject, body, meta }: { to: string; subject: string; body: string; meta?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-line">
      <div className="space-y-1 border-b border-line bg-surface-2/60 px-4 py-3 text-[13px]">
        <div className="flex min-w-0 gap-2">
          <span className="w-14 shrink-0 text-ink-3">To</span>
          <span className="min-w-0 break-words text-ink">{to}</span>
        </div>
        <div className="flex min-w-0 gap-2">
          <span className="w-14 shrink-0 text-ink-3">Subject</span>
          <span className="min-w-0 break-words font-medium text-ink">{subject}</span>
        </div>
        {meta && (
          <div className="flex min-w-0 gap-2">
            <span className="w-14 shrink-0 text-ink-3">Sent</span>
            <span className="min-w-0 text-ink-2">{meta}</span>
          </div>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words px-4 py-4 text-[14px] leading-relaxed text-ink">{body}</div>
    </div>
  )
}

/* ---------------- Sent ---------------- */
function Sent({ openId, onOpen }: { openId: string | null; onOpen: (id: string | null) => void }) {
  const templates = useEmailTemplates()
  const [key, setKey] = useState('')
  const [search, setSearch] = useState('')
  const ds = useDebounced(search, 250)
  const q = useOutbox({ template_key: key || undefined, search: ds.trim() || undefined })
  const nameOf = useMemo(() => new Map((templates.data ?? []).map((t) => [t.key as string, t.name])), [templates.data])
  const chips = [{ value: '', label: 'All' }, ...(templates.data ?? []).map((t) => ({ value: t.key as string, label: t.name.replace(' & login details', '') }))]
  return (
    <div>
      <div className="mb-3 flex flex-col gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search recipient or subject" className="md:w-[320px]" />
        <FilterChips value={key} onChange={setKey} options={chips} />
      </div>
      <DataTable<OutboxMessage>
        rows={q.data}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        rowKey={(m) => m.id}
        onRowClick={(m) => onOpen(m.id)}
        columns={[
          {
            key: 'to',
            header: 'To',
            sortValue: (m) => m.to_name ?? m.to,
            cell: (m) => (
              <div className="min-w-0 max-w-[260px]">
                <div className="truncate font-medium text-ink">{m.to_name ?? m.to}</div>
                {m.to_name && <div className="truncate text-[12.5px] text-ink-3">{m.to}</div>}
              </div>
            ),
          },
          { key: 'subject', header: 'Subject', cell: (m) => <span className="line-clamp-2 min-w-[180px] text-ink-2">{m.subject}</span> },
          { key: 'tpl', header: 'Template', hideBelow: 'lg', cell: (m) => <Badge size="sm">{nameOf.get(m.template_key) ?? m.template_key}</Badge> },
          { key: 'at', header: 'Sent', align: 'right', sortValue: (m) => m.sent_at, cell: (m) => <span className="tnum whitespace-nowrap text-[13px] text-ink-2">{fmtDateTime(m.sent_at)}</span> },
        ]}
        initialSort={{ key: 'at', dir: 'desc' }}
        mobileCard={(m) => (
          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[14px] font-medium">{m.to_name ?? m.to}</span>
              <span className="tnum shrink-0 text-[12px] text-ink-3">{relTime(m.sent_at)}</span>
            </div>
            <div className="mt-0.5 line-clamp-2 text-[13px] text-ink-2">{m.subject}</div>
            <div className="mt-1.5">
              <Badge size="sm">{nameOf.get(m.template_key) ?? m.template_key}</Badge>
            </div>
          </div>
        )}
        empty={<EmptyState icon={<MailCheck />} title={key || ds ? 'No emails match' : 'Nothing sent yet'} body={key || ds ? 'Try another filter or search.' : 'When you create an employee or reset a password, the email appears here with exactly what was sent.'} />}
      />
      {openId && <MessageSheet id={openId} nameOf={nameOf} onClose={() => onOpen(null)} />}
    </div>
  )
}

function MessageSheet({ id, nameOf, onClose }: { id: string; nameOf: Map<string, string>; onClose: () => void }) {
  const q = useApi(['emails', 'message', id], () => masterApi.message(id))
  const m = q.data
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={m?.subject ?? 'Email'} subtitle={m ? `${nameOf.get(m.template_key) ?? m.template_key} · ${relTime(m.sent_at)}` : undefined} width={640}>
      {q.isLoading ? (
        <SkeletonRows rows={5} />
      ) : q.error || !m ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4">
          {m.status !== 'sent' && <Callout tone="danger">This email could not be delivered.</Callout>}
          <EmailView to={m.to_name ? `${m.to_name} <${m.to}>` : m.to} subject={m.subject} body={m.body} meta={fmtDateTime(m.sent_at)} />
          <p className="text-[12.5px] text-ink-3">This is a copy of the email as rendered when it was sent. Later template edits don’t change it.</p>
        </div>
      )}
    </Sheet>
  )
}
