import { useMemo, useState } from 'react'
import { Building2, CalendarPlus, History, MoreHorizontal, PauseCircle, PlayCircle } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, usePlatformAudit, usePlatformTenants, type TenantAdminRow } from '@/api/admin'
import { useSession } from '@/stores/session'
import { fmtDate, fmtDateTime, relTime } from '@/domain/calendar'
import { fmtMoney, fmtMoneyCompact } from '@/domain/money'
import type { TenantStatus } from '@/types/entities'
import type { Tone } from '@/domain/labels'
import { Badge, Button, Callout, DataTable, Dialog, EmptyState, ErrorState, Field, FilterChips, IconButton, Menu, PageHeader, SearchInput, SkeletonCards, SkeletonRows, StatCard, Tabs, TenantMark, Textarea, useConfirm, type Column } from '@/ui'
import { errField } from './kit'

const STATUS: Record<TenantStatus, { label: string; tone: Tone }> = {
  trial: { label: 'Trial', tone: 'brand' },
  active: { label: 'Active', tone: 'success' },
  read_only: { label: 'Read-only', tone: 'warning' },
  suspended: { label: 'Suspended', tone: 'danger' },
}
const INDUSTRY: Record<string, string> = { it_services: 'IT services', sap_consulting: 'SAP consulting', product: 'Product', other: 'Other' }

export default function SuperAdminPage() {
  const { user } = useSession()
  const [tab, setTab] = useState<'tenants' | 'audit'>('tenants')
  if (!user?.is_super_admin) return <ErrorState error={{ code: 'FORBIDDEN', message: 'Platform administrators only.' }} />
  return (
    <div>
      <PageHeader title="Tenants" subtitle="Manage workspaces and trials. Tenant business data is never shown here." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'tenants', label: 'Tenants' }, { value: 'audit', label: 'Audit log' }]} />
      {tab === 'tenants' ? <TenantsView /> : <AuditView />}
    </div>
  )
}

function TenantsView() {
  const q = usePlatformTenants()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | TenantStatus>('all')
  const [extend, setExtend] = useState<TenantAdminRow | null>(null)
  const { askReason } = useConfirm()
  const inv = [['admin-tenants'], ['admin-audit']]
  const suspend = useMut(({ id, reason }: { id: string; reason: string }) => adminApi.suspend(id, reason), { invalidate: inv, success: (t) => `${t.name} suspended` })
  const reactivate = useMut(({ id, reason }: { id: string; reason: string }) => adminApi.reactivateTenant(id, reason), { invalidate: inv, success: (t) => `${t.name} reactivated (${STATUS[t.status].label.toLowerCase()})` })

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (q.data?.tenants ?? []).filter((t) => (status === 'all' || t.status === status) && (!s || `${t.name} ${t.slug}`.toLowerCase().includes(s)))
  }, [q.data, search, status])

  const actions = (t: TenantAdminRow) => (
    <Menu
      label={`Actions for ${t.name}`}
      trigger={
        <IconButton size="sm" label="Actions" onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal className="size-4" />
        </IconButton>
      }
      items={[
        { label: 'Extend trial', icon: <CalendarPlus />, disabled: t.status === 'active' || t.status === 'suspended', onSelect: () => setExtend(t) },
        t.status === 'suspended' || t.status === 'read_only'
          ? {
              label: 'Reactivate',
              icon: <PlayCircle />,
              onSelect: async () => {
                const r = await askReason({ title: `Reactivate ${t.name}?`, body: t.plan_code === 'trial' ? 'The tenant goes back to trial (at least 7 days).' : 'The tenant returns to its paid plan.', label: 'Reason (audit log)', confirmLabel: 'Reactivate' })
                if (r) reactivate.mutate({ id: t.id, reason: r })
              },
            }
          : {
              label: 'Suspend',
              icon: <PauseCircle />,
              danger: true,
              onSelect: async () => {
                const r = await askReason({ title: `Suspend ${t.name}?`, body: `All ${t.users_active} users are signed out and can’t sign in until reactivated. Data is kept.`, label: 'Reason (audit log)', placeholder: 'e.g. Abuse report #1432, non-payment after 30 days', confirmLabel: 'Suspend', tone: 'danger' })
                if (r) suspend.mutate({ id: t.id, reason: r })
              },
            },
      ]}
    />
  )

  const cols: Column<TenantAdminRow>[] = [
    {
      key: 'name',
      header: 'Tenant',
      sortValue: (t) => t.name,
      cell: (t) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <TenantMark name={t.name} size={28} />
          <span className="min-w-0">
            <span className="block truncate font-medium">{t.name}</span>
            <span className="block truncate text-[12px] text-ink-3">{t.slug} · {INDUSTRY[t.industry] ?? t.industry}</span>
          </span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (t) => t.status, cell: (t) => <Badge tone={STATUS[t.status].tone} size="sm">{STATUS[t.status].label}</Badge> },
    { key: 'plan', header: 'Plan', sortValue: (t) => t.plan_name, cell: (t) => <span className="text-ink-2">{t.plan_name}</span> },
    { key: 'seats', header: 'Users / seats', align: 'right', sortValue: (t) => t.users_active, cell: (t) => <span className="tnum">{t.users_active}<span className="text-ink-3"> / {t.seats}</span></span> },
    { key: 'mrr', header: 'MRR', align: 'right', sortValue: (t) => t.mrr_paise, cell: (t) => <span className="tnum">{t.mrr_paise ? fmtMoney(t.mrr_paise) : <span className="text-ink-3">—</span>}</span>, hideBelow: 'lg' },
    { key: 'trial', header: 'Trial ends', sortValue: (t) => t.trial_ends_on ?? '9999', cell: (t) => (t.trial_ends_on ? <span className={t.trial_days_left !== null && t.trial_days_left < 0 ? 'text-danger-text' : t.trial_days_left !== null && t.trial_days_left <= 3 ? 'text-warning-text' : 'text-ink-2'}>{fmtDate(t.trial_ends_on)}{t.trial_days_left !== null && <span className="ml-1 text-[12px] text-ink-3">({t.trial_days_left < 0 ? `${-t.trial_days_left}d ago` : `${t.trial_days_left}d`})</span>}</span> : <span className="text-ink-3">—</span>) },
    { key: 'created', header: 'Created', sortValue: (t) => t.created_at, cell: (t) => <span className="tnum text-ink-2">{fmtDate(t.created_at.slice(0, 10))}</span>, hideBelow: 'xl' },
    { key: 'act', header: '', align: 'right', cell: (t) => <span onClick={(e) => e.stopPropagation()}>{actions(t)}</span>, width: '48px' },
  ]

  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const k = q.data?.kpis
  return (
    <>
      {!k ? (
        <SkeletonCards n={4} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Tenants" value={k.total} sub={`${k.active} paying · ${k.trial} on trial`} />
          <StatCard label="MRR (excl. GST)" value={fmtMoneyCompact(k.mrr_paise)} sub={`${k.seats_paid} paid seats`} />
          <StatCard label="Trials ending ≤ 7 days" value={k.trials_ending_7d} sub="follow up to convert" tone={k.trials_ending_7d ? 'warning' : undefined} />
          <StatCard label="Read-only / suspended" value={`${k.read_only} / ${k.suspended}`} sub="need attention" tone={k.read_only + k.suspended ? 'danger' : undefined} />
        </div>
      )}
      <div className="mb-3 mt-6 flex flex-col gap-3 md:flex-row md:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search tenants" className="md:w-[280px]" />
        <FilterChips
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All', count: k?.total },
            { value: 'trial', label: 'Trial', count: k?.trial },
            { value: 'active', label: 'Active', count: k?.active },
            { value: 'read_only', label: 'Read-only', count: k?.read_only },
            { value: 'suspended', label: 'Suspended', count: k?.suspended },
          ]}
        />
      </div>
      <DataTable
        rows={rows}
        columns={cols}
        rowKey={(t) => t.id}
        loading={q.isLoading}
        initialSort={{ key: 'created', dir: 'desc' }}
        empty={<EmptyState compact icon={<Building2 />} title="No tenants match" />}
        mobileCard={(t) => (
          <div className="flex items-start gap-3">
            <TenantMark name={t.name} size={32} />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[14px] font-semibold">{t.name}</span>
                <Badge tone={STATUS[t.status].tone} size="sm">{STATUS[t.status].label}</Badge>
              </div>
              <div className="tnum mt-0.5 text-[12.5px] text-ink-3">
                {t.plan_name} · {t.users_active}/{t.seats} users{t.trial_ends_on ? ` · trial ends ${fmtDate(t.trial_ends_on)}` : ''}
              </div>
              <div className="text-[12px] text-ink-3">Created {fmtDate(t.created_at.slice(0, 10))}{t.last_activity_at ? ` · active ${relTime(t.last_activity_at)}` : ''}</div>
            </div>
            {actions(t)}
          </div>
        )}
      />
      {extend && <ExtendDialog t={extend} onClose={() => setExtend(null)} />}
    </>
  )
}

function ExtendDialog({ t, onClose }: { t: TenantAdminRow; onClose: () => void }) {
  const [days, setDays] = useState(7)
  const [reason, setReason] = useState('')
  const m = useMut(() => adminApi.extendTrial(t.id, days, reason.trim()), { invalidate: [['admin-tenants'], ['admin-audit']], success: (r) => `Trial extended to ${fmtDate(r.trial_ends_on)}`, onSuccess: onClose })
  const e = m.error
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Extend trial · ${t.name}`}
      description={t.trial_ends_on ? `Currently ends ${fmtDate(t.trial_ends_on, 'long')}. A read-only tenant goes back to trial.` : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={reason.trim().length < 5} onClick={() => m.mutate(undefined)}>
            Extend {days} day{days === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {e && !e.field && <Callout tone="danger">{e.message}</Callout>}
        <Field label="Extend by" htmlFor="days" error={errField(e, 'days')}>
          <div className="flex items-center gap-3">
            <input id="days" type="range" min={1} max={30} value={days} onChange={(ev) => setDays(Number(ev.target.value))} className="flex-1 accent-[var(--brand)]" />
            <span className="tnum w-16 text-right text-[14px] font-medium">{days} d</span>
          </div>
          <div className="mt-1 flex gap-1.5">
            {[3, 7, 14, 30].map((n) => (
              <button key={n} type="button" onClick={() => setDays(n)} className="rounded-md border border-line px-2.5 py-0.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
                {n} days
              </button>
            ))}
          </div>
        </Field>
        <Field label="Reason" htmlFor="reason" required hint="Recorded in the platform audit log. At least 5 characters." error={errField(e, 'reason')}>
          <Textarea id="reason" rows={2} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Evaluating with finance team; requested on call" />
        </Field>
      </div>
    </Dialog>
  )
}

function AuditView() {
  const q = usePlatformAudit()
  if (q.isLoading) return <SkeletonRows rows={5} />
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  if (!q.data?.length)
    return (
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState icon={<History />} title="No platform actions yet" body="Trial extensions, suspensions and reactivations are recorded here with the reason." />
      </div>
    )
  const label = (a: string) => (a.startsWith('extend_trial') ? `Extended trial ${a.split(':')[1] ?? ''}` : a === 'suspend' ? 'Suspended' : a === 'reactivate' ? 'Reactivated' : a)
  const tone = (a: string): Tone => (a === 'suspend' ? 'danger' : a === 'reactivate' ? 'success' : 'brand')
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {q.data.map((a) => (
        <div key={a.id} className="flex items-start gap-3 px-4 py-3">
          <TenantMark name={a.tenant_name} size={28} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
              {a.tenant_name}
              <Badge size="sm" tone={tone(a.action)}>{label(a.action)}</Badge>
            </div>
            <div className="mt-0.5 text-[13px] text-ink-2">“{a.reason}”</div>
            <div className="text-[12px] text-ink-3">
              {a.actor_name} · {fmtDateTime(a.at)}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
