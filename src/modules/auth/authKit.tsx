import { forwardRef, useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from '@/ui/icons'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/api/http'
import { checkPassword } from '@/domain/passwordPolicy'

/** Password field with show/hide toggle. */
export const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(function PasswordInput({ invalid, className, ...rest }, ref) {
  const [show, setShow] = useState(false)
  return (
    <div className={cn('relative', className)}>
      <input
        ref={ref}
        type={show ? 'text' : 'password'}
        aria-invalid={invalid || undefined}
        className="h-[var(--ctl-h)] w-full rounded-md border border-line-strong/80 bg-surface pl-3 pr-11 text-ink outline-none transition placeholder:text-ink-3 focus:border-brand focus:ring-[3px] focus:ring-brand/15 aria-[invalid=true]:border-danger"
        {...rest}
      />
      <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="absolute right-1 top-1/2 grid size-9 -translate-y-1/2 place-items-center rounded-md text-ink-3 hover:text-ink">
        {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
      </button>
    </div>
  )
})

/** 0..4 score with human label. Length matters most; variety adds. */
export function passwordScore(pw: string, min = 10) {
  if (!pw) return { score: 0, label: '', tip: `Use at least ${min} characters.` }
  let s = 0
  if (pw.length >= min) s++
  if (pw.length >= min + 4) s++
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w]/].filter((r) => r.test(pw)).length
  if (kinds >= 3) s++
  if (kinds === 4 && pw.length >= min) s++
  // the same rule the server applies (common / breached passwords are refused)
  const refused = pw.length >= min ? checkPassword(pw, { min }) : null
  if (refused || /^(.)\1+$/.test(pw) || /password|qwerty|123456|seereon/i.test(pw)) s = Math.min(s, refused ? 0 : 1)
  if (pw.length < min) s = 0
  const label = refused ? 'Not allowed' : ['Too short', 'Weak', 'Fair', 'Good', 'Strong'][s]
  const tip = pw.length < min ? `${min - pw.length} more character${min - pw.length === 1 ? '' : 's'} needed.` : refused ? refused.message : s < 3 ? 'Mix upper and lower case, numbers and a symbol — or make it longer.' : 'Nice. Store it in a password manager.'
  return { score: s, label, tip }
}

export function StrengthMeter({ password, min = 10 }: { password: string; min?: number }) {
  const { score, label, tip } = passwordScore(password, min)
  const tone = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'][score]
  return (
    <div aria-live="polite">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full transition-colors', password && i < Math.max(1, score) ? tone : 'bg-line')} />
        ))}
      </div>
      <p className="mt-1.5 flex justify-between text-[12px] text-ink-3">
        <span>{tip}</span>
        {password && <span className="font-semibold text-ink-2">{label}</span>}
      </p>
    </div>
  )
}

export function fieldError(e: unknown, field: string): string | null {
  const x = e as ApiError | null
  return x && x.field === field ? x.message : null
}

export function FormError({ error }: { error: unknown }) {
  const e = error as ApiError | null
  if (!e || e.field) return null
  return (
    <div role="alert" className="rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-[13.5px] font-medium text-danger-text">
      {e.message}
    </div>
  )
}
