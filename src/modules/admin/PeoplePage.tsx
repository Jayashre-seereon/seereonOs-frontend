// People & users (v4): employees, their job record, role & extra permissions (maker-checked),
// security (password reset, deactivation) and invite links.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Copy, Download, KeyRound, Link2, MoreHorizontal, RefreshCw, ShieldCheck, Trash2, UserMinus, UserPlus, Users } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { adminApi, useInvites, type BulkResult, type BulkRowIn, type InviteRow } from '@/api/admin'
import { accessApi, EMPLOYMENT_TYPE_LABEL, PEOPLE_KEYS, useMasterData, useRoles, useUserRows, type JobPatch, type PasswordReset, type RoleRow, type UserRow } from '@/api/access'
import { changesApi, isPending } from '@/api/changes'
import { useSession } from '@/stores/session'
import { fmtDate, relTime } from '@/domain/calendar'
import { effectivePermissions } from '@/domain/permissionCatalog'
import {
  Avatar, Badge, Button, Callout, DataTable, Dialog, EmptyState, Field, FileUpload, IconButton, Input, KV, Menu, PageHeader, PeoplePicker, SearchInput, Select, Sheet, Tabs, Textarea, toast, useCan, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { cn, parseCSV, readFileAsText, saveFile, toCSV } from '@/lib/utils'
import { absoluteLink, copyText, errField } from './kit'
import { PermissionMatrix, type Origin } from '../access/PermissionMatrix'
import { CredentialsCard, EmailPreview, PendingBanner, RoleSummary, announceNamed } from '../access/kit'

type TabKey = 'all' | 'active' | 'invited' | 'deactivated'
const TABS: TabKey[] = ['all', 'active', 'invited', 'deactivated']

export default function PeoplePage() {
  const q = useUserRows()
  const inv = useInvites()
  const roles = useRoles()
  const c = useCan()
  const readOnly = useReadOnly()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as TabKey) ? params.get('tab') : 'active') as TabKey
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('')
  const [dept, setDept] = useState('')
  const [openId, setOpenId] = useState<string | null>(params.get('focus'))
  const [inviting, setInviting] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [lastInvite, setLastInvite] = useState<InviteRow | null>(null)

  useEffect(() => {
    const f = params.get('focus')
    if (f) setOpenId(f)
  }, [params])

  const all = q.data ?? []
  const pendingInvites = (inv.data ?? []).filter((i) => i.status !== 'accepted')
  const counts: Record<TabKey, number> = {
    all: all.length,
    active: all.filter((u) => u.status === 'active').length,
    invited: pendingInvites.length + all.filter((u) => u.status === 'invited').length,
    deactivated: all.filter((u) => u.status === 'deactivated').length,
  }
  const deptOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of all) if (u.department_id && u.department_name) m.set(u.department_id, u.department_name)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }))
  }, [all])
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return all.filter((u) => {
      if (tab === 'active' && u.status !== 'active') return false
      if (tab === 'deactivated' && u.status !== 'deactivated') return false
      if (tab === 'invited' && u.status !== 'invited') return false
      if (role && u.role_key !== role) return false
      if (dept && u.department_id !== dept) return false
      return !s || `${u.name} ${u.email} ${u.title} ${u.employee_code ?? ''} ${u.role_name}`.toLowerCase().includes(s)
    })
  }, [all, tab, role, dept, search])
  const open = all.find((u) => u.id === openId) ?? null

  const setTab = (t: TabKey) => {
    if (t === 'active') params.delete('tab')
    else params.set('tab', t)
    setParams(params, { replace: true })
  }
  const closeSheet = () => {
    setOpenId(null)
    if (params.get('focus')) {
      params.delete('focus')
      setParams(params, { replace: true })
    }
  }

  const cols: Column<UserRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (u) => u.name,
      cell: (u) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={u.name} hue={u.avatar_hue} size={28} />
          <span className="min-w-0">
            <span className="block max-w-[240px] truncate font-medium">{u.name}</span>
            <span className="block max-w-[240px] truncate text-[12px] text-ink-3">{u.email}</span>
          </span>
        </span>
      ),
    },
    { key: 'code', header: 'Code', sortValue: (u) => u.employee_code ?? '', cell: (u) => <span className="tnum whitespace-nowrap text-ink-2">{u.employee_code ?? '—'}</span>, hideBelow: 'xl' },
    { key: 'role', header: 'Role', sortValue: (u) => u.role_name, cell: (u) => <RoleCell u={u} /> },
    { key: 'dept', header: 'Department', sortValue: (u) => u.department_name ?? '', cell: (u) => <span className="block max-w-[160px] truncate text-ink-2">{u.department_name ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'desig', header: 'Designation', sortValue: (u) => u.designation_name ?? u.title, cell: (u) => <span className="block max-w-[180px] truncate text-ink-2">{u.designation_name ?? u.title ?? '—'}</span>, hideBelow: 'xl' },
    { key: 'mgr', header: 'Manager', sortValue: (u) => u.manager_name ?? '', cell: (u) => <span className="block max-w-[160px] truncate text-ink-2">{u.manager_name ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'status', header: 'Status', sortValue: (u) => u.status, cell: (u) => <StatusCell u={u} /> },
    { key: 'login', header: 'Last sign-in', align: 'right', sortValue: (u) => u.last_login_at ?? '', cell: (u) => <span className="tnum whitespace-nowrap text-[12.5px] text-ink-3">{u.last_login_at ? relTime(u.last_login_at) : 'Never'}</span>, hideBelow: 'md' },
  ]

  return (
    <div>
      <PageHeader
        title="People & users"
        subtitle="Everyone in the workspace, their role and reporting line. A role decides what someone sees and does."
        actions={
          c('employees.create') &&
          !readOnly && (
            <>
              <Menu
                label="More ways to add people"
                trigger={
                  <IconButton size="sm" label="More">
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                }
                items={[
                  { label: 'Invite by link', icon: <Link2 />, onSelect: () => setInviting(true) },
                  { label: 'Bulk invite (CSV)', icon: <Users />, onSelect: () => setBulk(true) },
                ]}
              />
              <Button size="sm" variant="primary" icon={<UserPlus className="size-3.5" />} onClick={() => nav('/people/new')}>
                Create employee
              </Button>
            </>
          )
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'all', label: 'All', count: counts.all },
        { value: 'active', label: 'Active', count: counts.active },
        { value: 'invited', label: 'Invited', count: counts.invited },
        { value: 'deactivated', label: 'Deactivated', count: counts.deactivated },
      ]} />

      {tab !== 'invited' && (
        <div className="mb-3 grid gap-2.5 sm:grid-cols-2 lg:flex lg:items-center">
          <SearchInput value={search} onChange={setSearch} placeholder="Search name, email, code" className="sm:col-span-2 lg:w-[280px] lg:shrink-0" />
          <Select aria-label="Filter by role" value={role} onChange={(e) => setRole(e.target.value)} placeholder="All roles" options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.name }))} className="lg:w-[200px]" />
          <Select aria-label="Filter by department" value={dept} onChange={(e) => setDept(e.target.value)} placeholder="All departments" options={deptOptions} className="lg:w-[200px]" />
          {(role || dept || search) && (
            <button type="button" className="justify-self-start text-[13px] font-medium text-brand-text hover:underline lg:ml-1" onClick={() => { setRole(''); setDept(''); setSearch('') }}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {tab === 'invited' ? (
        <InviteList list={pendingInvites} loading={inv.isLoading} readOnly={readOnly || !c('employees.create')} onInvite={() => setInviting(true)} onResent={setLastInvite} />
      ) : (
        <DataTable
          rows={rows}
          columns={cols}
          rowKey={(u) => u.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          onRowClick={(u) => setOpenId(u.id)}
          initialSort={{ key: 'name', dir: 'asc' }}
          rowClassName={(u) => (u.status === 'deactivated' ? 'opacity-60' : undefined)}
          empty={
            <EmptyState
              compact
              icon={<Users />}
              title={search || role || dept ? 'No one matches' : tab === 'deactivated' ? 'Nobody is deactivated' : 'No people yet'}
              body={search || role || dept ? 'Try another search or clear the filters.' : undefined}
              action={!search && !role && !dept && tab !== 'deactivated' && c('employees.create') && !readOnly && <Button variant="primary" onClick={() => nav('/people/new')}>Create employee</Button>}
            />
          }
          mobileCard={(u) => (
            <div className="flex items-start gap-3">
              <Avatar name={u.name} hue={u.avatar_hue} size={36} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[14px] font-semibold">{u.name}</span>
                  {u.employee_code && <span className="tnum shrink-0 text-[12px] text-ink-3">{u.employee_code}</span>}
                </div>
                <div className="truncate text-[12.5px] text-ink-3">{u.designation_name ?? u.title ?? u.email}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Badge size="sm" tone="neutral">{u.role_name}</Badge>
                  <StatusCell u={u} compact />
                  <span className="min-w-0 truncate text-[12px] text-ink-3">{u.manager_name ? `Reports to ${u.manager_name}` : 'No manager'}</span>
                </div>
              </div>
            </div>
          )}
        />
      )}

      {open && <PersonSheet key={open.id} user={open} roles={roles.data ?? []} onClose={closeSheet} readOnly={readOnly} />}
      {inviting && (
        <InviteDialog
          roles={roles.data ?? []}
          onClose={() => setInviting(false)}
          onDone={(i) => {
            setInviting(false)
            setLastInvite(i)
            setTab('invited')
          }}
        />
      )}
      {bulk && <BulkInvite onClose={() => setBulk(false)} />}
      {lastInvite && <InviteLinkDialog invite={lastInvite} onClose={() => setLastInvite(null)} />}
    </div>
  )
}

function RoleCell({ u }: { u: UserRow }) {
  const n = u.extra_permissions.length
  return (
    <span className="inline-flex max-w-[200px] items-center gap-1.5">
      <span className="min-w-0 truncate text-ink">{u.role_name}</span>
      {n > 0 && <Badge tone="brand" size="sm">+{n}</Badge>}
    </span>
  )
}
function StatusCell({ u, compact }: { u: UserRow; compact?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {u.status === 'deactivated' ? (
        <Badge size="sm">Deactivated</Badge>
      ) : u.status === 'invited' ? (
        <Badge tone="info" size="sm">Invited</Badge>
      ) : u.must_change_password ? (
        <Badge tone="info" size="sm">Awaiting first sign-in</Badge>
      ) : compact ? null : (
        <Badge tone="success" size="sm">Active</Badge>
      )}
      {(u.pending_access || u.pending_employee) && <Badge tone="warning" size="sm">Pending approval</Badge>}
      {!compact && u.two_factor && <ShieldCheck className="size-3.5 text-success-text" aria-label="Two-step on" />}
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Person sheet                                                          */
/* ------------------------------------------------------------------ */
type SheetTab = 'profile' | 'access' | 'security'
const INV = PEOPLE_KEYS

function jobOf(u: UserRow) {
  return {
    name: u.name, phone: u.phone ?? '', personal_email: u.personal_email ?? '', joined_on: u.joined_on, employment_type: u.employment_type ?? '',
    department_id: u.department_id ?? '', designation_id: u.designation_id ?? '', grade_id: u.grade_id ?? '', location_id: u.location_id ?? '', shift_id: u.shift_id ?? '', cost_centre_id: u.cost_centre_id ?? '',
    reports_to_id: u.reports_to_id,
  }
}
type Job = ReturnType<typeof jobOf>

function PersonSheet({ user, roles, onClose, readOnly }: { user: UserRow; roles: RoleRow[]; onClose: () => void; readOnly: boolean }) {
  const c = useCan()
  const [tab, setTab] = useState<SheetTab>('profile')
  const me = useSession((s) => s.user)
  const deactivated = user.status === 'deactivated'
  const canEditJob = c('employees.edit') && !readOnly && !deactivated
  const canEditAccess = c('users.manage') && !readOnly && !deactivated && !user.pending_access
  const mc = useApi(['mc-config'], changesApi.config, { staleTime: 60_000 })
  const accessChecked = !!mc.data?.enabled && (mc.data.entities ?? []).includes('user_access')

  // profile & job
  const init = useMemo(() => jobOf(user), [user])
  const [job, setJob] = useState<Job>(init)
  useEffect(() => setJob(init), [init])
  const jobPatch: JobPatch = {}
  for (const k of Object.keys(job) as (keyof Job)[]) {
    if (job[k] !== init[k]) (jobPatch as Record<string, unknown>)[k] = job[k] === '' ? null : job[k]
  }
  const jobDirty = Object.keys(jobPatch).length > 0
  const saveJob = useMut(() => accessApi.patchUser(user.id, jobPatch, user.version), { invalidate: INV, success: `${user.name} updated` })

  // access
  const roleOf = (key: string) => roles.find((r) => r.key === key)
  const [roleKey, setRoleKey] = useState(user.role_key)
  const [eff, setEff] = useState<string[]>(user.permissions)
  useEffect(() => {
    setRoleKey(user.role_key)
    setEff(user.permissions)
  }, [user])
  const rolePerms = roleOf(roleKey)?.permissions ?? user.role_permissions
  const roleSet = new Set(rolePerms)
  const effSet = new Set(eff)
  const extra = eff.filter((k) => !roleSet.has(k))
  const revoked = rolePerms.filter((k) => !effSet.has(k))
  const accessDirty = roleKey !== user.role_key || JSON.stringify([...extra].sort()) !== JSON.stringify([...user.extra_permissions].sort()) || JSON.stringify([...revoked].sort()) !== JSON.stringify([...user.revoked_permissions].sort())
  const origin = (k: string): Origin => (roleSet.has(k) ? (effSet.has(k) ? 'role' : 'removed') : effSet.has(k) ? 'extra' : null)
  const changeRole = (key: string) => {
    const r = roleOf(key)
    setRoleKey(key)
    if (r) setEff(effectivePermissions(r.permissions, extra.filter((k) => !r.permissions.includes(k)), []))
  }
  const saveAccess = useMut(() => accessApi.patchUser(user.id, { role_key: roleKey, extra_permissions: extra, revoked_permissions: revoked }), {
    invalidate: INV,
    onSuccess: (r) => {
      if (r.access) announceNamed(r.access, 'Access updated')
      if (r.access && isPending(r.access)) {
        setRoleKey(user.role_key)
        setEff(user.permissions)
      }
    },
  })

  const footer =
    tab === 'profile' && canEditJob ? (
      <>
        <Button onClick={() => setJob(init)} disabled={!jobDirty}>Reset</Button>
        <Button variant="primary" loading={saveJob.isPending} disabled={!jobDirty} onClick={() => saveJob.mutate(undefined)}>
          Save changes
        </Button>
      </>
    ) : tab === 'access' && canEditAccess ? (
      <>
        <Button onClick={() => { setRoleKey(user.role_key); setEff(user.permissions) }} disabled={!accessDirty}>Reset</Button>
        <Button variant="primary" loading={saveAccess.isPending} disabled={!accessDirty} onClick={() => saveAccess.mutate(undefined)}>
          {accessChecked ? 'Send for approval' : 'Save access'}
        </Button>
      </>
    ) : undefined

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      width={720}
      title={
        <span className="flex items-center gap-3">
          <Avatar name={user.name} hue={user.avatar_hue} size={40} />
          <span className="min-w-0">
            <span className="block truncate">{user.name}</span>
            <span className="block truncate text-[13px] font-normal text-ink-3">
              {[user.employee_code, user.designation_name ?? user.title, user.role_name].filter(Boolean).join(' · ')}
            </span>
          </span>
        </span>
      }
      footer={footer}
    >
      <Tabs value={tab} onChange={setTab} className="mx-0! px-0!" tabs={[
        { value: 'profile', label: 'Profile & job' },
        { value: 'access', label: 'Access' },
        { value: 'security', label: 'Security' },
      ]} />
      {deactivated && <Callout tone="neutral" className="mb-4">Deactivated people can’t sign in and don’t use a seat. Reactivate under Security to edit.</Callout>}
      {user.pending_employee && <PendingBanner pending={user.pending_employee} what="Deactivation" />}
      {tab === 'profile' && <ProfileTab user={user} job={job} setJob={setJob} editable={canEditJob} error={saveJob.error} />}
      {tab === 'access' && (
        <div className="space-y-4">
          {user.pending_access && <PendingBanner pending={user.pending_access} what="An access change" />}
          {saveAccess.error && !saveAccess.error.field && <Callout tone="danger">{saveAccess.error.message}</Callout>}
          {!c('users.manage') && <Callout tone="neutral">You can see this person’s access. Changing it needs “Manage user access”.</Callout>}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Role" htmlFor="p-role" error={errField(saveAccess.error, 'role_key')} hint={accessChecked && canEditAccess ? 'Role and permission changes need a second person to approve.' : undefined}>
              <Select id="p-role" value={roleKey} disabled={!canEditAccess} onChange={(e) => changeRole(e.target.value)} options={roles.filter((r) => r.active || r.key === user.role_key).map((r) => ({ value: r.key, label: r.name }))} />
            </Field>
            <div className="rounded-lg border border-line bg-surface-2/50 px-4 py-3 text-[13px]">
              <div className="tnum flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
                <span>Role gives <b className="font-semibold text-ink">{rolePerms.length}</b></span>
                <span>Extra <b className="font-semibold text-ink">{extra.length}</b></span>
                <span>Removed <b className="font-semibold text-ink">{revoked.length}</b></span>
              </div>
              <div className="mt-1 text-ink-3">
                <b className="tnum font-semibold text-ink">{eff.length}</b> effective permissions
              </div>
            </div>
          </div>
          <PermissionMatrix value={eff} onChange={canEditAccess ? setEff : undefined} disabled={!canEditAccess} origin={origin} compact />
        </div>
      )}
      {tab === 'security' && <SecurityTab user={user} isSelf={me?.id === user.id} readOnly={readOnly} onClose={onClose} />}
    </Sheet>
  )
}

function ProfileTab({ user, job, setJob, editable, error }: { user: UserRow; job: Job; setJob: (j: Job) => void; editable: boolean; error: unknown }) {
  const md = useMasterData()
  const opts = <T extends { id: string; name: string; active: boolean }>(list: T[] | undefined, cur: string, label?: (x: T) => string) =>
    (list ?? []).filter((x) => x.active || x.id === cur).map((x) => ({ value: x.id, label: label ? label(x) : x.name }))
  const f = (k: keyof Job) => ({ value: (job[k] as string) ?? '', disabled: !editable, onChange: (e: { target: { value: string } }) => setJob({ ...job, [k]: e.target.value }) })
  const e = error as { field?: string; message?: string } | null
  return (
    <div className="space-y-5">
      {e && !e.field && <Callout tone="danger">{e.message}</Callout>}
      <section>
        <h3 className="mb-2.5 text-[13px] font-semibold text-ink-2">Personal</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" htmlFor="pj-name" error={errField(e, 'name')}>
            <Input id="pj-name" {...f('name')} invalid={!!errField(e, 'name')} />
          </Field>
          <Field label="Work email" htmlFor="pj-email" hint="Their login. Can’t be changed.">
            <Input id="pj-email" value={user.email} disabled />
          </Field>
          <Field label="Phone" htmlFor="pj-phone" error={errField(e, 'phone')}>
            <Input id="pj-phone" type="tel" {...f('phone')} invalid={!!errField(e, 'phone')} />
          </Field>
          <Field label="Personal email" htmlFor="pj-pe" error={errField(e, 'personal_email')}>
            <Input id="pj-pe" type="email" {...f('personal_email')} invalid={!!errField(e, 'personal_email')} />
          </Field>
        </div>
      </section>
      <section>
        <h3 className="mb-2.5 text-[13px] font-semibold text-ink-2">Job</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Department" htmlFor="pj-dept" error={errField(e, 'department_id')}>
            <Select id="pj-dept" {...f('department_id')} placeholder="None" options={opts(md.departments.data, job.department_id)} />
          </Field>
          <Field label="Designation" htmlFor="pj-desig" error={errField(e, 'designation_id')}>
            <Select id="pj-desig" {...f('designation_id')} placeholder="None" options={opts(md.designations.data, job.designation_id)} />
          </Field>
          <Field label="Grade" htmlFor="pj-grade" error={errField(e, 'grade_id')}>
            <Select id="pj-grade" {...f('grade_id')} placeholder="None" options={opts(md.grades.data, job.grade_id, (g) => `${g.code} · ${g.name}`)} />
          </Field>
          <Field label="Location" htmlFor="pj-loc" error={errField(e, 'location_id')}>
            <Select id="pj-loc" {...f('location_id')} placeholder="None" options={opts(md.locations.data, job.location_id)} />
          </Field>
          <Field label="Shift" htmlFor="pj-shift" error={errField(e, 'shift_id')}>
            <Select id="pj-shift" {...f('shift_id')} placeholder="None" options={opts(md.shifts.data, job.shift_id, (s) => `${s.name} · ${s.start_time}–${s.end_time}`)} />
          </Field>
          <Field label="Cost centre" htmlFor="pj-cc" error={errField(e, 'cost_centre_id')}>
            <Select id="pj-cc" {...f('cost_centre_id')} placeholder="None" options={opts(md.costCentres.data, job.cost_centre_id, (x) => `${x.code} · ${x.name}`)} />
          </Field>
          <Field label="Employment type" htmlFor="pj-et" error={errField(e, 'employment_type')}>
            <Select id="pj-et" {...f('employment_type')} placeholder="Not set" options={Object.entries(EMPLOYMENT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Field>
          <Field label="Joining date" htmlFor="pj-join" error={errField(e, 'joined_on')}>
            <Input id="pj-join" type="date" {...f('joined_on')} invalid={!!errField(e, 'joined_on')} />
          </Field>
          <Field label="Reports to" htmlFor="pj-mgr" className="sm:col-span-2" hint="Approves their leave, timesheets and expenses (first step)." error={errField(e, 'reports_to_id')}>
            {editable ? (
              <PeoplePicker id="pj-mgr" value={job.reports_to_id} onChange={(v) => setJob({ ...job, reports_to_id: v })} filter={(p) => p.id !== user.id && p.status === 'active'} clearable placeholder="No manager (top of the organisation)" invalid={!!errField(e, 'reports_to_id')} />
            ) : (
              <Input id="pj-mgr" value={user.manager_name ?? 'No manager'} disabled />
            )}
          </Field>
        </div>
      </section>
    </div>
  )
}

function SecurityTab({ user, isSelf, readOnly, onClose }: { user: UserRow; isSelf: boolean; readOnly: boolean; onClose: () => void }) {
  const c = useCan()
  const { confirm } = useConfirm()
  const [reset, setReset] = useState<PasswordReset | null>(null)
  const resetPw = useMut(() => accessApi.resetPassword(user.id), { invalidate: INV, success: `Password reset for ${user.name}`, onSuccess: setReset })
  const deact = useMut(() => accessApi.deactivate(user.id), {
    invalidate: INV,
    onSuccess: (r) => {
      announceNamed(r, `${user.name} deactivated`)
      if (!isPending(r)) onClose()
    },
  })
  const react = useMut(() => accessApi.reactivate(user.id), { invalidate: INV, success: `${user.name} reactivated` })
  const reset2fa = useMut(() => accessApi.resetTwoFactor(user.id), { invalidate: INV, success: `Two-step verification reset for ${user.name}` })
  const deactivated = user.status === 'deactivated'
  return (
    <div className="space-y-5">
      <KV
        cols={2}
        items={[
          { label: 'Last sign-in', value: user.last_login_at ? relTime(user.last_login_at) : 'Never' },
          { label: 'Password', value: user.must_change_password ? 'Temporary — must change at sign-in' : 'Set by them' },
          { label: 'Two-step verification', value: user.two_factor ? 'On' : 'Off' },
          { label: 'Joined', value: fmtDate(user.joined_on, 'long') },
          { label: 'Direct reports', value: String(user.direct_reports) },
          { label: 'Employment', value: user.employment_type ? EMPLOYMENT_TYPE_LABEL[user.employment_type] : '—' },
        ]}
      />
      {c('users.manage') && !deactivated && !isSelf && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Reset password</div>
            <div className="text-[12.5px] text-ink-3">Signs them out everywhere and emails a new temporary password.</div>
          </div>
          <Button
            size="sm"
            icon={<KeyRound className="size-3.5" />}
            loading={resetPw.isPending}
            disabled={readOnly}
            onClick={async () => (await confirm({ title: `Reset ${user.name}’s password?`, body: 'Their current password stops working and they are signed out. They get a temporary password by email.', confirmLabel: 'Reset password' })) && resetPw.mutate(undefined)}
          >
            Reset password
          </Button>
        </div>
      )}
      {c('users.manage') && !deactivated && !isSelf && user.two_factor && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">Reset two-step verification</div>
            <div className="text-[12.5px] text-ink-3">For a lost phone without recovery codes. Signs them out; they sign in with their password and set it up again.</div>
          </div>
          <Button
            size="sm"
            loading={reset2fa.isPending}
            disabled={readOnly}
            onClick={async () => (await confirm({ title: `Reset ${user.name}’s two-step verification?`, body: 'Their authenticator app and recovery codes stop working and they are signed out everywhere. Only do this after confirming who they are.', confirmLabel: 'Reset two-step', tone: 'danger' })) && reset2fa.mutate(undefined)}
          >
            Reset two-step
          </Button>
        </div>
      )}
      {c('employees.deactivate') && !isSelf && (
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium">{deactivated ? 'Reactivate' : 'Deactivate'}</div>
            <div className="text-[12.5px] text-ink-3">{deactivated ? 'They can sign in again with their old password.' : 'They are signed out and can’t sign in. Their history stays.'}</div>
          </div>
          {deactivated ? (
            <Button size="sm" loading={react.isPending} disabled={readOnly} onClick={() => react.mutate(undefined)}>
              Reactivate
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline-danger"
              icon={<UserMinus className="size-3.5" />}
              loading={deact.isPending}
              disabled={readOnly || !!user.pending_employee}
              onClick={async () => {
                const ok = await confirm({
                  title: `Deactivate ${user.name}?`,
                  body: (
                    <>
                      They are signed out and can’t sign in. Their hours, tasks and history stay.
                      {user.direct_reports > 0 && <b className="mt-2 block font-medium text-warning-text">{user.direct_reports} {user.direct_reports === 1 ? 'person reports' : 'people report'} to them — assign a new manager afterwards.</b>}
                    </>
                  ),
                  confirmLabel: 'Deactivate',
                  tone: 'danger',
                })
                if (ok) deact.mutate(undefined)
              }}
            >
              Deactivate
            </Button>
          )}
        </div>
      )}
      {isSelf && <p className="text-[12.5px] text-ink-3">Change your own password and two-step verification under Settings → Security.</p>}
      {reset && (
        <Dialog open onOpenChange={(o) => !o && setReset(null)} size="lg" title="Password reset" description={reset.email ? `We emailed ${reset.login_email}. Email is simulated in this preview, so here is what they received.` : 'Share these details with them.'} footer={<Button variant="primary" onClick={() => setReset(null)}>Done</Button>}>
          <div className="space-y-4">
            <CredentialsCard email={reset.login_email} password={reset.temp_password} />
            {reset.email && <EmailPreview to={reset.email.to} subject={reset.email.subject} body={reset.email.body} />}
          </div>
        </Dialog>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Invites                                                               */
/* ------------------------------------------------------------------ */
function InviteList({ list, loading, readOnly, onInvite, onResent }: { list: InviteRow[]; loading: boolean; readOnly: boolean; onInvite: () => void; onResent: (i: InviteRow) => void }) {
  const { confirm } = useConfirm()
  const nav = useNavigate()
  const resend = useMut((id: string) => adminApi.resendInvite(id), { invalidate: [['invites']], success: 'New invite link created', onSuccess: onResent })
  const revoke = useMut((i: InviteRow) => adminApi.revokeInvite(i.id), { invalidate: [['invites'], ['onboarding']], success: (_, i) => `Invite for ${i.email} revoked` })
  if (loading) return <div className="skeleton h-16 rounded-lg" />
  if (!list.length)
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          compact
          icon={<Link2 />}
          title="No pending invites"
          body="Create employee is the usual way in — it sets up the account and emails login details. Invite links let people pick their own password."
          action={!readOnly && (
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={onInvite}>Invite by link</Button>
              <Button variant="primary" onClick={() => nav('/people/new')}>Create employee</Button>
            </div>
          )}
        />
      </div>
    )
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {list.map((i) => (
        <div key={i.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[13.5px] font-medium">{i.name}</span>
              <Badge size="sm">{i.role_name}</Badge>
              {i.status === 'expired' ? <Badge tone="warning" size="sm">Expired</Badge> : <Badge tone="info" size="sm">Pending</Badge>}
            </div>
            <div className="truncate text-[12.5px] text-ink-3">
              {i.email} · {i.status === 'expired' ? 'expired' : 'expires'} {fmtDate(i.expires_at.slice(0, 10))}
            </div>
          </div>
          {!readOnly && (
            <Menu
              label={`Actions for ${i.email}`}
              trigger={
                <IconButton size="sm" label="More">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
              items={[
                ...(i.status === 'pending' ? [{ label: 'Copy invite link', icon: <Copy />, onSelect: async () => ((await copyText(absoluteLink(i.link))) ? toast.success('Invite link copied') : onResent(i)) }] : []),
                { label: 'Resend (new link, 7 days)', icon: <RefreshCw />, onSelect: () => resend.mutate(i.id) },
                { separator: true, label: '' },
                { label: 'Revoke invite', icon: <Trash2 />, danger: true, onSelect: async () => (await confirm({ title: `Revoke invite for ${i.name}?`, body: 'The link stops working immediately.', confirmLabel: 'Revoke', tone: 'danger' })) && revoke.mutate(i) },
              ]}
            />
          )}
        </div>
      ))}
    </div>
  )
}

function InviteDialog({ roles, onClose, onDone }: { roles: RoleRow[]; onClose: () => void; onDone: (i: InviteRow) => void }) {
  const me = useSession((s) => s.user)
  const [f, setF] = useState<{ name: string; email: string; role_key: string; reports_to_id: string | null }>({ name: '', email: '', role_key: 'employee', reports_to_id: me?.id ?? null })
  const m = useMut(() => adminApi.invite({ ...f, name: f.name.trim(), email: f.email.trim() }), { invalidate: [['invites'], ['onboarding']], success: `Invite created for ${f.email.trim()}`, onSuccess: onDone })
  const e = m.error
  const role = roles.find((r) => r.key === f.role_key)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Invite by link"
      description="They get a link to set their own name and password. The link works for 7 days."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={!f.name.trim() || !f.email.trim()} onClick={() => m.mutate(undefined)}>
            Create invite
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {e && !e.field && <Callout tone="danger">{e.message}</Callout>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="i-name" required error={errField(e, 'name')}>
            <Input id="i-name" autoFocus value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} invalid={!!errField(e, 'name')} />
          </Field>
          <Field label="Work email" htmlFor="i-email" required error={errField(e, 'email')}>
            <Input id="i-email" type="email" inputMode="email" autoCapitalize="none" value={f.email} onChange={(ev) => setF({ ...f, email: ev.target.value })} invalid={!!errField(e, 'email')} />
          </Field>
          <Field label="Role" htmlFor="i-role" error={errField(e, 'role_key')}>
            <Select id="i-role" value={f.role_key} onChange={(ev) => setF({ ...f, role_key: ev.target.value })} options={roles.filter((r) => r.active).map((r) => ({ value: r.key, label: r.name }))} />
          </Field>
          <Field label="Reports to" htmlFor="i-mgr" error={errField(e, 'reports_to_id')}>
            <PeoplePicker id="i-mgr" value={f.reports_to_id} onChange={(v) => setF({ ...f, reports_to_id: v })} filter={(p) => p.status === 'active'} clearable placeholder="No manager" />
          </Field>
        </div>
        {role && <RoleSummary role={role} />}
      </div>
    </Dialog>
  )
}

function InviteLinkDialog({ invite, onClose }: { invite: InviteRow; onClose: () => void }) {
  const url = absoluteLink(invite.link)
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Invite ready"
      description={`Email delivery is simulated in this preview. Share this link with ${invite.name}.`}
      footer={
        <>
          <Button onClick={onClose}>Done</Button>
          <Button variant="primary" icon={<Copy className="size-4" />} onClick={async () => ((await copyText(url)) ? toast.success('Invite link copied') : toast.error('Copy failed — select the link and copy it.'))}>
            Copy link
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 p-3">
        <Link2 className="size-4 shrink-0 text-ink-3" />
        <code className="min-w-0 flex-1 select-all break-all font-mono text-[12.5px]">{url}</code>
      </div>
      <p className="mt-3 text-[12.5px] text-ink-3">
        {invite.role_name} · {invite.email} · expires {fmtDate(invite.expires_at.slice(0, 10), 'long')}
      </p>
    </Dialog>
  )
}

function BulkInvite({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [preview, setPreview] = useState<BulkResult | null>(null)
  const parsed: BulkRowIn[] = useMemo(() => {
    const rows = parseCSV(text.trim())
    const body = rows.length && /name/i.test(rows[0][0] ?? '') && /email/i.test(rows[0][1] ?? '') ? rows.slice(1) : rows
    return body.map((r) => ({ name: (r[0] ?? '').trim(), email: (r[1] ?? '').trim(), role: (r[2] ?? '').trim() || 'Employee', reports_to_email: (r[3] ?? '').trim() }))
  }, [text])
  const pre = useMut(() => adminApi.bulkInvite(parsed, 'preview'), { onSuccess: setPreview })
  const commit = useMut(() => adminApi.bulkInvite(parsed, 'commit'), { invalidate: [['invites'], ['onboarding']], success: (r) => `${r.rows.length} invites created`, onSuccess: onClose })
  const roles = useRoles()
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Bulk invite"
      description="One person per row: name, email, role, reports_to_email. Nothing is sent until every row is valid."
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)}>Back</Button>
            <Button variant="primary" disabled={preview.invalid > 0} loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
              Invite {preview.valid} {preview.valid === 1 ? 'person' : 'people'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" icon={<Download className="size-4" />} onClick={() => saveFile('invite-template.csv', toCSV([['name', 'email', 'role', 'reports_to_email'], ['Ritu Das', 'ritu@company.com', 'Employee', 'manager@company.com'], ['Amit Sahu', 'amit@company.com', 'Sales Executive', '']]), 'text/csv')}>
              Template
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!parsed.length} loading={pre.isPending} onClick={() => pre.mutate(undefined)}>
              Check {parsed.length || ''} row{parsed.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="space-y-4">
          <FileUpload
            accept=".csv,text/csv,text/plain"
            label="Drop a CSV or browse"
            hint="CSV · up to 1 MB · max 200 rows"
            maxMb={1}
            file={file}
            onClear={() => {
              setFile(null)
              setText('')
            }}
            onFile={async (f) => {
              setFile({ name: f.name, size: f.size })
              setText(await readFileAsText(f))
            }}
          />
          <Field label="…or paste rows" htmlFor="bulk">
            <Textarea id="bulk" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'name,email,role,reports_to_email\nRitu Das,ritu@company.com,Employee,subhankar@seereon.co.in'} className="font-mono text-[13px]" />
          </Field>
          <p className="text-[12.5px] text-ink-3">Roles: {(roles.data ?? []).filter((r) => r.active).map((r) => r.name).join(', ')}. Leave reports_to_email empty for no manager.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {preview.invalid > 0 ? (
            <Callout tone="danger" title={`${preview.invalid} of ${preview.rows.length} rows need fixing`}>Go back, fix those rows and check again. Nothing has been sent.</Callout>
          ) : (
            <Callout tone="success" title="All rows look good">{preview.valid} invites will be created with 7-day links.</Callout>
          )}
          <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
            <table className="w-full min-w-[560px] text-[13px]">
              <thead className="bg-surface-2 text-left text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Email</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className={cn('border-t border-line align-top', r.errors.length && 'bg-danger-soft/50')}>
                    <td className="tnum px-3 py-2 text-ink-3">{r.line}</td>
                    <td className="px-3 py-2 font-medium">{r.name || <span className="text-ink-3">—</span>}</td>
                    <td className="px-3 py-2">{r.email}</td>
                    <td className="px-3 py-2">{r.role_name}</td>
                    <td className="px-3 py-2">{r.errors.length ? <span className="font-medium text-danger-text">{r.errors.join('; ')}</span> : <span className="text-success-text">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  )
}
