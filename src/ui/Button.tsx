import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from '@/ui/icons'
import { cn } from '@/lib/utils'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle' | 'accent' | 'outline-danger' | 'link'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

const V: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-ink hover:brightness-[1.08] active:brightness-95 border border-brand',
  secondary: 'bg-surface text-ink border border-line-strong hover:bg-surface-2 active:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink border border-transparent',
  subtle: 'bg-brand-soft text-brand-text hover:bg-brand-soft-2 border border-transparent',
  accent: 'bg-accent text-accent-ink hover:brightness-105 border border-transparent',
  danger: 'bg-danger text-white hover:brightness-110 border border-transparent',
  'outline-danger': 'bg-surface text-danger-text border border-line-strong hover:bg-danger-soft',
  link: 'text-brand-text hover:underline underline-offset-4 border border-transparent px-0! h-auto!',
}
const S: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-[12px] gap-1 rounded-sm',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-[var(--ctl-h)] px-3.5 text-[13.5px] gap-2 rounded-md',
  lg: 'h-11 px-5 text-[14.5px] gap-2 rounded-md',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconRight, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        /(^|\s)hidden(\s|$)/.test(className ?? '') ? '' : 'inline-flex',
        'select-none items-center justify-center whitespace-nowrap font-medium transition-[background,filter,color,border-color] duration-100 disabled:cursor-not-allowed disabled:opacity-50',
        V[variant],
        S[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
      {iconRight}
    </button>
  )
})

export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'icon' | 'children'> & { label: string; children: ReactNode }>(function IconButton(
  { label, variant = 'ghost', size = 'md', className, children, ...rest },
  ref,
) {
  const dim = { xs: 'size-7', sm: 'size-8', md: 'size-[var(--ctl-h)]', lg: 'size-12' }[size]
  return (
    <Button ref={ref} variant={variant} size={size} aria-label={label} title={label} className={cn(dim, 'px-0!', className)} {...rest}>
      {children}
    </Button>
  )
})
