// Shared building blocks for the Documents area: file-type icon, upload / version / edit dialogs,
// the document detail sheet, acknowledgement meter and the category-grouped library.
import { useEffect, useMemo, useState } from 'react'
import {
  Badge, Button, Callout, Card, DataTable, Dialog, EmptyState, ErrorState, Field, FileUpload, IconButton, Input, KV, Menu, PersonName, Progress, SearchInput, Segmented, Select, Sheet, Skeleton, SkeletonRows, Switch, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'
import {
  CheckCircle2, Download, ExternalLink, FileSpreadsheet, FileText, FileUp, History, ImageUp, Link2, MoreHorizontal, Pencil, Plus, Presentation, RotateCcw, Trash2, Users,
} from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import {
  ACCEPT_ATTR, ALLOWED_EXT, COMPANY_CATEGORIES, DOC_CATEGORY, DOC_VISIBILITY, DOCS_INVALIDATE, MAX_DOC_BYTES, PROJECT_CATEGORIES, documentsApi, useDocument, useDocuments, type DocListItem, type DocVersionView, type FilePayload,
} from '@/api/documents'
import type { ApiError } from '@/api/http'
import type { DocCategory, DocVisibility } from '@/types/business'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { cn, readFileAsDataURL, saveFile } from '@/lib/utils'

/* ---------------- formatting ---------------- */
export function extOf(name: string) {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
}
export function fmtBytes(n: number) {
  if (!n) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
export function typeLabel(d: { file_name: string; is_link: boolean }) {
  const e = extOf(d.file_name)
  const t = e === 'jpeg' ? 'JPG' : e ? e.toUpperCase() : 'File'
  return d.is_link ? `${t} link` : t
}
export function FileIcon({ name, isLink, className }: { name: string; isLink?: boolean; className?: string }) {
  const e = extOf(name)
  const Icon = isLink && !e ? Link2 : e === 'xlsx' || e === 'csv' ? FileSpreadsheet : e === 'png' || e === 'jpg' || e === 'jpeg' ? ImageUp : e === 'pptx' ? Presentation : FileText
  return <Icon className={cn('size-4 shrink-0 text-ink-3', className)} aria-hidden />
}

/* ---------------- acknowledgement status ---------------- */
export function AckMeter({ stats, className }: { stats: { acked: number; total: number }; className?: string }) {
  const pct = stats.total ? stats.acked / stats.total : 0
  return (
    <div className={cn('min-w-[96px]', className)}>
      <div className="tnum whitespace-nowrap text-[12.5px] text-ink-2">
        {stats.acked} of {stats.total} read
      </div>
      <Progress value={pct} height={4} tone={pct >= 1 ? 'success' : 'brand'} className="mt-1" />
    </div>
  )
}
export function DocStatus({ d, managerView = true }: { d: DocListItem; managerView?: boolean }) {
  if (d.archived) return <Badge size="sm">Archived</Badge>
  if (managerView && d.ack_stats) return <AckMeter stats={d.ack_stats} />
  if (d.my_ack === 'pending') return <Badge tone="warning" size="sm">Read required</Badge>
  if (d.my_ack === 'acknowledged') return <Badge tone="success" size="sm">Acknowledged</Badge>
  return <span className="text-[12.5px] text-ink-3">—</span>
}

/* ---------------- download ---------------- */
function dataUrlToBlob(u: string) {
  const [head, body] = u.split(',')
  const mime = /data:([^;,]+)/.exec(head)?.[1] ?? 'application/octet-stream'
  const bin = head.includes(';base64') ? atob(body) : decodeURIComponent(body)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
export function useDownload() {
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (id: string, version?: number) => {
    const key = `${id}:${version ?? 'cur'}`
    setBusy(key)
    try {
      const r = await documentsApi.download(id, version)
      if (r.url) window.open(r.url, '_blank', 'noopener,noreferrer')
      else if (r.data_url) {
        const res = await saveFile(r.file_name, dataUrlToBlob(r.data_url), r.mime)
        if (res === 'failed') throw new Error('The browser blocked the download.')
      }
    } catch (e) {
      const { toastError } = await import('@/api/query')
      toastError(e)
    } finally {
      setBusy(null)
    }
  }
  return { run, busy }
}

/* ---------------- upload / new version dialog ---------------- */
type Errs = Partial<Record<'title' | 'file' | 'url' | 'note' | 'category' | 'visibility', string>>

export function UploadDialog({ open, onOpenChange, projectId, doc, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; projectId: string | null; doc?: DocListItem | null; onDone?: (id: string) => void }) {
  const isVersion = !!doc
  const cats = projectId ? PROJECT_CATEGORIES : COMPANY_CATEGORIES
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState<DocCategory>(cats[0])
  const [visibility, setVisibility] = useState<DocVisibility>(projectId ? 'project' : 'company')
  const [mustRead, setMustRead] = useState(false)
  const [tags, setTags] = useState('')
  const [effective, setEffective] = useState('')
  const [note, setNote] = useState('')
  const [source, setSource] = useState<'file' | 'url'>('file')
  const [file, setFile] = useState<FilePayload | null>(null)
  const [url, setUrl] = useState('')
  const [errs, setErrs] = useState<Errs>({})

  useEffect(() => {
    if (!open) return
    setTitle('')
    setDescription('')
    setCategory(cats[0])
    setVisibility(projectId ? 'project' : 'company')
    setMustRead(!projectId)
    setTags('')
    setEffective(projectId ? '' : new Date().toISOString().slice(0, 10))
    setNote('')
    setSource(doc?.is_link ? 'url' : 'file')
    setFile(null)
    setUrl('')
    setErrs({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onErr = (e: ApiError) => {
    const f = (e as ApiError & { field?: string }).field as keyof Errs | undefined
    if (f) setErrs((x) => ({ ...x, [f]: e.message }))
  }
  const create = useMut(
    () => documentsApi.create({ project_id: projectId, title: title.trim(), description: description.trim(), category, visibility, must_read: mustRead, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), effective_on: projectId ? null : effective || null, file: source === 'file' ? file : null, url: source === 'url' ? url.trim() : null, note: note.trim() || undefined }),
    { invalidate: DOCS_INVALIDATE, success: (d) => (d.must_read ? 'Document uploaded — the team has been asked to read it' : 'Document uploaded'), onSuccess: (d) => { onOpenChange(false); onDone?.(d.id) }, onError: onErr },
  )
  const version = useMut(
    () => documentsApi.addVersion(doc!.id, { note: note.trim(), file: source === 'file' ? file : null, url: source === 'url' ? url.trim() : null }),
    { invalidate: DOCS_INVALIDATE, success: (d) => `Version ${d.current_version} uploaded`, onSuccess: () => onOpenChange(false), onError: onErr },
  )
  const pending = create.isPending || version.isPending

  const pick = async (f: File) => {
    const ext = extOf(f.name)
    if (!ALLOWED_EXT.includes(ext)) return setErrs((x) => ({ ...x, file: 'Use PDF, DOCX, XLSX, PPTX, PNG, JPG, CSV, TXT or MD files.' }))
    if (f.size > MAX_DOC_BYTES) return setErrs((x) => ({ ...x, file: 'The file is larger than 10 MB. Compress it or share a link instead.' }))
    const data_url = await readFileAsDataURL(f)
    setFile({ name: f.name, mime: f.type, size_bytes: f.size, data_url })
    setErrs((x) => ({ ...x, file: undefined }))
    if (!isVersion && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120))
  }

  const submit = () => {
    const e: Errs = {}
    if (!isVersion && (title.trim().length < 3 || title.trim().length > 120)) e.title = 'Give the document a title of 3 to 120 characters.'
    if (isVersion && note.trim().length < 5) e.note = 'Say what changed in this version (at least 5 characters).'
    if (source === 'file' && !file) e.file = 'Choose a file to upload.'
    if (source === 'url' && !/^https?:\/\/\S+\.\S+/.test(url.trim())) e.url = 'Paste a full link that starts with https://.'
    setErrs(e)
    if (Object.keys(e).length) return
    if (isVersion) version.mutate(undefined)
    else create.mutate(undefined)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={isVersion ? `Upload version ${doc!.current_version + 1}` : projectId ? 'Upload project document' : 'Add to company library'}
      description={isVersion ? <>New version of “{doc!.title}”.{doc!.must_read ? ' Everyone will be asked to read and acknowledge it again.' : ''}</> : undefined}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={pending} onClick={submit} icon={<FileUp className="size-4" />}>
            {isVersion ? 'Upload version' : 'Upload document'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!isVersion && (
          <Field label="Title" required error={errs.title}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={projectId ? 'e.g. Business requirements (BRD)' : 'e.g. Travel policy'} invalid={!!errs.title} maxLength={120} />
          </Field>
        )}
        <div>
          <Segmented
            size="sm"
            value={source}
            onChange={(v) => {
              setSource(v)
              setErrs((x) => ({ ...x, file: undefined, url: undefined }))
            }}
            options={[
              { value: 'file', label: 'Upload a file' },
              { value: 'url', label: 'Link to a file' },
            ]}
          />
          <div className="mt-2.5">
            {source === 'file' ? (
              <>
                <FileUpload accept={ACCEPT_ATTR} maxMb={10} onFile={pick} hint="PDF, DOCX, XLSX, PPTX, PNG, JPG, CSV, TXT or MD · up to 10 MB" file={file ? { name: file.name, size: file.size_bytes } : null} onClear={() => setFile(null)} />
                {errs.file && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{errs.file}</p>}
              </>
            ) : (
              <Field error={errs.url} hint="SharePoint, Google Drive or OneDrive link. Make sure the team has access.">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" invalid={!!errs.url} />
              </Field>
            )}
          </div>
        </div>
        {isVersion ? (
          <Field label="What changed" required error={errs.note}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="e.g. Added contract labour rules agreed with the client" invalid={!!errs.note} />
          </Field>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Category" required>
                <Select value={category} onChange={(e) => setCategory(e.target.value as DocCategory)} options={cats.map((c) => ({ value: c, label: DOC_CATEGORY[c] }))} />
              </Field>
              <Field label="Who can see it" required hint={DOC_VISIBILITY[visibility].hint}>
                <Select value={visibility} onChange={(e) => setVisibility(e.target.value as DocVisibility)} options={(projectId ? (['project', 'managers', 'company'] as DocVisibility[]) : (['company', 'managers'] as DocVisibility[])).map((v) => ({ value: v, label: DOC_VISIBILITY[v].label }))} />
              </Field>
            </div>
            <Field label="Description" hint="What it is and when people need it.">
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </Field>
            {!projectId && (
              <Field label="Effective from" htmlFor="doc-eff" hint="The date this policy applies from.">
                <Input id="doc-eff" type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className="sm:max-w-[220px]" />
              </Field>
            )}
            <Field label="Tags" hint="Comma separated, e.g. payroll, sign-off">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            <Switch checked={mustRead} onChange={setMustRead} label="Must read" description="Everyone who can see it is notified and asked to acknowledge they have read it." />
          </>
        )}
      </div>
    </Dialog>
  )
}

/* ---------------- edit details dialog ---------------- */
function EditDialog({ open, onOpenChange, doc }: { open: boolean; onOpenChange: (o: boolean) => void; doc: DocListItem }) {
  const cats = doc.project_id ? PROJECT_CATEGORIES : COMPANY_CATEGORIES
  const [f, setF] = useState({ title: doc.title, description: doc.description, category: doc.category, visibility: doc.visibility, must_read: doc.must_read, tags: doc.tags.join(', '), effective_on: doc.effective_on ?? '' })
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      setF({ title: doc.title, description: doc.description, category: doc.category, visibility: doc.visibility, must_read: doc.must_read, tags: doc.tags.join(', '), effective_on: doc.effective_on ?? '' })
      setErr(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const save = useMut(() => documentsApi.patch(doc.id, { ...f, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), ...(doc.project_id ? { effective_on: undefined } : { effective_on: f.effective_on || null }) }, doc.version), { invalidate: DOCS_INVALIDATE, success: 'Details saved', onSuccess: () => onOpenChange(false) })
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit details"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              const t = f.title.trim()
              if (t.length < 3 || t.length > 120) return setErr('Give the document a title of 3 to 120 characters.')
              save.mutate(undefined)
            }}
          >
            Save details
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required error={err}>
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={120} invalid={!!err} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            <Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as DocCategory })} options={[...new Set([...cats, doc.category])].map((c) => ({ value: c, label: DOC_CATEGORY[c] }))} />
          </Field>
          <Field label="Who can see it" hint={DOC_VISIBILITY[f.visibility].hint}>
            <Select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value as DocVisibility })} options={(doc.project_id ? (['project', 'managers', 'company'] as DocVisibility[]) : (['company', 'managers'] as DocVisibility[])).map((v) => ({ value: v, label: DOC_VISIBILITY[v].label }))} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} />
        </Field>
        <Field label="Tags" hint="Comma separated">
          <Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} />
        </Field>
        {!doc.project_id && (
          <Field label="Effective from" htmlFor="doc-eff-edit">
            <Input id="doc-eff-edit" type="date" value={f.effective_on} onChange={(e) => setF({ ...f, effective_on: e.target.value })} className="sm:max-w-[220px]" />
          </Field>
        )}
        <Switch checked={f.must_read} onChange={(v) => setF({ ...f, must_read: v })} label="Must read" description="Turning this on notifies everyone who can see the document." />
      </div>
    </Dialog>
  )
}

/* ---------------- preview ---------------- */
function Preview({ doc }: { doc: DocListItem }) {
  const e = extOf(doc.file_name)
  const isImage = !doc.is_link && ['png', 'jpg', 'jpeg'].includes(e)
  const isText = !doc.is_link && ['md', 'txt', 'csv'].includes(e)
  const q = useApi(['documents', 'preview', doc.id, doc.current_version], () => documentsApi.download(doc.id, doc.current_version, true), { enabled: isImage || isText, staleTime: 300_000 })
  const text = useMemo(() => {
    if (!isText || !q.data?.data_url) return null
    try {
      const b = q.data.data_url.split(',')[1]
      const bin = atob(b)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes).split('\n').slice(0, 40).join('\n')
    } catch {
      return null
    }
  }, [isText, q.data])
  if (isImage)
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
        {q.data?.data_url ? <img src={q.data.data_url} alt={doc.title} className="mx-auto block max-h-[320px] w-auto max-w-full object-contain" /> : <Skeleton className="h-48 w-full rounded-none" />}
      </div>
    )
  if (isText)
    return (
      <div className="overflow-hidden rounded-lg border border-line bg-surface-2">
        {text !== null ? <pre className="max-h-[260px] overflow-auto whitespace-pre-wrap break-words p-3.5 font-mono text-[12px] leading-relaxed text-ink-2 scroll-thin">{text}</pre> : <Skeleton className="h-32 w-full rounded-none" />}
      </div>
    )
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-md border border-line bg-surface">
        <FileIcon name={doc.file_name} isLink={doc.is_link} className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-medium text-ink">{doc.file_name}</div>
        <div className="text-[12.5px] text-ink-3">
          {typeLabel(doc)}
          {doc.size_bytes ? ` · ${fmtBytes(doc.size_bytes)}` : ''}
          {doc.is_link ? ' · opens in a new tab' : ' · download to open'}
        </div>
      </div>
    </div>
  )
}

/* ---------------- detail sheet ---------------- */
export function DocSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useDocument(id)
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const { run, busy } = useDownload()
  const { get } = usePeopleMap()
  const [versionOpen, setVersionOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [who, setWho] = useState<'pending' | 'done'>('pending')
  useEffect(() => {
    if (id)
      documentsApi
        .view(id)
        .then(() => q.refetch())
        .catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setWho('pending')
  }, [id])
  const ack = useMut(() => documentsApi.ack(id!), { invalidate: DOCS_INVALIDATE, success: 'Acknowledged — thanks for reading' })
  const archive = useMut(() => documentsApi.archive(id!), { invalidate: DOCS_INVALIDATE, success: 'Document archived', onSuccess: onClose })
  const restore = useMut(() => documentsApi.restore(id!), { invalidate: DOCS_INVALIDATE, success: 'Document restored' })
  const d = q.data?.doc
  const manage = !!d?.can_manage && !readOnly

  const doArchive = async () => {
    if (!d) return
    const ok = await confirm({ title: 'Archive this document?', body: `“${d.title}” is hidden from the team. Admins and the owner can restore it later; version history is kept.`, confirmLabel: 'Archive', tone: 'danger' })
    if (ok) archive.mutate(undefined)
  }

  const audience = q.data?.audience ?? null
  const pendingPeople = audience?.filter((a) => !a.acked_at) ?? []
  const donePeople = audience?.filter((a) => a.acked_at) ?? []

  return (
    <Sheet
      open={!!id}
      onOpenChange={(o) => !o && onClose()}
      width={600}
      title={d ? d.title : 'Document'}
      subtitle={
        d ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{d.project_name ? `${d.project_code} · ${d.project_name}` : 'Company library'}</span>
            <span aria-hidden>·</span>
            <span>{DOC_CATEGORY[d.category]}</span>
            <span aria-hidden>·</span>
            <span className="tnum">v{d.current_version}</span>
          </span>
        ) : null
      }
      footer={
        d ? (
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            {manage && (
              <Menu
                label="More actions"
                align="end"
                trigger={
                  <IconButton label="More actions" variant="secondary">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
                items={d.archived ? [{ label: 'Restore document', icon: <RotateCcw />, onSelect: () => restore.mutate(undefined) }] : [{ label: 'Edit details', icon: <Pencil />, onSelect: () => setEditOpen(true) }, { separator: true, label: '' }, { label: 'Archive', icon: <Trash2 />, danger: true, onSelect: doArchive }]}
              />
            )}
            {manage && !d.archived && (
              <Button icon={<Plus className="size-4" />} onClick={() => setVersionOpen(true)}>
                New version
              </Button>
            )}
            <Button variant={d.my_ack === 'pending' ? 'secondary' : 'primary'} icon={d.is_link ? <ExternalLink className="size-4" /> : <Download className="size-4" />} loading={busy === `${d.id}:cur`} onClick={() => run(d.id)}>
              {d.is_link ? 'Open link' : 'Download'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {q.isLoading ? (
        <SkeletonRows rows={4} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d && q.data ? (
        <div className="space-y-6">
          {d.archived && <Callout tone="neutral" title="Archived">This document is hidden from the team. Restore it from the menu to make it visible again.</Callout>}
          {!d.archived && d.my_ack === 'pending' && (
            <Callout
              tone="warning"
              title="Read required"
              action={
                <Button variant="primary" size="sm" loading={ack.isPending} disabled={readOnly} onClick={() => ack.mutate(undefined)} icon={<CheckCircle2 className="size-4" />}>
                  Acknowledge
                </Button>
              }
            >
              Read version {d.current_version}, then confirm you have read and understood it.
            </Callout>
          )}
          {d.my_ack === 'acknowledged' && q.data.my_ack_at && (
            <Callout tone="success" icon={<CheckCircle2 />}>
              You acknowledged version {d.current_version} on {fmtDateTime(q.data.my_ack_at)}.
            </Callout>
          )}

          <div className="space-y-3">
            {d.description && <p className="text-[14px] leading-relaxed text-ink-2">{d.description}</p>}
            <Preview doc={d} />
            {d.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {d.tags.map((t) => (
                  <Badge key={t} size="sm">
                    {t}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <KV
            items={[
              { label: 'Updated', value: `${fmtDate(d.updated_at.slice(0, 10))} by ${get(d.updated_by)?.name ?? '—'}` },
              { label: 'Owner', value: get(d.owner_id)?.name ?? '—' },
              { label: 'Visible to', value: DOC_VISIBILITY[d.visibility].label },
              ...(d.effective_on ? [{ label: 'Effective from', value: fmtDate(d.effective_on, 'long') }] : []),
              { label: 'Opened', value: `${q.data.view_count} ${q.data.view_count === 1 ? 'time' : 'times'}` },
            ]}
          />

          {audience && d.must_read && (
            <section>
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
                  <Users className="size-4 text-ink-3" />
                  Acknowledgements
                </h3>
                {d.ack_stats && <AckMeter stats={d.ack_stats} className="w-[140px]" />}
              </div>
              <Segmented
                size="sm"
                value={who}
                onChange={setWho}
                options={[
                  { value: 'pending', label: 'Not yet', count: pendingPeople.length },
                  { value: 'done', label: 'Acknowledged', count: donePeople.length },
                ]}
              />
              <div className="mt-2.5 divide-y divide-line rounded-lg border border-line">
                {(who === 'pending' ? pendingPeople : donePeople).length === 0 ? (
                  <p className="px-3.5 py-3 text-[13px] text-ink-3">{who === 'pending' ? 'Everyone has acknowledged this version.' : 'Nobody has acknowledged this version yet.'}</p>
                ) : (
                  (who === 'pending' ? pendingPeople : donePeople).map((a) => (
                    <div key={a.user_id} className="flex items-center justify-between gap-3 px-3.5 py-2.5">
                      <PersonName id={a.user_id} size={26} className="text-[13.5px]" />
                      <span className="shrink-0 text-right text-[12.5px] text-ink-3">
                        {a.acked_at ? fmtDateTime(a.acked_at) : a.acked_version ? `Read v${a.acked_version} only` : a.last_viewed_at ? `Opened ${fmtDate(a.last_viewed_at.slice(0, 10))}` : 'Not opened'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2.5 flex items-center gap-2 text-[14px] font-semibold text-ink">
              <History className="size-4 text-ink-3" />
              Version history
            </h3>
            <ol className="divide-y divide-line rounded-lg border border-line">
              {q.data.versions.map((v: DocVersionView) => (
                <li key={v.id} className="flex items-start gap-3 px-3.5 py-3">
                  <Badge size="sm" tone={v.version === d.current_version ? 'brand' : 'neutral'} className="tnum mt-0.5">
                    v{v.version}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] text-ink">{v.note}</div>
                    <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
                      {get(v.uploaded_by)?.name ?? '—'} · {fmtDate(v.uploaded_at.slice(0, 10))} · {v.file_name}
                      {v.size_bytes ? ` · ${fmtBytes(v.size_bytes)}` : ''}
                    </div>
                  </div>
                  <IconButton size="sm" label={`${v.is_link ? 'Open' : 'Download'} version ${v.version}`} onClick={() => run(d.id, v.version)} disabled={busy === `${d.id}:${v.version}`}>
                    {v.is_link ? <ExternalLink className="size-4" /> : <Download className="size-4" />}
                  </IconButton>
                </li>
              ))}
            </ol>
          </section>
          <UploadDialog open={versionOpen} onOpenChange={setVersionOpen} projectId={d.project_id} doc={d} />
          <EditDialog open={editOpen} onOpenChange={setEditOpen} doc={d} />
        </div>
      ) : null}
    </Sheet>
  )
}

/* ---------------- category-grouped library (project panel + company library) ---------------- */
function TitleCell({ d }: { d: DocListItem }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <FileIcon name={d.file_name} isLink={d.is_link} className="mt-0.5" />
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-ink">{d.title}</span>
          {d.must_read && !d.archived && (
            <Badge size="sm" tone="info">
              Must read
            </Badge>
          )}
        </div>
        <div className="truncate text-[12px] text-ink-3">
          {typeLabel(d)}
          {d.effective_on ? ` · effective ${fmtDate(d.effective_on)}` : ''}
        </div>
      </div>
    </div>
  )
}

export function DocLibrary({ projectId, onOpen }: { projectId: string | null; onOpen?: (id: string) => void }) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [archived, setArchived] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const readOnly = useReadOnly()
  const list = useDocuments({ scope: projectId ? 'project' : 'company', project_id: projectId ?? undefined, q: q || undefined, category: category || undefined, archived: archived || undefined })
  const { get } = usePeopleMap()
  const open = (id: string) => (onOpen ? onOpen(id) : setOpenId(id))
  const canUpload = !!list.data?.can_upload && !readOnly
  const cats = projectId ? PROJECT_CATEGORIES : COMPANY_CATEGORIES
  const items = list.data?.items ?? []
  const groups = useMemo(() => {
    const order = [...cats, ...(Object.keys(DOC_CATEGORY) as DocCategory[]).filter((c) => !cats.includes(c))]
    return order.map((c) => ({ c, rows: items.filter((d) => d.category === c) })).filter((g) => g.rows.length)
  }, [items, cats])

  const cols: Column<DocListItem>[] = [
    { key: 'title', header: 'Document', sortValue: (d) => d.title.toLowerCase(), cell: (d) => <TitleCell d={d} /> },
    { key: 'ver', header: 'Version', width: '84px', sortValue: (d) => d.current_version, cell: (d) => <span className="tnum text-ink-2">v{d.current_version}</span> },
    {
      key: 'upd', header: 'Updated', width: '180px', hideBelow: 'lg', sortValue: (d) => d.updated_at,
      cell: (d) => (
        <div className="min-w-0">
          <div className="tnum whitespace-nowrap text-ink-2">{fmtDate(d.updated_at.slice(0, 10))}</div>
          <div className="truncate text-[12px] text-ink-3">{get(d.updated_by)?.name ?? '—'}</div>
        </div>
      ),
    },
    { key: 'size', header: 'Size', width: '84px', align: 'right', hideBelow: 'xl', sortValue: (d) => d.size_bytes, cell: (d) => <span className="tnum whitespace-nowrap text-ink-3">{d.is_link ? 'Link' : fmtBytes(d.size_bytes)}</span> },
    { key: 'status', header: 'Status', width: '150px', cell: (d) => <DocStatus d={d} /> },
  ]
  const card = (d: DocListItem) => (
    <div className="flex min-w-0 items-start gap-2.5">
      <FileIcon name={d.file_name} isLink={d.is_link} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[14px] font-medium leading-snug text-ink">{d.title}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
          {typeLabel(d)} · v{d.current_version} · {d.is_link ? 'Link' : fmtBytes(d.size_bytes)}
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-[12px] text-ink-3">
            {fmtDate(d.updated_at.slice(0, 10))} · {get(d.updated_by)?.name ?? '—'}
          </span>
          <span className="shrink-0">{d.must_read || d.archived ? <DocStatus d={d} /> : null}</span>
        </div>
      </div>
    </div>
  )

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-center">
        <SearchInput value={q} onChange={setQ} placeholder={projectId ? 'Search project documents' : 'Search the library'} className="md:max-w-[320px] md:flex-1" />
        <div className="flex min-w-0 gap-2.5">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} placeholder="All categories" options={cats.map((c) => ({ value: c, label: DOC_CATEGORY[c] }))} className="min-w-0 flex-1 md:w-[180px] md:flex-none" aria-label="Category" />
          {canUpload && (
            <Select value={archived ? 'archived' : 'current'} onChange={(e) => setArchived(e.target.value === 'archived')} options={[{ value: 'current', label: 'Current' }, { value: 'archived', label: 'Archived' }]} className="min-w-0 flex-1 md:w-[130px] md:flex-none" aria-label="Show" />
          )}
        </div>
        {canUpload && (
          <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setUploadOpen(true)} className="md:ml-auto">
            {projectId ? 'Upload document' : 'Add to library'}
          </Button>
        )}
      </div>

      {list.isLoading ? (
        <Card>
          <SkeletonRows rows={5} />
        </Card>
      ) : list.error ? (
        <Card>
          <ErrorState error={list.error} onRetry={() => list.refetch()} />
        </Card>
      ) : groups.length === 0 ? (
        <Card pad={false}>
          {q || category || archived ? (
            <EmptyState compact title={archived ? 'No archived documents' : 'No documents match'} body={archived ? 'Archived documents appear here and can be restored.' : 'Try another search or category.'} />
          ) : projectId ? (
            <EmptyState
              icon={<FileText />}
              title="No project documents yet"
              body={canUpload ? 'Start with what the team needs on day one: the signed requirements (BRD), the design or UI mockups, and the test plan. Mark the ones everyone must read.' : 'Your project manager has not shared any documents for this project yet.'}
              action={
                canUpload ? (
                  <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setUploadOpen(true)}>
                    Upload the requirements
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <EmptyState icon={<FileText />} title="The company library is empty" body={canUpload ? 'Add the employee handbook, leave and timesheet policies first, and mark them must-read.' : 'Policies, processes and templates will appear here.'} />
          )}
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.c}>
              <h3 className="mb-2 flex items-center gap-2 text-[13.5px] font-semibold text-ink-2">
                {DOC_CATEGORY[g.c]}
                <span className="tnum text-[12px] font-normal text-ink-3">{g.rows.length}</span>
              </h3>
              <DataTable rows={g.rows} columns={cols} rowKey={(d) => d.id} onRowClick={(d) => open(d.id)} mobileCard={card} stickyHeader={false} />
            </section>
          ))}
        </div>
      )}
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} projectId={projectId} onDone={open} />
      {!onOpen && <DocSheet id={openId} onClose={() => setOpenId(null)} />}
    </div>
  )
}
