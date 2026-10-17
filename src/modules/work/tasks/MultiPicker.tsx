// Multi-select picker (people or tasks) for the task form: a searchable popover list with check marks and
// removable chips for the current selection. Built on the same Popover + cmdk pieces as the single Combobox.
import { useState, type ReactNode } from 'react'
import { Command } from 'cmdk'
import { Check, ChevronDown, X } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { Popover } from '@/ui'

export interface MultiOption {
  value: string
  label: string
  hint?: string
  leading?: ReactNode
  disabled?: boolean
  /** short form shown on the chip (defaults to label) */
  chip?: string
}

export function MultiPicker({
  value, onChange, options, placeholder = 'Choose…', searchPlaceholder = 'Search', emptyText = 'No matches', id, invalid, max, disabled,
}: {
  value: string[]
  onChange: (v: string[]) => void
  options: MultiOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  id?: string
  invalid?: boolean
  max?: number
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const byValue = new Map(options.map((o) => [o.value, o]))
  const toggle = (v: string) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v))
    else if (!max || value.length < max) onChange([...value, v])
  }
  return (
    <div className="min-w-0 space-y-2">
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
            className="flex h-[var(--ctl-h)] w-full items-center gap-2 rounded-md border border-line-strong/80 bg-surface px-3 text-left outline-none transition focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:bg-surface-2 aria-[invalid=true]:border-danger"
          >
            <span className={cn('min-w-0 flex-1 truncate', !value.length && 'text-ink-3')}>{value.length ? `${value.length} selected` : placeholder}</span>
            <ChevronDown className="size-4 shrink-0 text-ink-3" />
          </button>
        }
      >
        <Command className="flex max-h-[340px] flex-col" loop>
          <div className="border-b border-line px-3">
            <Command.Input autoFocus placeholder={searchPlaceholder} className="h-11 w-full bg-transparent text-[14px] outline-none placeholder:text-ink-3" />
          </div>
          <Command.List className="min-h-0 flex-1 overflow-y-auto p-1 scroll-thin">
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-3">{emptyText}</Command.Empty>
            {options.map((o) => {
              const on = value.includes(o.value)
              return (
                <Command.Item
                  key={o.value}
                  value={`${o.label} ${o.hint ?? ''} ${o.value}`}
                  disabled={o.disabled}
                  onSelect={() => !o.disabled && toggle(o.value)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] data-[disabled=true]:cursor-not-allowed data-[selected=true]:bg-surface-2 data-[disabled=true]:opacity-45"
                >
                  <span className={cn('grid size-4 shrink-0 place-items-center rounded-[4px] border', on ? 'border-brand bg-brand text-white' : 'border-line-strong')}>{on && <Check className="size-3" />}</span>
                  {o.leading}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{o.label}</span>
                    {o.hint && <span className="block truncate text-[12px] text-ink-3">{o.hint}</span>}
                  </span>
                </Command.Item>
              )
            })}
          </Command.List>
          <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[12px] text-ink-3">
            <span className="tnum">{value.length} selected{max ? ` of up to ${max}` : ''}</span>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 font-medium text-brand-text hover:bg-surface-2">
              Done
            </button>
          </div>
        </Command>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => {
            const o = byValue.get(v)
            return (
              <span key={v} className="inline-flex max-w-full items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-[12.5px] text-ink-2">
                <span className="min-w-0 truncate">{o?.chip ?? o?.label ?? v}</span>
                <button type="button" aria-label={`Remove ${o?.label ?? v}`} disabled={disabled} onClick={() => onChange(value.filter((x) => x !== v))} className="grid size-5 shrink-0 place-items-center rounded text-ink-3 hover:bg-surface hover:text-ink">
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
