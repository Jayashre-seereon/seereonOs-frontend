import { useMemo, useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Check, ChevronDown, X } from '@/ui/icons'
import { usePeopleMap, type DirectoryPerson } from '@/api/core'
import { cn } from '@/lib/utils'
import { Avatar } from './data'
import { Popover } from './overlay'

export function PersonName({ id, withAvatar = true, size = 24, subtitle, className }: { id: string | null | undefined; withAvatar?: boolean; size?: number; subtitle?: ReactNode; className?: string }) {
  const { get } = usePeopleMap()
  const p = get(id)
  if (!id) return <span className="text-ink-3">Unassigned</span>
  if (!p) return <span className="text-ink-3">—</span>
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {withAvatar && <Avatar name={p.name} hue={p.avatar_hue} size={size} />}
      <span className="min-w-0">
        <span className="block truncate font-medium text-ink">{p.name}</span>
        {subtitle && <span className="block truncate text-[12px] text-ink-3">{subtitle}</span>}
      </span>
    </span>
  )
}

/** Generic searchable combobox (used for people, projects, tasks…). */
export interface ComboOption {
  value: string
  label: string
  hint?: string
  group?: string
  leading?: ReactNode
  disabled?: boolean
}
export function Combobox({
  value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Search', emptyText = 'No matches', clearable, invalid, disabled, className, id, renderValue,
}: {
  value: string | null
  onChange: (v: string | null) => void
  options: ComboOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  clearable?: boolean
  invalid?: boolean
  disabled?: boolean
  className?: string
  id?: string
  renderValue?: (o: ComboOption) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const sel = options.find((o) => o.value === value)
  const groups = useMemo(() => {
    const m = new Map<string, ComboOption[]>()
    for (const o of options) {
      const g = o.group ?? ''
      if (!m.has(g)) m.set(g, [])
      m.get(g)!.push(o)
    }
    return [...m.entries()]
  }, [options])
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="w-[min(92vw,var(--radix-popover-trigger-width))] min-w-[260px] p-0"
      trigger={
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-invalid={invalid || undefined}
          className={cn(
            'flex h-[var(--ctl-h)] w-full items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-3 text-left outline-none transition focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:bg-surface-2 aria-[invalid=true]:border-danger',
            className,
          )}
        >
          <span className={cn('min-w-0 flex-1 truncate', !sel && 'text-ink-3')}>{sel ? (renderValue ? renderValue(sel) : <span className="flex items-center gap-2">{sel.leading}<span className="truncate">{sel.label}</span></span>) : placeholder}</span>
          {clearable && sel ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear"
              onClick={(e) => {
                e.stopPropagation()
                onChange(null)
              }}
              className="grid size-5 place-items-center rounded-full text-ink-3 hover:bg-surface-2"
            >
              <X className="size-3.5" />
            </span>
          ) : (
            <ChevronDown className="size-4 shrink-0 text-ink-3" />
          )}
        </button>
      }
    >
      <Command className="flex max-h-[340px] flex-col" loop>
        <div className="border-b border-line px-3">
          <Command.Input autoFocus placeholder={searchPlaceholder} className="h-11 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3" />
        </div>
        <Command.List className="min-h-0 flex-1 overflow-y-auto p-1 scroll-thin">
          <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-3">{emptyText}</Command.Empty>
          {groups.map(([g, opts]) => (
            <Command.Group key={g} heading={g || undefined} className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-ink-3">
              {opts.map((o) => (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] data-[disabled=true]:cursor-not-allowed data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-40"
                >
                  {o.leading}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.label}</span>
                    {o.hint && <span className="block truncate text-[12px] text-ink-3">{o.hint}</span>}
                  </span>
                  {o.value === value && <Check className="size-4 text-brand-text" />}
                </Command.Item>
              ))}
            </Command.Group>
          ))}
        </Command.List>
      </Command>
    </Popover>
  )
}

/** CMP-10 PeoplePicker */
export function PeoplePicker({ value, onChange, filter, placeholder = 'Choose a person', clearable, invalid, id, includeInactive }: { value: string | null; onChange: (v: string | null) => void; filter?: (p: DirectoryPerson) => boolean; placeholder?: string; clearable?: boolean; invalid?: boolean; id?: string; includeInactive?: boolean }) {
  const { data } = usePeopleMap()
  const opts = (data ?? [])
    .filter((p) => (includeInactive || p.status === 'active') && (!filter || filter(p)))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<ComboOption>((p) => ({ value: p.id, label: p.name, hint: p.title, leading: <Avatar name={p.name} hue={p.avatar_hue} size={24} /> }))
  return <Combobox id={id} value={value} onChange={onChange} options={opts} placeholder={placeholder} searchPlaceholder="Search people" clearable={clearable} invalid={invalid} />
}
