// Payroll page (final run): payslip status + "Generate payslips" / "View payslips". Owned by the documents module.
import { useNavigate } from 'react-router-dom'
import { Button, useCan, useReadOnly } from '@/ui'
import { FileText } from '@/ui/icons'
import { useMut } from '@/api/query'
import { DOCS7_KEYS, docsApi, usePayslipStatus } from '@/api/docs'

export default function PayslipActions({ runId }: { runId: string }) {
  const c = useCan()
  const ro = useReadOnly()
  const nav = useNavigate()
  const allowed = c('payroll.run') || c('documents.templates')
  const q = usePayslipStatus(runId, allowed)
  const gen = useMut(() => docsApi.generatePayslips(runId), {
    invalidate: [...DOCS7_KEYS, ['payroll']],
    success: (r) => (r.created ? `${r.created} payslip${r.created === 1 ? '' : 's'} issued — employees were notified and emailed` : 'Every payslip for this run is already issued'),
  })
  if (!allowed || !q.data) return null
  const s = q.data
  const missing = Math.max(0, s.eligible - s.issued)
  return (
    <>
      {s.issued > 0 && c('documents.templates') && (
        <Button icon={<FileText className="size-4" />} onClick={() => nav(`/documents?tab=issued&run=${runId}`)}>
          Payslips ({s.issued}/{s.eligible})
        </Button>
      )}
      {missing > 0 && !ro && (
        <Button variant="primary" loading={gen.isPending} onClick={() => gen.mutate(undefined)}>
          Generate payslips
        </Button>
      )}
    </>
  )
}
