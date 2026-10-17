// Company area seed: goals & OKRs (current quarter + the one before) and their check-in history.
import type { DB } from '../server'
import type { SeedHelpers } from './index'
import type * as B from '@/types/business'
import { addDays, quarterOf } from '@/domain/calendar'

const CR = (crore: number) => Math.round(crore * 1_00_00_000 * 100) // ₹ crore → paise
const LK = (lakh: number) => Math.round(lakh * 1_00_000 * 100) // ₹ lakh → paise

export function seed(db: DB, h: SeedHelpers) {
  const T1 = 'tn_seereon'
  const cur = quarterOf(h.today)
  const prev = quarterOf(addDays(cur.from, -1))
  const at = (day: string, hh = 6) => `${day}T${String(hh).padStart(2, '0')}:30:00Z`
  const clampDay = (d: string) => (d > h.today ? h.today : d)

  type KRIn = Omit<B.KeyResult, keyof import('@/types/entities').Base | 'objective_id' | 'current'> & { current?: number; checkins?: { daysAgo: number; from: number; to: number; note: string; by: string }[] }
  const obj = (tenant: string, id: string, q: { label: string; from: string; to: string }, o: Pick<B.Objective, 'title' | 'level' | 'owner_id' | 'parent_id'> & { status?: B.Objective['status'] }, krs: KRIn[]) => {
    db.objectives.push({ ...h.base(tenant), id, title: o.title, level: o.level, owner_id: o.owner_id, period: q.label, period_from: q.from, period_to: q.to, parent_id: o.parent_id, status: o.status ?? 'on_track', created_at: at(clampDay(addDays(q.from, -3)), 5), created_by: o.owner_id })
    krs.forEach((k, i) => {
      const kid = `${id}_kr${i + 1}`
      const { checkins, ...rest } = k
      db.key_results.push({ ...h.base(tenant), ...rest, id: kid, objective_id: id, current: k.current ?? k.start_value, created_by: o.owner_id })
      for (const c of checkins ?? []) {
        const day = clampDay(addDays(h.today, -Math.max(1, c.daysAgo)))
        const u = k.unit === '%' ? '%' : k.unit ? ` ${k.unit}` : ''
        db.activity_log.push({ ...h.base(tenant), entity: 'key_result', entity_id: kid, action: 'check_in', summary: `${c.from}${u} → ${c.to}${u}: ${c.note}`, actor_id: c.by, at: at(day, 4 + (c.daysAgo % 5)) })
      }
    })
    db.activity_log.push({ ...h.base(tenant), entity: 'objective', entity_id: id, action: 'created', summary: `Added ${o.level} objective “${o.title}” for ${q.label}`, actor_id: o.owner_id, at: at(clampDay(addDays(q.from, -3)), 5) })
  }

  const S = 'u_santosh', SUB = 'u_subhankar', BAI = 'u_baishali', SUBH = 'u_subham', HRI = 'u_hritesh', BIJ = 'u_bijaya', PRI = 'u_priya', JAY = 'u_jayashree'

  /* ---------------- current quarter ---------------- */
  obj(T1, 'okr_rev', cur, { title: 'Grow billed revenue to ₹1.2 Cr this quarter', level: 'company', owner_id: S, parent_id: null }, [
    { title: 'Bill ₹1.2 Cr across all streams', metric: 'revenue_billed', start_value: 0, target: CR(1.2), unit: '₹', owner_id: S },
    { title: 'Collect ₹90 L in the quarter', metric: 'revenue_collected', start_value: 0, target: LK(90), unit: '₹', owner_id: PRI },
    { title: 'Hold net margin at 30% or better', metric: 'margin_pct', start_value: 20, target: 30, unit: '%', owner_id: S },
  ])
  obj(T1, 'okr_ontime', cur, { title: 'Deliver on time', level: 'company', owner_id: S, parent_id: null }, [
    { title: '85% of tasks finished on or before their due date', metric: 'on_time_task_pct', start_value: 60, target: 85, unit: '%', owner_id: SUB },
    { title: 'No milestone slips more than 5 working days', metric: 'manual', start_value: 4, target: 0, unit: 'slips', owner_id: SUB, current: 3, checkins: [{ daysAgo: 0, from: 4, to: 3, note: 'HRMS payroll milestone recovered after weekend push.', by: SUB }] },
  ])
  obj(T1, 'okr_sales', cur, { title: 'Build a sales engine not dependent on the founder', level: 'company', owner_id: S, parent_id: null }, [
    { title: '30% of new deals sourced by Baishali and Subham', metric: 'manual', start_value: 10, target: 30, unit: '%', owner_id: BAI, current: 18, checkins: [
      { daysAgo: 20, from: 10, to: 14, note: 'Two BNI referrals converted to qualified leads by Subham.', by: SUBH },
      { daysAgo: 0, from: 14, to: 18, note: 'EduReon webinar brought in three school leads without Santosh on the call.', by: BAI },
    ] },
    { title: 'Win ₹25 L of new business this quarter', metric: 'deals_won_value', start_value: 0, target: LK(25), unit: '₹', owner_id: BAI },
    { title: 'Sales playbook written and used on every demo', metric: 'manual', start_value: 0, target: 100, unit: '%', owner_id: BAI, current: 40, checkins: [{ daysAgo: 0, from: 0, to: 40, note: 'Discovery and demo sections drafted; pricing section pending.', by: BAI }] },
  ])
  obj(T1, 'okr_data', cur, { title: 'Run the company on data', level: 'company', owner_id: S, parent_id: null }, [
    { title: '95% timesheet compliance every week', metric: 'timesheet_compliance', start_value: 75, target: 95, unit: '%', owner_id: PRI },
    { title: 'Weekly leadership review held from SeereonOS dashboards', metric: 'manual', start_value: 0, target: 13, unit: 'reviews', owner_id: S, current: 1, checkins: [{ daysAgo: 0, from: 0, to: 1, note: 'First Monday review run off the CEO dashboard.', by: S }] },
  ])
  // team objectives
  obj(T1, 'okr_delivery', cur, { title: 'Delivery team ships every milestone on its baseline', level: 'team', owner_id: SUB, parent_id: 'okr_ontime' }, [
    { title: 'Team on-time task rate at 90%', metric: 'on_time_task_pct', start_value: 60, target: 90, unit: '%', owner_id: SUB },
    { title: 'Team timesheet compliance at 98%', metric: 'timesheet_compliance', start_value: 80, target: 98, unit: '%', owner_id: SUB },
    { title: 'Zero P1 defects reported by clients', metric: 'manual', start_value: 3, target: 0, unit: 'defects', owner_id: HRI, current: 1, checkins: [{ daysAgo: 0, from: 3, to: 1, note: 'Fixed the two open HRMS attendance P1s; one ERP report bug left.', by: HRI }] },
  ])
  obj(T1, 'okr_salesteam', cur, { title: 'Sales team builds a predictable pipeline', level: 'team', owner_id: BAI, parent_id: 'okr_sales' }, [
    { title: '40 qualified leads from BNI, referrals and the website', metric: 'manual', start_value: 0, target: 40, unit: 'leads', owner_id: BAI, current: 6, checkins: [{ daysAgo: 0, from: 0, to: 6, note: 'Six qualified this week, four from the BNI chapter.', by: BAI }] },
    { title: 'Win ₹12 L from deals I own', metric: 'deals_won_value', start_value: 0, target: LK(12), unit: '₹', owner_id: BAI },
  ])
  // personal objectives
  obj(T1, 'okr_subham', cur, { title: 'Close my first ₹10 L on my own', level: 'person', owner_id: SUBH, parent_id: 'okr_sales' }, [
    { title: 'Deals won by me', metric: 'deals_won_value', start_value: 0, target: LK(10), unit: '₹', owner_id: SUBH },
    { title: 'Demos run without Santosh', metric: 'manual', start_value: 0, target: 12, unit: 'demos', owner_id: SUBH, current: 2, checkins: [{ daysAgo: 0, from: 0, to: 2, note: 'Ran the Mother’s Group follow-up demo solo.', by: SUBH }] },
  ])
  obj(T1, 'okr_hritesh', cur, { title: 'Become the module lead for HRMS', level: 'person', owner_id: HRI, parent_id: 'okr_delivery' }, [
    { title: 'Code reviews done for the HRMS team', metric: 'manual', start_value: 0, target: 30, unit: 'reviews', owner_id: HRI, current: 4, checkins: [{ daysAgo: 0, from: 0, to: 4, note: 'Reviewed leave and payroll PRs.', by: HRI }] },
    { title: 'My tasks finished on time', metric: 'on_time_task_pct', start_value: 70, target: 90, unit: '%', owner_id: HRI },
  ])
  obj(T1, 'okr_bijaya', cur, { title: 'Ship FastAPI work right the first time', level: 'person', owner_id: BIJ, parent_id: 'okr_delivery' }, [
    { title: 'My tasks finished on time', metric: 'on_time_task_pct', start_value: 60, target: 85, unit: '%', owner_id: BIJ },
    { title: 'API test coverage on my services', metric: 'manual', start_value: 35, target: 70, unit: '%', owner_id: BIJ, current: 41, checkins: [{ daysAgo: 0, from: 35, to: 41, note: 'Added tests for the attendance endpoints.', by: BIJ }] },
  ])
  obj(T1, 'okr_jayashree', cur, { title: 'Grow into full-stack work', level: 'person', owner_id: JAY, parent_id: null }, [
    { title: 'FastAPI course modules completed', metric: 'manual', start_value: 0, target: 8, unit: 'modules', owner_id: JAY, current: 1 },
  ])

  /* ---------------- previous quarter (closed) ---------------- */
  obj(T1, 'okr_p_rev', prev, { title: 'Cross ₹50 L billed in the quarter', level: 'company', owner_id: S, parent_id: null }, [
    { title: 'Bill ₹50 L across all streams', metric: 'revenue_billed', start_value: 0, target: LK(50), unit: '₹', owner_id: S },
    { title: 'Collect ₹45 L', metric: 'revenue_collected', start_value: 0, target: LK(45), unit: '₹', owner_id: PRI },
  ])
  obj(T1, 'okr_p_ontime', prev, { title: 'Get delivery under control', level: 'company', owner_id: S, parent_id: null }, [
    { title: '75% of tasks finished on time', metric: 'on_time_task_pct', start_value: 50, target: 75, unit: '%', owner_id: SUB },
    { title: 'Timesheet compliance at 90%', metric: 'timesheet_compliance', start_value: 60, target: 90, unit: '%', owner_id: PRI },
  ])
  obj(T1, 'okr_p_iso', prev, { title: 'Pass the ISO 9001:2015 surveillance audit', level: 'company', owner_id: S, parent_id: null, status: 'done' }, [
    { title: 'Major non-conformities', metric: 'manual', start_value: 2, target: 0, unit: 'NCs', owner_id: PRI, current: 0, checkins: [{ daysAgo: 40, from: 2, to: 0, note: 'Auditor closed both NCs; certificate continued.', by: PRI }] },
  ])
  obj(T1, 'okr_p_hire', prev, { title: 'Hire two developers', level: 'team', owner_id: SUB, parent_id: 'okr_p_ontime' }, [
    { title: 'Active headcount', metric: 'headcount', start_value: 4, target: 6, unit: 'people', owner_id: SUB },
  ])

  /* ---------------- Kalinga Softworks (light) ---------------- */
  const T2 = 'tn_kalinga'
  obj(T2, 'okr_k_clients', cur, { title: 'Land our first three paying clients', level: 'company', owner_id: 'u_k_ananya', parent_id: null }, [
    { title: 'Signed clients', metric: 'manual', start_value: 0, target: 3, unit: 'clients', owner_id: 'u_k_meera', current: 1, checkins: [{ daysAgo: 0, from: 0, to: 1, note: 'Kalinga Hospital OPD project signed.', by: 'u_k_meera' }] },
    { title: 'Win ₹20 L of new business', metric: 'deals_won_value', start_value: 0, target: LK(20), unit: '₹', owner_id: 'u_k_meera' },
  ])
}
