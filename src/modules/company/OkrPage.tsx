import { useMemo, useState } from 'react'
import { ChevronRight, Plus, Trash2 } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { companyApi, METRIC_META, type KRMetric, type KRView, type ObjectiveView, type OkrView } from '@/api/company'
import { fmtDate, relTime } from '@/domain/calendar'
import { useSession } from '@/stores/session'
import {
  Avatar, Badge, Button, Callout, Card, DataTable, Dialog, EmptyState, ErrorState, Field, Input, PageHeader, PeoplePicker, Progress, Segmented, Select, Sheet, Skeleton, SkeletonRows, StatCard, StatusBadge, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { LEVEL_LABEL, OKR_STATUS, fmtKR, pct } from './shared'

type Level = 'company' | 'team' | 'person'

/** /okrs — company → team → personal objectives with live key results. */
export default function OkrPage() {
  const [period, setPeriod] = useState<string | undefined>(undefined)
  const [owner, setOwner] = useState('')
  const [view, setView] = useState<'tree' | 'list'>('tree')
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const ro = useReadOnly()
  const q = useApi(['okrs', period ?? 'current', owner], () => companyApi.okrs(period, owner || undefined))
  const d = q.data
  const opened = d?.objectives.find((o) => o.id === openId) ?? null

  return (
    <div>
      <PageHeader
        title="Goals & OKRs"
        subtitle={d ? `${d.period.label} · ${fmtDate(d.period.from)} – ${fmtDate(d.period.to)}${d.period.current ? ` · ${d.days_left} days left` : ''}` : 'Company, team and personal objectives with measurable key results.'}
        actions={
          <>
            {d && (
              <Select
                aria-label="Period"
                className="w-[200px]"
                value={d.period.label}
                onChange={(e) => setPeriod(e.target.value)}
                options={d.periods.map((p) => ({ value: p.label, label: p.current ? `${p.label} (now)` : p.label }))}
              />
            )}
            {!ro && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={!d}>
                New objective
              </Button>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[92px] rounded-lg" />)}</div>
          <SkeletonRows rows={6} className="mt-6" />
        </>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <Scorecard d={d} />
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Segmented value={view} onChange={setView} options={[{ value: 'tree', label: 'Alignment tree' }, { value: 'list', label: 'List' }]} />
            <Select aria-label="Owner" className="w-full sm:w-[220px]" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Everyone" options={d.owners.map((p) => ({ value: p.id, label: p.name }))} />
          </div>
          {!d.objectives.length ? (
            <Card pad={false} className="mt-4">
              <EmptyState
                title={owner ? 'No objectives for this person' : `No objectives for ${d.period.label}`}
                body={owner ? 'Try everyone, or another period.' : 'Start with two to four company objectives, then let teams and people align theirs.'}
                action={!ro && !owner ? <Button variant="primary" size="sm" onClick={() => setCreating(true)}>New objective</Button> : undefined}
              />
            </Card>
          ) : view === 'tree' ? (
            <Tree d={d} onOpen={setOpenId} flat={!!owner} />
          ) : (
            <ListView d={d} onOpen={setOpenId} />
          )}
          <ObjectiveSheet o={opened} d={d} onClose={() => setOpenId(null)} />
          <NewObjectiveDialog open={creating} onOpenChange={setCreating} d={d} />
        </>
      ) : null}
    </div>
  )
}

/* ---------------- scorecard header ---------------- */
function Scorecard({ d }: { d: OkrView }) {
  const s = d.scorecard
  const attention = s.at_risk + s.off_track
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      <StatCard label="Overall progress" value={pct(s.progress)} sub={`${pct(d.elapsed)} of the period gone`} hint="Average progress of every key result, against the share of the period that has passed." />
      <StatCard label="Company objectives" value={pct(s.company_progress)} sub={`${d.objectives.filter((o) => o.level === 'company').length} objectives`} />
      <StatCard label="On track" value={s.on_track + s.done} tone={s.on_track + s.done ? 'success' : undefined} sub={s.done ? `${s.done} done` : `of ${s.objectives}`} />
      <StatCard label="Needs attention" value={attention} tone={s.off_track ? 'danger' : attention ? 'warning' : undefined} sub={`${s.at_risk} at risk · ${s.off_track} off track`} />
    </div>
  )
}

/* ---------------- tree ---------------- */
function Tree({ d, onOpen, flat }: { d: OkrView; onOpen: (id: string) => void; flat: boolean }) {
  const ids = new Set(d.objectives.map((o) => o.id))
  const kids = (id: string) => d.objectives.filter((o) => o.parent_id === id)
  const roots = flat ? d.objectives : d.objectives.filter((o) => !o.parent_id || !ids.has(o.parent_id))
  const aligned = roots.filter((o) => o.level === 'company')
  const loose = roots.filter((o) => o.level !== 'company')
  const node = (o: ObjectiveView, depth: number) => (
    <div key={o.id}>
      <ObjectiveCard o={o} onOpen={onOpen} />
      {!flat && kids(o.id).length > 0 && depth < 3 && (
        <div className="ml-3 mt-2 space-y-2 border-l border-line pl-3 md:ml-6 md:pl-5">
          {kids(o.id).map((c) => node(c, depth + 1))}
        </div>
      )}
    </div>
  )
  return (
    <div className="mt-4 space-y-3">
      {aligned.map((o) => node(o, 0))}
      {loose.length > 0 && (
        <>
          {!flat && <h2 className="pt-3 text-[13.5px] font-semibold text-ink-2">Not aligned to a company objective</h2>}
          {loose.map((o) => node(o, 0))}
        </>
      )}
    </div>
  )
}

function ObjectiveCard({ o, onOpen }: { o: ObjectiveView; onOpen: (id: string) => void }) {
  const st = OKR_STATUS[o.computed_status]
  return (
    <Card pad={false} className="overflow-hidden">
      <button type="button" onClick={() => onOpen(o.id)} className="flex w-full flex-col gap-3 px-4 py-3.5 text-left transition hover:bg-surface-2/50 md:flex-row md:items-center md:gap-5 md:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge size="sm">{LEVEL_LABEL[o.level]}</Badge>
            <StatusBadge map={OKR_STATUS} value={o.computed_status} size="sm" />
          </div>
          <div className="mt-1.5 text-[14.5px] font-semibold leading-snug text-ink">{o.title}</div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[12.5px] text-ink-3">
            {o.owner && <Avatar name={o.owner.name} hue={o.owner.hue} size={20} />}
            <span className="min-w-0 truncate">
              {o.owner?.name ?? '—'} · {o.key_results.length} key result{o.key_results.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-3 md:w-[220px]">
          <Progress value={o.progress ?? 0} tone={st.tone === 'brand' ? 'brand' : st.tone} className="flex-1" />
          <span className="tnum w-10 shrink-0 text-right text-[14px] font-semibold">{pct(o.progress)}</span>
          <ChevronRight className="hidden size-4 shrink-0 text-ink-3 md:block" />
        </div>
      </button>
      {o.key_results.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {o.key_results.map((k) => <KRRow key={k.id} k={k} />)}
        </div>
      )}
    </Card>
  )
}

function KRRow({ k, withCheckIn }: { k: KRView; withCheckIn?: boolean }) {
  const [open, setOpen] = useState(false)
  const ro = useReadOnly()
  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 md:flex-row md:items-center md:gap-5 md:px-5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-snug text-ink">{k.title}</div>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-ink-3">
          <span>{k.auto ? `Auto · ${METRIC_META[k.metric].label}` : 'Manual'}</span>
          {k.owner && <span className="truncate">· {k.owner.name}</span>}
        </div>
      </div>
      <div className="grid w-full shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 md:flex md:w-[340px]">
        <span className="tnum min-w-0 truncate whitespace-nowrap text-[12.5px] text-ink-2 md:w-[150px] md:shrink-0 md:text-right">
          {k.redacted ? 'Hidden' : k.target < k.start_value ? `${fmtKR(k, k.current)} · target ${fmtKR(k, k.target)}` : `${fmtKR(k, k.current)} of ${fmtKR(k, k.target)}`}
        </span>
        <span className="tnum text-right text-[12.5px] font-medium md:order-last md:w-9 md:shrink-0">{pct(k.progress)}</span>
        <div className="col-span-2 md:min-w-0 md:flex-1"><Progress value={k.progress ?? 0} tone="brand" height={5} /></div>
      </div>
      {withCheckIn && k.can_check_in && !ro && (
        <>
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)} className="self-end md:self-auto">Check in</Button>
          <CheckInDialog k={k} open={open} onOpenChange={setOpen} />
        </>
      )}
    </div>
  )
}

/* ---------------- list ---------------- */
function ListView({ d, onOpen }: { d: OkrView; onOpen: (id: string) => void }) {
  const cols: Column<ObjectiveView>[] = [
    { key: 'title', header: 'Objective', cell: (o) => <div className="min-w-0"><div className="truncate font-medium text-ink">{o.title}</div>{o.parent_title && <div className="truncate text-[12.5px] text-ink-3">Aligned to {o.parent_title}</div>}</div>, sortValue: (o) => o.title },
    { key: 'level', header: 'Level', cell: (o) => LEVEL_LABEL[o.level], sortValue: (o) => ({ company: 0, team: 1, person: 2 })[o.level], hideBelow: 'lg' },
    { key: 'owner', header: 'Owner', cell: (o) => <span className="whitespace-nowrap">{o.owner?.name ?? '—'}</span>, sortValue: (o) => o.owner?.name ?? '' },
    { key: 'krs', header: 'KRs', align: 'right', cell: (o) => <span className="tnum">{o.key_results.length}</span>, sortValue: (o) => o.key_results.length, hideBelow: 'xl' },
    { key: 'progress', header: 'Progress', align: 'right', cell: (o) => <span className="tnum whitespace-nowrap font-medium">{pct(o.progress)}</span>, sortValue: (o) => o.progress ?? -1 },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge map={OKR_STATUS} value={o.computed_status} size="sm" />, sortValue: (o) => o.computed_status },
  ]
  return (
    <div className="mt-4">
      <DataTable
        rows={d.objectives}
        columns={cols}
        rowKey={(o) => o.id}
        onRowClick={(o) => onOpen(o.id)}
        mobileCard={(o) => (
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-[14px] font-medium leading-snug">{o.title}</div>
              <StatusBadge map={OKR_STATUS} value={o.computed_status} size="sm" />
            </div>
            <div className="mt-1 text-[12.5px] text-ink-3">{LEVEL_LABEL[o.level]} · {o.owner?.name ?? '—'}</div>
            <div className="mt-2 flex items-center gap-3">
              <Progress value={o.progress ?? 0} className="flex-1" />
              <span className="tnum w-10 text-right text-[13px] font-semibold">{pct(o.progress)}</span>
            </div>
          </div>
        )}
      />
    </div>
  )
}

/* ---------------- objective detail sheet ---------------- */
function ObjectiveSheet({ o, d, onClose }: { o: ObjectiveView | null; d: OkrView; onClose: () => void }) {
  const ro = useReadOnly()
  const { confirm } = useConfirm()
  const [adding, setAdding] = useState(false)
  const inv = [['okrs']]
  const done = useMut((v: 'done' | 'on_track') => companyApi.updateObjective(o!.id, { status: v }, o!.version), { invalidate: inv, success: (_, v) => (v === 'done' ? 'Objective marked done' : 'Objective reopened') })
  const align = useMut((pid: string | null) => companyApi.updateObjective(o!.id, { parent_id: pid }, o!.version), { invalidate: inv, success: 'Alignment saved' })
  const del = useMut(() => companyApi.deleteObjective(o!.id), { invalidate: inv, success: 'Objective deleted', onSuccess: onClose })
  const delKR = useMut((id: string) => companyApi.deleteKR(id), { invalidate: inv, success: 'Key result removed' })
  if (!o) return <Sheet open={false} onOpenChange={() => onClose()} title=""><div /></Sheet>
  const parents = d.objectives.filter((p) => p.id !== o.id && (o.level === 'team' ? p.level === 'company' : o.level === 'person' ? p.level !== 'person' : false))
  const canEdit = o.can_edit && !ro
  return (
    <Sheet
      open={!!o}
      onOpenChange={(v) => !v && onClose()}
      width={640}
      title={o.title}
      subtitle={`${LEVEL_LABEL[o.level]} objective · ${o.period} · ${o.owner?.name ?? '—'}`}
      footer={
        canEdit ? (
          <>
            <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={async () => (await confirm({ title: 'Delete this objective?', body: 'Its key results and their check-ins go with it.', confirmLabel: 'Delete', tone: 'danger' })) && del.mutate(undefined)} className="mr-auto">Delete</Button>
            {o.status === 'done' ? <Button onClick={() => done.mutate('on_track')} loading={done.isPending}>Reopen</Button> : <Button onClick={() => done.mutate('done')} loading={done.isPending}>Mark done</Button>}
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} disabled={o.key_results.length >= 6}>Add key result</Button>
          </>
        ) : undefined
      }
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-line px-3 py-2.5"><div className="text-[12px] text-ink-3">Progress</div><div className="tnum mt-0.5 text-[18px] font-semibold">{pct(o.progress)}</div></div>
        <div className="rounded-lg border border-line px-3 py-2.5"><div className="text-[12px] text-ink-3">Expected by now</div><div className="tnum mt-0.5 text-[18px] font-semibold">{pct(o.expected)}</div></div>
        <div className="col-span-2 rounded-lg border border-line px-3 py-2.5 sm:col-span-1"><div className="text-[12px] text-ink-3">Status</div><div className="mt-1"><StatusBadge map={OKR_STATUS} value={o.computed_status} /></div></div>
      </div>
      <p className="mt-2 text-[12px] text-ink-3">On track when progress is at least 90% of what the time elapsed implies; at risk from 60%.</p>

      {o.level !== 'company' && (
        <Field label="Aligned to" className="mt-4">
          <Select value={o.parent_id ?? ''} disabled={!canEdit || align.isPending} onChange={(e) => align.mutate(e.target.value || null)} placeholder="Not aligned" options={parents.map((p) => ({ value: p.id, label: `${LEVEL_LABEL[p.level]}: ${p.title}` }))} />
        </Field>
      )}

      <h3 className="mb-2 mt-6 text-[13.5px] font-semibold text-ink-2">Key results</h3>
      {!o.key_results.length ? (
        <Callout tone="neutral">No key results yet. Add two to five measurable outcomes.</Callout>
      ) : (
        <div className="space-y-3">
          {o.key_results.map((k) => (
            <div key={k.id} className="overflow-hidden rounded-lg border border-line">
              <KRRow k={k} withCheckIn />
              <div className="border-t border-line bg-surface-2/40 px-4 py-2.5 text-[12.5px] text-ink-3 md:px-5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {k.redacted ? <span>Figures are visible to finance roles only.</span> : <span>Start {fmtKR(k, k.start_value)} · target {fmtKR(k, k.target)}</span>}
                  {k.basis && <span>{k.basis}</span>}
                  {k.forecast !== null && k.forecast !== undefined && <span>Scheduled by period end: {fmtKR(k, k.forecast)}</span>}
                  {canEdit && <button type="button" className="ml-auto inline-flex h-8 items-center text-[12.5px] font-medium text-danger-text hover:underline" onClick={() => delKR.mutate(k.id)}>Remove</button>}
                </div>
                {k.checkins.length > 0 && (
                  <ul className="mt-2 space-y-1.5 border-t border-line pt-2">
                    {k.checkins.slice(0, 5).map((c) => (
                      <li key={c.id} className="text-[12.5px] leading-snug">
                        <span className="text-ink-2">{c.summary}</span>
                        <span className="text-ink-3"> — {c.by}, {relTime(c.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <AddKRDialog open={adding} onOpenChange={setAdding} o={o} />
    </Sheet>
  )
}

/* ---------------- dialogs ---------------- */
function NewObjectiveDialog({ open, onOpenChange, d }: { open: boolean; onOpenChange: (o: boolean) => void; d: OkrView }) {
  const me = useSession((s) => s.user)
  const levels = (['company', 'team', 'person'] as Level[]).filter((l) => d.can[l])
  const [level, setLevel] = useState<Level>(levels.includes('company') ? 'company' : 'person')
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState<string | null>(me?.id ?? null)
  const [parent, setParent] = useState('')
  const [touched, setTouched] = useState(false)
  const parents = useMemo(() => d.objectives.filter((p) => (level === 'team' ? p.level === 'company' : level === 'person' ? p.level !== 'person' : false)), [d.objectives, level])
  const m = useMut(() => companyApi.createObjective({ title: title.trim(), level, owner_id: owner ?? me!.id, period: d.period.label, parent_id: parent || null }), {
    invalidate: [['okrs']],
    success: 'Objective added',
    onSuccess: () => {
      onOpenChange(false)
      setTitle('')
      setParent('')
      setTouched(false)
    },
  })
  const bad = title.trim().length < 3
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New objective"
      description={`For ${d.period.label}. Add key results after saving.`}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => (setTouched(true), !bad && m.mutate(undefined))}>Add objective</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Level" required>
          <Segmented block value={level} onChange={(v) => (setLevel(v), setParent(''))} options={levels.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} />
        </Field>
        <Field label="Objective" required error={touched && bad ? 'Write at least 3 characters.' : null} hint="Qualitative and ambitious, e.g. “Make delivery predictable for every client”.">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} invalid={touched && bad} placeholder="What do we want to achieve?" />
        </Field>
        {level !== 'company' && (
          <>
            <Field label="Owner">
              <PeoplePicker value={owner} onChange={setOwner} />
            </Field>
            <Field label="Aligned to" hint="Link it to the objective it moves forward.">
              <Select value={parent} onChange={(e) => setParent(e.target.value)} placeholder="Not aligned" options={parents.map((p) => ({ value: p.id, label: `${LEVEL_LABEL[p.level]}: ${p.title}` }))} />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  )
}

const METRIC_OPTIONS = (Object.keys(METRIC_META) as KRMetric[]).map((k) => ({ value: k, label: k === 'manual' ? 'Manual — I check in' : `Auto — ${METRIC_META[k].label}` }))
function AddKRDialog({ open, onOpenChange, o }: { open: boolean; onOpenChange: (v: boolean) => void; o: ObjectiveView }) {
  const [title, setTitle] = useState('')
  const [metric, setMetric] = useState<KRMetric>('manual')
  const [start, setStart] = useState('0')
  const [target, setTarget] = useState('')
  const [unit, setUnit] = useState('')
  const [owner, setOwner] = useState<string | null>(o.owner_id)
  const [touched, setTouched] = useState(false)
  const meta = METRIC_META[metric]
  const isMoney = meta.kind === 'money'
  const toStore = (v: string) => (isMoney ? Math.round(Number(v) * 100) : Number(v)) // rupees → paise for money metrics
  const m = useMut(() => companyApi.addKR(o.id, { title: title.trim(), metric, start_value: toStore(start || '0'), target: toStore(target), unit: metric === 'manual' ? unit.trim() : meta.unit, owner_id: owner ?? o.owner_id }), {
    invalidate: [['okrs']],
    success: 'Key result added',
    onSuccess: () => {
      onOpenChange(false)
      setTitle('')
      setTarget('')
      setTouched(false)
    },
  })
  const bad = { title: title.trim().length < 3, target: target === '' || !Number.isFinite(Number(target)) || Number(target) === Number(start || 0) }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add key result"
      description={o.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => (setTouched(true), !bad.title && !bad.target && m.mutate(undefined))}>Add key result</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Key result" required error={touched && bad.title ? 'Write at least 3 characters.' : null}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} invalid={touched && bad.title} placeholder="e.g. 90% of milestones invoiced within 3 days" />
        </Field>
        <Field label="Measured by" hint={metric === 'manual' ? 'The owner checks in with the current value and a note.' : `Calculated from live data for the ${o.level === 'company' ? 'whole company' : o.level === 'team' ? 'owner’s team' : 'owner'} over ${o.period}.`}>
          <Select value={metric} onChange={(e) => setMetric(e.target.value as KRMetric)} options={METRIC_OPTIONS} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Start${isMoney ? ' (₹)' : meta.kind === 'percent' ? ' (%)' : ''}`}>
            <Input type="number" inputMode="decimal" value={start} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label={`Target${isMoney ? ' (₹)' : meta.kind === 'percent' ? ' (%)' : ''}`} required error={touched && bad.target ? 'Enter a target different from the start.' : null}>
            <Input type="number" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} invalid={touched && bad.target} />
          </Field>
        </div>
        {metric === 'manual' && (
          <Field label="Unit" hint="e.g. %, leads, demos, reviews">
            <Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={16} />
          </Field>
        )}
        <Field label="Owner">
          <PeoplePicker value={owner} onChange={setOwner} />
        </Field>
      </div>
    </Dialog>
  )
}

function CheckInDialog({ k, open, onOpenChange }: { k: KRView; open: boolean; onOpenChange: (v: boolean) => void }) {
  const isMoney = k.kind === 'money'
  const [value, setValue] = useState(String(isMoney ? (k.current ?? 0) / 100 : k.current ?? ''))
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)
  const m = useMut(() => companyApi.checkIn(k.id, isMoney ? Math.round(Number(value) * 100) : Number(value), note.trim(), k.version), {
    invalidate: [['okrs']],
    success: 'Check-in saved',
    onSuccess: () => {
      onOpenChange(false)
      setNote('')
      setTouched(false)
    },
  })
  const bad = { value: value === '' || !Number.isFinite(Number(value)), note: note.trim().length < 5 }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Check in"
      description={k.title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => (setTouched(true), !bad.value && !bad.note && m.mutate(undefined))}>Save check-in</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={`Current value${k.unit ? ` (${k.unit})` : ''}`} required hint={`Was ${fmtKR(k, k.current)}; target ${fmtKR(k, k.target)}.`} error={touched && bad.value ? 'Enter a number.' : null}>
          <Input type="number" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} invalid={touched && bad.value} />
        </Field>
        <Field label="What changed" required error={touched && bad.note ? 'Write at least 5 characters.' : null}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} invalid={touched && bad.note} placeholder="e.g. Two more BNI referrals qualified this week." />
        </Field>
      </div>
    </Dialog>
  )
}

