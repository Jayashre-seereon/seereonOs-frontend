// Granular permission matrix: modules → permissions, with dependencies, locks, search and
// "only enabled". Desktop rows use checkboxes; phones get stacked rows with a switch.
// Used by the role editor (value = role permissions) and by person access (value = effective
// permissions, with `origin` telling which come from the role, which are extra, which are removed).
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, Lock, X } from '@/ui/icons'
import { MODULE_LABEL, MODULE_ORDER, PERMISSIONS, PERMISSION_BY_KEY, type PermissionDef, type PermissionKind } from '@/domain/permissionCatalog'
import { Badge, SearchInput, Switch } from '@/ui'
import { cn } from '@/lib/utils'

export const KIND_LABEL: Record<PermissionKind, string> = { view: 'View', create: 'Create', edit: 'Edit', approve: 'Approve', manage: 'Manage', sensitive: 'Sensitive' }
export const permLabel = (k: string) => PERMISSION_BY_KEY[k]?.label ?? k

/** Everything that (transitively) requires `key`. */
function dependentsOf(key: string): string[] {
  const out = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const p of PERMISSIONS as readonly PermissionDef[]) {
      if (out.has(p.key)) continue
      if ((p.requires ?? []).some((r) => r === key || out.has(r))) {
        out.add(p.key)
        grew = true
      }
    }
  }
  return [...out]
}
/** Everything `key` (transitively) requires. */
export function requirementsOf(key: string): string[] {
  const out = new Set<string>()
  const walk = (k: string) => {
    for (const r of PERMISSION_BY_KEY[k]?.requires ?? []) if (!out.has(r)) {
      out.add(r)
      walk(r)
    }
  }
  walk(key)
  return [...out]
}

/** Turn keys on or off with their dependencies. Returns the next set and what changed besides `keys`. */
export function toggleKeys(current: ReadonlySet<string>, keys: string[], on: boolean, locked: ReadonlySet<string>) {
  const next = new Set(current)
  const side = new Set<string>()
  if (on) {
    for (const k of keys) {
      next.add(k)
      for (const r of requirementsOf(k)) if (!next.has(r)) {
        next.add(r)
        if (!keys.includes(r)) side.add(r)
      }
    }
  } else {
    for (const k of keys) {
      if (locked.has(k)) continue
      next.delete(k)
      for (const d of dependentsOf(k)) if (next.has(d) && !locked.has(d)) {
        next.delete(d)
        if (!keys.includes(d)) side.add(d)
      }
    }
  }
  return { next, side: [...side] }
}

export type Origin = 'role' | 'extra' | 'removed' | null

/** Visual-only checkbox (the row itself is the control). */
function Box({ state, disabled }: { state: boolean | 'mixed'; disabled?: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-[17px] shrink-0 place-items-center rounded-[5px] border transition',
        state ? 'border-brand bg-brand text-brand-ink' : 'border-line-strong bg-surface',
        disabled && 'opacity-50',
      )}
    >
      {state === 'mixed' ? (
        <span className="h-[2px] w-2 rounded-full bg-current" />
      ) : state ? (
        <svg viewBox="0 0 16 16" className="size-3"><path d="M4 8.2l2.6 2.6L12 5.4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      ) : null}
    </span>
  )
}

export function PermissionMatrix({
  value, onChange, disabled, locked = [], lockedNote = 'Always on', origin, toolbarExtra, emptyHint, compact,
}: {
  value: string[]
  onChange?: (next: string[]) => void
  disabled?: boolean
  /** Keys that are on and can't be turned off. */
  locked?: string[]
  lockedNote?: string
  origin?: (key: string) => Origin
  toolbarExtra?: ReactNode
  emptyHint?: string
  compact?: boolean
}) {
  const [q, setQ] = useState('')
  const [onlyOn, setOnlyOn] = useState(false)
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const [note, setNote] = useState<string | null>(null)
  const set = useMemo(() => new Set(value), [value])
  const lockedSet = useMemo(() => new Set(locked), [locked])
  const ro = disabled || !onChange

  const apply = (keys: string[], on: boolean) => {
    if (ro) return
    const { next, side } = toggleKeys(set, keys, on, lockedSet)
    if (side.length) setNote(`${on ? 'Also turned on what this needs' : 'Also turned off what depends on it'}: ${side.map(permLabel).join(', ')}.`)
    else setNote(null)
    onChange!([...next].sort())
  }

  const s = q.trim().toLowerCase()
  const groups = MODULE_ORDER.map((m) => {
    const all = (PERMISSIONS as readonly PermissionDef[]).filter((p) => p.module === m)
    const shown = all.filter((p) => (!onlyOn || set.has(p.key)) && (!s || `${p.label} ${p.description} ${p.key}`.toLowerCase().includes(s)))
    return { module: m, all, shown, on: all.filter((p) => set.has(p.key)).length }
  }).filter((g) => g.shown.length)

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search permissions" className="sm:w-[260px] sm:shrink-0" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={onlyOn} onChange={setOnlyOn} />
            Only enabled
          </label>
          <span className="tnum text-[12.5px] text-ink-3">
            {set.size} of {PERMISSIONS.length} on
          </span>
          {toolbarExtra}
        </div>
      </div>
      {note && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-info/20 bg-info-soft px-3 py-2 text-[13px] text-ink-2" role="status">
          <span className="min-w-0 flex-1">{note}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)} className="grid size-6 shrink-0 place-items-center rounded text-ink-3 hover:text-ink">
            <X className="size-3.5" />
          </button>
        </div>
      )}
      {!groups.length && <div className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13.5px] text-ink-3">{emptyHint ?? (onlyOn ? 'Nothing is enabled yet.' : 'No permission matches your search.')}</div>}
      <div className="space-y-3">
        {groups.map((g) => {
          const isClosed = closed.has(g.module) && !s
          const editable = g.all.filter((p) => !lockedSet.has(p.key))
          const state: boolean | 'mixed' = g.on === 0 ? false : g.on === g.all.length ? true : 'mixed'
          return (
            <section key={g.module} className="overflow-hidden rounded-lg border border-line bg-surface">
              <div className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-3 py-2 sm:px-4">
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={state === 'mixed' ? 'mixed' : state}
                  aria-label={`All of ${MODULE_LABEL[g.module]}`}
                  disabled={ro || !editable.length}
                  onClick={() => apply(editable.map((p) => p.key), state !== true)}
                  className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-surface-2 disabled:cursor-not-allowed"
                >
                  <Box state={state} disabled={ro} />
                </button>
                <button type="button" onClick={() => setClosed((c) => { const n = new Set(c); n.has(g.module) ? n.delete(g.module) : n.add(g.module); return n })} className="flex min-w-0 flex-1 items-center gap-2 text-left" aria-expanded={!isClosed}>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{MODULE_LABEL[g.module]}</span>
                  <span className="tnum shrink-0 text-[12px] text-ink-3">
                    {g.on}/{g.all.length}
                  </span>
                  <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition', isClosed && '-rotate-90')} />
                </button>
              </div>
              {!isClosed && (
                <ul className="divide-y divide-line">
                  {g.shown.map((p) => {
                    const on = set.has(p.key)
                    const isLocked = lockedSet.has(p.key)
                    const rowDisabled = ro || isLocked
                    const o = origin?.(p.key) ?? null
                    return (
                      <li key={p.key}>
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on}
                          disabled={rowDisabled}
                          onClick={() => apply([p.key], !on)}
                          className={cn('flex w-full items-start gap-3 px-3 text-left transition sm:px-4', compact ? 'py-2' : 'py-2.5', !rowDisabled && 'hover:bg-surface-2', rowDisabled && 'cursor-default')}
                        >
                          <span className="hidden size-8 shrink-0 place-items-center lg:grid">
                            <Box state={on} disabled={rowDisabled && !isLocked} />
                          </span>
                          <span className="min-w-0 flex-1 lg:pt-1">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="text-[13.5px] font-medium text-ink">{p.label}</span>
                              {p.sensitive && (
                                <Badge tone="warning" size="sm">
                                  <Lock className="size-3" /> Sensitive
                                </Badge>
                              )}
                              {o === 'extra' && <Badge tone="brand" size="sm">Extra</Badge>}
                              {o === 'removed' && <Badge tone="danger" size="sm">Removed from role</Badge>}
                              {isLocked && <Badge size="sm">{lockedNote}</Badge>}
                              {p.kind !== 'sensitive' && <Badge size="sm" className="lg:hidden">{KIND_LABEL[p.kind]}</Badge>}
                            </span>
                            <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">{p.description}</span>
                            {!!p.requires?.length && <span className="mt-0.5 block text-[12px] text-ink-3">Needs {p.requires.map(permLabel).join(' and ')}</span>}
                          </span>
                          <span className="hidden w-[84px] shrink-0 pt-1.5 lg:block">
                            {p.kind !== 'sensitive' && <Badge size="sm">{KIND_LABEL[p.kind]}</Badge>}
                          </span>
                          <span className="shrink-0 pt-0.5 lg:hidden" aria-hidden>
                            <span className={cn('relative block h-[26px] w-[44px] rounded-full transition-colors', on ? 'bg-brand' : 'bg-line-strong', rowDisabled && 'opacity-50')}>
                              <span className={cn('absolute top-[2px] block size-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform', on ? 'translate-x-[20px]' : 'translate-x-[2px]')} />
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
