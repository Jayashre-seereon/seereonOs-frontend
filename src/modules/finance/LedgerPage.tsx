// UI-31 Ledger: income & expense entries with filters, recurring expansion, totals, add/edit/delete, export.
import { useEffect, useMemo, useState } from 'react'
import { Download, Lock, MoreHorizontal, Pencil, Plus, Repeat, Trash2 } from '@/ui/icons'
import {
  Badge, Button, Card, Combobox, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, Menu, Money, MoneyInput, PageHeader, SearchInput, Segmented, Select, SkeletonRows, StatCard, Switch, Callout, useCan, useConfirm, useReadOnly, SkeletonCards, type Column,
} from '@/ui'
import { useMut } from '@/api/query'
import { FINANCE_INVALIDATE, financeApi, useLedger, useLedgerEntries, useProjectsLite, type LedgerEntryRow, type LedgerInput, type LedgerRow } from '@/api/finance'
import { STREAM } from '@/domain/labels'
import { fmtMoneyCompact } from '@/domain/money'
import { addDays, addMonths, fmtDate, monthOf, monthRange, todayISO, fyRange, fyStartYear } from '@/domain/calendar'
import { exportTable } from '@/reports/export'
import { storage } from '@/lib/storage'
import { fmtMoney } from '@/domain/money'
import { cn } from '@/lib/utils'
import type { ApiError } from '@/api/http'
import type { LedgerKind, RevenueStream } from '@/types/entities'

type Preset = 'this_month' | 'last_month' | 'this_q' | 'last_3' | 'fy' | 'last_12' | 'custom'
function presetRange(p: Preset): { from: string; to: string } {
  const t = todayISO()
  const m = monthRange(monthOf(t))
  switch (p) {
    case 'this_month':
      return m
    case 'last_month':
      return monthRange(monthOf(addMonths(m.from, -1)))
    case 'this_q': {
      const d = new Date(t)
      const qStartMonth = Math.floor(d.getMonth() / 3) * 3
      const from = `${d.getFullYear()}-${String(qStartMonth + 1).padStart(2, '0')}-01`
      return { from, to: addDays(addMonths(from, 3), -1) }
    }
    case 'last_3':
      return { from: addMonths(m.from, -2), to: m.to }
    case 'fy':
      return fyRange(fyStartYear(t))
    case 'last_12':
      return { from: addMonths(m.from, -11), to: m.to }
    default:
      return m
  }
}
const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'info' }> = { received: { label: 'Received', tone: 'success' }, paid: { label: 'Paid', tone: 'success' }, expected: { label: 'Expected', tone: 'warning' } }

const VIEW_KEY = 'seereonos.ledger.view'

export default function LedgerPage() {
  const can = useCan()
  const readOnly = useReadOnly()
  const canEdit = can('finance.edit') && !readOnly
  const [view, setViewState] = useState<'entries' | 'month'>(() => storage.get(VIEW_KEY, 'entries'))
  const setView = (v: 'entries' | 'month') => {
    setViewState(v)
    storage.set(VIEW_KEY, v)
  }
  const [preset, setPreset] = useState<Preset>('this_month')
  const [custom, setCustom] = useState(presetRange('this_month'))
  const range = preset === 'custom' ? custom : presetRange(preset)
  const [kind, setKind] = useState<'' | LedgerKind>('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [project, setProject] = useState<string | null>(null)
  const [stream, setStream] = useState('')
  const [q, setQ] = useState('')
  const filters = { from: range.from, to: range.to, kind: kind || undefined, category: category || undefined, status: status || undefined, project_id: project || undefined, stream: stream || undefined, q: q || undefined }
  const ledger = useLedger(filters)
  const projects = useProjectsLite()
  const [editing, setEditing] = useState<LedgerRow | null>(null)
  const [adding, setAdding] = useState<LedgerKind | null>(null)
  const { confirm } = useConfirm()
  const del = useMut((r: LedgerRow) => financeApi.removeLedger(r.id, r.version), { invalidate: FINANCE_INVALIDATE, success: 'Entry deleted' })
  const d = ledger.data
  const cats = useMemo(() => (d ? (kind === 'income' ? d.categories.income : kind === 'expense' ? d.categories.expense : [...new Set([...d.categories.income, ...d.categories.expense])].sort()) : []), [d, kind])
  const anyFilter = !!(kind || category || status || project || stream || q)

  const remove = async (r: LedgerRow) => {
    if (r.locked) return
    const ok = await confirm({
      title: 'Delete this entry?',
      body: r.recurring ? `“${r.description}” repeats monthly. Deleting removes every month, past and future. To stop it from a date, edit it and set an end date instead.` : `“${r.description}” (${fmtMoneyCompact(r.amount_paise)}) is removed from the ledger and the P&L.`,
      confirmLabel: 'Delete entry',
      tone: 'danger',
    })
    if (ok) del.mutate(r)
  }

  const doExport = (format: 'pdf' | 'xlsx') => {
    if (!d) return
    exportTable(
      {
        title: 'Ledger',
        subtitle: `${fmtDate(d.from, 'long')} – ${fmtDate(d.to, 'long')}`,
        orientation: 'landscape',
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'string' }, { key: 'category', label: 'Category', type: 'string' }, { key: 'description', label: 'Description', type: 'string' },
          { key: 'project', label: 'Project', type: 'string' }, { key: 'stream', label: 'Stream', type: 'string' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'income', label: 'Income', type: 'money' }, { key: 'expense', label: 'Expense', type: 'money' },
        ],
        rows: d.items.map((r) => ({
          date: r.date, kind: r.kind === 'income' ? 'Income' : 'Expense', category: r.category, description: r.description + (r.recurring ? ' (monthly)' : ''), project: r.project_code ? `${r.project_code} ${r.project_name}` : '',
          stream: r.stream ? STREAM[r.stream] : '', status: STATUS_LABEL[r.status].label, income: r.kind === 'income' ? r.amount_paise : null, expense: r.kind === 'expense' ? r.amount_paise : null,
        })),
        totals: { income: d.totals.income, expense: d.totals.expense },
        kpis: [{ label: 'Income', value: fmtMoneyCompact(d.totals.income) }, { label: 'Expense', value: fmtMoneyCompact(d.totals.expense) }, { label: 'Net', value: fmtMoneyCompact(d.totals.net) }],
      },
      format,
    )
  }

  const cols: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', sortValue: (r) => r.date, cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(r.date)}</span>, width: '92px' },
    {
      key: 'desc', header: 'Description', sortValue: (r) => r.description.toLowerCase(),
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-ink">{r.description}</span>
            {r.recurring && <Repeat className="size-3.5 shrink-0 text-ink-3" aria-label="Repeats monthly" />}
            {r.locked && <Lock className="size-3.5 shrink-0 text-ink-3" aria-label="From an invoice" />}
          </div>
          <div className="truncate text-[12px] text-ink-3">
            {r.category}
            {r.project_code && ` · ${r.project_code}`}
            {r.stream && ` · ${STREAM[r.stream]}`}
          </div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <Badge tone={STATUS_LABEL[r.status].tone} size="sm">{STATUS_LABEL[r.status].label}</Badge>, hideBelow: 'lg' },
    {
      key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => (r.kind === 'income' ? r.amount_paise : -r.amount_paise),
      cell: (r) => <Money value={r.kind === 'income' ? r.amount_paise : -r.amount_paise} className={cn('font-medium', r.kind === 'income' ? 'text-ink' : 'text-ink-2')} />,
    },
    {
      key: 'act', header: '', align: 'right', width: '48px',
      cell: (r) => (canEdit ? <RowMenu r={r} onEdit={() => setEditing(r)} onDelete={() => remove(r)} /> : null),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Ledger"
        subtitle="Income and costs outside project milestones: SAP consulting, subscriptions, rent, tools. Milestone invoices add their income automatically."
        actions={
          <>
            <Menu
              label="Export"
              trigger={<Button icon={<Download className="size-4" />} disabled={!d?.items.length}>Export</Button>}
              items={[{ label: 'PDF', onSelect: () => doExport('pdf') }, { label: 'Excel', onSelect: () => doExport('xlsx') }]}
            />
            {canEdit && (
              <Menu
                label="Add entry"
                trigger={<Button variant="primary" icon={<Plus className="size-4" />} className="flex-1 md:flex-none">Add entry</Button>}
                items={[
                  { label: 'Income', onSelect: () => setAdding('income') },
                  { label: 'Expense', onSelect: () => setAdding('expense') },
                ]}
              />
            )}
          </>
        }
      />
      {!can('finance.edit') && <Callout tone="info" className="mb-4">You can view the ledger. Only an admin can add or change entries.</Callout>}

      <Segmented
        className="mb-4"
        value={view}
        onChange={setView}
        options={[{ value: 'entries', label: 'Entries' }, { value: 'month', label: 'By month' }]}
      />

      {view === 'entries' ? (
        <EntriesView canEdit={canEdit} onAdd={() => setAdding('income')} onEdit={(r) => setEditing(r)} />
      ) : (
      <>
      {/* Range */}
      <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between">
        <Segmented
          size="sm"
          value={preset}
          onChange={setPreset}
          options={[
            { value: 'this_month', label: 'This month' }, { value: 'last_month', label: 'Last month' }, { value: 'last_3', label: '3 months' }, { value: 'fy', label: 'This FY' }, { value: 'last_12', label: '12 months' }, { value: 'custom', label: 'Custom' },
          ]}
        />
        {preset === 'custom' && (
          <div className="grid grid-cols-2 gap-2">
            <Input type="date" aria-label="From" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            <Input type="date" aria-label="To" value={custom.to} min={custom.from} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
          </div>
        )}
      </div>

      {/* Totals */}
      <div className="mt-4">
        {ledger.isLoading ? (
          <SkeletonCards n={4} />
        ) : d ? (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Income" value={fmtMoneyCompact(d.totals.income)} sub={d.totals.expected_in ? `${fmtMoneyCompact(d.totals.expected_in)} still expected` : 'All received'} />
            <StatCard label="Expense" value={fmtMoneyCompact(d.totals.expense)} sub={d.totals.expected_out ? `${fmtMoneyCompact(d.totals.expected_out)} due` : 'All paid'} />
            <StatCard label="Net" tone={d.totals.net >= 0 ? 'success' : 'danger'} value={fmtMoneyCompact(d.totals.net)} sub={`${fmtDate(d.from)} – ${fmtDate(d.to)}`} />
            <StatCard label="Entries" value={d.totals.count} sub={anyFilter ? 'Matching filters' : 'In this range'} />
          </div>
        ) : null}
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search description or category" className="w-full sm:w-64 sm:flex-none" />
        <div className="grid w-full grid-cols-2 gap-2 sm:contents">
          <Select aria-label="Type" value={kind} onChange={(e) => { setKind(e.target.value as '' | LedgerKind); setCategory('') }} options={[{ value: '', label: 'Income & expense' }, { value: 'income', label: 'Income' }, { value: 'expense', label: 'Expense' }]} className="sm:w-40" />
          <Select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={[{ value: '', label: 'All categories' }, ...cats.map((c) => ({ value: c, label: c }))]} className="sm:w-44" />
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, { value: 'expected', label: 'Expected' }, { value: 'received', label: 'Received' }, { value: 'paid', label: 'Paid' }]} className="sm:w-36" />
          <Select aria-label="Stream" value={stream} onChange={(e) => setStream(e.target.value)} options={[{ value: '', label: 'All streams' }, ...Object.entries(STREAM).map(([value, label]) => ({ value, label }))]} className="sm:w-40" />
          <div className="col-span-2 min-w-0 sm:w-56">
            <Combobox value={project} onChange={setProject} clearable placeholder="Any project" options={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.code} ${p.name}`, hint: p.client }))} />
          </div>
        </div>
      </div>

      <div className="mt-4">
        <DataTable
          rows={d?.items}
          loading={ledger.isLoading}
          error={ledger.error}
          onRetry={() => ledger.refetch()}
          columns={cols}
          rowKey={(r) => r.key}
          initialSort={{ key: 'date', dir: 'desc' }}
          dense
          onRowClick={canEdit ? (r) => setEditing(r) : undefined}
          empty={
            anyFilter ? (
              <EmptyState title="No entries match" body="Clear a filter or widen the date range." compact />
            ) : (
              <EmptyState title="Nothing in this range" body="Record consulting income, subscriptions, salaries and overheads so the P&L is complete." action={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding('income')}>Add income</Button>} />
            )
          }
          mobileCard={(r) => (
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-start gap-1.5">
                  <span className="line-clamp-2 min-w-0 break-words text-[14px] font-medium leading-snug">{r.description}</span>
                  {r.recurring && <Repeat className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-label="Repeats monthly" />}
                  {r.locked && <Lock className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-label="From an invoice" />}
                </div>
                <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{fmtDate(r.date)} · {r.category}</div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <Money value={r.kind === 'income' ? r.amount_paise : -r.amount_paise} className={cn('text-[14px] font-semibold', r.kind === 'income' ? 'text-ink' : 'text-ink-2')} />
                <Badge tone={STATUS_LABEL[r.status].tone} size="sm">{STATUS_LABEL[r.status].label}</Badge>
              </div>
            </div>
          )}
          footer={
            d && d.items.length > 0 ? (
              <tr>
                <td className="px-3 py-2.5 pl-4 text-[12.5px] font-semibold text-ink" colSpan={2}>Net for {d.items.length} entries</td>
                <td className="hidden lg:table-cell" />
                <td className="border-t-2 border-double border-line-strong px-3 text-right"><Money value={d.totals.net} className={cn('font-semibold', d.totals.net < 0 && 'text-danger-text')} /></td>
                <td />
              </tr>
            ) : undefined
          }
        />
      </div>
      </>
      )}

      <EntryDialog open={!!adding || !!editing} kind={editing?.kind ?? adding ?? 'income'} entry={editing} onClose={() => { setAdding(null); setEditing(null) }} categories={d?.categories} />
    </div>
  )
}

function RowMenu({ r, onEdit, onDelete }: { r: LedgerRow; onEdit: () => void; onDelete: () => void }) {
  return (
    <span onClick={(e) => e.stopPropagation()}>
      <Menu
        label="Entry actions"
        trigger={<IconButton size="sm" label="Entry actions"><MoreHorizontal className="size-4" /></IconButton>}
        items={[
          { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
          { label: r.locked ? 'Delete (from invoice)' : 'Delete', icon: <Trash2 />, danger: !r.locked, disabled: r.locked, hint: r.locked ? 'Locked' : undefined, onSelect: onDelete },
        ]}
      />
    </span>
  )
}

/* ------------------------------------------------------------------ */
/* Entries (G13.02): one line per entry, recurring ones once           */
/* ------------------------------------------------------------------ */
function entryLine(r: LedgerEntryRow) {
  const parts = [r.kind === 'income' ? 'Income' : 'Expense', r.category, `${fmtMoney(r.amount_paise)}${r.recurring ? ' per month' : ''}`, `from ${fmtDate(r.date)}`]
  if (r.recurring && r.until_on) parts.push(`until ${fmtDate(r.until_on)}`)
  if (!r.recurring) {
    if (r.kind === 'income') parts.push(r.status === 'received' ? 'received' : 'awaiting payment')
    else if (r.status === 'expected') parts.push('due')
  } else if (r.run_state === 'ended') parts.push('ended')
  return parts.join(', ')
}
const asRow = (r: LedgerEntryRow): LedgerRow => ({
  key: r.id, id: r.id, version: r.version, kind: r.kind, category: r.category, description: r.description, amount_paise: r.amount_paise, date: r.date, origin_date: r.date, recurring: r.recurring,
  until_on: r.until_on, status: r.status, project_id: r.project_id, project_name: null, project_code: r.project_code, invoice_id: null, stream: r.stream, locked: false,
})

function EntriesView({ canEdit, onAdd, onEdit }: { canEdit: boolean; onAdd: () => void; onEdit: (r: LedgerRow) => void }) {
  const [scope, setScope] = useState<'fy' | 'all'>('fy')
  const q = useLedgerEntries(scope)
  const { confirm } = useConfirm()
  const del = useMut((r: LedgerEntryRow) => financeApi.removeLedger(r.id, r.version), { invalidate: FINANCE_INVALIDATE, success: 'Entry removed' })
  const received = useMut((r: LedgerEntryRow) => financeApi.updateLedger(r.id, { status: 'received' }, r.version), { invalidate: FINANCE_INVALIDATE, success: 'Marked received' })
  const d = q.data
  const remove = async (r: LedgerEntryRow) => {
    const ok = await confirm({
      title: `Remove “${r.description}”?`,
      body: r.recurring ? `It repeats monthly from ${fmtDate(r.date)}. Removing it takes every month out of the ledger and the P&L. To stop it from a date instead, edit it and set an end date.` : `${fmtMoney(r.amount_paise)} is taken out of the ledger and the P&L.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (ok) del.mutate(r)
  }
  return (
    <div className="space-y-4">
      <Card pad={false} className="overflow-hidden">
        <div className="flex flex-col gap-2 px-4 pb-3 pt-4 sm:flex-row sm:items-center sm:justify-between md:px-5">
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-ink">Entries</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-3">{scope === 'fy' ? `Active in ${d?.fy_label ?? 'this FY'}` : 'Every entry ever recorded'} · newest first</p>
          </div>
          <Segmented size="sm" value={scope} onChange={setScope} options={[{ value: 'fy', label: 'This FY' }, { value: 'all', label: 'All' }]} />
        </div>
        {q.isLoading ? (
          <div className="border-t border-line p-5"><SkeletonRows rows={5} /></div>
        ) : q.error || !d ? (
          <div className="border-t border-line p-5"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
        ) : !d.items.length ? (
          <div className="border-t border-line">
            <EmptyState title="No ledger entries" body="Add consulting retainers, subscriptions, rent and tools. A monthly entry is entered once and repeats until its end date." action={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} onClick={onAdd}>Add an entry</Button>} compact />
          </div>
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {d.items.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 md:px-5">
                <button type="button" className="min-w-0 flex-1 text-left disabled:cursor-default" onClick={() => canEdit && onEdit(asRow(r))} disabled={!canEdit}>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-words text-[14px] font-semibold text-ink">{r.description}</span>
                    {r.recurring && <Repeat className="size-3.5 shrink-0 text-ink-3" aria-label="Repeats monthly" />}
                    {r.run_state === 'upcoming' && <Badge tone="info" size="sm">Starts {fmtDate(r.date)}</Badge>}
                    {!r.recurring && r.kind === 'income' && r.status === 'expected' && <Badge tone="warning" size="sm">Awaiting payment</Badge>}
                  </div>
                  <p className="mt-0.5 break-words text-[12.5px] text-ink-3">{entryLine(r)}</p>
                  {r.recurring && r.months > 0 && <p className="tnum mt-0.5 text-[12px] text-ink-3">{r.months} {r.months === 1 ? 'month' : 'months'} in {scope === 'fy' ? d.fy_label : 'the books'} · {fmtMoney(r.booked_paise)}</p>}
                </button>
                {canEdit && (
                  <div className="flex shrink-0 gap-2">
                    {!r.recurring && r.kind === 'income' && r.status === 'expected' && (
                      <Button size="sm" onClick={() => received.mutate(r)} loading={received.isPending && received.variables?.id === r.id}>Mark received</Button>
                    )}
                    <Button size="sm" onClick={() => remove(r)} loading={del.isPending && del.variables?.id === r.id}>Remove</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && d && d.items.length > 0 && (
          <div className="border-t border-line px-4 py-3 md:px-5">
            <Button icon={<Plus className="size-4" />} onClick={onAdd} className="w-full sm:w-auto">Add an entry</Button>
          </div>
        )}
      </Card>
      {d && (
        <Card>
          <h2 className="text-[14px] font-semibold text-ink">Added automatically</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">These rows come from other screens and change there. See them month by month under By month.</p>
          <ul className="mt-3 divide-y divide-line">
            {d.automatic.map((a) => (
              <li key={a.key} className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
                <span className="min-w-0 text-ink-2">{a.label} <span className="tnum text-ink-3">({a.count})</span></span>
                <span className="tnum shrink-0 font-medium">{fmtMoney(a.amount)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
function EntryDialog({ open, kind, entry, onClose, categories }: { open: boolean; kind: LedgerKind; entry: LedgerRow | null; onClose: () => void; categories?: { income: string[]; expense: string[] } }) {
  const empty = (k: LedgerKind): LedgerInput => ({ kind: k, category: k === 'income' ? 'Consulting' : 'Tools & software', description: '', amount_paise: 0, date: todayISO(), recurring: false, until_on: null, status: 'received', project_id: null, stream: k === 'income' ? 'sap_consulting' : null })
  const [f, setF] = useState<LedgerInput>(empty(kind))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const projects = useProjectsLite()
  useEffect(() => {
    if (!open) return
    setErrors({})
    if (entry) setF({ kind: entry.kind, category: entry.category, description: entry.description, amount_paise: entry.amount_paise, date: entry.origin_date, recurring: entry.recurring, until_on: entry.until_on, status: entry.status, project_id: entry.project_id, stream: entry.stream })
    else setF({ ...empty(kind), status: kind === 'income' ? 'received' : 'paid' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry, kind])
  const set = <K extends keyof LedgerInput>(k: K, v: LedgerInput[K]) => {
    setF((x) => ({ ...x, [k]: v }))
    setErrors((e) => ({ ...e, [k]: '' }))
  }
  const onErr = (e: ApiError) => e.field && setErrors((x) => ({ ...x, [e.field!]: e.message }))
  const add = useMut((b: LedgerInput) => financeApi.addLedger(b), { invalidate: FINANCE_INVALIDATE, success: 'Entry added', onSuccess: onClose, onError: onErr })
  const save = useMut((b: LedgerInput) => financeApi.updateLedger(entry!.id, b, entry!.version), { invalidate: FINANCE_INVALIDATE, success: 'Entry updated', onSuccess: onClose, onError: onErr })
  const locked = !!entry?.locked
  const submit = () => {
    const e: Record<string, string> = {}
    if (!f.category) e.category = 'Choose a category.'
    if (f.description.trim().length < 3) e.description = 'Describe the entry (at least 3 characters).'
    if (!f.amount_paise || f.amount_paise <= 0) e.amount_paise = 'Enter an amount above zero.'
    if (!f.date) e.date = 'Pick a date.'
    if (f.recurring && f.until_on && f.until_on < f.date) e.until_on = 'The end must be on or after the first date.'
    setErrors(e)
    if (Object.values(e).some(Boolean)) return
    const body = { ...f, description: f.description.trim(), until_on: f.recurring ? f.until_on || null : null, stream: f.kind === 'income' ? f.stream : null }
    if (entry) save.mutate(locked ? ({ category: body.category, description: body.description, stream: body.stream } as LedgerInput) : body)
    else add.mutate(body)
  }
  const cats = f.kind === 'income' ? categories?.income ?? [] : categories?.expense ?? []
  const statusOpts = f.kind === 'income' ? [{ value: 'received', label: 'Received' }, { value: 'expected', label: 'Expected' }] : [{ value: 'paid', label: 'Paid' }, { value: 'expected', label: 'Expected (due)' }]
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={entry ? 'Edit entry' : f.kind === 'income' ? 'Add income' : 'Add expense'}
      description={locked ? 'Created by a milestone invoice. Amount, date and status follow the invoice.' : entry?.recurring ? 'Changes apply to every month of this repeating entry.' : undefined}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending || save.isPending} onClick={submit}>
            {entry ? 'Save changes' : f.kind === 'income' ? 'Add income' : 'Add expense'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!entry && (
          <Segmented
            block
            className="sm:col-span-2"
            value={f.kind}
            onChange={(k) => setF({ ...empty(k), description: f.description, amount_paise: f.amount_paise, date: f.date, status: k === 'income' ? 'received' : 'paid' })}
            options={[{ value: 'income', label: 'Income' }, { value: 'expense', label: 'Expense' }]}
          />
        )}
        <Field label="Description" required error={errors.description} className="sm:col-span-2">
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={f.kind === 'income' ? 'e.g. SAP CPI consulting — ZooPlus' : 'e.g. Office rent — Khandagiri'} invalid={!!errors.description} />
        </Field>
        <Field label="Category" required error={errors.category}>
          <Select value={f.category} onChange={(e) => set('category', e.target.value)} options={cats.includes(f.category) ? cats : [f.category, ...cats]} />
        </Field>
        <Field label={f.recurring ? 'Amount per month' : 'Amount'} required error={errors.amount_paise}>
          <MoneyInput value={f.amount_paise} onChange={(v) => set('amount_paise', v)} invalid={!!errors.amount_paise} disabled={locked} />
        </Field>
        <Field label={f.recurring ? 'First date' : 'Date'} required error={errors.date}>
          <Input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} disabled={locked} invalid={!!errors.date} />
        </Field>
        <Field label="Status" error={errors.status} hint={f.recurring ? 'Repeating rows are received/paid once their date passes.' : undefined}>
          <Select value={f.status} onChange={(e) => set('status', e.target.value as LedgerInput['status'])} options={statusOpts} disabled={locked || f.recurring} />
        </Field>
        {f.kind === 'income' && (
          <Field label="Revenue stream" error={errors.stream}>
            <Select value={f.stream ?? ''} onChange={(e) => set('stream', (e.target.value || null) as RevenueStream | null)} options={[{ value: '', label: 'Unassigned' }, ...Object.entries(STREAM).map(([value, label]) => ({ value, label }))]} />
          </Field>
        )}
        <Field label="Project (optional)" error={errors.project_id} className={f.kind === 'expense' ? 'sm:col-span-2' : undefined}>
          <Combobox value={f.project_id} onChange={(v) => set('project_id', v)} clearable disabled={locked} placeholder="Not linked" options={(projects.data ?? []).map((p) => ({ value: p.id, label: `${p.code} ${p.name}`, hint: p.client }))} />
        </Field>
        {!locked && (
          <div className="rounded-lg border border-line p-3.5 sm:col-span-2">
            <Switch checked={f.recurring} onChange={(v) => set('recurring', v)} label="Repeats monthly" description="Shows every month from the first date until the end date (or indefinitely)." />
            {f.recurring && (
              <Field label="Ends on (optional)" error={errors.until_on} className="mt-3">
                <Input type="date" value={f.until_on ?? ''} min={f.date} onChange={(e) => set('until_on', e.target.value || null)} invalid={!!errors.until_on} />
              </Field>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
