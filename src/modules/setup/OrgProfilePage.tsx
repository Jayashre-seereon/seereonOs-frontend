import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { OrgProfile } from '@/types/access'
import type { ApiError } from '@/api/http'
import { announce, changesApi, isPending } from '@/api/changes'
import { useApi, useMut } from '@/api/query'
import { INDIAN_STATES, formatEmployeeCode, masterApi, useOrgMeta, useOrgProfile, type OrgPatch } from '@/api/master'
import { fmtDate, relTime } from '@/domain/calendar'
import { Button, Callout, Card, CardHeader, ErrorState, Field, Input, KV, PageHeader, Select, SkeletonRows, Textarea, useCan, useReadOnly } from '@/ui'
import { Hourglass, Lock } from '@/ui/icons'
import { SaveBar } from '@/modules/admin/kit'

type Draft = Omit<OrgProfile, 'employee_code_next'> & { employee_code_next: string; bank_account: string }
const LABEL: Record<string, string> = {
  legal_name: 'Legal name', brand_name: 'Brand name', cin: 'CIN', gstin: 'GSTIN', pan: 'PAN', tan: 'TAN', registered_address: 'Registered address', corporate_address: 'Corporate address', city: 'City', state: 'State',
  pincode: 'Pincode', country: 'Country', phone: 'Phone', email: 'Email', website: 'Website', incorporated_on: 'Incorporated on', employee_code_prefix: 'Employee code prefix', employee_code_next: 'Next employee number',
  bank_name: 'Bank', bank_account_masked: 'Bank account', ifsc: 'IFSC',
}
const UPPER = new Set(['cin', 'gstin', 'pan', 'tan', 'ifsc', 'employee_code_prefix'])
const masked = (m: string) => (m ? `•••• ${m.slice(-4)}` : '—')

export default function OrgProfilePage() {
  const org = useOrgProfile()
  const meta = useOrgMeta()
  const pending = useApi(['changes', 'org_profile', 'pending'], () => changesApi.list({ entity: 'org_profile', status: 'pending' }))
  const c = useCan()
  const readOnly = useReadOnly()
  const canEdit = c('master.edit') && !readOnly
  const loading = org.isLoading || meta.isLoading
  const error = org.error || meta.error
  return (
    <div className="pb-28">
      <PageHeader
        title="Organisation profile"
        subtitle="Legal identity, tax registrations and addresses. Used on letters, payslips, invoices and every email the system sends."
      />
      {pending.data?.[0] && <PendingBanner change={pending.data[0]} />}
      {loading ? (
        <SkeletonRows rows={8} />
      ) : error || !org.data || !meta.data ? (
        <ErrorState error={error ?? { message: 'The organisation profile is not set up yet.' }} onRetry={() => (org.refetch(), meta.refetch())} />
      ) : canEdit ? (
        <Editor key={`${meta.data.version}:${org.dataUpdatedAt}`} org={org.data} version={meta.data.version} checked={meta.data.maker_checker} blocked={!!pending.data?.length} />
      ) : (
        <ReadView org={org.data} />
      )}
    </div>
  )
}

function PendingBanner({ change }: { change: Awaited<ReturnType<typeof changesApi.list>>[number] }) {
  const withdraw = useMut(() => changesApi.withdraw(change.id), { invalidate: [['changes'], ['master']], success: 'Change withdrawn' })
  const fields = Object.keys(change.after ?? {})
  return (
    <Callout
      tone="warning"
      icon={<Hourglass />}
      className="mb-5"
      title="Change waiting for approval"
      action={
        <div className="flex flex-col gap-1.5 sm:flex-row">
          {change.can_withdraw && (
            <Button size="sm" loading={withdraw.isPending} onClick={() => withdraw.mutate(undefined)}>
              Withdraw
            </Button>
          )}
          <Link to="/changes" className="inline-flex h-8 items-center justify-center rounded-md border border-line-strong bg-surface px-3 text-[13px] font-medium text-ink hover:bg-surface-2">
            {change.can_check ? 'Review' : 'View'}
          </Link>
        </div>
      }
    >
      <p>
        {change.maker_name} proposed this {relTime(change.created_at)}. It takes effect once someone with “Check changes” approves it.
      </p>
      <ul className="mt-2 space-y-1">
        {fields.map((k) => (
          <li key={k} className="min-w-0 break-words text-[13px]">
            <span className="font-medium text-ink">{LABEL[k] ?? k}:</span> <span className="text-ink-3 line-through">{show(k, change.before?.[k])}</span> <span className="text-ink-3">→</span> <span className="text-ink">{show(k, change.after?.[k])}</span>
          </li>
        ))}
      </ul>
    </Callout>
  )
}
function show(k: string, v: unknown) {
  if (v === null || v === undefined || v === '') return 'empty'
  if (k === 'bank_account_masked') return masked(String(v))
  if (k === 'incorporated_on') return fmtDate(String(v), 'long')
  return String(v)
}

function toDraft(o: OrgProfile): Draft {
  return { ...o, employee_code_next: String(o.employee_code_next), bank_account: '' }
}

function Editor({ org, version, checked, blocked }: { org: OrgProfile; version: number; checked: boolean; blocked: boolean }) {
  const init = useMemo(() => toDraft(org), [org])
  const [d, setD] = useState<Draft>(init)
  const [err, setErr] = useState<ApiError | null>(null)
  const changed = (Object.keys(d) as (keyof Draft)[]).filter((k) => (k === 'bank_account' ? d.bank_account.trim() !== '' : String(d[k] ?? '') !== String(init[k] ?? '')))
  const dirty = changed.length > 0
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setD((p) => ({ ...p, [k]: UPPER.has(k) && typeof v === 'string' ? (v.toUpperCase() as Draft[K]) : v }))
    if (err?.field === k) setErr(null)
  }
  const save = useMut(
    () => {
      const body: OrgPatch = {}
      for (const k of changed) {
        if (k === 'employee_code_next') body.employee_code_next = Number(d.employee_code_next)
        else if (k === 'incorporated_on') body.incorporated_on = d.incorporated_on || null
        else (body as Record<string, unknown>)[k] = d[k]
      }
      return masterApi.saveOrg(body, version)
    },
    {
      invalidate: [['master'], ['changes'], ['tenant'], ['setup'], ['onboarding']],
      onSuccess: (r) => {
        announce(r, 'Organisation profile saved')
        setErr(null)
        if (isPending(r)) setD(init)
      },
      onError: (e) => {
        setErr(e)
        if (e.field) setTimeout(() => document.getElementById(`org-${e.field}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30)
      },
    },
  )
  const fe = (k: string) => (err?.field === k ? err.message : null)
  const text = (k: keyof Draft, label: string, opts: { hint?: ReactNode; placeholder?: string; required?: boolean; max?: number; type?: string; mono?: boolean; className?: string } = {}) => (
    <Field label={label} htmlFor={`org-${k}`} hint={opts.hint} error={fe(k)} required={opts.required} className={opts.className}>
      <Input
        id={`org-${k}`}
        type={opts.type ?? 'text'}
        value={String(d[k] ?? '')}
        maxLength={opts.max}
        placeholder={opts.placeholder}
        onChange={(e) => set(k, e.target.value as never)}
        invalid={!!fe(k)}
        disabled={blocked}
        className={opts.mono ? 'font-mono tracking-[0.02em]' : undefined}
      />
    </Field>
  )
  const states = d.state && !INDIAN_STATES.includes(d.state) ? [d.state, ...INDIAN_STATES] : INDIAN_STATES
  const example = formatEmployeeCode(d.employee_code_prefix || 'EMP', Number(d.employee_code_next) || 1)

  return (
    <>
      {checked && !blocked && (
        <Callout tone="neutral" icon={<Lock />} className="mb-5">
          Maker-checker is on for the organisation profile. Your changes are sent to a second person for approval before they apply.
        </Callout>
      )}
      <div className="space-y-4">
        <Card>
          <CardHeader title="Legal & tax" subtitle="As registered with the MCA and the tax department." />
          <div className="grid gap-4 md:grid-cols-2">
            {text('legal_name', 'Legal name', { required: true, placeholder: 'Company Pvt. Ltd.' })}
            {text('brand_name', 'Brand name', { required: true, hint: 'Shown in the app and in emails.' })}
            {text('cin', 'CIN', { max: 21, mono: true, placeholder: 'U72900OR2025PTC048213', hint: 'Corporate identity number, 21 characters.' })}
            {text('incorporated_on', 'Incorporated on', { type: 'date' })}
            {text('pan', 'PAN', { max: 10, mono: true, placeholder: 'AAAAA9999A' })}
            {text('tan', 'TAN', { max: 10, mono: true, placeholder: 'AAAA99999A', hint: 'Needed for TDS on salaries.' })}
            {text('gstin', 'GSTIN', { max: 15, mono: true, placeholder: '21AAAAA9999A1Z5', hint: 'State code + PAN + entity + Z + check digit.', className: 'md:col-span-2 md:max-w-[calc(50%-8px)]' })}
          </div>
        </Card>
        <Card>
          <CardHeader title="Addresses" subtitle="The registered address appears on statutory letters; the corporate address on everything else." />
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Registered address" htmlFor="org-registered_address" error={fe('registered_address')}>
              <Textarea id="org-registered_address" rows={2} value={d.registered_address} onChange={(e) => set('registered_address', e.target.value)} disabled={blocked} />
            </Field>
            <Field label="Corporate address" htmlFor="org-corporate_address" error={fe('corporate_address')} aside={!blocked && d.registered_address && d.corporate_address !== d.registered_address ? <button type="button" className="text-[12.5px] font-medium text-brand-text hover:underline" onClick={() => set('corporate_address', d.registered_address)}>Same as registered</button> : undefined}>
              <Textarea id="org-corporate_address" rows={2} value={d.corporate_address} onChange={(e) => set('corporate_address', e.target.value)} disabled={blocked} />
            </Field>
            {text('city', 'City')}
            <Field label="State" htmlFor="org-state" error={fe('state')}>
              <Select id="org-state" value={d.state} onChange={(e) => set('state', e.target.value)} placeholder="Choose a state" options={states} disabled={blocked} />
            </Field>
            {text('pincode', 'Pincode', { max: 6, placeholder: '751030' })}
            {text('country', 'Country')}
          </div>
        </Card>
        <Card>
          <CardHeader title="Contact" />
          <div className="grid gap-4 md:grid-cols-3">
            {text('phone', 'Phone', { type: 'tel', placeholder: '+91 90000 00000' })}
            {text('email', 'Email', { type: 'email', placeholder: 'hr@company.in' })}
            {text('website', 'Website', { placeholder: 'company.in' })}
          </div>
        </Card>
        <Card>
          <CardHeader title="Employee numbering" subtitle="New employees get the next number automatically. Numbers are never reused." />
          <div className="grid gap-4 sm:grid-cols-[160px_160px_1fr] sm:items-start">
            {text('employee_code_prefix', 'Prefix', { max: 6, mono: true, placeholder: 'SCI', required: true })}
            {text('employee_code_next', 'Next number', { type: 'number', required: true })}
            <div className="min-w-0 sm:pt-[26px]">
              <div className="flex h-[var(--ctl-h)] items-center gap-2 rounded-md bg-surface-2 px-3 text-[13.5px]">
                <span className="text-ink-3">Next employee</span>
                <span className="tnum font-mono font-medium text-ink">{example}</span>
              </div>
            </div>
          </div>
        </Card>
        <Card>
          <CardHeader title="Bank" subtitle="Salary is paid from this account. Only the last 4 digits are stored and shown." />
          <div className="grid gap-4 md:grid-cols-3">
            {text('bank_name', 'Bank name', { placeholder: 'HDFC Bank' })}
            <Field label="Account number" htmlFor="org-bank_account" error={fe('bank_account')} hint={init.bank_account_masked ? `Current: ${masked(init.bank_account_masked)}. Enter a new number to replace it.` : 'Digits only.'}>
              <Input id="org-bank_account" inputMode="numeric" autoComplete="off" value={d.bank_account} placeholder={init.bank_account_masked ? masked(init.bank_account_masked) : '9–18 digits'} onChange={(e) => set('bank_account', e.target.value.replace(/[^0-9]/g, ''))} invalid={!!fe('bank_account')} disabled={blocked} className="tnum" />
            </Field>
            {text('ifsc', 'IFSC', { max: 11, mono: true, placeholder: 'HDFC0001234' })}
          </div>
        </Card>
      </div>
      <SaveBar
        dirty={dirty && !blocked}
        saving={save.isPending}
        onSave={() => save.mutate(undefined)}
        onDiscard={() => (setD(init), setErr(null))}
        label={checked ? 'Needs approval' : 'Unsaved changes'}
        count={changed.length}
      />
    </>
  )
}

function ReadView({ org }: { org: OrgProfile }) {
  const v = (s: string | null | undefined) => s || <span className="text-ink-3">Not set</span>
  return (
    <div className="space-y-4">
      <Callout tone="neutral" icon={<Lock />}>
        You can see the organisation profile. Ask an administrator or HR manager to change it.
      </Callout>
      <Card>
        <CardHeader title="Legal & tax" />
        <KV
          cols={2}
          items={[
            { label: 'Legal name', value: v(org.legal_name) },
            { label: 'Brand name', value: v(org.brand_name) },
            { label: 'CIN', value: <span className="font-mono">{v(org.cin)}</span> },
            { label: 'Incorporated on', value: org.incorporated_on ? fmtDate(org.incorporated_on, 'long') : v(null) },
            { label: 'PAN', value: <span className="font-mono">{v(org.pan)}</span> },
            { label: 'TAN', value: <span className="font-mono">{v(org.tan)}</span> },
            { label: 'GSTIN', value: <span className="font-mono">{v(org.gstin)}</span> },
          ]}
        />
      </Card>
      <Card>
        <CardHeader title="Addresses & contact" />
        <KV
          cols={2}
          items={[
            { label: 'Registered address', value: v([org.registered_address, org.city, org.state, org.pincode].filter(Boolean).join(', ')) },
            { label: 'Corporate address', value: v(org.corporate_address) },
            { label: 'Phone', value: v(org.phone) },
            { label: 'Email', value: v(org.email) },
            { label: 'Website', value: v(org.website) },
            { label: 'Country', value: v(org.country) },
          ]}
        />
      </Card>
      <Card>
        <CardHeader title="Employee numbering & bank" />
        <KV
          cols={2}
          items={[
            { label: 'Next employee code', value: <span className="tnum font-mono">{formatEmployeeCode(org.employee_code_prefix, org.employee_code_next)}</span> },
            { label: 'Bank', value: v(org.bank_name) },
            { label: 'Account', value: <span className="tnum">{masked(org.bank_account_masked)}</span> },
            { label: 'IFSC', value: <span className="font-mono">{v(org.ifsc)}</span> },
          ]}
        />
      </Card>
    </div>
  )
}
