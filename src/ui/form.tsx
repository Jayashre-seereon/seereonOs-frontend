import { forwardRef, useEffect, useId, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import * as RSwitch from '@radix-ui/react-switch'
import { ChevronDown, Search, X } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { rupees } from '@/domain/money'

const control =
  'w-full rounded-md border border-line-strong/80 bg-surface px-3 text-ink shadow-[inset_0_1px_0_rgba(0,0,0,0.02)] placeholder:text-ink-3 transition-[border,box-shadow] outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/15 disabled:bg-surface-2 disabled:text-ink-3 aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/15'

export function Field({ label, hint, error, required, children, className, htmlFor, aside }: { label?: ReactNode; hint?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; className?: string; htmlFor?: string; aside?: ReactNode }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label && (
        <div className="flex items-baseline justify-between gap-2">
          <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink-2">
            {label}
            {required && <span className="ml-0.5 text-danger-text">*</span>}
          </label>
          {aside}
        </div>
      )}
      {children}
      {error ? <p className="text-[12.5px] font-medium text-danger-text">{error}</p> : hint ? <p className="text-[12.5px] text-ink-3">{hint}</p> : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; prefix?: ReactNode; suffix?: ReactNode }>(function Input(
  { className, invalid, prefix, suffix, ...rest },
  ref,
) {
  if (prefix || suffix)
    return (
      <div className={cn('relative flex items-center', className)}>
        {prefix && <span className="pointer-events-none absolute left-3 text-ink-3">{prefix}</span>}
        <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-[var(--ctl-h)]', prefix ? 'pl-8' : '', suffix ? 'pr-10' : '')} {...rest} />
        {suffix && <span className="absolute right-3 text-[13px] text-ink-3">{suffix}</span>}
      </div>
    )
  return <input ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-[var(--ctl-h)]', className)} {...rest} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(function Textarea({ className, invalid, rows = 3, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn(control, 'min-h-[84px] resize-y py-2.5 leading-relaxed', className)} {...rest} />
})

export interface Option {
  value: string
  label: string
  disabled?: boolean
}
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { options: (Option | string)[]; placeholder?: string; invalid?: boolean }>(function Select(
  { options, placeholder, className, invalid, ...rest },
  ref,
) {
  return (
    <div className={cn('relative', className)}>
      <select ref={ref} aria-invalid={invalid || undefined} className={cn(control, 'h-[var(--ctl-h)] appearance-none pr-9')} {...rest}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => {
          const op = typeof o === 'string' ? { value: o, label: o } : o
          return (
            <option key={op.value} value={op.value} disabled={op.disabled}>
              {op.label}
            </option>
          )
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
    </div>
  )
})

/** Money entered in rupees, stored in paise. */
export function MoneyInput({ value, onChange, id, invalid, placeholder = '0', disabled, className }: { value: number | null | undefined; onChange: (paise: number) => void; id?: string; invalid?: boolean; placeholder?: string; disabled?: boolean; className?: string }) {
  const [text, setText] = useState(value ? String(rupees(value)) : '')
  useEffect(() => {
    const cur = Number(text.replace(/,/g, ''))
    if (Math.round(cur * 100) !== (value ?? 0)) setText(value ? String(rupees(value)) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const show = text && !Number.isNaN(Number(text.replace(/,/g, ''))) ? new Intl.NumberFormat('en-IN').format(Number(text.replace(/,/g, ''))) : ''
  return (
    <div className={cn('relative', className)}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">₹</span>
      <input
        id={id}
        inputMode="decimal"
        disabled={disabled}
        aria-invalid={invalid || undefined}
        className={cn(control, 'tnum h-[var(--ctl-h)] pl-7')}
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/g, '')
          setText(v)
          onChange(Math.round(Number(v || 0) * 100))
        }}
        onBlur={() => show && setText(text.replace(/,/g, ''))}
      />
    </div>
  )
}

export function SearchInput({ value, onChange, placeholder = 'Search', className, autoFocus }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocus?: boolean }) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" aria-hidden />
      <input
        type="search"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(control, 'h-[var(--ctl-h)] pl-9 pr-8 [&::-webkit-search-cancel-button]:hidden')}
      />
      {value && (
        <button type="button" onClick={() => onChange('')} aria-label="Clear search" className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-full text-ink-3 hover:bg-surface-2">
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

export function Checkbox({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId()
  const cid = id ?? auto
  return (
    <label htmlFor={cid} className={cn('flex cursor-pointer items-start gap-2.5', disabled && 'cursor-not-allowed opacity-60')}>
      <input
        id={cid}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] size-[17px] shrink-0 cursor-pointer appearance-none rounded-[5px] border border-line-strong bg-surface transition checked:border-brand checked:bg-brand checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22><path d=%22M4 8.2l2.6 2.6L12 5.4%22 fill=%22none%22 stroke=%22white%22 stroke-width=%222.2%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>')] bg-center bg-no-repeat"
      />
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-[14px] font-medium text-ink">{label}</span>}
          {description && <span className="block text-[12.5px] text-ink-3">{description}</span>}
        </span>
      )}
    </label>
  )
}

export function Switch({ checked, onChange, label, description, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; id?: string }) {
  const auto = useId()
  const sid = id ?? auto
  const sw = (
    <RSwitch.Root
      id={sid}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className="relative h-[26px] w-[44px] shrink-0 cursor-pointer rounded-full bg-line-strong transition-colors data-[state=checked]:bg-brand disabled:cursor-not-allowed disabled:opacity-50"
    >
      <RSwitch.Thumb className="block size-[22px] translate-x-[2px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.25)] transition-transform data-[state=checked]:translate-x-[20px]" />
    </RSwitch.Root>
  )
  if (!label) return sw
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={sid} className="min-w-0 cursor-pointer">
        <span className="block text-[14px] font-medium text-ink">{label}</span>
        {description && <span className="block text-[12.5px] leading-snug text-ink-3">{description}</span>}
      </label>
      {sw}
    </div>
  )
}

/** iOS-style segmented control. */
export function Segmented<T extends string>({ value, onChange, options, size = 'md', className, block }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; size?: 'sm' | 'md'; className?: string; block?: boolean }) {
  return (
    <div role="tablist" className={cn('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md bg-surface-2 p-[3px] no-scrollbar', block && 'flex w-full', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          type="button"
          aria-selected={value === o.value}
          aria-label={typeof o.label === 'string' || typeof o.label === 'number' ? undefined : o.value.replace(/[_-]+/g, ' ')}
          title={typeof o.label === 'string' || typeof o.label === 'number' ? undefined : o.value.replace(/[_-]+/g, ' ')}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--r-md)-2px)] font-medium text-ink-2 transition-colors',
            size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3.5 text-[13px]',
            block && 'flex-1',
            value === o.value ? 'bg-surface text-ink ring-1 ring-line-strong' : 'hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className={cn('tnum text-[11.5px] font-semibold', value === o.value ? 'text-ink-3' : 'text-ink-3/80')}>{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** Filter chips (CMP-11) */
export function FilterChips<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; count?: number }[]; className?: string }) {
  return (
    <div className={cn('-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 no-scrollbar md:mx-0 md:flex-wrap md:px-0', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[13px] transition',
            value === o.value ? 'border-brand bg-brand-soft font-medium text-brand-text' : 'border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink',
          )}
        >
          {o.label}
          {o.count !== undefined && <span className={cn('tnum text-[12px]', value === o.value ? 'text-brand-text/80' : 'text-ink-3')}>{o.count}</span>}
        </button>
      ))}
    </div>
  )
}
