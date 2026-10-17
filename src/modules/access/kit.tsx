// Shared pieces for roles, people and Create employee screens.
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Eye, EyeOff, Hourglass, Mail } from '@/ui/icons'
import { toast } from 'sonner'
import { MODULE_LABEL, MODULE_ORDER, PERMISSION_BY_KEY, PERSONA_LABEL } from '@/domain/permissionCatalog'
import { isPending } from '@/api/changes'
import type { ProposedNamed, RoleRow } from '@/api/access'
import type { PendingBrief } from '@/api/changes'
import { relTime } from '@/domain/calendar'
import { Button, Callout, useCan } from '@/ui'
import { cn } from '@/lib/utils'
import { copyText } from '../admin/kit'

const names = (xs: string[] | undefined) => (!xs?.length ? 'a checker' : xs.length === 1 ? xs[0] : xs.length === 2 ? `${xs[0]} or ${xs[1]}` : `${xs[0]}, ${xs[1]} or ${xs.length - 2} more`)
export const checkerText = names

/** Toast for guarded writes: applied, or sent to named checkers. */
export function announceNamed<R>(r: ProposedNamed<R>, applied: string) {
  if (isPending(r)) toast.message('Sent for approval', { description: `${names(r.checker_names)} can approve it. ${r.change.summary}.` })
  else toast.success(applied)
}

/** "Waiting for approval" banner shown on a record with a pending change. */
export function PendingBanner({ pending, what = 'This change', action }: { pending: PendingBrief; what?: string; action?: ReactNode }) {
  const c = useCan()
  return (
    <Callout
      tone="warning"
      icon={<Hourglass />}
      title={pending.mine ? `${what} is waiting for approval` : `${pending.maker_name} proposed a change`}
      action={action ?? (c('makerchecker.check') || pending.mine ? <Link to="/changes" className="whitespace-nowrap text-[13px] font-medium text-brand-text hover:underline">Open</Link> : undefined)}
      className="mb-4"
    >
      <span className="break-words">{pending.summary}</span>
      <span className="mt-0.5 block text-[12.5px] text-ink-3">
        {pending.can_check ? 'You can approve it in Change approvals.' : `${names(pending.checker_names)} can approve it.`} Proposed {relTime(pending.created_at)}. Editing is paused until it is decided.
      </span>
    </Callout>
  )
}

/** Rendered email as the recipient sees it. */
export function EmailPreview({ to, subject, body, className, note }: { to: string; subject: string; body: string; className?: string; note?: ReactNode }) {
  return (
    <div className={cn('overflow-hidden rounded-lg border border-line bg-surface', className)}>
      <div className="space-y-1 border-b border-line bg-surface-2/60 px-4 py-3 text-[12.5px]">
        <div className="flex min-w-0 gap-2">
          <span className="w-12 shrink-0 text-ink-3">To</span>
          <span className="min-w-0 break-all font-medium text-ink">{to || '—'}</span>
        </div>
        <div className="flex min-w-0 gap-2">
          <span className="w-12 shrink-0 text-ink-3">Subject</span>
          <span className="min-w-0 break-words font-medium text-ink">{subject}</span>
        </div>
      </div>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-sans text-[13px] leading-relaxed text-ink-2 scroll-thin">{body}</pre>
      {note && <div className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12px] text-ink-3"><Mail className="size-3.5 shrink-0" />{note}</div>}
    </div>
  )
}

/** Login details with reveal + copy. */
export function CredentialsCard({ email, password, loginUrl = 'https://app.seereonos.com/login' }: { email: string; password: string; loginUrl?: string }) {
  const [show, setShow] = useState(false)
  const copy = async () => {
    const ok = await copyText(`Sign in: ${loginUrl}\nUsername: ${email}\nTemporary password: ${password}`)
    ok ? toast.success('Login details copied') : toast.error('Copy failed — select the text and copy it.')
  }
  return (
    <div className="rounded-lg border border-line bg-surface">
      <dl className="divide-y divide-line text-[13.5px]">
        <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
          <dt className="w-[150px] shrink-0 text-[12.5px] text-ink-3">Login email</dt>
          <dd className="min-w-0 break-all font-medium">{email}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-center sm:gap-4">
          <dt className="w-[150px] shrink-0 text-[12.5px] text-ink-3">Temporary password</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[14px] font-medium" data-testid="temp-password">{show ? password : '•'.repeat(password.length)}</code>
            <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} className="grid size-8 shrink-0 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink">
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-[12px] text-ink-3">They must set their own password at first sign-in.</span>
        <Button size="sm" icon={<Copy className="size-3.5" />} onClick={copy}>
          Copy login details
        </Button>
      </div>
    </div>
  )
}

/** "This role can…" — the role's permissions summarised by module. */
export function RoleSummary({ role, extra = [], className }: { role: Pick<RoleRow, 'name' | 'permissions' | 'persona' | 'description'>; extra?: string[]; className?: string }) {
  const all = [...new Set([...role.permissions, ...extra])]
  const byModule = MODULE_ORDER.map((m) => ({ m, keys: all.filter((k) => PERMISSION_BY_KEY[k]?.module === m) })).filter((x) => x.keys.length)
  return (
    <div className={cn('rounded-lg border border-line bg-surface-2/50 px-4 py-3', className)}>
      <div className="text-[13px] font-medium text-ink">This role can</div>
      {role.description && <p className="mt-0.5 text-[12.5px] text-ink-3">{role.description}</p>}
      <ul className="mt-2 space-y-1.5">
        {byModule.map(({ m, keys }) => (
          <li key={m} className="text-[12.5px] leading-snug">
            <span className="font-medium text-ink-2">{MODULE_LABEL[m]}:</span>{' '}
            <span className="text-ink-3">
              {keys.slice(0, 3).map((k) => PERMISSION_BY_KEY[k].label.toLowerCase()).join(', ')}
              {keys.length > 3 && ` +${keys.length - 3} more`}
            </span>
          </li>
        ))}
        {!byModule.length && <li className="text-[12.5px] text-ink-3">Nothing yet — this role has no permissions.</li>}
      </ul>
      <p className="mt-2 text-[12px] text-ink-3">Home: {PERSONA_LABEL[role.persona]} · {all.length} permissions</p>
    </div>
  )
}
