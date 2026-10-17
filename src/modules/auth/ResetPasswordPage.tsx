import { useState, type FormEvent } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowRight } from '@/ui/icons'
import AuthLayout from '@/app/AuthLayout'
import { authApi } from '@/api/core'
import type { ApiError } from '@/api/http'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '@/api/admin'
import { Button, Callout, Field, Input, Skeleton, toast } from '@/ui'
import { FormError, PasswordInput, StrengthMeter, fieldError } from './authKit'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token')
  return token ? <SetNew token={token} /> : <RequestLink />
}

function RequestLink() {
  const loc = useLocation()
  const nav = useNavigate()
  const [email, setEmail] = useState((loc.state as { email?: string } | null)?.email ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const [sent, setSent] = useState<{ demo: string | null } | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) return setError({ field: 'email', message: 'Enter the email you sign in with.' } as ApiError)
    setBusy(true)
    setError(null)
    try {
      const r = await authApi.resetRequest(email.trim())
      setSent({ demo: r.demo_token })
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(false)
    }
  }

  if (sent)
    return (
      <AuthLayout title="Check your email" subtitle={<>If an account exists for <b className="text-ink">{email}</b>, we sent a link to reset the password. It works for 60 minutes.</>} footer={<Link to="/login" className="font-medium text-brand-text hover:underline">Back to sign in</Link>}>
        <div className="space-y-4">
          {sent.demo && (
            <Callout tone="accent" title="Demo preview">
              Email isn’t sent in this preview. Continue as if you had opened the link.
            </Callout>
          )}
          {sent.demo && (
            <Button variant="primary" size="lg" block iconRight={<ArrowRight className="size-4" />} onClick={() => nav(`/reset-password?token=${sent.demo}`)}>
              Continue in demo
            </Button>
          )}
          <Button variant="ghost" block onClick={() => setSent(null)}>
            Use a different email
          </Button>
        </div>
      </AuthLayout>
    )

  return (
    <AuthLayout title="Reset your password" subtitle="Enter your work email and we’ll send you a reset link." footer={<Link to="/login" className="font-medium text-brand-text hover:underline">Back to sign in</Link>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <Field label="Work email" htmlFor="email" error={fieldError(error, 'email')}>
          <Input id="email" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" invalid={!!fieldError(error, 'email')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Send reset link
        </Button>
      </form>
    </AuthLayout>
  )
}

function SetNew({ token }: { token: string }) {
  const nav = useNavigate()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const info = useQuery({ queryKey: ['reset-info', token], queryFn: () => adminApi.resetInfo(token), retry: false })
  const expired = error?.code === 'RESET_EXPIRED' || (info.error as ApiError | null)?.code === 'RESET_EXPIRED'
  const min = info.data?.min_length ?? 10

  if (info.isLoading)
    return (
      <AuthLayout title="Choose a new password">
        <div className="space-y-3">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-12" />
        </div>
      </AuthLayout>
    )

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (pw.length < min) return setError({ field: 'password', message: `Use at least ${min} characters.` } as ApiError)
    if (pw !== pw2) return setError({ field: 'confirm', message: 'Passwords don’t match.' } as ApiError)
    setBusy(true)
    setError(null)
    try {
      await authApi.reset(token, pw)
      toast.success('Password changed', { description: 'Sign in with your new password.' })
      nav('/login', { replace: true })
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(false)
    }
  }

  if (expired)
    return (
      <AuthLayout title="This link has expired" subtitle="Reset links work once, for 60 minutes. Request a new one and use the latest email." footer={<Link to="/login" className="font-medium text-brand-text hover:underline">Back to sign in</Link>}>
        <div className="space-y-4">
          <Button variant="primary" size="lg" block onClick={() => nav('/reset-password', { replace: true })}>
            Request a new link
          </Button>
        </div>
      </AuthLayout>
    )

  return (
    <AuthLayout title="Choose a new password" subtitle={<>For {info.data?.email_hint}. Use at least {min} characters. You’ll be signed out on all devices.</>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <Field label="New password" htmlFor="pw" error={fieldError(error, 'password')}>
          <PasswordInput id="pw" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!fieldError(error, 'password')} />
        </Field>
        <StrengthMeter password={pw} min={min} />
        <Field label="Confirm password" htmlFor="pw2" error={fieldError(error, 'confirm')}>
          <PasswordInput id="pw2" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} invalid={!!fieldError(error, 'confirm')} />
        </Field>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Set password
        </Button>
      </form>
    </AuthLayout>
  )
}
