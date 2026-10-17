import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Minus, Plus, Trash2, X } from '@/ui/icons'
import type { WeekDay, WeekView, WorkItem } from '@/api/work'
import { parseISO } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Combobox, IconButton, Tooltip, type ComboOption } from '@/ui'
import { countedTotal, dayTotal, fmtH, parseHours, round2, rowTotal, snap, type DraftRow } from './timesheetModel'

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const dow = (d: string) => DOW[parseISO(d).getDay()]

/** Days shown for the week: Monday to Saturday, plus Sunday only when the company calendar works it. */
export const visibleDays = (v: WeekView) => v.days.filter((d) => !d.hidden)

export function dayNote(d: WeekDay): string | null {
  if (d.label) return d.label === 'Holiday' && d.holiday ? 'Holiday' : d.label
  if (d.holiday) return 'Holiday'
  if (d.kind === 'weekly_off') return 'Weekly off'
  if (d.leave) return d.leave.portion === 'half' ? 'Half day' : 'Leave'
  return null
}
const muted = (d: WeekDay) => d.kind === 'weekly_off' || d.kind === 'holiday'

export interface EmptyDraft {
  project_id: string | null
  note: string
  hours: Record<string, number>
}
export const EMPTY_DRAFT: EmptyDraft = { project_id: null, note: '', hours: {} }

export interface GridProps {
  view: WeekView
  rows: DraftRow[]
  editable: boolean
  today: string
  items?: WorkItem[]
  itemsLoading?: boolean
  onChange?: (rows: DraftRow[]) => void
  /** Picking a task or activity in the empty row turns it into a real row (with what was typed in it). */
  onPick?: (it: WorkItem, extra: EmptyDraft) => void
  empty?: EmptyDraft
  onEmpty?: (e: EmptyDraft) => void
  /** read-only, narrower columns and no outer border (for split panes) */
  compact?: boolean
  /** sits inside the "Timesheet" card: no outer border (img-013) */
  inCard?: boolean
  /** "+ Add a task row": opens the empty row's picker */
  onAddTask?: () => void
  /** focus left a row (rows whose hours were cleared disappear) */
  onRowLeave?: (ri: number) => void
}

/** A day that hasn't happened yet while future entries are off: not a holiday — a distinct, dashed "opens on the day" state. */
export const futureLocked = (d: WeekDay) => !d.entry_allowed && !muted(d)

/** Options for the "Choose a task or activity…" picker (leave comes in through "+ Leave or holiday"). */
function pickOptions(items: WorkItem[] | undefined, rows: DraftRow[]): ComboOption[] {
  const used = new Set(rows.filter((r) => r.kind === 'task').map((r) => `task:${r.task_id}`))
  return (items ?? []).filter((it) => it.kind !== 'leave' && !used.has(it.key)).map((it) => ({ value: it.key, label: it.label, hint: it.hint, group: it.group }))
}

const sectionOf = (r: DraftRow) => (r.kind === 'task' ? 'tasks' : 'activities')

/* ================================================================== */
/* Desktop grid                                                        */
/* ================================================================== */
export function DesktopGrid({ view, rows, editable, today, items, itemsLoading, onChange, onPick, empty = EMPTY_DRAFT, onEmpty, compact, inCard, onAddTask, onRowLeave }: GridProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { step, max_hours: maxH, min_hours: minH } = view.rules
  const breaks = view.rules.breaks_count ?? true
  const days = visibleDays(view)
  const projects = view.activity_projects ?? []
  const setRow = (ri: number, patch: Partial<DraftRow>) => onChange?.(rows.map((r, i) => (i === ri ? { ...r, ...patch } : r)))
  const setHours = (ri: number, date: string, h: number | null) => setRow(ri, { hours: { ...rows[ri].hours, [date]: h ?? 0 } })
  const focusCell = (r: number, c: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-cell="${r}:${c}"]`)
    if (el) {
      el.focus()
      if (el instanceof HTMLInputElement) el.select()
      return true
    }
    return false
  }
  const nav = (r: number, c: number, dr: number, dc: number) => {
    let rr = r + dr
    let cc = c + dc
    for (let i = 0; i < 8; i++) {
      if (rr < 0 || rr > rows.length || cc < 0 || cc >= days.length) return
      if (focusCell(rr, cc)) return
      rr += dr
      cc += dc
    }
  }
  const cellDisabled = (r: DraftRow, d: WeekDay) => !editable || !!r.locked_reason || (r.kind !== 'leave' && !d.entry_allowed) || (r.kind === 'leave' && muted(d))
  const weekTotal = round2(rows.reduce((s, r) => s + rowTotal(r), 0))
  const options = pickOptions(items, rows)
  const tasks = rows.map((r, i) => ({ r, i })).filter((x) => sectionOf(x.r) === 'tasks')
  const acts = rows.map((r, i) => ({ r, i })).filter((x) => sectionOf(x.r) === 'activities')
  const span = days.length + 2 + (editable ? 1 : 0)
  const dayW = compact ? 'w-[68px]' : 'w-[84px]'

  const hourCells = (r: DraftRow, ri: number) =>
    days.map((d, ci) => {
      const dis = cellDisabled(r, d)
      return (
        <td key={d.date} className={cn('px-1 py-1.5 align-top', muted(d) && 'bg-surface-2')}>
          {r.kind === 'leave' ? (
            <LeaveCell value={r.hours[d.date] ?? 0} min={minH} disabled={dis} dataCell={`${ri}:${ci}`} onChange={(h) => setHours(ri, d.date, h)} onNav={(dr, dc) => nav(ri, ci, dr, dc)} />
          ) : editable ? (
            <HourInput value={r.hours[d.date] ?? 0} step={step} max={maxH} disabled={dis} future={futureLocked(d) && !r.locked_reason} dataCell={`${ri}:${ci}`} onChange={(h) => setHours(ri, d.date, h)} onNav={(dr, dc) => nav(ri, ci, dr, dc)} title={futureLocked(d) ? `Opens on ${dow(d.date)} ${parseISO(d.date).getDate()} (future days can’t be filled in ahead)` : undefined} />
          ) : (
            <div className="tnum h-9 whitespace-nowrap px-2 text-right leading-9 text-ink">{fmtH(r.hours[d.date] ?? 0) || <span className="text-ink-3/50">–</span>}</div>
          )}
        </td>
      )
    })

  const rowEl = ({ r, i: ri }: { r: DraftRow; i: number }) => (
    <tr
      key={r.uid}
      className="group border-b border-line"
      onBlur={(e) => {
        if (!onRowLeave) return
        const next = e.relatedTarget as Node | null
        if (next && e.currentTarget.contains(next)) return
        onRowLeave(ri)
      }}
    >
      <td className="sticky left-0 z-[1] bg-surface px-4 py-2 align-top">
        <RowLabel r={r} editable={editable} projects={projects} noteRequired={view.rules.note_required} onPatch={(p) => setRow(ri, p)} />
      </td>
      {hourCells(r, ri)}
      <td className="tnum whitespace-nowrap px-3 py-1.5 text-right align-top font-medium leading-9">{fmtNum(rowTotal(r), 2)}</td>
      {editable && (
        <td className="py-1.5 pr-2 align-top">
          {!r.locked_reason && (
            <IconButton size="sm" label={`Remove ${r.label}`} className="opacity-60 group-hover:opacity-100 focus:opacity-100" onClick={() => onChange?.(rows.filter((_, i) => i !== ri))}>
              <X className="size-4" />
            </IconButton>
          )}
        </td>
      )}
    </tr>
  )
  const section = (label: string, list: { r: DraftRow; i: number }[], emptyText: ReactNode, extra?: ReactNode, after?: ReactNode) => (
    <>
      <tr className="border-b border-line bg-surface-2">
        <td colSpan={span} className="sticky left-0 px-4 py-2 text-[13px] font-semibold text-ink">
          {label}
        </td>
      </tr>
      {list.map(rowEl)}
      {!list.length && !extra && (
        <tr className="border-b border-line">
          <td colSpan={span} className="px-4 py-2.5 text-[13.5px] text-ink-2">
            {emptyText}
          </td>
        </tr>
      )}
      {after}
      {extra}
    </>
  )
  const addTaskLink = (
    <button type="button" onClick={onAddTask} className="font-medium text-brand-text hover:underline">
      “+ Add a task row”
    </button>
  )

  return (
    <div ref={ref} className={cn('overflow-hidden bg-surface', inCard ? 'border-t border-line' : !compact && 'rounded-lg border border-line')}>
      <div className="overflow-x-auto scroll-thin">
        <table className={cn('w-full table-fixed border-collapse text-[13.5px]', compact ? 'min-w-[640px]' : 'min-w-[860px]')}>
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 z-[2] bg-surface px-4 py-2 text-left align-bottom text-[13px] font-semibold text-ink">Task or activity</th>
              {days.map((d) => {
                const isToday = d.date === today
                const note = dayNote(d)
                return (
                  <th key={d.date} className={cn('px-1 py-2 text-right align-bottom font-normal', dayW, muted(d) && 'bg-surface-2', isToday && 'shadow-[inset_0_-2px_0_var(--brand)]')}>
                    <div className={cn('whitespace-nowrap leading-tight', compact ? 'px-1' : 'px-2')}>
                      <span className={cn('text-[13px] font-semibold', muted(d) ? 'text-ink-3' : isToday ? 'text-brand-text' : 'text-ink')}>{dow(d.date)}</span>{' '}
                      <span className={cn('tnum text-[13px] font-semibold', muted(d) ? 'text-ink-3' : isToday ? 'text-brand-text' : 'text-ink')}>{parseISO(d.date).getDate()}</span>
                    </div>
                    <div className={cn('h-4 truncate text-[11.5px] font-medium text-ink-3', compact ? 'px-1' : 'px-2')} title={d.holiday ?? note ?? undefined}>
                      {note ?? ''}
                    </div>
                  </th>
                )
              })}
              <th className={cn('px-3 py-2 text-right align-bottom text-[13px] font-semibold text-ink', compact ? 'w-[64px]' : 'w-[76px]')}>Total</th>
              {editable && <th className="w-11" />}
            </tr>
          </thead>
          <tbody>
            {section(
              'Tasks',
              tasks,
              editable ? <>No task rows this week. Add one with {addTaskLink}.</> : 'No task hours this week.',
              undefined,
              editable && tasks.length > 0 ? (
                <tr className="border-b border-line">
                  <td colSpan={span} className="sticky left-0 px-4 py-2">
                    <button type="button" onClick={onAddTask} className="text-[13px] font-medium text-brand-text hover:underline">
                      + Add a task row
                    </button>
                  </td>
                </tr>
              ) : undefined,
            )}
            {section(
              'Activities',
              acts,
              editable ? 'No activity rows yet.' : 'No activity or leave hours this week.',
              editable ? (
                <EmptyRow
                  rowIndex={rows.length}
                  days={days}
                  view={view}
                  empty={empty}
                  onEmpty={onEmpty}
                  options={options}
                  itemsLoading={itemsLoading}
                  projects={projects}
                  onPick={(key) => {
                    const it = items?.find((x) => x.key === key)
                    if (it) onPick?.(it, empty)
                  }}
                  onNav={nav}
                />
              ) : undefined,
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong">
              <td className="sticky left-0 z-[1] bg-surface px-4 py-2.5 align-top text-[13.5px] font-semibold text-ink">Day total</td>
              {days.map((d) => {
                const tot = round2(dayTotal(rows, d.date))
                const counted = round2(countedTotal(rows, d.date, breaks))
                const short = d.min_required > 0 && counted < d.min_required && d.date < today
                return (
                  <td key={d.date} className={cn('py-2 text-right align-top', compact ? 'px-2' : 'px-3', muted(d) && 'bg-surface-2')}>
                    <div className={cn('tnum whitespace-nowrap text-[13.5px] font-semibold', short ? 'text-danger-text' : muted(d) ? 'text-ink-3' : 'text-ink')}>{fmtNum(tot, 2)}</div>
                    <div className={cn('tnum whitespace-nowrap text-[11.5px]', short ? 'text-danger-text' : 'text-ink-3')}>{d.min_required > 0 ? `of ${d.min_required}h` : '—'}</div>
                  </td>
                )
              })}
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right align-top text-[14px] font-semibold">{fmtNum(weekTotal, 2)}</td>
              {editable && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function ProjectSelect({ value, onChange, projects, className, disabled }: { value: string | null; onChange: (v: string | null) => void; projects: { id: string; code: string; name: string }[]; className?: string; disabled?: boolean }) {
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      aria-label="Project"
      className={cn('h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-[12.5px] text-ink outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/15 disabled:opacity-60', className)}
    >
      <option value="">No project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.code} · {p.name}
        </option>
      ))}
    </select>
  )
}

function NoteInput({ value, onChange, required, invalid, className, label }: { value: string; onChange: (v: string) => void; required?: boolean; invalid?: boolean; className?: string; label: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={required ? 'Note (required)' : 'Note'}
      aria-label={label}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-8 w-full min-w-0 rounded-md border border-line bg-surface px-2 text-[12.5px] outline-none transition placeholder:text-ink-3 focus:border-brand focus:ring-2 focus:ring-brand/15 aria-[invalid=true]:border-warning aria-[invalid=true]:bg-warning-soft/40',
        className,
      )}
    />
  )
}

function RowLabel({ r, editable, projects, noteRequired, onPatch }: { r: DraftRow; editable: boolean; projects: { id: string; code: string; name: string }[]; noteRequired: boolean; onPatch: (p: Partial<DraftRow>) => void }) {
  const isBreaks = r.internal_code === 'breaks'
  const needsNote = r.kind === 'internal' && !isBreaks && noteRequired && rowTotal(r) > 0 && r.note.trim().length < 3
  const projectName = r.project_id ? projects.find((p) => p.id === r.project_id) : null
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5">
        {r.kind === 'task' && r.wbs && <span className="tnum shrink-0 text-[12.5px] text-ink-3">{r.wbs}</span>}
        <span className="truncate font-medium text-ink" title={r.label}>
          {r.label}
        </span>
      </div>
      {(r.kind !== 'internal' || !editable) && (
        <div className="truncate text-[12px] text-ink-3" title={r.sublabel}>
          {r.kind === 'internal' && projectName ? `${projectName.code} · ${projectName.name}` : r.sublabel}
          {r.kind === 'task' && r.est_hours !== null && ` · est. ${fmtNum(r.est_hours, 1)}h, logged ${fmtNum(r.logged_hours ?? 0, 1)}h`}
        </div>
      )}
      {r.locked_reason && <div className="mt-0.5 text-[11.5px] font-medium text-info-text">{r.locked_reason}</div>}
      {r.kind === 'internal' &&
        (editable ? (
          <div className="mt-1.5 grid max-w-[420px] grid-cols-2 gap-1.5">
            {isBreaks ? <div className="col-span-2 self-center text-[12px] text-ink-3">Internal · lunch, tea and the daily stand-up</div> : <ProjectSelect value={r.project_id ?? null} onChange={(v) => onPatch({ project_id: v })} projects={projects} />}
            {!isBreaks && <NoteInput value={r.note} onChange={(note) => onPatch({ note })} required={noteRequired} invalid={needsNote} label={`Note for ${r.label}`} />}
          </div>
        ) : (
          r.note && <div className="mt-0.5 truncate text-[12px] italic text-ink-2">“{r.note}”</div>
        ))}
    </div>
  )
}

/** The one empty row: pick a task or activity (+ project for activities) and a note; hours typed first are kept. */
function EmptyRow({ rowIndex, days, view, empty, onEmpty, options, itemsLoading, projects, onPick, onNav }: {
  rowIndex: number
  days: WeekDay[]
  view: WeekView
  empty: EmptyDraft
  onEmpty?: (e: EmptyDraft) => void
  options: ComboOption[]
  itemsLoading?: boolean
  projects: { id: string; code: string; name: string }[]
  onPick: (key: string) => void
  onNav: (r: number, c: number, dr: number, dc: number) => void
}) {
  const { step, max_hours: maxH } = view.rules
  const set = (p: Partial<EmptyDraft>) => onEmpty?.({ ...empty, ...p })
  const total = round2(Object.values(empty.hours).reduce((s, h) => s + (h || 0), 0))
  return (
    <tr className="border-b border-line bg-warning-soft/40" data-empty-row>
      <td className="sticky left-0 z-[1] bg-[color-mix(in_srgb,var(--warning-soft)_40%,var(--surface))] px-4 py-2 align-top">
        <div className="grid grid-cols-1 gap-1.5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Combobox
            id="ts-pick"
            value={null}
            onChange={(v) => v && onPick(v)}
            options={options}
            placeholder={itemsLoading ? 'Loading your tasks…' : 'Choose a task or activity…'}
            searchPlaceholder="Search tasks and activities"
            emptyText="Nothing matches. Only tasks you own, back up or are allocated to appear here."
            className="h-8 bg-surface text-[13px]"
          />
          <ProjectSelect value={empty.project_id} onChange={(v) => set({ project_id: v })} projects={projects} />
        </div>
        <NoteInput value={empty.note} onChange={(note) => set({ note })} label="Note for the new row" className="mt-1.5" />
        <div className="mt-1 text-[11.5px] text-ink-3">Empty row: pick a task or activity</div>
      </td>
      {days.map((d, ci) => (
        <td key={d.date} className={cn('px-1 py-1.5 align-top', muted(d) && 'bg-surface-2')}>
          <HourInput
            value={empty.hours[d.date] ?? 0}
            step={step}
            max={maxH}
            disabled={!d.entry_allowed}
            future={futureLocked(d)}
            title={futureLocked(d) ? `Opens on ${dow(d.date)} ${parseISO(d.date).getDate()}` : undefined}
            dataCell={`${rowIndex}:${ci}`}
            onChange={(h) => set({ hours: { ...empty.hours, [d.date]: h ?? 0 } })}
            onNav={(dr, dc) => onNav(rowIndex, ci, dr, dc)}
            className="border-line bg-surface"
          />
        </td>
      ))}
      <td className="tnum whitespace-nowrap px-3 py-1.5 text-right align-top font-medium leading-9">{fmtNum(total, 2)}</td>
      <td className="py-1.5 pr-2 align-top">
        <IconButton size="sm" label="Clear the empty row" variant="secondary" onClick={() => onEmpty?.(EMPTY_DRAFT)}>
          <X className="size-4" />
        </IconButton>
      </td>
    </tr>
  )
}

/** Numeric hours cell with keyboard navigation (arrows / Enter) and +/− stepping. */
export function HourInput({ value, onChange, step, max, disabled, dataCell, onNav, title, className, big, future }: {
  value: number
  onChange: (h: number | null) => void
  step: number
  max: number
  disabled?: boolean
  dataCell?: string
  onNav?: (dr: number, dc: number) => void
  title?: string
  className?: string
  big?: boolean
  /** disabled because the day hasn't happened yet (dashed box, not the holiday grey) */
  future?: boolean
}) {
  const [text, setText] = useState(fmtH(value))
  const [focus, setFocus] = useState(false)
  const [bad, setBad] = useState(false)
  useEffect(() => {
    if (!focus) setText(fmtH(value))
  }, [value, focus])
  const commit = () => {
    const p = parseHours(text)
    if (p === null) {
      onChange(null)
      setBad(false)
      return
    }
    if (Number.isNaN(p)) {
      setText(fmtH(value))
      setBad(false)
      return
    }
    const s = Math.min(max, snap(p, step))
    onChange(s || null)
    setText(fmtH(s))
    setBad(false)
  }
  const bump = (d: number) => {
    const s = Math.min(max, Math.max(0, snap((parseHours(text) || 0) + d * step, step)))
    setText(fmtH(s))
    onChange(s || null)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    const all = el.selectionStart === 0 && el.selectionEnd === el.value.length
    if (e.key === 'ArrowUp' && !e.altKey) return (e.preventDefault(), commit(), onNav?.(-1, 0))
    if (e.key === 'ArrowDown' && !e.altKey) return (e.preventDefault(), commit(), onNav?.(1, 0))
    if (e.key === 'Enter') return (e.preventDefault(), commit(), onNav?.(e.shiftKey ? -1 : 1, 0))
    if (e.key === 'ArrowLeft' && (all || el.selectionStart === 0)) return (e.preventDefault(), commit(), onNav?.(0, -1))
    if (e.key === 'ArrowRight' && (all || el.selectionEnd === el.value.length)) return (e.preventDefault(), commit(), onNav?.(0, 1))
    if (e.key === '+' || e.key === '=' || (e.altKey && e.key === 'ArrowUp')) return (e.preventDefault(), bump(1))
    if (e.key === '-' || (e.altKey && e.key === 'ArrowDown')) return (e.preventDefault(), bump(-1))
    if (e.key === 'Escape') return (setText(fmtH(value)), el.blur())
  }
  const offStep = (() => {
    const p = parseHours(text)
    return p !== null && !Number.isNaN(p) && Math.abs(p / step - Math.round(p / step)) > 1e-9
  })()
  return (
    <input
      data-cell={dataCell}
      inputMode="decimal"
      enterKeyHint="next"
      autoComplete="off"
      disabled={disabled}
      title={title}
      value={disabled && !value ? '' : text}
      placeholder={disabled ? '' : '–'}
      aria-label="Hours"
      aria-invalid={bad || offStep || undefined}
      onFocus={(e) => {
        setFocus(true)
        e.currentTarget.select()
      }}
      onBlur={() => {
        setFocus(false)
        commit()
      }}
      onChange={(e) => {
        const v = e.target.value.replace(/[^0-9.,:h]/gi, '').slice(0, 5)
        setText(v)
        const p = parseHours(v)
        if (p !== null && !Number.isNaN(p)) onChange(Math.min(max, p) || null)
        else if (p === null) onChange(null)
        setBad(p !== null && (Number.isNaN(p) || p > max))
      }}
      onKeyDown={onKey}
      className={cn(
        'tnum w-full rounded-md border bg-transparent text-right font-medium text-ink outline-none transition placeholder:text-ink-3/40',
        big ? 'h-11 px-3 text-center text-[18px] font-semibold' : 'h-9 px-2 text-[14px]',
        'border-line hover:border-line-strong focus:border-brand focus:bg-surface focus:ring-[3px] focus:ring-brand/15',
        'aria-[invalid=true]:border-warning aria-[invalid=true]:bg-warning-soft/50',
        className,
        future
          ? 'disabled:cursor-not-allowed disabled:border-dashed disabled:border-line-strong disabled:bg-surface disabled:hover:border-line-strong'
          : 'disabled:cursor-not-allowed disabled:border-transparent disabled:bg-surface-2/60 disabled:hover:border-transparent',
      )}
    />
  )
}

/** Leave cells cycle: empty → full day → half day → empty (Space / Enter / click). */
function LeaveCell({ value, min, disabled, onChange, dataCell, onNav }: { value: number; min: number; disabled: boolean; onChange: (h: number | null) => void; dataCell: string; onNav: (dr: number, dc: number) => void }) {
  const state = value >= min ? 'full' : value > 0 ? 'half' : 'none'
  const cycle = () => onChange(state === 'none' ? min : state === 'full' ? min / 2 : null)
  return (
    <button
      type="button"
      data-cell={dataCell}
      disabled={disabled}
      onClick={cycle}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') return (e.preventDefault(), onNav(-1, 0))
        if (e.key === 'ArrowDown') return (e.preventDefault(), onNav(1, 0))
        if (e.key === 'ArrowLeft') return (e.preventDefault(), onNav(0, -1))
        if (e.key === 'ArrowRight') return (e.preventDefault(), onNav(0, 1))
      }}
      aria-label={`Leave: ${state === 'none' ? 'none' : state === 'full' ? 'full day' : 'half day'}. Press to change.`}
      className={cn(
        'h-9 w-full rounded-md border text-[12px] font-semibold outline-none transition focus-visible:ring-[3px] focus-visible:ring-brand/20 disabled:cursor-not-allowed',
        state === 'full' ? 'border-line bg-surface-2 text-ink' : state === 'half' ? 'border-line bg-surface text-ink-2' : 'border-dashed border-line text-ink-3/60 enabled:hover:border-line-strong enabled:hover:text-ink',
        disabled && state === 'none' && 'border-transparent',
      )}
    >
      {state === 'full' ? `${min}h` : state === 'half' ? `${min / 2}h` : disabled ? '' : '+'}
    </button>
  )
}

/* ================================================================== */
/* Phone: day pills + per-day list                                    */
/* ================================================================== */
export function DayPills({ days, rows, selected, onSelect, today, breaksCount = true }: { days: WeekDay[]; rows: DraftRow[]; selected: string; onSelect: (d: string) => void; today: string; breaksCount?: boolean }) {
  const shown = days.filter((d) => !d.hidden)
  return (
    <div role="tablist" aria-label="Day" className="grid gap-1 rounded-lg border border-line bg-surface p-1" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
      {shown.map((d) => {
        const tot = round2(dayTotal(rows, d.date))
        const short = d.min_required > 0 && round2(countedTotal(rows, d.date, breaksCount)) < d.min_required && d.date < today
        const on = d.date === selected
        return (
          <button
            key={d.date}
            role="tab"
            aria-selected={on}
            type="button"
            onClick={() => onSelect(d.date)}
            className={cn('relative flex min-h-[60px] min-w-0 flex-col items-center justify-center rounded-md border transition', on ? 'border-brand bg-brand-soft text-brand-text' : muted(d) ? 'border-transparent bg-surface-2 text-ink-3' : 'border-transparent text-ink active:bg-surface-2')}
          >
            <span className={cn('text-[11px]', on ? 'text-brand-text' : 'text-ink-3')}>{dow(d.date)}</span>
            <span className={cn('tnum text-[15px] font-semibold leading-tight', d.date === today && !on && 'text-brand-text underline decoration-2 underline-offset-4')}>{parseISO(d.date).getDate()}</span>
            <span className={cn('tnum text-[11px] font-medium', on ? 'text-brand-text' : short ? 'text-danger-text' : tot ? 'text-ink-2' : 'text-ink-3/60')}>{tot ? fmtNum(tot, 1) : muted(d) ? (d.kind === 'holiday' ? 'Hol' : 'Off') : d.leave ? 'Lv' : '–'}</span>
          </button>
        )
      })}
    </div>
  )
}

export function DayList({ view, rows, editable, day, today, items, itemsLoading, onChange, onPick, empty = EMPTY_DRAFT, onEmpty, onAddTask }: GridProps & { day: WeekDay }) {
  const { step, max_hours: maxH, min_hours: minH } = view.rules
  const breaks = view.rules.breaks_count ?? true
  const projects = view.activity_projects ?? []
  const tot = round2(dayTotal(rows, day.date))
  const short = day.min_required > 0 && round2(countedTotal(rows, day.date, breaks)) < day.min_required && day.date < today
  const setRow = (ri: number, patch: Partial<DraftRow>) => onChange?.(rows.map((r, i) => (i === ri ? { ...r, ...patch } : r)))
  const setHours = (ri: number, h: number | null) => setRow(ri, { hours: { ...rows[ri].hours, [day.date]: h ?? 0 } })
  const options = pickOptions(items, rows)
  const note = dayNote(day)
  const visible = editable ? rows : rows.filter((r) => (r.hours[day.date] ?? 0) > 0)
  const groups: [string, DraftRow[]][] = [
    ['Tasks', visible.filter((r) => r.kind === 'task')],
    ['Activities', visible.filter((r) => r.kind !== 'task')],
  ]
  return (
    <div>
      <div className="mb-2 mt-4 flex items-end justify-between gap-2 px-1">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{parseISO(day.date).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</div>
          <div className="truncate text-[12.5px] text-ink-3">
            {day.holiday ? `Holiday · ${day.holiday}` : note ? note : day.min_required ? `Minimum ${minH}h` : 'No minimum'}
            {futureLocked(day) && ' · opens on the day'}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn('tnum whitespace-nowrap text-[20px] font-semibold leading-none', short ? 'text-danger-text' : tot ? 'text-ink' : 'text-ink-3')}>{fmtNum(tot, 2)}h</div>
          <div className={cn('tnum mt-1 text-[11.5px]', short ? 'text-danger-text' : 'text-ink-3')}>{day.min_required > 0 ? `of ${day.min_required}h` : '—'}</div>
        </div>
      </div>
      {visible.length === 0 && !editable ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-[13.5px] text-ink-3">Nothing logged on this day.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          {groups.map(([label, list]) => (
            <div key={label}>
              <div className="border-b border-line bg-surface-2 px-3.5 py-1.5 text-[12.5px] font-semibold text-ink">{label}</div>
              {!list.length && (
                <div className="border-b border-line px-3.5 py-2.5 text-[13px] text-ink-2">
                  {label === 'Tasks' ? (
                    editable ? (
                      <>
                        No task rows this week. Add one with{' '}
                        <button type="button" onClick={onAddTask} className="font-medium text-brand-text hover:underline">
                          “+ Add a task row”
                        </button>
                        .
                      </>
                    ) : (
                      'No task hours on this day.'
                    )
                  ) : editable ? (
                    'No activity rows yet. Use the empty row below.'
                  ) : (
                    'No activity hours on this day.'
                  )}
                </div>
              )}
              {label === 'Tasks' && editable && list.length > 0 && (
                <div className="border-b border-line px-3.5 py-2">
                  <button type="button" onClick={onAddTask} className="text-[13px] font-medium text-brand-text hover:underline">
                    + Add a task row
                  </button>
                </div>
              )}
              {list.map((r) => {
                const ri = rows.indexOf(r)
                const h = r.hours[day.date] ?? 0
                const dis = !editable || !!r.locked_reason || (r.kind !== 'leave' && !day.entry_allowed) || (r.kind === 'leave' && muted(day))
                const isBreaks = r.internal_code === 'breaks'
                return (
                  <div key={r.uid} className="border-b border-line px-3.5 py-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-1.5">
                          {r.wbs && <span className="tnum shrink-0 text-[12.5px] text-ink-3">{r.wbs}</span>}
                          <span className="truncate text-[14px] font-medium">{r.label}</span>
                        </div>
                        {(r.kind !== 'internal' || !editable) && <div className="truncate text-[12px] text-ink-3">{r.kind === 'internal' && r.project_id ? projects.find((p) => p.id === r.project_id)?.name ?? r.sublabel : r.sublabel}</div>}
                        {r.locked_reason && <div className="mt-0.5 text-[11.5px] font-medium text-info-text">{r.locked_reason}</div>}
                      </div>
                      {editable && !r.locked_reason && (
                        <IconButton size="sm" label={`Remove ${r.label} from the week`} className="-mr-1 -mt-1 text-ink-3" onClick={() => onChange?.(rows.filter((_, i) => i !== ri))}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      )}
                    </div>
                    {r.kind === 'internal' && editable && !isBreaks && (
                      <div className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                        <ProjectSelect value={r.project_id ?? null} onChange={(v) => setRow(ri, { project_id: v })} projects={projects} className="h-10 text-[14px]" />
                        <NoteInput value={r.note} onChange={(v) => setRow(ri, { note: v })} required={view.rules.note_required} label={`Note for ${r.label}`} className="h-10 text-[14px]" />
                      </div>
                    )}
                    {r.kind === 'internal' && !editable && r.note && <div className="mt-1 text-[12.5px] italic text-ink-2">“{r.note}”</div>}
                    <div className="mt-2.5">
                      {r.kind === 'leave' ? (
                        <div className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1">
                          {(['none', 'half', 'full'] as const).map((k) => {
                            const on = (k === 'none' && !h) || (k === 'half' && h > 0 && h < minH) || (k === 'full' && h >= minH)
                            return (
                              <button key={k} type="button" disabled={dis} onClick={() => setHours(ri, k === 'none' ? null : k === 'half' ? minH / 2 : minH)} className={cn('h-10 rounded-md text-[13px] font-medium transition disabled:opacity-50', on ? 'bg-surface text-ink ring-1 ring-line-strong' : 'text-ink-3')}>
                                {k === 'none' ? 'None' : k === 'half' ? 'Half day' : 'Full day'}
                              </button>
                            )
                          })}
                        </div>
                      ) : editable ? (
                        <Stepper h={h} step={step} maxH={maxH} disabled={dis} future={futureLocked(day) && !r.locked_reason} onChange={(v) => setHours(ri, v)} />
                      ) : (
                        <div className="tnum text-right text-[15px] font-semibold">{fmtNum(h, 2)}h</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          {editable && (
            <div className="bg-warning-soft/40 px-3.5 py-3">
              <Combobox
                id="ts-pick-m"
                value={null}
                onChange={(v) => {
                  const it = items?.find((x) => x.key === v)
                  if (it) onPick?.(it, { ...empty, hours: { ...empty.hours } })
                }}
                options={options}
                placeholder={itemsLoading ? 'Loading your tasks…' : 'Choose a task or activity…'}
                searchPlaceholder="Search tasks and activities"
                emptyText="Nothing matches. Only tasks you own, back up or are allocated to appear."
                className="h-11 bg-surface text-[14px]"
              />
              <div className="mt-2 grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
                <ProjectSelect value={empty.project_id} onChange={(v) => onEmpty?.({ ...empty, project_id: v })} projects={projects} className="h-10 text-[14px]" />
                <NoteInput value={empty.note} onChange={(v) => onEmpty?.({ ...empty, note: v })} label="Note for the new row" className="h-10 text-[14px]" />
              </div>
              <div className="mt-1.5 text-[12px] text-ink-3">Empty row: pick a task or activity. The project applies to activities.</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stepper({ h, step, maxH, disabled, future, onChange }: { h: number; step: number; maxH: number; disabled: boolean; future?: boolean; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" aria-label="Less" disabled={disabled || h <= 0} onClick={() => onChange(Math.max(0, round2(h - step)) || null)} className="grid size-11 shrink-0 place-items-center rounded-md border border-line-strong bg-surface text-ink transition active:bg-surface-2 disabled:opacity-40">
        <Minus className="size-5" />
      </button>
      <HourInput big value={h} step={step} max={maxH} disabled={disabled} future={future} onChange={onChange} className="min-w-0 flex-1 border-line-strong bg-surface" />
      <button type="button" aria-label="More" disabled={disabled || h >= maxH} onClick={() => onChange(Math.min(maxH, round2(h + step)))} className="grid size-11 shrink-0 place-items-center rounded-md border border-line-strong bg-surface text-ink transition active:bg-surface-2 disabled:opacity-40">
        <Plus className="size-5" />
      </button>
    </div>
  )
}

/** Compact read-only week (approvals, team). Shows the grid on desktop, day summaries on phones. */
export function WeekReadOnly({ view, compact }: { view: WeekView; compact?: boolean }) {
  const rows = view.rows.map((r, i) => ({ ...r, uid: String(i), locked_reason: null, hours: r.hours })) as unknown as DraftRow[]
  const shown = visibleDays(view)
  const [day, setDay] = useState(shown.find((d) => d.total > 0)?.date ?? view.week_start)
  const today = new Date().toISOString().slice(0, 10)
  return (
    <>
      <div className="hidden md:block">
        <DesktopGrid view={view} rows={rows} editable={false} today={today} compact={compact} />
      </div>
      <div className="md:hidden">
        <DayPills days={view.days} rows={rows} selected={day} onSelect={setDay} today={today} breaksCount={view.rules.breaks_count} />
        <DayList view={view} rows={rows} editable={false} today={today} day={view.days.find((d) => d.date === day) ?? shown[0]} />
      </div>
    </>
  )
}

export function Legend({ future }: { future?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
      {future && (
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-3.5 rounded-sm border border-dashed border-line-strong" />
          Days still ahead open on the day
        </span>
      )}
      <span>
        <span className="font-semibold text-danger-text">Red</span> day totals are short days (below the minimum)
      </span>
      <Tooltip content="Weekly offs and holidays are shaded. You can still log hours on them if you worked.">
        <span className="flex cursor-help items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-surface-2 ring-1 ring-line" />
          Weekly off / holiday
        </span>
      </Tooltip>
    </div>
  )
}
