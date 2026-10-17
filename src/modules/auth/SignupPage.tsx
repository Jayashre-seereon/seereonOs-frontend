import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import AuthLayout from '@/app/AuthLayout'
import { authApi } from '@/api/core'
import type { ApiError } from '@/api/http'
import { queryClient } from '@/api/query'
import { useSession } from '@/stores/session'
import { Button, Checkbox, Field, Input, Select, toast } from '@/ui'
import { FormError, PasswordInput, StrengthMeter, fieldError } from './authKit'

const INDUSTRIES = [
  { value: 'it_services', label: 'IT services' },
  { value: 'sap_consulting', label: 'SAP consulting' },
  { value: 'product', label: 'Software product' },
  { value: 'other', label: 'Other' },
]

export default function SignupPage() {
  const nav = useNavigate()
  const setSession = useSession((s) => s.setSession)
  const [f, setF] = useState({ company: '', industry: 'it_services', name: '', email: '', password: '' })
  const [terms, setTerms] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ApiError | null>(null)
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }))

  const local = (): ApiError | null => {
    const e = (field: string, message: string) => ({ field, message } as ApiError)
    if (f.company.trim().length < 2) return e('company', 'Enter your company name.')
    if (f.name.trim().length < 2) return e('name', 'Enter your name.')
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email.trim())) return e('email', 'Enter a valid work email.')
    if (f.password.length < 10) return e('password', 'Use at least 10 characters.')
    if (!terms) return e('terms', 'Accept the terms to continue.')
    return null
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    const le = local()
    if (le) return setError(le)
    setBusy(true)
    setError(null)
    try {
      const r = await authApi.signup({ company: f.company.trim(), industry: f.industry, name: f.name.trim(), email: f.email.trim(), password: f.password })
      queryClient.clear()
      setSession(r)
      toast.success('Workspace created', { description: 'Your 14-day trial has started.' })
      nav('/onboarding', { replace: true })
    } catch (e) {
      setError(e as ApiError)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Create your workspace"
      subtitle="14-day free trial. No card needed."
      footer={
        <p>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-text hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError error={error} />
        <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
          <Field label="Company" htmlFor="company" required error={fieldError(error, 'company')}>
            <Input id="company" autoComplete="organization" value={f.company} onChange={(e) => set('company')(e.target.value)} placeholder="Acme Technologies" invalid={!!fieldError(error, 'company')} autoFocus />
          </Field>
          <Field label="Industry" htmlFor="industry">
            <Select id="industry" value={f.industry} onChange={(e) => set('industry')(e.target.value)} options={INDUSTRIES} />
          </Field>
        </div>
        <Field label="Your name" htmlFor="name" required error={fieldError(error, 'name')}>
          <Input id="name" autoComplete="name" value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Full name" invalid={!!fieldError(error, 'name')} />
        </Field>
        <Field label="Work email" htmlFor="email" required error={fieldError(error, 'email')}>
          <Input id="email" type="email" inputMode="email" autoCapitalize="none" autoComplete="email" value={f.email} onChange={(e) => set('email')(e.target.value)} placeholder="you@company.com" invalid={!!fieldError(error, 'email')} />
        </Field>
        <Field label="Password" htmlFor="password" required error={fieldError(error, 'password')}>
          <PasswordInput id="password" autoComplete="new-password" value={f.password} onChange={(e) => set('password')(e.target.value)} invalid={!!fieldError(error, 'password')} />
        </Field>
        <StrengthMeter password={f.password} />
        <div>
          <Checkbox
            checked={terms}
            onChange={setTerms}
            label={
              <span className="font-normal text-ink-2">
                I agree to the{' '}
                <Link to="/terms" target="_blank" className="font-medium text-brand-text hover:underline">Terms</Link> and{' '}
                <Link to="/privacy" target="_blank" className="font-medium text-brand-text hover:underline">Privacy Policy</Link>
              </span>
            }
          />
          {fieldError(error, 'terms') && <p className="mt-1 text-[12.5px] font-medium text-danger-text">{fieldError(error, 'terms')}</p>}
        </div>
        <Button type="submit" variant="primary" size="lg" block loading={busy}>
          Create workspace
        </Button>
        <p className="text-center text-[12px] text-ink-3">You’ll be the workspace admin. Invite your team next.</p>
      </form>
    </AuthLayout>
  )
}
