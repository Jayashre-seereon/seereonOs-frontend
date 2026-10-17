// /workflows — running workflows: what is waiting for me, what I started, what is about me, and (HR / designers) all.
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Workflow } from '@/ui/icons'
import { useWfList, useWfTemplates, type WfRow, type WfTab } from '@/api/wf'
import { useSession } from '@/stores/session'
import { fmtDate } from '@/domain/calendar'
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, Select, SkeletonRows, StatusBadge, Tabs, useCan, useReadOnly, type Column } from '@/ui'
import { DueText, PersonChip, PROCESS_LABEL, StartDialog, WF_STATUS } from './shared'

export default function WorkflowInboxPage() {
  const [sp, setSp] = useSearchParams()
  const can = useCan()
  const ro = useReadOnly()
  const me = useSession((s) => s.user?.id ?? '')
  const tab = (sp.get('tab') as WfTab) || 'waiting'
  const [status, setStatus] = useState('')
  const [tpl, setTpl] = useState('')
  const q = useWfList(tab, { status: status || undefined, template_id: tpl || undefined })
  const tq = useWfTemplates()
  const [starting, setStarting] = useState(false)
  const nav = useNavigate()
  const d = q.data
  const canAll = can('workflows.design') || can('workflows.start')
  const cols: Column<WfRow>[] = [
    {
      key: 'title', header: 'Workflow', sortValue: (r) => r.title,
      cell: (r) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-ink">{r.title}</span>
          <span className="block truncate text-[12px] text-ink-3">{r.template_name} · {PROCESS_LABEL[r.process]}</span>
        </span>
      ),
    },
    { key: 'subject', header: 'Employee', sortValue: (r) => r.subject?.name ?? '', cell: (r) => <PersonChip p={r.subject} />, hideBelow: 'lg' },
    {
      key: 'stage', header: 'Stage', sortValue: (r) => r.stage_index,
      cell: (r) => r.status === 'in_progress'
        ? <span className="block min-w-0"><span className="block truncate text-ink">{r.stage_name}</span><span className="tnum block text-[12px] text-ink-3">Step {r.stage_index + 1} of {r.stage_count}</span></span>
        : <StatusBadge size="sm" map={WF_STATUS} value={r.status} />,
    },
    { key: 'with', header: 'With', sortValue: (r) => r.assignee?.name ?? '', cell: (r) => (r.status === 'in_progress' ? <PersonChip p={r.assignee} /> : <span className="text-ink-3">—</span>), hideBelow: 'md' },
    { key: 'due', header: 'Due', sortValue: (r) => r.due_on ?? '9999', cell: (r) => (r.status === 'in_progress' ? <DueText due={r.due_on} overdue={r.overdue} /> : <span className="whitespace-nowrap text-ink-3">{r.completed_at ? `Closed ${fmtDate(r.completed_at.slice(0, 10))}` : '—'}</span>) },
    { key: 'act', header: '', align: 'right', cell: (r) => (r.can_act ? <Badge size="sm" tone="brand">Your turn</Badge> : null) },
  ]
  return (
    <div>
      <PageHeader
        title="Workflows"
        subtitle="Multi-stage reviews and approvals — appraisals, onboarding, exits, promotions and more. Each reviewer fills their own parameters."
        actions={
          <>
            {can('workflows.design') && <Button onClick={() => nav('/workflows/designer')}>Workflow designer</Button>}
            {d?.can_start && <Button variant="primary" icon={<Plus />} disabled={ro} onClick={() => setStarting(true)}>Start workflow</Button>}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => setSp(v === 'waiting' ? {} : { tab: v }, { replace: true })}
        tabs={[
          { value: 'waiting', label: 'Waiting for me', count: d?.counts.waiting },
          { value: 'started', label: 'Started by me', count: d?.counts.started },
          { value: 'about', label: 'About me', count: d?.counts.about },
          { value: 'all', label: 'All', count: d?.counts.all ?? undefined, hidden: !canAll },
        ]}
      />
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:justify-end">
        <Select aria-label="Status" className="lg:w-[200px]" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...Object.entries(WF_STATUS).map(([k, v]) => ({ value: k, label: v.label }))]} />
        <Select aria-label="Workflow" className="lg:w-[260px]" value={tpl} onChange={(e) => setTpl(e.target.value)} options={[{ value: '', label: 'All workflows' }, ...(tq.data ?? []).map((t) => ({ value: t.id, label: t.name }))]} />
      </div>
      {q.isLoading ? (
        <Card pad={false}><SkeletonRows rows={6} /></Card>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Card pad={false}>
          <DataTable
            rows={d.rows}
            columns={cols}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/workflows/run/${r.id}`)}
            empty={
              <EmptyState
                icon={<Workflow />}
                title={tab === 'waiting' ? 'Nothing is waiting for you' : tab === 'started' ? 'You haven’t started any workflows' : tab === 'about' ? 'No workflows about you' : 'No workflows yet'}
                body={tab === 'waiting' ? 'Steps assigned to you — reviews, approvals, clearances — show up here.' : 'Start one for an employee, or launch an appraisal cycle with a workflow.'}
                action={d.can_start && !ro ? <Button size="sm" variant="primary" onClick={() => setStarting(true)}>Start workflow</Button> : <Link to="/appraisals" className="text-[13px] font-medium text-brand-text hover:underline">Go to appraisals</Link>}
              />
            }
            mobileCard={(r) => (
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 font-medium text-ink">{r.title}</span>
                  {r.can_act ? <Badge size="sm" tone="brand">Your turn</Badge> : <StatusBadge size="sm" map={WF_STATUS} value={r.status} />}
                </div>
                <div className="text-[12.5px] text-ink-3">{r.status === 'in_progress' ? `Step ${r.stage_index + 1} of ${r.stage_count} · ${r.stage_name} · ${r.assignee?.name ?? '—'}` : r.template_name}</div>
                {r.status === 'in_progress' && <div className="text-[12.5px]"><DueText due={r.due_on} overdue={r.overdue} /></div>}
              </div>
            )}
          />
        </Card>
      )}
      {starting && <StartDialog open onClose={() => setStarting(false)} canStartOthers={can('workflows.start')} meId={me} />}
    </div>
  )
}
