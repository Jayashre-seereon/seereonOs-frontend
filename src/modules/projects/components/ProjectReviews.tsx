// Project task reviews (v3): on-time delivery for the project and tasks waiting for review.
import { useState } from 'react'
import type { ProjectDetail } from '@/api/projects'
import { usePeopleMap } from '@/api/core'
import { useUI } from '@/stores/ui'
import { fmtDate } from '@/domain/calendar'
import { fmtNum, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, CardHeader, useReadOnly } from '@/ui'
import { ReviewDialog } from '@/modules/work/taskReview'
import { TimelinessSplit, fmtSlip, pctTone, slipTone } from '@/modules/work/taskDelivery'

export function ProjectReviews({ d }: { d: ProjectDetail }) {
  const dl = d.delivery
  const people = usePeopleMap()
  const openTask = useUI((s) => s.openTask)
  const ro = useReadOnly()
  const [act, setAct] = useState<{ id: string; title: string; wbs: string; due_on: string } | null>(null)
  if (!dl) return null
  return (
    <Card>
      <CardHeader title="Task delivery" subtitle={dl.completed ? `${dl.completed} tasks approved on this project` : 'No approved tasks yet'} />
      <div className="grid grid-cols-3 gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-ink-3">On time</div>
          <div className={cn('tnum mt-0.5 text-[18px] font-semibold', pctTone(dl.on_time_pct))}>{fmtPct(dl.on_time_pct, 0)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[12px] text-ink-3">Avg slip</div>
          <div className={cn('tnum mt-0.5 text-[18px] font-semibold', slipTone(dl.avg_variance_days))}>{fmtSlip(dl.avg_variance_days)}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[12px] text-ink-3">Quality</div>
          <div className="tnum mt-0.5 text-[18px] font-semibold">{dl.avg_quality ? `${fmtNum(dl.avg_quality, 1)}/5` : '—'}</div>
        </div>
      </div>
      <TimelinessSplit s={dl} className="mt-3" />
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold text-ink">Waiting for review</span>
          <span className="tnum text-[12.5px] text-ink-3">{dl.awaiting_review.length}</span>
        </div>
        {dl.awaiting_review.length ? (
          <ul className="-mx-1.5 space-y-0.5">
            {dl.awaiting_review.map((t) => (
              <li key={t.id} className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1.5 hover:bg-surface-2">
                <button type="button" onClick={() => openTask(t.id)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] text-ink"><span className="tnum mr-1 text-ink-3">{t.wbs}</span>{t.title}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    {people.get(t.owner_id)?.name ?? '—'} · sent {fmtDate(t.submitted_on)}{t.round > 1 ? ` · round ${t.round}` : ''}
                  </span>
                </button>
                {t.late && <Badge size="sm" tone="danger">Late</Badge>}
                {t.can_review && !ro && (
                  <Button size="xs" variant="secondary" className="shrink-0" onClick={() => setAct({ id: t.id, title: t.title, wbs: t.wbs, due_on: t.due_on })}>
                    Review
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-3">Nothing waiting. Submitted tasks appear here until the reviewer decides.</p>
        )}
      </div>
      <ReviewDialog mode="approve" open={!!act} onOpenChange={(o) => !o && setAct(null)} task={act} />
    </Card>
  )
}
