// Create employee: personal + job details, role (with extra permissions), pay, and the welcome
// email with login credentials. Goes through maker-checker when the tenant checks employee creation.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CheckCircle2, ChevronDown, Hourglass, UserPlus } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { http } from '@/api/http'
import { accessApi, EMPLOYMENT_TYPE_LABEL, PEOPLE_KEYS, useMasterData, useRoles, type CreatedEmployee, type EmployeeInput, type ProposedNamed } from '@/api/access'
import { isPending } from '@/api/changes'
import { usePeopleMap } from '@/api/core'
import { useSession } from '@/stores/session'
import { todayISO } from '@/domain/calendar'
import type { EmailTemplate } from '@/types/access'
import { Button, Callout, Card, CardHeader, Checkbox, Field, Input, MoneyInput, PageHeader, PeoplePicker, Select, Switch, useCan, useReadOnly } from '@/ui'
import { cn } from '@/lib/utils'
import { errField } from './kit'
import { PermissionMatrix } from '../access/PermissionMatrix'
import { CredentialsCard, EmailPreview, RoleSummary, checkerText } from '../access/kit'

const LOGIN_URL = 'https://app.seereonos.com/login'
const FALLBACK_WELCOME = {
  subject: 'Welcome to {{company}}, {{employee_name}} — your SeereonOS login',
  body: 'Hi {{employee_name}},\n\nWelcome to {{company}}! Your SeereonOS account is ready.\n\nSign in: {{login_url}}\nUsername: {{username}}\nTemporary password: {{temp_password}}\n\nYou will be asked to set your own password the first time you sign in.\n\nYour role: {{role_name}}\nReporting manager: {{manager_name}}\nJoining date: {{joining_date}}',
}
const render = (t: string, vars: Record<string, string>) => t.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '')
const longDate = (d: string) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '')

const blank = (): EmployeeInput => ({
  name: '', email: '', personal_email: '', phone: '', joined_on: todayISO(), employment_type: 'full_time',
  department_id: null, designation_id: null, grade_id: null, location_id: null, shift_id: null, cost_centre_id: null, reports_to_id: null,
  role_key: 'employee', extra_permissions: [], monthly_ctc_paise: null, send_welcome: true,
})

export default function CreateEmployeePage() {
  const c = useCan()
  const readOnly = useReadOnly()
  const nav = useNavigate()
  const tenant = useSession((s) => s.tenant)
  const roles = useRoles()
  const md = useMasterData()
  const people = usePeopleMap()
  const templates = useApi(['emails', 'templates'], () => http.get<EmailTemplate[]>('/emails/templates'), { enabled: c('emails.view'), staleTime: 60_000 })
  const [f, setF] = useState<EmployeeInput>(blank)
  const [extrasOpen, setExtrasOpen] = useState(false)
  const [roleHint, setRoleHint] = useState<string | null>(null)
  const [done, setDone] = useState<ProposedNamed<CreatedEmployee> | null>(null)
  const [joiningLetter, setJoiningLetter] = useState(true) // v7: issue the joining letter (Documents) on create
  const [onboarding, setOnboarding] = useState(true) // v7: start the onboarding workflow on create
  const set = (p: Partial<EmployeeInput>) => setF((x) => ({ ...x, ...p }))

  // sensible defaults once master data arrives
  useEffect(() => {
    setF((x) => ({
      ...x,
      location_id: x.location_id ?? md.locations.data?.find((l) => l.active && l.is_head_office)?.id ?? md.locations.data?.find((l) => l.active)?.id ?? null,
      shift_id: x.shift_id ?? md.shifts.data?.find((s) => s.active && s.is_default)?.id ?? null,
    }))
  }, [md.locations.data, md.shifts.data])

  const activeRoles = (roles.data ?? []).filter((r) => r.active)
  const role = activeRoles.find((r) => r.key === f.role_key)
  const canGrant = c('users.manage')
  const isAccessRole = (perms: string[]) => perms.includes('roles.manage') || perms.includes('users.manage')
  const depts = (md.departments.data ?? []).filter((d) => d.active)
  const desigs = (md.designations.data ?? []).filter((d) => d.active && (!f.department_id || !d.department_id || d.department_id === f.department_id))
  const grades = (md.grades.data ?? []).filter((g) => g.active)
  const locs = (md.locations.data ?? []).filter((l) => l.active)
  const shifts = (md.shifts.data ?? []).filter((s) => s.active)
  const ccs = (md.costCentres.data ?? []).filter((x) => x.active)
  const manager = people.get(f.reports_to_id)

  const onDepartment = (id: string) => {
    const d = depts.find((x) => x.id === id)
    const desig = (md.designations.data ?? []).find((x) => x.id === f.designation_id)
    set({
      department_id: id || null,
      designation_id: desig && desig.department_id && desig.department_id !== id ? null : f.designation_id,
      reports_to_id: f.reports_to_id ?? (d?.head_id && people.get(d.head_id)?.status === 'active' ? d.head_id : null),
      cost_centre_id: f.cost_centre_id ?? d?.cost_centre_id ?? null,
    })
  }
  const onDesignation = (id: string) => {
    const d = (md.designations.data ?? []).find((x) => x.id === id)
    const r = d?.default_role_id ? activeRoles.find((x) => x.id === d.default_role_id || x.key === d.default_role_id) : null
    const allowed = r && (canGrant || !isAccessRole(r.permissions))
    set({ designation_id: id || null, grade_id: d?.grade_id ?? f.grade_id, department_id: f.department_id ?? d?.department_id ?? null, ...(allowed ? { role_key: r!.key, extra_permissions: f.extra_permissions.filter((k) => !r!.permissions.includes(k)) } : {}) })
    setRoleHint(allowed ? `Suggested by ${d!.name}` : null)
  }

  const tpl = templates.data?.find((t) => t.key === 'welcome' && t.active) ?? FALLBACK_WELCOME
  const vars = {
    company: tenant?.org?.brand_name || tenant?.name || '', login_url: LOGIN_URL, employee_name: f.name.trim() || 'New employee', username: f.email.trim() || 'their work email',
    temp_password: '•••••••••••• (generated when you create)', role_name: role?.name ?? '', manager_name: manager?.name ?? '—', joining_date: longDate(f.joined_on), employee_code: 'assigned on create',
  }

  const m = useMut(() => accessApi.createEmployee({ ...f, name: f.name.trim(), email: f.email.trim(), extra_permissions: canGrant ? f.extra_permissions : [], monthly_ctc_paise: c('cost_rates.edit') ? f.monthly_ctc_paise : null, ...({ issue_joining_letter: c('documents.templates') && joiningLetter, start_onboarding: c('workflows.start') && onboarding } as object) } as EmployeeInput), {
    invalidate: PEOPLE_KEYS,
    onSuccess: (r) => {
      setDone(r)
      window.scrollTo({ top: 0 })
    },
    onError: () => setTimeout(() => document.querySelector('[aria-invalid="true"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 50),
  })
  const e = m.error
  const ready = f.name.trim().length >= 2 && !!f.email.trim() && !!f.role_key && !!f.joined_on

  if (done)
    return (
      <Done
        r={done}
        onAnother={() => {
          setDone(null)
          setF(blank())
          setRoleHint(null)
          m.reset()
        }}
      />
    )

  return (
    <div className="pb-28 lg:pb-8">
      <PageHeader back={{ to: '/people', label: 'People' }} title="Create employee" subtitle="Set up their account, role and reporting line. They get a welcome email with login details." />
      {e && !e.field && <Callout tone="danger" className="mb-4">{e.message}</Callout>}
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="min-w-0 space-y-5 lg:col-span-7 xl:col-span-8">
          <Card>
            <CardHeader title="Personal" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name" htmlFor="ce-name" required error={errField(e, 'name')}>
                <Input id="ce-name" autoFocus value={f.name} onChange={(ev) => set({ name: ev.target.value })} autoComplete="off" invalid={!!errField(e, 'name')} />
              </Field>
              <Field label="Work email" htmlFor="ce-email" required hint="This is their login." error={errField(e, 'email')}>
                <Input id="ce-email" type="email" inputMode="email" autoCapitalize="none" autoComplete="off" value={f.email} onChange={(ev) => set({ email: ev.target.value })} placeholder="name@company.com" invalid={!!errField(e, 'email')} />
              </Field>
              <Field label="Personal email" htmlFor="ce-pe" error={errField(e, 'personal_email')}>
                <Input id="ce-pe" type="email" inputMode="email" autoCapitalize="none" value={f.personal_email} onChange={(ev) => set({ personal_email: ev.target.value })} invalid={!!errField(e, 'personal_email')} />
              </Field>
              <Field label="Phone" htmlFor="ce-phone" error={errField(e, 'phone')}>
                <Input id="ce-phone" type="tel" inputMode="tel" value={f.phone} onChange={(ev) => set({ phone: ev.target.value })} placeholder="+91" invalid={!!errField(e, 'phone')} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Job" subtitle="The designation suggests a role; the manager approves their leave and timesheets." />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Department" htmlFor="ce-dept" required={depts.length > 0} error={errField(e, 'department_id')}>
                <Select id="ce-dept" value={f.department_id ?? ''} onChange={(ev) => onDepartment(ev.target.value)} placeholder={depts.length ? 'Choose a department' : 'No departments set up'} options={depts.map((d) => ({ value: d.id, label: d.name }))} invalid={!!errField(e, 'department_id')} />
              </Field>
              <Field label="Designation" htmlFor="ce-desig" required={desigs.length > 0} error={errField(e, 'designation_id')}>
                <Select id="ce-desig" value={f.designation_id ?? ''} onChange={(ev) => onDesignation(ev.target.value)} placeholder={desigs.length ? 'Choose a designation' : 'No designations set up'} options={desigs.map((d) => ({ value: d.id, label: d.name }))} invalid={!!errField(e, 'designation_id')} />
              </Field>
              <Field label="Grade" htmlFor="ce-grade" error={errField(e, 'grade_id')}>
                <Select id="ce-grade" value={f.grade_id ?? ''} onChange={(ev) => set({ grade_id: ev.target.value || null })} placeholder="None" options={grades.map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))} />
              </Field>
              <Field label="Location" htmlFor="ce-loc" error={errField(e, 'location_id')}>
                <Select id="ce-loc" value={f.location_id ?? ''} onChange={(ev) => set({ location_id: ev.target.value || null })} placeholder="None" options={locs.map((l) => ({ value: l.id, label: l.is_head_office ? `${l.name} (head office)` : l.name }))} />
              </Field>
              <Field label="Shift" htmlFor="ce-shift" error={errField(e, 'shift_id')}>
                <Select id="ce-shift" value={f.shift_id ?? ''} onChange={(ev) => set({ shift_id: ev.target.value || null })} placeholder="None" options={shifts.map((s) => ({ value: s.id, label: `${s.name} · ${s.start_time}–${s.end_time}` }))} />
              </Field>
              <Field label="Cost centre" htmlFor="ce-cc" hint="Defaults to the department’s.">
                <Select id="ce-cc" value={f.cost_centre_id ?? ''} onChange={(ev) => set({ cost_centre_id: ev.target.value || null })} placeholder="None" options={ccs.map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))} />
              </Field>
              <Field label="Joining date" htmlFor="ce-join" required error={errField(e, 'joined_on')}>
                <Input id="ce-join" type="date" value={f.joined_on} onChange={(ev) => set({ joined_on: ev.target.value })} invalid={!!errField(e, 'joined_on')} />
              </Field>
              <Field label="Employment type" htmlFor="ce-et" error={errField(e, 'employment_type')}>
                <Select id="ce-et" value={f.employment_type} onChange={(ev) => set({ employment_type: ev.target.value as EmployeeInput['employment_type'] })} options={Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
              </Field>
              <Field label="Reporting manager" htmlFor="ce-mgr" className="sm:col-span-2" required={role?.persona !== 'admin'} hint="Approves their leave, timesheets and expenses (first step)." error={errField(e, 'reports_to_id')}>
                <PeoplePicker id="ce-mgr" value={f.reports_to_id} onChange={(v) => set({ reports_to_id: v })} filter={(p) => p.status === 'active'} clearable placeholder="Choose their manager" invalid={!!errField(e, 'reports_to_id')} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Access" subtitle="The role decides which screens they see and what they can do." />
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Role" htmlFor="ce-role" required hint={roleHint ?? undefined} error={errField(e, 'role_key')}>
                <Select
                  id="ce-role"
                  value={f.role_key}
                  onChange={(ev) => {
                    const r = activeRoles.find((x) => x.key === ev.target.value)
                    set({ role_key: ev.target.value, extra_permissions: f.extra_permissions.filter((k) => !r?.permissions.includes(k)) })
                    setRoleHint(null)
                  }}
                  options={activeRoles.map((r) => ({ value: r.key, label: !canGrant && isAccessRole(r.permissions) ? `${r.name} (needs “Manage user access”)` : r.name, disabled: !canGrant && isAccessRole(r.permissions) }))}
                  invalid={!!errField(e, 'role_key')}
                />
              </Field>
              {role && <RoleSummary role={role} extra={f.extra_permissions} className="md:row-span-2" />}
            </div>
            {canGrant && role && (
              <div className="mt-4 border-t border-line pt-3">
                <button type="button" onClick={() => setExtrasOpen((o) => !o)} aria-expanded={extrasOpen} className="flex w-full items-center gap-2 py-1 text-left">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-ink">Extra permissions {f.extra_permissions.length > 0 && <span className="tnum text-brand-text">· {f.extra_permissions.length}</span>}</span>
                    <span className="block text-[12.5px] text-ink-3">Optional. Give this person more than their role, e.g. “See project margins”.</span>
                  </span>
                  <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition', extrasOpen && 'rotate-180')} />
                </button>
                {extrasOpen && (
                  <div className="mt-3">
                    {errField(e, 'extra_permissions') && <Callout tone="danger" className="mb-3">{errField(e, 'extra_permissions')}</Callout>}
                    <PermissionMatrix
                      value={[...new Set([...role.permissions, ...f.extra_permissions])]}
                      onChange={(next) => set({ extra_permissions: next.filter((k) => !role.permissions.includes(k)) })}
                      locked={role.permissions}
                      lockedNote="In role"
                      compact
                    />
                  </div>
                )}
              </div>
            )}
          </Card>

          {c('cost_rates.edit') && (
            <Card>
              <CardHeader title="Pay" subtitle="Monthly CTC sets their cost rate from the joining date. Leave empty to add it later." />
              <Field label="Monthly CTC" htmlFor="ce-ctc" error={errField(e, 'monthly_ctc_paise')} className="sm:max-w-[280px]">
                <MoneyInput id="ce-ctc" value={f.monthly_ctc_paise} onChange={(p) => set({ monthly_ctc_paise: p || null })} invalid={!!errField(e, 'monthly_ctc_paise')} />
              </Field>
            </Card>
          )}
        </div>

        <div className="min-w-0 lg:col-span-5 xl:col-span-4">
          <div className="space-y-4 lg:sticky lg:top-[76px]">
            <Card>
              <CardHeader title="Welcome email" subtitle="Login details go to their work email." />
              <Switch checked={f.send_welcome} onChange={(v) => set({ send_welcome: v })} label="Send welcome email" description={f.send_welcome ? 'Sent the moment the employee is created.' : 'You will see the login details to share yourself.'} />
              {f.send_welcome && (
                <EmailPreview className="mt-4" to={f.email.trim()} subject={render(tpl.subject, vars)} body={render(tpl.body, vars)} note={c('emails.view') ? <Link to="/setup/emails" className="font-medium text-brand-text hover:underline">Edit template</Link> : 'Template set by your administrator'} />
              )}
            </Card>
            {c('documents.templates') && (
              <Card>
                <CardHeader title="Joining letter" subtitle="From the Joining letter template under Documents." />
                <Checkbox checked={joiningLetter} onChange={setJoiningLetter} label="Issue joining letter" description={joiningLetter ? 'Issued with their joining date, designation, manager, shift timings and CTC. They acknowledge it under My documents.' : 'You can issue it later from Documents → Templates.'} />
              </Card>
            )}
            {c('workflows.start') && (
              <Card>
                <CardHeader title="Onboarding" subtitle="The Employee onboarding workflow under Workflows." />
                <Checkbox checked={onboarding} onChange={setOnboarding} label="Start onboarding workflow" description={onboarding ? 'Starts as soon as the employee is created; each stage goes to the right person.' : 'You can start it later from Workflows.'} />
              </Card>
            )}
            <div className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom,0px))] z-20 border-t border-line bg-surface px-4 py-2.5 lg:static lg:z-auto lg:border-0 lg:bg-transparent lg:p-0">
              <Button variant="primary" block icon={<UserPlus className="size-4" />} loading={m.isPending} disabled={!ready || readOnly} onClick={() => m.mutate(undefined)}>
                Create employee
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Done({ r, onAnother }: { r: ProposedNamed<CreatedEmployee>; onAnother: () => void }) {
  const nav = useNavigate()
  if (isPending(r))
    return (
      <div className="mx-auto max-w-[720px]">
        <PageHeader title="Sent for approval" subtitle={r.change.summary} />
        <Card>
          <div className="flex items-start gap-3">
            <Hourglass className="mt-0.5 size-5 shrink-0 text-warning-text" />
            <div className="min-w-0 text-[14px]">
              <p className="font-medium text-ink">Sent to {checkerText(r.checker_names)} for approval.</p>
              <p className="mt-1 text-ink-3">The account is created and the welcome email goes out once it is approved. You’ll get a notification.</p>
            </div>
          </div>
        </Card>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={() => nav('/people')}>Back to people</Button>
          <Button variant="primary" onClick={onAnother}>Create another</Button>
        </div>
      </div>
    )
  const x = r.result
  return (
    <div className="mx-auto max-w-[760px]">
      <PageHeader title="Employee created" subtitle={`${x.user.name} can sign in now. They’ll be asked to set their own password.`} />
      <Card className="mb-4">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-text" />
          <div className="grid min-w-0 flex-1 gap-x-6 gap-y-3 text-[13.5px] sm:grid-cols-3">
            <div className="min-w-0">
              <div className="text-[12px] text-ink-3">Employee code</div>
              <div className="tnum font-medium" data-testid="employee-code">{x.employee_code}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[12px] text-ink-3">Role</div>
              <div className="truncate font-medium">{x.user.role_name}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[12px] text-ink-3">Reports to</div>
              <div className="truncate font-medium">{x.manager_name ?? '—'}</div>
            </div>
          </div>
        </div>
      </Card>
      {x.joining_letter_id && (
        <Callout tone="success" className="mb-4" title="Joining letter issued" action={<Button size="sm" onClick={() => nav(`/documents/issued/${x.joining_letter_id}`)}>Open letter</Button>}>
          {x.user.name} can read and acknowledge it under Documents → My documents.
        </Callout>
      )}
      {x.onboarding_workflow_id && (
        <Callout tone="success" className="mb-4" title="Onboarding workflow started" action={<Button size="sm" onClick={() => nav(`/workflows/run/${x.onboarding_workflow_id}`)}>Open workflow</Button>}>
          Each onboarding stage now waits in the right person’s workflow inbox.
        </Callout>
      )}
      <h2 className="mb-2 text-[14px] font-semibold">Login details</h2>
      <CredentialsCard email={x.login_email} password={x.temp_password} />
      {x.email ? (
        <>
          <h2 className="mb-2 mt-5 text-[14px] font-semibold">Welcome email sent to {x.email.to}</h2>
          <EmailPreview to={x.email.to} subject={x.email.subject} body={x.email.body} note="Email is simulated in this preview — this is exactly what they received." />
        </>
      ) : (
        <Callout tone="info" className="mt-4">No welcome email was sent. Share the login details yourself.</Callout>
      )}
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={() => nav('/people')}>Back to people</Button>
        <Button onClick={onAnother}>Create another</Button>
        <Button variant="primary" onClick={() => nav(`/people?focus=${x.user.id}`)}>Open profile</Button>
      </div>
    </div>
  )
}
