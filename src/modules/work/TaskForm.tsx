// v7 (CEO point 7) — the one Create task form used everywhere: Tasks tab, My tasks, Team tasks, the project WBS
// (+ Task per milestone), the dashboards' quick actions, a task's "Create sub-task / follow-up" and /tasks/new.
// Every rule (who may create for whom, defaults, numbering, notifications) is the server's (POST /tasks); the form
// mirrors the validation so mistakes show next to the field before the round trip.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, CalendarDays, Plus, Trash2, X } from '@/ui/icons'
import { taskV7Api, PRIORITY_P, type TaskCreateBody, type TaskCreateOptionProject, type TaskPriorityV7 } from '@/api/work'
import { workApi } from '@/api/work'
import { useApi, useMut } from '@/api/query'
import type { ApiError } from '@/api/http'
import { usePeopleMap, useTenant } from '@/api/core'
import { useSession } from '@/stores/session'
import { useUI } from '@/stores/ui'
import { COMPLEXITY, COMPLEXITY_ORDER, TASK_TAG_LABEL } from '@/domain/labels'
import { addDays, addWorkingDays, fmtDate, isWorkingDay, todayISO, workingDaysBetween, type CalendarCtx } from '@/domain/calendar'
import { fmtNum } from '@/domain/money'
import type { Complexity, Task, TaskTag } from '@/types/entities'
import { cn } from '@/lib/utils'
import {
  Avatar, Button, Callout, Combobox, Field, FileUpload, Input, PersonName, Segmented, Select, Sheet, Skeleton, Switch, Textarea, useReadOnly, type ComboOption,
} from '@/ui'
import { EstimateHintLine } from './taskStage'
import { MultiPicker, type MultiOption } from './tasks/MultiPicker'
import { useTaskInvalidate } from './TaskDrawerHost'

export interface TaskFormPrefill {
  project_id?: string | null
  milestone_id?: string | null
  owner_id?: string | null
  parent_task_id?: string | null
  depends_on?: string[]
  title?: string
  description?: string
  tag?: TaskTag
  reviewer_id?: string | null
}
type Created = Task & { wbs: string }
interface FileDraft {
  name: string
  size: number
  type: string
  data_url: string | null
}
interface Form {
  title: string
  description: string
  project_id: string
  milestone_id: string
  tag: TaskTag
  owner_id: string
  backup_id: string
  reviewer_id: string
  concerned_manager_id: string
  priority: TaskPriorityV7
  complexity: Complexity
  est: string
  start_on: string
  due_on: string
  depends_on: string[]
  watcher_ids: string[]
  criteria: string[]
  attachments: FileDraft[]
  labels: string[]
  billable: boolean
  recurrence: 'none' | 'weekly' | 'monthly'
  parent_task_id: string
}
const MAX_FILE = 750 * 1024
const PRIORITY_ORDER: TaskPriorityV7[] = ['urgent', 'high', 'normal', 'low']

/** Simple weekday fallback until the company calendar loads (the server applies the real one). */
function calendarFrom(settings: unknown, holidays: { date: string; optional?: boolean }[]): CalendarCtx | null {
  const s = settings as CalendarCtx['settings'] | undefined
  if (!s || !Array.isArray((s as Record<string, unknown>)['calendar.weekly_off'])) return null
  return { settings: s, holidays: holidays.map((h) => ({ date: h.date, optional: !!h.optional })) as CalendarCtx['holidays'] }
}

export function TaskForm({
  prefill, lockProject, lockMilestone, onCreated, onCancel, variant = 'sheet', heading,
  onOwnerChange, actionsTarget,
}: {
  prefill?: TaskFormPrefill
  lockProject?: boolean
  lockMilestone?: boolean
  onCreated?: (t: Created, open: boolean, another: boolean) => void
  onCancel?: () => void
  variant?: 'sheet' | 'page' | 'inline'
  heading?: (wbs: string) => void
  onOwnerChange?: (ownerId: string | null) => void
  /** render the action buttons into this element (a sheet footer) instead of below the form */
  actionsTarget?: HTMLElement | null
}) {
  const ro = useReadOnly()
  const me = useSession((s) => s.user)
  const sessionTenant = useSession((s) => s.tenant)
  const tenant = useTenant()
  const people = usePeopleMap()
  const inv = useTaskInvalidate()
  const today = todayISO()
  const opts = useApi(['tasks', 'create-options'], () => taskV7Api.options(), { staleTime: 15_000 })
  const hol = useApi(['tasks', 'form-holidays', today], () => workApi.holidays(addDays(today, -60), addDays(today, 400)), { staleTime: 300_000 })
  const cal = useMemo(() => calendarFrom((tenant.data ?? sessionTenant)?.settings, hol.data ?? []), [tenant.data, sessionTenant, hol.data])
  const o = opts.data

  const addWd = (from: string, n: number) => (cal ? addWorkingDays(from, n, cal) : addDays(from, n + Math.floor(n / 5) * 2))
  const blank = (): Form => ({
    title: prefill?.title ?? '', description: prefill?.description ?? '', project_id: prefill?.project_id ?? '', milestone_id: prefill?.milestone_id ?? '', tag: prefill?.tag ?? 'feature',
    owner_id: prefill?.owner_id ?? '', backup_id: '', reviewer_id: prefill?.reviewer_id ?? '', concerned_manager_id: '', priority: 'normal', complexity: 'medium', est: '8',
    start_on: today, due_on: addWd(today, 3), depends_on: prefill?.depends_on ?? [], watcher_ids: [], criteria: [], attachments: [], labels: [], billable: true, recurrence: 'none',
    parent_task_id: prefill?.parent_task_id ?? '',
  })
  const [f, setF] = useState<Form>(blank)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [showErrs, setShowErrs] = useState(false)
  const [general, setGeneral] = useState<string | null>(null)
  const [critText, setCritText] = useState('')
  const [labelText, setLabelText] = useState('')
  const [fileErr, setFileErr] = useState<string | null>(null)
  const openAfter = useRef(false)
  const another = useRef(false)

  const project: TaskCreateOptionProject | undefined = o?.projects.find((p) => p.id === f.project_id)
  const milestone = project?.milestones.find((m) => m.id === f.milestone_id)
  const isGeneral = !!project?.general
  const wbs = project ? (milestone ? milestone.next_wbs : project.milestones.length && !isGeneral ? '' : project.next_wbs_none) : ''
  useEffect(() => {
    heading?.(wbs)
  }, [wbs, heading])

  // first load: pick the project (prefill → General & admin), owner (prefill → me) and the milestone's dates
  useEffect(() => {
    if (!o || general) return
    setGeneral(o.general_project_id)
    setF((x) => {
      const pid = x.project_id && o.projects.some((p) => p.id === x.project_id) ? x.project_id : o.general_project_id
      const p = o.projects.find((pp) => pp.id === pid)
      const ms = p?.milestones.find((m) => m.id === x.milestone_id)
      const start = ms && ms.planned_start > today ? ms.planned_start : x.start_on
      const due = ms ? (addWd(start, 3) > ms.planned_end && ms.planned_end >= start ? ms.planned_end : addWd(start, 3)) : x.due_on
      return { ...x, project_id: pid, owner_id: x.owner_id || (p?.anyone ? '' : o.me), start_on: start, due_on: due, billable: !p?.general }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o])

  // defaults that follow the owner and project until the user changes them: reviewer, concerned manager, billable
  const ownerP = people.get(f.owner_id)
  const defaultReviewer = (() => {
    if (!project) return ''
    if (!isGeneral && project.pm_id && project.pm_id !== f.owner_id) return project.pm_id
    if (f.owner_id && f.owner_id !== me?.id) return me?.id ?? ''
    return ownerP?.reports_to_id ?? (ownerP ? ownerP.id : o?.my_manager_id ?? '') // the top person reviews their own self-tasks
  })()
  const defaultCm = ownerP?.reports_to_id && ownerP.reports_to_id !== f.owner_id ? ownerP.reports_to_id : ''
  useEffect(() => {
    setF((x) => ({
      ...x,
      reviewer_id: touched.reviewer_id ? x.reviewer_id : defaultReviewer,
      concerned_manager_id: touched.concerned_manager_id ? x.concerned_manager_id : defaultCm,
      billable: touched.billable ? x.billable : !isGeneral,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultReviewer, defaultCm, isGeneral])
  useEffect(() => {
    onOwnerChange?.(f.owner_id || null)
  }, [f.owner_id, onOwnerChange])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setTouched((t) => ({ ...t, [k]: true }))
    setErrs((e) => ({ ...e, [k]: '' }))
  }
  const pickProject = (pid: string) => {
    const p = o?.projects.find((x) => x.id === pid)
    setF((x) => ({
      ...x, project_id: pid, milestone_id: '', depends_on: [],
      owner_id: p && !p.anyone && x.owner_id && x.owner_id !== o?.me && !o?.team_ids.includes(x.owner_id) ? o?.me ?? '' : x.owner_id,
    }))
    setErrs((e) => ({ ...e, project_id: '', milestone_id: '', owner_id: '' }))
  }
  const pickMilestone = (mid: string) => {
    const m = project?.milestones.find((x) => x.id === mid)
    setF((x) => {
      if (!m || touched.start_on || touched.due_on) return { ...x, milestone_id: mid }
      const start = m.planned_start > today ? m.planned_start : today
      const due = addWd(start, 3) > m.planned_end && m.planned_end >= start ? m.planned_end : addWd(start, 3)
      return { ...x, milestone_id: mid, start_on: start, due_on: due }
    })
    setErrs((e) => ({ ...e, milestone_id: '' }))
  }

  /* ---------- derived planning numbers ---------- */
  const est = Number(f.est)
  const datesOk = /^\d{4}-\d{2}-\d{2}$/.test(f.start_on) && /^\d{4}-\d{2}-\d{2}$/.test(f.due_on) && f.due_on >= f.start_on
  const wd = datesOk ? (cal ? workingDaysBetween(f.start_on, f.due_on, cal) : Math.max(1, Math.round(((new Date(f.due_on).getTime() - new Date(f.start_on).getTime()) / 864e5 + 1) * (5 / 7)))) : 0
  const productive = (f.owner_id && o?.productive_hours[f.owner_id]) || 6
  const capacity = wd * productive
  const perDay = wd ? est / wd : 0
  const startOff = datesOk && cal ? !isWorkingDay(f.start_on, cal) : false
  const dueOff = datesOk && cal ? !isWorkingDay(f.due_on, cal) : false
  const outside = !!project && !isGeneral && datesOk && (f.start_on < project.start_on || f.due_on > project.end_on)
  const movesMs = !!milestone && datesOk && f.due_on > milestone.planned_end

  /* ---------- validation (mirrors the server) ---------- */
  const local: Record<string, string | null> = {
    title: f.title.trim().length < 3 ? 'Give the task a title (at least 3 characters).' : f.title.length > 200 ? 'Keep the title under 200 characters.' : null,
    project_id: !f.project_id ? 'Choose the concerned project, or General & admin.' : null,
    milestone_id: project?.milestone_required && !f.milestone_id ? 'Choose the milestone this task delivers.' : null,
    owner_id: !f.owner_id ? 'Choose who will do this task.' : null,
    backup_id: f.backup_id && f.backup_id === f.owner_id ? 'The backup must be someone else.' : null,
    reviewer_id: !f.reviewer_id ? 'Choose who approves completion.' : f.reviewer_id === f.owner_id && people.get(f.reviewer_id)?.reports_to_id ? 'The reviewer must be someone other than the owner.' : null,
    concerned_manager_id: f.concerned_manager_id && f.concerned_manager_id === f.owner_id && people.get(f.owner_id)?.reports_to_id ? 'Choose someone other than the owner.' : null,
    est: !(est >= 0.5 && est <= 999) ? 'Estimate between 0.5 and 999 hours.' : null,
    start_on: !/^\d{4}-\d{2}-\d{2}$/.test(f.start_on) ? 'Set a start date.' : null,
    due_on: !/^\d{4}-\d{2}-\d{2}$/.test(f.due_on) ? 'Set an end date.' : f.due_on < f.start_on ? 'The end date is before the start date.' : f.due_on < today ? 'The end date is in the past.' : null,
  }
  const err = (k: string) => (showErrs ? local[k] : null) || errs[k] || null

  const m = useMut((b: TaskCreateBody) => taskV7Api.create(b), {
    silentError: true,
    success: (t) => `Created ${t.wbs} ${t.title} · ${people.get(t.owner_id)?.name ?? 'owner'} notified`,
    onSuccess: (t) => {
      inv() // every task detail: the parent / dependencies now list the new task
      opts.refetch()
      if (another.current) {
        setF({ ...blank(), project_id: f.project_id, milestone_id: f.milestone_id, owner_id: f.owner_id, start_on: f.start_on, due_on: f.due_on })
        setShowErrs(false)
        setErrs({})
      }
      onCreated?.(t, openAfter.current, another.current)
    },
    onError: (e: ApiError) => {
      const map: Record<string, string> = { est_hours: 'est' }
      setErrs(e.field ? { [map[e.field] ?? e.field]: e.message } : { _: e.message })
    },
  })
  const submit = (open: boolean, more = false) => {
    setShowErrs(true)
    setErrs({})
    openAfter.current = open
    another.current = more
    if (Object.values(local).some(Boolean)) {
      setErrs({ _: 'Fix the highlighted fields.' })
      return
    }
    m.mutate({
      title: f.title.trim(), description: f.description.trim(), project_id: f.project_id, milestone_id: f.milestone_id || null, tag: f.tag, owner_id: f.owner_id,
      backup_id: f.backup_id || null, reviewer_id: f.reviewer_id, concerned_manager_id: f.concerned_manager_id || null, priority: f.priority, complexity: f.complexity,
      est_hours: Math.round(est * 4) / 4, start_on: f.start_on, due_on: f.due_on, depends_on: f.depends_on, watcher_ids: f.watcher_ids, acceptance_criteria: f.criteria,
      attachments: f.attachments, labels: f.labels, billable: f.billable, recurrence: f.recurrence, parent_task_id: f.parent_task_id || null,
    })
  }

  /* ---------- option lists ---------- */
  const active = (people.data ?? []).filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const projTeam = new Set(project?.team_ids ?? [])
  const ownerAllowed = (id: string) => !!project?.anyone || id === o?.me || (!!o?.can_assign_team && !!o?.team_ids.includes(id))
  const personOpt = (p: (typeof active)[number], hint?: string): ComboOption => ({ value: p.id, label: p.id === me?.id ? `${p.name} (me)` : p.name, hint: hint ?? p.title, leading: <Avatar name={p.name} hue={p.avatar_hue} size={22} /> })
  const ownerOpts: ComboOption[] = active.filter((p) => ownerAllowed(p.id)).map((p) => ({ ...personOpt(p), group: projTeam.size ? (projTeam.has(p.id) ? 'On this project' : 'Others') : undefined })).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') * -1)
  const reviewerOpts = active.filter((p) => p.id !== f.owner_id || !p.reports_to_id).map((p) => personOpt(p, p.id === defaultReviewer ? `${p.title} · default` : p.title))
  const cmOpts = active.filter((p) => p.id !== f.owner_id).map((p) => personOpt(p, p.id === defaultCm ? `${p.title} · reporting manager` : p.title))
  const backupOpts = active.filter((p) => p.id !== f.owner_id).map((p) => personOpt(p))
  const watcherOpts: MultiOption[] = active.filter((p) => p.id !== f.owner_id).map((p) => ({ value: p.id, label: p.name, hint: p.title, chip: p.name, leading: <Avatar name={p.name} hue={p.avatar_hue} size={22} /> }))
  const depOpts: MultiOption[] = (project?.tasks ?? []).map((t) => ({ value: t.id, label: `${t.wbs} ${t.title}`, chip: `${t.wbs} ${t.title.length > 28 ? t.title.slice(0, 27) + '…' : t.title}`, hint: `${people.get(t.owner_id)?.name ?? 'Unassigned'} · ${t.status === 'done' ? 'Done' : 'Open'}` }))
  const projectOpts: ComboOption[] = (o?.projects ?? []).map((p) => ({ value: p.id, label: p.general ? 'General & admin' : `${p.code} · ${p.name}`, hint: p.general ? 'Non-project work: admin, internal, self-tasks' : `${fmtDate(p.start_on)} – ${fmtDate(p.end_on)}${p.pm_id ? ` · PM ${people.get(p.pm_id)?.name ?? ''}` : ''}`, group: p.general ? 'Internal' : 'Projects you manage' }))

  if (opts.isLoading || !o)
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )

  const selfOnly = !!project && !project.anyone && !o.can_assign_team
  const addCriterion = () => {
    const t = critText.trim()
    if (!t) return
    if (f.criteria.length >= 30) return setErrs((e) => ({ ...e, acceptance_criteria: 'Up to 30 items.' }))
    if (t.length > 300) return setErrs((e) => ({ ...e, acceptance_criteria: 'Keep each item under 300 characters.' }))
    set('criteria', [...f.criteria, t])
    setCritText('')
  }
  const addLabel = (raw: string) => {
    const t = raw.trim().replace(/,$/, '').trim()
    if (!t) return
    if (f.labels.includes(t)) return setLabelText('')
    if (f.labels.length >= 10) return setErrs((e) => ({ ...e, labels: 'Up to 10 labels.' }))
    if (t.length > 30) return setErrs((e) => ({ ...e, labels: 'Keep labels under 30 characters.' }))
    set('labels', [...f.labels, t])
    setLabelText('')
  }
  const addFile = (file: File) => {
    setFileErr(null)
    if (f.attachments.length >= 5) return setFileErr('Attach up to 5 files.')
    if (file.size > MAX_FILE) return setFileErr(`${file.name} is larger than 750 KB. Put a link in the description instead.`)
    const r = new FileReader()
    r.onload = () => set('attachments', [...f.attachments, { name: file.name, size: file.size, type: file.type || 'application/octet-stream', data_url: typeof r.result === 'string' ? r.result : null }])
    r.onerror = () => setFileErr(`${file.name} could not be read.`)
    r.readAsDataURL(file)
  }
  const insertAtLines = (prefix: (i: number) => string) => {
    const lines = f.description ? f.description.split('\n') : ['']
    set('description', lines.map((l, i) => (l.trim() ? `${prefix(i)}${l.replace(/^(\s*[-•]\s+|\s*\d+\.\s+)/, '')}` : l)).join('\n') || prefix(0))
  }

  const actions = (
    <div className={cn('grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end', actionsTarget ? 'w-full' : 'mt-6 border-t border-line pt-4')}>
      {errs._ && <span className="col-span-2 text-[12.5px] font-medium text-danger-text sm:mr-auto">{errs._}</span>}
      {onCancel && (
        <Button variant="secondary" onClick={onCancel} disabled={m.isPending} className={cn(variant === 'sheet' && 'hidden sm:inline-flex', variant === 'page' && 'order-last col-span-2 sm:order-none')}>
          Cancel
        </Button>
      )}
      {variant === 'page' && (
        <Button variant="secondary" loading={m.isPending && another.current} disabled={ro} onClick={() => submit(false, true)} className="order-last col-span-2 sm:order-none">
          Create and add another
        </Button>
      )}
      <Button variant="secondary" loading={m.isPending && openAfter.current && !another.current} disabled={ro} onClick={() => submit(true)}>
        Create and open
      </Button>
      <Button variant="primary" loading={m.isPending && !openAfter.current && !another.current} disabled={ro} onClick={() => submit(false)}>
        Create task
      </Button>
    </div>
  )

  return (
    <div className="min-w-0">
      {f.parent_task_id && (
        <Callout tone="info" className="mb-4" title={f.depends_on.length ? 'Follow-up task' : 'Sub-task'}>
          {(() => {
            const parent = project?.tasks.find((t) => t.id === f.parent_task_id)
            return parent ? `Linked to ${parent.wbs} ${parent.title}.${f.depends_on.includes(parent.id) ? ' It starts after that task is done.' : ''}` : 'Linked to the task you came from.'
          })()}
        </Callout>
      )}
      <FormSection title="Task">
        <Field label="Title" required error={err('title')} className="md:col-span-2" htmlFor="tf-title">
          <Input id="tf-title" autoFocus={variant !== 'inline'} value={f.title} maxLength={200} invalid={!!err('title')} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Fee receipt PDF with GST breakup" />
        </Field>
        <Field label="Description" hint="Context, links and notes for the owner. Line breaks and bullets are kept." className="md:col-span-2" error={err('description')}>
          <div className="overflow-hidden rounded-md border border-line-strong/80 focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand/15">
            <div className="flex items-center gap-1 border-b border-line bg-surface-2/60 px-1.5 py-1">
              <button type="button" onClick={() => insertAtLines(() => '- ')} className="rounded px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface">• Bulleted list</button>
              <button type="button" onClick={() => insertAtLines((i) => `${i + 1}. `)} className="rounded px-2 py-1 text-[12px] font-medium text-ink-2 hover:bg-surface">1. Numbered list</button>
              <span className="tnum ml-auto pr-1 text-[11.5px] text-ink-3">{f.description.length}/6000</span>
            </div>
            <textarea
              rows={variant === 'inline' ? 3 : 4}
              value={f.description}
              maxLength={6000}
              onChange={(e) => set('description', e.target.value)}
              className="block w-full resize-y bg-surface px-3 py-2 text-[14px] leading-relaxed outline-none placeholder:text-ink-3"
              placeholder="What needs to be done and why"
            />
          </div>
        </Field>
        <Field label="Task type" htmlFor="tf-tag">
          <Select id="tf-tag" value={f.tag} onChange={(e) => set('tag', e.target.value as TaskTag)} options={(Object.keys(TASK_TAG_LABEL) as TaskTag[]).map((k) => ({ value: k, label: TASK_TAG_LABEL[k].label }))} />
        </Field>
        <Field label="Priority">
          <Segmented<TaskPriorityV7> block size="sm" value={f.priority} onChange={(v) => set('priority', v)} options={PRIORITY_ORDER.map((p) => ({ value: p, label: PRIORITY_P[p].code }))} />
          <span className="mt-1 block text-[12px] text-ink-3">{PRIORITY_P[f.priority].label}</span>
        </Field>
      </FormSection>

      <FormSection title="Project">
        <Field htmlFor="tf-project" label="Concerned project" required error={err('project_id')} hint={isGeneral ? 'General & admin: internal or non-project work, not billed to a client.' : project ? `${fmtDate(project.start_on)} – ${fmtDate(project.end_on)}` : undefined}>
          {lockProject && project ? (
            <div className="flex h-[var(--ctl-h)] items-center rounded-md border border-line bg-surface-2 px-3 text-[14px]">{isGeneral ? 'General & admin' : `${project.code} · ${project.name}`}</div>
          ) : (
            <Combobox id="tf-project" value={f.project_id || null} onChange={(v) => v && pickProject(v)} options={projectOpts} placeholder="Choose a project" searchPlaceholder="Search projects" invalid={!!err('project_id')} />
          )}
        </Field>
        <Field htmlFor="tf-milestone" label="Milestone" required={!!project?.milestone_required} error={err('milestone_id')} hint={project && !project.milestones.length ? (isGeneral ? 'General work has no milestones.' : 'This project has no milestones yet.') : milestone ? `Due ${fmtDate(milestone.planned_end)} · this task will be ${milestone.next_wbs}` : 'Numbered M1, M2… in creation order.'}>
          {lockMilestone && milestone ? (
            <div className="flex h-[var(--ctl-h)] items-center rounded-md border border-line bg-surface-2 px-3 text-[14px]">M{milestone.no} {milestone.name}</div>
          ) : (
            <Select
              id="tf-milestone"
              value={f.milestone_id}
              disabled={!project?.milestones.length}
              invalid={!!err('milestone_id')}
              onChange={(e) => pickMilestone(e.target.value)}
              options={[{ value: '', label: project?.milestone_required ? 'Choose a milestone' : 'No milestone' }, ...(project?.milestones ?? []).map((x) => ({ value: x.id, label: `M${x.no} ${x.name}` }))]}
            />
          )}
        </Field>
      </FormSection>

      <FormSection title="People" hint="The owner is notified; the reviewer approves completion; the concerned manager and watchers are kept informed.">
        <Field htmlFor="tf-owner" label="Owner / assignee" required error={err('owner_id')} hint={selfOnly ? 'Self-task: you can create general tasks for yourself. Your manager reviews it.' : isGeneral && !project?.anyone ? 'Yourself or someone who reports to you.' : 'Anyone; people on the project are listed first.'}>
          {selfOnly ? (
            <div className="flex h-[var(--ctl-h)] items-center rounded-md border border-line bg-surface-2 px-3">
              <PersonName id={o.me} size={22} />
            </div>
          ) : (
            <Combobox id="tf-owner" value={f.owner_id || null} onChange={(v) => set('owner_id', v ?? '')} options={ownerOpts} placeholder="Choose the owner" searchPlaceholder="Search people" invalid={!!err('owner_id')} />
          )}
        </Field>
        <Field htmlFor="tf-backup" label="Backup" hint="Optional. Covers the task on the owner’s leave days." error={err('backup_id')}>
          <Combobox id="tf-backup" value={f.backup_id || null} onChange={(v) => set('backup_id', v ?? '')} options={backupOpts} placeholder="No backup" searchPlaceholder="Search people" clearable invalid={!!err('backup_id')} />
        </Field>
        <Field htmlFor="tf-reviewer" label="Task reviewer" required error={err('reviewer_id')} hint={f.reviewer_id === defaultReviewer ? (isGeneral ? 'Default: the assigning manager (or your manager for a self-task).' : 'Default: the project manager.') : 'Approves completion with a quality rating.'}>
          <Combobox id="tf-reviewer" value={f.reviewer_id || null} onChange={(v) => set('reviewer_id', v ?? '')} options={reviewerOpts} placeholder="Who approves completion" searchPlaceholder="Search people" invalid={!!err('reviewer_id')} />
        </Field>
        <Field htmlFor="tf-cm" label="Concerned manager" error={err('concerned_manager_id')} hint={f.concerned_manager_id && f.concerned_manager_id === defaultCm ? 'Default: the owner’s reporting manager.' : 'Accountable line manager; sees the task and its progress.'}>
          <Combobox id="tf-cm" value={f.concerned_manager_id || null} onChange={(v) => set('concerned_manager_id', v ?? '')} options={cmOpts} placeholder="No concerned manager" searchPlaceholder="Search people" clearable invalid={!!err('concerned_manager_id')} />
        </Field>
        <Field htmlFor="tf-watchers" label="Watchers" hint="Followers notified when the task is created and completed." className="md:col-span-2" error={err('watcher_ids')}>
          <MultiPicker id="tf-watchers" value={f.watcher_ids} onChange={(v) => set('watcher_ids', v)} options={watcherOpts} placeholder="Add watchers" searchPlaceholder="Search people" max={20} />
        </Field>
      </FormSection>

      <FormSection title="Planning">
        <Field label="Complexity" hint="Feeds estimation accuracy in Insights." className="md:col-span-2">
          <Segmented<Complexity> block size="sm" value={f.complexity} onChange={(v) => set('complexity', v)} options={COMPLEXITY_ORDER.map((c) => ({ value: c, label: COMPLEXITY[c].label }))} />
        </Field>
        <Field htmlFor="tf-est" label="Estimated hours" required error={err('est')}>
          <Input id="tf-est" inputMode="decimal" suffix="h" value={f.est} invalid={!!err('est')} onChange={(e) => set('est', e.target.value.replace(/[^0-9.]/g, ''))} />
        </Field>
        <Field htmlFor="tf-deps" label="Depends on" hint={project?.tasks.length ? 'It can’t start while one of these is open.' : 'No other tasks you can link in this project.'} error={err('depends_on')}>
          <MultiPicker id="tf-deps" value={f.depends_on} onChange={(v) => set('depends_on', v)} options={depOpts} placeholder={project?.tasks.length ? 'No dependencies' : 'Nothing to depend on'} searchPlaceholder="Search tasks by number or title" disabled={!project?.tasks.length} max={30} />
        </Field>
        <EstimateHintLine className="md:col-span-2" ownerId={f.owner_id || null} complexity={f.complexity} est={est || null} onApply={(h) => set('est', String(h))} />
        <Field htmlFor="tf-start" label="Start date" required error={err('start_on')}>
          <Input id="tf-start" type="date" value={f.start_on} invalid={!!err('start_on')} onChange={(e) => set('start_on', e.target.value)} />
        </Field>
        <Field htmlFor="tf-due" label="End / due date" required error={err('due_on')}>
          <Input id="tf-due" type="date" value={f.due_on} min={f.start_on} invalid={!!err('due_on')} onChange={(e) => set('due_on', e.target.value)} />
        </Field>
        <div className="md:col-span-2">
          <PlanningNote
            wd={wd} est={est} perDay={perDay} capacity={capacity} productive={productive} ownerName={ownerP?.name ?? null} datesOk={datesOk}
            warnings={[
              startOff ? `${fmtDate(f.start_on)} (start) is a holiday or weekly off.` : null,
              dueOff ? `${fmtDate(f.due_on)} (end) is a holiday or weekly off.` : null,
              outside && project ? `Runs outside ${project.code}’s dates (${fmtDate(project.start_on)} – ${fmtDate(project.end_on)}).` : null,
              movesMs && milestone ? `Ends after M${milestone.no}’s deadline (${fmtDate(milestone.planned_end)}): the milestone deadline moves to ${fmtDate(f.due_on)}.` : null,
            ].filter(Boolean) as string[]}
          />
        </div>
      </FormSection>

      <FormSection title="Definition of done" hint="Acceptance criteria the reviewer checks. The owner ticks them off on the task.">
        <div className="md:col-span-2">
          {f.criteria.length > 0 && (
            <ol className="mb-2 divide-y divide-line rounded-lg border border-line">
              {f.criteria.map((c, i) => (
                <li key={i} className="flex items-start gap-2 px-3 py-2 text-[13.5px]">
                  <span className="tnum mt-px w-5 shrink-0 text-ink-3">{i + 1}.</span>
                  <span className="min-w-0 flex-1 break-words">{c}</span>
                  <button type="button" aria-label={`Remove criterion ${i + 1}`} onClick={() => set('criteria', f.criteria.filter((_, j) => j !== i))} className="grid size-6 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface-2 hover:text-ink">
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex gap-2">
            <Input
              value={critText}
              maxLength={300}
              onChange={(e) => setCritText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addCriterion()
                }
              }}
              placeholder="e.g. Payslip PDF matches the approved template"
              aria-label="New acceptance criterion"
            />
            <Button variant="secondary" icon={<Plus className="size-4" />} onClick={addCriterion} disabled={!critText.trim()} className="shrink-0">
              Add
            </Button>
          </div>
          {errs.acceptance_criteria && <p className="mt-1.5 text-[12.5px] font-medium text-danger-text">{errs.acceptance_criteria}</p>}
        </div>
      </FormSection>

      <FormSection title="Tracking">
        <Field label="Labels" hint="Press Enter to add. Used to filter the Tasks tab." error={errs.labels || null}>
          <div className="space-y-2">
            <Input
              value={labelText}
              list="task-label-suggestions"
              maxLength={30}
              onChange={(e) => (e.target.value.endsWith(',') ? addLabel(e.target.value) : setLabelText(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addLabel(labelText)
                }
              }}
              onBlur={() => labelText.trim() && addLabel(labelText)}
              placeholder="e.g. integration"
              aria-label="Add a label"
            />
            <datalist id="task-label-suggestions">
              {o.labels.filter((l) => !f.labels.includes(l)).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
            {f.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {f.labels.map((l) => (
                  <span key={l} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-[12.5px] text-ink-2">
                    {l}
                    <button type="button" aria-label={`Remove label ${l}`} onClick={() => set('labels', f.labels.filter((x) => x !== l))} className="grid size-5 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink">
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </Field>
        <Field htmlFor="tf-repeat" label="Repeat" hint={f.recurrence === 'none' ? 'One-off task.' : `When it’s approved, the next one is created ${f.recurrence === 'weekly' ? 'a week' : 'a month'} later with the same people.`}>
          <Select
            id="tf-repeat"
            value={f.recurrence}
            onChange={(e) => set('recurrence', e.target.value as Form['recurrence'])}
            options={[
              { value: 'none', label: 'Does not repeat' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
        </Field>
        <div className="md:col-span-2">
          <Switch checked={f.billable} onChange={(v) => set('billable', v)} label="Billable" description={f.billable ? 'Hours count as billable client work.' : 'Internal, non-billable work.'} />
        </div>
        <Field label="Attachments" hint="Up to 5 files, 750 KB each. Put links to bigger files in the description." className="md:col-span-2">
          <div className="space-y-2">
            {f.attachments.map((a, i) => (
              <div key={i} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{a.name}</span>
                <span className="tnum shrink-0 text-[12px] text-ink-3">{Math.max(1, Math.round(a.size / 1024))} KB</span>
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => set('attachments', f.attachments.filter((_, j) => j !== i))} className="grid size-7 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink">
                  <Trash2 className="size-4" />
                </button>
              </div>
            ))}
            {f.attachments.length < 5 && <FileUpload onFile={addFile} maxMb={0.75} label="Attach a file" hint="PDF, image, spreadsheet, document or text · up to 750 KB" />}
            {(fileErr || errs.attachments) && <p className="text-[12.5px] font-medium text-danger-text">{fileErr || errs.attachments}</p>}
          </div>
        </Field>
      </FormSection>
      {actionsTarget ? createPortal(actions, actionsTarget) : actions}
    </div>
  )
}

function FormSection({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0 [&+section]:mt-5">
      <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

function PlanningNote({ wd, est, perDay, capacity, productive, ownerName, datesOk, warnings }: { wd: number; est: number; perDay: number; capacity: number; productive: number; ownerName: string | null; datesOk: boolean; warnings: string[] }) {
  if (!datesOk) return null
  const over = est > 0 && capacity > 0 && est > capacity
  return (
    <div className="space-y-1.5">
      <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-[12.5px] leading-snug', over ? 'border-warning/40 bg-warning-soft/40 text-warning-text' : 'border-line bg-surface-2/60 text-ink-3')}>
        <CalendarDays className="mt-px size-4 shrink-0" />
        <span className="tnum min-w-0">
          {wd} working day{wd === 1 ? '' : 's'}
          {est > 0 && wd > 0 ? ` · ${fmtNum(perDay, 1)}h a day` : ''}
          {ownerName ? ` · ${ownerName} plans ${fmtNum(productive, 1)} productive hours a day (${fmtNum(capacity, 0)}h in this window)` : ''}
          {over ? '. The estimate doesn’t fit: move the end date or split the task.' : ''}
        </span>
      </div>
      {warnings.map((w) => (
        <p key={w} className="flex items-start gap-1.5 text-[12.5px] text-warning-text">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span className="min-w-0">{w}</span>
        </p>
      ))}
    </div>
  )
}

/** The form in a right-hand sheet (bottom sheet on phones). Opens the created task when asked. */
export function TaskFormSheet({
  open, onOpenChange, prefill, lockProject, lockMilestone, title = 'Create task', subtitle, onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  prefill?: TaskFormPrefill
  lockProject?: boolean
  lockMilestone?: boolean
  title?: string
  subtitle?: ReactNode
  onCreated?: (t: Created, open: boolean) => void
}) {
  const [wbs, setWbs] = useState('')
  const [footer, setFooter] = useState<HTMLDivElement | null>(null)
  return (
    <Sheet open={open} onOpenChange={onOpenChange} width={760} title={`${title}${wbs ? ` ${wbs}` : ''}`} subtitle={subtitle ?? 'Every field a reviewer needs: owner, reviewer, dates, estimate and definition of done.'} footer={<div ref={setFooter} className="w-full" />}>
      {open && (
        <TaskForm
          actionsTarget={footer}
          prefill={prefill}
          lockProject={lockProject}
          lockMilestone={lockMilestone}
          variant="sheet"
          heading={setWbs}
          onCancel={() => onOpenChange(false)}
          onCreated={(t, andOpen) => {
            onOpenChange(false)
            if (andOpen) useUI.getState().openTask(t.id)
            onCreated?.(t, andOpen)
          }}
        />
      )}
    </Sheet>
  )
}

/** A "Create task" button that opens the shared sheet and, on "Create and open", the new task's drawer. */
export function CreateTaskButton({ prefill, label = 'Create task', variant = 'primary', size = 'sm', lockProject, lockMilestone, className, onCreated }: { prefill?: TaskFormPrefill; label?: string; variant?: 'primary' | 'secondary'; size?: 'xs' | 'sm' | 'md'; lockProject?: boolean; lockMilestone?: boolean; className?: string; onCreated?: (t: Created, open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const ro = useReadOnly()
  return (
    <>
      <Button size={size} variant={variant} icon={<Plus className="size-4" />} onClick={() => setOpen(true)} disabled={ro} className={className}>
        {label}
      </Button>
      <TaskFormSheet open={open} onOpenChange={setOpen} prefill={prefill} lockProject={lockProject} lockMilestone={lockMilestone} onCreated={onCreated} />
    </>
  )
}

export type { Created as CreatedTask }
