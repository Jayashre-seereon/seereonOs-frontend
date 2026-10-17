// /recruitment — pipeline per opening (Applied → Hired/Rejected) with drag or "Move to", candidate sheet with
// resume, interviews and offer; hiring creates the invite and the onboarding checklist on the server.
import { useMemo, useState, type DragEvent } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight, Download, MoreHorizontal, Plus, UserPlus } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { hrApi, type CandidateDetail, type CandidateRow, type RecruitmentView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { addDays, fmtDate, fmtDateTime, relTime, todayISO } from '@/domain/calendar'
import { fmtMoneyCompact } from '@/domain/money'
import { cn } from '@/lib/utils'
import type { Candidate, CandidateStage, Interview } from '@/types/business'
import {
  Avatar, Badge, Button, Callout, Card, CardHeader, Dialog, EmptyState, ErrorState, Field, FileUpload, FilterChips, IconButton, Input, KV, Menu, MoneyInput, PageHeader, PeoplePicker, Segmented, Select, Sheet,
  SkeletonCards, SkeletonRows, StatCard, StatusBadge, Textarea, useConfirm, useReadOnly,
} from '@/ui'
import { CANDIDATE_STAGE, SOURCE, STAGES } from './components'

const INV = [['recruitment'], ['candidate'], ['lifecycle'], ['hr-dashboard']]
type MoveAsk = { c: CandidateRow; stage: 'offer' | 'hired' } | null

export default function RecruitmentPage() {
  const q = useApi(['recruitment'], hrApi.recruitment)
  const d = q.data
  const ro = useReadOnly()
  const [opening, setOpening] = useState<string>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [ask, setAsk] = useState<MoveAsk>(null)
  const move = useMoveCandidate(setAsk)
  const list = (d?.candidates ?? []).filter((c) => opening === 'all' || c.opening_id === opening)
  return (
    <div>
      <PageHeader
        title="Recruitment"
        subtitle="Candidates for each opening, from application to joining. Openings themselves are managed on the Openings page."
        actions={!ro && d && d.openings.length > 0 ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} className="w-full sm:w-auto">Add candidate</Button> : undefined}
      />
      {q.isLoading ? (
        <div className="space-y-4">
          <SkeletonCards n={4} />
          <SkeletonRows rows={6} />
        </div>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4 md:space-y-5">
          <Metrics d={d} />
          <FilterChips
            value={opening}
            onChange={setOpening}
            options={[{ value: 'all', label: 'All openings', count: d.candidates.length }, ...d.openings.map((o) => ({ value: o.id, label: `${o.role}${o.count > 1 ? ` × ${o.count}` : ''}`, count: o.candidates }))]}
          />
          {opening !== 'all' && <OpeningStrip d={d} id={opening} />}
          {!d.openings.length ? (
            <Card pad={false}>
              <EmptyState icon={<UserPlus />} title="No open positions" body="Create an opening first, then add candidates to it." action={<Link to="/openings" className="text-[13px] font-medium text-brand-text hover:underline">Go to Openings</Link>} />
            </Card>
          ) : (
            <Board rows={list} onOpen={setOpen} onMove={move} />
          )}
        </div>
      )}
      {open && <CandidateSheet id={open} onClose={() => setOpen(null)} onMove={move} />}
      {adding && d && <AddCandidateDialog openings={d.openings} defaultOpening={opening !== 'all' ? opening : d.openings[0]?.id} onClose={() => setAdding(false)} />}
      {ask && <MoveDialog ask={ask} onClose={() => setAsk(null)} />}
    </div>
  )
}

function Metrics({ d }: { d: RecruitmentView }) {
  const m = d.metrics
  const top = m.by_source[0]
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
      <StatCard label="Open positions" value={m.open_positions} sub={`${d.openings.length} opening${d.openings.length === 1 ? '' : 's'}`} />
      <StatCard label="Active candidates" value={m.active} sub={`${m.offers_out} offer${m.offers_out === 1 ? '' : 's'} out`} />
      <StatCard label="Time to hire" value={m.avg_time_to_hire === null ? '—' : `${m.avg_time_to_hire}d`} sub={m.hired_90 ? `${m.hired_90} hired in 90 days` : 'no hires yet'} hint="Average days from a candidate being added to being marked hired." />
      <StatCard label="Top source" value={top ? SOURCE[top.source] ?? top.source : '—'} sub={m.by_source.slice(0, 3).map((s) => `${SOURCE[s.source] ?? s.source} ${s.count}`).join(' · ') || 'no candidates'} />
    </div>
  )
}

function OpeningStrip({ d, id }: { d: RecruitmentView; id: string }) {
  const o = d.openings.find((x) => x.id === id)
  if (!o) return null
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-4 py-2.5 text-[13px]">
      <span className="font-semibold">{o.role}</span>
      <span className="text-ink-3">{o.project ?? 'General'}</span>
      <span className="text-ink-3">Owner {o.owner_name}</span>
      {o.needed_by && <span className="text-ink-3">Needed by {fmtDate(o.needed_by)}</span>}
      <span className="tnum text-ink-3">{o.hired}/{o.count} hired</span>
    </div>
  )
}

/* ---------------- move logic ---------------- */
function useMoveCandidate(setAsk: (a: MoveAsk) => void) {
  const { askReason } = useConfirm()
  const m = useMut((v: { id: string; stage: CandidateStage; reason?: string }) => hrApi.moveCandidate(v.id, { stage: v.stage, reason: v.reason }), {
    invalidate: INV, success: (r) => `Moved to ${CANDIDATE_STAGE[r.stage].label.toLowerCase()}`,
  })
  return async (c: CandidateRow, stage: CandidateStage) => {
    if (stage === c.stage) return
    if (stage === 'offer' || stage === 'hired') return setAsk({ c, stage })
    if (stage === 'rejected') {
      const reason = await askReason({ title: `Reject ${c.name}?`, body: 'The reason is kept on the candidate record.', label: 'Reason', placeholder: 'e.g. Expected CTC above band; weak on test design', minLength: 5, confirmLabel: 'Reject candidate', tone: 'danger' })
      if (reason) m.mutate({ id: c.id, stage, reason })
      return
    }
    m.mutate({ id: c.id, stage })
  }
}

function MoveDialog({ ask, onClose }: { ask: NonNullable<MoveAsk>; onClose: () => void }) {
  const { c, stage } = ask
  const [ctc, setCtc] = useState<number>(c.offer_ctc_paise ?? c.expected_ctc_paise ?? 0)
  const [joining, setJoining] = useState(c.joining_on ?? addDays(todayISO(), Math.max(7, c.notice_days ?? 30)))
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => hrApi.moveCandidate(c.id, stage === 'offer' ? { stage, offer_ctc_paise: ctc || null } : { stage, joining_on: joining }), {
    invalidate: INV,
    success: stage === 'hired' ? `${c.name} hired — invite and onboarding checklist created` : 'Offer recorded',
    silentError: true,
    onSuccess: onClose,
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title={stage === 'offer' ? `Make an offer to ${c.name}` : `Mark ${c.name} as hired`}
      description={stage === 'offer' ? 'Needs at least one passed interview.' : 'Creates their account invite (employee) and an onboarding checklist from the joining date.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>{stage === 'offer' ? 'Record offer' : 'Mark hired'}</Button></>}
    >
      <div className="space-y-4">
        {stage === 'offer' ? (
          <Field label="Offered CTC (annual)" error={errs.offer_ctc_paise} hint={c.expected_ctc_paise ? `Expected ${fmtMoneyCompact(c.expected_ctc_paise)}` : undefined}>
            <MoneyInput value={ctc} onChange={setCtc} invalid={!!errs.offer_ctc_paise} />
          </Field>
        ) : (
          <Field label="Joining date" required error={errs.joining_on} hint={c.notice_days ? `Notice period ${c.notice_days} days` : undefined}>
            <Input type="date" value={joining} invalid={!!errs.joining_on} onChange={(e) => setJoining(e.target.value)} />
          </Field>
        )}
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

/* ---------------- board ---------------- */
function Board({ rows, onOpen, onMove }: { rows: CandidateRow[]; onOpen: (id: string) => void; onMove: (c: CandidateRow, s: CandidateStage) => void }) {
  const ro = useReadOnly()
  const [phoneStage, setPhoneStage] = useState<CandidateStage>('interview')
  const [over, setOver] = useState<CandidateStage | null>(null)
  const by = useMemo(() => {
    const m = new Map<CandidateStage, CandidateRow[]>(STAGES.map((s) => [s, []]))
    for (const c of rows) (m.get(c.stage === 'withdrawn' ? 'rejected' : c.stage) ?? []).push(c)
    return m
  }, [rows])
  const drop = (e: DragEvent, stage: CandidateStage) => {
    e.preventDefault()
    setOver(null)
    const id = e.dataTransfer.getData('text/candidate')
    const c = rows.find((x) => x.id === id)
    if (c && !ro) onMove(c, stage)
  }
  return (
    <>
      {/* phone: one stage at a time */}
      <div className="md:hidden">
        <Segmented block size="sm" value={phoneStage} onChange={setPhoneStage} options={STAGES.map((s) => ({ value: s, label: CANDIDATE_STAGE[s].label.slice(0, s === 'screening' ? 6 : s === 'interview' ? 5 : 9), count: by.get(s)!.length }))} />
        <div className="mt-3 space-y-2">
          {by.get(phoneStage)!.length ? by.get(phoneStage)!.map((c) => <CandidateCard key={c.id} c={c} onOpen={onOpen} onMove={onMove} />) : <p className="py-8 text-center text-[13px] text-ink-3">No candidates in {CANDIDATE_STAGE[phoneStage].label.toLowerCase()}.</p>}
        </div>
      </div>
      {/* tablet / desktop: kanban */}
      <div className="hidden overflow-x-auto pb-2 scroll-thin md:block">
        <div className="grid min-w-[1080px] grid-cols-6 gap-3">
          {STAGES.map((s) => (
            <section
              key={s}
              onDragOver={(e) => { if (!ro) { e.preventDefault(); setOver(s) } }}
              onDragLeave={() => setOver((o) => (o === s ? null : o))}
              onDrop={(e) => drop(e, s)}
              className={cn('flex min-h-[320px] min-w-0 flex-col rounded-lg border bg-surface-2/50 p-2', over === s ? 'border-brand bg-brand-soft/40' : 'border-line')}
              aria-label={CANDIDATE_STAGE[s].label}
            >
              <header className="flex items-center justify-between gap-2 px-1.5 pb-2 pt-1">
                <span className="text-[12.5px] font-semibold text-ink-2">{CANDIDATE_STAGE[s].label}</span>
                <span className="tnum text-[12px] text-ink-3">{by.get(s)!.length}</span>
              </header>
              <div className="flex-1 space-y-2">
                {by.get(s)!.map((c) => <CandidateCard key={c.id} c={c} onOpen={onOpen} onMove={onMove} draggable={!ro && c.stage !== 'hired'} />)}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  )
}

function CandidateCard({ c, onOpen, onMove, draggable }: { c: CandidateRow; onOpen: (id: string) => void; onMove: (c: CandidateRow, s: CandidateStage) => void; draggable?: boolean }) {
  const ro = useReadOnly()
  return (
    <article
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/candidate', c.id)}
      className={cn('group min-w-0 rounded-md border border-line bg-surface p-3', draggable && 'cursor-grab active:cursor-grabbing')}
    >
      <div className="flex items-start gap-2">
        <button type="button" onClick={() => onOpen(c.id)} className="min-w-0 flex-1 text-left">
          <span className="block break-words text-[13.5px] font-medium leading-snug text-ink hover:underline">{c.name}</span>
          <span className="block text-[12px] leading-snug text-ink-3">{c.opening_role} · {c.experience_years}y · {SOURCE[c.source]}</span>
        </button>
        {!ro && c.stage !== 'hired' && (
          <Menu
            label={`Move ${c.name}`}
            trigger={<IconButton label={`Move ${c.name}`} size="xs"><MoreHorizontal className="size-4" /></IconButton>}
            items={[
              { label: 'Open details', onSelect: () => onOpen(c.id) },
              { separator: true, label: '' },
              ...STAGES.filter((s) => s !== c.stage).map((s) => ({ label: `Move to ${CANDIDATE_STAGE[s].label.toLowerCase()}`, onSelect: () => onMove(c, s), danger: s === 'rejected' })),
            ]}
          />
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
        {c.interviews_total > 0 && <Badge size="sm" tone={c.interviews_passed ? 'success' : 'neutral'}>{c.interviews_passed}/{c.interviews_total} passed</Badge>}
        {c.offer_ctc_paise ? <Badge size="sm" tone="accent">{fmtMoneyCompact(c.offer_ctc_paise)}</Badge> : c.expected_ctc_paise ? <span className="tnum">exp. {fmtMoneyCompact(c.expected_ctc_paise)}</span> : null}
        {c.stage === 'hired' && c.joining_on && <span>joins {fmtDate(c.joining_on)}</span>}
        {c.next_interview && <span>next {fmtDate(c.next_interview.slice(0, 10))}</span>}
        {!c.next_interview && c.stage !== 'hired' && c.stage !== 'rejected' && <span className="tnum">{c.days_in_pipeline}d in pipeline</span>}
      </div>
      {c.stage === 'rejected' && c.rejected_reason && <p className="mt-1.5 line-clamp-2 text-[12px] text-ink-3">{c.rejected_reason}</p>}
    </article>
  )
}

/* ---------------- candidate sheet ---------------- */
function CandidateSheet({ id, onClose, onMove }: { id: string; onClose: () => void; onMove: (c: CandidateRow, s: CandidateStage) => void }) {
  const q = useApi(['candidate', id], () => hrApi.candidate(id))
  const c = q.data
  const ro = useReadOnly()
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      width={640}
      title={c?.name ?? 'Candidate'}
      subtitle={c ? `${c.opening_role} · ${c.email}${c.phone ? ` · ${c.phone}` : ''}` : undefined}
      headerExtra={
        c ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge size="sm" map={CANDIDATE_STAGE} value={c.stage} />
            {!ro && c.stage !== 'hired' && (
              <Menu
                label="Move to"
                align="start"
                trigger={<Button size="xs" iconRight={<ChevronRight className="size-3.5" />}>Move to</Button>}
                items={STAGES.filter((s) => s !== c.stage).map((s) => ({ label: CANDIDATE_STAGE[s].label, onSelect: () => onMove(c, s), danger: s === 'rejected' }))}
              />
            )}
          </div>
        ) : undefined
      }
    >
      {q.isLoading ? <SkeletonRows rows={6} /> : q.error || !c ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <SheetBody c={c} />}
    </Sheet>
  )
}

function SheetBody({ c }: { c: CandidateDetail }) {
  const ro = useReadOnly() || c.stage === 'hired'
  const [scheduling, setScheduling] = useState(false)
  const [recording, setRecording] = useState<Interview | null>(null)
  const upload = useMut((f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f) }).then((data_url) => hrApi.uploadResume(c.id, { name: f.name, mime: f.type, size_bytes: f.size, data_url })), { invalidate: INV, success: 'Resume uploaded' })
  return (
    <div className="space-y-6">
      {c.stage === 'hired' && (
        <Callout tone="success" title="Hired">
          Joins {fmtDate(c.joining_on, 'long')}. {c.invite ? `Invite sent to ${c.invite.email}${c.invite.accepted ? ' (accepted)' : ''}.` : ''} <Link to="/lifecycle" className="font-medium text-brand-text hover:underline">Onboarding checklist</Link>
        </Callout>
      )}
      {c.stage === 'rejected' && c.rejected_reason && <Callout tone="danger" title="Rejected">{c.rejected_reason}</Callout>}
      <section>
        <h4 className="mb-2.5 text-[13px] font-semibold text-ink-2">Profile</h4>
        <KV
          cols={3}
          items={[
            { label: 'Source', value: SOURCE[c.source] },
            { label: 'Experience', value: `${c.experience_years} years` },
            { label: 'Notice', value: c.notice_days === null ? '—' : `${c.notice_days} days` },
            { label: 'Current CTC', value: <span className="tnum">{fmtMoneyCompact(c.current_ctc_paise)}</span> },
            { label: 'Expected CTC', value: <span className="tnum">{fmtMoneyCompact(c.expected_ctc_paise)}</span> },
            { label: 'Offered CTC', value: <span className="tnum">{fmtMoneyCompact(c.offer_ctc_paise)}</span> },
          ]}
        />
        {c.notes && <p className="mt-3 text-[13px] text-ink-2">{c.notes}</p>}
      </section>

      <section>
        <h4 className="mb-2.5 text-[13px] font-semibold text-ink-2">Resume</h4>
        {c.resume ? (
          <div className="flex items-center gap-3 rounded-lg border border-line px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{c.resume.name}</span>
            <span className="tnum text-[12px] text-ink-3">{Math.max(1, Math.round(c.resume.size_bytes / 1024))} KB</span>
            {c.resume.data_url && (
              <a href={c.resume.data_url} download={c.resume.name} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-text hover:underline">
                <Download className="size-4" />Download
              </a>
            )}
          </div>
        ) : ro ? (
          <p className="text-[13px] text-ink-3">No resume uploaded.</p>
        ) : (
          <FileUpload accept=".pdf,.doc,.docx,application/pdf" maxMb={5} label="Upload resume" hint="PDF or DOCX · up to 5 MB" onFile={(f) => upload.mutate(f)} />
        )}
      </section>

      <section>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <h4 className="text-[13px] font-semibold text-ink-2">Interviews</h4>
          {!ro && c.stage !== 'rejected' && <Button size="xs" icon={<Plus className="size-3.5" />} onClick={() => setScheduling(true)}>Schedule round</Button>}
        </div>
        {c.interviews.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {c.interviews.map((i) => (
              <li key={i.id} className="px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-[13.5px] font-medium">Round {i.round} · <span className="capitalize">{i.kind}</span></span>
                  <Badge size="sm" tone={i.result === 'pass' ? 'success' : i.result === 'fail' ? 'danger' : i.result === 'no_show' ? 'warning' : 'neutral'}>{i.result === 'no_show' ? 'No show' : i.result === 'pending' ? 'Scheduled' : i.result === 'pass' ? 'Passed' : 'Failed'}</Badge>
                  {i.rating ? <span className="tnum text-[12px] text-ink-3">{i.rating}/5</span> : null}
                  {!ro && i.result === 'pending' && <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setRecording(i)}>Record result</Button>}
                </div>
                <div className="mt-0.5 text-[12px] text-ink-3">{i.interviewer_name} · {fmtDateTime(i.scheduled_at)}</div>
                {i.feedback && <p className="mt-1.5 text-[13px] text-ink-2">{i.feedback}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-ink-3">No interviews yet. An offer needs at least one passed round.</p>
        )}
      </section>

      {!ro && <OfferForm c={c} />}

      {c.history.length > 0 && (
        <section>
          <h4 className="mb-2.5 text-[13px] font-semibold text-ink-2">History</h4>
          <ul className="space-y-2">
            {c.history.map((h, k) => (
              <li key={k} className="flex gap-3 text-[12.5px]">
                <span className="w-16 shrink-0 text-ink-3">{relTime(h.at)}</span>
                <span className="min-w-0 text-ink-2">{h.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {scheduling && <ScheduleDialog c={c} onClose={() => setScheduling(false)} />}
      {recording && <ResultDialog i={recording} onClose={() => setRecording(null)} />}
    </div>
  )
}

function OfferForm({ c }: { c: CandidateDetail }) {
  const [f, setF] = useState({ expected: c.expected_ctc_paise ?? 0, offer: c.offer_ctc_paise ?? 0, notice: c.notice_days === null ? '' : String(c.notice_days), joining: c.joining_on ?? '', rating: c.rating ? String(c.rating) : '' })
  const [err, setErr] = useState<string | null>(null)
  const save = useMut(() => hrApi.updateCandidate(c.id, { expected_ctc_paise: f.expected || null, offer_ctc_paise: f.offer || null, notice_days: f.notice === '' ? null : Number(f.notice), joining_on: f.joining || null, rating: f.rating ? Number(f.rating) : null }, c.version), {
    invalidate: INV, success: 'Candidate saved', silentError: true, onError: (e: ApiError) => setErr(e.message), onSuccess: () => setErr(null),
  })
  return (
    <section>
      <h4 className="mb-2.5 text-[13px] font-semibold text-ink-2">Offer & joining</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Expected CTC"><MoneyInput value={f.expected} onChange={(v) => setF((s) => ({ ...s, expected: v }))} /></Field>
        <Field label="Offered CTC"><MoneyInput value={f.offer} onChange={(v) => setF((s) => ({ ...s, offer: v }))} /></Field>
        <Field label="Notice (days)"><Input type="number" min={0} max={180} value={f.notice} onChange={(e) => setF((s) => ({ ...s, notice: e.target.value }))} /></Field>
        <Field label="Joining date"><Input type="date" value={f.joining} onChange={(e) => setF((s) => ({ ...s, joining: e.target.value }))} /></Field>
        <Field label="Overall rating">
          <Select value={f.rating} onChange={(e) => setF((s) => ({ ...s, rating: e.target.value }))} options={[{ value: '', label: 'Not rated' }, ...[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: `${n} / 5` }))]} />
        </Field>
      </div>
      {err && <p className="mt-2 text-[12.5px] font-medium text-danger-text">{err}</p>}
      <div className="mt-3 flex justify-end">
        <Button size="sm" loading={save.isPending} onClick={() => save.mutate(undefined)}>Save details</Button>
      </div>
    </section>
  )
}

function ScheduleDialog({ c, onClose }: { c: CandidateDetail; onClose: () => void }) {
  const [kind, setKind] = useState<Interview['kind']>('technical')
  const [when, setWhen] = useState(`${addDays(todayISO(), 1)}T11:00`)
  const [who, setWho] = useState<string | null>(null)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => hrApi.addInterview(c.id, { kind, scheduled_at: when, interviewer_id: who ?? '' }), { invalidate: INV, success: 'Interview scheduled', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }) })
  return (
    <Dialog open size="sm" onOpenChange={(o) => !o && onClose()} title={`Schedule round ${c.interviews.length + 1}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>Schedule</Button></>}>
      <div className="space-y-4">
        <Field label="Type" error={errs.kind}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as Interview['kind'])} options={[{ value: 'technical', label: 'Technical' }, { value: 'assignment', label: 'Assignment' }, { value: 'manager', label: 'Manager' }, { value: 'hr', label: 'HR' }, { value: 'final', label: 'Final' }]} />
        </Field>
        <Field label="Date and time" required error={errs.scheduled_at}><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
        <Field label="Interviewer" required error={errs.interviewer_id}><PeoplePicker value={who} onChange={setWho} invalid={!!errs.interviewer_id} /></Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

function ResultDialog({ i, onClose }: { i: Interview; onClose: () => void }) {
  const [result, setResult] = useState<Interview['result']>('pass')
  const [rating, setRating] = useState('4')
  const [feedback, setFeedback] = useState('')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const m = useMut(() => hrApi.recordInterview(i.id, { result, rating: result === 'no_show' ? null : Number(rating), feedback }), { invalidate: INV, success: 'Result recorded', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }) })
  return (
    <Dialog open size="sm" onOpenChange={(o) => !o && onClose()} title={`Round ${i.round} result`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>Save result</Button></>}>
      <div className="space-y-4">
        <Field label="Result"><Segmented block value={result} onChange={setResult} options={[{ value: 'pass', label: 'Pass' }, { value: 'fail', label: 'Fail' }, { value: 'no_show', label: 'No show' }]} /></Field>
        {result !== 'no_show' && (
          <Field label="Rating" error={errs.rating}>
            <Segmented block value={rating} onChange={setRating} options={['1', '2', '3', '4', '5'].map((n) => ({ value: n, label: n }))} />
          </Field>
        )}
        <Field label="Feedback" required={result !== 'no_show'} error={errs.feedback}><Textarea rows={4} value={feedback} invalid={!!errs.feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Strengths, gaps and a clear recommendation" /></Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

function AddCandidateDialog({ openings, defaultOpening, onClose }: { openings: RecruitmentView['openings']; defaultOpening?: string; onClose: () => void }) {
  const [f, setF] = useState({ opening_id: defaultOpening ?? '', name: '', email: '', phone: '', source: 'job_portal' as Candidate['source'], experience_years: '2', notice_days: '30', notes: '' })
  const [exp, setExp] = useState(0)
  const [errs, setErrs] = useState<Record<string, string>>({})
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))
  const m = useMut(() => hrApi.addCandidate({ ...f, experience_years: Number(f.experience_years), notice_days: Number(f.notice_days), expected_ctc_paise: exp || null }), {
    invalidate: INV, success: 'Candidate added', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Add candidate" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>Add candidate</Button></>}>
      <div className="space-y-4">
        <Field label="Opening" required error={errs.opening_id}><Select value={f.opening_id} onChange={set('opening_id')} options={openings.map((o) => ({ value: o.id, label: o.role }))} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={errs.name}><Input value={f.name} invalid={!!errs.name} onChange={set('name')} /></Field>
          <Field label="Email" required error={errs.email}><Input type="email" value={f.email} invalid={!!errs.email} onChange={set('email')} /></Field>
          <Field label="Phone"><Input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Source" error={errs.source}><Select value={f.source} onChange={set('source')} options={Object.entries(SOURCE).map(([value, label]) => ({ value, label }))} /></Field>
          <Field label="Experience (years)" error={errs.experience_years}><Input type="number" min={0} value={f.experience_years} onChange={set('experience_years')} /></Field>
          <Field label="Notice (days)" error={errs.notice_days}><Input type="number" min={0} value={f.notice_days} onChange={set('notice_days')} /></Field>
        </div>
        <Field label="Expected CTC (annual)"><MoneyInput value={exp} onChange={setExp} /></Field>
        <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

