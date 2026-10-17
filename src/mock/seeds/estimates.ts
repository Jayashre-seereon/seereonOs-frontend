// v7 seed — standalone project cost estimates (Project cost calculator).
// Seereon: a draft for the Kalinga Public School deal (named people + a Flutter developer not hired yet), a shared
// DMS phase-2 estimate for Utkal Tubes with a cheaper "Scenario B", and an estimate already converted into the
// Digitalratha Sales CRM project (rebuilt from that project's saved plan, so both show the same planned numbers).
// Kalinga Softworks gets one draft. Runs after the costing seed (it reads the saved allocations and costing).
// Costs use the Feature Guide formula (cost per hour = CTC ÷ (working days in the month × minimum hours)), computed
// here the same way the server does, so the revision history matches what the screens show.
import type { DB } from '../server'
import type { CostEstimate } from '@/types/v7'
import type { SeedHelpers } from './index'
import { addDays, minISO, monthOf, monthRange, workingDaysBetween, workingDaysInMonth, type CalendarCtx } from '@/domain/calendar'
import { rateOn } from '@/domain/costing'

const R = (rupees: number) => Math.round(rupees * 100)
type Res = CostEstimate['resources'][number]
type Add = CostEstimate['additional_costs'][number]

export function seed(db: DB, h: SeedHelpers) {
  const today = h.today
  const at = (d: string, hh = 10) => `${d}T${String(hh).padStart(2, '0')}:15:00Z`

  const make = (T: string) => {
    const tenant = db.tenants.find((t) => t.id === T)!
    const cal: CalendarCtx = { settings: tenant.settings, holidays: db.holidays.filter((x) => x.tenant_id === T && !x.optional) }
    const rates = db.cost_rates.filter((r) => r.tenant_id === T)
    const ctcOf = (userId: string, date: string) => (rateOn(rates, userId, date) ?? rates.filter((x) => x.user_id === userId).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0])?.monthly_ctc_paise ?? 0
    /** resource cost, month by month: working days × % × (CTC ÷ working days in the month) */
    const rowCost = (r: Res) => {
      let cost = 0, days = 0
      for (let a = r.from_on!; a <= r.to_on!; ) {
        const ym = monthOf(a)
        const b = minISO(monthRange(ym).to, r.to_on!)
        const d = workingDaysBetween(a, b, cal)
        const ctc = r.user_id ? ctcOf(r.user_id, a) : r.monthly_ctc_paise ?? 0
        cost += (d * r.pct * ctc) / workingDaysInMonth(ym, cal) / 100
        days += d
        a = addDays(b, 1)
      }
      return { cost: Math.round(cost), md: Math.round(((days * r.pct) / 100) * 10) / 10 }
    }
    const totals = (res: Res[], add: Add[], maint: number, contPct: number) => {
      const people = res.reduce((s, r) => s + rowCost(r).cost, 0)
      const extra = add.reduce((s, a) => s + a.amount_paise, 0)
      const cont = Math.round(((people + extra) * contPct) / 100)
      return { total: people + extra + maint + cont, md: Math.round(res.reduce((s, r) => s + rowCost(r).md, 0) * 10) / 10 }
    }
    /** price that lands the target margin, rounded to the nearest ₹1,000 */
    const priceFor = (total: number, margin: number) => Math.round(total / (1 - margin) / 100_000) * 100_000
    const est = (e: Omit<CostEstimate, 'id' | 'tenant_id' | 'created_at' | 'updated_at' | 'version' | 'markup_pct' | 'revisions'> & { id: string; created: string; updated: string; saves: string[] }) => {
      const t = totals(e.resources, e.additional_costs, e.maintenance_paise, e.contingency_pct)
      const markup = t.total > 0 ? Math.round(((e.price_paise - t.total) / t.total) * 10000) / 100 : 0
      const { created, updated, saves, ...rest } = e
      const revisions = saves.map((note, i) => ({ version: i + 1, at: at(i === saves.length - 1 ? updated : addDays(created, i), 9 + i), by: e.owner_id, note, price_paise: e.price_paise, total_cost_paise: t.total, man_days: t.md }))
      const row: CostEstimate = { ...h.base(T), ...rest, markup_pct: markup, revisions, created_at: at(created, 9), updated_at: at(updated, 9 + saves.length - 1), version: saves.length, created_by: e.owner_id }
      db.cost_estimates.push(row)
      return { row, total: t.total }
    }
    return { est, totals, priceFor, rowCost }
  }

  /* ---------------- Seereon ---------------- */
  const T1 = 'tn_seereon'
  if (db.tenants.some((t) => t.id === T1)) {
    const { est, totals, priceFor } = make(T1)
    let seq = 0

    // 1. Kalinga Public School — EduReon rollout (draft, linked to the pipeline deal; a role not hired yet)
    {
      const s = addDays(today, 21)
      const ms = [
        { key: 'M1', name: 'Discovery and fee structures', amt: 40000 },
        { key: 'M2', name: 'Student data migration and setup', amt: 60000 },
        { key: 'M3', name: 'Parent app and go-live', amt: 80000 },
        { key: 'M4', name: 'Hypercare and teacher training', amt: 60000 },
      ]
      const d = (o: number) => addDays(s, o)
      const resources: Res[] = [
        { id: 'r1', user_id: 'u_pragyasmita', role_label: null, monthly_ctc_paise: null, milestone_key: 'M1', pct: 60, from_on: d(0), to_on: d(20) },
        { id: 'r2', user_id: 'u_jayashree', role_label: null, monthly_ctc_paise: null, milestone_key: 'M2', pct: 50, from_on: d(21), to_on: d(48) },
        { id: 'r3', user_id: 'u_pragyasmita', role_label: null, monthly_ctc_paise: null, milestone_key: 'M2', pct: 30, from_on: d(21), to_on: d(48) },
        { id: 'r4', user_id: null, role_label: 'Flutter developer (to hire)', monthly_ctc_paise: R(55000), milestone_key: 'M3', pct: 50, from_on: d(49), to_on: d(90) },
        { id: 'r5', user_id: 'u_subhankar', role_label: null, monthly_ctc_paise: null, milestone_key: 'M4', pct: 10, from_on: d(91), to_on: d(118) },
      ]
      const additional: Add[] = [
        { id: 'ac1', category: 'software', description: 'Play Store developer account and SMS gateway credits', amount_paise: R(9500) },
        { id: 'ac2', category: 'travel', description: 'Campus visits for data migration and teacher training', amount_paise: R(6000) },
      ]
      const deal = db.deals.find((x) => x.id === 'd_kps')
      est({
        id: 'est_kps', number: `EST-${String(++seq).padStart(3, '0')}`, name: 'Kalinga Public School — EduReon rollout', client: 'Kalinga Public School', client_id: null, deal_id: deal ? deal.id : null, project_id: null,
        status: 'draft', start_on: s, end_on: d(118), type: 'product', billing_model: 'fixed', stream: 'products',
        milestones: ms.map((m) => ({ key: m.key, name: m.name, billing_amount_paise: R(m.amt), start_on: null, end_on: null })),
        resources, additional_costs: additional, maintenance_paise: R(12000), contingency_pct: 5, price_paise: R(240000),
        notes: 'Fee module first: the principal wants Razorpay fee collection live before the new session. Flutter developer is an assumed hire (₹55,000 CTC); Jayashree covers if the hire slips.',
        description: 'EduReon for one campus: admissions, fees with Razorpay, parent app and teacher training.',
        owner_id: 'u_santosh', scenario_of: null, scenario_label: null, shared_on: null, decided_on: null, lost_reason: null, converted_on: null,
        created: addDays(today, -6), updated: addDays(today, -2), saves: ['Created from Baishali’s demo call notes', 'Added the Flutter developer for the parent app'],
      })
    }

    // 2. Utkal Tubes — DMS phase 2 (shared) and a leaner Scenario B
    {
      const s = addDays(today, 35)
      const d = (o: number) => addDays(s, o)
      const ms = [
        { key: 'M1', name: 'Approval workflows', amt: 220000 },
        { key: 'M2', name: 'OCR indexing and search', amt: 180000 },
        { key: 'M3', name: 'UAT and rollout', amt: 0 },
      ]
      const resA: Res[] = [
        { id: 'r1', user_id: 'u_bijaya', role_label: null, monthly_ctc_paise: null, milestone_key: 'M1', pct: 80, from_on: d(0), to_on: d(41) },
        { id: 'r2', user_id: 'u_hritesh', role_label: null, monthly_ctc_paise: null, milestone_key: 'M1', pct: 50, from_on: d(0), to_on: d(41) },
        { id: 'r3', user_id: null, role_label: 'Senior React developer', monthly_ctc_paise: R(80000), milestone_key: 'M2', pct: 100, from_on: d(42), to_on: d(76) },
        { id: 'r4', user_id: 'u_jagannath', role_label: null, monthly_ctc_paise: null, milestone_key: 'M2', pct: 60, from_on: d(42), to_on: d(76) },
        { id: 'r5', user_id: 'u_subhankar', role_label: null, monthly_ctc_paise: null, milestone_key: 'M3', pct: 20, from_on: d(77), to_on: d(97) },
        { id: 'r6', user_id: null, role_label: 'QA engineer (contract)', monthly_ctc_paise: R(38000), milestone_key: 'M3', pct: 100, from_on: d(77), to_on: d(97) },
      ]
      const addA: Add[] = [
        { id: 'ac1', category: 'software', description: 'OCR engine licence (Tesseract support plan)', amount_paise: R(24000) },
        { id: 'ac2', category: 'third_party', description: 'Additional storage and backup for scanned documents (year 1)', amount_paise: R(18000) },
      ]
      const tA = totals(resA, addA, R(20000), 8)
      const priceA = Math.max(R(400000), priceFor(tA.total, 0.38))
      const a = est({
        id: 'est_utkal', number: `EST-${String(++seq).padStart(3, '0')}`, name: 'Utkal Tubes — DMS phase 2 (workflows & OCR)', client: 'Utkal Tubes Ltd', client_id: null, deal_id: null, project_id: null,
        status: 'shared', start_on: s, end_on: d(97), type: 'service', billing_model: 'tm', stream: 'services',
        milestones: ms.map((m) => ({ key: m.key, name: m.name, billing_amount_paise: R(m.amt), start_on: null, end_on: null })),
        resources: resA, additional_costs: addA, maintenance_paise: R(20000), contingency_pct: 8, price_paise: priceA,
        notes: 'Quote shared with the Utkal IT head after the phase-1 review. Senior React developer is budgeted at market CTC; we may staff Hritesh full-time instead.',
        description: 'Phase 2 of the DMS: approval routing, OCR indexing of scanned records and full-text search.',
        owner_id: 'u_santosh', scenario_of: null, scenario_label: 'Scenario A', shared_on: addDays(today, -6), decided_on: null, lost_reason: null, converted_on: null,
        created: addDays(today, -15), updated: addDays(today, -6), saves: ['Created', 'Added QA for UAT', 'Price agreed internally before sharing'],
      })
      // Scenario B: Hritesh full-time on OCR instead of a new hire, no QA contractor, lower contingency
      const resB: Res[] = [
        resA[0], resA[1],
        { id: 'r3', user_id: 'u_hritesh', role_label: null, monthly_ctc_paise: null, milestone_key: 'M2', pct: 100, from_on: d(42), to_on: d(76) },
        resA[3], resA[4],
        { id: 'r6', user_id: 'u_jayashree', role_label: null, monthly_ctc_paise: null, milestone_key: 'M3', pct: 60, from_on: d(77), to_on: d(97) },
      ]
      est({
        id: 'est_utkal_b', number: `EST-${String(++seq).padStart(3, '0')}`, name: 'Utkal Tubes — DMS phase 2 (workflows & OCR) — Scenario B', client: 'Utkal Tubes Ltd', client_id: null, deal_id: null, project_id: null,
        status: 'draft', start_on: s, end_on: d(97), type: 'service', billing_model: 'tm', stream: 'services',
        milestones: ms.map((m) => ({ key: m.key, name: m.name, billing_amount_paise: R(m.amt), start_on: null, end_on: null })),
        resources: resB, additional_costs: addA, maintenance_paise: R(20000), contingency_pct: 5, price_paise: R(420000),
        notes: 'Same scope staffed from the bench: Hritesh moves to OCR full-time, Jayashree runs UAT. Lower price if the client pushes back.',
        description: a.row.description,
        owner_id: 'u_santosh', scenario_of: a.row.id, scenario_label: 'Scenario B', shared_on: null, decided_on: null, lost_reason: null, converted_on: null,
        created: addDays(today, -5), updated: addDays(today, -5), saves: ['Scenario B of EST-002'],
      })
    }

    // 3. Converted: the Digitalratha Sales CRM Phase 2 estimate, rebuilt from the project's saved plan
    {
      const p = db.projects.find((x) => x.id === 'p_crm')
      if (p) {
        const ms = db.milestones.filter((m) => m.project_id === p.id && !m.deleted_at).sort((x, y) => x.no - y.no)
        const key = new Map(ms.map((m, i) => [m.id, `M${i + 1}`]))
        const allocs = db.allocations.filter((x) => x.project_id === p.id)
        const resources: Res[] = allocs.map((x, i) => ({ id: `r${i + 1}`, user_id: x.user_id, role_label: null, monthly_ctc_paise: null, milestone_key: (x.milestone_id && key.get(x.milestone_id)) || 'M1', pct: x.pct, from_on: x.from_on, to_on: x.to_on }))
        const c = p.costing
        const additional: Add[] = (c?.additional_costs ?? []).map((x, i) => ({ id: x.id ?? `ac${i + 1}`, category: x.category, description: x.description, amount_paise: x.amount_paise }))
        const created = addDays(p.start_on, -12)
        est({
          id: 'est_crm', number: `EST-${String(++seq).padStart(3, '0')}`, name: 'Digitalratha — Sales CRM phase 2', client: p.client, client_id: null, deal_id: p.deal_id ?? null, project_id: p.id,
          status: 'converted', start_on: p.start_on, end_on: p.end_on, type: p.type, billing_model: p.billing_model, stream: p.stream,
          milestones: ms.map((m, i) => ({ key: `M${i + 1}`, name: m.name, billing_amount_paise: m.billing_amount_paise, start_on: m.planned_start, end_on: m.planned_end })),
          resources, additional_costs: additional, maintenance_paise: c?.maintenance_paise ?? 0, contingency_pct: c?.contingency_pct ?? 0, price_paise: c?.price_paise ?? p.contract_value_paise,
          notes: 'Won after the phase-1 case study (27% closing-rate lift). Converted into the project on kick-off.',
          description: p.description,
          owner_id: 'u_santosh', scenario_of: null, scenario_label: null, shared_on: addDays(created, 3), decided_on: addDays(p.start_on, -3), lost_reason: null, converted_on: addDays(p.start_on, -2),
          created, updated: addDays(p.start_on, -2), saves: ['Created', 'Shared with Deepak'],
        })
      }
    }
    const sq = db.number_sequences.find((x) => x.tenant_id === T1 && x.scope === 'estimate')
    if (sq) sq.next_value = Math.max(sq.next_value, seq + 1)
    else db.number_sequences.push({ tenant_id: T1, scope: 'estimate', next_value: seq + 1 })
  }

  /* ---------------- Kalinga Softworks (light) ---------------- */
  const T2 = 'tn_kalinga'
  if (db.tenants.some((t) => t.id === T2) && db.users.some((u) => u.id === 'u_k_sneha')) {
    const { est, totals, priceFor } = make(T2)
    const s = addDays(today, 30)
    const d = (o: number) => addDays(s, o)
    const resources: Res[] = [
      { id: 'r1', user_id: 'u_k_sneha', role_label: null, monthly_ctc_paise: null, milestone_key: 'M1', pct: 80, from_on: d(0), to_on: d(34) },
      { id: 'r2', user_id: null, role_label: 'Flutter developer', monthly_ctc_paise: R(60000), milestone_key: 'M2', pct: 100, from_on: d(35), to_on: d(69) },
      { id: 'r3', user_id: 'u_k_arjun', role_label: null, monthly_ctc_paise: null, milestone_key: 'M2', pct: 50, from_on: d(35), to_on: d(69) },
    ]
    const t = totals(resources, [], 0, 5)
    est({
      id: 'est_k_1', number: 'EST-001', name: 'Clinic chain teleconsult app', client: 'Utkal Clinics', client_id: null, deal_id: null, project_id: null,
      status: 'draft', start_on: s, end_on: d(69), type: 'service', billing_model: 'fixed', stream: 'services',
      milestones: [
        { key: 'M1', name: 'Booking and doctor schedules', billing_amount_paise: R(150000), start_on: null, end_on: null },
        { key: 'M2', name: 'Video consult and prescriptions', billing_amount_paise: R(200000), start_on: null, end_on: null },
      ],
      resources, additional_costs: [], maintenance_paise: 0, contingency_pct: 5, price_paise: Math.max(R(350000), priceFor(t.total, 0.35)),
      notes: '', description: 'Teleconsult add-on for a three-clinic chain.', owner_id: 'u_k_ananya', scenario_of: null, scenario_label: null, shared_on: null, decided_on: null, lost_reason: null, converted_on: null,
      created: addDays(today, -3), updated: addDays(today, -3), saves: ['Created'],
    })
    db.number_sequences.push({ tenant_id: T2, scope: 'estimate', next_value: 2 })
  }
}
