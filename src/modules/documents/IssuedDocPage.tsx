// /documents/issued/:id — one issued document (letter or payslip): letterhead view, PDF download, acknowledgement
// by the employee, and for HR: edit / issue a draft, revoke, re-issue.
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge, Button, Callout, Card, CardHeader, ErrorState, Field, Input, KV, PageHeader, PersonName, Sheet, SkeletonRows, Textarea, useConfirm, useReadOnly } from '@/ui'
import { CheckCircle2, Download, Pencil, RotateCcw, Send, Trash2, XCircle } from '@/ui/icons'
import { useMut } from '@/api/query'
import { useSession } from '@/stores/session'
import { DOCS7_KEYS, ISSUED_STATUS, SOURCE_LABEL, docsApi, useIssuedDoc, type IssuedDetail } from '@/api/docs'
import { CATEGORY_LABEL } from '@/mock/docMarkup'
import { fmtDate } from '@/domain/calendar'
import { LetterView, useLetterPdf } from './docUi'

export default function IssuedDocPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const ro = useReadOnly()
  const me = useSession((s) => s.user)
  const { confirm, askReason } = useConfirm()
  const q = useIssuedDoc(id)
  const { run, busy } = useLetterPdf()
  const [editOpen, setEditOpen] = useState(false)
  const done = (msg: string) => ({ invalidate: DOCS7_KEYS, success: msg })
  const ack = useMut(() => docsApi.ack(id), done('Acknowledged — thank you'))
  const issue = useMut(() => docsApi.issueDraft(id), done('Document issued — the employee has been notified and emailed'))
  const revoke = useMut((reason: string) => docsApi.revoke(id, reason), done('Document revoked'))
  const reissue = useMut(() => docsApi.reissue(id), { invalidate: DOCS7_KEYS, success: (r: IssuedDetail) => `Re-issued as ${r.doc.ref_no}`, onSuccess: (r: IssuedDetail) => nav(`/documents/issued/${r.doc.id}`) })
  const del = useMut(() => docsApi.deleteDraft(id), { invalidate: DOCS7_KEYS, success: 'Draft deleted', onSuccess: () => nav('/documents?tab=issued') })

  if (q.isLoading) return <SkeletonRows rows={8} />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const { doc, letterhead, can_manage, can_ack, replaces, replaced_by } = q.data
  const st = ISSUED_STATUS[doc.status]
  const mine = doc.employee_id === me?.id

  const doRevoke = async () => {
    const reason = await askReason({ title: 'Revoke this document?', body: `${doc.employee_name} is told it is no longer valid. It stays in the register as revoked.`, label: 'Reason', minLength: 5, confirmLabel: 'Revoke', tone: 'danger' })
    if (reason) revoke.mutate(reason)
  }
  const doReissue = async () => {
    if (await confirm({ title: 'Re-issue with current details?', body: `A new copy with a new reference number is issued from the current template and ${doc.employee_name}’s current record.${doc.status !== 'revoked' ? ' This copy is revoked.' : ''}`, confirmLabel: 'Re-issue' })) reissue.mutate(undefined)
  }
  const doDelete = async () => {
    if (await confirm({ title: 'Delete this draft?', body: 'It was never issued, so nobody has seen it.', confirmLabel: 'Delete', tone: 'danger' })) del.mutate(undefined)
  }

  const sourceLink = doc.source.kind === 'payroll' && doc.source.ref_id ? `/payroll/${doc.source.ref_id}` : doc.source.kind === 'workflow' && doc.source.ref_id ? `/workflows/run/${doc.source.ref_id}` : null

  return (
    <div>
      <PageHeader
        back={can_manage ? { to: '/documents?tab=issued', label: 'Issued documents' } : { to: '/documents?tab=mine', label: 'My documents' }}
        title={doc.title}
        subtitle={`${doc.ref_no || 'Draft'} · ${CATEGORY_LABEL[doc.category]}${mine ? '' : ` · ${doc.employee_name}`}`}
        meta={<Badge tone={st.tone}>{st.label}</Badge>}
        actions={
          <div className="flex flex-wrap gap-2">
            {can_manage && !ro && doc.status === 'draft' && (
              <>
                <Button icon={<Trash2 className="size-4" />} onClick={doDelete} loading={del.isPending}>
                  Delete draft
                </Button>
                <Button icon={<Pencil className="size-4" />} onClick={() => setEditOpen(true)}>
                  Edit details
                </Button>
                <Button variant="primary" icon={<Send className="size-4" />} loading={issue.isPending} onClick={() => issue.mutate(undefined)}>
                  Issue now
                </Button>
              </>
            )}
            {can_manage && !ro && doc.status !== 'draft' && (
              <>
                {doc.status !== 'revoked' && (
                  <Button variant="outline-danger" icon={<XCircle className="size-4" />} onClick={doRevoke} loading={revoke.isPending}>
                    Revoke
                  </Button>
                )}
                {!replaced_by && (
                  <Button icon={<RotateCcw className="size-4" />} onClick={doReissue} loading={reissue.isPending}>
                    Re-issue
                  </Button>
                )}
              </>
            )}
            <Button variant={can_ack ? 'secondary' : doc.status === 'draft' && can_manage ? 'secondary' : 'primary'} icon={<Download className="size-4" />} loading={busy === doc.id} onClick={() => run(doc.id)}>
              Download PDF
            </Button>
            {can_ack && (
              <Button variant="primary" icon={<CheckCircle2 className="size-4" />} loading={ack.isPending} disabled={ro} onClick={() => ack.mutate(undefined)}>
                Acknowledge
              </Button>
            )}
          </div>
        }
      />
      {can_ack && (
        <Callout tone="warning" className="mb-4" title="Please read and acknowledge">
          Acknowledging confirms you have received and read this {CATEGORY_LABEL[doc.category].toLowerCase()}.
        </Callout>
      )}
      {doc.status === 'revoked' && (
        <Callout tone="danger" className="mb-4" title={`Revoked on ${fmtDate(doc.revoked_on ?? null, 'long')}`}>
          {doc.revoke_reason}
          {replaced_by && (
            <>
              {' '}
              <Link className="font-medium text-brand-text hover:underline" to={`/documents/issued/${replaced_by.id}`}>
                Open {replaced_by.ref_no}
              </Link>
            </>
          )}
        </Callout>
      )}
      {doc.status === 'draft' && <Callout tone="neutral" className="mb-4">Draft — {doc.employee_name} can’t see it until it is issued.</Callout>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 lg:col-span-8">
          <LetterView html={doc.body_html} letterhead={letterhead} watermark={doc.status === 'revoked' ? 'Revoked — this document is no longer valid.' : null} />
        </div>
        <div className="min-w-0 space-y-5 lg:col-span-4">
          <Card>
            <CardHeader title="Details" />
            <KV
              cols={1}
              items={[
                { label: 'Employee', value: <PersonName id={doc.employee_id} subtitle={doc.employee_code} /> },
                { label: 'Reference', value: <span className="tnum">{doc.ref_no || '—'}</span> },
                { label: 'Template', value: doc.template_name ?? '—' },
                { label: 'Source', value: sourceLink && can_manage ? <Link className="text-brand-text hover:underline" to={sourceLink}>{SOURCE_LABEL[doc.source.kind]}</Link> : SOURCE_LABEL[doc.source.kind] },
                ...(doc.period ? [{ label: 'Period', value: doc.period }] : []),
                { label: 'Issued', value: doc.issued_on ? <span>{fmtDate(doc.issued_on, 'long')} by <PersonName id={doc.issued_by} withAvatar={false} /></span> : 'Not yet' },
                { label: 'Acknowledged', value: doc.acknowledged_on ? fmtDate(doc.acknowledged_on, 'long') : doc.status === 'issued' ? 'Waiting' : '—' },
                ...(doc.emailed_to ? [{ label: 'Emailed to', value: <span className="break-all">{doc.emailed_to}</span> }] : []),
                ...(replaces ? [{ label: 'Replaces', value: <Link className="text-brand-text hover:underline" to={`/documents/issued/${replaces.id}`}>{replaces.ref_no}</Link> }] : []),
              ]}
            />
          </Card>
          {can_manage && doc.status !== 'draft' && (
            <Card>
              <CardHeader title="Employee file" subtitle="Every letter, payslip and uploaded document of this employee." />
              <Button block onClick={() => nav(`/documents/employees/${doc.employee_id}`)}>
                Open {doc.employee_name}’s documents
              </Button>
            </Card>
          )}
        </div>
      </div>
      {can_manage && doc.status === 'draft' && <DraftSheet open={editOpen} onOpenChange={setEditOpen} d={q.data} />}
    </div>
  )
}

function DraftSheet({ open, onOpenChange, d }: { open: boolean; onOpenChange: (o: boolean) => void; d: IssuedDetail }) {
  const [title, setTitle] = useState(d.doc.title)
  const [vals, setVals] = useState<Record<string, string>>({})
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setTitle(d.doc.title)
    setVals(Object.fromEntries(d.process_fields.map((f) => [f.key, d.doc.vars?.[f.key] ?? ''])))
    setErr(null)
  }, [open, d])
  const save = useMut(() => docsApi.saveDraft(d.doc.id, { title: title.trim(), vars: vals }, d.doc.version), {
    invalidate: DOCS7_KEYS,
    success: 'Draft saved',
    silentError: true,
    onError: (e) => setErr(e.message),
    onSuccess: () => onOpenChange(false),
  })
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Edit draft"
      subtitle={`${d.doc.employee_name} · ${d.doc.template_name ?? ''}`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save draft
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} />
        </Field>
        {d.process_fields.map((f) => (
          <Field key={f.key} label={f.label}>
            {f.type === 'textarea' ? <Textarea rows={2} value={vals[f.key] ?? ''} onChange={(e) => setVals((x) => ({ ...x, [f.key]: e.target.value }))} /> : <Input value={vals[f.key] ?? ''} onChange={(e) => setVals((x) => ({ ...x, [f.key]: e.target.value }))} />}
          </Field>
        ))}
        {err && <Callout tone="danger">{err}</Callout>}
      </div>
    </Sheet>
  )
}
