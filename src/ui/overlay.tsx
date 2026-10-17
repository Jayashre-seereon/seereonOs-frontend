import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import * as RD from '@radix-ui/react-dialog'
import * as RM from '@radix-ui/react-dropdown-menu'
import * as RP from '@radix-ui/react-popover'
import * as RT from '@radix-ui/react-tooltip'
import { X } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { Button } from './Button'
import { Field, Textarea } from './form'

/* ---------------------------------------------------------------- */
/* Dialog: centred on desktop, bottom sheet on phones                */
/* ---------------------------------------------------------------- */
export function Dialog({
  open, onOpenChange, title, description, children, footer, size = 'md', dismissable = true,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  dismissable?: boolean
}) {
  const w = { sm: 'md:max-w-[420px]', md: 'md:max-w-[560px]', lg: 'md:max-w-[760px]', xl: 'md:max-w-[1040px]' }[size]
  return (
    <RD.Root open={open} onOpenChange={(o) => (dismissable || o ? onOpenChange(o) : undefined)}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-[rgba(8,12,10,.42)] backdrop-blur-[2px] data-[state=open]:animate-[fade_.18s_ease]" />
        <RD.Content
          onOpenAutoFocus={(e) => {
            if (window.innerWidth < 768) e.preventDefault()
          }}
          className={cn(
            'fixed z-50 flex max-h-[92dvh] w-full flex-col bg-elevated text-ink shadow-lg outline-none',
            'inset-x-0 bottom-0 rounded-t-[22px] pb-[env(safe-area-inset-bottom,0px)] animate-[sheet-up_.28s_cubic-bezier(.2,.9,.2,1)]',
            'md:bottom-auto md:left-1/2 md:top-1/2 md:max-h-[86dvh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg md:pb-0 md:animate-[pop_.18s_ease-out]',
            w,
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden" />
          <div className="flex shrink-0 items-start gap-3 px-5 pb-3 pt-4 md:px-6 md:pt-5">
            <div className="min-w-0 flex-1">
              <RD.Title className="text-[17px] font-semibold tracking-[-0.01em]">{title}</RD.Title>
              {description ? <RD.Description className="mt-1 text-[13.5px] leading-snug text-ink-3">{description}</RD.Description> : <RD.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</RD.Description>}
            </div>
            <RD.Close className="-mr-1.5 -mt-0.5 grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="size-[18px]" />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 scroll-thin md:px-6">{children}</div>
          {footer && <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line bg-surface/60 px-5 py-3 sm:flex-row sm:justify-end md:rounded-b-xl md:px-6">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/* ---------------------------------------------------------------- */
/* Sheet: right drawer on desktop, full-height sheet on phones        */
/* ---------------------------------------------------------------- */
export function Sheet({
  open, onOpenChange, title, subtitle, children, footer, width = 560, headerExtra,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
  headerExtra?: ReactNode
}) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-[rgba(8,12,10,.36)] data-[state=open]:animate-[fade_.18s_ease]" />
        <RD.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          style={{ ['--w' as string]: `${width}px` }}
          className={cn(
            'fixed z-50 flex flex-col bg-elevated text-ink shadow-lg outline-none',
            'inset-x-0 bottom-0 top-[max(env(safe-area-inset-top,0px),24px)] rounded-t-[22px] animate-[sheet-up_.3s_cubic-bezier(.2,.9,.2,1)]',
            'md:inset-y-0 md:left-auto md:right-0 md:top-0 md:w-[min(var(--w),100vw)] md:rounded-none md:rounded-l-xl md:animate-[sheet-right_.26s_cubic-bezier(.2,.9,.2,1)]',
          )}
        >
          <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong md:hidden" />
          <div className="flex shrink-0 items-start gap-3 border-b border-line px-5 pb-3.5 pt-3 md:px-6 md:pt-5">
            <div className="min-w-0 flex-1">
              <RD.Title className="text-[17px] font-semibold leading-snug tracking-[-0.01em]">{title}</RD.Title>
              <RD.Description asChild>
                <div className="mt-0.5 text-[13px] text-ink-3">{subtitle}</div>
              </RD.Description>
              {headerExtra}
            </div>
            <RD.Close className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="size-[18px]" />
            </RD.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin md:px-6">{children}</div>
          {footer && <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3 pb-[max(12px,env(safe-area-inset-bottom,0px))] md:px-6">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  )
}

/* ---------------------------------------------------------------- */
/* Confirm + Reason dialogs (the viewer blocks window.confirm)        */
/* ---------------------------------------------------------------- */
interface ConfirmOpts {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  tone?: 'danger' | 'primary'
}
interface ReasonOpts {
  title: string
  body?: ReactNode
  label?: string
  placeholder?: string
  confirmLabel?: string
  minLength?: number
  tone?: 'danger' | 'primary'
}
const ConfirmCtx = createContext<{ confirm: (o: ConfirmOpts) => Promise<boolean>; askReason: (o: ReasonOpts) => Promise<string | null> } | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [c, setC] = useState<(ConfirmOpts & { kind: 'confirm' }) | (ReasonOpts & { kind: 'reason' }) | null>(null)
  const [reason, setReason] = useState('')
  const [touched, setTouched] = useState(false)
  const resolver = useRef<(v: unknown) => void>(() => {})
  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((res) => {
    resolver.current = res as (v: unknown) => void
    setC({ ...o, kind: 'confirm' })
  }), [])
  const askReason = useCallback((o: ReasonOpts) => new Promise<string | null>((res) => {
    resolver.current = res as (v: unknown) => void
    setReason('')
    setTouched(false)
    setC({ ...o, kind: 'reason' })
  }), [])
  const close = (v: unknown) => {
    resolver.current(v)
    setC(null)
  }
  const min = c?.kind === 'reason' ? c.minLength ?? 5 : 0
  const tooShort = reason.trim().length < min
  return (
    <ConfirmCtx.Provider value={{ confirm, askReason }}>
      {children}
      <Dialog
        open={!!c}
        onOpenChange={(o) => !o && close(c?.kind === 'confirm' ? false : null)}
        size="sm"
        title={c?.title ?? ''}
        description={c?.kind === 'confirm' ? c.body : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={() => close(c?.kind === 'confirm' ? false : null)}>
              {(c?.kind === 'confirm' && c.cancelLabel) || 'Cancel'}
            </Button>
            <Button
              variant={c?.tone === 'danger' ? 'danger' : 'primary'}
              onClick={() => {
                if (c?.kind === 'reason') {
                  setTouched(true)
                  if (tooShort) return
                  close(reason.trim())
                } else close(true)
              }}
            >
              {c?.confirmLabel ?? 'Confirm'}
            </Button>
          </>
        }
      >
        {c?.kind === 'reason' && (
          <div className="space-y-3">
            {c.body && <div className="text-[13.5px] text-ink-2">{c.body}</div>}
            <Field label={c.label ?? 'Reason'} required error={touched && tooShort ? `Write at least ${min} characters.` : null}>
              <Textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={c.placeholder} invalid={touched && tooShort} />
            </Field>
          </div>
        )}
      </Dialog>
    </ConfirmCtx.Provider>
  )
}
export function useConfirm() {
  const v = useContext(ConfirmCtx)
  if (!v) throw new Error('ConfirmProvider missing')
  return v
}

/* ---------------------------------------------------------------- */
/* Menu, Popover, Tooltip                                            */
/* ---------------------------------------------------------------- */
export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  hint?: ReactNode
}
export function Menu({ trigger, items, align = 'end', label }: { trigger: ReactNode; items: MenuItem[]; align?: 'start' | 'end' | 'center'; label?: string }) {
  return (
    <RM.Root modal={false}>
      <RM.Trigger asChild aria-label={label}>
        {trigger}
      </RM.Trigger>
      <RM.Portal>
        <RM.Content align={align} sideOffset={6} className="z-[60] min-w-[200px] overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-lg animate-[fade_.12s_ease]">
          {items.map((it, i) =>
            it.separator ? (
              <RM.Separator key={i} className="my-1 h-px bg-line" />
            ) : (
              <RM.Item
                key={i}
                disabled={it.disabled}
                onSelect={it.onSelect}
                className={cn(
                  'flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 data-[highlighted]:bg-surface-2',
                  it.danger ? 'text-danger-text' : 'text-ink',
                )}
              >
                {it.icon && <span className="grid size-4 place-items-center text-ink-3 [&>svg]:size-4">{it.icon}</span>}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="text-[12px] text-ink-3">{it.hint}</span>}
              </RM.Item>
            ),
          )}
        </RM.Content>
      </RM.Portal>
    </RM.Root>
  )
}

export function Popover({ trigger, children, align = 'start', className, open, onOpenChange }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <RP.Root open={open} onOpenChange={onOpenChange}>
      <RP.Trigger asChild>{trigger}</RP.Trigger>
      <RP.Portal>
        <RP.Content align={align} sideOffset={6} collisionPadding={12} className={cn('z-[60] rounded-lg border border-line bg-elevated p-3 shadow-lg outline-none animate-[fade_.12s_ease]', className)}>
          {children}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  )
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>
  return (
    <RT.Root delayDuration={250}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content side={side} sideOffset={6} className="z-[70] max-w-[280px] rounded-md bg-ink px-2.5 py-1.5 text-[12.5px] font-medium leading-snug text-surface shadow-md animate-[fade_.1s_ease]">
          {content}
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  )
}
export const TooltipProvider = RT.Provider
