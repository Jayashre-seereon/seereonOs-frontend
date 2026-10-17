// Shared bits for Module A admin screens.
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '@/ui'
import type { Role } from '@/types/entities'
import type { Tone } from '@/domain/labels'
import { ROLE_LABEL } from '@/domain/permissions'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/api/http'

export const ROLE_TONE: Record<Role, Tone> = { admin: 'brand', pm: 'info', sales: 'accent', ops: 'warning', employee: 'neutral' }
export function RoleBadge({ role, size }: { role: Role; size?: 'sm' | 'md' }) {
  return (
    <Badge tone={ROLE_TONE[role]} size={size}>
      {ROLE_LABEL[role].replace(' (CEO)', '')}
    </Badge>
  )
}

/** Sticky save bar shown while a form is dirty. Sits above the phone tab bar. */
export function SaveBar({ dirty, saving, onSave, onDiscard, label = 'You have unsaved changes', count }: { dirty: boolean; saving?: boolean; onSave: () => void; onDiscard: () => void; label?: string; count?: number }) {
  // Portalled to <body>: an animated (transformed) page wrapper would otherwise become the containing block for `fixed`.
  if (typeof document === 'undefined') return null
  return createPortal(
    <div
      aria-hidden={!dirty}
      className={cn(
        'fixed inset-x-0 z-30 transition-all duration-150 lg:left-auto lg:right-8 lg:w-[480px]',
        'bottom-[calc(59px+env(safe-area-inset-bottom,0px))] lg:bottom-6',
        dirty ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
      )}
    >
      <div className="flex items-center gap-2 border-t border-line bg-surface px-4 py-2.5 lg:rounded-lg lg:border lg:shadow-lg">
        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-2">
          {label}
          {count ? <span className="text-ink-3"> · {count}</span> : null}
        </span>
        <Button size="sm" variant="secondary" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button size="sm" variant="primary" onClick={onSave} loading={saving}>
          Save
        </Button>
      </div>
    </div>,
    document.body,
  )
}

/** A settings row: label + help on the left, control on the right (stacks on phones). */
export function SettingRow({ label, help, children, error, stack, id }: { label: ReactNode; help?: ReactNode; children: ReactNode; error?: string | null; stack?: boolean; id?: string }) {
  return (
    <div id={id} className={cn('flex scroll-mt-24 flex-col gap-2.5 px-4 py-3.5 md:px-5', !stack && 'sm:flex-row sm:items-start sm:justify-between sm:gap-6')}>
      <div className="min-w-0 sm:max-w-[52%]">
        <div className="text-[14px] font-medium text-ink">{label}</div>
        {help && <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{help}</div>}
        {error && <div className="mt-1 text-[12.5px] font-medium text-danger-text">{error}</div>}
      </div>
      <div className={cn('min-w-0', !stack && 'sm:w-[280px] sm:shrink-0 sm:[&>*]:ml-auto')}>{children}</div>
    </div>
  )
}

export function SettingsCard({ title, subtitle, children, action, id }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-8 scroll-mt-24 last:mb-0">
      <div className="mb-2 flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">{children}</div>
    </section>
  )
}

export function errField(e: unknown, f: string) {
  const x = e as ApiError | null
  return x?.field === f ? x.message : null
}

/** Copy text with a fallback for sandboxed iframes. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}

export function absoluteLink(path: string) {
  const hash = (import.meta.env.VITE_ROUTER as string) === 'hash'
  return hash ? `${window.location.origin}${window.location.pathname}#${path}` : `${window.location.origin}${path}`
}
