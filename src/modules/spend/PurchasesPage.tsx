// Purchases: vendor master, purchase orders (CEO approval, budget check), vendor bills with the
// PO tolerance check, payment (books the ledger) and the payables ageing.
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Ban, Check, FileText, LockOpen, MoreHorizontal, Pencil, Plus, Trash2, X } from '@/ui/icons'
import {
  Badge, Button, Callout, Card, CardHeader, Combobox, DataTable, Dialog, EmptyState, Field, FileUpload, IconButton, Input, Menu, Money, MoneyInput, PageHeader, SearchInput, Select,
  SkeletonCards, StatCard, StatusBadge, Tabs, Textarea, useConfirm, useReadOnly, type Column, type MenuItem,
} from '@/ui'
import { useMut } from '@/api/query'
import { announce, guarded } from '@/api/changes'
import { PendingNote } from '@/modules/workflows/ApprovalRoute'
import { readFile, SPEND_INVALIDATE, spendApi, usePurchases, useSpendMeta, type BillRow, type FileInput, type PORow, type SpendMeta, type VendorRow } from '@/api/spend'
import { useSession } from '@/stores/session'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { addDays, fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtMoneyCompact, fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { BILL_STATUS, GSTIN_RE, PAN_RE, PO_STATUS, VENDOR_STATUS } from './labels'
import { KpiRow, Meta, useFieldErrors } from './components'

type Tab = 'pos' | 'bills' | 'vendors'

export default function PurchasesPage() {
  const [params, setParams] = useSearchParams()
  const tab = (['pos', 'bills', 'vendors'].includes(params.get('tab') ?? '') ? params.get('tab') : 'pos') as Tab
  const setTab = (t: Tab) => setParams((p) => { p.set('tab', t); return p }, { replace: true })
  const q = usePurchases()
  const meta = useSpendMeta()
  const readOnly = useReadOnly()
  const d = q.data
  // Spend authority (approve POs and bills) comes from the server, computed from permissions.
  const isAdmin = !!d?.can_approve
  const [poEdit, setPoEdit] = useState<PORow | 'new' | null>(null)
  const [billFor, setBillFor] = useState<{ po?: PORow } | null>(null)
  const [vendorEdit, setVendorEdit] = useState<VendorRow | 'new' | null>(null)

  const exportFor = (): ExportTable => {
    if (!d) throw new Error('no data')
    if (tab === 'pos')
      return {
        title: 'Purchase order register', orientation: 'landscape', category: 'Spend register',
        columns: [
          { key: 'number', label: 'PO', type: 'string' }, { key: 'date', label: 'Raised', type: 'date' }, { key: 'vendor', label: 'Vendor', type: 'string' }, { key: 'title', label: 'Description', type: 'string' },
          { key: 'category', label: 'Budget', type: 'string' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'amount', label: 'Amount', type: 'money' }, { key: 'gst', label: 'GST', type: 'money' },
          { key: 'total', label: 'Total', type: 'money' }, { key: 'billed', label: 'Billed', type: 'money' },
        ],
        rows: d.pos.map((p) => ({ number: p.number, date: p.created_at.slice(0, 10), vendor: p.vendor_name, title: p.title ?? '', category: p.budget_category + (p.over_budget ? ' (over budget)' : ''), status: PO_STATUS[p.status].label, amount: p.amount_paise, gst: p.gst_amount_paise, total: p.total_paise, billed: p.billed_paise })),
        totals: { amount: d.pos.reduce((a, p) => a + p.amount_paise, 0), total: d.pos.reduce((a, p) => a + p.total_paise, 0), billed: d.pos.reduce((a, p) => a + p.billed_paise, 0) },
      }
    if (tab === 'bills')
      return {
        title: 'Vendor bills and payables', orientation: 'landscape', category: 'Spend register',
        columns: [
          { key: 'number', label: 'Bill', type: 'string' }, { key: 'vendor', label: 'Vendor', type: 'string' }, { key: 'po', label: 'PO', type: 'string' }, { key: 'date', label: 'Bill date', type: 'date' },
          { key: 'due', label: 'Due', type: 'date' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'total', label: 'Bill + GST', type: 'money' }, { key: 'tds', label: 'TDS', type: 'money' }, { key: 'net', label: 'Net payable', type: 'money' },
        ],
        rows: d.bills.map((b) => ({ number: b.number, vendor: b.vendor_name, po: b.po_number ?? 'Direct', date: b.bill_date, due: b.due_on, status: BILL_STATUS[b.status].label, total: b.total_paise, tds: b.tds_paise, net: b.net_payable_paise })),
        totals: { total: d.bills.reduce((a, b) => a + b.total_paise, 0), tds: d.bills.reduce((a, b) => a + b.tds_paise, 0), net: d.bills.reduce((a, b) => a + b.net_payable_paise, 0) },
        kpis: d.ageing.map((a) => ({ label: a.label, value: fmtMoneyCompact(a.amount) })),
      }
    return {
      title: 'Vendor master', category: 'Spend register', orientation: 'landscape',
      columns: [
        { key: 'name', label: 'Vendor', type: 'string' }, { key: 'category', label: 'Category', type: 'string' }, { key: 'gstin', label: 'GSTIN', type: 'string' }, { key: 'pan', label: 'PAN', type: 'string' },
        { key: 'terms', label: 'Terms (days)', type: 'number' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'billed', label: 'Billed this FY', type: 'money' }, { key: 'payable', label: 'Payable', type: 'money' },
      ],
      rows: d.vendors.map((v) => ({ name: v.name, category: v.category, gstin: v.gstin, pan: v.pan, terms: v.payment_terms_days, status: VENDOR_STATUS[v.status].label, billed: v.billed_fy, payable: v.payable })),
    }
  }

  return (
    <div>
      <PageHeader
        title="Purchases & vendors"
        subtitle="Raise a PO before you buy. Bills are checked against the PO, approved by the CEO and paid by accounts."
        actions={
          <>
            <ExportMenu table={d ? exportFor : null} filename={`purchases-${tab}`} />
            {!readOnly && (
              <Menu
                label="New"
                trigger={<Button variant="primary" icon={<Plus className="size-4" />} className="flex-1 md:flex-none">New</Button>}
                items={[
                  { label: 'Purchase order', onSelect: () => setPoEdit('new') },
                  { label: 'Vendor bill', onSelect: () => setBillFor({}) },
                  { label: 'Vendor', onSelect: () => setVendorEdit('new') },
                ]}
              />
            )}
          </>
        }
      />
      {q.isLoading ? (
        <SkeletonCards n={4} />
      ) : d ? (
        <KpiRow>
          <StatCard label="Open PO value" value={fmtMoneyCompact(d.totals.open_po_value)} sub="Approved, not yet billed" />
          <StatCard label="POs to approve" value={d.totals.pending_po} tone={d.totals.pending_po ? 'warning' : undefined} sub="Waiting for the CEO" onClick={() => setTab('pos')} />
          <StatCard label="Payables" value={fmtMoneyCompact(d.totals.payable)} sub={d.totals.disputed ? `${fmtMoneyCompact(d.totals.disputed)} disputed` : 'Net of TDS'} onClick={() => setTab('bills')} />
          <StatCard label="Overdue to vendors" value={fmtMoneyCompact(d.totals.overdue)} tone={d.totals.overdue ? 'danger' : undefined} sub={`${fmtMoneyCompact(d.totals.paid_fy)} paid this FY`} />
        </KpiRow>
      ) : null}

      <Tabs
        className="mt-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'pos', label: 'Purchase orders', count: d?.totals.pending_po || undefined },
          { value: 'bills', label: 'Bills & payables', count: d?.bills.filter((b) => b.status === 'received').length || undefined },
          { value: 'vendors', label: 'Vendors', count: d?.vendors.length },
        ]}
      />
      {tab === 'pos' && <POTab d={d} loading={q.isLoading} error={q.error} retry={() => q.refetch()} readOnly={readOnly} isAdmin={isAdmin} onEdit={setPoEdit} onBill={(po) => setBillFor({ po })} />}
      {tab === 'bills' && <BillsTab d={d} loading={q.isLoading} error={q.error} retry={() => q.refetch()} readOnly={readOnly} isAdmin={isAdmin} onNew={() => setBillFor({})} />}
      {tab === 'vendors' && <VendorsTab d={d} loading={q.isLoading} error={q.error} retry={() => q.refetch()} readOnly={readOnly} onEdit={setVendorEdit} />}

      {poEdit && meta.data && <PODialog row={poEdit === 'new' ? null : poEdit} meta={meta.data} onClose={() => setPoEdit(null)} />}
      {billFor && meta.data && d && <BillDialog po={billFor.po ?? null} pos={d.pos} meta={meta.data} onClose={() => setBillFor(null)} />}
      {vendorEdit && <VendorDialog row={vendorEdit === 'new' ? null : vendorEdit} checked={!!d?.vendor_checked} onClose={() => setVendorEdit(null)} />}
    </div>
  )
}

type TabProps = { d: ReturnType<typeof usePurchases>['data']; loading: boolean; error: unknown; retry: () => void; readOnly: boolean }

/* ---------------- purchase orders ---------------- */
function POTab({ d, loading, error, retry, readOnly, isAdmin, onEdit, onBill }: TabProps & { isAdmin: boolean; onEdit: (p: PORow) => void; onBill: (p: PORow) => void }) {
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const { askReason, confirm } = useConfirm()
  const approve = useMut((p: PORow) => spendApi.approvePO(p.id, p.version), { invalidate: SPEND_INVALIDATE, success: (r, p) => ((r as PORow | undefined)?.status === 'pending' ? null : `${p.number} approved`) })
  const reject = useMut((v: { p: PORow; reason: string }) => spendApi.rejectPO(v.p.id, v.reason, v.p.version), { invalidate: SPEND_INVALIDATE, success: 'PO rejected' })
  const submit = useMut((p: PORow) => spendApi.submitPO(p.id), { invalidate: SPEND_INVALIDATE, success: 'Sent for approval' })
  const close = useMut((p: PORow) => spendApi.closePO(p.id), { invalidate: SPEND_INVALIDATE, success: 'PO closed' })
  const del = useMut((p: PORow) => spendApi.deletePO(p.id, p.version), { invalidate: SPEND_INVALIDATE, success: 'Draft deleted' })
  const rows = (d?.pos ?? []).filter((p) => (!status || p.status === status) && (!q || `${p.number} ${p.vendor_name} ${p.title}`.toLowerCase().includes(q.toLowerCase())))
  const busy = approve.isPending || reject.isPending
  const doReject = async (p: PORow) => {
    const reason = await askReason({ title: `Reject ${p.number}?`, body: `${p.vendor_name} · ${fmtMoney(p.total_paise)}`, label: 'Reason', placeholder: 'e.g. Get a second quote first', confirmLabel: 'Reject PO', minLength: 5, tone: 'danger' })
    if (reason) reject.mutate({ p, reason })
  }
  const actions = (p: PORow) => {
    if (readOnly) return null
    if (p.can_approve)
      return (
        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" icon={<X className="size-3.5" />} onClick={() => doReject(p)} disabled={busy}>Reject</Button>
          <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => approve.mutate(p)} disabled={busy}>Approve</Button>
        </div>
      )
    const items: MenuItem[] = []
    if (p.status === 'draft' || p.status === 'rejected') {
      items.push({ label: 'Send for approval', onSelect: () => submit.mutate(p) }, { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(p) })
      if (p.status === 'draft') items.push({ label: 'Delete draft', icon: <Trash2 />, danger: true, onSelect: async () => (await confirm({ title: `Delete ${p.number}?`, confirmLabel: 'Delete', tone: 'danger' })) && del.mutate(p) })
    }
    if (p.status === 'approved') items.push({ label: 'Record bill', icon: <FileText />, onSelect: () => onBill(p) }, { label: 'Close PO', onSelect: async () => (await confirm({ title: `Close ${p.number}?`, body: 'No more bills can be booked against it.', confirmLabel: 'Close PO' })) && close.mutate(p) })
    if (!items.length) return null
    return (
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Menu label="PO actions" trigger={<IconButton label="PO actions" size="sm" variant="ghost"><MoreHorizontal className="size-4" /></IconButton>} items={items} />
      </div>
    )
  }
  const cols: Column<PORow>[] = [
    { key: 'number', header: 'PO', sortValue: (p) => p.number, cell: (p) => <div className="whitespace-nowrap"><div className="tnum font-medium text-ink">{p.number}</div><div className="text-[12px] text-ink-3">{fmtDate(p.created_at.slice(0, 10))}</div></div> },
    {
      key: 'vendor', header: 'Vendor & description', sortValue: (p) => p.vendor_name,
      cell: (p) => (
        <div className="min-w-0 max-w-[380px]">
          <div className="truncate text-ink">{p.vendor_name}</div>
          <div className="truncate text-[12px] text-ink-3">{p.title}{p.project_code ? ` · ${p.project_code}` : ''}</div>
        </div>
      ),
    },
    { key: 'cat', header: 'Budget', sortValue: (p) => p.budget_category, hideBelow: 'lg', cell: (p) => <div className="flex flex-wrap items-center gap-1"><span className="whitespace-nowrap text-ink-2">{p.budget_category}</span>{p.over_budget && <Badge tone="warning" size="sm">Over budget</Badge>}</div> },
    { key: 'status', header: 'Status', sortValue: (p) => p.status, cell: (p) => <div className="flex flex-wrap items-center gap-1"><StatusBadge map={PO_STATUS} value={p.status} size="sm" />{p.status === 'pending' && <span className="whitespace-nowrap text-[12px] text-ink-3" title={p.step_label ?? undefined}>{p.step_label ? `${p.step_label.split(' · ')[0]} · ` : ''}{p.approver_name}</span>}</div> },
    { key: 'billed', header: 'Billed', align: 'right', hideBelow: 'xl', sortValue: (p) => p.billed_paise, cell: (p) => <Money value={p.billed_paise} muted={!p.billed_paise} /> },
    { key: 'total', header: 'Total incl. GST', align: 'right', sortValue: (p) => p.total_paise, cell: (p) => <Money value={p.total_paise} className="font-medium" /> },
    { key: 'act', header: '', align: 'right', width: '1%', className: 'whitespace-nowrap', cell: actions },
  ]
  const pending = (d?.pos ?? []).filter((p) => p.status === 'pending')
  return (
    <>
      {isAdmin && pending.some((p) => p.over_budget) && (
        <Callout tone="warning" className="mb-4" title="Over-budget POs waiting for you">
          {pending.filter((p) => p.over_budget).map((p) => `${p.number} (${p.vendor_name}): “${p.justification}”`).join(' · ')}
        </Callout>
      )}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={q} onChange={setQ} placeholder="Search PO, vendor or item" className="w-full sm:w-72" />
        <Select aria-label="PO status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...Object.entries(PO_STATUS).map(([value, s]) => ({ value, label: s.label }))]} className="w-full sm:w-48" />
      </div>
      <DataTable
        rows={d ? rows : undefined}
        loading={loading}
        error={error}
        onRetry={retry}
        columns={cols}
        rowKey={(p) => p.id}
        onRowClick={(p) => (p.status === 'draft' || p.status === 'rejected') && !readOnly ? onEdit(p) : undefined}
        empty={<EmptyState title="No purchase orders" body="Raise a PO for laptops, licences or services before you commit the spend." compact />}
        mobileCard={(p) => (
          <div>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-ink">{p.vendor_name}</div>
                <Meta>{p.number} · {p.title}</Meta>
                <Meta>{p.budget_category}{p.project_code ? ` · ${p.project_code}` : ''}</Meta>
              </div>
              <Money value={p.total_paise} className="shrink-0 text-[14px] font-semibold" />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1"><StatusBadge map={PO_STATUS} value={p.status} size="sm" />{p.step_label && p.status === 'pending' && <Badge tone="accent" size="sm">{p.step_label.split(' · ')[0]}</Badge>}{p.over_budget && <Badge tone="warning" size="sm">Over budget</Badge>}</div>
              {actions(p)}
            </div>
          </div>
        )}
      />
    </>
  )
}

/* ---------------- bills & ageing ---------------- */
function BillsTab({ d, loading, error, retry, readOnly, isAdmin, onNew }: TabProps & { isAdmin: boolean; onNew: () => void }) {
  const [status, setStatus] = useState('')
  const { askReason, confirm } = useConfirm()
  const approve = useMut((b: BillRow) => spendApi.approveBill(b.id, b.version), { invalidate: SPEND_INVALIDATE, success: 'Bill approved for payment' })
  const pay = useMut((b: BillRow) => spendApi.payBill(b.id, undefined, b.version), { invalidate: SPEND_INVALIDATE, success: 'Bill paid and booked to the ledger' })
  const dispute = useMut((v: { b: BillRow; reason: string }) => spendApi.disputeBill(v.b.id, v.reason), { invalidate: SPEND_INVALIDATE, success: 'Bill marked disputed' })
  const resolve = useMut((b: BillRow) => spendApi.resolveBill(b.id), { invalidate: SPEND_INVALIDATE, success: 'Dispute resolved' })
  const rows = (d?.bills ?? []).filter((b) => !status || b.status === status)
  const busy = approve.isPending || pay.isPending
  const actions = (b: BillRow) => {
    if (readOnly) return null
    const items: MenuItem[] = []
    if (b.status === 'received' || b.status === 'approved') items.push({ label: 'Dispute bill', onSelect: async () => { const r = await askReason({ title: `Dispute bill ${b.number}?`, body: b.vendor_name, label: 'What is wrong', placeholder: 'e.g. Billed for 5 licences, PO was for 4', confirmLabel: 'Mark disputed', minLength: 10, tone: 'danger' }); if (r) dispute.mutate({ b, reason: r }) } })
    if (b.status === 'disputed') items.push({ label: 'Resolve dispute', onSelect: () => resolve.mutate(b) })
    const primary =
      b.can_approve ? <Button size="sm" variant="primary" onClick={() => approve.mutate(b)} disabled={busy}>Approve</Button>
      : b.status === 'approved' ? <Button size="sm" variant="primary" onClick={async () => (await confirm({ title: `Pay ${fmtMoney(b.net_payable_paise)} to ${b.vendor_name}?`, body: `Bill ${b.number}. ${b.tds_paise ? `TDS of ${fmtMoney(b.tds_paise)} is deducted. ` : ''}${fmtMoney(b.total_paise)} is booked to the ledger under ${b.category}.`, confirmLabel: 'Mark paid' })) && pay.mutate(b)} disabled={busy}>Mark paid</Button>
      : null
    if (!primary && !items.length) return null
    return (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {primary}
        {items.length > 0 && <Menu label="Bill actions" trigger={<IconButton label="Bill actions" size="sm" variant="ghost"><MoreHorizontal className="size-4" /></IconButton>} items={items} />}
      </div>
    )
  }
  const cols: Column<BillRow>[] = [
    {
      key: 'bill', header: 'Bill', sortValue: (b) => b.bill_date,
      cell: (b) => (
        <div className="min-w-0 max-w-[340px]">
          <div className="truncate text-ink">{b.vendor_name}</div>
          <div className="truncate text-[12px] text-ink-3">{b.number} · {fmtDate(b.bill_date)}{b.po_number ? ` · ${b.po_number}` : ' · direct'}</div>
        </div>
      ),
    },
    { key: 'due', header: 'Due', sortValue: (b) => b.due_on, cell: (b) => <div className="whitespace-nowrap"><div className="tnum text-ink-2">{fmtDate(b.due_on)}</div>{b.days_overdue > 0 && <div className="text-[12px] font-medium text-danger-text">{b.days_overdue}d overdue</div>}</div> },
    {
      key: 'status', header: 'Status', sortValue: (b) => b.status,
      cell: (b) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge map={BILL_STATUS} value={b.status} size="sm" />
          {b.over_po_pct !== null && <Badge tone="warning" size="sm">{(b.over_po_pct * 100).toFixed(1)}% over PO</Badge>}
        </div>
      ),
    },
    { key: 'total', header: 'Bill + GST', align: 'right', hideBelow: 'lg', sortValue: (b) => b.total_paise, cell: (b) => <Money value={b.total_paise} /> },
    { key: 'tds', header: 'TDS', align: 'right', hideBelow: 'xl', sortValue: (b) => b.tds_paise, cell: (b) => <Money value={b.tds_paise} muted={!b.tds_paise} /> },
    { key: 'net', header: 'Net payable', align: 'right', sortValue: (b) => b.net_payable_paise, cell: (b) => <Money value={b.net_payable_paise} className="font-medium" /> },
    { key: 'act', header: '', align: 'right', width: '1%', className: 'whitespace-nowrap', cell: actions },
  ]
  const ageMax = Math.max(1, ...(d?.ageing ?? []).map((a) => a.amount))
  return (
    <div className="grid gap-4 xl:grid-cols-12">
      <div className="min-w-0 xl:col-span-8">
        <div className="mb-4 flex flex-col gap-2 sm:flex-row">
          <Select aria-label="Bill status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...Object.entries(BILL_STATUS).map(([value, s]) => ({ value, label: s.label }))]} className="w-full sm:w-48" />
        </div>
        <DataTable
          rows={d ? rows : undefined}
          loading={loading}
          error={error}
          onRetry={retry}
          columns={cols}
          rowKey={(b) => b.id}
          initialSort={{ key: 'bill', dir: 'desc' }}
          empty={<EmptyState title="No vendor bills" body="Record bills as they arrive; they are checked against the PO." action={!readOnly && <Button variant="primary" onClick={onNew}>Record bill</Button>} compact />}
          mobileCard={(b) => (
            <div>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-ink">{b.vendor_name}</div>
                  <Meta>{b.number} · {b.po_number ?? 'Direct bill'}</Meta>
                  <Meta className={cn(b.days_overdue > 0 && 'text-danger-text')}>Due {fmtDate(b.due_on)}{b.days_overdue > 0 ? ` · ${b.days_overdue}d overdue` : ''}</Meta>
                </div>
                <Money value={b.net_payable_paise} className="shrink-0 text-[14px] font-semibold" />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1"><StatusBadge map={BILL_STATUS} value={b.status} size="sm" />{b.over_po_pct !== null && <Badge tone="warning" size="sm">{(b.over_po_pct * 100).toFixed(1)}% over PO</Badge>}</div>
                {actions(b)}
              </div>
            </div>
          )}
        />
        {d?.bills.some((b) => b.status === 'disputed') && (
          <div className="mt-4 space-y-2">
            {d.bills.filter((b) => b.status === 'disputed').map((b) => (
              <Callout key={b.id} tone="danger" title={`Disputed · ${b.vendor_name} · ${b.number}`}>{b.dispute_reason}</Callout>
            ))}
          </div>
        )}
      </div>
      <Card className="min-w-0 xl:col-span-4 xl:self-start">
        <CardHeader title="Payables ageing" subtitle="Unpaid bills by days past due (net of TDS)" />
        {d ? (
          <div className="space-y-3">
            {d.ageing.map((a) => (
              <div key={a.key}>
                <div className="flex items-baseline justify-between gap-2 text-[13px]">
                  <span className="text-ink-2">{a.label} <span className="text-ink-3">· {a.count}</span></span>
                  <Money value={a.amount} className={cn('font-medium', a.key !== 'not_due' && a.amount > 0 && 'text-danger-text')} />
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className={cn('h-full rounded-full', a.key === 'not_due' ? 'bg-brand' : 'bg-danger')} style={{ width: `${(a.amount / ageMax) * 100}%` }} />
                </div>
              </div>
            ))}
            <div className="flex items-baseline justify-between border-t border-line pt-3 text-[13px] font-semibold">
              <span>Total unpaid</span>
              <Money value={d.ageing.reduce((x, a) => x + a.amount, 0)} />
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}

/* ---------------- vendors ---------------- */
function VendorsTab({ d, loading, error, retry, readOnly, onEdit }: TabProps & { onEdit: (v: VendorRow) => void }) {
  const [q, setQ] = useState('')
  const { askReason } = useConfirm()
  const block = useMut((v: { id: string; reason: string }) => spendApi.blockVendor(v.id, v.reason), { invalidate: SPEND_INVALIDATE, success: 'Vendor blocked' })
  const unblock = useMut((id: string) => spendApi.unblockVendor(id), { invalidate: SPEND_INVALIDATE, success: 'Vendor unblocked' })
  const rows = (d?.vendors ?? []).filter((v) => !q || `${v.name} ${v.category} ${v.gstin}`.toLowerCase().includes(q.toLowerCase()))
  const actions = (v: VendorRow) =>
    readOnly ? null : (
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Menu
          label="Vendor actions"
          trigger={<IconButton label="Vendor actions" size="sm" variant="ghost"><MoreHorizontal className="size-4" /></IconButton>}
          items={[
            { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(v) },
            v.status === 'active'
              ? { label: 'Block vendor', icon: <Ban />, danger: true, onSelect: async () => { const r = await askReason({ title: `Block ${v.name}?`, body: 'No new POs can be raised for a blocked vendor.', label: 'Reason', minLength: 5, confirmLabel: 'Block', tone: 'danger' }); if (r) block.mutate({ id: v.id, reason: r }) } }
              : { label: 'Unblock vendor', icon: <LockOpen />, onSelect: () => unblock.mutate(v.id) },
          ]}
        />
      </div>
    )
  const cols: Column<VendorRow>[] = [
    { key: 'name', header: 'Vendor', sortValue: (v) => v.name, cell: (v) => <div className="min-w-0 max-w-[320px]"><div className="flex min-w-0 items-center gap-1.5"><span className="truncate font-medium text-ink">{v.name}</span>{v.pending_change && <Badge tone="warning" size="sm">Change pending</Badge>}</div><div className="truncate text-[12px] text-ink-3">{v.category}{v.contact ? ` · ${v.contact}` : ''}{v.bank_account_masked ? ` · a/c ${v.bank_account_masked}` : ''}</div></div> },
    { key: 'gstin', header: 'GSTIN', hideBelow: 'lg', sortValue: (v) => v.gstin, cell: (v) => <span className="tnum whitespace-nowrap text-ink-2">{v.gstin || 'Unregistered'}</span> },
    { key: 'terms', header: 'Terms', align: 'right', hideBelow: 'xl', sortValue: (v) => v.payment_terms_days, cell: (v) => <span className="tnum whitespace-nowrap text-ink-2">{v.payment_terms_days} days</span> },
    { key: 'status', header: 'Status', sortValue: (v) => v.status, cell: (v) => <StatusBadge map={VENDOR_STATUS} value={v.status} size="sm" /> },
    { key: 'billed', header: 'Billed this FY', align: 'right', hideBelow: 'lg', sortValue: (v) => v.billed_fy, cell: (v) => <Money value={v.billed_fy} muted={!v.billed_fy} /> },
    { key: 'payable', header: 'Payable', align: 'right', sortValue: (v) => v.payable, cell: (v) => <Money value={v.payable} className={cn('font-medium', v.overdue > 0 && 'text-danger-text')} muted={!v.payable} /> },
    { key: 'act', header: '', align: 'right', width: '52px', cell: actions },
  ]
  return (
    <>
      <div className="mb-4"><SearchInput value={q} onChange={setQ} placeholder="Search vendor, category or GSTIN" className="w-full sm:w-80" /></div>
      <DataTable
        rows={d ? rows : undefined}
        loading={loading}
        error={error}
        onRetry={retry}
        columns={cols}
        rowKey={(v) => v.id}
        onRowClick={readOnly ? undefined : onEdit}
        empty={<EmptyState title="No vendors" body="Add the suppliers you buy from — GSTIN and payment terms drive bill due dates." compact />}
        mobileCard={(v) => (
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">{v.name}</div>
              <Meta>{v.category} · {v.payment_terms_days} days</Meta>
              <Meta className="tnum">{v.gstin || 'Unregistered'}</Meta>
              <div className="mt-1.5 flex flex-wrap gap-1"><StatusBadge map={VENDOR_STATUS} value={v.status} size="sm" />{v.pending_change && <Badge tone="warning" size="sm">Change pending</Badge>}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Money value={v.payable} className="text-[14px] font-semibold" />
              <span className="text-[12px] text-ink-3">payable</span>
            </div>
          </div>
        )}
      />
    </>
  )
}

/* ---------------- dialogs ---------------- */
function PODialog({ row, meta, onClose }: { row: PORow | null; meta: SpendMeta; onClose: () => void }) {
  const [f, setF] = useState({
    vendor_id: row?.vendor_id ?? '',
    title: row?.title ?? '',
    project_id: row?.project_id ?? null as string | null,
    budget_category: row?.budget_category ?? '',
    gst_pct: row?.gst_pct ?? 18,
    needed_by: row?.needed_by ?? addDays(meta.today, 14),
    justification: row?.justification ?? '',
  })
  const [lines, setLines] = useState(row?.lines.map((l) => ({ ...l })) ?? [{ description: '', qty: 1, rate_paise: 0 }])
  const fe = useFieldErrors()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const save = useMut(
    (v: { submit: boolean }) => {
      const body = { ...f, lines, needed_by: f.needed_by || null, justification: f.justification || null, submit: v.submit }
      return row ? spendApi.updatePO(row.id, body, row.version) : spendApi.createPO(body)
    },
    { invalidate: SPEND_INVALIDATE, success: (_r, v) => (v.submit ? 'PO sent for approval' : 'Draft saved'), onSuccess: onClose, onError: (e) => fe.take(e) },
  )
  // preview only — the server computes and stores the amounts
  const sub = lines.reduce((a, l) => a + Math.round((Number(l.qty) || 0) * (l.rate_paise || 0)), 0)
  const gst = Math.round((sub * f.gst_pct) / 100)
  const vendors = meta.vendors.filter((v) => v.status === 'active' || v.id === f.vendor_id)
  return (
    <Dialog
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${row.number}` : 'New purchase order'}
      description="The CEO approves every PO. If it takes the category over budget, explain why."
      footer={
        <>
          <Button onClick={() => save.mutate({ submit: false })} disabled={save.isPending}>Save draft</Button>
          <Button variant="primary" onClick={() => save.mutate({ submit: true })} loading={save.isPending} disabled={save.isPending}>Send for approval</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" required error={fe.errors.vendor_id}>
          <Combobox value={f.vendor_id || null} onChange={(v) => set('vendor_id', v ?? '')} placeholder="Choose vendor" options={vendors.map((v) => ({ value: v.id, label: v.name, hint: v.category }))} invalid={!!fe.errors.vendor_id} />
        </Field>
        <Field label="Budget category" required error={fe.errors.budget_category}>
          <Select aria-label="Budget category" value={f.budget_category} onChange={(e) => set('budget_category', e.target.value)} placeholder="Choose…" options={meta.budget_categories} invalid={!!fe.errors.budget_category} />
        </Field>
        <Field label="What are you buying" className="sm:col-span-2">
          <Input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Laptops for new joiners" maxLength={120} />
        </Field>
        <Field label="Project" hint="Optional — for project-specific purchases.">
          <Combobox value={f.project_id} onChange={(v) => set('project_id', v)} clearable placeholder="No project" options={meta.projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}`, hint: p.client }))} />
        </Field>
        <Field label="Needed by">
          <Input type="date" value={f.needed_by ?? ''} onChange={(e) => set('needed_by', e.target.value)} />
        </Field>
      </div>
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium text-ink-2">Lines</span>
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setLines((l) => [...l, { description: '', qty: 1, rate_paise: 0 }])}>Add line</Button>
        </div>
        {fe.errors.lines && <p className="mb-2 text-[12.5px] font-medium text-danger-text">{fe.errors.lines}</p>}
        <div className="space-y-2">
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-line p-2.5 sm:grid-cols-[minmax(0,1fr)_80px_140px_auto] sm:items-center sm:border-0 sm:p-0">
              <Input aria-label={`Line ${i + 1} description`} value={l.description} placeholder="Item or service" onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, description: e.target.value } : y)))} className="col-span-2 sm:col-span-1" />
              <Input aria-label={`Line ${i + 1} quantity`} type="number" min={0} step="any" value={String(l.qty)} onChange={(e) => setLines((x) => x.map((y, j) => (j === i ? { ...y, qty: Number(e.target.value) } : y)))} className="tnum" />
              <MoneyInput value={l.rate_paise} onChange={(v) => setLines((x) => x.map((y, j) => (j === i ? { ...y, rate_paise: v } : y)))} placeholder="Rate" />
              <IconButton label="Remove line" size="sm" variant="ghost" disabled={lines.length === 1} onClick={() => setLines((x) => x.filter((_, j) => j !== i))} className="col-start-2 row-start-2 justify-self-end sm:col-start-auto sm:row-start-auto">
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <Field label="GST" className="sm:w-40">
            <Select aria-label="GST rate" value={String(f.gst_pct)} onChange={(e) => set('gst_pct', Number(e.target.value))} options={[0, 5, 12, 18, 28].map((g) => ({ value: String(g), label: `${g}%` }))} />
          </Field>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-[13px] sm:text-right">
            <dt className="text-ink-3">Subtotal</dt><dd className="tnum text-right">{fmtMoney(sub)}</dd>
            <dt className="text-ink-3">GST {f.gst_pct}%</dt><dd className="tnum text-right">{fmtMoney(gst)}</dd>
            <dt className="font-semibold">Total</dt><dd className="tnum text-right font-semibold">{fmtMoney(sub + gst)}</dd>
          </dl>
        </div>
      </div>
      <Field label="Justification" className="mt-4" error={fe.errors.justification} hint="Required (15+ characters) when the PO takes the category over its budget.">
        <Textarea value={f.justification} onChange={(e) => set('justification', e.target.value)} placeholder="Why this purchase can’t wait for the next budget" invalid={!!fe.errors.justification} rows={2} />
      </Field>
    </Dialog>
  )
}

function BillDialog({ po, pos, meta, onClose }: { po: PORow | null; pos: PORow[]; meta: SpendMeta; onClose: () => void }) {
  const [f, setF] = useState({
    vendor_id: po?.vendor_id ?? '',
    po_id: po?.id ?? null as string | null,
    number: '',
    bill_date: meta.today,
    amount_paise: po ? po.balance_paise : 0,
    gst_paise: po ? Math.round((po.balance_paise * po.gst_pct) / 100) : 0,
    tds_paise: 0,
    category: '',
    description: '',
  })
  const [file, setFile] = useState<FileInput | null>(null)
  const fe = useFieldErrors()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const vendorPOs = useMemo(() => pos.filter((p) => p.vendor_id === f.vendor_id && (p.status === 'approved' || p.id === f.po_id)), [pos, f.vendor_id, f.po_id])
  const selPO = pos.find((p) => p.id === f.po_id) ?? null
  const vendor = meta.vendors.find((v) => v.id === f.vendor_id)
  const save = useMut(() => spendApi.createBill({ ...f, category: f.po_id ? null : f.category || vendor?.category || null, file }), { invalidate: SPEND_INVALIDATE, success: 'Bill recorded', onSuccess: onClose, onError: (e) => fe.take(e) })
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record vendor bill"
      description="Bills against a PO may exceed it by at most 5%. The due date follows the vendor’s payment terms."
      footer={<Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending}>Record bill</Button>}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor" required error={fe.errors.vendor_id}>
          <Combobox value={f.vendor_id || null} onChange={(v) => { set('vendor_id', v ?? ''); set('po_id', null) }} placeholder="Choose vendor" options={meta.vendors.map((v) => ({ value: v.id, label: v.name, hint: v.category }))} invalid={!!fe.errors.vendor_id} />
        </Field>
        <Field label="Against PO" error={fe.errors.po_id} hint={selPO ? `PO ${fmtMoney(selPO.amount_paise)} before GST · ${fmtMoney(selPO.billed_paise)} billed` : 'Leave empty for a direct bill (rent, utilities).'}>
          <Select
            aria-label="Purchase order"
            value={f.po_id ?? ''}
            onChange={(e) => {
              const p = pos.find((x) => x.id === e.target.value)
              setF((x) => ({ ...x, po_id: p?.id ?? null, amount_paise: p ? p.balance_paise : x.amount_paise, gst_paise: p ? Math.round((p.balance_paise * p.gst_pct) / 100) : x.gst_paise }))
            }}
            options={[{ value: '', label: 'Direct bill (no PO)' }, ...vendorPOs.map((p) => ({ value: p.id, label: `${p.number} · ${fmtMoneyCompact(p.amount_paise)}` }))]}
            disabled={!f.vendor_id}
          />
        </Field>
        <Field label="Bill number" required error={fe.errors.number}>
          <Input value={f.number} onChange={(e) => set('number', e.target.value)} placeholder="As printed on the invoice" invalid={!!fe.errors.number} />
        </Field>
        <Field label="Bill date" required error={fe.errors.bill_date} hint={vendor ? `Due ${fmtDate(addDays(f.bill_date || meta.today, vendor.payment_terms_days))} (${vendor.payment_terms_days} days)` : undefined}>
          <Input type="date" value={f.bill_date} max={meta.today} onChange={(e) => set('bill_date', e.target.value)} invalid={!!fe.errors.bill_date} />
        </Field>
        <Field label="Amount before GST" required error={fe.errors.amount_paise}>
          <MoneyInput value={f.amount_paise} onChange={(v) => set('amount_paise', v)} invalid={!!fe.errors.amount_paise} />
        </Field>
        <Field label="GST amount" error={fe.errors.gst_paise}>
          <MoneyInput value={f.gst_paise} onChange={(v) => set('gst_paise', v)} />
        </Field>
        <Field label="TDS deducted" error={fe.errors.tds_paise} hint="Withheld and paid to the government.">
          <MoneyInput value={f.tds_paise} onChange={(v) => set('tds_paise', v)} />
        </Field>
        {!f.po_id ? (
          <Field label="Budget category">
            <Select aria-label="Budget category" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder={vendor ? `${vendor.category} (vendor default)` : 'Choose…'} options={meta.budget_categories} />
          </Field>
        ) : (
          <div className="flex items-end">
            <p className="text-[12.5px] text-ink-3">Net payable {fmtMoney(f.amount_paise + f.gst_paise - f.tds_paise)}</p>
          </div>
        )}
        <Field label="Bill copy" className="sm:col-span-2">
          <FileUpload accept="application/pdf,image/png,image/jpeg" label="Attach the vendor invoice" file={file ? { name: file.name, size: file.size_bytes } : null} onClear={() => setFile(null)} onFile={async (fl) => setFile(await readFile(fl))} />
        </Field>
      </div>
      {selPO && f.amount_paise > selPO.balance_paise && (
        <Callout tone={f.amount_paise + selPO.billed_paise > selPO.amount_paise * 1.05 ? 'danger' : 'warning'} className="mt-4">
          This bill takes {selPO.number} to {fmtNum(((f.amount_paise + selPO.billed_paise) / selPO.amount_paise) * 100, 1)}% of the PO value. Above 105% it is refused.
        </Callout>
      )}
    </Dialog>
  )
}

function VendorDialog({ row, checked, onClose }: { row: VendorRow | null; checked: boolean; onClose: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? '', category: row?.category ?? '', gstin: row?.gstin ?? '', pan: row?.pan ?? '', contact: row?.contact ?? '', email: row?.email ?? '', phone: row?.phone ?? '', payment_terms_days: row?.payment_terms_days ?? 30,
    bank_name: row?.bank_name ?? '', bank_account: row?.bank_account ?? '', ifsc: row?.ifsc ?? '',
  })
  const fe = useFieldErrors()
  const meta = useSpendMeta()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  // Vendor create and tax / bank edits are maker-checked: the response is applied or pending.
  const save = useMut(() => guarded<VendorRow>(row ? 'PATCH' : 'POST', row ? `/vendors/${row.id}` : '/vendors', f, row?.version), {
    invalidate: [...SPEND_INVALIDATE, ['spend-meta'], ['changes']],
    onSuccess: (r) => {
      announce(r, row ? 'Vendor saved' : 'Vendor added')
      onClose()
    },
    onError: (e) => fe.take(e),
  })
  const gstOk = !f.gstin || GSTIN_RE.test(f.gstin.toUpperCase())
  const panOk = !f.pan || PAN_RE.test(f.pan.toUpperCase())
  const sensitiveChanged = !row || (['gstin', 'pan', 'bank_name', 'bank_account', 'ifsc'] as const).some((k) => String(f[k] ?? '') !== String(row[k] ?? ''))
  const pend = row?.pending_change ?? null
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Edit ${row.name}` : 'Add vendor'}
      description={checked ? (row ? 'Changes to GSTIN, PAN or bank details are applied after a second person approves them.' : 'A new vendor is added after a second person approves it.') : undefined}
      footer={<Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!!pend}>{checked && sensitiveChanged ? 'Send for approval' : row ? 'Save vendor' : 'Add vendor'}</Button>}
    >
      {pend && <PendingNote p={pend} what="A change to this vendor is" className="mb-4" />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Vendor name" required error={fe.errors.name} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} invalid={!!fe.errors.name} />
        </Field>
        <Field label="Default budget category">
          <Select aria-label="Category" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Choose…" options={meta.data?.budget_categories ?? []} />
        </Field>
        <Field label="Payment terms" error={fe.errors.payment_terms_days}>
          <Input type="number" min={0} max={180} suffix="days" value={String(f.payment_terms_days)} onChange={(e) => set('payment_terms_days', Number(e.target.value))} invalid={!!fe.errors.payment_terms_days} />
        </Field>
        <Field label="GSTIN" error={fe.errors.gstin ?? (gstOk ? null : 'GSTIN is 15 characters, e.g. 21AAKFM9876Q1ZP.')} hint="Leave empty if the vendor is not GST-registered.">
          <Input value={f.gstin} maxLength={15} onChange={(e) => { const g = e.target.value.toUpperCase(); set('gstin', g); if (g.length === 15 && !f.pan) set('pan', g.slice(2, 12)) }} className="tnum uppercase" invalid={!!fe.errors.gstin || !gstOk} />
        </Field>
        <Field label="PAN" error={fe.errors.pan ?? (panOk ? null : 'PAN is 10 characters, e.g. AAKFM9876Q.')}>
          <Input value={f.pan} maxLength={10} onChange={(e) => set('pan', e.target.value.toUpperCase())} className="tnum uppercase" invalid={!!fe.errors.pan || !panOk} />
        </Field>
        <Field label="Contact person">
          <Input value={f.contact} onChange={(e) => set('contact', e.target.value)} />
        </Field>
        <Field label="Phone">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" />
        </Field>
        <Field label="Email" error={fe.errors.email} className="sm:col-span-2">
          <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} invalid={!!fe.errors.email} />
        </Field>
        <div className="border-t border-line pt-3 sm:col-span-2">
          <h3 className="text-[13.5px] font-semibold text-ink">Bank account for payments</h3>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Used when paying bills. Check it against a cancelled cheque or the vendor’s letterhead.</p>
        </div>
        <Field label="Bank" error={fe.errors.bank_name}>
          <Input value={f.bank_name} onChange={(e) => set('bank_name', e.target.value)} invalid={!!fe.errors.bank_name} placeholder="e.g. HDFC Bank" />
        </Field>
        <Field label="IFSC" error={fe.errors.ifsc}>
          <Input value={f.ifsc} maxLength={11} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} className="tnum uppercase" invalid={!!fe.errors.ifsc} placeholder="HDFC0001234" />
        </Field>
        <Field label="Account number" error={fe.errors.bank_account} className="sm:col-span-2">
          <Input value={f.bank_account} inputMode="numeric" maxLength={20} onChange={(e) => set('bank_account', e.target.value.replace(/[^0-9]/g, ''))} className="tnum" invalid={!!fe.errors.bank_account} />
        </Field>
      </div>
    </Dialog>
  )
}
