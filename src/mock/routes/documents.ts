// Documents: project libraries + company library, versions, must-read acknowledgements, views.
// Access rules (server-enforced):
//  - company docs (project_id null): visibility 'company' → everyone in the tenant; 'managers' → admin, pm, ops.
//  - project docs: 'company' → everyone; 'project' → admin, project PM, ops, task owners/backups, allocated people;
//    'managers' → admin, project PM, ops.
//  - manage: project docs → admin or the project's PM (documents.manage); company docs → documents.company (admin/ops).
//  - archived docs are only visible to people who can manage them.
import type { Router, Ctx } from '../server'
import { err, find, insert, logActivity, notify, nowISO, rows, update, getDb, has, permissionsOf } from '../server'
import type { DocumentRec, DocumentVersion, DocCategory, DocVisibility } from '@/types/business'
import type { User } from '@/types/entities'
import type { AudienceRow, DocDetail, DocList, DocListItem, DocProject, FilePayload, PolicyStatus } from '@/api/documents'

const CATEGORIES: DocCategory[] = ['requirements', 'design', 'technical', 'test', 'contract', 'meeting_notes', 'process', 'policy', 'training', 'other']
const VISIBILITIES: DocVisibility[] = ['project', 'company', 'managers']
const EXT_MIME: Record<string, string[]> = {
  pdf: ['application/pdf'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  csv: ['text/csv', 'application/vnd.ms-excel'],
  txt: ['text/plain'],
  md: ['text/markdown', 'text/x-markdown', 'text/plain'],
}
const MAX_BYTES = 10 * 1024 * 1024

/* ---------------- access ---------------- */
type Members = Map<string, Set<string>> // project_id → user ids

function membersOf(ctx: Ctx): Members {
  const m: Members = new Map()
  const add = (p: string, u: string | null | undefined) => {
    if (!u) return
    if (!m.has(p)) m.set(p, new Set())
    m.get(p)!.add(u)
  }
  for (const t of rows(ctx, 'tasks')) {
    add(t.project_id, t.owner_id)
    add(t.project_id, t.backup_id)
  }
  for (const a of rows(ctx, 'allocations')) add(a.project_id, a.user_id)
  for (const p of rows(ctx, 'projects')) add(p.id, p.pm_id)
  return m
}

interface Viewer {
  id: string
  perms: ReadonlySet<string>
}
function pmOf(ctx: Ctx, projectId: string | null) {
  if (!projectId) return null
  return rows(ctx, 'projects').find((p) => p.id === projectId)?.pm_id ?? null
}
function canSeeAs(ctx: Ctx, v: Viewer, d: DocumentRec, members: Members): boolean {
  if (d.archived && !canManageAs(ctx, v, d)) return false
  if (d.visibility === 'company') return true
  if (v.perms.has('documents.view_all')) return true
  if (!d.project_id) return v.perms.has('documents.manage') || v.perms.has('documents.company') // company doc, managers only
  if (pmOf(ctx, d.project_id) === v.id) return true
  if (d.visibility === 'managers') return false
  return members.get(d.project_id)?.has(v.id) ?? false
}
function canManageAs(ctx: Ctx, v: Viewer, d: { project_id: string | null }): boolean {
  if (!d.project_id) return v.perms.has('documents.company')
  if (v.perms.has('documents.manage') && v.perms.has('documents.view_all')) return true
  return v.perms.has('documents.manage') && pmOf(ctx, d.project_id) === v.id
}
const me = (ctx: Ctx): Viewer => ({ id: ctx.user.id, perms: ctx.perms })
const canSee = (ctx: Ctx, d: DocumentRec, m: Members) => canSeeAs(ctx, me(ctx), d, m)
/** Library documents the caller may see (used by global search). */
export function visibleDocuments(ctx: Ctx): DocumentRec[] {
  const m = membersOf(ctx)
  return rows(ctx, 'documents').filter((d) => !d.archived && canSee(ctx, d, m))
}
const canManage = (ctx: Ctx, d: { project_id: string | null }) => canManageAs(ctx, me(ctx), d)

/** Load a doc the caller may see; anything else is a 404 (never reveal existence). */
function loadDoc(ctx: Ctx, id: string, m = membersOf(ctx)): DocumentRec {
  const d = find(ctx, 'documents', id, 'Document')
  if (!canSee(ctx, d, m)) err(404, 'NOT_FOUND', 'Document not found.')
  return d
}
function requireManage(ctx: Ctx, d: { project_id: string | null }) {
  if (!canManage(ctx, d))
    err(403, 'FORBIDDEN', d.project_id ? 'Only admins and the project manager can change project documents.' : 'Only admins and HR & operations can change the company library.')
}

/** Who must read a must-read doc: the project team (PM + members) for project docs, everyone who can see it for
 *  company docs. Admins / HR who can see a project doc without being on the team may read it but are not required to. */
function isRequired(ctx: Ctx, v: Viewer, d: DocumentRec, m: Members): boolean {
  if (!canSeeAs(ctx, v, d, m)) return false
  if (!d.project_id || d.visibility === 'company') return true
  if (pmOf(ctx, d.project_id) === v.id) return true
  if (d.visibility === 'managers') return v.perms.has('documents.view_all')
  return m.get(d.project_id)?.has(v.id) ?? false
}
function audienceOf(ctx: Ctx, d: DocumentRec, m: Members): User[] {
  return rows(ctx, 'users').filter((u) => u.status === 'active' && isRequired(ctx, { id: u.id, perms: new Set(permissionsOf(u)) }, d, m))
}
function ackFor(ctx: Ctx, d: DocumentRec, userId: string) {
  if (rows(ctx, 'document_acks').some((a) => a.document_id === d.id && a.user_id === userId && a.version === d.current_version)) return
  insert(ctx, 'document_acks', { document_id: d.id, version: d.current_version, user_id: userId, at: nowISO() } as never)
}

/* ---------------- views ---------------- */
function currentVersion(ctx: Ctx, d: DocumentRec): DocumentVersion | undefined {
  return rows(ctx, 'document_versions').find((v) => v.document_id === d.id && v.version === d.current_version)
}
function toItem(ctx: Ctx, d: DocumentRec, m: Members): DocListItem {
  const v = currentVersion(ctx, d)
  const p = d.project_id ? rows(ctx, 'projects').find((x) => x.id === d.project_id) : null
  const acks = rows(ctx, 'document_acks').filter((a) => a.document_id === d.id && a.version === d.current_version)
  const manage = canManage(ctx, d)
  let ack_stats: DocListItem['ack_stats'] = null
  if (manage && d.must_read) {
    const aud = audienceOf(ctx, d, m)
    const ids = new Set(aud.map((u) => u.id))
    ack_stats = { acked: new Set(acks.filter((a) => ids.has(a.user_id)).map((a) => a.user_id)).size, total: aud.length }
  }
  return {
    id: d.id,
    version: d.version,
    project_id: d.project_id,
    project_name: p?.name ?? null,
    project_code: p?.code ?? null,
    title: d.title,
    description: d.description,
    category: d.category,
    visibility: d.visibility,
    must_read: d.must_read,
    tags: d.tags,
    owner_id: d.owner_id,
    current_version: d.current_version,
    archived: d.archived,
    file_name: v?.file_name ?? '',
    mime: v?.mime ?? '',
    size_bytes: v?.size_bytes ?? 0,
    is_link: !!v?.url,
    updated_by: v?.uploaded_by ?? d.owner_id,
    updated_at: v?.uploaded_at ?? d.updated_at,
    effective_on: d.effective_on ?? null,
    my_ack: !d.must_read ? null : acks.some((a) => a.user_id === ctx.user.id) ? 'acknowledged' : isRequired(ctx, me(ctx), d, m) ? 'pending' : null,
    ack_stats,
    can_manage: manage,
  }
}

/* ---------------- validation ---------------- */
// v7: company-library documents (policies) carry an effective date. Stored on the row as an optional extra.
function cleanEffective(v: unknown): string | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) err(422, 'VALIDATION', 'Enter a valid effective date.', 'effective_on')
  return s
}
function cleanTitle(t: unknown) {
  const s = String(t ?? '').trim()
  if (s.length < 3 || s.length > 120) err(422, 'VALIDATION', 'Give the document a title of 3 to 120 characters.', 'title')
  return s
}
function cleanCategory(c: unknown): DocCategory {
  if (!CATEGORIES.includes(c as DocCategory)) err(422, 'VALIDATION', 'Choose a category.', 'category')
  return c as DocCategory
}
function cleanVisibility(v: unknown, projectId: string | null): DocVisibility {
  if (!VISIBILITIES.includes(v as DocVisibility)) err(422, 'VALIDATION', 'Choose who can see the document.', 'visibility')
  if (!projectId && v === 'project') return 'company'
  return v as DocVisibility
}
function cleanTags(t: unknown): string[] {
  if (!Array.isArray(t)) return []
  return [...new Set(t.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 8)
}
interface Source {
  file_id: string | null
  url: string | null
  file_name: string
  mime: string
  size_bytes: number
}
function takeSource(body: { file?: FilePayload | null; url?: string | null }): Omit<Source, 'file_id'> & { file?: FilePayload } {
  const f = body.file
  const url = String(body.url ?? '').trim()
  if (f && url) err(422, 'VALIDATION', 'Attach a file or paste a link — not both.', 'file')
  if (f) {
    const name = String(f.name ?? '').trim()
    const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
    if (!EXT_MIME[ext]) err(422, 'FILE_REJECTED', 'Use PDF, DOCX, XLSX, PPTX, PNG, JPG, CSV, TXT or MD files.', 'file')
    const size = Number(f.size_bytes ?? 0)
    if (!(size > 0)) err(422, 'FILE_REJECTED', 'The file is empty. Choose another file.', 'file')
    if (size > MAX_BYTES) err(422, 'FILE_REJECTED', 'The file is larger than 10 MB. Compress it or share a link instead.', 'file')
    if (typeof f.data_url !== 'string' || !f.data_url.startsWith('data:')) err(422, 'FILE_REJECTED', 'The file could not be read. Choose it again.', 'file')
    const mime = f.mime && EXT_MIME[ext].includes(f.mime) ? f.mime : EXT_MIME[ext][0]
    return { url: null, file_name: name, mime, size_bytes: size, file: { ...f, name, mime } }
  }
  if (url) {
    if (!/^https?:\/\/\S+\.\S+/.test(url)) err(422, 'VALIDATION', 'Paste a full link that starts with https://.', 'url')
    let name = url
    try {
      const u = new URL(url)
      name = u.hostname + (u.pathname.length > 1 ? u.pathname : '')
    } catch {
      /* keep url */
    }
    return { url, file_name: name.slice(0, 120), mime: 'text/uri-list', size_bytes: 0 }
  }
  return err(422, 'VALIDATION', 'Attach a file or paste a link to the document.', 'file')
}
function addVersion(ctx: Ctx, d: DocumentRec, versionNo: number, src: ReturnType<typeof takeSource>, note: string) {
  const at = nowISO()
  const ver = insert(ctx, 'document_versions', { document_id: d.id, version: versionNo, file_id: null, url: src.url, file_name: src.file_name, size_bytes: src.size_bytes, mime: src.mime, note, uploaded_by: ctx.user.id, uploaded_at: at } as never) as DocumentVersion
  if (src.file) {
    const fr = insert(ctx, 'files', { name: src.file.name, mime: src.file.mime, size_bytes: src.size_bytes, entity: 'document_version', entity_id: ver.id, data_url: src.file.data_url } as never)
    ver.file_id = fr.id
  }
  return ver
}
function notifyMustRead(ctx: Ctx, d: DocumentRec, m: Members, isNewVersion: boolean) {
  for (const u of audienceOf(ctx, d, m)) {
    if (u.id === ctx.user.id) continue
    notify(
      ctx,
      u.id,
      'NTF-14',
      isNewVersion ? 'Must-read document updated' : 'New must-read document',
      `${ctx.user.name} ${isNewVersion ? `published v${d.current_version} of` : 'shared'} “${d.title}”. Read it and acknowledge.`,
      `/documents?doc=${d.id}`,
    )
  }
}

/* ---------------- routes ---------------- */
export function register(r: Router) {
  r.get('/documents', ({ ctx, query }) => {
    const m = membersOf(ctx)
    const scope = String(query.scope ?? (query.project_id ? 'project' : 'mine'))
    const projectId = query.project_id ? String(query.project_id) : null
    const q = String(query.q ?? '').trim().toLowerCase()
    const cat = String(query.category ?? '')
    const archived = String(query.archived ?? '') === 'true'
    if (projectId) find(ctx, 'projects', projectId, 'Project')
    const visible = rows(ctx, 'documents').filter((d) => canSee(ctx, d, m))
    const pending_count = visible.filter((d) => !d.archived && d.must_read && isRequired(ctx, me(ctx), d, m) && !rows(ctx, 'document_acks').some((a) => a.document_id === d.id && a.version === d.current_version && a.user_id === ctx.user.id)).length
    let list = visible.filter((d) => d.archived === archived)
    if (scope === 'project') list = list.filter((d) => (projectId ? d.project_id === projectId : d.project_id !== null))
    else if (scope === 'company') list = list.filter((d) => d.project_id === null)
    if (cat) list = list.filter((d) => d.category === cat)
    let items = list.map((d) => toItem(ctx, d, m))
    if (q) items = items.filter((d) => [d.title, d.description, d.file_name, d.project_name ?? '', d.project_code ?? '', ...d.tags].join(' ').toLowerCase().includes(q))
    items.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    const can_upload = scope === 'company' ? canManage(ctx, { project_id: null }) : projectId ? canManage(ctx, { project_id: projectId }) : false
    return { items, pending_count, can_upload } satisfies DocList
  })

  r.get('/documents/projects', ({ ctx }) => {
    const m = membersOf(ctx)
    const visibleDocs = rows(ctx, 'documents').filter((d) => d.project_id && !d.archived && canSee(ctx, d, m))
    const acks = rows(ctx, 'document_acks').filter((a) => a.user_id === ctx.user.id)
    const out: DocProject[] = rows(ctx, 'projects')
      .filter((p) => has(ctx, 'documents.view_all') || p.pm_id === ctx.user.id || m.get(p.id)?.has(ctx.user.id) || visibleDocs.some((d) => d.project_id === p.id))
      .map((p) => {
        const docs = visibleDocs.filter((d) => d.project_id === p.id)
        return {
          id: p.id,
          code: p.code,
          name: p.name,
          status: p.status,
          doc_count: docs.length,
          pending: docs.filter((d) => d.must_read && isRequired(ctx, me(ctx), d, m) && !acks.some((a) => a.document_id === d.id && a.version === d.current_version)).length,
          can_manage: canManage(ctx, { project_id: p.id }),
        }
      })
      .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name))
    return out
  })

  // v7 Documents hub → Policies: who has read which must-read policy (current version).
  r.get('/documents/policy-status', ({ ctx }) => {
    if (!['documents.company', 'documents.employee_files', 'documents.view_all'].some((k) => ctx.perms.has(k))) err(403, 'FORBIDDEN', 'Acknowledgement status is for HR and managers.')
    const m = membersOf(ctx)
    const policies = rows(ctx, 'documents').filter((d) => !d.project_id && !d.archived && d.must_read && canSee(ctx, d, m))
    const acks = rows(ctx, 'document_acks')
    const people = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.is_super_admin)
    const viewers = people.map((u) => ({ u, v: { id: u.id, perms: new Set(permissionsOf(u)) } as Viewer }))
    const acked = (d: DocumentRec, uid: string) => acks.some((a) => a.document_id === d.id && a.user_id === uid && a.version === d.current_version)
    const out: PolicyStatus = {
      policies: policies
        .map((d) => {
          const aud = viewers.filter((x) => isRequired(ctx, x.v, d, m))
          return { id: d.id, title: d.title, current_version: d.current_version, effective_on: d.effective_on ?? null, acked: aud.filter((x) => acked(d, x.u.id)).length, total: aud.length }
        })
        .sort((a, b) => a.acked / (a.total || 1) - b.acked / (b.total || 1) || a.title.localeCompare(b.title)),
      people: viewers
        .map(({ u, v }) => {
          const req = policies.filter((d) => isRequired(ctx, v, d, m))
          const pending = req.filter((d) => !acked(d, u.id))
          return { user_id: u.id, name: u.name, required: req.length, acked: req.length - pending.length, pending: pending.map((d) => ({ id: d.id, title: d.title })) }
        })
        .sort((a, b) => b.pending.length - a.pending.length || a.name.localeCompare(b.name)),
    }
    return out
  })

  r.get('/documents/:id', ({ ctx, params }) => {
    const m = membersOf(ctx)
    const d = loadDoc(ctx, params.id, m)
    const versions = rows(ctx, 'document_versions')
      .filter((v) => v.document_id === d.id)
      .sort((a, b) => b.version - a.version)
      .map((v) => ({ ...v, is_link: !!v.url }))
    const acks = rows(ctx, 'document_acks').filter((a) => a.document_id === d.id)
    const views = rows(ctx, 'document_views').filter((v) => v.document_id === d.id)
    const mine = acks.find((a) => a.user_id === ctx.user.id && a.version === d.current_version)
    let audience: AudienceRow[] | null = null
    if (canManage(ctx, d)) {
      audience = audienceOf(ctx, d, m)
        .map((u) => {
          const ua = acks.filter((a) => a.user_id === u.id).sort((a, b) => b.version - a.version)
          const cur = ua.find((a) => a.version === d.current_version)
          const lv = views.filter((v) => v.user_id === u.id).sort((a, b) => b.at.localeCompare(a.at))[0]
          return { user_id: u.id, acked_at: cur?.at ?? null, acked_version: ua[0]?.version ?? null, last_viewed_at: lv?.at ?? null }
        })
        .sort((a, b) => Number(!!a.acked_at) - Number(!!b.acked_at))
    }
    return { doc: toItem(ctx, d, m), versions, my_ack_at: mine?.at ?? null, view_count: views.length, audience } satisfies DocDetail
  })

  r.post('/documents', ({ ctx, body }) => {
    const m = membersOf(ctx)
    const projectId = body.project_id ? String(body.project_id) : null
    if (projectId) {
      const p = find(ctx, 'projects', projectId, 'Project')
      if (!canManage(ctx, { project_id: p.id })) err(403, 'FORBIDDEN', 'Only admins and the project manager can upload project documents.')
    } else if (!canManage(ctx, { project_id: null })) err(403, 'FORBIDDEN', 'Only admins and HR & operations can add to the company library.')
    const title = cleanTitle(body.title)
    const category = cleanCategory(body.category)
    const visibility = cleanVisibility(body.visibility ?? (projectId ? 'project' : 'company'), projectId)
    const src = takeSource(body)
    const d = insert(ctx, 'documents', {
      project_id: projectId,
      title,
      description: String(body.description ?? '').trim().slice(0, 2000),
      category,
      visibility,
      must_read: !!body.must_read,
      tags: cleanTags(body.tags),
      ...(projectId ? {} : { effective_on: cleanEffective(body.effective_on) }),
      owner_id: ctx.user.id,
      current_version: 1,
      archived: false,
    } as never) as DocumentRec
    addVersion(ctx, d, 1, src, String(body.note ?? '').trim() || 'First version')
    if (d.must_read) ackFor(ctx, d, ctx.user.id) // the uploader has read what they published
    logActivity(ctx, 'document', d.id, 'created', `Uploaded “${d.title}” (v1)`)
    if (d.must_read) notifyMustRead(ctx, d, m, false)
    return toItem(ctx, d, m)
  })

  r.post('/documents/:id/versions', ({ ctx, params, body }) => {
    const m = membersOf(ctx)
    const d = loadDoc(ctx, params.id, m)
    requireManage(ctx, d)
    if (d.archived) err(409, 'ARCHIVED', 'Restore the document before uploading a new version.')
    const note = String(body.note ?? '').trim()
    if (note.length < 5) err(422, 'VALIDATION', 'Say what changed in this version (at least 5 characters).', 'note')
    const src = takeSource(body)
    const next = d.current_version + 1
    addVersion(ctx, d, next, src, note.slice(0, 500))
    const u = update(ctx, 'documents', d.id, { current_version: next } as Partial<DocumentRec>)
    logActivity(ctx, 'document', d.id, 'version', `Uploaded v${next} of “${d.title}”: ${note}`)
    if (u.must_read) {
      ackFor(ctx, u, ctx.user.id)
      notifyMustRead(ctx, u, m, true)
    }
    return toItem(ctx, u, m)
  })

  r.patch('/documents/:id', ({ ctx, params, body, ifMatch }) => {
    const m = membersOf(ctx)
    const d = loadDoc(ctx, params.id, m)
    requireManage(ctx, d)
    const patch: Partial<DocumentRec> = {}
    if (body.title !== undefined) patch.title = cleanTitle(body.title)
    if (body.description !== undefined) patch.description = String(body.description ?? '').trim().slice(0, 2000)
    if (body.category !== undefined) patch.category = cleanCategory(body.category)
    if (body.visibility !== undefined) patch.visibility = cleanVisibility(body.visibility, d.project_id)
    if (body.must_read !== undefined) patch.must_read = !!body.must_read
    if (body.tags !== undefined) patch.tags = cleanTags(body.tags)
    if (body.effective_on !== undefined && !d.project_id) patch.effective_on = cleanEffective(body.effective_on)
    const becameMustRead = patch.must_read === true && !d.must_read
    const u = update(ctx, 'documents', d.id, patch, ifMatch)
    logActivity(ctx, 'document', d.id, 'updated', `Updated details of “${u.title}”`)
    if (becameMustRead) {
      ackFor(ctx, u, ctx.user.id)
      notifyMustRead(ctx, u, m, false)
    }
    return toItem(ctx, u, m)
  })

  for (const [action, archived] of [['archive', true], ['restore', false]] as const) {
    r.post(`/documents/:id/${action}`, ({ ctx, params }) => {
      const m = membersOf(ctx)
      const d = find(ctx, 'documents', params.id, 'Document')
      if (!canManage(ctx, d)) {
        if (!canSee(ctx, d, m)) err(404, 'NOT_FOUND', 'Document not found.')
        requireManage(ctx, d)
      }
      if (d.archived === archived) return toItem(ctx, d, m)
      const u = update(ctx, 'documents', d.id, { archived } as Partial<DocumentRec>)
      logActivity(ctx, 'document', d.id, action === 'archive' ? 'archived' : 'restored', `${action === 'archive' ? 'Archived' : 'Restored'} “${d.title}”`)
      return toItem(ctx, u, m)
    })
  }

  r.post('/documents/:id/ack', ({ ctx, params }) => {
    const d = loadDoc(ctx, params.id)
    if (d.archived) err(409, 'ARCHIVED', 'This document is archived and no longer needs acknowledgement.')
    const existing = rows(ctx, 'document_acks').find((a) => a.document_id === d.id && a.user_id === ctx.user.id && a.version === d.current_version)
    if (existing) return { version: existing.version, at: existing.at }
    ackFor(ctx, d, ctx.user.id)
    const at = rows(ctx, 'document_acks').find((a) => a.document_id === d.id && a.user_id === ctx.user.id && a.version === d.current_version)!.at
    logActivity(ctx, 'document', d.id, 'acknowledged', `Acknowledged v${d.current_version} of “${d.title}”`)
    return { version: d.current_version, at }
  })

  r.post('/documents/:id/view', ({ ctx, params }) => {
    const d = loadDoc(ctx, params.id)
    insert(ctx, 'document_views', { document_id: d.id, user_id: ctx.user.id, at: nowISO() } as never)
    return { ok: true }
  })

  r.get('/documents/:id/download', ({ ctx, params, query }) => {
    const d = loadDoc(ctx, params.id)
    const vno = query.version ? Number(query.version) : d.current_version
    const v = rows(ctx, 'document_versions').find((x) => x.document_id === d.id && x.version === vno)
    if (!v) err(404, 'NOT_FOUND', `Version ${vno} not found.`)
    const file = v.file_id ? getDb().files.find((f) => f.id === v.file_id && f.tenant_id === ctx.tenant.id) : null
    // GET handlers may still record a view (reads don't go through the write guard, so View-as doesn't log).
    if (!ctx.viewAs && !query.preview) insert(ctx, 'document_views', { document_id: d.id, user_id: ctx.user.id, at: nowISO() } as never)
    return { file_name: v.file_name, mime: v.mime, data_url: file?.data_url ?? null, url: v.url }
  })
}
