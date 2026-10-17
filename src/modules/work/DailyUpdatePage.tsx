import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { ExternalLink } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { timeApi, workApi, type DailyView } from '@/api/work'
import type { ApiError } from '@/api/http'
import { fmtDate, relTime, todayISO, weekStart } from '@/domain/calendar'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Card, CardHeader, Checkbox, EmptyState, ErrorState, Field, FilterChips, Input, Skeleton, StatCard, Textarea, useReadOnly } from '@/ui'
import type { DailyUpdate } from '@/types/entities'

/** /daily now lives on "Timesheet & log" (Feature Guide §8, img-013/014): the old page redirects to its log section. */
export default function DailyUpdatePage() {
  return <Navigate to="/timesheet?section=log" replace />
}

/** The log half of "Timesheet & log": End-of-day update, Friday demo, then my recent updates (and the team feed for managers). */
export function DailyLog({ id }: { id?: string }) {
  const today = todayISO()
  const [date, setDate] = useState(today)
  const q = useApi(['daily', date], () => workApi.daily(date))
  const d = q.data
  const isManager = !!d?.team
  return (
    <div id={id} className="scroll-mt-24 space-y-5">
      {q.isLoading ? (
        <Skeleton className="h-[380px] rounded-lg" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <UpdateForm key={`${d.date}:${d.mine?.version ?? 0}`} view={d} onDate={setDate} minDate={isManager ? undefined : weekStart(today)} />
          {d.demo && <DemoCard key={`${d.demo.date}:${d.demo.shown}:${d.demo.note}`} view={d} />}
          <div className={cn('grid grid-cols-1 gap-5', isManager && 'xl:grid-cols-12')}>
            {isManager && (
              <div className="min-w-0 xl:col-span-7">
                <TeamFeed view={d} />
              </div>
            )}
            <div className={cn('min-w-0', isManager && 'xl:col-span-5')}>
              <History items={d.recent} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function UpdateForm({ view, onDate, minDate }: { view: DailyView; onDate: (d: string) => void; minDate?: string }) {
  const ro = useReadOnly()
  const today = todayISO()
  const m = view.mine
  const [done, setDone] = useState(m?.done ?? '')
  const [proof, setProof] = useState(m?.proof_url ?? '')
  const [blocker, setBlocker] = useState(m?.blocker ?? '')
  const [errs, setErrs] = useState<Record<string, string>>({})
  const editableDay = view.date <= today && view.date >= weekStart(today)
  const dirty = done !== (m?.done ?? '') || proof !== (m?.proof_url ?? '') || blocker !== (m?.blocker ?? '')
  useEffect(() => setErrs({}), [view.date])

  const save = useMut(() => workApi.postDaily({ date: view.date, done, proof_url: proof, blocker }), {
    invalidate: [['daily']],
    success: m ? 'Update saved' : 'Update posted',
    silentError: true,
    onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }),
  })
  const submit = () => {
    const e: Record<string, string> = {}
    if (done.trim().length < 5) e.done = 'Write what you finished (at least a sentence).'
    if (view.proof_required && !proof.trim()) e.proof_url = 'Add a proof link — a commit, screenshot or demo URL. No proof, no progress.'
    else if (proof.trim() && !/^https?:\/\/\S+\.\S+/.test(proof.trim())) e.proof_url = 'Links must start with http:// or https://'
    setErrs(e)
    if (!Object.keys(e).length) save.mutate(undefined)
  }
  const disabled = ro || !editableDay

  return (
    <Card>
      <CardHeader
        title="End-of-day update"
        subtitle={m ? `Posted ${relTime(m.created_at)}${m.version > 1 ? ` · edited ${relTime(m.updated_at)}` : ''}` : editableDay ? 'Not posted yet.' : 'Nothing was posted for this day.'}
        action={m ? <Badge tone="success">Posted</Badge> : editableDay ? <Badge tone="warning">Due today</Badge> : null}
      />
      {!editableDay && !m ? (
        <>
        <Field label="Date" htmlFor="du-date2" className="mb-3">
          <Input id="du-date2" type="date" value={view.date} max={today} min={minDate} onChange={(e) => e.target.value && onDate(e.target.value)} />
        </Field>
        <EmptyState compact title="No update for this day" body="Updates can be posted or edited for days in the current week." />
        </>
      ) : (
        <div className="space-y-4">
          <Field label="Date" htmlFor="du-date">
            <Input id="du-date" type="date" value={view.date} max={today} min={minDate} onChange={(e) => e.target.value && onDate(e.target.value)} />
          </Field>
          <Field label="What I finished" required error={errs.done} htmlFor="du-done">
            <Textarea id="du-done" rows={3} value={done} onChange={(e) => setDone(e.target.value)} disabled={disabled} invalid={!!errs.done} />
          </Field>
          <Field label="Proof link" required={view.proof_required} error={errs.proof_url} hint={view.proof_required ? 'No proof, no progress: a commit, a document or a screenshot.' : undefined} htmlFor="du-proof">
            <Input id="du-proof" type="url" inputMode="url" value={proof} onChange={(e) => setProof(e.target.value)} disabled={disabled} invalid={!!errs.proof_url} placeholder="Commit, screenshot or demo URL" />
          </Field>
          <Field label="Blockers" htmlFor="du-block">
            <Input id="du-block" value={blocker} onChange={(e) => setBlocker(e.target.value)} disabled={disabled} placeholder="Optional" />
          </Field>
          {errs.form && <p className="text-[13px] text-danger-text">{errs.form}</p>}
          {!ro && editableDay && (
            <div>
              <Button variant="primary" className="w-full sm:w-auto" loading={save.isPending} disabled={!!m && !dirty} onClick={submit}>
                Save update
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/** Friday demo (Feature Guide §8): did you show working software to the team this week, and what. */
function DemoCard({ view }: { view: DailyView }) {
  const ro = useReadOnly()
  const demo = view.demo!
  const [shown, setShown] = useState(demo.shown)
  const [note, setNote] = useState(demo.note)
  const [err, setErr] = useState<string | null>(null)
  const save = useMut(() => timeApi.saveDemo({ date: demo.date, demo_shown: shown, demo_note: note }), {
    invalidate: [['daily']],
    success: shown ? 'Demo saved' : 'Saved: no demo this week',
    silentError: true,
    onError: (e: ApiError) => setErr(e.message),
  })
  const dirty = shown !== demo.shown || note !== demo.note
  const disabled = ro || !demo.editable
  const onSave = () => {
    if (shown && note.trim().length < 5) return setErr('Say what was demoed (at least a few words).')
    setErr(null)
    save.mutate(undefined)
  }
  return (
    <Card>
      <CardHeader title="Friday demo" action={demo.shown ? <Badge tone="success">Demo shown</Badge> : null} />
      <div className="space-y-3">
        <Checkbox checked={shown} onChange={setShown} disabled={disabled} label="Showed working software to the team" />
        <Field error={err} htmlFor="demo-note">
          <Input id="demo-note" aria-label="What was demoed" value={note} disabled={disabled} invalid={!!err} onChange={(e) => setNote(e.target.value)} placeholder="What was demoed" />
        </Field>
        {!demo.editable && <p className="text-[12.5px] text-ink-3">{demo.date > todayISO() ? `You can record this week’s demo on ${fmtDate(demo.date, 'long')}.` : 'Demos can be recorded for the current week only.'}</p>}
        {!disabled && (
          <div>
            <Button variant="primary" className="w-full sm:w-auto" loading={save.isPending} disabled={!dirty} onClick={onSave}>
              Save demo
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

function UpdateBody({ u }: { u: DailyUpdate }) {
  return (
    <>
      <p className="whitespace-pre-wrap text-[13.5px] leading-snug text-ink">{u.done}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {u.proof_url && (
          <a href={u.proof_url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 max-w-full items-center gap-1 text-[12.5px] text-brand-text hover:underline" onClick={(e) => e.stopPropagation()}>
            <ExternalLink className="size-3.5 shrink-0" />
            <span className="truncate">{u.proof_url.replace(/^https?:\/\//, '')}</span>
          </a>
        )}
        {u.demo_shown && (
          <Badge tone="neutral" size="sm">
            Friday demo
          </Badge>
        )}
        {u.demo_shown && u.demo_note && <span className="min-w-0 truncate text-[12.5px] text-ink-2">{u.demo_note}</span>}
      </div>
      {u.blocker && (
        <div className="mt-2 flex items-start gap-2 text-[12.5px]">
          <Badge tone="danger" size="sm">Blocked</Badge>
          <span className="min-w-0 pt-px text-ink-2">{u.blocker}</span>
        </div>
      )}
    </>
  )
}

function History({ items }: { items: DailyUpdate[] }) {
  return (
    <Card pad={false}>
      <CardHeader className="px-5 pt-5" title="My recent updates" subtitle="Last 10 days you posted." />
      {!items.length ? (
        <EmptyState compact title="No updates yet" body="Post your first one today — it takes a minute." />
      ) : (
        <ol className="divide-y divide-line">
          {items.map((u) => (
            <li key={u.id} className="flex gap-3 px-5 py-3.5">
              <div className="w-14 shrink-0">
                <div className="tnum whitespace-nowrap text-[13px] font-medium text-ink">{fmtDate(u.date)}</div>
                <div className="text-[12px] text-ink-3">{fmtDate(u.date, 'day').split(' ')[0]}</div>
              </div>
              <div className="min-w-0 flex-1">
                <UpdateBody u={u} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

type TeamFilter = 'all' | 'missing' | 'blocked'
function TeamFeed({ view }: { view: DailyView }) {
  const team = view.team ?? []
  const [f, setF] = useState<TeamFilter>('all')
  const posted = team.filter((t) => t.update)
  const missing = team.filter((t) => !t.update && !t.on_leave)
  const blocked = team.filter((t) => t.update?.blocker)
  const list = useMemo(() => (f === 'missing' ? missing : f === 'blocked' ? blocked : [...team].sort((a, b) => Number(!!b.update?.blocker) - Number(!!a.update?.blocker) || Number(!!b.update) - Number(!!a.update))), [f, team, missing, blocked])
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <StatCard label="Posted" value={`${posted.length} / ${team.length}`} />
        <StatCard label="Not posted" value={missing.length} tone={missing.length ? 'warning' : undefined} />
        <StatCard label="Blockers" value={blocked.length} tone={blocked.length ? 'danger' : undefined} />
      </div>
      <Card pad={false}>
        <div className="flex flex-col gap-3 border-b border-line px-4 py-3.5 md:flex-row md:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">Team feed · {view.date === todayISO() ? 'today' : fmtDate(view.date, 'long')}</h2>
            <p className="text-[12.5px] text-ink-3">Blockers first, then who posted.</p>
          </div>
          <FilterChips
            value={f}
            onChange={setF}
            options={[
              { value: 'all', label: 'All', count: team.length },
              { value: 'missing', label: 'Not posted', count: missing.length },
              { value: 'blocked', label: 'Blocked', count: blocked.length },
            ]}
          />
        </div>
        {!list.length ? (
          <EmptyState compact title={f === 'missing' ? 'Everyone has posted' : f === 'blocked' ? 'No blockers reported' : 'No one reports to you'} />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((t) => (
              <li key={t.user.id} className="flex gap-3 px-4 py-3 md:px-5">
                <Avatar name={t.user.name} hue={t.user.avatar_hue} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium text-ink">{t.user.name}</div>
                      <div className="truncate text-[12.5px] text-ink-3">{t.user.title}</div>
                    </div>
                    <div className="shrink-0 pt-0.5">
                      {t.update ? (
                        <span className="whitespace-nowrap text-[12.5px] text-ink-3">{relTime(t.update.updated_at)}</span>
                      ) : t.on_leave ? (
                        <Badge tone="info" size="sm">On leave</Badge>
                      ) : (
                        <Badge tone="warning" size="sm">Not posted</Badge>
                      )}
                    </div>
                  </div>
                  {t.update && (
                    <div className="mt-1.5">
                      <UpdateBody u={t.update} />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
