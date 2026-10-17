// Lost revenue: lost deals, unbilled hours, bad-debt risk and rejected change requests are derived
// automatically; discounts, write-offs, credit notes and penalties are recorded here.
import { useMemo, useState } from 'react'
import { Plus } from '@/ui/icons'
import {
  Badge, BarChart, Button, Callout, Card, CardHeader, Combobox, DataTable, Dialog, EmptyState, ErrorState, Field, Input, Money, MoneyInput, PageHeader, Progress, Select, SkeletonCards,
  SkeletonRows, StatCard, StatusBadge, Switch, Textarea, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { useMut } from '@/api/query'
import { SPEND_INVALIDATE, spendApi, useLeakage, useSpendMeta, type LeakageInput, type LeakageRow } from '@/api/spend'
import { useClientsLite } from '@/api/clients'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportTable } from '@/reports/export'
import { fmtDate, fyLabel, parseISO } from '@/domain/calendar'
import { fmtMoneyCompact, fmtPct } from '@/domain/money'
import type { LeakageKind } from '@/types/business'
import { LEAKAGE_KIND, LEAKAGE_STATUS, MANUAL_LEAKAGE_KINDS } from './labels'
import { FyPicker, KpiRow, Meta, useFieldErrors } from './components'

export default function LeakagePage() {
  const meta = useSpendMeta()
  const current = meta.data?.fy_start_year ?? new Date().getFullYear()
  const [fySel, setFy] = useState<number | null>(null)
  const fy = fySel ?? current
  const q = useLeakage(fy)
  const d = q.data
  const readOnly = useReadOnly()
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [edit, setEdit] = useState<LeakageRow | 'new' | null>(null)
  const rows = (d?.items ?? []).filter((r) => (!kind || r.kind === kind) && (!status || r.status === status))
  const trend = useMemo(() => (d ? d.summary.by_month.map((m) => ({ month: parseISO(`${m.month}-01`).toLocaleDateString('en-IN', { month: 'short' }), Lost: m.amount })) : []), [d])
  const kindData = useMemo(() => (d ? d.summary.by_kind.map((k) => ({ kind: k.label, Lost: k.amount })) : []), [d])

  const exportT = (): ExportTable => ({
    title: 'Lost revenue register', subtitle: d!.fy_label, orientation: 'landscape', category: 'Revenue report',
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Kind', type: 'string' }, { key: 'client', label: 'Client', type: 'string' }, { key: 'project', label: 'Project', type: 'string' },
      { key: 'reason', label: 'Reason', type: 'string' }, { key: 'status', label: 'Status', type: 'string' }, { key: 'amount', label: 'Lost', type: 'money' }, { key: 'recovered', label: 'Recovered', type: 'money' },
    ],
    rows: rows.map((r) => ({ date: r.date, kind: r.kind_label + (r.auto ? ' (auto)' : ''), client: r.client, project: r.project_code ?? '', reason: r.reason, status: LEAKAGE_STATUS[r.status].label, amount: r.amount_paise, recovered: r.recovered_paise })),
    totals: { amount: rows.reduce((a, r) => a + r.amount_paise, 0), recovered: rows.reduce((a, r) => a + r.recovered_paise, 0) },
    kpis: [
      { label: 'Lost this FY (net)', value: fmtMoneyCompact(d!.summary.net) }, { label: '% of billed revenue', value: fmtPct(d!.summary.pct_of_billed) },
      { label: 'Recoverable, open', value: fmtMoneyCompact(d!.summary.recoverable_open) }, { label: 'Recovered', value: fmtMoneyCompact(d!.summary.recovered) },
    ],
    notes: ['Lost deals, unbilled hours, invoices more than 90 days overdue and change requests rejected after work started are calculated from live data.'],
  })

  const cols: Column<LeakageRow>[] = [
    { key: 'date', header: 'Date', width: '92px', sortValue: (r) => r.date, cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(r.date)}</span> },
    {
      key: 'what', header: 'What was lost', sortValue: (r) => r.client,
      cell: (r) => (
        <div className="min-w-0 max-w-[520px]">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium text-ink">{r.client}</span>
            {r.project_code && <span className="shrink-0 text-[12px] text-ink-3">{r.project_code}</span>}
          </div>
          <div className="line-clamp-2 text-[12.5px] text-ink-3">{r.reason}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', sortValue: (r) => r.kind_label, cell: (r) => <div className="flex flex-wrap items-center gap-1"><Badge size="sm">{r.kind_label}</Badge>{r.auto && <Badge size="sm" tone="info">Auto</Badge>}</div> },
    { key: 'status', header: 'Status', hideBelow: 'lg', sortValue: (r) => r.status, cell: (r) => <StatusBadge map={LEAKAGE_STATUS} value={r.status} size="sm" /> },
    { key: 'rec', header: 'Recovered', align: 'right', hideBelow: 'xl', sortValue: (r) => r.recovered_paise, cell: (r) => <Money value={r.recovered_paise} muted={!r.recovered_paise} /> },
    { key: 'amount', header: 'Lost', align: 'right', sortValue: (r) => r.amount_paise, cell: (r) => <Money value={r.amount_paise} className="font-medium" /> },
  ]

  return (
    <div>
      <PageHeader
        title="Lost revenue"
        subtitle="Revenue we lost or gave away — lost deals, discounts, write-offs, penalties and hours we never billed — and what we got back."
        actions={
          <>
            <FyPicker value={fy} onChange={setFy} current={current} />
            <ExportMenu table={d ? exportT : null} filename={`lost-revenue-${fyLabel(fy)}`} />
            {!readOnly && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')} className="flex-1 md:flex-none">Record loss</Button>}
          </>
        }
      />
      {q.isLoading ? (
        <><SkeletonCards n={4} /><Card className="mt-4"><SkeletonRows rows={5} /></Card></>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <KpiRow>
            <StatCard label={`Lost in ${d.fy_label}`} value={fmtMoneyCompact(d.summary.net)} tone={d.summary.net ? 'danger' : undefined} sub={`${d.items.length} entries · net of recoveries`} />
            <StatCard label="Share of billed revenue" value={fmtPct(d.summary.pct_of_billed)} sub={`Billed ${fmtMoneyCompact(d.summary.billed)}`} />
            <StatCard label="Still recoverable" value={fmtMoneyCompact(d.summary.recoverable_open)} tone={d.summary.recoverable_open ? 'warning' : undefined} sub="Open items we can chase" />
            <StatCard label="Recovered" value={fmtMoneyCompact(d.summary.recovered)} tone={d.summary.recovered ? 'success' : undefined} sub="Won back so far" />
          </KpiRow>

          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <Card className="min-w-0 lg:col-span-5">
              <CardHeader title="By kind" subtitle="Net of recoveries" />
              {kindData.length ? <BarChart data={kindData} x="kind" series={[{ key: 'Lost', label: 'Lost' }]} format="money" horizontal height={Math.max(160, kindData.length * 38)} /> : <EmptyState title="Nothing lost" compact />}
            </Card>
            <Card className="min-w-0 lg:col-span-4">
              <CardHeader title="By month" subtitle={d.fy_label} />
              <BarChart data={trend} x="month" series={[{ key: 'Lost', label: 'Lost' }]} format="money" height={Math.max(160, kindData.length * 38)} />
            </Card>
            <Card className="min-w-0 lg:col-span-3">
              <CardHeader title="Top clients" subtitle="Where most was lost" />
              {d.summary.top_clients.length ? (
                <ul className="space-y-3">
                  {d.summary.top_clients.map((c) => (
                    <li key={c.client}>
                      <div className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span className="min-w-0 truncate text-ink">{c.client}</span>
                        <Money value={c.amount} compact className="font-medium" />
                      </div>
                      <Progress value={c.amount} max={d.summary.top_clients[0].amount || 1} tone="danger" height={4} className="mt-1" />
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="Nothing lost" compact />}
            </Card>
          </div>

          <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: '', label: 'All kinds' }, ...Object.entries(LEAKAGE_KIND).map(([value, k]) => ({ value, label: k.label }))]} className="w-full sm:w-48" />
            <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} options={[{ value: '', label: 'Any status' }, ...Object.entries(LEAKAGE_STATUS).map(([value, s]) => ({ value, label: s.label }))]} className="w-full sm:w-40" />
            <p className="text-[12.5px] text-ink-3 sm:ml-auto">Rows marked Auto are calculated from deals, timesheets, invoices and change requests.</p>
          </div>
          <div className="mt-3">
            <DataTable
              rows={rows}
              columns={cols}
              rowKey={(r) => r.id}
              initialSort={{ key: 'date', dir: 'desc' }}
              onRowClick={(r) => (!r.auto && !readOnly ? setEdit(r) : undefined)}
              empty={<EmptyState title="No lost revenue recorded" body="Record discounts, write-offs and penalties as they happen." compact />}
              mobileCard={(r) => (
                <div>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium">{r.client}</div>
                      <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{r.reason}</div>
                      <Meta>{fmtDate(r.date)}{r.project_code ? ` · ${r.project_code}` : ''}</Meta>
                    </div>
                    <Money value={r.amount_paise} className="shrink-0 text-[14px] font-semibold" />
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Badge size="sm">{r.kind_label}</Badge>
                    {r.auto && <Badge size="sm" tone="info">Auto</Badge>}
                    <StatusBadge map={LEAKAGE_STATUS} value={r.status} size="sm" />
                    {r.recovered_paise > 0 && <Badge size="sm" tone="success">{fmtMoneyCompact(r.recovered_paise)} back</Badge>}
                  </div>
                </div>
              )}
            />
          </div>
        </>
      )}
      {edit && <LeakDialog row={edit === 'new' ? null : edit} today={meta.data?.today ?? new Date().toISOString().slice(0, 10)} onClose={() => setEdit(null)} />}
    </div>
  )
}

function LeakDialog({ row, today, onClose }: { row: LeakageRow | null; today: string; onClose: () => void }) {
  const meta = useSpendMeta()
  const clients = useClientsLite()
  const { confirm } = useConfirm()
  const [f, setF] = useState<LeakageInput>({
    kind: (row?.kind ?? 'discount') as LeakageKind,
    amount_paise: row?.amount_paise ?? 0,
    date: row?.date ?? today,
    client: row?.client ?? '',
    project_id: row?.project_id ?? null,
    reason: row?.reason ?? '',
    recoverable: row?.recoverable ?? false,
    status: row?.status ?? 'open',
    recovered_paise: row?.recovered_paise ?? 0,
  })
  const fe = useFieldErrors()
  const set = <K extends keyof LeakageInput>(k: K, v: LeakageInput[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const save = useMut(() => (row ? spendApi.updateLeakage(row.id, f, row.version) : spendApi.createLeakage(f)), { invalidate: SPEND_INVALIDATE, success: row ? 'Entry updated' : 'Loss recorded', onSuccess: onClose, onError: (e) => fe.take(e) })
  const del = useMut(() => spendApi.deleteLeakage(row!.id, row!.version), { invalidate: SPEND_INVALIDATE, success: 'Entry removed', onSuccess: onClose })
  const projects = (meta.data?.projects ?? []).filter((p) => !f.client || p.client.toLowerCase() === f.client.toLowerCase())
  const clientOpts = (clients.data ?? []).map((c) => ({ value: c.name, label: c.name }))
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? `${LEAKAGE_KIND[row.kind].label} · ${row.client}` : 'Record lost revenue'}
      description="Discounts, write-offs, credit notes and penalties. Lost deals, unbilled hours and bad debts are tracked automatically."
      footer={
        <>
          {row && <Button variant="outline-danger" className="sm:mr-auto" onClick={async () => (await confirm({ title: 'Remove this entry?', confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(undefined)}>Remove</Button>}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate(undefined)} loading={save.isPending}>{row ? 'Save' : 'Record loss'}</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" required error={fe.errors.kind}>
          <Select aria-label="Kind" value={f.kind} onChange={(e) => set('kind', e.target.value as LeakageKind)} options={MANUAL_LEAKAGE_KINDS.map((k) => ({ value: k, label: LEAKAGE_KIND[k].label }))} />
        </Field>
        <Field label="Amount lost" required error={fe.errors.amount_paise}>
          <MoneyInput value={f.amount_paise} onChange={(v) => set('amount_paise', v)} invalid={!!fe.errors.amount_paise} />
        </Field>
        <Field label="Client" required error={fe.errors.client}>
          <Combobox value={f.client || null} onChange={(v) => { set('client', v ?? ''); set('project_id', null) }} placeholder="Choose client" options={clientOpts} invalid={!!fe.errors.client} />
        </Field>
        <Field label="Project">
          <Combobox value={f.project_id} onChange={(v) => set('project_id', v)} clearable placeholder="Not project-specific" options={projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}` }))} />
        </Field>
        <Field label="Date" required error={fe.errors.date}>
          <Input type="date" value={f.date} max={today} onChange={(e) => set('date', e.target.value)} invalid={!!fe.errors.date} />
        </Field>
        <Field label="Status">
          <Select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value as LeakageInput['status'])} options={Object.entries(LEAKAGE_STATUS).map(([value, s]) => ({ value, label: s.label }))} />
        </Field>
        <Field label="Reason" required error={fe.errors.reason} className="sm:col-span-2" hint="At least 10 characters — what happened and who agreed to it.">
          <Textarea rows={3} value={f.reason} onChange={(e) => set('reason', e.target.value)} invalid={!!fe.errors.reason} placeholder="e.g. 10% discount to close before the academic year" />
        </Field>
        <div className="sm:col-span-2">
          <Switch checked={f.recoverable} onChange={(v) => set('recoverable', v)} label="We can still recover this" description="Recoverable items show on the CEO dashboard until closed." />
        </div>
        {(f.recoverable || f.status === 'recovered') && (
          <Field label="Recovered so far" error={fe.errors.recovered_paise}>
            <MoneyInput value={f.recovered_paise} onChange={(v) => set('recovered_paise', v)} />
          </Field>
        )}
      </div>
      {f.status === 'recovered' && f.recovered_paise === 0 && <Callout tone="info" className="mt-4">Marking it recovered with no amount records the full {fmtMoneyCompact(f.amount_paise)} as recovered.</Callout>}
    </Dialog>
  )
}
