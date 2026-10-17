import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronRight, RotateCcw, ShieldCheck } from '@/ui/icons'
import AuthLayout from '@/app/AuthLayout'
import { authApi, isMfaChallenge, type AuthResult } from '@/api/core'
import type { ApiError } from '@/api/http'
import { queryClient } from '@/api/query'
import { useSession } from '@/stores/session'
import { Button, Field, Input, toast, useConfirm } from '@/ui'
import { cn } from '@/lib/utils'
import { FormError, PasswordInput, fieldError } from './authKit'

const DEMO_PASSWORD = 'Seereon@123'
const DEMO = [
  { email: 'santosh@seereon.co.in', name: 'Santosh Nayak', role: 'CEO', note: 'Everything, incl. money; approves sensitive changes' },
  { email: 'debasish@seereon.co.in', name: 'Debasish Mishra', role: 'Administrator', note: 'Setup, users, roles' },
  { email: 'subhankar@seereon.co.in', name: 'Subhankar Rout', role: 'Project Manager', note: 'Delivery & approvals' },
  { email: 'priya@seereon.co.in', name: 'Priya Mohapatra', role: 'HR Manager', note: 'Onboarding, leave, payroll prep' },
  { email: 'baishali@seereon.co.in', name: 'Baishali Rout', role: 'Sales Manager', note: 'Pipeline & team' },
  { email: 'subham@seereon.co.in', name: 'Subham Mohanty', role: 'Sales Executive', note: 'Own deals' },
  { email: 'hritesh@seereon.co.in', name: 'Hritesh Panda', role: 'Employee', note: 'Tasks & timesheet' },
  { email: 'ananya@kalingasoft.in', name: 'Ananya Mishra', role: 'CEO · 2nd tenant', note: 'Second tenant, on trial' },
  { email: 'platform@seereon.co.in', name: 'Platform Admin', role: 'Super admin', note: 'Tenants, never their data' },
]

export default function LoginPage() {
  const nav = useNavigate()
  const loc = useLocation()
  const setSession = useSession((s) => s.setSession)
  const { confirm } = useConfirm()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [demoOpen, setDemoOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  // second step (two-step verification): the challenge token from POST /auth/login
  const [mfa, setMfa] = useState<{ token: string; email: string } | null>(null)

  const backToPassword = (why: ApiError | null = null) => {
    setMfa(null)
    setPassword('')
    setError(why)
  }

  const done = (r: AuthResult & { recovery_codes_left?: number }) => {
    queryClient.clear()
    setSession(r)
    if (r.recovery_codes_left !== undefined)
      toast.warning(`${r.recovery_codes_left} recovery code${r.recovery_codes_left === 1 ? '' : 's'} left`, { description: 'Each code works once. Create new codes under Settings → Security.' })
    const from = (loc.state as { from?: string } | null)?.from
    const first = r.user.name.split(' ')[0]
    if (r.user.must_change_password) {
      toast.message(`Welcome, ${first}`, { description: 'Set your own password to finish setting up your account.' })
      nav('/welcome/password', { replace: true })
      return
    }
    const to = r.user.is_super_admin ? '/admin' : from && from !== '/login' ? from : '/home'
    toast.success(`Welcome back, ${first}`)
    nav(to, { replace: true })
  }

  const signIn = async (em: string, pw: string, key: string) => {
    setBusy(key)
    setError(null)
    try {
      const r = await authApi.login(em, pw)
      if (isMfaChallenge(r)) setMfa({ token: r.mfa_token, email: em.trim() })
      else done(r)
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(null)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError({ message: 'Enter your email and password.', field: !email.trim() ? 'email' : 'password' } as ApiError)
      return
    }
    signIn(email, password, 'form')
  }

  const resetDemo = async () => {
    const ok = await confirm({ title: 'Reset demo data?', body: 'All changes made in this preview — people, projects, timesheets, settings — go back to the original demo data. Everyone is signed out.', confirmLabel: 'Reset demo data', tone: 'danger' })
    if (!ok) return
    setResetting(true)
    try {
      await authApi.resetDemo()
      queryClient.clear()
      toast.success('Demo data restored')
    } catch (e) {
      toast.error('Could not reset', { description: (e as Error).message })
    } finally {
      setResetting(false)
    }
  }

  const locked = error?.code === 'LOGIN_LOCKED'

  if (mfa)
    return (
      <SecondStep
        email={mfa.email}
        token={mfa.token}
        onDone={done}
        onRestart={(why) => backToPassword(why)}
      />
    )

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Sign in to your workspace."
      footer={
        <div className="space-y-2">
          <p>
            New to SeereonOS?{' '}
            <Link to="/signup" className="font-medium text-brand-text hover:underline">
              Create a workspace
            </Link>
          </p>
          <p className="text-[12px]">
            <Link to="/terms" className="hover:underline">Terms</Link> · <Link to="/privacy" className="hover:underline">Privacy</Link>
          </p>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {locked ? (
          <div role="alert" className="flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-3.5 py-3 text-[13.5px] text-warning-text">
            <ShieldCheck className="mt-0.5 size-[18px] shrink-0" />
            <div>
              <div className="font-medium">Account temporarily locked</div>
              <div className="mt-0.5 text-ink-2">{error!.message}</div>
              <Link to="/reset-password" className="mt-1 inline-block font-medium text-brand-text hover:underline">Reset password</Link>
            </div>
          </div>
        ) : (
          error && !error.field && <FormError error={error.code === 'LOGIN_FAILED' ? null : error} />
        )}
        <Field label="Work email" htmlFor="email" error={fieldError(error, 'email')}>
          <Input id="email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" invalid={!!fieldError(error, 'email')} autoFocus />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          aside={
            <Link to="/reset-password" state={{ email }} className="text-[12.5px] font-medium text-brand-text hover:underline">
              Forgot password?
            </Link>
          }
          error={error?.code === 'LOGIN_FAILED' ? error.message : fieldError(error, 'password')}
        >
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={error?.code === 'LOGIN_FAILED' || !!fieldError(error, 'password')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy === 'form'} disabled={!!busy && busy !== 'form'}>
          Sign in
        </Button>
      </form>

      {/* Demo accounts */}
      <section className="mt-8 border-t border-line pt-5" aria-labelledby="demo-h">
        <button type="button" onClick={() => setDemoOpen((o) => !o)} className="flex w-full items-center gap-3 text-left lg:pointer-events-none" aria-expanded={demoOpen}>
          <span className="min-w-0 flex-1">
            <span id="demo-h" className="block text-[14px] font-semibold text-ink">Demo accounts</span>
            <span className="block text-[12.5px] text-ink-3">Select an account to sign in. Password: <span className="font-mono text-ink-2">{DEMO_PASSWORD}</span></span>
          </span>
          <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition lg:hidden', demoOpen && 'rotate-180')} />
        </button>
        <ul className={cn('mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line lg:block', demoOpen ? 'block' : 'hidden')}>
          {DEMO.map((d) => (
            <li key={d.email}>
              <button
                type="button"
                disabled={!!busy}
                title={d.note}
                onClick={() => {
                  setEmail(d.email)
                  setPassword(DEMO_PASSWORD)
                  signIn(d.email, DEMO_PASSWORD, d.email)
                }}
                className="flex h-10 w-full items-center gap-3 px-3 text-left text-[13.5px] transition hover:bg-surface-2 disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{d.name}</span>
                <span className="min-w-0 max-w-[48%] shrink-0 truncate text-right text-[12.5px] text-ink-3">{d.role}</span>
                {busy === d.email ? <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-brand border-t-transparent" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-3" />}
              </button>
            </li>
          ))}
        </ul>
      </section>
      <div className="mt-3 text-center">
        <button type="button" onClick={resetDemo} disabled={resetting} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-3 hover:text-ink disabled:opacity-60">
          <RotateCcw className={cn('size-3.5', resetting && 'animate-spin')} /> Reset demo data
        </button>
      </div>
    </AuthLayout>
  )
}

/* ---------------- second step: authenticator code or recovery code ---------------- */
function SecondStep({ email, token, onDone, onRestart }: { email: string; token: string; onDone: (r: AuthResult & { recovery_codes_left?: number }) => void; onRestart: (why: ApiError | null) => void }) {
  const [recovery, setRecovery] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const field = recovery ? 'recovery_code' : 'code'

  const verify = async (v = value) => {
    if (busy) return
    const clean = v.trim()
    if (recovery ? clean.replace(/[^a-z0-9]/gi, '').length < 8 : !/^\d{6}$/.test(clean)) {
      setError({ field, message: recovery ? 'Enter one of your recovery codes, like k7m2q-x9p4t.' : 'Enter the 6-digit code from your authenticator app.' } as ApiError)
      return
    }
    setBusy(true)
    setError(null)
    try {
      onDone(await authApi.loginMfa(token, recovery ? { recovery_code: clean } : { code: clean }))
    } catch (e) {
      const x = e as ApiError
      // the challenge is gone (expired, too many wrong codes) or the account is locked: start again from the password
      if (x.code === 'MFA_EXPIRED' || x.code === 'MFA_LOCKED' || x.code === 'LOGIN_LOCKED') onRestart(x)
      else {
        setError(x)
        setValue('')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Two-step verification"
      subtitle={recovery ? 'Enter one of the recovery codes you saved when you turned on two-step verification.' : 'Open your authenticator app and enter the 6-digit code for SeereonOS.'}
      footer={
        <button type="button" onClick={() => onRestart(null)} className="inline-flex items-center gap-1.5 font-medium text-ink-3 hover:text-ink">
          <ArrowLeft className="size-3.5" /> Back to sign in
        </button>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          verify()
        }}
        className="space-y-4"
        noValidate
      >
        <p className="truncate text-[13.5px] text-ink-2">
          Signing in as <span className="font-medium text-ink">{email}</span>
        </p>
        {error && !error.field && <FormError error={error} />}
        <Field label={recovery ? 'Recovery code' : 'Authentication code'} htmlFor="mfa-code" error={fieldError(error, field)}>
          {recovery ? (
            <Input
              key="rc"
              id="mfa-code"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value.slice(0, 24))}
              placeholder="xxxxx-xxxxx"
              invalid={!!fieldError(error, field)}
              className="tnum font-mono text-[16px]"
              autoFocus
            />
          ) : (
            <Input
              key="totp"
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={value}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6)
                setValue(v)
                if (v.length === 6) verify(v)
              }}
              placeholder="000000"
              invalid={!!fieldError(error, field)}
              className="tnum max-w-[200px] text-center font-mono text-[18px] font-medium tracking-[0.2em]"
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Verify
        </Button>
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setRecovery((r) => !r)
              setValue('')
              setError(null)
            }}
            className="text-[13px] font-medium text-brand-text hover:underline"
          >
            {recovery ? 'Use your authenticator app instead' : 'Use a recovery code'}
          </button>
        </div>
      </form>
    </AuthLayout>
  )
}
