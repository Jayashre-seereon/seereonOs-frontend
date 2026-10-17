// v7: appraisal ↔ workflow integration — launch a cycle through a workflow, and show a linked appraisal's
// workflow progress on the appraisal page.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMut } from '@/api/query'
import { wfApi, WF_INV, useWfForAppraisal, useWfTemplates } from '@/api/wf'
import type { CycleView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { fmtDate } from '@/domain/calendar'
import { Badge, Button, Callout, Card, CardHeader, Dialog, Field, Select, useCan } from '@/ui'
import { StageTimeline } from '@/modules/wf/shared'

export function LaunchDialog({ cycle, onClose }: { cycle: CycleView; onClose: () => void }) {
  const can = useCan()
  const canWf = can('workflows.start')
  const tq = useWfTemplates()
  const appraisalWfs = (tq.data ?? []).filter((t) => t.process === 'appraisal' && t.active)
  const [mode, setMode] = useState<string>('')
  const chosen = mode || (canWf ? appraisalWfs.find((t) => t.key === 'annual_appraisal')?.id ?? appraisalWfs[0]?.id ?? 'classic' : 'classic')
  const [err, setErr] = useState<string | null>(null)
  const tpl = appraisalWfs.find((t) => t.id === chosen)
  const launch = useMut(() => wfApi.launchCycle(cycle.id, chosen === 'classic' ? null : chosen), {
    invalidate: [['appraisals'], ...WF_INV], silentError: true,
    success: (r) => (r.workflows ? `Cycle launched — ${r.workflows} workflows started` : `Cycle launched for ${r.created} people`),
    onSuccess: onClose, onError: (e: ApiError) => setErr(e.message),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={`Launch ${cycle.name}?`} description="An appraisal is created for every active person with a manager."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={launch.isPending} onClick={() => launch.mutate(undefined)}>Launch cycle</Button></>}>
      <div className="space-y-4">
        <Field label="How reviews run" hint={chosen === 'classic' ? 'Self review → manager review → HR calibration on the appraisal screen.' : tpl ? tpl.stage_names.join(' → ') : undefined}>
          <Select value={chosen} onChange={(e) => setMode(e.target.value)} options={[...(canWf ? appraisalWfs.map((t) => ({ value: t.id, label: `Workflow: ${t.name}` })) : []), { value: 'classic', label: 'Classic: self → manager → HR' }]} />
        </Field>
        {chosen !== 'classic' && <Callout tone="info">Each person gets their own workflow. Reviewers act from Workflows and the Approvals inbox; the appraisal shows the progress. On finance approval the appraisal letter is issued and the new CTC goes to Change approvals.</Callout>}
        {!canWf && <p className="text-[12.5px] text-ink-3">Running appraisals through a workflow needs “Start workflows for others”.</p>}
        {err && <Callout tone="danger">{err}</Callout>}
      </div>
    </Dialog>
  )
}

/** Workflow progress for an appraisal that runs through a workflow (null when it doesn't). */
export function AppraisalWorkflowCard({ appraisalId }: { appraisalId: string }) {
  const q = useWfForAppraisal(appraisalId)
  const nav = useNavigate()
  const w = q.data
  if (!w) return null
  return (
    <Card>
      <CardHeader
        title="Workflow"
        subtitle={w.status === 'in_progress' ? `Step ${w.stage_index + 1} of ${w.stage_count} · ${w.stage_name} · with ${w.assignee?.name ?? '—'}${w.due_on ? ` · due ${fmtDate(w.due_on)}` : ''}` : w.status === 'completed' ? 'Completed' : w.status === 'rejected' ? 'Rejected' : 'Cancelled'}
        action={<span className="flex items-center gap-2">{w.overdue && <Badge size="sm" tone="danger">Overdue</Badge>}{w.can_act && <Badge size="sm" tone="brand">Your turn</Badge>}</span>}
      />
      <StageTimeline stages={w.stages.map((s) => ({ ...s, due_on: null, overdue: false }))} compact />
      {w.outputs.length > 0 && <ul className="mt-3 space-y-1 text-[13px] text-ink-2">{w.outputs.map((o, i) => <li key={i} className="break-words">{o.label}</li>)}</ul>}
      <div className="mt-4 flex justify-end">
        <Button size="sm" variant={w.can_act ? 'primary' : 'secondary'} onClick={() => nav(`/workflows/run/${w.id}`)}>{w.can_act ? 'Open your step' : 'Open workflow'}</Button>
      </div>
    </Card>
  )
}
