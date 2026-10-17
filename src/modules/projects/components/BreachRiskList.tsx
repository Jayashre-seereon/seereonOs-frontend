// G5.03 — "Critical path and breach risks": every at-risk task with why it is at risk and one-click actions.
// Used on the project Schedule tab ({projectId}) and, cross-project, on the PM dashboard (no projectId).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ShieldCheck } from '@/ui/icons'
import { deliveryApi, type RiskRow, type RiskTaskLink } from '@/api/work'
import { useApi } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { COMPLEXITY, TASK_STAGE } from '@/domain/labels'
import { fmtDate } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { useUI } from '@/stores/ui'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, FilterChips, Skeleton, useReadOnly } from '@/ui'
import { FlagSlipDialog, ProgressDialog, ReassignDialog, StageBadge, StageSelect, TagBadge, useRemoveTask, type StageTask } from '@/modules/work/taskStage'

type Filter = 'all' | 'breached' | 'high_risk' | 'critical'

export function BreachRiskList({ projectId, limit, className, title = 'Critical path and breach risks' }: { projectId?: string; limit?: number; className?: string; title?: string }) {
  const q = useApi(['delivery', 'risks', projectId ?? 'all'], () => deliveryApi.risks(projectId), { staleTime: 10_000 })
  const [filter, setFilter] = useState<Filter>('all')
  const [all, setAll] = useState(false)
  const rows = q.data ?? []
  const shown = rows.filter((r) => filter === 'all' || (filter === 'breached' ? r.breached : filter === 'high_risk' ? r.high_risk : r.critical))
  const cut = limit && !all ? shown.slice(0, limit) : shown
  return (
    <Card className={cn('min-w-0', className)}>
      <CardHeader
        title={title}
        subtitle={`${projectId ? 'Tasks that are overdue, forecast to miss their target, waiting, over estimate, or on the critical path and starting soon.' : 'Across the projects you run: overdue, forecast late, waiting, and critical tasks starting soon.'} Breached = an open task already past its target end.`}
        action={rows.length ? <Badge tone="danger">{rows.length}</Badge> : undefined}
      />
      {q.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-md" />
          ))}
        </div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !rows.length ? (
        <EmptyState compact icon={<ShieldCheck />} title="Nothing is at risk" body="Every open task is forecast to finish by its target and none is waiting on anyone." />
      ) : (
        <>
          <FilterChips
            className="mb-2"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All', count: rows.length },
              { value: 'breached', label: 'Breached', count: rows.filter((r) => r.breached).length },
              { value: 'high_risk', label: 'High risk', count: rows.filter((r) => r.high_risk).length },
              { value: 'critical', label: 'Critical', count: rows.filter((r) => r.critical).length },
            ]}
          />
          {!shown.length ? (
            <EmptyState compact title="Nothing in this filter" />
          ) : (
            <ul className="divide-y divide-line">
              {cut.map((r) => (
                <RiskItem key={r.id} r={r} showProject={!projectId} />
              ))}
            </ul>
          )}
          {limit && shown.length > limit && (
            <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-[13px] font-medium text-brand-text hover:underline">
              {all ? 'Show fewer' : `Show all ${shown.length}`}
            </button>
          )}
        </>
      )}
    </Card>
  )
}

function LinkLine({ kind, links }: { kind: 'waits' | 'blocks'; links: RiskTaskLink[] }) {
  const people = usePeopleMap()
  const openTask = useUI((s) => s.openTask)
  if (!links.length) return null
  const open = links.filter((l) => !l.done).length
  return (
    <div className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-1 text-[12.5px] leading-snug">
      <span className="font-semibold text-ink-2">{kind === 'waits' ? `Waiting on${open ? ` (${open} open)` : ''}` : 'Blocks'}</span>
      {links.map((l) => {
        const tone = l.done ? 'ok' : l.held_up ? (kind === 'waits' ? 'warn' : 'bad') : kind === 'waits' ? 'warn' : 'ok'
        const who = people.get(l.owner_id)?.name ?? 'Unassigned'
        const tail =
          kind === 'waits'
            ? l.done
              ? 'done'
              : `${TASK_STAGE[l.stage].label}, ends ${fmtDate(l.forecast_end)}`
            : l.done
              ? 'done'
              : `starts ${fmtDate(l.start_on)}${l.held_up ? ', will be held up' : ''}`
        return (
          <button
            type="button"
            key={l.id}
            onClick={() => openTask(l.id)}
            className={cn(
              'min-w-0 max-w-full rounded-[3px] px-1 text-left hover:underline',
              tone === 'ok' && 'bg-success-soft text-success-text',
              tone === 'warn' && 'bg-warning-soft text-warning-text',
              tone === 'bad' && 'bg-danger-soft text-danger-text',
            )}
          >
            <span className="tnum font-medium">{l.wbs}</span> {l.title}: {who}, {tail}
          </button>
        )
      })}
    </div>
  )
}

function RiskItem({ r, showProject }: { r: RiskRow; showProject: boolean }) {
  const people = usePeopleMap()
  const openTask = useUI((s) => s.openTask)
  const ro = useReadOnly()
  const remove = useRemoveTask()
  const [dlg, setDlg] = useState<null | 'progress' | 'slip' | 'reassign'>(null)
  const st: StageTask = {
    id: r.id, title: r.title, wbs: r.wbs, due_on: r.due_on, start_on: r.start_on, stage: r.stage, progress: r.progress, status: r.status, version: r.version,
    can_move: r.can_move, can_submit: r.can_submit, can_review: r.can_review, can_edit: r.can_edit, owner_id: r.owner_id, backup_id: r.backup_id, logged_hours: r.logged_hours,
  }
  const name = (id: string | null) => people.get(id)?.name ?? 'Unassigned'
  const where = r.general ? 'No project' : `${r.project_name}${r.milestone_label ? ` / ${r.milestone_label}` : ''}`
  const notStarted = r.stage === 'new' || r.stage === 'selected'
  const revised = r.revised_on && r.baseline_due_on && r.baseline_due_on !== r.due_on
  const planned = `Planned ${fmtDate(r.start_on)} to ${fmtDate(r.baseline_due_on ?? r.due_on)}${revised ? `, revised ${fmtDate(r.due_on)}` : ''}${r.slip_flagged_on ? ` (flagged ${fmtDate(r.slip_flagged_on)}${r.slip_flagged_on < r.due_on ? ', early' : ''})` : ''}.`
  const actual = notStarted && !r.actual_start_on ? `Forecast ${fmtDate(r.forecast_start)} to ${fmtDate(r.forecast_end)}` : `Actual ${fmtDate(r.actual_start_on ?? r.start_on)} to …`
  const canAct = !ro && r.can_move
  const headline = /orecast end/.test(r.headline) || r.breached || r.forecast_end <= r.due_on ? r.headline : `${r.headline}; forecast end ${fmtDate(r.forecast_end)}, target ${fmtDate(r.due_on)}`
  const extra = r.reasons.filter((x) => !headline.includes(x) && !(x.startsWith('Forecast end') && /orecast end/.test(headline)))
  return (
    <li className="py-3.5 first:pt-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={() => openTask(r.id)} className="min-w-0 text-left text-[14px] font-semibold leading-snug text-ink hover:underline">
          {!r.general && <span className="tnum mr-1 text-brand-text">{r.wbs}</span>}
          {r.title}
        </button>
        <StageBadge stage={r.stage} progress={r.progress} />
        <TagBadge tag={r.tag} />
        {r.breached && <Badge tone="danger" size="sm">Breached</Badge>}
        {r.high_risk && !r.breached && <Badge tone="danger" size="sm">High risk</Badge>}
        {r.critical && <Badge tone="danger" size="sm">Critical</Badge>}
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-3">
        {showProject && !r.general ? <span className="text-ink-2">{r.project_code} · </span> : null}
        {where}, {name(r.owner_id)}, {COMPLEXITY[r.complexity].label} complexity, est. {fmtNum(r.est_hours, 1)}h{r.logged_hours ? `, logged ${fmtNum(r.logged_hours, 1)}h` : ''}
        {r.backup_id ? `, backup ${name(r.backup_id)}` : ''}
      </p>
      <p className="tnum text-[12.5px] leading-snug text-ink-3">
        {planned} {actual}
      </p>
      {r.note && <p className="text-[12.5px] leading-snug text-ink-2">Note: {r.note}</p>}
      {r.slip_note && r.slip_note !== r.note && <p className="text-[12.5px] leading-snug text-ink-2">Slip: {r.slip_note}</p>}
      <LinkLine kind="waits" links={r.waiting_on} />
      <LinkLine kind="blocks" links={r.blocks} />
      <p className="mt-1 text-[12.5px] font-semibold leading-snug text-ink">{headline}</p>
      {extra.length > 0 && <p className="text-[12px] text-ink-3">{extra.join(' · ')}</p>}
      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        <StageSelect t={st} size="sm" className="col-span-2 sm:w-[220px]" />
        <Button size="sm" disabled={!canAct || r.status === 'in_review'} onClick={() => setDlg('progress')}>Update progress</Button>
        <Button size="sm" disabled={!canAct} onClick={() => setDlg('slip')}>Flag slip</Button>
        <Button size="sm" disabled={ro || !r.can_edit} onClick={() => setDlg('reassign')}>Reassign</Button>
        <Button size="sm" onClick={() => openTask(r.id)}>Details and comments{r.comments ? ` (${r.comments})` : ''}</Button>
        <Button size="sm" variant="outline-danger" disabled={ro || !r.can_edit} onClick={() => remove(st)}>Remove</Button>
      </div>
      <ProgressDialog t={st} open={dlg === 'progress'} onOpenChange={(o) => !o && setDlg(null)} />
      <FlagSlipDialog t={st} open={dlg === 'slip'} onOpenChange={(o) => !o && setDlg(null)} />
      <ReassignDialog t={st} open={dlg === 'reassign'} onOpenChange={(o) => !o && setDlg(null)} />
      {showProject && !r.general && (
        <Link to={`/projects/${r.project_id}/schedule`} className="mt-1.5 inline-block text-[12px] font-medium text-ink-3 hover:text-brand-text">
          Open {r.project_code} schedule
        </Link>
      )}
    </li>
  )
}

export default BreachRiskList
