// Invoice register (tenant-wide): GST tax invoices — drafts, issued, partially paid, paid, overdue, cancelled.
// KPIs (revenue billed this FY at taxable value, GST charged, collected, outstanding incl. GST, DSO), receivables
// ageing, filters by status / client / project, export, and "Create invoice".
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Download, Eye, MoreHorizontal, Plus, Settings } from '@/ui/icons'
import { Badge, Button, Callout, DataTable, EmptyState, FilterChips, IconButton, Menu, Money, PageHeader, SearchInput, Select, SkeletonCards, StatCard, useCan, useReadOnly, type Column } from '@/ui'
import { useInvoices, type AgeBucket, type InvoiceDisplayStatus, type InvoiceListRow } from '@/api/invoices'
import { fmtMoneyCompact } from '@/domain/money'
import { fmtDate, todayISO } from '@/domain/calendar'
import { exportTable } from '@/reports/export'
import { cn } from '@/lib/utils'
import { INVOICE_STATUS, TAX_MODE } from './invoice/labels'
import { SettingsSheet } from './invoice/dialogs'

const BUCKET: Record<AgeBucket, string> = { '0_30': '0–30 days', '31_60': '31–60 days', '61_90': '61–90 days', '90_plus': '90+ days' }
type Filter = 'all' | 'outstanding' | InvoiceDisplayStatus

export default function InvoicesPage() {
  const q = useInvoices()
  const nav = useNavigate()
  const can = useCan()
  const readOnly = useReadOnly()
  const canEdit = can('finance.edit') && !readOnly
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>((params.get('status') as Filter) || 'all')
  const [bucket, setBucket] = useState<AgeBucket | null>(null)
  const [client, setClient] = useState(params.get('client') ?? '')
  const [project, setProject] = useState(params.get('project') ?? '')
  const [search, setSearch] = useState('')
  const [settings, setSettings] = useState(false)
  const d = q.data

  const clients = useMemo(() => [...new Set((d?.items ?? []).map((x) => x.client).filter(Boolean))].sort(), [d])
  const projects = useMemo(() => {
    const m = new Map<string, string>()
    for (const x of d?.items ?? []) m.set(x.project_id, `${x.project_code} ${x.project_name}`)
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [d])

  const rows = useMemo(() => {
    let r = d?.items ?? []
    if (filter === 'outstanding') r = r.filter((x) => x.balance_paise > 0)
    else if (filter !== 'all') r = r.filter((x) => x.status === filter)
    if (bucket) r = r.filter((x) => x.bucket === bucket)
    if (client) r = r.filter((x) => x.client === client)
    if (project) r = r.filter((x) => x.project_id === project)
    const s = search.trim().toLowerCase()
    if (s) r = r.filter((x) => `${x.number} ${x.project_name} ${x.project_code} ${x.client} ${x.milestone_label}`.toLowerCase().includes(s))
    return r
  }, [d, filter, bucket, client, project, search])

  const counts = useMemo(() => {
    const it = d?.items ?? []
    const c = (s: InvoiceDisplayStatus) => it.filter((x) => x.status === s).length
    return { all: it.length, outstanding: it.filter((x) => x.balance_paise > 0).length, draft: c('draft'), issued: c('issued'), partially_paid: c('partially_paid'), paid: c('paid'), overdue: c('overdue'), cancelled: c('cancelled') }
  }, [d])

  const setFilterParam = (k: string, v: string) => {
    const p = new URLSearchParams(params)
    if (v) p.set(k, v)
    else p.delete(k)
    setParams(p, { replace: true })
  }

  const registerExport = (format: 'pdf' | 'xlsx') =>
    exportTable(
      {
        title: 'Invoice register',
        subtitle: `${rows.length} invoices · as of ${fmtDate(todayISO(), 'long')}`,
        category: 'Finance report',
        orientation: 'landscape',
        columns: [
          { key: 'number', label: 'Number', type: 'string' }, { key: 'client', label: 'Client', type: 'string' }, { key: 'project', label: 'Project', type: 'string' }, { key: 'milestone', label: 'Milestone / item', type: 'string' },
          { key: 'date', label: 'Date', type: 'date' }, { key: 'due', label: 'Due', type: 'date' }, { key: 'taxable', label: 'Taxable', type: 'money' }, { key: 'gst', label: 'GST', type: 'money' }, { key: 'total', label: 'Total', type: 'money' },
          { key: 'paid', label: 'Paid', type: 'money' }, { key: 'balance', label: 'Balance', type: 'money' }, { key: 'status', label: 'Status', type: 'string' },
        ],
        rows: rows.map((i) => ({
          number: i.number, client: i.client, project: `${i.project_code} ${i.project_name}`, milestone: i.milestone_label, date: i.invoiced_on, due: i.due_on, taxable: i.taxable_paise, gst: i.gst_paise, total: i.total_paise,
          paid: i.paid_paise, balance: i.balance_paise, status: INVOICE_STATUS[i.status].label,
        })),
        totals: {
          taxable: rows.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => s + i.taxable_paise, 0), gst: rows.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => s + i.gst_paise, 0),
          total: rows.filter((i) => i.status !== 'draft' && i.status !== 'cancelled').reduce((s, i) => s + i.total_paise, 0), paid: rows.reduce((s, i) => s + i.paid_paise, 0), balance: rows.reduce((s, i) => s + i.balance_paise, 0),
        },
        kpis: d ? [{ label: `Billed ${d.summary.fy_label} (taxable)`, value: fmtMoneyCompact(d.summary.billed_fy) }, { label: 'GST charged', value: fmtMoneyCompact(d.summary.gst_fy) }, { label: 'Collected', value: fmtMoneyCompact(d.summary.collected_fy) }, { label: 'Outstanding', value: fmtMoneyCompact(d.summary.outstanding) }] : undefined,
        notes: ['Totals of taxable value, GST and total exclude drafts and cancelled invoices.', 'Paid = cash received + TDS deducted by the client.'],
      },
      format,
    )

  const cols: Column<InvoiceListRow>[] = [
    { key: 'number', header: 'Invoice', sortValue: (i) => i.number, cell: (i) => <span className={cn('tnum whitespace-nowrap font-medium', i.status === 'draft' ? 'text-ink-3' : 'text-ink')}>{i.number}</span> },
    {
      key: 'client', header: 'Client · project', sortValue: (i) => i.client,
      cell: (i) => (
        <div className="min-w-0 max-w-[300px]">
          <div className="truncate font-medium text-ink">{i.client}</div>
          <div className="truncate text-[12px] text-ink-3">{i.project_code} · {i.milestone_label}</div>
        </div>
      ),
    },
    { key: 'date', header: 'Date', sortValue: (i) => i.invoiced_on, cell: (i) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(i.invoiced_on)}</span> },
    { key: 'due', header: 'Due', sortValue: (i) => i.due_on, hideBelow: 'lg', cell: (i) => <span className={cn('tnum whitespace-nowrap', i.status === 'overdue' ? 'text-danger-text' : 'text-ink-2')}>{fmtDate(i.due_on)}{i.days_overdue > 0 && <span className="block text-[11.5px]">{i.days_overdue}d late</span>}</span> },
    { key: 'taxable', header: 'Taxable', align: 'right', sortValue: (i) => i.taxable_paise, hideBelow: 'xl', cell: (i) => <Money value={i.taxable_paise} muted={i.status === 'cancelled'} /> },
    { key: 'gst', header: 'GST', align: 'right', sortValue: (i) => i.gst_paise, hideBelow: 'xl', cell: (i) => <Money value={i.gst_paise} muted /> },
    { key: 'total', header: 'Total', align: 'right', sortValue: (i) => i.total_paise, cell: (i) => <Money value={i.total_paise} className={i.status === 'cancelled' ? 'text-ink-3 line-through' : 'font-medium'} /> },
    { key: 'paid', header: 'Paid', align: 'right', sortValue: (i) => i.paid_paise, hideBelow: 'xl', cell: (i) => <Money value={i.paid_paise} muted={!i.paid_paise} /> },
    { key: 'balance', header: 'Balance', align: 'right', sortValue: (i) => i.balance_paise, cell: (i) => <Money value={i.balance_paise} className={i.balance_paise ? 'font-medium' : 'text-ink-3'} /> },
    { key: 'status', header: 'Status', sortValue: (i) => i.status, cell: (i) => <Badge tone={INVOICE_STATUS[i.status].tone} size="sm">{INVOICE_STATUS[i.status].label}</Badge> },
    {
      key: 'act', header: '', align: 'right', width: '48px',
      cell: (i) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Menu
            label="Invoice actions"
            trigger={<IconButton size="sm" label={`Actions for ${i.number}`}><MoreHorizontal className="size-4" /></IconButton>}
            items={[
              { label: 'Open invoice', icon: <Eye />, onSelect: () => nav(`/finance/invoices/${i.id}`) },
              ...(i.status === 'draft' ? [{ label: 'Edit draft', disabled: !canEdit, onSelect: () => nav(`/finance/invoices/${i.id}/edit`) }] : []),
              ...(i.balance_paise > 0 ? [{ label: 'Record payment', disabled: !canEdit, onSelect: () => nav(`/finance/invoices/${i.id}?pay=1`) }] : []),
            ]}
          />
        </span>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Invoices"
        subtitle="GST tax invoices for every project. Revenue is booked at the taxable value when an invoice is issued; GST is held separately."
        actions={
          <>
            <Button icon={<Settings className="size-4" />} onClick={() => setSettings(true)}>Settings</Button>
            <Menu
              label="Export"
              trigger={<Button icon={<Download className="size-4" />} disabled={!rows.length}>Export</Button>}
              items={[{ label: 'PDF', onSelect: () => registerExport('pdf') }, { label: 'Excel', onSelect: () => registerExport('xlsx') }]}
            />
            {can('finance.edit') && (
              <Button variant="primary" icon={<Plus className="size-4" />} disabled={readOnly} onClick={() => nav('/finance/invoices/new')}>
                Create invoice
              </Button>
            )}
          </>
        }
      />
      {q.isLoading ? (
        <SkeletonCards n={4} />
      ) : d ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label={`Billed ${d.summary.fy_label}`} value={fmtMoneyCompact(d.summary.billed_fy)} sub={`Taxable value · GST ${fmtMoneyCompact(d.summary.gst_fy)} on top`} hint="Revenue = taxable value of issued invoices dated in this financial year. GST is a liability, not revenue." />
            <StatCard label="Collected" value={fmtMoneyCompact(d.summary.collected_fy)} sub="Received + TDS, this FY" />
            <StatCard label="Outstanding" value={fmtMoneyCompact(d.summary.outstanding)} sub={`${d.summary.outstanding_count} invoices incl. GST${d.summary.overdue_count ? ` · ${d.summary.overdue_count} overdue` : ''}`} tone={d.summary.overdue_count ? 'warning' : undefined} />
            <StatCard
              label="DSO"
              value={d.summary.dso === null ? '—' : `${d.summary.dso}d`}
              sub="Days sales outstanding"
              hint="Receivables ÷ average daily billing (incl. GST) over the last 90 days. Above 45 days needs attention; above 60 is a cash risk."
              tone={d.summary.dso === null ? undefined : d.summary.dso > 60 ? 'danger' : d.summary.dso > 45 ? 'warning' : 'success'}
            />
          </div>
          <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
              <h2 className="text-[13px] font-semibold text-ink">Receivables ageing</h2>
              <span className="text-[12px] text-ink-3">Select a bucket to filter</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4">
              {(Object.keys(BUCKET) as AgeBucket[]).map((b, idx) => {
                const a = d.summary.ageing[b]
                const active = bucket === b
                const share = d.summary.outstanding ? a.amount / d.summary.outstanding : 0
                return (
                  <button
                    key={b}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setBucket(active ? null : b)}
                    className={cn('min-w-0 border-line px-4 py-3 text-left transition-colors', idx % 2 === 1 && 'border-l', idx >= 2 && 'border-t sm:border-t-0', idx === 2 && 'sm:border-l', active ? 'bg-brand-soft' : 'hover:bg-surface-2')}
                  >
                    <div className="flex items-baseline justify-between gap-2 text-[12px] text-ink-3">
                      <span className="truncate">{BUCKET[b]}</span>
                      <span className="tnum shrink-0">{a.count} inv.</span>
                    </div>
                    <div className={cn('tnum mt-0.5 text-[16px] font-semibold', b === '90_plus' && a.amount ? 'text-danger-text' : 'text-ink')}>{fmtMoneyCompact(a.amount)}</div>
                    <div className="tnum mt-0.5 text-[11.5px] text-ink-3">{Math.round(share * 100)}% of outstanding</div>
                  </button>
                )
              })}
            </div>
          </div>
        </>
      ) : null}

      <div className="mt-5">
        <FilterChips
          value={filter}
          onChange={(v) => {
            setFilter(v)
            setFilterParam('status', v === 'all' ? '' : v)
          }}
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'outstanding', label: 'Outstanding', count: counts.outstanding },
            { value: 'draft', label: 'Draft', count: counts.draft },
            { value: 'issued', label: 'Issued', count: counts.issued },
            { value: 'partially_paid', label: 'Partially paid', count: counts.partially_paid },
            { value: 'overdue', label: 'Overdue', count: counts.overdue },
            { value: 'paid', label: 'Paid', count: counts.paid },
            { value: 'cancelled', label: 'Cancelled', count: counts.cancelled },
          ]}
        />
        <div className="mt-2.5 grid gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,18rem)]">
          <Select aria-label="Filter by client" value={client} onChange={(e) => { setClient(e.target.value); setFilterParam('client', e.target.value) }} options={[{ value: '', label: 'All clients' }, ...clients.map((c) => ({ value: c, label: c }))]} />
          <Select aria-label="Filter by project" value={project} onChange={(e) => { setProject(e.target.value); setFilterParam('project', e.target.value) }} options={[{ value: '', label: 'All projects' }, ...projects.map(([id, l]) => ({ value: id, label: l }))]} />
          <SearchInput value={search} onChange={setSearch} placeholder="Search number, client, project" className="sm:col-span-2 lg:col-span-1" />
        </div>
      </div>
      {bucket && (
        <Callout tone="brand" className="mt-3" action={<Button size="xs" variant="ghost" onClick={() => setBucket(null)}>Clear</Button>}>
          Showing invoices aged {BUCKET[bucket]}.
        </Callout>
      )}

      <div className="mt-3">
        <DataTable
          rows={q.data ? rows : undefined}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          columns={cols}
          rowKey={(i) => i.id}
          initialSort={{ key: 'date', dir: 'desc' }}
          onRowClick={(i) => nav(`/finance/invoices/${i.id}`)}
          empty={
            (d?.items.length ?? 0) === 0 ? (
              <EmptyState title="No invoices yet" body="Create a GST invoice for a project milestone, approved hours or any other billable item." action={canEdit ? <Button variant="primary" onClick={() => nav('/finance/invoices/new')}>Create invoice</Button> : undefined} />
            ) : (
              <EmptyState title="No invoices match" body="Change the status, client or project filter, or clear the search." compact />
            )
          }
          mobileCard={(i) => (
            <div>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="tnum text-[12px] text-ink-3">{i.number} · {fmtDate(i.invoiced_on)}</div>
                  <div className="truncate text-[14px] font-medium">{i.client}</div>
                  <div className="truncate text-[12.5px] text-ink-3">{i.project_code} · {i.milestone_label}</div>
                </div>
                <div className="shrink-0 text-right">
                  <Money value={i.balance_paise || i.total_paise} className="block text-[15px] font-semibold" />
                  <div className="text-[11.5px] text-ink-3">{i.balance_paise ? 'Balance' : 'Total'}</div>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={INVOICE_STATUS[i.status].tone} size="sm">{INVOICE_STATUS[i.status].label}</Badge>
                <span className="text-[12px] text-ink-3">{TAX_MODE[i.tax_mode].short}</span>
                <span className="tnum text-[12px] text-ink-3">Due {fmtDate(i.due_on)}{i.days_overdue ? ` · ${i.days_overdue}d late` : ''}</span>
              </div>
            </div>
          )}
        />
      </div>
      <SettingsSheet open={settings} onClose={() => setSettings(false)} />
    </div>
  )
}
