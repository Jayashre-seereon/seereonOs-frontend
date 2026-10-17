// Forced first sign-in password change (/welcome/password). AppShell sends anyone with
// `must_change_password` here, and the API refuses other writes until it is done.
import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { authApi } from '@/api/core'
import type { ApiError } from '@/api/http'
import { queryClient } from '@/api/query'
import { useSession } from '@/stores/session'
import type { User } from '@/types/entities'
import { Button, Card, Field, toast } from '@/ui'
import { FormError, PasswordInput, StrengthMeter, fieldError, passwordScore } from './authKit'

export default function FirstPasswordPage() {
  const { user, tenant, patchUser, logout } = useSession()
  const nav = useNavigate()
  const min = tenant?.settings?.['security.password_min_length'] ?? 10
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  if (!user) return <Navigate to="/login" replace />
  if (!user.must_change_password) return <Navigate to="/home" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!cur) return setError({ message: 'Enter the temporary password from your welcome email.', field: 'current' } as ApiError)
    if (next.length < min) return setError({ message: `Use at least ${min} characters.`, field: 'next' } as ApiError)
    if (passwordScore(next, min).score < 2) return setError({ message: 'Make it stronger: mix upper and lower case, numbers and a symbol — or make it longer.', field: 'next' } as ApiError)
    if (next !== confirm) return setError({ message: 'The two passwords don’t match.', field: 'confirm' } as ApiError)
    setBusy(true)
    setError(null)
    try {
      const r = (await authApi.password(cur, next)) as { ok: boolean; user?: User }
      patchUser({ ...(r.user ?? {}), must_change_password: false })
      queryClient.invalidateQueries()
      toast.success('Password set — welcome aboard')
      nav('/home', { replace: true })
    } catch (err) {
      setError(err as ApiError)
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    try {
      await authApi.logout()
    } catch {
      /* already signed out */
    }
    logout()
    queryClient.clear()
    nav('/login', { replace: true })
  }

  return (
    <div className="mx-auto max-w-[480px] py-2 md:py-8">
      <Card className="md:p-7">
        <div className="mb-5">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold leading-tight">Set your password</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-3">
              Welcome{user.name ? `, ${user.name.split(' ')[0]}` : ''}. Set a new password to finish setting up your account. You’ll use it from now on instead of the temporary one.
            </p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormError error={error} />
          <input type="email" autoComplete="username" value={user.email} readOnly hidden />
          <Field label="Temporary password" htmlFor="fp-cur" hint="From your welcome email." error={fieldError(error, 'current')}>
            <PasswordInput id="fp-cur" autoComplete="current-password" autoFocus value={cur} onChange={(e) => setCur(e.target.value)} invalid={!!fieldError(error, 'current')} />
          </Field>
          <Field label="New password" htmlFor="fp-next" error={fieldError(error, 'next')}>
            <PasswordInput id="fp-next" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} invalid={!!fieldError(error, 'next')} />
          </Field>
          <StrengthMeter password={next} min={min} />
          <Field label="Confirm new password" htmlFor="fp-confirm" error={fieldError(error, 'confirm')}>
            <PasswordInput id="fp-confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} invalid={!!fieldError(error, 'confirm')} />
          </Field>
          <Button type="submit" variant="primary" size="lg" block loading={busy}>
            Set password and continue
          </Button>
        </form>
        <div className="mt-4 text-center">
          <button type="button" onClick={signOut} className="text-[13px] font-medium text-ink-3 hover:text-ink">
            Sign out
          </button>
        </div>
      </Card>
    </div>
  )
}
