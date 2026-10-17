import { useEffect, useMemo, useState } from 'react'
import { Lock, Plus, Trash2 } from '@/ui/icons'
import { usePeopleMap } from '@/api/core'
import { useMut } from '@/api/query'
import { adminApi, useCostRates, type CostRatePerson } from '@/api/admin'
import { addDays, fmtDate, monthOf, todayISO } from '@/domain/calendar'
import { fmtMoney, fmtNum } from '@/domain/money'
import { ROLE_LABEL } from '@/domain/permissions'
import { Badge, Button, Callout, DataTable, Dialog, EmptyState, ErrorState, Field, IconButton, Input, KV, Money, MoneyInput, PageHeader, PersonName, SearchInput, Sheet, SkeletonRows, useConfirm, useReadOnly, type Column } from '@/ui'
import { errField } from './kit'
import { announce, guarded, type PendingBrief } from '@/api/changes'
import { PendingNote } from '@/modules/workflows/ApprovalRoute'
import { costingApi } from '@/api/projects'
import { useApi } from '@/api/query'

/** v4: a salary change waiting for a checker (maker-checker entity `cost_rate`). */
const pendingOf = (p: CostRatePerson) => (p as CostRatePerson & { pending_change?: PendingBrief | null }).pending_change ?? null

export default function CostRatesPage() {
  const q = useCostRates()
  const people = usePeopleMap()
  const readOnly = useReadOnly()
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase()
    return (q.data?.people ?? []).filter((p) => {
      const d = people.get(p.user_id)
      return !s || (d?.name + ' ' + d?.title).toLowerCase().includes(s)
    })
  }, [q.data, people, search])
  const canEdit = !!q.data?.can_edit && !readOnly
  const sel = q.data?.people.find((p) => p.user_id === open) ?? null
  // v6: cost per day = minimum hours × cost per hour (Feature Guide §6; no overhead loading)
  const days = useApi(['cost-rate-days'], () => costingApi.rateDays(), { staleTime: 30_000 })
  const cpd = new Map((days.data?.people ?? []).map((x) => [x.user_id, x.cost_per_day_paise]))

  const cols: Column<CostRatePerson>[] = [
    { key: 'name', header: 'Person', cell: (r) => <PersonName id={r.user_id} subtitle={people.get(r.user_id)?.title} size={28} className="flex max-w-[240px]" />, sortValue: (r) => people.get(r.user_id)?.name ?? '' },
    { key: 'ctc', header: 'Monthly CTC', align: 'right', cell: (r) => <Money value={r.current?.monthly_ctc_paise} />, sortValue: (r) => r.current?.monthly_ctc_paise ?? 0 },
    { key: 'var', header: 'Variable', align: 'right', cell: (r) => (r.current?.variable_pct ? <span className="tnum whitespace-nowrap" title={fmtMoney(r.variable_paise)}>{r.current.variable_pct}%</span> : <span className="text-ink-3">—</span>), hideBelow: 'xl' },
    { key: 'target', header: 'Sales target', align: 'right', cell: (r) => (r.current?.sales_target_paise ? <Money value={r.current.sales_target_paise} /> : <span className="text-ink-3">—</span>), hideBelow: 'xl' },
    { key: 'cph', header: 'Cost / hour', align: 'right', cell: (r) => <span className="tnum whitespace-nowrap font-medium">{fmtMoney(r.cost_per_hour_paise, { decimals: true })}</span>, sortValue: (r) => r.cost_per_hour_paise ?? 0 },
    { key: 'cpd', header: 'Cost / day', align: 'right', cell: (r) => <span className="tnum whitespace-nowrap font-medium">{fmtMoney(cpd.get(r.user_id) ?? null)}</span>, sortValue: (r) => cpd.get(r.user_id) ?? 0, hideBelow: 'md' },
    { key: 'eff', header: 'Since', cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(r.current?.effective_from)}{r.upcoming && <Badge tone="info" size="sm" className="ml-1.5">Change {fmtDate(r.upcoming.effective_from)}</Badge>}{pendingOf(r) && <Badge tone="warning" size="sm" className="ml-1.5">Awaiting approval</Badge>}</span>, hideBelow: 'lg' },
  ]

  return (
    <div>
      <PageHeader
        title="Cost rates"
        subtitle="Monthly CTC drives cost per hour, project margins and payroll. Rates are never edited — add a new row from a date."
        meta={canEdit ? undefined : <Badge tone="neutral">Read-only</Badge>}
      />
      {q.isLoading ? (
        <SkeletonRows rows={7} />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Stat label="Monthly payroll cost" value={fmtMoney(q.data.total_ctc_paise)} sub="active people" />
            <Stat label="Working days" value={fmtNum(q.data.working_days)} sub={new Date(q.data.month + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })} />
            <Stat label="Minimum hours / day" value={`${q.data.min_hours}h`} sub="from Company & rules" />
            <Stat label="Locked through" value={q.data.locked_through ? fmtDate(q.data.locked_through) : 'Nothing'} sub="final payroll" />
          </div>
          <Callout tone="info" className="mb-4">
            Cost per hour = monthly salary (CTC) ÷ (working days in the month × minimum hours per day): this month ÷ ({q.data.working_days} × {q.data.min_hours}). Example: ₹60,000 ÷ (22 × 9) = ₹303 per hour. Costs on any day use the rate and the working days of that month.
            <span className="mt-1 block">
              Cost per day = {q.data.min_hours} × cost per hour (monthly CTC ÷ working days in the month). Project allocations cost working days × % × cost per day; actual cost is approved hours × cost per hour.
            </span>
          </Callout>
          <SearchInput value={search} onChange={setSearch} placeholder="Search people" className="mb-3 md:max-w-[320px]" />
          <DataTable
            rows={rows}
            columns={cols}
            rowKey={(r) => r.user_id}
            onRowClick={(r) => setOpen(r.user_id)}
            initialSort={{ key: 'name', dir: 'asc' }}
            rowClassName={(r) => (r.status === 'deactivated' ? 'opacity-55' : undefined)}
            empty={<EmptyState title="No people match" compact />}
            mobileCard={(r) => (
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1 overflow-hidden">
                  <PersonName id={r.user_id} subtitle={pendingOf(r) ? 'Rate change awaiting approval' : people.get(r.user_id)?.title} size={32} className="flex w-full" />
                </div>
                <div className="shrink-0 whitespace-nowrap text-right">
                  <Money value={r.current?.monthly_ctc_paise} className="block text-[14px] font-semibold" />
                  <span className="tnum block text-[12px] text-ink-3">{fmtMoney(r.cost_per_hour_paise, { decimals: true })}/h{cpd.get(r.user_id) ? ` · ${fmtMoney(cpd.get(r.user_id)!)}/day` : ''}</span>
                </div>
              </div>
            )}
          />
        </>
      )}
      {sel && (
        <Sheet
          open
          onOpenChange={(o) => !o && setOpen(null)}
          title={people.get(sel.user_id)?.name ?? 'Person'}
          subtitle={`${people.get(sel.user_id)?.title ?? ''} · ${people.get(sel.user_id)?.role_name ?? (people.get(sel.user_id) ? ROLE_LABEL[people.get(sel.user_id)!.role] : '')}`}
          footer={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} disabled={!!pendingOf(sel)} onClick={() => setAdding(sel.user_id)}>New rate</Button>}
        >
          <RateDetail p={sel} canEdit={canEdit} lockedThrough={q.data?.locked_through ?? null} />
        </Sheet>
      )}
      {adding && q.data && <AddRate person={q.data.people.find((p) => p.user_id === adding)!} lockedThrough={q.data.locked_through} onClose={() => setAdding(null)} />}
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-3.5 py-3 md:px-4">
      <div className="text-[12.5px] leading-tight text-ink-3">{label}</div>
      <div className="tnum mt-1.5 whitespace-nowrap text-[18px] font-semibold leading-tight md:text-[20px]">{value}</div>
      <div className="mt-0.5 truncate text-[12px] text-ink-3">{sub}</div>
    </div>
  )
}

function RateDetail({ p, canEdit, lockedThrough }: { p: CostRatePerson; canEdit: boolean; lockedThrough: string | null }) {
  const { confirm } = useConfirm()
  const del = useMut((id: string) => guarded('DELETE', `/cost-rates/${id}`), { invalidate: [['cost-rates'], ['changes']], onSuccess: (r) => announce(r, 'Future rate removed') })
  const today = todayISO()
  const pend = pendingOf(p)
  return (
    <div className="space-y-6">
      {pend && <PendingNote p={pend} what="A salary change is" />}
      <KV
        cols={2}
        items={[
          { label: 'Monthly CTC', value: <Money value={p.current?.monthly_ctc_paise} /> },
          { label: 'Cost per hour', value: fmtMoney(p.cost_per_hour_paise, { decimals: true }) },
          { label: 'Variable pay', value: p.current?.variable_pct ? `${p.current.variable_pct}% · ${fmtMoney(p.variable_paise)}` : '—' },
          { label: 'Sales target', value: p.current?.sales_target_paise ? fmtMoney(p.current.sales_target_paise) : '—' },
        ]}
      />
      <div>
        <h3 className="mb-2 text-[14px] font-semibold text-ink">History</h3>
        {p.history.length === 0 ? (
          <EmptyState compact title="No rate yet" body="Add a monthly CTC so this person’s hours are costed." />
        ) : (
          <ol className="relative space-y-3 border-l border-line pl-5">
            {p.history.map((h) => {
              const isCur = p.current?.id === h.id
              const future = h.effective_from > today
              return (
                <li key={h.id} className="relative">
                  <span className={`absolute -left-[26px] top-1.5 size-3 rounded-full ring-4 ring-elevated ${isCur ? 'bg-brand' : future ? 'bg-info' : 'bg-line-strong'}`} />
                  <div className="flex items-start gap-3 rounded-lg border border-line bg-surface p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                        From {fmtDate(h.effective_from, 'long')}
                        {isCur && <Badge tone="brand" size="sm">Current</Badge>}
                        {future && <Badge tone="info" size="sm">Upcoming</Badge>}
                        {h.locked && <Badge size="sm"><Lock className="mr-0.5 inline size-3" />Locked</Badge>}
                      </div>
                      <div className="tnum mt-0.5 text-[13px] text-ink-2">
                        {fmtMoney(h.monthly_ctc_paise)}/month{h.variable_pct ? ` · ${h.variable_pct}% variable` : ''}{h.sales_target_paise ? ` · target ${fmtMoney(h.sales_target_paise)}` : ''}
                      </div>
                    </div>
                    {canEdit && future && !pend && (
                      <IconButton size="sm" label="Remove future rate" onClick={async () => (await confirm({ title: 'Remove this future rate?', body: `The rate from ${fmtDate(h.effective_from, 'long')} will not apply.`, confirmLabel: 'Remove', tone: 'danger' })) && del.mutate(h.id)}>
                        <Trash2 className="size-4 text-danger-text" />
                      </IconButton>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
        {lockedThrough && <p className="mt-3 text-[12.5px] text-ink-3">Rates up to {fmtDate(lockedThrough, 'long')} are locked by a final payroll run.</p>}
      </div>
    </div>
  )
}

function AddRate({ person, lockedThrough, onClose }: { person: CostRatePerson; lockedThrough: string | null; onClose: () => void }) {
  const people = usePeopleMap()
  const d = people.get(person.user_id)
  const isSales = d?.role === 'sales'
  const latest = person.history[0]?.effective_from
  const minDate = [lockedThrough ? addDays(lockedThrough, 1) : null, latest ? addDays(latest, 1) : null].filter(Boolean).sort().pop() ?? undefined
  const firstOfNext = (() => {
    const t = new Date()
    const n = new Date(t.getFullYear(), t.getMonth() + 1, 1)
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-01`
  })()
  const [f, setF] = useState({
    monthly_ctc_paise: person.current?.monthly_ctc_paise ?? 0,
    variable_pct: person.current?.variable_pct ?? (isSales ? 20 : 0),
    sales_target_paise: person.current?.sales_target_paise ?? null as number | null,
    effective_from: minDate && minDate > firstOfNext ? minDate : firstOfNext,
  })
  const [targetTouched, setTargetTouched] = useState(false)
  useEffect(() => {
    if (isSales && !targetTouched) setF((x) => ({ ...x, sales_target_paise: x.monthly_ctc_paise }))
  }, [f.monthly_ctc_paise, isSales, targetTouched])
  // Salary changes are maker-checked: the response is applied now or waiting for a checker.
  const m = useMut(() => guarded('POST', '/cost-rates', { user_id: person.user_id, ...f, sales_target_paise: isSales ? f.sales_target_paise : null }), {
    invalidate: [['cost-rates'], ['changes']],
    onSuccess: (r) => {
      announce(r, 'New rate added')
      onClose()
    },
  })
  const e = m.error
  const change = person.current ? (f.monthly_ctc_paise - person.current.monthly_ctc_paise) / person.current.monthly_ctc_paise : null
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`New rate for ${d?.name ?? ''}`}
      description="Adds a row to the history. Earlier rows stay as they are."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>
            Add rate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Monthly CTC" htmlFor="ctc" required error={errField(e, 'monthly_ctc_paise')} hint={change !== null && Number.isFinite(change) && f.monthly_ctc_paise ? `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}% vs current` : undefined}>
            <MoneyInput id="ctc" value={f.monthly_ctc_paise} onChange={(v) => setF({ ...f, monthly_ctc_paise: v })} invalid={!!errField(e, 'monthly_ctc_paise')} />
          </Field>
          <Field label="Effective from" htmlFor="eff" required error={errField(e, 'effective_from')} hint={minDate ? `Earliest ${fmtDate(minDate)}` : undefined}>
            <Input id="eff" type="date" min={minDate} value={f.effective_from} onChange={(ev) => setF({ ...f, effective_from: ev.target.value })} invalid={!!errField(e, 'effective_from')} />
          </Field>
          <Field label="Variable pay" htmlFor="var" error={errField(e, 'variable_pct')} hint="Share of CTC paid on hitting target. 0–50%.">
            <Input id="var" type="number" min={0} max={50} suffix="%" value={String(f.variable_pct)} onChange={(ev) => setF({ ...f, variable_pct: Number(ev.target.value) })} invalid={!!errField(e, 'variable_pct')} />
          </Field>
          {isSales && (
            <Field label="Monthly sales target" htmlFor="tgt" error={errField(e, 'sales_target_paise')} hint="Defaults to monthly CTC.">
              <MoneyInput
                id="tgt"
                value={f.sales_target_paise}
                onChange={(v) => {
                  setTargetTouched(true)
                  setF({ ...f, sales_target_paise: v })
                }}
              />
            </Field>
          )}
        </div>
        {f.effective_from < todayISO() && <Callout tone="warning">Backdated to {monthOf(f.effective_from)}: project costs from that date will use this rate.</Callout>}
      </div>
    </Dialog>
  )
}
