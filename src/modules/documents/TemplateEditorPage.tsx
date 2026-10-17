// /documents/templates/:id — create or edit a letter template: details, a light rich-text editor (markup with a
// formatting toolbar), the placeholder picker, the company letterhead toggle and a live preview for a real employee.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Badge, Button, Callout, Card, CardHeader, ErrorState, Field, IconButton, Input, Menu, PageHeader, Select, SkeletonRows, Switch, Textarea, Tooltip, useConfirm, useReadOnly } from '@/ui'
import { ChevronRight, Copy, List, MoreHorizontal, Plus, Save, Send, Table2, Trash2, X } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { useSession } from '@/stores/session'
import type { ApiError } from '@/api/http'
import { DOCS7_KEYS, docsApi, useTemplate, type TemplateCategory, type TemplateInput, type TemplateRow } from '@/api/docs'
import { CATEGORY_LABEL, CATEGORY_PLACEHOLDERS, STANDARD_PLACEHOLDERS, catalogueFor, TEMPLATE_CATEGORIES, fillPlaceholders, knownPlaceholders, markupToHtml, placeholdersIn, sampleVars, type PlaceholderDef } from '@/mock/docMarkup'
import { fmtDate } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { IssueSheet, LetterView } from './docUi'
import type { Letterhead } from '@/api/docs'

const STARTER = `:::right
Ref: {{ref_no}}
Date: {{today}}
:::

**{{employee_name}}**
Employee code: {{employee_code}}

## Subject of the letter

Dear {{employee_first_name}},

Write the body of the letter here. Use the toolbar for headings, bold text, lists and tables, and insert placeholders from the list on the right.

Yours sincerely,

**{{signatory_name}}**
{{signatory_designation}}
For {{company}}`

const blank = (category: TemplateCategory): TemplateInput => ({ name: '', category, body: STARTER, description: '', letterhead: true, active: true, custom_placeholders: [] })

export default function TemplateEditorPage() {
  const { id = 'new' } = useParams()
  const isNew = id === 'new'
  const [params] = useSearchParams()
  const nav = useNavigate()
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const q = useTemplate(isNew ? null : id)
  const initialCat = (TEMPLATE_CATEGORIES.includes(params.get('category') as TemplateCategory) ? params.get('category') : 'other') as TemplateCategory
  const [f, setF] = useState<TemplateInput>(() => blank(initialCat))
  const [loadedVersion, setLoadedVersion] = useState<number | undefined>(undefined)
  const [dirty, setDirty] = useState(false)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [issueOpen, setIssueOpen] = useState(false)
  const [customName, setCustomName] = useState('')
  const [showOther, setShowOther] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const t = q.data
    if (!t || (dirty && loadedVersion === t.version)) return
    setF({ name: t.name, category: t.category, body: t.body, description: t.description ?? '', letterhead: t.letterhead, active: t.active, custom_placeholders: t.custom_placeholders ?? [] })
    setLoadedVersion(t.version)
    setDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data?.id, q.data?.version])

  const set = (p: Partial<TemplateInput>) => {
    setF((x) => ({ ...x, ...p }))
    setDirty(true)
    setErrs({})
  }
  const onErr = (e: ApiError) => {
    const field = (e as ApiError & { field?: string }).field
    setErrs({ [field ?? 'form']: e.message })
  }
  const create = useMut(() => docsApi.createTemplate(f), {
    invalidate: DOCS7_KEYS,
    silentError: true,
    onError: onErr,
    success: 'Template created',
    onSuccess: (t) => {
      setDirty(false)
      nav(`/documents/templates/${t.id}`, { replace: true })
    },
  })
  const save = useMut(() => docsApi.saveTemplate(id, f, loadedVersion), {
    invalidate: DOCS7_KEYS,
    silentError: true,
    onError: onErr,
    success: 'Template saved',
    onSuccess: (t) => {
      setLoadedVersion(t.version)
      setDirty(false)
    },
  })
  const dup = useMut(() => docsApi.duplicateTemplate(id), { invalidate: DOCS7_KEYS, success: 'Copy created — it is switched off until you turn it on', onSuccess: (t) => nav(`/documents/templates/${t.id}`) })
  const del = useMut(() => docsApi.deleteTemplate(id), { invalidate: DOCS7_KEYS, success: 'Template deleted', onSuccess: () => nav('/documents?tab=templates') })

  const known = useMemo(() => knownPlaceholders(f.category, f.custom_placeholders), [f.category, f.custom_placeholders])
  const used = useMemo(() => placeholdersIn(f.body), [f.body])
  const unknown = used.filter((p) => !known.has(p))
  const submit = () => {
    const e: Record<string, string> = {}
    if (f.name.trim().length < 3) e.name = 'Give the template a name of 3 to 80 characters.'
    if (f.body.trim().length < 20) e.body = 'Write the letter: the body needs at least a few sentences.'
    else if (unknown.length) e.body = `${unknown.map((u) => `{{${u}}}`).join(', ')} ${unknown.length === 1 ? 'isn’t a known placeholder' : 'aren’t known placeholders'}. Pick one from the list, or add it as a custom field.`
    setErrs(e)
    if (Object.keys(e).length) return
    if (isNew) create.mutate(undefined)
    else save.mutate(undefined)
  }

  /* ---- toolbar ---- */
  const edit = (fn: (text: string, s: number, e: number) => { text: string; s: number; e: number }) => {
    const el = ta.current
    if (!el) return
    const r = fn(f.body, el.selectionStart, el.selectionEnd)
    set({ body: r.text })
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(r.s, r.e)
    })
  }
  const wrap = (mark: string) => edit((t, s, e) => {
    const sel = t.slice(s, e) || 'text'
    return { text: t.slice(0, s) + mark + sel + mark + t.slice(e), s: s + mark.length, e: s + mark.length + sel.length }
  })
  const linePrefix = (prefix: string | ((i: number) => string)) => edit((t, s, e) => {
    const ls = t.lastIndexOf('\n', s - 1) + 1
    const le = t.indexOf('\n', e) === -1 ? t.length : t.indexOf('\n', e)
    const lines = t.slice(ls, le).split('\n').map((l, i) => (typeof prefix === 'string' ? prefix : prefix(i)) + l.replace(/^(#{1,3}\s+|[-*]\s+|\d+[.)]\s+)/, ''))
    const out = lines.join('\n')
    return { text: t.slice(0, ls) + out + t.slice(le), s: ls, e: ls + out.length }
  })
  const insert = (snippet: string) => edit((t, s, e) => ({ text: t.slice(0, s) + snippet + t.slice(e), s: s + snippet.length, e: s + snippet.length }))
  const align = (a: 'center' | 'right') => edit((t, s, e) => {
    const ls = t.lastIndexOf('\n', s - 1) + 1
    const le = t.indexOf('\n', e) === -1 ? t.length : t.indexOf('\n', e)
    const block = `:::${a}\n${t.slice(ls, le) || 'text'}\n:::`
    return { text: t.slice(0, ls) + block + t.slice(le), s: ls, e: ls + block.length }
  })
  const tools: { label: string; title: string; icon?: React.ReactNode; on: () => void }[] = [
    { label: 'H1', title: 'Heading 1', on: () => linePrefix('# ') },
    { label: 'H2', title: 'Heading 2', on: () => linePrefix('## ') },
    { label: 'H3', title: 'Heading 3', on: () => linePrefix('### ') },
    { label: 'B', title: 'Bold', on: () => wrap('**') },
    { label: 'I', title: 'Italic', on: () => wrap('*') },
    { label: '', title: 'Bulleted list', icon: <List className="size-4" />, on: () => linePrefix('- ') },
    { label: '1.', title: 'Numbered list', on: () => linePrefix((i) => `${i + 1}. `) },
    { label: '', title: 'Table', icon: <Table2 className="size-4" />, on: () => insert('\n| Item | Detail |\n|---|---|\n| | |\n') },
    { label: 'Center', title: 'Align centre', on: () => align('center') },
    { label: 'Right', title: 'Align right', on: () => align('right') },
    { label: '—', title: 'Divider line', on: () => insert('\n---\n') },
  ]

  /* ---- preview ---- */
  const people = usePeopleMap()
  const me = useSession((s) => s.user)
  const tenant = useSession((s) => s.tenant)
  const [sampleId, setSampleId] = useState<string>('')
  const active = (people.data ?? []).filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const sid = sampleId || active.find((p) => p.id !== me?.id)?.id || ''
  const sample = useApi(['docs7', 'sample', sid], () => docsApi.sampleVars(sid), { enabled: !!sid })
  const org = useApi(['master', 'org'], () => import('@/api/http').then((m) => m.http.get<Record<string, string> | null>('/master/org')), { staleTime: 60_000 })
  const letterhead: Letterhead | null = f.letterhead
    ? {
        legal_name: org.data?.legal_name || tenant?.name || '', brand_name: org.data?.brand_name || tenant?.name || '',
        address: [org.data?.registered_address, org.data?.city, [org.data?.state, org.data?.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        cin: org.data?.cin ?? '', gstin: org.data?.gstin ?? '', email: org.data?.email ?? '', phone: org.data?.phone ?? '', website: org.data?.website ?? '',
        logo: tenant?.slug === 'seereon' ? 'seereon' : tenant?.logo_data_url ?? null,
      }
    : null
  const html = useMemo(() => {
    const vars = { ...sampleVars(f.category, f.custom_placeholders), ...(sample.data ?? {}) }
    return markupToHtml(fillPlaceholders(f.body, vars))
  }, [f.body, f.category, f.custom_placeholders, sample.data])

  const t = q.data
  const busy = create.isPending || save.isPending
  if (!isNew && q.isLoading) return <SkeletonRows rows={8} />
  if (!isNew && (q.error || !t)) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  const catDefs = CATEGORY_PLACEHOLDERS[f.category] ?? []
  const otherDefs = catalogueFor(f.category).filter((p) => !catDefs.some((x) => x.key === p.key))
  const chip = (p: PlaceholderDef, kind: 'auto' | 'process' | 'custom') => (
    <Tooltip key={p.key} content={`${p.label}${p.sample ? ` — e.g. ${p.sample.split('\n')[0]}` : ''}`}>
      <button
        type="button"
        disabled={ro}
        onClick={() => insert(`{{${p.key}}}`)}
        className={cn('inline-flex h-7 max-w-full items-center truncate rounded-sm border px-2 font-mono text-[12px] transition hover:border-brand hover:text-brand-text', used.includes(p.key) ? 'border-brand/40 bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2', kind === 'custom' && 'border-dashed')}
      >
        {p.key}
      </button>
    </Tooltip>
  )

  return (
    <div>
      <PageHeader
        back={{ to: '/documents?tab=templates', label: 'Templates' }}
        title={isNew ? 'New template' : f.name || t!.name}
        subtitle={isNew ? 'Write the letter once; issue it to any employee with their details filled in.' : `${CATEGORY_LABEL[t!.category]} · issued ${t!.issued_count} ${t!.issued_count === 1 ? 'time' : 'times'}${t!.last_used_on ? ` · last on ${fmtDate(t!.last_used_on)}` : ''}`}
        meta={!isNew && <Badge tone={t!.active ? 'success' : 'neutral'}>{t!.active ? 'Active' : 'Off'}</Badge>}
        actions={
          <div className="flex flex-wrap gap-2">
            {!isNew && (
              <Menu
                label="More actions"
                trigger={
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
                items={[
                  { label: 'Duplicate', icon: <Copy />, onSelect: () => dup.mutate(undefined), disabled: ro },
                  ...(t!.issued_count === 0 && t!.key !== 'payslip'
                    ? [{ separator: true, label: '' }, { label: 'Delete template', icon: <Trash2 />, danger: true, disabled: ro, onSelect: async () => { if (await confirm({ title: 'Delete this template?', body: `“${t!.name}” has never been issued. It is removed for good.`, confirmLabel: 'Delete', tone: 'danger' })) del.mutate(undefined) } }]
                    : []),
                ]}
              />
            )}
            {!isNew && t!.active && (
              <Button icon={<Send className="size-4" />} disabled={ro || dirty} onClick={() => setIssueOpen(true)} title={dirty ? 'Save your changes first' : undefined}>
                Issue to employees
              </Button>
            )}
            <Button variant="primary" icon={<Save className="size-4" />} loading={busy} disabled={ro || (!isNew && !dirty)} onClick={submit}>
              {isNew ? 'Create template' : dirty ? 'Save changes' : 'Saved'}
            </Button>
          </div>
        }
      />
      {errs.form && <Callout tone="danger" className="mb-4">{errs.form}</Callout>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-7">
          <Card>
            <CardHeader title="Details" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required error={errs.name} htmlFor="tpl-name">
                <Input id="tpl-name" value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="e.g. Internship completion letter" invalid={!!errs.name} disabled={ro} />
              </Field>
              <Field label="Category" required error={errs.category} htmlFor="tpl-cat" hint={t?.key === 'payslip' ? 'Payroll issues payslips from this template.' : undefined}>
                <Select id="tpl-cat" value={f.category} onChange={(e) => set({ category: e.target.value as TemplateCategory })} options={TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))} disabled={ro || t?.key === 'payslip'} />
              </Field>
              <Field label="Description" className="sm:col-span-2" htmlFor="tpl-desc">
                <Input id="tpl-desc" value={f.description ?? ''} onChange={(e) => set({ description: e.target.value })} maxLength={300} placeholder="When HR uses this template" disabled={ro} />
              </Field>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Switch checked={f.letterhead} onChange={(v) => set({ letterhead: v })} label="Company letterhead" description="Logo, legal name, address, CIN and GSTIN from Setup → Organisation." disabled={ro} />
              <Switch checked={f.active} onChange={(v) => set({ active: v })} label="Active" description={f.active ? 'HR can issue it.' : 'Hidden from issuing.'} disabled={ro || t?.key === 'payslip'} />
            </div>
          </Card>

          <Card pad={false}>
            <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5" role="toolbar" aria-label="Formatting">
              {tools.map((x) => (
                <Tooltip key={x.title} content={x.title}>
                  <button type="button" aria-label={x.title} disabled={ro} onClick={x.on} className={cn('grid h-8 min-w-8 place-items-center rounded-md px-1.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50', x.label === 'B' && 'font-semibold', x.label === 'I' && 'italic')}>
                    {x.icon ?? x.label}
                  </button>
                </Tooltip>
              ))}
            </div>
            <div className="p-3 md:p-4">
              <Textarea
                ref={ta}
                aria-label="Letter body"
                rows={22}
                value={f.body}
                onChange={(e) => set({ body: e.target.value })}
                invalid={!!errs.body}
                disabled={ro}
                className="min-h-[420px] font-mono text-[13px] leading-[1.65]"
              />
              {errs.body ? (
                <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{errs.body}</p>
              ) : unknown.length ? (
                <p className="mt-1.5 text-[12.5px] font-medium text-warning-text">
                  Unknown placeholder{unknown.length > 1 ? 's' : ''}: {unknown.map((u) => `{{${u}}}`).join(', ')}. Add {unknown.length > 1 ? 'them' : 'it'} as a custom field or fix the spelling.
                </p>
              ) : (
                <p className="mt-1.5 text-[12px] text-ink-3"># Heading · **bold** · *italic* · - list · | table | · :::center … ::: · {'{{placeholder}}'}</p>
              )}
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-5 lg:col-span-5">
          <Card>
            <CardHeader title="Placeholders" subtitle="Click to insert at the cursor. Highlighted ones are in the letter." />
            <h4 className="mb-1.5 text-[12.5px] font-medium text-ink-3">Filled automatically</h4>
            <div className="flex flex-wrap gap-1.5">{STANDARD_PLACEHOLDERS.map((p) => chip(p, 'auto'))}</div>
            {catDefs.length > 0 && (
              <>
                <h4 className="mb-1.5 mt-4 text-[12.5px] font-medium text-ink-3">{f.category === 'payslip' ? 'Filled from the payroll run' : `Filled when issuing a ${CATEGORY_LABEL[f.category].toLowerCase()}`}</h4>
                <div className="flex flex-wrap gap-1.5">{catDefs.map((p) => chip(p, 'process'))}</div>
              </>
            )}
            <button type="button" aria-expanded={showOther} onClick={() => setShowOther((x) => !x)} className="mt-4 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-3 hover:text-ink-2">
              <ChevronRight className={cn('size-3.5 transition', showOther && 'rotate-90')} />
              Fields from other letter types ({otherDefs.length})
            </button>
            {showOther && <div className="mt-1.5 flex flex-wrap gap-1.5">{otherDefs.map((p) => chip(p, 'process'))}</div>}
            <h4 className="mb-1.5 mt-4 text-[12.5px] font-medium text-ink-3">Custom fields</h4>
            <div className="flex flex-wrap gap-1.5">
              {(f.custom_placeholders ?? []).map((k) => (
                <span key={k} className="inline-flex items-center gap-0.5">
                  {chip({ key: k, label: k.replace(/_/g, ' '), sample: '' }, 'custom')}
                  <IconButton size="xs" label={`Remove custom field ${k}`} disabled={ro} onClick={() => set({ custom_placeholders: (f.custom_placeholders ?? []).filter((x) => x !== k) })}>
                    <X className="size-3.5" />
                  </IconButton>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <Input
                aria-label="New custom field"
                value={customName}
                onChange={(e) => setCustomName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                placeholder="e.g. bonus_amount"
                className="min-w-0 flex-1"
                disabled={ro}
              />
              <Button
                icon={<Plus className="size-4" />}
                disabled={ro || !/^[a-z][a-z0-9_]{1,39}$/.test(customName) || known.has(customName)}
                onClick={() => {
                  set({ custom_placeholders: [...(f.custom_placeholders ?? []), customName] })
                  insert(`{{${customName}}}`)
                  setCustomName('')
                }}
              >
                Add
              </Button>
            </div>
            {errs.custom_placeholders && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{errs.custom_placeholders}</p>}
          </Card>

          <Card pad={false} className="lg:sticky lg:top-[76px]">
            <div className="flex flex-col gap-2 border-b border-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between md:px-5">
              <h2 className="text-[14px] font-semibold text-ink">Live preview</h2>
              <Select aria-label="Preview with employee" value={sid} onChange={(e) => setSampleId(e.target.value)} options={active.map((p) => ({ value: p.id, label: p.name }))} className="sm:w-[220px]" />
            </div>
            <div className="max-h-[720px] overflow-y-auto bg-surface-2 p-3 scroll-thin md:p-4">
              <LetterView html={html} letterhead={letterhead} className="!px-4 !py-5 sm:!px-6 sm:!py-6" />
            </div>
            <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-3 md:px-5">Values the issuer fills show sample data here.</p>
          </Card>
        </div>
      </div>
      {!isNew && t && <IssueSheet template={t as TemplateRow} open={issueOpen} onOpenChange={setIssueOpen} />}
    </div>
  )
}
