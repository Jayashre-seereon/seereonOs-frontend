// Planned costing on an existing project (checklist G6.09): calendar summary + the same cost calculator as the
// create form, saved with PUT /projects/:id/costing (allocations are the resource rows).
import { useEffect, useMemo, useState } from 'react'
import { costingApi, type ProjectDetail } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { usePeopleMap } from '@/api/core'
import { fmtDateTime } from '@/domain/calendar'
import { Badge, Button, Callout, Card, CardHeader, ErrorState, SkeletonRows, useReadOnly } from '@/ui'
import { CalendarLine, CostingEditor } from './CostingEditor'
import { draftFromPreview, draftToInput, useCostingPreview, type CostingDraft } from './costingDraft'

export function PlannedCostingCard({ d }: { d: ProjectDetail }) {
  const readOnly = useReadOnly()
  const people = usePeopleMap()
  const q = useApi(['project', d.project.id, 'costing'], () => costingApi.get(d.project.id))
  const [draft, setDraft] = useState<CostingDraft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  useEffect(() => {
    if (q.data && !dirty) setDraft(draftFromPreview(q.data.preview))
  }, [q.data, dirty])
  const editable = !!q.data?.can_edit && !readOnly
  const input = useMemo(() => (draft && dirty ? { project_id: d.project.id, start_on: d.project.start_on, end_on: d.project.end_on, ...draftToInput(draft) } : null), [draft, dirty, d.project.id, d.project.start_on, d.project.end_on])
  const live = useCostingPreview(input, dirty)
  const preview = dirty ? live.data ?? q.data?.preview : q.data?.preview
  const save = useMut(() => costingApi.save(d.project.id, draftToInput(draft!)), {
    invalidate: [['project', d.project.id], ['projects'], ['margins'], ['costing-preview']],
    success: 'Planned costing saved',
    onSuccess: (p) => {
      setDirty(false)
      setErrors({})
      setDraft(draftFromPreview(p))
    },
    onError: (e: ApiError) => e.field && setErrors({ [e.field]: e.message }),
  })

  if (q.isLoading) return <Card><SkeletonRows rows={4} /></Card>
  if (q.error || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>
  const t = preview?.totals
  const savedBy = q.data.preview.saved_by ? people.get(q.data.preview.saved_by)?.name : null
  return (
    <Card>
      <CardHeader
        title={<span className="inline-flex flex-wrap items-center gap-2">Planned costing {dirty && <Badge size="sm" tone="warning">Unsaved changes</Badge>}</span>}
        subtitle={q.data.preview.saved_at ? `Saved ${fmtDateTime(q.data.preview.saved_at)}${savedBy ? ` by ${savedBy}` : ''}. Resource rows are this project’s allocations.` : 'Not saved yet. Resource rows are this project’s allocations; add costs, contingency and markup, then save.'}
      />
      <CalendarLine className="mb-4" preview={preview} manDays={t ? { total: t.man_days, rows: t.resource_rows } : null} />
      {Object.keys(errors).length > 0 && <Callout tone="danger" className="mb-3">{Object.values(errors)[0]}</Callout>}
      {draft && (
        <CostingEditor
          draft={draft}
          readOnly={!editable}
          preview={preview}
          errors={errors}
          loading={live.isFetching}
          onChange={(x) => {
            setDraft(x)
            setDirty(true)
            setErrors({})
          }}
        />
      )}
      {editable && (
        <div className="mt-4 flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
          <Button disabled={!dirty || save.isPending} onClick={() => { setDirty(false); setErrors({}); setDraft(draftFromPreview(q.data!.preview)) }}>
            Discard changes
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate(undefined)}>
            Save costing
          </Button>
        </div>
      )}
    </Card>
  )
}
