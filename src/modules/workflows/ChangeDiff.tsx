// Before → after view of a maker-checker change. Objects get a field-level table; permission lists
// show what is added (success tone) and removed (danger tone); workflow changes render both chains.
import { useState, type ReactNode } from 'react'
import type { ApproverType, WorkflowStep } from '@/types/access'
import type { ChangeView } from '@/api/changes'
import { usePeopleMap } from '@/api/core'
import { DEFAULT_ROLES, PERMISSION_BY_KEY } from '@/domain/permissionCatalog'
import { fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button } from '@/ui'
import { ArrowRight } from '@/ui/icons'

const FIELD_LABEL: Record<string, string> = {
  role_key: 'Role', extra_permissions: 'Extra permissions', revoked_permissions: 'Removed permissions', permissions: 'Permissions', reports_to_id: 'Reports to', reports_to: 'Reports to',
  joined_on: 'Joining date', name: 'Name', description: 'Description', persona: 'Home dashboard', active: 'Active', status: 'Status', email: 'Email', enabled: 'Maker-checker',
  entities: 'Checked areas', sla_days: 'Checking deadline (working days)', summary: 'Route', steps: 'Steps', min_amount_paise: 'Only above', monthly_ctc_paise: 'Monthly CTC',
}
const ROLE_NAME: Record<string, string> = Object.fromEntries(DEFAULT_ROLES.map((r) => [r.key, r.name]))
const humanize = (k: string) => FIELD_LABEL[k] ?? (k.charAt(0).toUpperCase() + k.slice(1)).replace(/_id$/, '').replace(/_/g, ' ')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Flatten one nesting level ("Roles › HR Executive") so nested payloads still diff field by field. */
function flatten(o: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!o) return out
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v) && !('approver' in v)) for (const [k2, v2] of Object.entries(v)) out[`${humanize(k)} › ${humanize(k2)}`] = v2
    else out[k] = v
  }
  return out
}
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export function ChangeDiff({ c }: { c: ChangeView }) {
  if (c.entity === 'workflow' && (Array.isArray((c.after as { steps?: unknown })?.steps) || Array.isArray((c.before as { steps?: unknown })?.steps)))
    return <WorkflowDiff before={(c.before as { steps?: WorkflowStep[] } | null)?.steps ?? null} after={(c.after as { steps?: WorkflowStep[] } | null)?.steps ?? null} />
  return <FieldDiff before={c.before} after={c.after} action={c.action} />
}

function FieldDiff({ before, after, action }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null; action: ChangeView['action'] }) {
  const [showAll, setShowAll] = useState(false)
  const b = flatten(before)
  const a = flatten(after)
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
  const changed = keys.filter((k) => !same(b[k], a[k]))
  const unchanged = keys.filter((k) => same(b[k], a[k]))
  const lists = changed.filter((k) => Array.isArray(b[k] ?? []) && Array.isArray(a[k] ?? []) && (Array.isArray(b[k]) || Array.isArray(a[k])))
  const scalars = changed.filter((k) => !lists.includes(k))
  // a "create" that replaces something (e.g. a new salary row) still diffs against the current values
  const kind = !before ? 'create' : !after ? 'delete' : 'update'
  void action
  if (!keys.length) return <p className="text-[13px] text-ink-3">No field details were recorded for this change.</p>

  return (
    <div className="space-y-4">
      {lists.map((k) => <ListDiff key={k} label={humanize(k)} before={(b[k] as unknown[]) ?? []} after={(a[k] as unknown[]) ?? []} />)}
      {scalars.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="hidden grid-cols-[minmax(120px,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-line bg-surface-2 px-3 py-2 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 sm:grid">
            <span>Field</span>
            <span>{kind === 'create' ? '' : 'Before'}</span>
            <span>{kind === 'delete' ? '' : 'After'}</span>
          </div>
          <ul className="divide-y divide-line">
            {scalars.map((k) => (
              <li key={k} className="grid grid-cols-1 gap-1 px-3 py-2.5 sm:grid-cols-[minmax(120px,0.8fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-3">
                <span className="text-[12.5px] text-ink-3 sm:text-[13px] sm:text-ink-2">{humanize(k)}</span>
                {kind === 'create' ? (
                  <span className="min-w-0 break-words text-[13.5px] text-ink sm:col-span-2"><Value k={k} v={a[k]} /></span>
                ) : kind === 'delete' ? (
                  <span className="min-w-0 break-words text-[13.5px] text-danger-text line-through decoration-danger/50 sm:col-span-2"><Value k={k} v={b[k]} /></span>
                ) : (
                  <>
                    <span className="flex min-w-0 items-start gap-1.5 break-words text-[13.5px] text-ink-3">
                      <span className="shrink-0 text-[11.5px] font-medium uppercase tracking-[0.04em] sm:hidden">Before</span>
                      <span className="min-w-0 line-through decoration-ink-3/40"><Value k={k} v={b[k]} /></span>
                    </span>
                    <span className="flex min-w-0 items-start gap-1.5 break-words text-[13.5px] font-medium text-ink">
                      <span className="shrink-0 text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 sm:hidden">After</span>
                      <span className="min-w-0"><Value k={k} v={a[k]} /></span>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!changed.length && <p className="text-[13px] text-ink-3">The proposed values are the same as the current ones.</p>}
      {unchanged.length > 0 && kind === 'update' && (
        <div>
          <Button size="xs" variant="ghost" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide unchanged fields' : `Show ${unchanged.length} unchanged field${unchanged.length > 1 ? 's' : ''}`}</Button>
          {showAll && (
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-line px-3 py-2.5 sm:grid-cols-2">
              {unchanged.map((k) => (
                <div key={k} className="min-w-0">
                  <dt className="text-[12px] text-ink-3">{humanize(k)}</dt>
                  <dd className="break-words text-[13px] text-ink-2"><Value k={k} v={a[k]} /></dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

function Value({ k, v }: { k: string; v: unknown }) {
  const people = usePeopleMap()
  if (v === null || v === undefined || v === '') return <span className="text-ink-3">—</span>
  if (typeof v === 'boolean') return <>{k === 'enabled' ? (v ? 'On' : 'Off') : v ? 'Yes' : 'No'}</>
  if (typeof v === 'number') return <span className="tnum">{k.endsWith('_paise') ? fmtMoney(v) : v.toLocaleString('en-IN')}</span>
  if (typeof v === 'string') {
    if (/^u_[\w]+$/.test(v) || k.endsWith('_id')) return <>{people.get(v)?.name ?? v}</>
    if (k === 'role_key' || k === 'role') return <>{ROLE_NAME[v] ?? v}</>
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return <span className="tnum">{fmtDate(v)}</span>
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return <span className="tnum">{fmtDateTime(v)}</span>
    return <>{v}</>
  }
  if (Array.isArray(v)) return <>{v.length ? v.map((x) => labelOf(x)).join(', ') : 'None'}</>
  return <span className="font-mono text-[12px]">{JSON.stringify(v)}</span>
}
function labelOf(x: unknown): string {
  if (typeof x === 'string') return PERMISSION_BY_KEY[x]?.label ?? ROLE_NAME[x] ?? x
  return JSON.stringify(x)
}

/** Set difference of two lists — permissions, entities, people. */
function ListDiff({ label, before, after }: { label: string; before: unknown[]; after: unknown[] }) {
  const bs = new Set(before.map(String))
  const as = new Set(after.map(String))
  const added = [...as].filter((x) => !bs.has(x))
  const removed = [...bs].filter((x) => !as.has(x))
  return (
    <div className="rounded-lg border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-ink-3">{before.length} → {after.length}</span>
      </div>
      <div className="grid gap-3 px-3 py-2.5 sm:grid-cols-2">
        <Group title={`Added (${added.length})`} items={added} tone="success" />
        <Group title={`Removed (${removed.length})`} items={removed} tone="danger" />
      </div>
    </div>
  )
}
function Group({ title, items, tone }: { title: string; items: string[]; tone: 'success' | 'danger' }) {
  return (
    <div className="min-w-0">
      <div className={cn('mb-1.5 text-[12px] font-medium', tone === 'success' ? 'text-success-text' : 'text-danger-text')}>{title}</div>
      {items.length ? (
        <ul className="space-y-1">
          {items.map((x) => {
            const p = PERMISSION_BY_KEY[x]
            return (
              <li key={x} className={cn('rounded-md px-2 py-1.5 text-[13px]', tone === 'success' ? 'bg-success-soft text-success-text' : 'bg-danger-soft text-danger-text')}>
                <span className="font-medium">{tone === 'success' ? '+ ' : '− '}{p?.label ?? ROLE_NAME[x] ?? x}</span>
                {p?.sensitive && <span className="ml-1.5 text-[11.5px] opacity-80">sensitive</span>}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-[12.5px] text-ink-3">Nothing</p>
      )}
    </div>
  )
}

/* ---------------- workflow chains ---------------- */
const APPROVER_SHORT: Record<ApproverType, string> = {
  reports_to: 'Reporting manager', skip_level: 'Manager’s manager', role: 'Role', user: 'Person', project_pm: 'Project manager',
  project_pm_or_manager: 'Project manager, else reporting manager', department_head: 'Department head', task_reviewer: 'Task reviewer',
}
export function approverName(s: { approver: ApproverType; role_id?: string | null; user_id?: string | null }, roleName: (k: string) => string, personName: (id: string) => string) {
  if (s.approver === 'role') return s.role_id ? roleName(s.role_id) : 'A role'
  if (s.approver === 'user') return s.user_id ? personName(s.user_id) : 'A person'
  return APPROVER_SHORT[s.approver]
}

type Mark = 'added' | 'removed' | 'changed' | 'moved' | null
function WorkflowDiff({ before, after }: { before: WorkflowStep[] | null; after: WorkflowStep[] | null }) {
  const sig = (s: WorkflowStep) => JSON.stringify([s.name, s.approver, s.role_id ?? null, s.user_id ?? null, s.min_amount_paise ?? null, s.sla_days, s.escalate_to ?? null, !!s.allow_self])
  const b = before ?? []
  const a = after ?? []
  const bi = new Map(b.map((s, i) => [s.id, { s, i }]))
  const ai = new Map(a.map((s, i) => [s.id, { s, i }]))
  // Steps keep their id when edited, so an edit shows as "Changed" rather than removed + new.
  const markBefore = (s: WorkflowStep): Mark => (!ai.has(s.id) ? 'removed' : sig(ai.get(s.id)!.s) !== sig(s) ? 'changed' : null)
  const markAfter = (s: WorkflowStep, i: number): Mark => (!bi.has(s.id) ? 'added' : sig(bi.get(s.id)!.s) !== sig(s) ? 'changed' : bi.get(s.id)!.i !== i ? 'moved' : null)
  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-start">
      <ChainColumn title="Before" steps={before} mark={(s) => markBefore(s)} />
      <div className="hidden self-center text-ink-3 md:block"><ArrowRight className="size-5" /></div>
      <ChainColumn title="After" steps={after} mark={(s, i) => markAfter(s, i)} compareTo={(s) => bi.get(s.id)?.s ?? null} />
    </div>
  )
}

export function ChainColumn({ title, steps, mark, footer, roleNames, compareTo }: { title: ReactNode; steps: WorkflowStep[] | null; mark?: (s: WorkflowStep, i: number) => Mark; footer?: ReactNode; roleNames?: Record<string, string>; compareTo?: (s: WorkflowStep) => WorkflowStep | null }) {
  const people = usePeopleMap()
  const roleName = (k: string) => roleNames?.[k] ?? ROLE_NAME[k] ?? k
  const personName = (id: string) => people.get(id)?.name ?? 'Unknown person'
  return (
    <div className="min-w-0 rounded-lg border border-line">
      <div className="border-b border-line px-3 py-2 text-[13px] font-medium text-ink">{title}</div>
      {!steps || !steps.length ? (
        <p className="px-3 py-3 text-[13px] text-ink-3">No steps</p>
      ) : (
        <ol className="divide-y divide-line">
          {steps.map((s, i) => {
            const m = mark?.(s, i) ?? null
            const prev = m === 'changed' ? compareTo?.(s) ?? null : null
            const hl = (diff: boolean) => (prev && diff ? 'rounded-sm bg-warning-soft px-0.5 text-warning-text' : '')
            return (
              <li key={s.id + i} className={cn('flex gap-3 px-3 py-2.5', m === 'added' && 'bg-success-soft/60', m === 'removed' && 'bg-danger-soft/60')}>
                <span className="tnum grid size-6 shrink-0 place-items-center rounded-full border border-line bg-surface text-[12px] font-medium text-ink-2">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-words text-[13.5px] font-medium text-ink">{s.name}</span>
                    {m === 'added' && <Badge tone="success" size="sm">New</Badge>}
                    {m === 'removed' && <Badge tone="danger" size="sm">Removed</Badge>}
                    {m === 'changed' && <Badge tone="warning" size="sm">Changed</Badge>}
                    {m === 'moved' && <Badge tone="info" size="sm">Moved</Badge>}
                  </div>
                  <div className="mt-0.5 break-words text-[12.5px] text-ink-2">
                    <span className={hl(!!prev && (prev.approver !== s.approver || prev.role_id !== s.role_id || prev.user_id !== s.user_id))}>{approverName(s, roleName, personName)}</span>
                    {s.min_amount_paise ? <> · only above <span className={cn('tnum whitespace-nowrap', hl(!!prev && prev.min_amount_paise !== s.min_amount_paise))}>{fmtMoney(s.min_amount_paise)}</span></> : prev?.min_amount_paise ? <span className={hl(true)}> · every amount</span> : null}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-3">
                    <span className={hl(!!prev && prev.sla_days !== s.sla_days)}>{s.sla_days} working day{s.sla_days === 1 ? '' : 's'}</span>
                    {s.escalate_to ? ` · escalates to ${approverName(s.escalate_to, roleName, personName)}` : ''}
                    {s.allow_self ? ' · self-approval allowed' : ''}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {footer}
    </div>
  )
}
