// /workflows/designer — the workflow templates of the workspace (built-in ones plus the company's own).
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Plus, Workflow } from '@/ui/icons'
import { useMut } from '@/api/query'
import { wfApi, useWfTemplates, type WfTemplateRow } from '@/api/wf'
import type { ApiError } from '@/api/http'
import type { WfProcess } from '@/types/v7'
import { fmtDate } from '@/domain/calendar'
import { Badge, Button, Callout, Card, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, Segmented, Select, SkeletonRows, Textarea, Tooltip, useReadOnly, type Column } from '@/ui'
import { PROCESS_LABEL } from './shared'

export default function WfDesignerListPage() {
  const q = useWfTemplates()
  const nav = useNavigate()
  const ro = useReadOnly()
  const [creating, setCreating] = useState(false)
  const dup = useMut((id: string) => wfApi.duplicate(id), { invalidate: [['wf']], success: 'Copy created — it starts inactive', onSuccess: (t) => nav(`/workflows/designer/${t.id}`) })
  const cols: Column<WfTemplateRow>[] = [
    {
      key: 'name', header: 'Workflow', sortValue: (r) => r.name,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-ink">{r.name}</span>
          <span className="block truncate text-[12px] text-ink-3">{r.stage_names.join(' → ')}</span>
        </span>
      ),
    },
    { key: 'process', header: 'Process', sortValue: (r) => r.process, cell: (r) => <span className="whitespace-nowrap text-ink-2">{PROCESS_LABEL[r.process]}</span>, hideBelow: 'md' },
    { key: 'stages', header: 'Stages', align: 'right', sortValue: (r) => r.stage_names.length, cell: (r) => <span className="tnum">{r.stage_names.length}</span>, hideBelow: 'lg' },
    { key: 'running', header: 'Running', align: 'right', sortValue: (r) => r.running, cell: (r) => <span className="tnum">{r.running}</span> },
    { key: 'done', header: 'Completed', align: 'right', sortValue: (r) => r.completed, cell: (r) => <span className="tnum">{r.completed}</span>, hideBelow: 'lg' },
    { key: 'rev', header: 'Revision', align: 'right', sortValue: (r) => r.rev, cell: (r) => <span className="tnum text-ink-2">{r.rev}</span>, hideBelow: 'xl' },
    { key: 'upd', header: 'Updated', sortValue: (r) => r.updated_at, cell: (r) => <span className="whitespace-nowrap text-ink-3">{fmtDate(r.updated_at.slice(0, 10))}</span>, hideBelow: 'xl' },
    { key: 'status', header: 'Status', sortValue: (r) => Number(r.active), cell: (r) => <span className="inline-flex flex-wrap gap-1"><Badge size="sm" tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge>{r.self_service && <Badge size="sm">Self-service</Badge>}</span> },
    {
      key: 'act', header: '', align: 'right',
      cell: (r) => (
        <Tooltip content="Duplicate">
          <IconButton label={`Duplicate ${r.name}`} size="sm" variant="ghost" disabled={ro} onClick={(e) => { e.stopPropagation(); dup.mutate(r.id) }}><Copy className="size-4" /></IconButton>
        </Tooltip>
      ),
    },
  ]
  return (
    <div>
      <PageHeader
        back={{ to: '/workflows', label: 'Workflows' }}
        title="Workflow designer"
        subtitle="Design multi-stage workflows: who reviews at each stage, the parameters each reviewer fills, who sees which values, deadlines, and what happens on completion."
        actions={<Button variant="primary" icon={<Plus />} disabled={ro} onClick={() => setCreating(true)}>New workflow</Button>}
      />
      {q.isLoading ? <Card pad={false}><SkeletonRows rows={6} /></Card> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Card pad={false}>
          <DataTable
            rows={q.data}
            columns={cols}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/workflows/designer/${r.id}`)}
            empty={<EmptyState icon={<Workflow />} title="No workflows yet" body="Create one, or start from a copy." action={<Button size="sm" variant="primary" onClick={() => setCreating(true)}>New workflow</Button>} />}
            mobileCard={(r) => (
              <div className="min-w-0 space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium">{r.name}</span>
                  <Badge size="sm" tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Active' : 'Inactive'}</Badge>
                </div>
                <div className="text-[12.5px] text-ink-3">{PROCESS_LABEL[r.process]} · {r.stage_names.length} stages · {r.running} running</div>
                <div className="text-[12px] text-ink-3">{r.stage_names.join(' → ')}</div>
              </div>
            )}
          />
        </Card>
      )}
      {creating && <NewDialog rows={q.data ?? []} onClose={() => setCreating(false)} />}
    </div>
  )
}

function NewDialog({ rows, onClose }: { rows: WfTemplateRow[]; onClose: () => void }) {
  const nav = useNavigate()
  const [mode, setMode] = useState<'blank' | 'copy'>('blank')
  const [name, setName] = useState('')
  const [process, setProcess] = useState<WfProcess>('general')
  const [copy, setCopy] = useState('')
  const [desc, setDesc] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => wfApi.create({ name: name.trim(), process, description: desc.trim(), copy_of: mode === 'copy' ? copy : null }), {
    invalidate: [['wf']], success: 'Workflow created — add stages and activate it', silentError: true, onSuccess: (t) => { onClose(); nav(`/workflows/designer/${t.id}`) },
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (name.trim().length < 3) e.name = 'At least 3 characters.'
    if (mode === 'copy' && !copy) e.copy_of = 'Choose the workflow to copy.'
    setErrs(e)
    if (!Object.keys(e).length) m.mutate(undefined)
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="New workflow" description="It starts inactive so you can design it before anyone uses it."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={submit}>Create and design</Button></>}>
      <div className="space-y-4">
        <Segmented block value={mode} onChange={setMode} options={[{ value: 'blank', label: 'Start blank' }, { value: 'copy', label: 'Copy an existing one' }]} />
        <Field label="Name" required error={errs.name}>
          <Input value={name} invalid={!!errs.name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mid-year review" />
        </Field>
        {mode === 'copy' ? (
          <Field label="Copy of" required error={errs.copy_of}>
            <Select value={copy} invalid={!!errs.copy_of} placeholder="Choose a workflow" options={rows.map((r) => ({ value: r.id, label: r.name }))} onChange={(e) => { setCopy(e.target.value); const r = rows.find((x) => x.id === e.target.value); if (r) setProcess(r.process) }} />
          </Field>
        ) : null}
        <Field label="Process type" required error={errs.process}>
          <Select value={process} onChange={(e) => setProcess(e.target.value as WfProcess)} options={Object.entries(PROCESS_LABEL).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}
