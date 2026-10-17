// /documents/employees/:userId — one employee's file: documents they uploaded (verify / reject, HR upload on
// behalf, missing mandatory documents, expiry) and every letter and payslip issued to them.
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { Avatar, Button, Callout, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, PageHeader, Select, SkeletonRows, StatCard, useCan, useReadOnly } from '@/ui'
import { FileUp, Send } from '@/ui/icons'
import { EMP_DOC_KIND, MANDATORY_KINDS, useEmpFile, useTemplates, type EmpDocKind, type EmpDocRow, type TemplateRow } from '@/api/docs'
import { useSession } from '@/stores/session'
import { CATEGORY_LABEL } from '@/mock/docMarkup'
import { fmtDate } from '@/domain/calendar'
import { EmpDocUploadDialog, EmpDocsTable, IssueSheet, IssuedTable, ReviewDialog } from './docUi'

export default function EmployeeDocsPage() {
  const { userId = '' } = useParams()
  const c = useCan()
  const ro = useReadOnly()
  const me = useSession((s) => s.user)
  const q = useEmpFile(userId)
  const [upload, setUpload] = useState<{ open: boolean; kind?: EmpDocKind }>({ open: false })
  const [review, setReview] = useState<{ doc: EmpDocRow | null; action: 'verify' | 'reject' }>({ doc: null, action: 'verify' })
  const [pickOpen, setPickOpen] = useState(false)
  const [tplId, setTplId] = useState('')
  const [issueTpl, setIssueTpl] = useState<TemplateRow | null>(null)
  const templates = useTemplates(c('documents.templates'))

  if (q.isLoading) return <SkeletonRows rows={8} />
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const d = q.data
  const self = d.user.id === me?.id
  const pending = d.docs.filter((x) => x.status === 'pending').length
  const expiring = d.docs.filter((x) => x.expiry_state === 'expiring' || x.expiry_state === 'expired')
  const activeTpls = (templates.data ?? []).filter((t) => t.active && t.category !== 'payslip')

  return (
    <div>
      <PageHeader
        back={c('documents.employee_files') ? { to: '/documents?tab=employees', label: 'Employee documents' } : { to: '/documents?tab=mine', label: 'My documents' }}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <Avatar name={d.user.name} hue={d.user.avatar_hue} size={36} />
            <span className="min-w-0 truncate">{d.user.name}</span>
          </span>
        }
        subtitle={[d.user.code, d.user.designation, d.user.department, d.user.joined_on && `joined ${fmtDate(d.user.joined_on, 'long')}`].filter(Boolean).join(' · ')}
        actions={
          <div className="flex flex-wrap gap-2">
            {d.can_issue && !ro && (
              <Button icon={<Send className="size-4" />} onClick={() => setPickOpen(true)}>
                Issue a letter
              </Button>
            )}
            {d.can_upload && !ro && (
              <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setUpload({ open: true })}>
                {self ? 'Upload document' : 'Upload on behalf'}
              </Button>
            )}
          </div>
        }
      />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Documents uploaded" value={d.docs.length} sub={`${d.docs.filter((x) => x.status === 'verified').length} verified`} />
        <StatCard label="Waiting for verification" value={pending} tone={pending ? 'warning' : undefined} sub={pending ? 'HR to check' : 'Nothing waiting'} />
        <StatCard label="Missing mandatory" value={d.missing.length} tone={d.missing.length ? 'danger' : undefined} sub={d.missing.length ? d.missing.map((k) => EMP_DOC_KIND[k]).join(', ') : `All ${MANDATORY_KINDS.length} on file`} />
        <StatCard label="Letters & payslips" value={d.issued.length} sub={`${d.issued.filter((x) => x.status === 'issued').length} to acknowledge`} />
      </div>
      {d.missing.length > 0 && (
        <Callout tone="warning" className="mb-4" title={self ? 'Upload your mandatory documents' : `${d.user.name.split(' ')[0]} is missing mandatory documents`}>
          <div className="mt-1 flex flex-wrap gap-2">
            {d.missing.map((k) => (
              <Button key={k} size="sm" variant="secondary" disabled={ro || !d.can_upload} onClick={() => setUpload({ open: true, kind: k })}>
                Upload {EMP_DOC_KIND[k]}
              </Button>
            ))}
          </div>
        </Callout>
      )}
      {expiring.length > 0 && (
        <Callout tone="warning" className="mb-4" title="Expiring documents">
          {expiring.map((x) => `${x.title} — ${x.expiry_state === 'expired' ? 'expired' : 'expires'} ${fmtDate(x.expires_on, 'long')}`).join(' · ')}
        </Callout>
      )}
      <div className="grid gap-5 xl:grid-cols-12">
        <section className="min-w-0 xl:col-span-7">
          <Card pad={false}>
            <div className="border-b border-line px-4 py-3 md:px-5">
              <CardHeader className="mb-0" title="Uploaded documents" subtitle={d.can_verify ? 'Open a file, check it against the original, then verify or reject it.' : 'Uploaded by the employee or by HR.'} />
            </div>
            <div className="p-3 md:p-4">
              <EmpDocsTable
                rows={d.docs}
                canVerify={d.can_verify}
                canDelete={(x) => c('documents.employee_files') || (self && x.status !== 'verified')}
                onReview={(doc, action) => setReview({ doc, action })}
                empty={<EmptyState compact title="Nothing uploaded yet" body={self ? 'Upload your PAN, Aadhaar, education certificates and bank details.' : 'Ask the employee to upload their documents, or upload them on their behalf.'} />}
              />
            </div>
          </Card>
        </section>
        <section className="min-w-0 xl:col-span-5">
          <Card pad={false}>
            <div className="border-b border-line px-4 py-3 md:px-5">
              <CardHeader className="mb-0" title="Letters & payslips" subtitle="Issued to this employee from templates and payroll." />
            </div>
            <div className="p-3 md:p-4">
              <IssuedTable rows={d.issued} showEmployee={false} compact empty={<EmptyState compact title="No letters or payslips yet" />} />
            </div>
          </Card>
        </section>
      </div>
      <EmpDocUploadDialog open={upload.open} onOpenChange={(o) => setUpload({ open: o, kind: upload.kind })} employeeId={self ? undefined : d.user.id} employeeName={self ? undefined : d.user.name} defaultKind={upload.kind} />
      <ReviewDialog doc={review.doc} action={review.action} onClose={() => setReview({ doc: null, action: 'verify' })} />
      <Dialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        size="sm"
        title={`Issue a letter to ${d.user.name}`}
        footer={
          <>
            <Button onClick={() => setPickOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!tplId}
              onClick={() => {
                setIssueTpl(activeTpls.find((t) => t.id === tplId) ?? null)
                setPickOpen(false)
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        <Field label="Template" required>
          <Select value={tplId} onChange={(e) => setTplId(e.target.value)} placeholder="Choose a template" options={activeTpls.map((t) => ({ value: t.id, label: `${t.name} · ${CATEGORY_LABEL[t.category]}` }))} />
        </Field>
      </Dialog>
      <IssueSheet template={issueTpl} open={!!issueTpl} onOpenChange={(o) => !o && setIssueTpl(null)} presetIds={[d.user.id]} />
    </div>
  )
}
