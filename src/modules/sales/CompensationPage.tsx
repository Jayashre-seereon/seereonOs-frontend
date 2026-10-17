// G12.01–G12.05 Sales cost vs deals closed: Month / Quarter / Year, per-salesperson pay (base + variable earned),
// editable variable % and monthly target (saved as a new cost-rate row, maker-checked), team totals, trend by month.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BarChart3, Download, Table2 } from '@/ui/icons'
import {
  Badge, BarChart, Button, Callout, Card, CardHeader, EmptyState, ErrorState, Input, MoneyInput, PageHeader, PeriodSwitch, Segmented, SkeletonCards, SkeletonRows, useReadOnly,
} from '@/ui'
import { useMut } from '@/api/query'
import { announce } from '@/api/changes'
import { COMP_INVALIDATE, salesApi, useCompensation, type CompensationResult, type CompPerson } from '@/api/sales'
import { useTenant } from '@/api/core'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { exportTable } from '@/reports/export'
import { cn } from '@/lib/utils'
import { useSalesPeriod } from './components'

/** Closed ÷ sales cost as "13.5×" (same format as the Performance page). */
const fmtX = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${fmtNum(v, 1)}×`)
const pctTone = (v: number | null) => (v === null ? 'neutral' : v >= 1 ? 'success' : v >= 0.5 ? 'warning' : 'danger')

export default function CompensationPage() {
  const fy = useTenant().data?.settings['company.fy_start_month'] ?? 4
  const [period, setPeriod] = useSalesPeriod()
  const q = useCompensation(period.kind, period.anchor)
  const d = q.data

  const doExport = () => {
    if (!d) return
    exportTable(
      {
        title: 'Sales cost vs deals closed',
        subtitle: d.label,
        orientation: 'landscape',
        columns: [
          { key: 'name', label: 'Salesperson', type: 'string' }, { key: 'ctc', label: 'CTC in period', type: 'money' }, { key: 'vp', label: 'Variable %', type: 'number' }, { key: 'mt', label: 'Monthly target', type: 'money' },
          { key: 'tp', label: 'Target in period', type: 'money' }, { key: 'closed', label: 'Closed', type: 'money' }, { key: 'ach', label: 'Achieved', type: 'percent' }, { key: 've', label: 'Variable earned', type: 'money' }, { key: 'payout', label: 'Sales cost (base + variable earned)', type: 'money' },
        ],
        rows: d.people.map((p) => ({ name: p.name, ctc: p.ctc_in_period, vp: p.variable_pct, mt: p.monthly_target, tp: p.target_in_period, closed: p.closed, ach: p.achievement, ve: p.variable_earned, payout: p.payout })),
        totals: { ctc: d.totals.ctc, tp: d.totals.target, closed: d.totals.closed, ve: d.totals.variable_earned, payout: d.totals.payout },
        notes: [
          `Variable pay is decided month by month: it is paid only in a month where that month's target is met (${d.threshold_pct}%). A quarter or year is the sum of monthly payouts; months still to come are not counted.`,
          'Deal value = one-time value + 12 months of recurring.',
        ],
      },
      'pdf',
    )
  }

  return (
    <div>
      <PageHeader
        title="Sales cost vs deals closed"
        subtitle={d?.scope === 'self' ? 'Your base pay, target, deals closed and variable earned.' : 'What sales costs against what it brings in, per person and per period.'}
        meta={d ? <Badge tone="neutral" size="md">{d.scope === 'self' ? 'Your pay only' : d.can_edit ? 'Editors can change variable % and targets' : 'Read only'}</Badge> : undefined}
        actions={
          <>
            <PeriodSwitch value={period} onChange={setPeriod} fyStartMonth={fy} />
            <Button icon={<Download className="size-4" />} onClick={doExport} disabled={!d?.people.length} className="hidden md:inline-flex">
              Export
            </Button>
          </>
        }
      />
      {q.isLoading ? (
        <>
          <SkeletonCards n={4} />
          <div className="mt-4 rounded-lg border border-line bg-surface p-5"><SkeletonRows rows={3} /></div>
        </>
      ) : q.error || !d ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !d.people.length ? (
        <Card><EmptyState title="No sales people" body="Pay here applies to people with a Sales role and a cost rate. Add one under People, then set their CTC in Settings → Cost rates." /></Card>
      ) : (
        <div className="space-y-4">
          <Kpis d={d} />
          <PeopleTable d={d} />
          <Trend d={d} />
          <p className="text-[12.5px] leading-relaxed text-ink-3">
            Variable pay is decided month by month: it’s paid only in a month where that month’s target is met ({d.threshold_pct}% of target), so a quarter or year shows the sum of monthly payouts.
            Default target = the person’s monthly CTC. Deal value = one-time value + 12 months of recurring. Months still to come in a quarter or year are not counted.
          </p>
        </div>
      )}
    </div>
  )
}

function Kpi({ value, label, tone }: { value: string; label: string; tone?: 'success' | 'danger' | 'warning' | 'neutral' }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface px-4 py-3.5">
      <div className={cn('tnum whitespace-nowrap text-[20px] font-semibold leading-tight', tone === 'success' ? 'text-success-text' : tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : 'text-ink')}>{value}</div>
      <div className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{label}</div>
    </div>
  )
}

function Kpis({ d }: { d: CompensationResult }) {
  const n = d.people.length
  const t = d.totals
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Kpi value={fmtMoney(t.sales_cost)} label={`Sales cost, ${d.label}: base salary + variable pay earned (${n} ${n === 1 ? 'person' : 'people'})`} />
      <Kpi value={fmtMoney(t.closed)} label="Deals closed (value of deals won in the period)" />
      <Kpi value={fmtX(t.ratio)} label={`Rupees of sales per ₹1 of sales cost (${fmtMoney(t.closed)} ÷ ${fmtMoney(t.sales_cost)})`} tone={pctTone(t.ratio)} />
      <Kpi value={fmtMoney(t.ctc)} label={`CTC in period, for reference (variable is paid only when the target is met)`} />
    </div>
  )
}

function AchievedBadge({ v }: { v: number | null }) {
  if (v === null) return <span className="text-ink-3">—</span>
  return <Badge tone={v >= 1 ? 'success' : 'danger'} size="sm">{fmtPct(v, 0)}</Badge>
}

function wonLine(p: CompPerson) {
  if (!p.deals.length) return 'No deals won'
  const first = p.deals[0]
  return `${p.deals.length} ${p.deals.length === 1 ? 'deal' : 'deals'} won: ${first.title}, ${first.client}${p.deals.length > 1 ? ` +${p.deals.length - 1} more` : ''}`
}

/* ------------------------------------------------------------------ */
/* Editable row state                                                  */
/* ------------------------------------------------------------------ */
function useRowEdit(p: CompPerson) {
  const readOnly = useReadOnly()
  const [vp, setVp] = useState(String(p.variable_pct))
  const [target, setTarget] = useState(p.monthly_target)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setVp(String(p.variable_pct))
    setTarget(p.monthly_target)
    setError(null)
  }, [p.user_id, p.variable_pct, p.monthly_target, p.pending_change?.id])
  const save = useMut((b: Parameters<typeof salesApi.saveComp>[0]) => salesApi.saveComp(b), {
    invalidate: COMP_INVALIDATE,
    onSuccess: (r) => announce(r, `Pay settings saved for ${p.name}`),
    onError: (e) => setError(e.message),
  })
  const vpNum = Number(vp)
  const dirty = vp.trim() !== String(p.variable_pct) || target !== p.monthly_target
  const pending = !!p.pending_change
  const editable = !readOnly && !!p.next_effective_from && !pending
  const submit = () => {
    if (vp.trim() === '' || !Number.isFinite(vpNum) || vpNum < 0 || vpNum > 50) return setError('Variable % must be between 0 and 50.')
    if (!Number.isInteger(target) || target < 0) return setError('Enter a monthly target of zero or more.')
    setError(null)
    save.mutate({
      user_id: p.user_id,
      monthly_ctc_paise: p.monthly_ctc,
      variable_pct: vpNum,
      // keep "default = monthly CTC" when the target was not touched
      sales_target_paise: p.target_is_default && target === p.monthly_target ? null : target,
      effective_from: p.next_effective_from!,
    })
  }
  return { vp, setVp, target, setTarget, error, dirty, pending, editable, submit, saving: save.isPending }
}

function PeopleTable({ d }: { d: CompensationResult }) {
  const t = d.totals
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 pt-4 md:px-5">
        <CardHeader title="Per salesperson" subtitle={`${d.label} · ${d.months.length} ${d.months.length === 1 ? 'month' : 'months'} counted`} className="mb-3" />
      </div>
      {/* phones: one card per person */}
      <ul className="divide-y divide-line border-t border-line md:hidden">
        {d.people.map((p) => <PersonCard key={p.user_id} p={p} canEdit={d.can_edit} />)}
        <li className="flex items-center justify-between gap-3 bg-surface-2 px-4 py-3 text-[13px]">
          <span className="font-semibold text-ink">Team</span>
          <span className="tnum text-right text-ink-2">
            Closed <span className="font-semibold text-ink">{fmtMoney(t.closed)}</span> · sales cost <span className="font-semibold text-ink">{fmtMoney(t.payout)}</span>
          </span>
        </li>
      </ul>
      {/* tablet & desktop: table, scrolls inside the card */}
      <div className="relative hidden overflow-x-auto scroll-thin md:block">
        <table className="w-full min-w-[980px] text-[13.5px]">
          <thead>
            <tr className="border-y border-line bg-surface-2 text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
              <th className="py-2 pl-5 pr-3 font-medium">Salesperson</th>
              <th className="px-3 py-2 text-right font-medium">CTC in period</th>
              <th className="px-3 py-2 font-medium">Variable %</th>
              <th className="px-3 py-2 font-medium">Monthly target</th>
              <th className="px-3 py-2 text-right font-medium">Target in period</th>
              <th className="px-3 py-2 text-right font-medium">Closed</th>
              <th className="px-3 py-2 text-right font-medium">Achieved</th>
              <th className="px-3 py-2 text-right font-medium">Variable earned</th>
              <th className="px-3 py-2 text-right font-medium" title="Base salary + variable pay earned">Sales cost</th>
              {d.can_edit && <th className="py-2 pl-3 pr-5"><span className="sr-only">Save</span></th>}
            </tr>
          </thead>
          <tbody>
            {d.people.map((p) => <PersonRow key={p.user_id} p={p} canEdit={d.can_edit} />)}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-surface-2/60 font-semibold">
              <td className="py-2.5 pl-5 pr-3 text-ink">Team</td>
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(t.ctc)}</td>
              <td />
              <td />
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right font-medium">{fmtMoney(t.target)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(t.closed)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right font-medium">{t.target ? fmtPct(t.closed / t.target, 0) : '—'}</td>
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right font-medium">{fmtMoney(t.variable_earned)}</td>
              <td className="tnum whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(t.payout)}</td>
              {d.can_edit && <td />}
            </tr>
          </tfoot>
        </table>
      </div>
      {d.scope === 'self' && d.people[0] && <SelfHint p={d.people[0]} d={d} />}
    </Card>
  )
}

function PendingNote({ p }: { p: CompPerson }) {
  if (!p.pending_change) return null
  return (
    <Badge tone="warning" size="sm">
      Pending approval
    </Badge>
  )
}

function PersonRow({ p, canEdit }: { p: CompPerson; canEdit: boolean }) {
  const e = useRowEdit(p)
  return (
    <>
      <tr className="border-b border-line align-top last:border-0">
        <td className="max-w-[240px] py-3 pl-5 pr-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-ink">{p.name}</span>
            <PendingNote p={p} />
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-3">
            {p.deals.length ? (
              <>
                {p.deals.length} {p.deals.length === 1 ? 'deal' : 'deals'} won:{' '}
                {p.deals.map((dl, i) => (
                  <span key={dl.id}>
                    {i > 0 && '; '}
                    <Link to={`/sales/${dl.id}`} className="hover:text-brand-text hover:underline">{dl.title}, {dl.client}</Link>
                  </span>
                ))}
              </>
            ) : (
              wonLine(p)
            )}
          </div>
          {!p.has_rate && <div className="mt-1 text-[12px] text-warning-text">No cost rate yet — set CTC in Settings → Cost rates.</div>}
        </td>
        <td className="tnum whitespace-nowrap px-3 py-3 text-right">{fmtMoney(p.ctc_in_period)}</td>
        <td className="px-3 py-2">
          {canEdit ? (
            <Input aria-label={`Variable % for ${p.name}`} type="number" inputMode="decimal" min={0} max={50} value={e.vp} onChange={(x) => e.setVp(x.target.value)} disabled={!e.editable} className="w-[72px]" invalid={!!e.error && e.error.startsWith('Variable')} />
          ) : (
            <span className="tnum block py-1">{p.variable_pct}%</span>
          )}
        </td>
        <td className="px-3 py-2">
          {canEdit ? (
            <MoneyInput value={e.target} onChange={e.setTarget} disabled={!e.editable} className="w-[124px]" invalid={!!e.error && e.error.includes('target')} />
          ) : (
            <span className="tnum block whitespace-nowrap py-1">{fmtMoney(p.monthly_target)}</span>
          )}
        </td>
        <td className="tnum whitespace-nowrap px-3 py-3 text-right">{fmtMoney(p.target_in_period)}</td>
        <td className="tnum whitespace-nowrap px-3 py-3 text-right">{fmtMoney(p.closed)}</td>
        <td className="px-3 py-3 text-right"><AchievedBadge v={p.achievement} /></td>
        <td className={cn('tnum whitespace-nowrap px-3 py-3 text-right', p.variable_earned ? 'font-semibold text-success-text' : 'text-ink-3')}>{fmtMoney(p.variable_earned)}</td>
        <td className="tnum whitespace-nowrap px-3 py-3 text-right font-semibold">{fmtMoney(p.payout)}</td>
        {canEdit && (
          <td className="py-2 pl-3 pr-5 text-right">
            <Button size="sm" onClick={e.submit} loading={e.saving} disabled={!e.editable || !e.dirty}>
              Save
            </Button>
          </td>
        )}
      </tr>
      {canEdit && (e.error || e.dirty || p.pending_change) && (
        <tr className="border-b border-line">
          <td colSpan={10} className="px-5 pb-3 pt-0 text-[12px]">
            {e.error ? (
              <span className="text-danger-text">{e.error}</span>
            ) : p.pending_change ? (
              <span className="text-ink-3">Waiting for {p.pending_change.checker_names.join(' or ') || 'a checker'}: {p.pending_change.summary}.</span>
            ) : (
              <span className="text-ink-3">Saving adds a new cost-rate row from {fmtDate(p.next_effective_from)}; earlier months keep their old settings.</span>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function PersonCard({ p, canEdit }: { p: CompPerson; canEdit: boolean }) {
  const e = useRowEdit(p)
  const facts: [string, string][] = [
    ['CTC in period', fmtMoney(p.ctc_in_period)],
    ['Target in period', fmtMoney(p.target_in_period)],
    ['Closed', fmtMoney(p.closed)],
    ['Variable earned', fmtMoney(p.variable_earned)],
  ]
  return (
    <li className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-ink">{p.name}</span>
            <PendingNote p={p} />
          </div>
          <div className="mt-0.5 text-[12px] leading-snug text-ink-3">{wonLine(p)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum text-[15px] font-semibold" title="Sales cost: base + variable earned">{fmtMoney(p.payout)}</div>
          <div className="mt-0.5"><AchievedBadge v={p.achievement} /></div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        {facts.map(([l, v]) => (
          <div key={l} className="min-w-0">
            <dt className="text-[12px] text-ink-3">{l}</dt>
            <dd className="tnum font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      {canEdit ? (
        <div className="mt-3 grid grid-cols-[88px_minmax(0,1fr)] gap-2">
          <label className="min-w-0">
            <span className="text-[12px] text-ink-3">Variable %</span>
            <Input type="number" inputMode="decimal" min={0} max={50} value={e.vp} onChange={(x) => e.setVp(x.target.value)} disabled={!e.editable} />
          </label>
          <label className="min-w-0">
            <span className="text-[12px] text-ink-3">Monthly target</span>
            <MoneyInput value={e.target} onChange={e.setTarget} disabled={!e.editable} />
          </label>
          {e.error && <p className="col-span-2 text-[12px] text-danger-text">{e.error}</p>}
          <Button className="col-span-2" onClick={e.submit} loading={e.saving} disabled={!e.editable || !e.dirty}>
            Save
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[12.5px] text-ink-3">Variable {p.variable_pct}% · monthly target {fmtMoney(p.monthly_target)}</p>
      )}
    </li>
  )
}

function SelfHint({ p, d }: { p: CompPerson; d: CompensationResult }) {
  const cur = p.months[p.months.length - 1]
  if (!cur || cur.hit || !p.has_rate) return null
  const gap = Math.max(0, Math.ceil((cur.target * d.threshold_pct) / 100) - cur.achieved)
  if (!gap) return null
  return (
    <div className="border-t border-line px-4 py-3 md:px-5">
      <Callout tone="neutral">
        Close <span className="tnum font-medium text-ink">{fmtMoney(gap)}</span> more in {cur.label} to earn the <span className="tnum font-medium text-ink">{fmtMoney(cur.variable)}</span> variable. Below {d.threshold_pct}% of target only the base is paid.
      </Callout>
    </div>
  )
}

function Trend({ d }: { d: CompensationResult }) {
  const [v, setV] = useState<'table' | 'chart'>('table')
  const series = [
    { key: 'sales_cost', label: 'Sales cost', format: 'money' as const },
    { key: 'closed', label: 'Deals closed', format: 'money' as const },
  ]
  return (
    <Card pad={false} className="overflow-hidden">
      <div className="px-4 pt-4 md:px-5">
        <CardHeader
          title="Trend by month"
          subtitle="Sales cost (base salary + variable pay earned) against deals closed, this financial year to date"
          className="mb-3"
          action={<Segmented size="sm" value={v} onChange={setV} options={[{ value: 'table', label: <Table2 className="size-3.5" aria-label="Table" /> }, { value: 'chart', label: <BarChart3 className="size-3.5" aria-label="Chart" /> }]} />}
        />
      </div>
      {v === 'chart' ? (
        <div className="px-4 pb-4 md:px-5">
          <BarChart data={d.trend as unknown as Record<string, unknown>[]} x="label" series={series} format="money" height={260} />
        </div>
      ) : (
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full min-w-[520px] text-[13.5px]">
            <thead>
              <tr className="border-y border-line bg-surface-2 text-left text-[11.5px] uppercase tracking-[0.04em] text-ink-3">
                <th className="py-2 pl-4 pr-3 font-medium md:pl-5">Month</th>
                <th className="px-3 py-2 text-right font-medium">Sales cost</th>
                <th className="px-3 py-2 text-right font-medium">Deals closed</th>
                <th className="px-3 py-2 text-right font-medium">CTC</th>
                <th className="py-2 pl-3 pr-4 text-right font-medium md:pr-5">Closed ÷ sales cost</th>
              </tr>
            </thead>
            <tbody>
              {d.trend.map((m) => (
                <tr key={m.month} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap py-2.5 pl-4 pr-3 md:pl-5">{m.label}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2.5 text-right font-medium">{fmtMoney(m.sales_cost)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2.5 text-right">{fmtMoney(m.closed)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-2.5 text-right text-ink-3">{fmtMoney(m.salary_cost)}</td>
                  <td className="py-2.5 pl-3 pr-4 text-right md:pr-5">
                    {m.ratio === null ? <span className="text-ink-3">—</span> : <Badge tone={m.ratio >= 1 ? 'success' : 'danger'} size="sm">{fmtX(m.ratio)}</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
