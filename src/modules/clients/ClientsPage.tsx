// Clients & contracts: client master with computed status and health, revenue billed / outstanding,
// and contracts coming up for renewal.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus } from '@/ui/icons'
import {
  Badge, Button, Card, CardHeader, DataTable, EmptyState, ListGroup, ListRow, Money, PageHeader, PersonName, SearchInput, Select, SkeletonCards, StatCard, StatusBadge, useReadOnly, type Column,
} from '@/ui'
import { useClients, type ClientRow } from '@/api/clients'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { fmtDate } from '@/domain/calendar'
import { fmtMoneyCompact } from '@/domain/money'
import { cn } from '@/lib/utils'
import { CLIENT_HEALTH, CLIENT_STATUS, CONTRACT_KIND } from '@/modules/spend/labels'
import { KpiRow, Meta } from '@/modules/spend/components'
import { ClientDialog } from './ClientPage'

export default function ClientsPage() {
  const q = useClients()
  const d = q.data
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [health, setHealth] = useState('')
  const [adding, setAdding] = useState(false)
  const rows = (d?.items ?? []).filter((c) => (!status || c.status === status) && (!health || c.health === health) && (!search || `${c.name} ${c.industry} ${c.primary_contact}`.toLowerCase().includes(search.toLowerCase())))

  const exportT = (): ExportTable => ({
    title: 'Client register', orientation: 'landscape', category: 'Commercial register',
    columns: [
      { key: 'name', label: 'Client', type: 'string' }, { key: 'industry', label: 'Industry', type: 'string' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'health', label: 'Health', type: 'string' },
      { key: 'owner', label: 'Account manager', type: 'string' }, { key: 'billed', label: 'Billed this FY', type: 'money' }, { key: 'outstanding', label: 'Outstanding', type: 'money' },
      { key: 'contracts', label: 'Live contracts', type: 'money' }, { key: 'renewal', label: 'Next renewal', type: 'date' },
    ],
    rows: rows.map((c) => ({ name: c.name, industry: c.industry, status: CLIENT_STATUS[c.status].label, health: c.health ? CLIENT_HEALTH[c.health].label : '', owner: c.owner_name, billed: c.billed_fy, outstanding: c.outstanding, contracts: c.contract_value, renewal: c.next_renewal })),
    totals: { billed: rows.reduce((a, c) => a + c.billed_fy, 0), outstanding: rows.reduce((a, c) => a + c.outstanding, 0), contracts: rows.reduce((a, c) => a + c.contract_value, 0) },
  })

  const cols: Column<ClientRow>[] = [
    {
      key: 'name', header: 'Client', sortValue: (c) => c.name.toLowerCase(),
      cell: (c) => (
        <div className="min-w-0 max-w-[340px]">
          <div className="truncate font-medium text-ink">{c.name}</div>
          <div className="truncate text-[12px] text-ink-3">{[c.industry, c.country].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (c) => c.status, cell: (c) => <StatusBadge map={CLIENT_STATUS} value={c.status} size="sm" /> },
    { key: 'health', header: 'Health', sortValue: (c) => (c.health === 'at_risk' ? 0 : c.health === 'watch' ? 1 : c.health === 'good' ? 2 : 3), cell: (c) => (c.health ? <span title={c.health_reasons.join(' · ')}><StatusBadge map={CLIENT_HEALTH} value={c.health} size="sm" /></span> : <span className="text-ink-3">—</span>) },
    { key: 'owner', header: 'Account manager', hideBelow: 'xl', sortValue: (c) => c.owner_name, cell: (c) => <PersonName id={c.owner_id} size={22} /> },
    { key: 'renewal', header: 'Next renewal', hideBelow: 'lg', sortValue: (c) => c.next_renewal ?? '9999', cell: (c) => <span className="tnum whitespace-nowrap text-ink-2">{c.next_renewal ? fmtDate(c.next_renewal) : '—'}</span> },
    { key: 'out', header: 'Outstanding', align: 'right', hideBelow: 'md', sortValue: (c) => c.outstanding, cell: (c) => <Money value={c.outstanding} muted={!c.outstanding} className={cn(c.overdue > 0 && 'text-danger-text')} /> },
    { key: 'billed', header: 'Billed this FY', align: 'right', sortValue: (c) => c.billed_fy, cell: (c) => <Money value={c.billed_fy} muted={!c.billed_fy} className="font-medium" /> },
  ]

  return (
    <div>
      <PageHeader
        title="Clients & contracts"
        subtitle="Who we work for, what they pay us, what they owe, and which contracts need renewing."
        actions={
          <>
            <ExportMenu table={d ? exportT : null} filename="clients" />
            {!readOnly && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} className="flex-1 md:flex-none">Add client</Button>}
          </>
        }
      />
      {q.isLoading ? (
        <SkeletonCards n={4} />
      ) : d ? (
        <KpiRow>
          <StatCard label="Active clients" value={d.totals.active} sub={`${d.totals.clients} in the register`} />
          <StatCard label="Billed this FY" value={fmtMoneyCompact(d.totals.billed_fy)} sub="Invoices and consulting income" />
          <StatCard label="Outstanding" value={fmtMoneyCompact(d.totals.outstanding)} tone={d.totals.overdue ? 'warning' : undefined} sub={d.totals.overdue ? `${fmtMoneyCompact(d.totals.overdue)} overdue` : 'Nothing overdue'} />
          <StatCard label="Renewals in 60 days" value={d.totals.renewals_60} tone={d.totals.renewals_60 ? 'warning' : undefined} sub={d.totals.renewals_60 ? `${fmtMoneyCompact(d.totals.renewal_value)} contract value` : 'None due'} />
        </KpiRow>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-8">
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <SearchInput value={search} onChange={setSearch} placeholder="Search client, industry or contact" className="w-full sm:w-72" />
            <div className="grid grid-cols-2 gap-2 sm:flex">
              <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...Object.entries(CLIENT_STATUS).map(([value, s]) => ({ value, label: s.label }))]} className="sm:w-40" />
              <Select aria-label="Health" value={health} onChange={(e) => setHealth(e.target.value)} options={[{ value: '', label: 'Any health' }, ...Object.entries(CLIENT_HEALTH).map(([value, s]) => ({ value, label: s.label }))]} className="sm:w-36" />
            </div>
          </div>
          <DataTable
            rows={d ? rows : undefined}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => q.refetch()}
            columns={cols}
            rowKey={(c) => c.id}
            onRowClick={(c) => nav(`/clients/${c.id}`)}
            empty={<EmptyState title="No clients match" body="Clients appear here automatically from projects and deals." compact />}
            mobileCard={(c) => (
              <div>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{c.name}</div>
                    <Meta>{[c.industry, c.owner_name].filter((x) => x && x !== '—').join(' · ') || '—'}</Meta>
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <Money value={c.billed_fy} compact className="text-[14px] font-semibold" />
                    <span className="text-[11.5px] text-ink-3">this FY</span>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <StatusBadge map={CLIENT_STATUS} value={c.status} size="sm" />
                  {c.health && <StatusBadge map={CLIENT_HEALTH} value={c.health} size="sm" />}
                  {c.outstanding > 0 && <Badge size="sm" tone={c.overdue ? 'danger' : 'neutral'}>{fmtMoneyCompact(c.outstanding)} due</Badge>}
                </div>
              </div>
            )}
          />
        </div>
        <Card className="min-w-0 xl:col-span-4 xl:self-start">
          <CardHeader title="Renewals due" subtitle="Contracts within 60 days of renewal or expiry" />
          {d?.renewals.length ? (
            <ListGroup className="-mx-1 border-0">
              {d.renewals.map((r) => (
                <ListRow
                  key={r.id}
                  to={`/clients/${r.client_id}`}
                  className="px-1"
                  title={r.client_name}
                  subtitle={`${CONTRACT_KIND[r.kind]} · ${r.title}`}
                  trailing={
                    <span className="flex flex-col items-end">
                      <span className={cn('tnum whitespace-nowrap text-[13px] font-medium', (r.days_to_renewal ?? 99) <= 15 ? 'text-danger-text' : 'text-warning-text')}>
                        {r.days_to_renewal !== null && r.days_to_renewal >= 0 ? `in ${r.days_to_renewal}d` : 'overdue'}
                      </span>
                      <span className="tnum text-[12px] text-ink-3">{fmtMoneyCompact(r.value_paise)}</span>
                    </span>
                  }
                />
              ))}
            </ListGroup>
          ) : (
            <EmptyState title="No renewals due" body="Nothing renews in the next 60 days." compact />
          )}
        </Card>
      </div>
      {adding && <ClientDialog row={null} onClose={() => setAdding(false)} onCreated={(id) => nav(`/clients/${id}`)} />}
    </div>
  )
}
