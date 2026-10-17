// Client page: revenue billed / collected / outstanding, contracts (renewals), invoices, projects,
// deals, lost revenue, expenses to re-bill and contacts.
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { FileText, MoreHorizontal, Pencil, Plus, RefreshCw } from '@/ui/icons'
import {
  Badge, Button, Callout, Card, CardHeader, DataTable, Dialog, EmptyState, ErrorState, Field, FileUpload, IconButton, Input, KV, ListGroup, ListRow, Menu, Money, MoneyInput, PageHeader,
  PeoplePicker, Select, SkeletonCards, SkeletonRows, StatCard, StatusBadge, Switch, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { useMut } from '@/api/query'
import { CLIENTS_INVALIDATE, clientsApi, useClient, type ClientDetail, type ClientInput, type ClientRow, type ContractInput, type ContractRow } from '@/api/clients'
import { readFile, useSpendMeta, type FileInput } from '@/api/spend'
import { addDays, fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtMoney, fmtMoneyCompact } from '@/domain/money'
import { DEAL_STAGE, PROJECT_STATUS } from '@/domain/labels'
import { cn } from '@/lib/utils'
import type { Contract } from '@/types/business'
import { CLIENT_HEALTH, CLIENT_STATUS, CONTRACT_KIND, CONTRACT_STATUS, EXPENSE_STATUS, LEAKAGE_STATUS } from '@/modules/spend/labels'
import { KpiRow, Meta, useFieldErrors } from '@/modules/spend/components'
import { GST_STATES } from '@/domain/gst'

export default function ClientPage() {
  const { id } = useParams()
  const q = useClient(id)
  const d = q.data
  const readOnly = useReadOnly()
  const [editing, setEditing] = useState(false)
  const [contract, setContract] = useState<ContractRow | 'new' | null>(null)
  const [renewing, setRenewing] = useState<ContractRow | null>(null)

  if (q.isLoading)
    return (
      <div>
        <PageHeader title="Client" back={{ to: '/clients', label: 'Clients' }} />
        <SkeletonCards n={4} />
        <Card className="mt-4"><SkeletonRows rows={5} /></Card>
      </div>
    )
  if (q.error || !d)
    return (
      <div>
        <PageHeader title="Client" back={{ to: '/clients', label: 'Clients' }} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    )
  const c = d.client
  return (
    <div>
      <PageHeader
        back={{ to: '/clients', label: 'Clients' }}
        title={c.name}
        subtitle={[c.industry, c.country, c.since ? `client since ${fmtDate(c.since)}` : null].filter(Boolean).join(' · ')}
        meta={
          <>
            <StatusBadge map={CLIENT_STATUS} value={c.status} />
            {c.health && <StatusBadge map={CLIENT_HEALTH} value={c.health} />}
          </>
        }
        actions={
          !readOnly && (
            <>
              <Button icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit client</Button>
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setContract('new')} className="flex-1 md:flex-none">Add contract</Button>
            </>
          )
        }
      />
      {c.health && c.health !== 'good' && c.health_reasons.length > 0 && (
        <Callout tone={c.health === 'at_risk' ? 'danger' : 'warning'} className="mb-4" title={c.health === 'at_risk' ? 'At risk' : 'Watch'}>
          {c.health_reasons.join(' · ')}
        </Callout>
      )}
      <KpiRow>
        <StatCard label="Billed" value={fmtMoneyCompact(c.billed)} sub={`${fmtMoneyCompact(c.billed_fy)} this FY`} />
        <StatCard label="Collected" value={fmtMoneyCompact(c.collected)} sub={c.billed ? `${Math.round((c.collected / c.billed) * 100)}% of billed` : '—'} />
        <StatCard label="Outstanding" value={fmtMoneyCompact(c.outstanding)} tone={c.overdue ? 'danger' : undefined} sub={c.overdue ? `${fmtMoneyCompact(c.overdue)} overdue` : 'Nothing overdue'} />
        <StatCard label="Lost revenue this FY" value={fmtMoneyCompact(c.leakage_fy)} tone={c.leakage_fy ? 'warning' : undefined} sub={`${d.leakage.length} entries`} />
      </KpiRow>

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <div className="min-w-0 space-y-4 lg:col-span-8">
          <Contracts d={d} readOnly={readOnly} onEdit={setContract} onRenew={setRenewing} />
          <Invoices d={d} />
          <Card>
            <CardHeader title="Projects" subtitle={`${d.projects.length} with ${c.name}`} />
            {d.projects.length ? (
              <ListGroup className="-mx-1 border-0">
                {d.projects.map((p) => (
                  <ListRow
                    key={p.id}
                    to={`/projects/${p.id}`}
                    className="px-1"
                    title={`${p.code} · ${p.name}`}
                    subtitle={`${p.pm_name} · ends ${fmtDate(p.end_on)}`}
                    trailing={
                      <span className="flex flex-col items-end gap-1">
                        <StatusBadge map={PROJECT_STATUS} value={p.status} size="sm" />
                        {p.contract_value_paise !== null && <span className="tnum text-[12px] text-ink-3">{fmtMoneyCompact(p.contract_value_paise)}</span>}
                      </span>
                    }
                  />
                ))}
              </ListGroup>
            ) : <EmptyState title="No projects yet" compact />}
          </Card>
          <Card>
            <CardHeader title="Deals" subtitle="Pipeline with this client" />
            {d.deals.length ? (
              <ListGroup className="-mx-1 border-0">
                {d.deals.map((x) => (
                  <ListRow
                    key={x.id}
                    to={`/sales/${x.id}`}
                    className="px-1"
                    title={x.title}
                    subtitle={x.lost_reason ? `Lost: ${x.lost_reason}` : `${x.owner_name} · close ${fmtDate(x.expected_close)}`}
                    trailing={<span className="flex flex-col items-end gap-1"><StatusBadge map={DEAL_STAGE} value={x.stage} size="sm" /><span className="tnum text-[12px] text-ink-3">{fmtMoneyCompact(x.value_paise)}</span></span>}
                  />
                ))}
              </ListGroup>
            ) : <EmptyState title="No deals" compact />}
          </Card>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-4">
          <Card>
            <CardHeader title="Details" />
            <KV
              cols={1}
              items={[
                { label: 'Account manager', value: c.owner_id ? <Link to="/people" className="hover:underline">{c.owner_name}</Link> : '—' },
                { label: 'GSTIN', value: <span className="tnum">{c.gstin || (c.country !== 'India' ? 'Overseas client' : 'Not on file')}</span> },
                { label: 'Payment terms', value: `${c.payment_terms_days} days` },
                { label: 'Billing address', value: [c.billing_address, [c.city, c.state].filter(Boolean).join(', '), c.pincode].filter(Boolean).join(' · ') || '—' },
                ...(c.state_code && c.state_code !== '96' ? [{ label: 'GST state code', value: <span className="tnum">{c.state_code}</span> }] : []),
                ...(c.pan ? [{ label: 'PAN', value: <span className="tnum">{c.pan}</span> }] : []),
              ]}
            />
          </Card>
          <Card>
            <CardHeader title="Contacts" />
            {d.contacts.length ? (
              <ul className="space-y-3">
                {d.contacts.map((p, i) => (
                  <li key={i} className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{p.name}</div>
                    <Meta>{p.role}</Meta>
                    {(p.email || p.phone) && <Meta className="tnum">{[p.email, p.phone].filter(Boolean).join(' · ')}</Meta>}
                  </li>
                ))}
              </ul>
            ) : <EmptyState title="No contacts" compact />}
          </Card>
          <Card>
            <CardHeader title="Expenses to re-bill" subtitle="Approved billable claims on this client’s projects" action={d.rebill_total ? <Money value={d.rebill_total} className="font-semibold" /> : undefined} />
            {d.rebill.length ? (
              <ul className="divide-y divide-line">
                {d.rebill.map((e) => (
                  <li key={e.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[13.5px] text-ink">{e.description}</div>
                      <Meta>{fmtDate(e.date)} · {e.person}{e.project_code ? ` · ${e.project_code}` : ''}</Meta>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Money value={e.amount_paise} className="text-[13.5px] font-medium" />
                      <StatusBadge map={EXPENSE_STATUS} value={e.status} size="sm" />
                    </div>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-3">Nothing to re-bill.</p>}
          </Card>
          <Card>
            <CardHeader title="Lost revenue" subtitle="Discounts, write-offs, penalties, lost deals" />
            {d.leakage.length ? (
              <ul className="divide-y divide-line">
                {d.leakage.map((l) => (
                  <li key={l.id} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1"><Badge size="sm">{l.kind_label}</Badge><StatusBadge map={LEAKAGE_STATUS} value={l.status} size="sm" /></div>
                      <div className="mt-1 line-clamp-2 text-[12.5px] text-ink-3">{l.reason}</div>
                    </div>
                    <Money value={l.amount_paise} className="shrink-0 text-[13.5px] font-medium" />
                  </li>
                ))}
              </ul>
            ) : <p className="text-[13px] text-ink-3">Nothing lost with this client.</p>}
          </Card>
          <Card>
            <CardHeader title="Activity" />
            {d.activity.length ? (
              <ol className="space-y-2.5 border-l border-line pl-4">
                {d.activity.map((a, i) => (
                  <li key={i} className="text-[13px]"><div className="text-ink">{a.summary}</div><div className="text-[12px] text-ink-3">{a.actor} · {fmtDateTime(a.at)}</div></li>
                ))}
              </ol>
            ) : <p className="text-[13px] text-ink-3">No changes recorded yet.</p>}
          </Card>
        </div>
      </div>
      {editing && <ClientDialog row={c} onClose={() => setEditing(false)} />}
      {contract && <ContractDialog clientId={c.id} row={contract === 'new' ? null : contract} projects={d.projects} onClose={() => setContract(null)} />}
      {renewing && <RenewDialog row={renewing} onClose={() => setRenewing(null)} />}
    </div>
  )
}

function Contracts({ d, readOnly, onEdit, onRenew }: { d: ClientDetail; readOnly: boolean; onEdit: (c: ContractRow) => void; onRenew: (c: ContractRow) => void }) {
  const { askReason } = useConfirm()
  const terminate = useMut((v: { c: ContractRow; reason: string }) => clientsApi.updateContract(v.c.id, { status: 'terminated', notes: `${v.c.notes ? v.c.notes + '\n' : ''}Terminated: ${v.reason}` }, v.c.version), { invalidate: CLIENTS_INVALIDATE, success: 'Contract terminated' })
  const actions = (c: ContractRow) =>
    readOnly || c.status === 'renewed' || c.status === 'terminated' ? null : (
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Menu
          label="Contract actions"
          trigger={<IconButton label="Contract actions" size="sm" variant="ghost"><MoreHorizontal className="size-4" /></IconButton>}
          items={[
            { label: 'Renew', icon: <RefreshCw />, onSelect: () => onRenew(c) },
            { label: 'Edit', icon: <Pencil />, onSelect: () => onEdit(c) },
            { label: 'Terminate', danger: true, onSelect: async () => { const r = await askReason({ title: `Terminate “${c.title}”?`, label: 'Reason', minLength: 5, confirmLabel: 'Terminate', tone: 'danger' }); if (r) terminate.mutate({ c, reason: r }) } },
          ]}
        />
      </div>
    )
  const cols: Column<ContractRow>[] = [
    {
      key: 'title', header: 'Contract', sortValue: (c) => c.title,
      cell: (c) => (
        <div className="min-w-0 max-w-[420px]">
          <div className="flex items-center gap-1.5"><span className="truncate text-ink">{c.title}</span>{c.file_name && <FileText className="size-3.5 shrink-0 text-ink-3" aria-label="Signed copy attached" />}</div>
          <div className="truncate text-[12px] text-ink-3">{CONTRACT_KIND[c.kind]}{c.project_code ? ` · ${c.project_code}` : ''} · {fmtDate(c.start_on)} – {fmtDate(c.end_on)}{c.auto_renew ? ' · auto-renews' : ''}</div>
        </div>
      ),
    },
    {
      key: 'status', header: 'Status', sortValue: (c) => c.days_to_renewal ?? 9999,
      cell: (c) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge map={CONTRACT_STATUS} value={c.status} size="sm" />
          {c.days_to_renewal !== null && c.status === 'expiring' && <span className="tnum whitespace-nowrap text-[12px] text-warning-text">renews in {c.days_to_renewal}d</span>}
        </div>
      ),
    },
    { key: 'value', header: 'Value', align: 'right', sortValue: (c) => c.value_paise, cell: (c) => <Money value={c.value_paise} muted={!c.value_paise} className="font-medium" /> },
    { key: 'act', header: '', align: 'right', width: '52px', cell: actions },
  ]
  return (
    <Card pad={false}>
      <div className="px-4 pt-4 md:px-5 md:pt-5"><CardHeader title="Contracts" subtitle="MSAs, SOWs, AMCs, licences, NDAs and retainers" /></div>
      <div className="px-4 pb-4 md:px-5 md:pb-5">
        <DataTable
          rows={d.contracts}
          columns={cols}
          rowKey={(c) => c.id}
          dense
          onRowClick={readOnly ? undefined : (c) => (c.status !== 'renewed' && c.status !== 'terminated' ? onEdit(c) : undefined)}
          empty={<EmptyState title="No contracts on file" body="Add the signed MSA, SOW or licence so renewals are tracked." compact />}
          mobileCard={(c) => (
            <div>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium">{c.title}</div>
                  <Meta>{CONTRACT_KIND[c.kind]} · {fmtDate(c.start_on)} – {fmtDate(c.end_on)}</Meta>
                </div>
                <Money value={c.value_paise} compact className="shrink-0 text-[14px] font-semibold" />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge map={CONTRACT_STATUS} value={c.status} size="sm" />
                  {c.status === 'expiring' && c.days_to_renewal !== null && <span className="text-[12px] text-warning-text">in {c.days_to_renewal}d</span>}
                </div>
                {actions(c)}
              </div>
            </div>
          )}
        />
      </div>
    </Card>
  )
}

function Invoices({ d }: { d: ClientDetail }) {
  const cols: Column<ClientDetail['invoices'][number]>[] = [
    { key: 'no', header: 'Invoice', sortValue: (i) => i.invoiced_on, cell: (i) => <div className="whitespace-nowrap"><div className="tnum text-ink">{i.number}</div><div className="text-[12px] text-ink-3">{i.project_code} · {fmtDate(i.invoiced_on)}</div></div> },
    { key: 'due', header: 'Due', hideBelow: 'md', sortValue: (i) => i.due_on, cell: (i) => <div className="whitespace-nowrap"><span className="tnum text-ink-2">{fmtDate(i.due_on)}</span>{i.days_overdue > 0 && <div className="text-[12px] font-medium text-danger-text">{i.days_overdue}d overdue</div>}</div> },
    { key: 'amt', header: 'Amount', align: 'right', sortValue: (i) => i.amount_paise, cell: (i) => <Money value={i.amount_paise} /> },
    { key: 'out', header: 'Outstanding', align: 'right', sortValue: (i) => i.outstanding_paise, cell: (i) => <Money value={i.outstanding_paise} muted={!i.outstanding_paise} className={cn('font-medium', i.days_overdue > 0 && 'text-danger-text')} /> },
  ]
  return (
    <Card pad={false}>
      <div className="px-4 pt-4 md:px-5 md:pt-5"><CardHeader title="Invoices & income" subtitle="Milestone invoices, plus consulting and retainer income booked in the ledger" /></div>
      <div className="space-y-4 px-4 pb-4 md:px-5 md:pb-5">
        {d.invoices.length > 0 && (
          <DataTable
            rows={d.invoices}
            columns={cols}
            rowKey={(i) => i.id}
            dense
            initialSort={{ key: 'no', dir: 'desc' }}
            mobileCard={(i) => (
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="tnum truncate text-[14px] font-medium">{i.number}</div>
                  <Meta>{i.project_code} · due {fmtDate(i.due_on)}</Meta>
                </div>
                <div className="flex shrink-0 flex-col items-end">
                  <Money value={i.amount_paise} className="text-[14px] font-semibold" />
                  {i.outstanding_paise > 0 && <span className={cn('tnum text-[12px]', i.days_overdue ? 'text-danger-text' : 'text-ink-3')}>{fmtMoneyCompact(i.outstanding_paise)} due</span>}
                </div>
              </div>
            )}
          />
        )}
        {d.other_income.length > 0 && (
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-3">Ledger income · {d.other_income.length} entries · {fmtMoney(d.other_income.reduce((a, l) => a + l.amount_paise, 0))}</div>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {d.other_income.slice(0, 6).map((l, i) => (
                <li key={i} className="flex items-center gap-3 px-3 py-2">
                  <span className="tnum w-16 shrink-0 text-[12.5px] text-ink-3">{fmtDate(l.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{l.description}</span>
                  <Money value={l.amount_paise} className="shrink-0 text-[13px]" />
                </li>
              ))}
            </ul>
          </div>
        )}
        {!d.invoices.length && !d.other_income.length && <EmptyState title="Nothing billed yet" compact />}
      </div>
    </Card>
  )
}

/* ---------------- dialogs ---------------- */
export function ClientDialog({ row, onClose, onCreated }: { row: ClientRow | null; onClose: () => void; onCreated?: (id: string) => void }) {
  const [f, setF] = useState<ClientInput>({
    name: row?.name ?? '', industry: row?.industry ?? '', country: row?.country ?? 'India', gstin: row?.gstin ?? '', billing_address: row?.billing_address ?? '', primary_contact: row?.primary_contact ?? '',
    email: row?.email ?? '', phone: row?.phone ?? '', owner_id: row?.owner_id ?? null, payment_terms_days: row?.payment_terms_days ?? 30, status: row?.status,
    city: row?.city ?? '', state: row?.state ?? '', state_code: row?.state_code && row.state_code !== '96' ? row.state_code : '', pincode: row?.pincode ?? '', pan: row?.pan ?? '',
  })
  const india = /^(india|in)$/i.test(f.country.trim() || 'India')
  const fe = useFieldErrors()
  const set = <K extends keyof ClientInput>(k: K, v: ClientInput[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const save = useMut(() => (row ? clientsApi.update(row.id, f, row.version) : clientsApi.create(f)), {
    invalidate: CLIENTS_INVALIDATE, success: row ? 'Client saved' : 'Client added', onSuccess: (r) => { onClose(); if (!row && r && 'id' in (r as object)) onCreated?.((r as { id: string }).id) }, onError: (e) => fe.take(e),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={row ? `Edit ${row.name}` : 'Add client'} footer={<Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending}>{row ? 'Save client' : 'Add client'}</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client name" required error={fe.errors.name} className="sm:col-span-2">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} invalid={!!fe.errors.name} />
        </Field>
        <Field label="Industry"><Input value={f.industry} onChange={(e) => set('industry', e.target.value)} placeholder="e.g. Education" /></Field>
        <Field label="Country"><Input value={f.country} onChange={(e) => set('country', e.target.value)} /></Field>
        <Field label="Account manager"><PeoplePicker value={f.owner_id} onChange={(v) => set('owner_id', v)} clearable /></Field>
        <Field label="Payment terms" error={fe.errors.payment_terms_days}><Input type="number" min={0} max={180} suffix="days" value={String(f.payment_terms_days)} onChange={(e) => set('payment_terms_days', Number(e.target.value))} /></Field>
        <Field label="GSTIN" error={fe.errors.gstin} hint="Leave empty for overseas clients."><Input value={f.gstin} maxLength={15} onChange={(e) => set('gstin', e.target.value.toUpperCase())} className="tnum uppercase" invalid={!!fe.errors.gstin} /></Field>
        {row && (
          <Field label="Status" hint="Status follows projects and contracts; set Churned when the client leaves.">
            <Select aria-label="Status" value={f.status ?? row.status} onChange={(e) => set('status', e.target.value as ClientInput['status'])} options={Object.entries(CLIENT_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
          </Field>
        )}
        <Field label="Primary contact"><Input value={f.primary_contact} onChange={(e) => set('primary_contact', e.target.value)} /></Field>
        <Field label="Phone"><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Email" error={fe.errors.email} className="sm:col-span-2"><Input type="email" value={f.email} onChange={(e) => set('email', e.target.value)} invalid={!!fe.errors.email} /></Field>
        <Field label="Billing address" className="sm:col-span-2"><Textarea rows={2} value={f.billing_address} onChange={(e) => set('billing_address', e.target.value)} placeholder="Building, street, area" /></Field>
        <Field label="City" htmlFor="cl-city"><Input id="cl-city" value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
        {india ? (
          <Field label="State" htmlFor="cl-state" error={fe.errors.state ?? fe.errors.state_code} hint="Sets the place of supply on invoices (CGST + SGST or IGST).">
            <Select
              id="cl-state"
              value={f.state_code ?? ''}
              onChange={(e) => { const code = e.target.value; setF((x) => ({ ...x, state_code: code, state: GST_STATES.find((g) => g.code === code)?.name ?? '' })); fe.unset('state'); fe.unset('state_code'); fe.unset('gstin') }}
              options={[{ value: '', label: 'Choose a state' }, ...GST_STATES.filter((g) => g.code !== '96' && g.code !== '97').map((g) => ({ value: g.code, label: `${g.name} (${g.code})` }))]}
            />
          </Field>
        ) : (
          <Field label="State / region" htmlFor="cl-state"><Input id="cl-state" value={f.state ?? ''} onChange={(e) => set('state', e.target.value)} /></Field>
        )}
        <Field label={india ? 'PIN code' : 'Postal code'} htmlFor="cl-pin" error={fe.errors.pincode}><Input id="cl-pin" value={f.pincode ?? ''} inputMode={india ? 'numeric' : undefined} maxLength={india ? 6 : 12} onChange={(e) => set('pincode', e.target.value)} className="tnum" invalid={!!fe.errors.pincode} /></Field>
        {india && (
          <Field label="PAN" htmlFor="cl-pan" error={fe.errors.pan} hint="Filled from the GSTIN when left empty."><Input id="cl-pan" value={f.pan ?? ''} maxLength={10} onChange={(e) => set('pan', e.target.value.toUpperCase())} className="tnum uppercase" invalid={!!fe.errors.pan} /></Field>
        )}
      </div>
    </Dialog>
  )
}

function ContractDialog({ clientId, row, projects, onClose }: { clientId: string; row: ContractRow | null; projects: ClientDetail['projects']; onClose: () => void }) {
  const meta = useSpendMeta()
  const today = meta.data?.today ?? new Date().toISOString().slice(0, 10)
  const [f, setF] = useState<ContractInput>({
    title: row?.title ?? '', kind: (row?.kind ?? 'sow') as Contract['kind'], value_paise: row?.value_paise ?? 0, start_on: row?.start_on ?? today, end_on: row?.end_on ?? addDays(today, 364),
    renewal_on: row?.renewal_on ?? null, auto_renew: row?.auto_renew ?? false, project_id: row?.project_id ?? null, notes: row?.notes ?? '',
  })
  const [file, setFile] = useState<FileInput | null>(null)
  const fe = useFieldErrors()
  const set = <K extends keyof ContractInput>(k: K, v: ContractInput[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const save = useMut(() => (row ? clientsApi.updateContract(row.id, { ...f, file }, row.version) : clientsApi.addContract(clientId, { ...f, file })), { invalidate: CLIENTS_INVALIDATE, success: row ? 'Contract saved' : 'Contract added', onSuccess: onClose, onError: (e) => fe.take(e) })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={row ? 'Edit contract' : 'Add contract'} description="The account manager is reminded 60 days before the renewal date." footer={<Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending}>{row ? 'Save contract' : 'Add contract'}</Button>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Title" required error={fe.errors.title} className="sm:col-span-2"><Input value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. SAP AMS — annual maintenance" invalid={!!fe.errors.title} /></Field>
        <Field label="Type" required error={fe.errors.kind}>
          <Select aria-label="Contract type" value={f.kind} onChange={(e) => set('kind', e.target.value as Contract['kind'])} options={Object.entries(CONTRACT_KIND).map(([value, label]) => ({ value, label }))} />
        </Field>
        <Field label="Contract value" error={fe.errors.value_paise}><MoneyInput value={f.value_paise} onChange={(v) => set('value_paise', v)} /></Field>
        <Field label="Start" required error={fe.errors.start_on}><Input type="date" value={f.start_on} onChange={(e) => set('start_on', e.target.value)} invalid={!!fe.errors.start_on} /></Field>
        <Field label="End" required error={fe.errors.end_on}><Input type="date" value={f.end_on} min={f.start_on} onChange={(e) => set('end_on', e.target.value)} invalid={!!fe.errors.end_on} /></Field>
        <Field label="Renewal date" error={fe.errors.renewal_on} hint="Defaults to the end date."><Input type="date" value={f.renewal_on ?? ''} min={f.start_on} max={f.end_on} onChange={(e) => set('renewal_on', e.target.value || null)} invalid={!!fe.errors.renewal_on} /></Field>
        <Field label="Project">
          <Select aria-label="Project" value={f.project_id ?? ''} onChange={(e) => set('project_id', e.target.value || null)} options={[{ value: '', label: 'Not project-specific' }, ...projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))]} />
        </Field>
        <div className="sm:col-span-2"><Switch checked={f.auto_renew} onChange={(v) => set('auto_renew', v)} label="Auto-renews" description="Renews on the same terms unless either side gives notice." /></div>
        <Field label="Signed copy" className="sm:col-span-2">
          <FileUpload accept="application/pdf" label="Attach the signed contract" hint="PDF · up to 10 MB" file={file ? { name: file.name, size: file.size_bytes } : row?.file_name ? { name: row.file_name } : null} onClear={() => setFile(null)} onFile={async (fl) => setFile(await readFile(fl))} />
        </Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notice period, escalation, renewal terms" /></Field>
      </div>
    </Dialog>
  )
}

function RenewDialog({ row, onClose }: { row: ContractRow; onClose: () => void }) {
  const [months, setMonths] = useState('12')
  const [value, setValue] = useState(row.value_paise)
  const renew = useMut(() => clientsApi.renewContract(row.id, { months: Number(months), value_paise: value }), { invalidate: CLIENTS_INVALIDATE, success: 'Contract renewed', onSuccess: onClose })
  const change = row.value_paise ? (value - row.value_paise) / row.value_paise : null
  return (
    <Dialog open size="sm" onOpenChange={(o) => !o && onClose()} title={`Renew “${row.title}”`} description={`The new term starts ${fmtDate(addDays(row.end_on, 1), 'long')}. The current contract is marked renewed.`} footer={<Button variant="primary" onClick={() => renew.mutate(undefined)} loading={renew.isPending}>Renew contract</Button>}>
      <div className="space-y-4">
        <Field label="Term"><Select aria-label="Term" value={months} onChange={(e) => setMonths(e.target.value)} options={['6', '12', '24', '36'].map((m) => ({ value: m, label: `${m} months` }))} /></Field>
        <Field label="New value" hint={change !== null && change !== 0 ? `${change > 0 ? '+' : ''}${(change * 100).toFixed(1)}% vs current ${fmtMoney(row.value_paise)}` : `Current ${fmtMoney(row.value_paise)}`}>
          <MoneyInput value={value} onChange={setValue} />
        </Field>
      </div>
    </Dialog>
  )
}

