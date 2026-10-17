// v7 Documents hub building blocks: the letter view (letterhead + rendered body), PDF download, the issue sheet,
// the employee-document upload dialog and the shared tables for issued documents and employee documents.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Button, Callout, Checkbox, DataTable, Dialog, EmptyState, Field, FileUpload, IconButton, Input, Menu, SearchInput, Select, Sheet, Textarea, toast, useConfirm, useReadOnly, type Column } from '@/ui'
import { CheckCircle2, Download, Eye, FileText, MoreHorizontal, ShieldCheck, Trash2, XCircle } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { toastError } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import type { ApiError } from '@/api/http'
import { DOCS7_KEYS, EMP_DOC_ACCEPT, EMP_DOC_KIND, EMP_DOC_STATUS, ISSUED_STATUS, SOURCE_LABEL, docsApi, type EmpDocKind, type EmpDocRow, type IssuedDetail, type IssuedRow, type IssuePreviewItem, type Letterhead, type TemplateRow } from '@/api/docs'
import { CATEGORY_LABEL, CATEGORY_PLACEHOLDERS, labelOf, processPlaceholders, type PlaceholderDef } from '@/mock/docMarkup'
import { SEEREON_LOGO } from '@/assets/brand'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, paise } from '@/domain/money'
import { cn, readFileAsDataURL, saveFile } from '@/lib/utils'
import { downloadLetterPdf, pdfName } from './letterPdf'
import { fmtBytes } from './shared'

/* ---------------- letter view ---------------- */
export const PROSE =
  'text-[14px] leading-relaxed text-ink-2 [&_h1]:mb-3 [&_h1]:mt-4 [&_h1]:text-[20px] [&_h1]:font-semibold [&_h1]:text-ink [&_h2]:mb-3 [&_h2]:mt-4 [&_h2]:text-[16.5px] [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-[14px] [&_h3]:font-semibold [&_h3]:text-ink [&_p]:my-2.5 [&_strong]:font-semibold [&_strong]:text-ink [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_hr]:my-5 [&_hr]:border-line [&_.doc-tbl]:my-3.5 [&_.doc-tbl]:overflow-x-auto [&_table]:w-full [&_table]:min-w-[420px] [&_table]:border-collapse [&_table]:text-[13px] [&_th]:border [&_th]:border-line [&_th]:bg-surface-2 [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink [&_td]:border [&_td]:border-line [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_.num]:whitespace-nowrap [&_.num]:text-right [&_.num]:tabular-nums [&>*:first-child]:mt-0'

export function wrapTables(html: string) {
  return html.replace(/<table>/g, '<div class="doc-tbl"><table>').replace(/<\/table>/g, '</table></div>')
}

export function LetterheadBlock({ lh }: { lh: Letterhead }) {
  const logo = lh.logo === 'seereon' ? SEEREON_LOGO : lh.logo
  return (
    <div className="mb-6 flex flex-col gap-3 border-b-2 border-brand pb-4 sm:flex-row sm:items-start sm:justify-between">
      {logo ? <img src={logo} alt={lh.brand_name} className="h-11 w-auto max-w-[180px] object-contain object-left" /> : <span className="text-[18px] font-semibold text-ink">{lh.brand_name}</span>}
      <div className="min-w-0 text-left text-[12px] leading-snug text-ink-3 sm:text-right">
        <div className="text-[13.5px] font-semibold text-ink">{lh.legal_name}</div>
        {lh.address && <div>{lh.address}</div>}
        {(lh.cin || lh.gstin) && <div>{[lh.cin && `CIN ${lh.cin}`, lh.gstin && `GSTIN ${lh.gstin}`].filter(Boolean).join(' · ')}</div>}
        <div className="break-words">{[lh.email, lh.phone, lh.website].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  )
}

export function LetterView({ html, letterhead, watermark, className }: { html: string; letterhead: Letterhead | null; watermark?: string | null; className?: string }) {
  return (
    <div className={cn('relative mx-auto w-full max-w-[820px] overflow-hidden rounded-lg border border-line bg-surface px-4 py-5 sm:px-8 sm:py-8 lg:px-12 lg:py-10', className)}>
      {watermark && <div className="mb-4 rounded-md border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] font-medium text-danger-text">{watermark}</div>}
      {letterhead && <LetterheadBlock lh={letterhead} />}
      <div className={PROSE} dangerouslySetInnerHTML={{ __html: wrapTables(html) }} />
    </div>
  )
}

export function useLetterPdf() {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (id: string) => {
    setBusy(id)
    try {
      const d: IssuedDetail = await docsApi.issuedDoc(id)
      const r = await downloadLetterPdf({ title: d.doc.title, ref_no: d.doc.ref_no ?? '', body_md: d.doc.body_md ?? '', letterhead: d.letterhead, status: d.doc.status, issued_on: d.doc.issued_on ? fmtDate(d.doc.issued_on, 'long') : null, filename: pdfName(d.doc.title, d.doc.ref_no ?? '') })
      if (r === 'failed') toast.error('The PDF could not be created', { description: 'Try again, or open the document and print it.' })
      else if (r === 'saved') toast.success('PDF downloaded')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(null)
    }
  }
  return { run, busy }
}

export function IssuedStatus({ s }: { s: IssuedRow['status'] }) {
  const m = ISSUED_STATUS[s]
  return (
    <Badge size="sm" tone={m.tone}>
      {s === 'issued' ? 'To acknowledge' : m.label}
    </Badge>
  )
}

/* ---------------- issued documents table ---------------- */
export function IssuedTable({ rows, loading, error, onRetry, showEmployee = true, empty, compact }: { rows: IssuedRow[] | undefined; loading?: boolean; error?: unknown; onRetry?: () => void; showEmployee?: boolean; empty?: ReactNode; compact?: boolean }) {
  const nav = useNavigate()
  const { run, busy } = useLetterPdf()
  const cols: Column<IssuedRow>[] = [
    {
      key: 'title', header: 'Document', sortValue: (d) => d.title.toLowerCase(),
      cell: (d) => (
        <div className={cn('flex min-w-0 items-start gap-2.5', compact ? 'max-w-[220px] 2xl:max-w-[300px]' : 'max-w-[240px] lg:max-w-[300px] xl:max-w-[380px] 2xl:max-w-[520px]')}>
          <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{d.title}</div>
            <div className="truncate text-[12px] text-ink-3">
              <span className="tnum">{d.ref_no || 'Draft'}</span> · {CATEGORY_LABEL[d.category]}
            </div>
          </div>
        </div>
      ),
    },
    ...(showEmployee
      ? [{ key: 'emp', header: 'Employee', width: '200px', sortValue: (d: IssuedRow) => d.employee_name, cell: (d: IssuedRow) => <div className="min-w-0"><div className="truncate text-ink">{d.employee_name}</div><div className="tnum truncate text-[12px] text-ink-3">{d.employee_code}</div></div> } as Column<IssuedRow>]
      : []),
    { key: 'src', header: 'Source', width: '120px', hideBelow: 'xl', sortValue: (d) => d.source.kind, cell: (d) => <span className="whitespace-nowrap text-ink-2">{SOURCE_LABEL[d.source.kind]}</span> },
    { key: 'on', header: 'Issued', width: '120px', hideBelow: compact ? 'xl' : 'lg', sortValue: (d) => d.issued_on ?? d.created_at, cell: (d) => <span className="tnum whitespace-nowrap text-ink-2">{d.issued_on ? fmtDate(d.issued_on) : '—'}</span> },
    { key: 'st', header: 'Status', width: '170px', sortValue: (d) => d.status, cell: (d) => <IssuedStatus s={d.status} /> },
    {
      key: 'act', header: '', width: '56px', align: 'right',
      cell: (d) => (
        <span onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" label={`Download ${d.title} as PDF`} onClick={() => run(d.id)} disabled={busy === d.id}>
            <Download className="size-4" />
          </IconButton>
        </span>
      ),
    },
  ]
  const card = (d: IssuedRow) => (
    <div className="flex min-w-0 items-start gap-2.5">
      <FileText className="mt-0.5 size-4 shrink-0 text-ink-3" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{d.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
          {showEmployee ? `${d.employee_name} · ` : ''}
          <span className="tnum">{d.ref_no || 'Draft'}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="tnum truncate text-[12px] text-ink-3">{d.issued_on ? fmtDate(d.issued_on) : 'Not issued'}</span>
          <IssuedStatus s={d.status} />
        </div>
      </div>
    </div>
  )
  return <DataTable rows={rows} loading={loading} error={error} onRetry={onRetry} columns={cols} rowKey={(d) => d.id} onRowClick={(d) => nav(`/documents/issued/${d.id}`)} mobileCard={card} stickyHeader={false} empty={empty} initialSort={{ key: 'on', dir: 'desc' }} />
}

/* ---------------- issue sheet ---------------- */
const longOf = (iso: string) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '')
function toVar(f: PlaceholderDef, raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return longOf(v)
  if (f.type === 'money' && /^[₹\s\d,.]+$/.test(v)) return fmtMoney(paise(v))
  return v
}

export function IssueSheet({ template, open, onOpenChange, presetIds }: { template: TemplateRow | null; open: boolean; onOpenChange: (o: boolean) => void; presetIds?: string[] }) {
  const nav = useNavigate()
  const ro = useReadOnly()
  const people = usePeopleMap()
  const [ids, setIds] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [shared, setShared] = useState<Record<string, string>>({})
  const [per, setPer] = useState<Record<string, Record<string, string>>>({})
  const [scope, setScope] = useState<string>('all')
  const [title, setTitle] = useState('')
  const [preview, setPreview] = useState<IssuePreviewItem[] | null>(null)
  const [pv, setPv] = useState<string>('')
  const [err, setErr] = useState<{ field?: string; msg: string } | null>(null)
  const fields = useMemo(() => (template ? processPlaceholders(template.body, template.category, template.custom_placeholders ?? []) : []), [template])
  const first = ids.length === 1 ? ids[0] : null
  const suggest = useApi(['docs7', 'suggest', first], () => docsApi.suggest(first!), { enabled: !!first && open })

  useEffect(() => {
    if (!open) return
    setIds(presetIds ?? [])
    setQ('')
    setShared({})
    setPer({})
    setScope('all')
    setTitle('')
    setPreview(null)
    setErr(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, template?.id])
  useEffect(() => {
    if (scope !== 'all' && !ids.includes(scope)) setScope('all')
  }, [ids, scope])

  const list = (people.data ?? []).filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const shown = list.filter((p) => !q || `${p.name} ${p.title}`.toLowerCase().includes(q.toLowerCase()))
  const toggle = (id: string) => {
    setIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]))
    setPreview(null)
  }
  const values = scope === 'all' ? shared : per[scope] ?? {}
  const setVal = (k: string, v: string) => {
    setPreview(null)
    setErr(null)
    if (scope === 'all') setShared((x) => ({ ...x, [k]: v }))
    else setPer((x) => ({ ...x, [scope]: { ...(x[scope] ?? {}), [k]: v } }))
  }
  const payload = () => {
    const conv = (m: Record<string, string>) => Object.fromEntries(fields.map((f) => [f.key, toVar(f, m[f.key] ?? '')]).filter(([, v]) => v))
    return { employee_ids: ids, vars: conv(shared), per_employee: Object.fromEntries(Object.entries(per).filter(([k]) => ids.includes(k)).map(([k, m]) => [k, conv(m)])), title: title.trim() || undefined }
  }
  const onErr = (e: ApiError) => setErr({ field: (e as ApiError & { field?: string }).field, msg: e.message })
  const doPreview = useMut(() => docsApi.previewIssue(template!.id, payload()), {
    silentError: true,
    onError: onErr,
    onSuccess: (r) => {
      setPreview(r)
      setPv(r[0]?.employee_id ?? '')
    },
  })
  const issue = useMut((status: 'draft' | 'issued') => docsApi.issue(template!.id, { ...payload(), status }), {
    invalidate: DOCS7_KEYS,
    silentError: true,
    onError: onErr,
    success: (r, status) => (status === 'draft' ? `${r.created.length} draft${r.created.length === 1 ? '' : 's'} saved` : `${template!.name} issued to ${r.created.length} ${r.created.length === 1 ? 'employee' : 'employees'}${r.emailed ? ' — emailed' : ''}`),
    onSuccess: (r) => {
      onOpenChange(false)
      if (r.created.length === 1) nav(`/documents/issued/${r.created[0].id}`)
      else nav('/documents?tab=issued')
    },
  })
  const cur = preview?.find((p) => p.employee_id === pv) ?? preview?.[0]
  const sug = suggest.data ?? {}

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      width={760}
      title={template ? `Issue ${template.name.toLowerCase()}` : 'Issue document'}
      subtitle={template ? `${CATEGORY_LABEL[template.category]} · employees get a notification and an email, and acknowledge it in SeereonOS` : undefined}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!ids.length || ro} loading={doPreview.isPending} onClick={() => doPreview.mutate(undefined)} icon={<Eye className="size-4" />}>
            Preview
          </Button>
          <Button disabled={!ids.length || ro} loading={issue.isPending && issue.variables === 'draft'} onClick={() => issue.mutate('draft')}>
            Save as draft
          </Button>
          <Button variant="primary" disabled={!ids.length || ro} loading={issue.isPending && issue.variables === 'issued'} onClick={() => issue.mutate('issued')}>
            {ids.length > 1 ? `Issue to ${ids.length} employees` : 'Issue now'}
          </Button>
        </div>
      }
    >
      {!template ? null : (
        <div className="space-y-6">
          {template.category === 'payslip' && (
            <Callout tone="info" title="Payslips usually come from payroll">
              Finalise the month’s payroll and use Generate payslips there, so every number matches the payroll run.
            </Callout>
          )}
          <section>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-[14px] font-semibold text-ink">Employees</h3>
              <span className="tnum text-[12.5px] text-ink-3">{ids.length} selected</span>
            </div>
            <SearchInput value={q} onChange={setQ} placeholder="Search people" />
            <div className="mt-2 max-h-[220px] divide-y divide-line overflow-y-auto rounded-lg border border-line scroll-thin">
              {shown.length === 0 ? (
                <p className="px-3.5 py-3 text-[13px] text-ink-3">No one matches.</p>
              ) : (
                shown.map((p) => (
                  <div key={p.id} className="px-3.5 py-2.5">
                    <Checkbox checked={ids.includes(p.id)} onChange={() => toggle(p.id)} label={<span className="text-[13.5px] text-ink">{p.name}</span>} description={p.title} />
                  </div>
                ))
              )}
            </div>
            {err?.field === 'employee_ids' && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{err.msg}</p>}
          </section>

          {fields.length > 0 && (
            <section>
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-[14px] font-semibold text-ink">Details for this letter</h3>
                  <p className="text-[12.5px] text-ink-3">Name, code, designation, department and company details fill in automatically. Empty fields use the default shown{ids.length > 1 ? ' — from each person’s own record' : ''}.</p>
                </div>
                {ids.length > 1 && (
                  <Select
                    aria-label="Edit values for"
                    className="sm:w-[220px]"
                    value={scope}
                    onChange={(e) => setScope(e.target.value)}
                    options={[{ value: 'all', label: 'Same for everyone' }, ...ids.map((id) => ({ value: id, label: `Only ${people.get(id)?.name ?? 'employee'}` }))]}
                  />
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {fields.map((f) => (
                  <Field key={f.key} htmlFor={`iss-${f.key}`} label={f.label} error={err?.field === f.key ? err.msg : undefined} hint={scope !== 'all' && shared[f.key] ? `Everyone: ${shared[f.key]}` : sug[f.key] ? `Default: ${sug[f.key]}` : f.type === 'money' ? 'e.g. 8,40,000' : undefined} className={f.type === 'textarea' ? 'sm:col-span-2' : undefined}>
                    {f.type === 'textarea' ? (
                      <Textarea id={`iss-${f.key}`} rows={2} value={values[f.key] ?? ''} onChange={(e) => setVal(f.key, e.target.value)} placeholder={f.sample} />
                    ) : (
                      <Input
                        id={`iss-${f.key}`}
                        type={f.type === 'date' ? 'date' : 'text'}
                        inputMode={f.type === 'number' || f.type === 'money' ? 'decimal' : undefined}
                        prefix={f.type === 'money' ? '₹' : undefined}
                        value={values[f.key] ?? ''}
                        onChange={(e) => setVal(f.key, e.target.value)}
                        placeholder={f.type === 'date' ? undefined : (sug[f.key] ?? f.sample).replace(f.type === 'money' ? /^₹/ : /$^/, '')}
                        invalid={err?.field === f.key}
                      />
                    )}
                  </Field>
                ))}
              </div>
            </section>
          )}
          <Field label="Title" htmlFor="iss-title" hint={`Optional. Default: “${template.name} — employee name”.`}>
            <Input id="iss-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} placeholder={`${template.name} — ${ids.length === 1 ? people.get(ids[0])?.name ?? 'employee' : 'employee name'}`} />
          </Field>
          {err && !err.field && <Callout tone="danger">{err.msg}</Callout>}
          {err && err.field && err.field !== 'employee_ids' && !fields.some((f) => f.key === err.field) && <Callout tone="danger">{err.msg}</Callout>}

          {preview && cur && (
            <section>
              <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-[14px] font-semibold text-ink">Preview</h3>
                {preview.length > 1 && <Select aria-label="Preview for" className="sm:w-[240px]" value={cur.employee_id} onChange={(e) => setPv(e.target.value)} options={preview.map((p) => ({ value: p.employee_id, label: p.name }))} />}
              </div>
              {cur.missing.length > 0 && (
                <Callout tone="warning" className="mb-3" title={`${cur.missing.length} ${cur.missing.length === 1 ? 'value is' : 'values are'} empty for ${cur.name}`}>
                  {cur.missing.map(labelOf).join(', ')}. Fill them above, or the letter shows a blank.
                </Callout>
              )}
              <LetterView html={cur.body_html} letterhead={null} className="!max-w-none !px-4 !py-5 sm:!px-6" />
            </section>
          )}
        </div>
      )}
    </Sheet>
  )
}

/* ---------------- employee documents ---------------- */
export function EmpDocStatus({ d }: { d: EmpDocRow }) {
  const m = EMP_DOC_STATUS[d.status]
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge size="sm" tone={m.tone}>
        {d.status === 'pending' ? 'To verify' : m.label}
      </Badge>
      {d.expiry_state === 'expired' && <Badge size="sm" tone="danger">Expired</Badge>}
      {d.expiry_state === 'expiring' && <Badge size="sm" tone="warning">Expiring</Badge>}
    </span>
  )
}

function dataUrlToBlob(u: string) {
  const [head, body] = u.split(',')
  const mime = /data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  const bin = head.includes(';base64') ? atob(body) : decodeURIComponent(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
export async function downloadEmpDoc(id: string) {
  try {
    const f = await docsApi.empDocFile(id)
    if (!f.data_url) throw new Error('The file is missing. Ask the employee to upload it again.')
    const r = await saveFile(f.file_name, dataUrlToBlob(f.data_url), f.mime)
    if (r === 'failed') throw new Error('The browser blocked the download.')
  } catch (e) {
    toastError(e)
  }
}

export function EmpDocsTable({ rows, canVerify, canDelete, onReview, empty }: { rows: EmpDocRow[]; canVerify: boolean; canDelete: (d: EmpDocRow) => boolean; onReview: (d: EmpDocRow, action: 'verify' | 'reject') => void; empty?: ReactNode }) {
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const del = useMut((id: string) => docsApi.deleteEmpDoc(id), { invalidate: DOCS7_KEYS, success: 'Document removed' })
  const doDelete = async (d: EmpDocRow) => {
    if (await confirm({ title: 'Remove this document?', body: `“${d.title}” and its file are deleted.`, confirmLabel: 'Remove', tone: 'danger' })) del.mutate(d.id)
  }
  const actions = (d: EmpDocRow) => (
    <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      {canVerify && d.status === 'pending' && !ro && (
        <>
          <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} onClick={() => onReview(d, 'verify')}>
            Verify
          </Button>
          <IconButton size="sm" label={`Reject ${d.title}`} onClick={() => onReview(d, 'reject')}>
            <XCircle className="size-4" />
          </IconButton>
        </>
      )}
      <Menu
        label="More actions"
        trigger={
          <IconButton size="sm" label={`More actions for ${d.title}`}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        }
        items={[
          { label: 'Download', icon: <Download />, onSelect: () => void downloadEmpDoc(d.id) },
          ...(canDelete(d) && !ro ? [{ separator: true, label: '' }, { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => void doDelete(d) }] : []),
        ]}
      />
    </span>
  )
  const cols: Column<EmpDocRow>[] = [
    {
      key: 'title', header: 'Document', sortValue: (d) => d.title.toLowerCase(),
      cell: (d) => (
        <div className="min-w-0 max-w-[220px] lg:max-w-[260px] 2xl:max-w-[360px]">
          <div className="truncate font-medium text-ink">{d.title}</div>
          <div className="truncate text-[12px] text-ink-3">
            {EMP_DOC_KIND[d.kind]}
            {d.doc_number ? ` · No. ••••${d.doc_number.replace(/\s/g, '').slice(-4)}` : ''} · {d.file_name ?? 'file'}
            {d.size_bytes ? ` · ${fmtBytes(d.size_bytes)}` : ''}
          </div>
          {d.status === 'rejected' && d.review_note && <div className="mt-0.5 line-clamp-2 text-[12px] text-danger-text">{d.review_note}</div>}
        </div>
      ),
    },
    { key: 'up', header: 'Uploaded', width: '150px', hideBelow: 'lg', sortValue: (d) => d.uploaded_on ?? d.created_at, cell: (d) => <div className="min-w-0"><div className="tnum whitespace-nowrap text-ink-2">{fmtDate(d.uploaded_on ?? d.created_at.slice(0, 10))}</div><div className="truncate text-[12px] text-ink-3">{d.uploaded_by_name}</div></div> },
    { key: 'exp', header: 'Expires', width: '110px', hideBelow: 'xl', sortValue: (d) => d.expires_on ?? '', cell: (d) => <span className="tnum whitespace-nowrap text-ink-2">{d.expires_on ? fmtDate(d.expires_on) : '—'}</span> },
    { key: 'st', header: 'Status', width: '170px', sortValue: (d) => d.status, cell: (d) => <div className="min-w-0"><EmpDocStatus d={d} />{d.verified_by_name && d.status !== 'pending' && <div className="mt-0.5 truncate text-[12px] text-ink-3">{d.verified_by_name}</div>}</div> },
    { key: 'act', header: '', width: canVerify ? '170px' : '56px', align: 'right', cell: actions },
  ]
  const card = (d: EmpDocRow) => (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="line-clamp-2 min-w-0 text-[14px] font-medium leading-snug text-ink">{d.title}</div>
        <EmpDocStatus d={d} />
      </div>
      {d.status === 'rejected' && d.review_note && <div className="mt-1 text-[12.5px] text-danger-text">{d.review_note}</div>}
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[12.5px] text-ink-3">
          {EMP_DOC_KIND[d.kind]} · {fmtDate(d.uploaded_on ?? d.created_at.slice(0, 10))}
        </span>
        <span className="shrink-0">{actions(d)}</span>
      </div>
    </div>
  )
  return <DataTable rows={rows} columns={cols} rowKey={(d) => d.id} onRowClick={(d) => void downloadEmpDoc(d.id)} mobileCard={card} stickyHeader={false} empty={empty ?? <EmptyState compact title="No documents uploaded yet" />} />
}

export function ReviewDialog({ doc, action, onClose }: { doc: EmpDocRow | null; action: 'verify' | 'reject'; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setNote('')
    setErr(null)
  }, [doc?.id, action])
  const m = useMut(() => (action === 'verify' ? docsApi.verify(doc!.id, note.trim() || undefined) : docsApi.reject(doc!.id, note.trim())), {
    invalidate: DOCS7_KEYS,
    success: action === 'verify' ? 'Document verified' : 'Document rejected — the employee has been told why',
    onSuccess: onClose,
    onError: (e) => setErr(e.message),
    silentError: true,
  })
  return (
    <Dialog
      open={!!doc}
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={action === 'verify' ? 'Verify document' : 'Reject document'}
      description={doc ? `${doc.title} · ${EMP_DOC_KIND[doc.kind]}` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={action === 'verify' ? 'primary' : 'danger'}
            loading={m.isPending}
            icon={action === 'verify' ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            onClick={() => {
              if (action === 'reject' && note.trim().length < 10) return setErr('Tell the employee what is wrong and what to upload instead (at least 10 characters).')
              m.mutate(undefined)
            }}
          >
            {action === 'verify' ? 'Verify' : 'Reject'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {doc && (
          <Button variant="secondary" size="sm" icon={<Download className="size-4" />} onClick={() => void downloadEmpDoc(doc.id)}>
            Open the file
          </Button>
        )}
        <Field htmlFor="rv-note" label={action === 'verify' ? 'Note' : 'Reason'} required={action === 'reject'} error={err} hint={action === 'verify' ? 'Optional, e.g. “Checked against the original”.' : 'The employee sees this and uploads a corrected copy.'}>
          <Textarea id="rv-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} invalid={!!err} />
        </Field>
      </div>
    </Dialog>
  )
}

const KIND_ORDER: EmpDocKind[] = ['pan', 'aadhaar', 'education', 'bank', 'photo', 'experience', 'passport', 'id_proof', 'address_proof', 'other']
export function EmpDocUploadDialog({ open, onOpenChange, employeeId, employeeName, defaultKind }: { open: boolean; onOpenChange: (o: boolean) => void; employeeId?: string; employeeName?: string; defaultKind?: EmpDocKind }) {
  const [kind, setKind] = useState<EmpDocKind>(defaultKind ?? 'pan')
  const [title, setTitle] = useState('')
  const [file, setFile] = useState<{ name: string; mime: string; size_bytes: number; data_url: string } | null>(null)
  const [expires, setExpires] = useState('')
  const [num, setNum] = useState('')
  const [note, setNote] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!open) return
    setKind(defaultKind ?? 'pan')
    setTitle(EMP_DOC_KIND[defaultKind ?? 'pan'])
    setFile(null)
    setExpires('')
    setNum('')
    setNote('')
    setErrs({})
  }, [open, defaultKind])
  const m = useMut(() => docsApi.uploadEmpDoc({ employee_id: employeeId, kind, title: title.trim(), file, expires_on: expires || null, doc_number: num.trim() || null, note: note.trim() }), {
    invalidate: DOCS7_KEYS,
    silentError: true,
    success: (d) => (d.status === 'verified' ? 'Document added and marked verified' : 'Document uploaded — HR will verify it'),
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      const f = (e as ApiError & { field?: string }).field
      setErrs(f ? { [f]: e.message } : { form: e.message })
    },
  })
  const pick = async (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    if (!['pdf', 'png', 'jpg', 'jpeg', 'docx'].includes(ext)) return setErrs({ file: 'Use a PDF, PNG, JPG or DOCX file.' })
    if (f.size > 5 * 1024 * 1024) return setErrs({ file: 'The file is larger than 5 MB. Scan at a lower resolution and try again.' })
    setFile({ name: f.name, mime: f.type, size_bytes: f.size, data_url: await readFileAsDataURL(f) })
    setErrs({})
  }
  const submit = () => {
    const e: Record<string, string> = {}
    if (title.trim().length < 3) e.title = 'Give the document a title of 3 to 120 characters.'
    if (!file) e.file = 'Attach the scanned document.'
    if (kind === 'passport' && !expires) e.expires_on = 'Enter the passport’s expiry date.'
    setErrs(e)
    if (!Object.keys(e).length) m.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={employeeName ? `Upload for ${employeeName}` : 'Upload a document'}
      description={employeeName ? 'Documents HR uploads after checking the original are marked verified.' : 'HR verifies it against the original. You are notified when it is verified or if anything is wrong.'}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={submit}>
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kind" required htmlFor="ed-kind">
            <Select
              id="ed-kind"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as EmpDocKind
                if (!title.trim() || title === EMP_DOC_KIND[kind]) setTitle(EMP_DOC_KIND[k])
                setKind(k)
              }}
              options={KIND_ORDER.map((k) => ({ value: k, label: EMP_DOC_KIND[k] }))}
            />
          </Field>
          <Field label="Title" required error={errs.title} htmlFor="ed-title">
            <Input id="ed-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} invalid={!!errs.title} />
          </Field>
        </div>
        <div>
          <FileUpload accept={EMP_DOC_ACCEPT} maxMb={5} onFile={pick} hint="PDF, PNG, JPG or DOCX · up to 5 MB" file={file ? { name: file.name, size: file.size_bytes } : null} onClear={() => setFile(null)} />
          {errs.file && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{errs.file}</p>}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Document number" hint="Optional. Shown masked to HR." htmlFor="ed-num">
            <Input id="ed-num" value={num} onChange={(e) => setNum(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Expires on" required={kind === 'passport'} error={errs.expires_on} hint={kind === 'passport' ? undefined : 'Only for documents that expire.'} htmlFor="ed-exp">
            <Input id="ed-exp" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} invalid={!!errs.expires_on} />
          </Field>
        </div>
        <Field label="Note" hint="Optional, e.g. “Updated address”." htmlFor="ed-note">
          <Textarea id="ed-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

export function MissingKinds({ kinds, className }: { kinds: EmpDocKind[]; className?: string }) {
  if (!kinds.length) return <span className={cn('text-[12.5px] text-ink-3', className)}>None</span>
  return (
    <span className={cn('flex flex-wrap gap-1', className)}>
      {kinds.map((k) => (
        <Badge key={k} size="sm" tone="warning">
          {EMP_DOC_KIND[k]}
        </Badge>
      ))}
    </span>
  )
}

export const placeholderDefs = (cat: TemplateRow['category']) => CATEGORY_PLACEHOLDERS[cat] ?? []
