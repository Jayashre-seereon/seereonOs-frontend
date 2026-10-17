// /assets — HR sees the whole register (assign / return / repair, history from the activity log, leavers'
// assets highlighted); everyone else sees "My assets".
import { useState } from 'react'
import { Laptop, Plus } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { hrApi, type AssetInput, type AssetView } from '@/api/hr'
import type { ApiError } from '@/api/http'
import { fmtDate, relTime, todayISO } from '@/domain/calendar'
import { fmtMoneyCompact } from '@/domain/money'
import type { Asset } from '@/types/business'
import {
  Badge, Button, Callout, Card, DataTable, Dialog, EmptyState, ErrorState, Field, FilterChips, Input, KV, Money, MoneyInput, PageHeader, PeoplePicker, SearchInput, Segmented, Select, Sheet, SkeletonCards, SkeletonRows, StatCard,
  StatusBadge, Textarea, useReadOnly, type Column,
} from '@/ui'
import { ASSET_CATEGORY, ASSET_STATUS } from './components'

const INV = [['assets'], ['asset-history'], ['lifecycle'], ['hr-dashboard']]

export default function AssetsPage() {
  const q = useApi(['assets'], hrApi.assets)
  const d = q.data
  const ro = useReadOnly()
  const [cat, setCat] = useState<'all' | Asset['category'] | 'return'>('all')
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const all = d?.mode === 'all'
  const items = (d?.items ?? []).filter((a) => (cat === 'all' ? true : cat === 'return' ? a.pending_return : a.category === cat) && (!search || `${a.tag} ${a.name} ${a.serial} ${a.assignee_name ?? ''}`.toLowerCase().includes(search.toLowerCase())))
  const sel = d?.items.find((a) => a.id === open) ?? null
  const cols: Column<AssetView>[] = [
    {
      key: 'tag', header: 'Asset', sortValue: (a) => a.tag,
      cell: (a) => (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="tnum whitespace-nowrap font-medium text-ink">{a.tag}</span>
            {a.pending_return && <Badge size="sm" tone="danger">Return due</Badge>}
          </div>
          <div className="truncate text-[12px] text-ink-3">{a.name}</div>
        </div>
      ),
    },
    { key: 'cat', header: 'Category', sortValue: (a) => a.category, cell: (a) => ASSET_CATEGORY[a.category], hideBelow: 'lg' },
    { key: 'status', header: 'Status', sortValue: (a) => a.status, cell: (a) => <StatusBadge size="sm" map={ASSET_STATUS} value={a.status} /> },
    { key: 'who', header: 'With', sortValue: (a) => a.assignee_name ?? '', cell: (a) => (a.assignee_name ? <span className="min-w-0"><span className="block truncate">{a.assignee_name}</span>{a.assignee_status === 'deactivated' && <span className="block text-[12px] text-danger-text">left the company</span>}</span> : <span className="text-ink-3">—</span>) },
    { key: 'serial', header: 'Serial', cell: (a) => <span className="tnum text-[12.5px] text-ink-2">{a.serial || '—'}</span>, hideBelow: 'xl' },
    { key: 'cost', header: 'Cost', align: 'right', sortValue: (a) => a.purchase_cost_paise, cell: (a) => <Money value={a.purchase_cost_paise} className="tnum whitespace-nowrap" />, hideBelow: 'lg' },
    { key: 'warranty', header: 'Warranty', sortValue: (a) => a.warranty_until ?? '', cell: (a) => <span className={a.warranty_expired ? 'text-warning-text' : 'text-ink-2'}>{a.warranty_until ? `${a.warranty_expired ? 'Ended' : 'Until'} ${fmtDate(a.warranty_until)}` : '—'}</span>, hideBelow: 'xl' },
  ]
  return (
    <div>
      <PageHeader
        title={all ? 'Assets' : 'My assets'}
        subtitle={all ? 'Laptops, monitors, phones and licences: who has what, and what is due back from people leaving.' : 'Company equipment and licences assigned to you. Ask HR to record any change.'}
        actions={all && !ro ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} className="w-full sm:w-auto">Add asset</Button> : undefined}
      />
      {q.isLoading ? (
        <div className="space-y-4"><SkeletonCards n={4} /><SkeletonRows rows={6} /></div>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="space-y-4 md:space-y-5">
          {all && (
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-3">
              <StatCard label="Assets" value={d.summary.total} sub={<span className="tnum">{fmtMoneyCompact(d.summary.value_paise)} in use</span>} />
              <StatCard label="Assigned" value={d.summary.assigned} sub={`${d.summary.in_stock} in stock`} />
              <StatCard label="In repair" value={d.summary.repair} tone={d.summary.repair ? 'warning' : undefined} />
              <StatCard label="Due back from leavers" value={d.summary.pending_return} tone={d.summary.pending_return ? 'danger' : 'success'} onClick={() => setCat('return')} />
            </div>
          )}
          {all && d.summary.pending_return > 0 && cat !== 'return' && (
            <Callout tone="danger" title={`${d.summary.pending_return} asset${d.summary.pending_return > 1 ? 's are' : ' is'} still with people who have left or are leaving`} action={<Button size="sm" onClick={() => setCat('return')}>Show</Button>}>
              Record the return here; the exit checklist can’t close until it is done.
            </Callout>
          )}
          {all && (
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <FilterChips
                value={cat}
                onChange={setCat}
                options={[
                  { value: 'all', label: 'All', count: d.items.length },
                  ...(['laptop', 'monitor', 'phone', 'licence', 'furniture', 'other'] as Asset['category'][]).filter((c) => d.items.some((a) => a.category === c)).map((c) => ({ value: c, label: ASSET_CATEGORY[c], count: d.items.filter((a) => a.category === c).length })),
                  ...(d.summary.pending_return ? [{ value: 'return' as const, label: 'Return due', count: d.summary.pending_return }] : []),
                ]}
              />
              <SearchInput value={search} onChange={setSearch} placeholder="Search tag, name, serial or person" className="md:w-[300px]" />
            </div>
          )}
          <DataTable
            rows={items}
            columns={all ? cols : cols.filter((c) => c.key !== 'who')}
            rowKey={(a) => a.id}
            onRowClick={(a) => setOpen(a.id)}
            initialSort={{ key: 'tag', dir: 'asc' }}
            rowClassName={(a) => (a.pending_return ? 'bg-danger-soft/40' : undefined)}
            empty={<EmptyState compact icon={<Laptop />} title={all ? 'No assets match' : 'Nothing assigned to you'} body={all ? 'Clear the filters or add an asset.' : 'When HR assigns you a laptop or licence, it appears here.'} />}
            mobileCard={(a) => (
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="tnum text-[14px] font-medium">{a.tag}</span>
                    {a.pending_return && <Badge size="sm" tone="danger">Return due</Badge>}
                  </div>
                  <div className="truncate text-[12.5px] text-ink-2">{a.name}</div>
                  <div className="truncate text-[12px] text-ink-3">{ASSET_CATEGORY[a.category]}{a.assignee_name && all ? ` · ${a.assignee_name}` : ''}{a.warranty_until ? ` · warranty ${a.warranty_expired ? 'ended' : 'until'} ${fmtDate(a.warranty_until)}` : ''}</div>
                </div>
                <StatusBadge size="sm" map={ASSET_STATUS} value={a.status} />
              </div>
            )}
          />
        </div>
      )}
      {sel && <AssetSheet a={sel} canManage={all && !ro} onClose={() => setOpen(null)} />}
      {adding && <AssetDialog onClose={() => setAdding(false)} />}
    </div>
  )
}

function AssetSheet({ a, canManage, onClose }: { a: AssetView; canManage: boolean; onClose: () => void }) {
  const h = useApi(['asset-history', a.id, a.version], () => hrApi.assetHistory(a.id))
  const [assignTo, setAssignTo] = useState<string | null>(null)
  const [ret, setRet] = useState<'in_stock' | 'repair'>('in_stock')
  const [note, setNote] = useState('')
  const [edit, setEdit] = useState(false)
  const assign = useMut(() => hrApi.assignAsset(a.id, assignTo ?? ''), { invalidate: INV, success: 'Asset assigned', onSuccess: () => setAssignTo(null) })
  const back = useMut(() => hrApi.returnAsset(a.id, { status: ret, note }), { invalidate: INV, success: 'Return recorded', onSuccess: () => setNote('') })
  const setStatus = useMut((s: Asset['status']) => hrApi.updateAsset(a.id, { status: s }, a.version), { invalidate: INV, success: 'Status updated' })
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} width={560} title={`${a.tag} · ${a.name}`} subtitle={`${ASSET_CATEGORY[a.category]}${a.serial ? ` · serial ${a.serial}` : ''}`} headerExtra={<div className="mt-2"><StatusBadge size="sm" map={ASSET_STATUS} value={a.status} /></div>} footer={canManage ? <Button onClick={() => setEdit(true)}>Edit details</Button> : undefined}>
      <div className="space-y-6">
        {a.pending_return && <Callout tone="danger" title="Return due">{a.assignee_name} {a.assignee_status === 'deactivated' ? 'has left the company' : 'is leaving'}. Collect it and record the return below.</Callout>}
        <KV
          cols={2}
          items={[
            { label: 'Assigned to', value: a.assignee_name ?? '—', hint: a.assigned_on ? `since ${fmtDate(a.assigned_on)}` : undefined },
            { label: 'Purchased', value: fmtDate(a.purchase_on, 'long') },
            { label: 'Cost', value: <Money value={a.purchase_cost_paise} className="tnum" /> },
            { label: 'Warranty', value: a.warranty_until ? `${a.warranty_expired ? 'Ended' : 'Until'} ${fmtDate(a.warranty_until)}` : 'None' },
          ]}
        />
        {a.notes && <p className="text-[13px] text-ink-2">{a.notes}</p>}
        {canManage && a.status === 'assigned' && (
          <section className="rounded-lg border border-line p-3.5">
            <h4 className="text-[13px] font-semibold">Record return</h4>
            <div className="mt-3 space-y-3">
              <Segmented block value={ret} onChange={setRet} options={[{ value: 'in_stock', label: 'Back in stock' }, { value: 'repair', label: 'Needs repair' }]} />
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Condition, charger returned, etc." />
              <div className="flex justify-end"><Button variant="primary" size="sm" loading={back.isPending} onClick={() => back.mutate(undefined)}>Record return</Button></div>
            </div>
          </section>
        )}
        {canManage && a.status === 'in_stock' && (
          <section className="rounded-lg border border-line p-3.5">
            <h4 className="text-[13px] font-semibold">Assign</h4>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <div className="min-w-0 flex-1"><PeoplePicker value={assignTo} onChange={setAssignTo} /></div>
              <Button variant="primary" disabled={!assignTo} loading={assign.isPending} onClick={() => assign.mutate(undefined)}>Assign</Button>
            </div>
          </section>
        )}
        {canManage && (a.status === 'repair' || a.status === 'in_stock') && (
          <div className="flex flex-wrap gap-2">
            {a.status === 'repair' && <Button size="sm" onClick={() => setStatus.mutate('in_stock')}>Back from repair</Button>}
            {a.status === 'in_stock' && <Button size="sm" onClick={() => setStatus.mutate('repair')}>Send for repair</Button>}
            <Button size="sm" variant="ghost" onClick={() => setStatus.mutate('retired')}>Retire</Button>
          </div>
        )}
        <section>
          <h4 className="mb-2.5 text-[13px] font-semibold text-ink-2">History</h4>
          {h.isLoading ? <SkeletonRows rows={3} /> : (h.data ?? []).length ? (
            <ul className="space-y-2">
              {h.data!.map((x, k) => (
                <li key={k} className="flex gap-3 text-[12.5px]">
                  <span className="w-16 shrink-0 text-ink-3">{relTime(x.at)}</span>
                  <span className="min-w-0 text-ink-2">{x.summary}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-ink-3">No history yet.</p>
          )}
        </section>
      </div>
      {edit && <AssetDialog a={a} onClose={() => setEdit(false)} />}
    </Sheet>
  )
}

function AssetDialog({ a, onClose }: { a?: AssetView; onClose: () => void }) {
  const [f, setF] = useState<AssetInput>({ tag: a?.tag ?? '', name: a?.name ?? '', category: a?.category ?? 'laptop', serial: a?.serial ?? '', purchase_on: a?.purchase_on ?? todayISO(), purchase_cost_paise: a?.purchase_cost_paise ?? 0, warranty_until: a?.warranty_until ?? null, notes: a?.notes ?? '' })
  const [errs, setErrs] = useState<Record<string, string>>({})
  const set = <K extends keyof AssetInput>(k: K, v: AssetInput[K]) => setF((s) => ({ ...s, [k]: v }))
  const m = useMut(() => (a ? hrApi.updateAsset(a.id, f, a.version) : hrApi.addAsset(f)), { invalidate: INV, success: a ? 'Asset saved' : 'Asset added', silentError: true, onSuccess: onClose, onError: (e: ApiError) => setErrs(e.field ? { [e.field]: e.message } : { form: e.message }) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={a ? `Edit ${a.tag}` : 'Add asset'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>{a ? 'Save asset' : 'Add asset'}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tag" required error={errs.tag} hint="e.g. SEE-LAP-012"><Input value={f.tag} invalid={!!errs.tag} onChange={(e) => set('tag', e.target.value.toUpperCase())} /></Field>
          <Field label="Category" required error={errs.category}><Select value={f.category} onChange={(e) => set('category', e.target.value as Asset['category'])} options={Object.entries(ASSET_CATEGORY).map(([value, label]) => ({ value, label }))} /></Field>
        </div>
        <Field label="Name / model" required error={errs.name}><Input value={f.name} invalid={!!errs.name} onChange={(e) => set('name', e.target.value)} placeholder="Dell Latitude 5440" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Serial number" error={errs.serial}><Input value={f.serial} onChange={(e) => set('serial', e.target.value)} /></Field>
          <Field label="Purchase cost" required error={errs.purchase_cost_paise}><MoneyInput value={f.purchase_cost_paise} onChange={(v) => set('purchase_cost_paise', v)} invalid={!!errs.purchase_cost_paise} /></Field>
          <Field label="Purchased on" required error={errs.purchase_on}><Input type="date" value={f.purchase_on} max={todayISO()} onChange={(e) => set('purchase_on', e.target.value)} /></Field>
          <Field label="Warranty until" error={errs.warranty_until}><Input type="date" value={f.warranty_until ?? ''} onChange={(e) => set('warranty_until', e.target.value || null)} /></Field>
        </div>
        <Field label="Notes"><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
        {errs.form && <Callout tone="danger">{errs.form}</Callout>}
      </div>
    </Dialog>
  )
}

