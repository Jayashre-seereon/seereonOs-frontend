// UI-28 Deal page: stage stepper, key facts, merged timeline, activity composer, linked project.
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowRight, Calculator, FileText, Mail, MessageSquareText, MoreHorizontal, Pencil, Phone, Presentation, Repeat, Trash2, Users } from '@/ui/icons'
import {
  Badge, Button, Callout, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, KV, Menu, Money, PageHeader, PersonName, Segmented, Skeleton, SkeletonRows, StatusBadge, Textarea, useCan, useConfirm, useReadOnly,
} from '@/ui'
import { useMut } from '@/api/query'
import { SALES_INVALIDATE, salesApi, useDeal, type DealView, type TimelineItem } from '@/api/sales'
import { ACTIVITY_TYPE, DEAL_SOURCE, DEAL_STAGE, PROJECT_STATUS } from '@/domain/labels'
import { fmtMoney, fmtPct } from '@/domain/money'
import { addDays, fmtDate, fmtDateTime, todayISO } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import type { ActivityType, DealStage } from '@/types/entities'
import { CreateProjectDialog, DealFormDialog, Metric, StageStepper, StaleBadge, isClosedStage, useStageMover } from './components'

const ACT_ICON: Record<ActivityType, typeof Phone> = { call: Phone, meeting: Users, demo: Presentation, email: Mail, proposal: FileText, follow_up: Repeat, whatsapp: MessageSquareText }

export default function DealPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const q = useDeal(id)
  const can = useCan()
  const readOnly = useReadOnly()
  const isAdmin = can('deals.edit_all')
  const { confirm } = useConfirm()
  const [edit, setEdit] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const mover = useStageMover({ onWon: (d) => isAdmin && !d.project_id && setProjectOpen(true) })
  const del = useMut((v: { id: string; version: number }) => salesApi.remove(v.id, v.version), { invalidate: SALES_INVALIDATE, success: 'Deal deleted', onSuccess: () => nav('/sales') })

  if (q.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-16 w-full rounded-lg" />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-lg border border-line bg-surface p-5 lg:col-span-2"><SkeletonRows rows={5} /></div>
          <div className="rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={3} /></div>
        </div>
      </div>
    )
  if (q.error || !q.data)
    return (
      <div>
        <PageHeader title="Deal" back={{ to: '/sales', label: 'Pipeline' }} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    )
  const { deal, timeline } = q.data
  const closed = isClosedStage(deal.stage)
  // Server-computed: own deal (or deals.edit_all) and not closed (unless deals.edit_all).
  const lockedForMe = readOnly || !q.data.can_edit
  const remove = async () => {
    const ok = await confirm({ title: `Delete “${deal.title}”?`, body: 'The deal, its activities and stage history are removed. A linked project stays but loses the link. This cannot be undone.', confirmLabel: 'Delete deal', tone: 'danger' })
    if (ok) del.mutate({ id: deal.id, version: deal.version })
  }

  return (
    <div>
      <PageHeader
        back={{ to: '/sales', label: 'Pipeline' }}
        eyebrow={deal.client}
        title={deal.title}
        meta={
          <>
            <StatusBadge map={DEAL_STAGE} value={deal.stage} />
            {deal.stale && <StaleBadge days={deal.days_since_activity} />}
            <Badge tone="neutral" size="md">{deal.product}</Badge>
            <span className="text-[12.5px] text-ink-3">via {DEAL_SOURCE[deal.source]}</span>
          </>
        }
        actions={
          <>
            <Button icon={<Pencil className="size-4" />} onClick={() => setEdit(true)} disabled={lockedForMe} className="flex-1 md:flex-none">
              Edit
            </Button>
            {can('estimates.manage') && !deal.project_id && (
              <Button icon={<Calculator className="size-4" />} onClick={() => nav(`/projects/cost-calculator/new?deal=${deal.id}`)} disabled={readOnly} className="flex-1 md:flex-none">
                Estimate cost
              </Button>
            )}
            {q.data.can_create_project && (
              <Button variant="primary" onClick={() => setProjectOpen(true)} disabled={readOnly} className="flex-1 md:flex-none">
                Create project
              </Button>
            )}
            {isAdmin && (
              <Menu
                label="More actions"
                trigger={
                  <IconButton label="More actions" variant="secondary" disabled={readOnly}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
                items={[{ label: 'Delete deal', icon: <Trash2 />, danger: true, onSelect: remove }]}
              />
            )}
          </>
        }
      />

      <Card className="mb-4">
        <StageStepper deal={deal} disabled={lockedForMe || mover.pending} onMove={(s: DealStage) => mover.move(deal, s)} />
        {closed && !isAdmin && <p className="mt-3 text-[12.5px] text-ink-3">This deal is closed. Only an admin can reopen it.</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <FactsCard deal={deal} />
          {!closed && !readOnly && <Composer deal={deal} />}
          <Timeline items={timeline} />
        </div>
        <div className="min-w-0 space-y-4">
          <ProjectCard deal={deal} canCreate={q.data.can_create_project && !readOnly} onCreate={() => setProjectOpen(true)} />
          <Card>
            <CardHeader title="Contact" />
            <KV
              cols={1}
              items={[
                { label: 'Person', value: deal.contact || <span className="text-ink-3">Not recorded</span> },
                { label: 'Phone', value: deal.phone ? <a className="text-brand-text hover:underline" href={`tel:${deal.phone.replace(/\s/g, '')}`}>{deal.phone}</a> : <span className="text-ink-3">—</span> },
                { label: 'Email', value: deal.email ? <a className="break-all text-brand-text hover:underline" href={`mailto:${deal.email}`}>{deal.email}</a> : <span className="text-ink-3">—</span> },
                { label: 'Owner', value: <PersonName id={deal.owner_id} /> },
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="How the lead came in" subtitle={`${DEAL_SOURCE[deal.source]} · ${fmtDate(deal.opened_on)}`} />
            {deal.first_conversation ? (
              <p className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{deal.first_conversation}</p>
            ) : (
              <p className="text-[13px] text-ink-3">The first conversation wasn’t recorded.{!lockedForMe && ' Edit the deal to add it.'}</p>
            )}
          </Card>
          {deal.notes && (
            <Card>
              <CardHeader title="Notes" />
              <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink-2">{deal.notes}</p>
            </Card>
          )}
        </div>
      </div>

      <DealFormDialog open={edit} onOpenChange={setEdit} deal={deal} />
      <CreateProjectDialog deal={deal} open={projectOpen} onOpenChange={setProjectOpen} />
    </div>
  )
}

function FactsCard({ deal }: { deal: DealView }) {
  const closed = isClosedStage(deal.stage)
  const overdueClose = !closed && deal.expected_close < todayISO()
  return (
    <Card>
      <CardHeader title="Deal summary" />
      <div className="mb-4 rounded-md border border-line bg-surface-2 px-3.5 py-3">
        <div className="text-[12px] text-ink-3">Deal value</div>
        <div className="tnum mt-0.5 text-[20px] font-semibold leading-tight text-ink">{fmtMoney(deal.deal_value_paise)}</div>
        <div className="tnum mt-1 text-[12.5px] text-ink-2">
          = one-time {fmtMoney(deal.value_paise)} + 12 × {fmtMoney(deal.mrr_paise)} recurring per month
        </div>
        <p className="mt-1 text-[12px] text-ink-3">This is the value used for the pipeline, targets, achievement and sales variable pay.</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        <Metric label="One-time value"><Money value={deal.value_paise} /></Metric>
        <Metric label="Recurring">{deal.mrr_paise ? `${fmtMoney(deal.mrr_paise)}/mo` : '—'}</Metric>
        <Metric label={`Weighted (${fmtPct(deal.probability, 0)})`}><Money value={deal.weighted_paise} /></Metric>
        <Metric label={deal.stage === 'won' ? 'Won on' : deal.stage === 'lost' ? 'Lost on' : 'Expected close'}>
          <span className={cn(overdueClose && 'text-danger-text')}>{fmtDate(deal.won_on ?? deal.lost_on ?? deal.expected_close)}</span>
        </Metric>
        <Metric label="In pipeline">{deal.days_in_pipeline} days</Metric>
        <Metric label="In this stage">{deal.days_in_stage} days</Metric>
        <Metric label="Created by"><span className="font-medium">{deal.created_by_name}</span></Metric>
        <Metric label="Lead since">{fmtDate(deal.opened_on)}</Metric>
        <Metric label="Last activity">{fmtDate(deal.last_activity_on)}</Metric>
      </div>
      {(deal.next_step || deal.stale) && !closed && (
        <div className="mt-4 space-y-2">
          {deal.next_step && (
            <Callout tone={deal.next_step_overdue ? 'danger' : 'neutral'} title={deal.next_step_overdue ? 'Next step overdue' : 'Next step'}>
              {deal.next_step}
              {deal.next_step_on && <> · by {fmtDate(deal.next_step_on)}</>}
            </Callout>
          )}
          {deal.stale && (
            <Callout tone="warning" title={`No activity for ${deal.days_since_activity} days`}>
              Log a call or follow-up to keep it moving. Stale deals are flagged to the owner every day.
            </Callout>
          )}
        </div>
      )}
      {overdueClose && <p className="mt-3 text-[12.5px] text-danger-text">The expected close date has passed — update it or move the deal.</p>}
    </Card>
  )
}

function Composer({ deal }: { deal: DealView }) {
  const [type, setType] = useState<ActivityType>('call')
  const [note, setNote] = useState('')
  const [date, setDate] = useState(todayISO())
  const [next, setNext] = useState('')
  const [nextOn, setNextOn] = useState(addDays(todayISO(), 2))
  const [err, setErr] = useState<string | null>(null)
  const mut = useMut((v: { type: ActivityType; note: string; date: string; next_step?: string; next_step_on?: string | null }) => salesApi.logActivity(deal.id, v), {
    invalidate: SALES_INVALIDATE,
    success: 'Activity logged',
    onSuccess: () => {
      setNote('')
      setNext('')
      setErr(null)
    },
    onError: (e) => e.field === 'note' && setErr(e.message),
  })
  const submit = () => {
    if (note.trim().length < 3) return setErr('Write what happened (at least 3 characters).')
    mut.mutate({ type, note: note.trim(), date, ...(next.trim() ? { next_step: next.trim(), next_step_on: nextOn } : {}) })
  }
  return (
    <Card>
      <CardHeader title="Log activity" subtitle="Keeps the deal fresh and feeds the performance numbers." />
      <Segmented
        block
        size="sm"
        value={type}
        onChange={setType}
        className="mb-3"
        options={(Object.keys(ACTIVITY_TYPE) as ActivityType[]).map((t) => {
          const I = ACT_ICON[t]
          return { value: t, label: <span className="inline-flex items-center gap-1" title={ACTIVITY_TYPE[t]}><I className="size-3.5 sm:hidden" aria-label={ACTIVITY_TYPE[t]} /><span className="hidden sm:inline">{ACTIVITY_TYPE[t]}</span></span> }
        })}
      />
      <Field error={err}>
        <Textarea
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
            if (err) setErr(null)
          }}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && submit()}
          placeholder={`What happened on the ${ACTIVITY_TYPE[type].toLowerCase()}?`}
          rows={2}
          invalid={!!err}
        />
      </Field>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(150px,1fr)_minmax(0,2fr)_minmax(150px,1fr)]">
        <Field label="Date">
          <Input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Next step (optional)" className="sm:col-span-2 xl:col-span-1 xl:order-none">
          <Input value={next} onChange={(e) => setNext(e.target.value)} placeholder={deal.next_step ?? 'e.g. Send revised proposal'} />
        </Field>
        <Field label="By">
          <Input type="date" value={nextOn} onChange={(e) => setNextOn(e.target.value)} disabled={!next.trim()} />
        </Field>
      </div>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" loading={mut.isPending} onClick={submit} className="w-full sm:w-auto">
          Log {ACTIVITY_TYPE[type].toLowerCase()}
        </Button>
      </div>
    </Card>
  )
}

function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <Card>
      <CardHeader title="Timeline" subtitle={`${items.length} ${items.length === 1 ? 'event' : 'events'} · newest first`} />
      {!items.length ? (
        <EmptyState title="Nothing logged yet" body="Stage changes and activities appear here." compact />
      ) : (
        <ol className="relative">
          {items.map((it, i) => {
            const last = i === items.length - 1
            if (it.kind === 'stage') {
              const dot = it.to_stage === 'won' ? 'border-success bg-success' : it.to_stage === 'lost' ? 'border-danger bg-danger' : 'border-line-strong bg-surface'
              return (
                <li key={it.id} className="relative flex gap-3 pb-4 last:pb-0">
                  {!last && <span className="absolute bottom-0 left-[5px] top-4 w-px bg-line" />}
                  <span className={cn('mt-[5px] size-[11px] shrink-0 rounded-full border-2', dot)} />
                  <div className="min-w-0">
                    <p className="text-[13.5px] text-ink">
                      {it.from_stage ? (
                        <>Stage changed from <span className="font-medium">{DEAL_STAGE[it.from_stage].label}</span> to <span className="font-medium">{DEAL_STAGE[it.to_stage].label}</span></>
                      ) : (
                        <>New lead created in <span className="font-medium">{DEAL_STAGE[it.to_stage].label}</span></>
                      )}
                    </p>
                    {it.reason && <p className="mt-0.5 text-[13px] text-ink-2">“{it.reason}”</p>}
                    <p className="mt-0.5 text-[12px] text-ink-3">{it.by_name} · {fmtDateTime(it.at)}</p>
                  </div>
                </li>
              )
            }
            const I = ACT_ICON[it.type]
            return (
              <li key={it.id} className="relative flex gap-3 pb-4 last:pb-0">
                {!last && <span className="absolute bottom-0 left-[5px] top-4 w-px bg-line" />}
                <span className="mt-[5px] size-[11px] shrink-0 rounded-full border-2 border-brand bg-surface" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-1.5 text-[13.5px]">
                    <I className="size-3.5 text-ink-3" />
                    <span className="font-medium text-ink">{ACTIVITY_TYPE[it.type]}</span>
                    <span className="text-[12.5px] text-ink-3">{it.by_name} · {fmtDate(it.date)}</span>
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[13.5px] leading-relaxed text-ink-2">{it.note}</p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Card>
  )
}

function ProjectCard({ deal, canCreate, onCreate }: { deal: DealView; canCreate: boolean; onCreate: () => void }) {
  if (deal.project)
    return (
      <Card>
        <CardHeader title="Project" />
        <Link to={`/projects/${deal.project.id}`} className="group flex items-center gap-3 rounded-md border border-line p-3 transition hover:bg-surface-2">
          <div className="min-w-0 flex-1">
            <div className="tnum text-[12px] text-ink-3">{deal.project.code}</div>
            <div className="truncate text-[14px] font-medium text-ink">{deal.project.name}</div>
          </div>
          <StatusBadge map={PROJECT_STATUS} value={deal.project.status} size="sm" />
          <ArrowRight className="size-4 shrink-0 text-ink-3" />
        </Link>
      </Card>
    )
  if (deal.stage !== 'won') return null
  return (
    <Card>
      <CardHeader title="Project" />
      <p className="text-[13.5px] text-ink-2">Won deals turn into delivery projects. Create it so hours, milestones and invoices tie back to this sale.</p>
      {canCreate ? (
        <Button className="mt-3" block variant="primary" onClick={onCreate}>
          Create project
        </Button>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">An admin creates the project.</p>
      )}
    </Card>
  )
}

