import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Copy, Download, KeyRound, MonitorSmartphone, Smartphone } from '@/ui/icons'
import { authApi } from '@/api/core'
import { announce, isPending } from '@/api/changes'
import { useApi, useMut } from '@/api/query'
import type { ApiError } from '@/api/http'
import { adminApi, useSessions, useSettings } from '@/api/admin'
import { useSession } from '@/stores/session'
import { fmtDateTime, relTime } from '@/domain/calendar'
import { saveFile } from '@/lib/utils'
import { Badge, Button, Callout, Dialog, Field, Input, PageHeader, SkeletonRows, Switch, ErrorState, toast, useCan, useConfirm, useReadOnly } from '@/ui'
import type { User } from '@/types/entities'
import { PasswordInput, StrengthMeter } from '../auth/authKit'
import { SettingRow, SettingsCard, copyText, errField } from './kit'

export default function SecurityPage() {
  const { user, tenant } = useSession()
  const c = useCan()
  if (!user) return null
  return (
    <div className="pb-16">
      <PageHeader title="Security" subtitle="Keep your account and workspace safe." />
      <PasswordCard min={tenant?.settings['security.password_min_length'] ?? 10} />
      <TwoFactorCard user={user} required={!!tenant?.settings['security.require_2fa_admins'] && (c('roles.manage') || c('users.manage'))} />
      <SessionsCard />
      {c('settings.edit') && !user.is_super_admin && <WorkspaceSecurity />}
    </div>
  )
}

function PasswordCard({ min }: { min: number }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [local, setLocal] = useState<ApiError | null>(null)
  const m = useMut(() => authApi.password(cur, next), {
    success: 'Password changed',
    onSuccess: () => {
      setCur('')
      setNext('')
      setConfirm('')
    },
  })
  const err = local ?? (m.error as ApiError | null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setLocal(null)
    if (!cur) return setLocal({ field: 'current', message: 'Enter your current password.' } as ApiError)
    if (next.length < min) return setLocal({ field: 'next', message: `Use at least ${min} characters.` } as ApiError)
    if (next === cur) return setLocal({ field: 'next', message: 'Choose a password you haven’t used here.' } as ApiError)
    if (next !== confirm) return setLocal({ field: 'confirm', message: 'Passwords don’t match.' } as ApiError)
    m.mutate(undefined)
  }
  return (
    <SettingsCard title="Password" subtitle={`At least ${min} characters (workspace rule).`}>
      <form onSubmit={submit} className="grid gap-4 p-4 md:p-5" noValidate>
        <Field label="Current password" htmlFor="cur" error={errField(err, 'current')}>
          <PasswordInput id="cur" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} invalid={!!errField(err, 'current')} />
        </Field>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="New password" htmlFor="next" error={errField(err, 'next')}>
            <PasswordInput id="next" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} invalid={!!errField(err, 'next')} />
          </Field>
          <Field label="Confirm new password" htmlFor="confirm" error={errField(err, 'confirm')}>
            <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!errField(err, 'confirm')} />
          </Field>
        </div>
        <StrengthMeter password={next} min={min} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={m.isPending} className="w-full sm:w-auto">
            Change password
          </Button>
        </div>
      </form>
    </SettingsCard>
  )
}

function TwoFactorCard({ user, required }: { user: User; required: boolean }) {
  const { patchUser } = useSession()
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null)
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [proof, setProof] = useState<'off' | 'codes' | null>(null)
  const status = useApi(['2fa', user.id, user.two_factor], adminApi.twoFactorStatus, { enabled: user.two_factor })
  const start = useMut(() => adminApi.twoFactorSetup(), {
    onSuccess: (r) => {
      setCode('')
      setSetup(r)
    },
  })
  const verify = useMut(() => adminApi.twoFactorVerify(code.trim()), {
    success: 'Two-step verification is on',
    invalidate: [['2fa'], ['sessions']],
    onSuccess: (r) => {
      patchUser({ two_factor: r.user.two_factor })
      setSetup(null)
      setCode('')
      setCodes(r.recovery_codes)
    },
  })
  const groups = setup?.secret.match(/.{1,4}/g) ?? []
  const left = status.data?.recovery_codes_left

  return (
    <SettingsCard title="Two-step verification" subtitle="A 6-digit code from an authenticator app when you sign in.">
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-start md:px-5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
            Authenticator app {user.two_factor ? <Badge tone="success" size="sm">On</Badge> : <Badge size="sm">Off</Badge>}
          </div>
          <p className="mt-0.5 text-[13px] text-ink-3">Works with Google Authenticator, Microsoft Authenticator, 1Password or Authy.</p>
          {required && !user.two_factor && <Callout tone="warning" className="mt-3">Your workspace requires two-step verification for admins. Set it up now.</Callout>}
        </div>
        {user.two_factor ? (
          <Button variant="outline-danger" size="sm" className="self-start" onClick={() => setProof('off')}>
            Turn off
          </Button>
        ) : (
          <Button variant="primary" size="sm" className="self-start" loading={start.isPending} onClick={() => start.mutate(undefined)}>
            Set up
          </Button>
        )}
      </div>
      {user.two_factor && (
        <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center md:px-5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Recovery codes</div>
            <p className="mt-0.5 text-[13px] text-ink-3">
              {left === undefined ? 'Single-use codes for when you don’t have your phone.' : `${left} of 10 unused. Each code works once when you don’t have your phone.`}
            </p>
            {left !== undefined && left <= 3 && <Callout tone="warning" className="mt-3">{left === 0 ? 'You have no recovery codes left.' : 'You are running low on recovery codes.'} Create new ones and store them safely.</Callout>}
          </div>
          <Button size="sm" className="self-start sm:self-center" icon={<KeyRound className="size-3.5" />} onClick={() => setProof('codes')}>
            New codes
          </Button>
        </div>
      )}
      <Dialog
        open={!!setup}
        onOpenChange={(o) => !o && setSetup(null)}
        title="Set up two-step verification"
        description="Add SeereonOS to your authenticator app, then enter the 6-digit code it shows."
        footer={
          <>
            <Button onClick={() => setSetup(null)}>Cancel</Button>
            <Button variant="primary" loading={verify.isPending} disabled={code.trim().length !== 6} onClick={() => verify.mutate(undefined)}>
              Verify and turn on
            </Button>
          </>
        }
      >
        <ol className="space-y-5 text-[13.5px]">
          <li className="flex gap-3">
            <span className="tnum grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[12px] font-medium text-ink-2">1</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Open your authenticator app and choose “Enter a setup key”</div>
              <div className="mt-1 break-words text-ink-3">Account: <b className="text-ink-2">{user.email}</b> · Type: time-based</div>
            </div>
          </li>
          <li className="flex gap-3">
            <span className="tnum grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[12px] font-medium text-ink-2">2</span>
            <div className="min-w-0 flex-1">
              <div className="font-medium">Enter this key</div>
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-3">
                <code className="tnum min-w-0 flex-1 break-all font-mono text-[14px] font-medium">{groups.join(' ')}</code>
                <Button
                  size="sm"
                  icon={<Copy className="size-3.5" />}
                  onClick={async () => {
                    const ok = await copyText(setup?.secret ?? '')
                    ok ? toast.success('Key copied') : toast.error('Copy failed — select the key and copy it manually.')
                  }}
                >
                  Copy
                </Button>
              </div>
              {setup && (
                <a href={setup.otpauth_url} className="mt-2 inline-block text-[13px] font-medium text-brand-text hover:underline">
                  On this phone? Open in your authenticator app
                </a>
              )}
            </div>
          </li>
          <li className="flex gap-3">
            <span className="tnum grid size-6 shrink-0 place-items-center rounded-full border border-line-strong text-[12px] font-medium text-ink-2">3</span>
            <div className="min-w-0 flex-1">
              <Field label="6-digit code" htmlFor="totp" error={errField(verify.error, 'code') ?? (verify.error && !errField(verify.error, 'code') ? (verify.error as Error).message : null)} hint="The code changes every 30 seconds.">
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="tnum max-w-[180px] text-center font-mono text-[18px] font-medium"
                />
              </Field>
            </div>
          </li>
        </ol>
      </Dialog>
      {proof && (
        <ProofDialog
          mode={proof}
          onClose={() => setProof(null)}
          onOff={(u) => {
            patchUser({ two_factor: u.two_factor })
            setProof(null)
          }}
          onCodes={(c) => {
            setProof(null)
            setCodes(c)
          }}
        />
      )}
      {codes && <RecoveryCodesDialog codes={codes} email={user.email} onClose={() => setCodes(null)} />}
    </SettingsCard>
  )
}

/** Turn off (password or a current code) / new recovery codes (current code). */
function ProofDialog({ mode, onClose, onOff, onCodes }: { mode: 'off' | 'codes'; onClose: () => void; onOff: (u: User) => void; onCodes: (codes: string[]) => void }) {
  const [byCode, setByCode] = useState(mode === 'codes')
  const [value, setValue] = useState('')
  const [local, setLocal] = useState<ApiError | null>(null)
  const off = useMut(() => adminApi.twoFactorDisable(byCode ? { code: value.trim() } : { password: value }), { success: 'Two-step verification turned off', invalidate: [['2fa']], onSuccess: onOff })
  const fresh = useMut(() => adminApi.twoFactorNewCodes(value.trim()), { success: 'New recovery codes created', invalidate: [['2fa']], onSuccess: (r) => onCodes(r.recovery_codes) })
  const m = mode === 'off' ? off : fresh
  const field = byCode ? 'code' : 'password'
  const err = local ?? (m.error as ApiError | null)
  const errText = err ? (errField(err, field) ?? (!err.field || err.field !== field ? err.message : null)) : null
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    setLocal(null)
    if (byCode ? !/^\d{6}$/.test(value.trim()) : !value) return setLocal({ field, message: byCode ? 'Enter the 6-digit code from your authenticator app.' : 'Enter your password.' } as ApiError)
    if (mode === 'off') off.mutate(undefined)
    else fresh.mutate(undefined)
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={mode === 'off' ? 'Turn off two-step verification?' : 'Create new recovery codes?'}
      description={mode === 'off' ? 'Your account will be protected by your password only.' : 'Your current recovery codes stop working. Confirm with a code from your authenticator app.'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'off' ? 'danger' : 'primary'} loading={m.isPending} onClick={() => submit()}>
            {mode === 'off' ? 'Turn off' : 'Create new codes'}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3" noValidate>
        <Field label={byCode ? '6-digit code' : 'Password'} htmlFor="tf-proof" error={errText}>
          {byCode ? (
            <Input
              key="code"
              id="tf-proof"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              invalid={!!errText}
              className="tnum max-w-[180px] text-center font-mono text-[18px] font-medium"
              autoFocus
            />
          ) : (
            <PasswordInput key="pw" id="tf-proof" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} invalid={!!errText} autoFocus />
          )}
        </Field>
        {mode === 'off' && (
          <button
            type="button"
            className="text-[13px] font-medium text-brand-text hover:underline"
            onClick={() => {
              setByCode((b) => !b)
              setValue('')
              setLocal(null)
              off.reset()
            }}
          >
            {byCode ? 'Use your password instead' : 'Use a code from your authenticator app instead'}
          </button>
        )}
      </form>
    </Dialog>
  )
}

/** Shown once, right after the codes are created: copy / download, then confirm they are saved. */
function RecoveryCodesDialog({ codes, email, onClose }: { codes: string[]; email: string; onClose: () => void }) {
  const text = `SeereonOS recovery codes for ${email}\nEach code can be used once to sign in without your authenticator app.\n\n${codes.join('\n')}\n`
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Save your recovery codes"
      description="Use one of these if you lose your phone. Each code works once. You won’t see them again."
      footer={
        <Button variant="primary" onClick={onClose}>
          I’ve saved them
        </Button>
      }
    >
      <div className="space-y-4">
        <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg border border-line bg-surface-2 p-4 min-[400px]:grid-cols-2" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c} className="tnum whitespace-nowrap font-mono text-[14.5px] font-medium text-ink">
              {c}
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            icon={<Copy className="size-3.5" />}
            onClick={async () => ((await copyText(codes.join('\n'))) ? toast.success('Codes copied') : toast.error('Copy failed — select the codes and copy them manually.'))}
          >
            Copy
          </Button>
          <Button
            icon={<Download className="size-3.5" />}
            onClick={async () => {
              const r = await saveFile('seereonos-recovery-codes.txt', text, 'text/plain')
              if (r === 'failed') toast.error('The browser blocked the download. Copy the codes instead.')
            }}
          >
            Download
          </Button>
        </div>
        <Callout tone="warning">Store them somewhere safe, like a password manager. Anyone with a code and your password can sign in.</Callout>
      </div>
    </Dialog>
  )
}

function SessionsCard() {
  const q = useSessions()
  const { confirm } = useConfirm()
  const revokeAll = useMut(() => adminApi.revokeOthers(), { invalidate: [['sessions']], success: (r) => (r.revoked ? `Signed out ${r.revoked} other session${r.revoked === 1 ? '' : 's'}` : 'No other sessions') })
  const revokeOne = useMut((id: string) => adminApi.revokeSession(id), { invalidate: [['sessions']], success: 'Session signed out' })
  const others = (q.data ?? []).filter((s) => !s.current).length
  return (
    <SettingsCard
      title="Active sessions"
      subtitle="Devices signed in to your account."
      action={
        others > 0 && (
          <Button
            size="sm"
            variant="outline-danger"
           
            loading={revokeAll.isPending}
            onClick={async () => (await confirm({ title: 'Sign out other sessions?', body: `${others} other device${others === 1 ? '' : 's'} will need to sign in again.`, confirmLabel: 'Sign out others', tone: 'danger' })) && revokeAll.mutate(undefined)}
          >
            Sign out others
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <div className="p-4"><SkeletonRows rows={2} /></div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        (q.data ?? []).map((s, i) => (
          <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 md:px-5">
            {i % 2 ? <Smartphone className="size-[18px] shrink-0 text-ink-3" /> : <MonitorSmartphone className="size-[18px] shrink-0 text-ink-3" />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                {s.current ? 'This browser' : `Session ···${s.id.slice(-4)}`}
                {s.current && <Badge tone="success" size="sm">Current</Badge>}
              </div>
              <div className="text-[12.5px] text-ink-3">Signed in {relTime(s.created_at)} · {fmtDateTime(s.created_at)}</div>
            </div>
            {!s.current && (
              <Button size="sm" variant="ghost" loading={revokeOne.isPending && revokeOne.variables === s.id} onClick={() => revokeOne.mutate(s.id)}>
                Sign out
              </Button>
            )}
          </div>
        ))
      )}
    </SettingsCard>
  )
}

function WorkspaceSecurity() {
  const q = useSettings()
  const { setTenant } = useSession()
  const readOnly = useReadOnly()
  const save = useMut((v: boolean) => adminApi.saveSettings({ settings: { 'security.require_2fa_admins': v }, tenant: {} }, q.data!.tenant.version), {
    invalidate: [['settings'], ['me']],
    onSuccess: (r) => {
      if (isPending(r)) return announce(r, '')
      announce(r, r.result.settings['security.require_2fa_admins'] ? 'Two-step now required for admins' : 'Two-step no longer required')
      setTenant(r.result)
    },
  })
  const s = q.data?.tenant.settings
  return (
    <SettingsCard title="Workspace security" subtitle="Applies to everyone in this workspace." action={<Link to="/settings/company#security" className="text-[13px] font-medium text-brand-text hover:underline">Edit rules</Link>}>
      {!s ? (
        <div className="p-4"><SkeletonRows rows={3} /></div>
      ) : (
        <>
          <SettingRow label="Require two-step for admins" help="Applies to everyone who can manage roles or user access. Without it they must set it up at next sign-in.">
            <Switch checked={s['security.require_2fa_admins']} disabled={readOnly || save.isPending} onChange={(v) => save.mutate(v)} />
          </SettingRow>
          {[
            ['Minimum password length', `${s['security.password_min_length']} characters`],
            ['Lockout', `${s['security.lockout_attempts']} failed attempts → locked ${s['security.lockout_minutes']} min`],
            ['Idle sign-out', `After ${s['security.session_idle_minutes']} minutes`],
          ].map(([k, v]) => (
            <SettingRow key={k} label={k}>
              <div className="text-[14px] text-ink-2 sm:text-right">{v}</div>
            </SettingRow>
          ))}
        </>
      )}
    </SettingsCard>
  )
}
