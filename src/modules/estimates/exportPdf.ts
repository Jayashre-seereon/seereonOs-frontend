// Estimate PDFs through the shared corporate exporter (src/reports/export). Two documents:
//  - Internal costing sheet: resources, man-days, cost, contingency, price, profit, margin and markup (named people's
//    cost appears only when the server sent it, i.e. the viewer holds the salaries permission).
//  - Client quote: scope by milestone, billing schedule and the price — no cost, margin, markup or rates.
import { exportTable } from '@/reports/export'
import type { EstimateDetail, EstimatePreview } from '@/api/estimates'
import type { DirectoryPerson } from '@/api/core'
import { additionalCategoryLabel, commercialShort } from '@/domain/costing'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { PROJECT_TYPE } from '@/domain/labels'

type People = { get: (id: string | null | undefined) => DirectoryPerson | undefined }

export async function exportInternalCosting(d: EstimateDetail, pv: EstimatePreview, people: People) {
  const e = d.estimate
  const t = pv.totals
  const msName = (i: number | null) => (i === null ? '—' : pv.milestones[i] ? `${pv.milestones[i].code} ${pv.milestones[i].name}` : '—')
  const rows = pv.rows.map((r) => ({
    milestone: msName(r.milestone_index),
    resource: r.kind === 'person' ? people.get(r.user_id)?.name ?? 'Person' : `${r.role_label ?? 'Role'} (placeholder)`,
    pct: r.pct !== null ? r.pct / 100 : null,
    from: r.from_on,
    to: r.to_on,
    days: r.working_days,
    man_days: r.man_days,
    cpd: r.cost_per_day,
    cost: r.cost,
  }))
  const hiddenNamed = !pv.can_see_rates && pv.named_rows > 0
  return exportTable(
    {
      title: `${e.number ?? ''} ${e.name} — internal costing`.trim(),
      subtitle: `${e.client} · ${fmtDate(e.start_on)} – ${fmtDate(e.end_on)} · ${PROJECT_TYPE[e.type as keyof typeof PROJECT_TYPE] ?? e.type}, ${commercialShort(e.billing_model)} · version ${e.version}`,
      category: 'Internal costing — confidential',
      orientation: 'landscape',
      columns: [
        { key: 'milestone', label: 'Milestone', type: 'string' },
        { key: 'resource', label: 'Resource', type: 'string' },
        { key: 'pct', label: 'Alloc.', type: 'percent' },
        { key: 'from', label: 'From', type: 'date' },
        { key: 'to', label: 'To', type: 'date' },
        { key: 'days', label: 'Working days', type: 'number' },
        { key: 'man_days', label: 'Man-days', type: 'hours' },
        { key: 'cpd', label: 'Cost/day', type: 'money' },
        { key: 'cost', label: 'Cost', type: 'money' },
      ],
      rows,
      totals: { man_days: t.man_days, cost: hiddenNamed ? null : t.resources },
      kpis: [
        { label: 'Total cost', value: fmtMoney(t.total_cost) },
        { label: `Contingency (${pv.contingency_pct}%)`, value: fmtMoney(t.contingency) },
        { label: 'Price', value: fmtMoney(t.price) },
        { label: 'Profit', value: fmtMoney(t.profit) },
        { label: 'Planned margin', value: fmtPct(t.margin) },
        { label: 'Markup', value: fmtPct(t.markup) },
      ],
      notes: [
        `Working days ${pv.summary?.working_days ?? 0} (${pv.summary?.calendar_days ?? 0} calendar days, ${pv.summary?.weekend_days ?? 0} weekend days, ${pv.summary?.holidays ?? 0} holidays). Man-days ${fmtNum(t.man_days, 1)} across ${t.resource_rows} resource rows.`,
        `People ${fmtMoney(t.resources)} · additional costs ${fmtMoney(t.additional)} · maintenance / support ${fmtMoney(t.maintenance)} · contingency ${fmtMoney(t.contingency)} = total cost ${fmtMoney(t.total_cost)}.`,
        ...pv.additional_costs.filter((a) => a.amount_paise > 0).map((a) => `Additional cost — ${additionalCategoryLabel(a.category)}: ${a.description} ${fmtMoney(a.amount_paise)}.`),
        ...pv.by_milestone.map((m) => `${m.code} ${m.name} (${fmtDate(m.start)} – ${fmtDate(m.end)}): billing ${fmtMoney(m.billing)}, cost ${fmtMoney(m.total_cost)}, net ${fmtMoney(m.net)}, cumulative ${fmtMoney(m.cumulative_net)}.`),
        `Cost per hour = monthly CTC ÷ (working days in the month × ${pv.min_hours ?? 9} minimum hours); a row costs working days × allocation × cost per day, month by month. Role placeholders use the assumed CTC typed on the estimate. Margin = profit ÷ price; markup = profit ÷ cost.`,
        ...(pv.below_floor ? [`Planned margin ${fmtPct(t.margin)} is below the ${pv.floor_pct}% floor.`] : []),
        ...(hiddenNamed ? ['Cost of named people is private to the salaries permission; it is included in the totals.'] : []),
      ],
    },
    'pdf',
    `${e.number ?? 'estimate'}-internal-costing`,
  )
}

export async function exportClientQuote(d: EstimateDetail, pv: EstimatePreview, company: string) {
  const e = d.estimate
  const lines = pv.by_milestone.map((m) => ({ ms: `${m.code} ${m.name}`, period: `${fmtDate(m.start)} – ${fmtDate(m.end)}`, billing: m.billing }))
  const price = pv.totals.price ?? 0
  return exportTable(
    {
      title: `Quotation — ${e.name}`,
      subtitle: `Prepared for ${e.client} · ${e.number ?? ''} · ${fmtDate(e.start_on)} – ${fmtDate(e.end_on)}`,
      category: 'Quotation',
      orientation: 'portrait',
      columns: [
        { key: 'ms', label: 'Milestone / deliverable', type: 'string' },
        { key: 'period', label: 'Planned period', type: 'string' },
        { key: 'billing', label: 'Amount (excl. GST)', type: 'money' },
      ],
      rows: lines.length ? lines : [{ ms: e.name, period: `${fmtDate(e.start_on)} – ${fmtDate(e.end_on)}`, billing: price }],
      totals: { billing: price },
      kpis: [
        { label: 'Quote value (excl. GST)', value: fmtMoney(price) },
        { label: 'Commercial model', value: commercialShort(e.billing_model) },
        { label: 'Duration', value: `${pv.summary?.working_days ?? 0} working days` },
        { label: 'Milestones', value: String(Math.max(1, pv.by_milestone.length)) },
      ],
      notes: [
        ...(e.description ? [e.description] : []),
        ...(pv.unscheduled_billing > 0 && pv.by_milestone.length ? [`The last milestone includes the balance of ${fmtMoney(pv.unscheduled_billing)} billed on completion.`] : []),
        'GST is charged extra at the applicable rate. Each milestone is invoiced on sign-off; payment within the agreed terms.',
        'Dates are planned working-day estimates from the start date and move if the start moves.',
        `This quotation is valid for 30 days from ${fmtDate(new Date().toISOString().slice(0, 10))}. ${company}.`,
      ],
    },
    'pdf',
    `${e.number ?? 'estimate'}-quotation`,
  )
}
