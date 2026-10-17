// v7 task page / drawer: the professional fields — concerned manager, watchers (watch / unwatch), definition of done
// (tick off), attachments, labels, billable, repeat, sub-tasks and follow-ups. Rules and numbers come from the server.
import { useEffect, useState, type ReactNode } from 'react'
import { Download, Eye, EyeOff, Paperclip, Plus, Repeat, Trash2, X } from '@/ui/icons'
import { taskV7Api, type TaskAttachment, type TaskDetailV7 } from '@/api/work'
import { useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { useSession } from '@/stores/session'
import { useUI } from '@/stores/ui'
import { fmtDate, relTime } from '@/domain/calendar'
import { TASK_STATUS } from '@/domain/labels'
import { cn, saveFile } from '@/lib/utils'
import { Badge, Button, Checkbox, FileUpload, Input, PersonName, PeoplePicker, Select, StatusBadge, Switch, useReadOnly } from '@/ui'
import { MultiPicker } from './MultiPicker'
import { useTaskInvalidate } from '../TaskDrawerHost'
import type { TaskStatus } from '@/types/entities'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-3 py-2 sm:grid-cols-[128px_minmax(0,1fr)]">
      <span className="pt-0.5 text-[13px] text-ink-3">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function TaskV7Panel({ d, editable }: { d: TaskDetailV7; editable: boolean }) {
  const ro = useReadOnly()
  const people = usePeopleMap()
  const me = useSession((s) => s.user)
  const inv = useTaskInvalidate()
  const t = d.task
  const canTick = !!d.can_tick_criteria && !ro
  const canAttach = !!d.can_attach && !ro
  const after = { onSuccess: () => inv(t.id) }
  const save = useMut((patch: Parameters<typeof taskV7Api.update>[1]) => taskV7Api.update(t.id, patch, t.version), { success: 'Saved', ...after })
  const watch = useMut((on: boolean) => taskV7Api.watch(t.id, on), { success: (_r, on) => (on ? 'You’re watching this task' : 'Stopped watching'), ...after })
  const tick = useMut((v: { i: number; done: boolean }) => taskV7Api.tickCriterion(t.id, v.i, v.done), { ...after })
  const attach = useMut((f: { name: string; size: number; type: string; data_url: string | null }) => taskV7Api.attach(t.id, f), { success: (_r, f) => `Attached ${f.name}`, ...after })
  const unattach = useMut((a: TaskAttachment) => taskV7Api.removeAttachment(t.id, a.id), { success: (_r, a) => `Removed ${a.name}`, ...after })
  const [critText, setCritText] = useState('')
  const [labelText, setLabelText] = useState('')
  const [fileErr, setFileErr] = useState<string | null>(null)
  const crit = d.acceptance_criteria ?? []
  const labels = d.labels ?? []
  const watchers = d.watcher_ids ?? []
  useEffect(() => setFileErr(null), [t.id])

  const addFile = (file: File) => {
    setFileErr(null)
    if (file.size > 750 * 1024) return setFileErr(`${file.name} is larger than 750 KB. Put a link in a comment instead.`)
    const r = new FileReader()
    r.onload = () => attach.mutate({ name: file.name, size: file.size, type: file.type || 'application/octet-stream', data_url: typeof r.result === 'string' ? r.result : null })
    r.onerror = () => setFileErr(`${file.name} could not be read.`)
    r.readAsDataURL(file)
  }
  const download = async (a: TaskAttachment) => {
    if (!a.data_url) return
    const blob = await (await fetch(a.data_url)).blob()
    await saveFile(a.name, blob, a.type)
  }

  return (
    <div className="space-y-6">
      {/* accountability */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-ink">Accountability</h4>
        <div className="divide-y divide-line rounded-lg border border-line px-4">
          <Row label="Task reviewer">
            <PersonName id={d.review.reviewer_id} size={22} subtitle="Approves completion" />
          </Row>
          <Row label="Concerned manager">
            {editable ? (
              <PeoplePicker value={d.concerned_manager_id ?? null} onChange={(v) => v !== d.concerned_manager_id && save.mutate({ concerned_manager_id: v })} filter={(p) => p.id !== t.owner_id} clearable placeholder="No concerned manager" />
            ) : d.concerned_manager_id ? (
              <PersonName id={d.concerned_manager_id} size={22} subtitle={d.concerned_manager_default ? 'Owner’s reporting manager' : undefined} />
            ) : (
              <span className="text-[13.5px] text-ink-3">None</span>
            )}
          </Row>
          <Row label="Watchers">
            <div className="space-y-2">
              {editable ? (
                <MultiPicker
                  value={watchers}
                  onChange={(v) => save.mutate({ watcher_ids: v })}
                  options={(people.data ?? []).filter((p) => p.status === 'active' && p.id !== t.owner_id).map((p) => ({ value: p.id, label: p.name, hint: p.title, chip: p.name }))}
                  placeholder="Add watchers"
                  searchPlaceholder="Search people"
                  max={20}
                />
              ) : watchers.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {watchers.map((w) => (
                    <Badge key={w} size="sm">{people.get(w)?.name ?? 'Former user'}</Badge>
                  ))}
                </div>
              ) : (
                <span className="text-[13.5px] text-ink-3">Nobody yet</span>
              )}
              {!ro && t.owner_id !== me?.id && (
                <Button size="xs" variant="secondary" icon={d.watching ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} loading={watch.isPending} onClick={() => watch.mutate(!d.watching)}>
                  {d.watching ? 'Stop watching' : 'Watch this task'}
                </Button>
              )}
            </div>
          </Row>
        </div>
      </section>

      {/* definition of done */}
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <h4 className="text-[13px] font-semibold text-ink">Definition of done</h4>
          {crit.length > 0 && <span className={cn('tnum text-[12.5px]', d.criteria_done === crit.length ? 'font-medium text-success-text' : 'text-ink-3')}>{d.criteria_done}/{crit.length} done</span>}
        </div>
        {crit.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {crit.map((c, i) => (
              <li key={i} className="flex items-start gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <Checkbox checked={c.done} disabled={!canTick || tick.isPending} onChange={(v) => tick.mutate({ i, done: v })} label={<span className={cn('text-[13.5px]', c.done && 'text-ink-3 line-through')}>{c.text}</span>} />
                </div>
                {editable && (
                  <button type="button" aria-label={`Remove “${c.text}”`} onClick={() => save.mutate({ acceptance_criteria: crit.filter((_, j) => j !== i) })} className="grid size-6 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-line px-3 py-2.5 text-[13px] text-ink-3">No acceptance criteria. {editable ? 'Add what the reviewer should check.' : ''}</p>
        )}
        {editable && (
          <div className="mt-2 flex gap-2">
            <Input
              value={critText}
              maxLength={300}
              onChange={(e) => setCritText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && critText.trim()) {
                  e.preventDefault()
                  save.mutate({ acceptance_criteria: [...crit, { text: critText.trim(), done: false }] }, { onSuccess: () => setCritText('') })
                }
              }}
              placeholder="Add an acceptance criterion"
              aria-label="Add an acceptance criterion"
            />
            <Button variant="secondary" icon={<Plus className="size-4" />} className="shrink-0" disabled={!critText.trim()} loading={save.isPending} onClick={() => save.mutate({ acceptance_criteria: [...crit, { text: critText.trim(), done: false }] }, { onSuccess: () => setCritText('') })}>
              Add
            </Button>
          </div>
        )}
        {!canTick && crit.length > 0 && !ro && t.status !== 'done' && <p className="mt-1.5 text-[12px] text-ink-3">The owner, backup, reviewer or project manager ticks these off.</p>}
      </section>

      {/* attachments */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-ink">Attachments {(d.attachments ?? []).length ? <span className="tnum font-normal text-ink-3">({(d.attachments ?? []).length})</span> : null}</h4>
        <div className="space-y-2">
          {(d.attachments ?? []).map((a) => (
            <div key={a.id} className="flex items-center gap-2.5 rounded-lg border border-line px-3 py-2">
              <Paperclip className="size-4 shrink-0 text-ink-3" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium">{a.name}</div>
                <div className="truncate text-[12px] text-ink-3">
                  {Math.max(1, Math.round(a.size / 1024))} KB · {people.get(a.uploaded_by)?.name ?? 'Someone'} · {relTime(a.at)}
                </div>
              </div>
              {a.data_url && (
                <Button size="xs" variant="ghost" icon={<Download className="size-3.5" />} onClick={() => download(a)} aria-label={`Download ${a.name}`}>
                  <span className="hidden sm:inline">Download</span>
                </Button>
              )}
              {!ro && (a.uploaded_by === me?.id || editable) && (
                <Button size="xs" variant="ghost" icon={<Trash2 className="size-3.5" />} loading={unattach.isPending && unattach.variables?.id === a.id} onClick={() => unattach.mutate(a)} aria-label={`Remove ${a.name}`} />
              )}
            </div>
          ))}
          {canAttach && (d.attachments ?? []).length < 8 && <FileUpload onFile={addFile} maxMb={0.75} label="Attach a file" hint="Up to 750 KB · PDF, image, spreadsheet, document or text" />}
          {fileErr && <p className="text-[12.5px] font-medium text-danger-text">{fileErr}</p>}
          {!canAttach && !(d.attachments ?? []).length && <p className="text-[13px] text-ink-3">No files.</p>}
        </div>
      </section>

      {/* labels, billable, repeat */}
      <section>
        <h4 className="mb-2 text-[13px] font-semibold text-ink">Tracking</h4>
        <div className="divide-y divide-line rounded-lg border border-line px-4">
          <Row label="Labels">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {labels.map((l) => (
                  <span key={l} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-[12.5px] text-ink-2">
                    {l}
                    {editable && (
                      <button type="button" aria-label={`Remove label ${l}`} onClick={() => save.mutate({ labels: labels.filter((x) => x !== l) })} className="grid size-5 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink">
                        <X className="size-3" />
                      </button>
                    )}
                  </span>
                ))}
                {!labels.length && !editable && <span className="text-[13.5px] text-ink-3">None</span>}
              </div>
              {editable && labels.length < 10 && (
                <Input
                  value={labelText}
                  maxLength={30}
                  onChange={(e) => setLabelText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && labelText.trim()) {
                      e.preventDefault()
                      if (!labels.includes(labelText.trim())) save.mutate({ labels: [...labels, labelText.trim()] }, { onSuccess: () => setLabelText('') })
                      else setLabelText('')
                    }
                  }}
                  placeholder="Add a label and press Enter"
                  aria-label="Add a label"
                />
              )}
            </div>
          </Row>
          <Row label="Billable">
            {editable ? (
              <Switch checked={!!d.billable} onChange={(v) => save.mutate({ billable: v })} label={<span className="text-[13.5px]">{d.billable ? 'Billable client work' : 'Internal, non-billable'}</span>} />
            ) : (
              <span className="text-[13.5px]">{d.billable ? 'Billable client work' : 'Internal, non-billable'}</span>
            )}
          </Row>
          <Row label="Repeat">
            {editable ? (
              <Select
                value={d.recurrence ?? 'none'}
                onChange={(e) => save.mutate({ recurrence: e.target.value as 'none' })}
                options={[
                  { value: 'none', label: 'Does not repeat' },
                  { value: 'weekly', label: 'Weekly — next one on approval' },
                  { value: 'monthly', label: 'Monthly — next one on approval' },
                ]}
              />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[13.5px]">
                {d.recurrence && d.recurrence !== 'none' && <Repeat className="size-3.5 text-ink-3" />}
                {d.recurrence === 'weekly' ? 'Weekly' : d.recurrence === 'monthly' ? 'Monthly' : 'Does not repeat'}
              </span>
            )}
            {(d.recurrence_of || d.next_occurrence) && (
              <div className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-3">
                {d.recurrence_of && <TaskLink id={d.recurrence_of.id} text={`Repeats ${d.recurrence_of.wbs} ${d.recurrence_of.title}`} />}
                {d.next_occurrence && <TaskLink id={d.next_occurrence.id} text={`Next occurrence ${d.next_occurrence.wbs}, due ${fmtDate(d.next_occurrence.due_on)}`} />}
              </div>
            )}
          </Row>
        </div>
      </section>

      {/* sub-tasks and follow-ups */}
      {(d.parent || (d.children ?? []).length > 0) && (
        <section>
          <h4 className="mb-2 text-[13px] font-semibold text-ink">Related tasks</h4>
          <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
            {d.parent && (
              <button type="button" onClick={() => useUI.getState().openTask(d.parent!.id)} className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-surface-2/60">
                <span className="shrink-0 text-[12px] text-ink-3">Parent</span>
                <span className="tnum shrink-0 text-[12.5px] text-ink-3">{d.parent.wbs}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{d.parent.title}</span>
              </button>
            )}
            {(d.children ?? []).map((c) => (
              <button key={c.id} type="button" onClick={() => useUI.getState().openTask(c.id)} className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-2/60">
                <span className="tnum shrink-0 text-[12.5px] text-ink-3">{c.wbs}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{c.title}</span>
                <span className="hidden shrink-0 text-[12px] text-ink-3 sm:inline">{people.get(c.owner_id)?.name ?? 'Unassigned'}</span>
                <StatusBadge map={TASK_STATUS} value={c.status as TaskStatus} size="sm" />
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function TaskLink({ id, text }: { id: string; text: string }) {
  return (
    <button type="button" onClick={() => useUI.getState().openTask(id)} className="block text-left font-medium text-brand-text hover:underline">
      {text}
    </button>
  )
}
