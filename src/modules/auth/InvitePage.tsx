import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import AuthLayout from '@/app/AuthLayout'
import { authApi } from '@/api/core'
import type { ApiError } from '@/api/http'
import { queryClient } from '@/api/query'
import { useSession } from '@/stores/session'
import { applyTheme } from '@/theme/theme'
import { ROLE_LABEL } from '@/domain/permissions'
import { Button, Field, Input, Skeleton, TenantMark, toast } from '@/ui'
import { FormError, PasswordInput, StrengthMeter, fieldError } from './authKit'

export default function InvitePage() {
  const { token = '' } = useParams()
  const nav = useNavigate()
  const { token: sessionToken, setSession, logout } = useSession()
  const q = useQuery({ queryKey: ['invite', token], queryFn: () => authApi.invite(token), retry: false })
  const [name, setName] = useState('')
  const [title, setTitle] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    if (q.data) {
      setName((n) => n || q.data.name)
      applyTheme(q.data.theme)
    }
  }, [q.data])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (name.trim().length < 2) return setError({ field: 'name', message: 'Enter your name.' } as ApiError)
    if (pw.length < 8) return setError({ field: 'password', message: 'Use at least 10 characters.' } as ApiError)
    setBusy(true)
    setError(null)
    try {
      const r = await authApi.acceptInvite(token, { name: name.trim(), password: pw, title: title.trim() || undefined })
      queryClient.clear()
      setSession(r)
      toast.success(`Welcome to ${q.data?.company}`)
      nav('/home', { replace: true })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  if (q.isLoading)
    return (
      <AuthLayout title="Opening your invitation…">
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-lg" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      </AuthLayout>
    )

  if (q.error || error?.code === 'INVITE_EXPIRED')
    return (
      <AuthLayout title="This invitation has expired" subtitle="Invitations work for 7 days and only once. Ask your admin to resend it — you’ll get a fresh link." >
        <Button variant="primary" size="lg" block onClick={() => nav('/login')}>
          Go to sign in
        </Button>
      </AuthLayout>
    )

  const inv = q.data!
  return (
    <AuthLayout
      title={`Join ${inv.company}`}
      subtitle="Set your name and a password to finish."
      footer={
        <p>
          By joining you agree to the <Link to="/terms" className="font-medium text-brand-text hover:underline">Terms</Link> and <Link to="/privacy" className="font-medium text-brand-text hover:underline">Privacy Policy</Link>.
        </p>
      }
    >
      {sessionToken && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">
          You’re signed in to another account.
          <Button size="sm" onClick={() => logout()}>Sign out</Button>
        </div>
      )}
      <div className="mb-6 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
        <TenantMark name={inv.company} logo={inv.logo_data_url} size={36} />
        <div className="min-w-0 flex-1 text-[13.5px]">
          <div className="truncate text-[14px] font-semibold">{inv.company}</div>
          <div className="mt-0.5 text-ink-3">
            {ROLE_LABEL[inv.role]}
            {inv.reports_to && <> · reports to {inv.reports_to}</>}
          </div>
          <div className="truncate text-ink-3">{inv.email}</div>
        </div>
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <Field label="Full name" htmlFor="name" required error={fieldError(error, 'name')}>
          <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} invalid={!!fieldError(error, 'name')} />
        </Field>
        <Field label="Job title" htmlFor="title" hint="Shown to your team, e.g. “React Developer”.">
          <Input id="title" autoComplete="organization-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Password" htmlFor="pw" required error={fieldError(error, 'password')}>
          <PasswordInput id="pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} invalid={!!fieldError(error, 'password')} />
        </Field>
        <StrengthMeter password={pw} />
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Join {inv.company}
        </Button>
      </form>
    </AuthLayout>
  )
}
