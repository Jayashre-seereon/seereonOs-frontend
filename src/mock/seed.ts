// Demo data. Two tenants prove isolation: Seereon (full data set, the team's real structure with
// invented salaries/values) and Kalinga Softworks (a small fictional customer).
// All dates are generated relative to today so the demo always looks current.
import type * as E from '@/types/entities'
import { SEEREON_EMBLEM } from '@/assets/brand'
import { extendSeed } from './seeds'
import type { DB } from './server'
import { addDays, addMonths, isWorkingDay, monthOf, monthRange, parseISO, toISO, todayISO, weekStart, type CalendarCtx } from '@/domain/calendar'

export const DEMO_PASSWORD = 'Seereon@123'

// deterministic PRNG so every fresh seed looks the same
function mulberry(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const DEFAULT_SETTINGS: E.TenantSettings = {
  'company.fy_start_month': 4,
  'company.currency': 'INR',
  'calendar.weekly_off': [0],
  'calendar.saturday_rule': 'some_off',
  'calendar.saturday_off_weeks': [2, 4],
  'calendar.min_hours_per_day': 9,
  'calendar.max_hours_per_day': 16,
  'calendar.breaks_count': true,
  'timesheet.hours_step': 0.5,
  'timesheet.allow_future_entries': false,
  'timesheet.internal_note_required': true,
  'timesheet.weekly_lock': true,
  'timesheet.unlock_max_days': 7,
  'approval.sla_working_days': 2,
  'approval.bulk_approve': true,
  'pay.deduct_unapproved_days': false,
  'pay.variable_default_pct': 20,
  'pay.target_default': 'ctc',
  'pay.variable_threshold_pct': 100,
  'projects.code_prefix': 'PRJ',
  'projects.empty_milestone_days': 7,
  'projects.margin_floor_pct': 25,
  'projects.effort_ratio_alert': 1.2,
  'allocation.max_pct_per_person': 100,
  'allocation.block_over': false,
  'daily.proof_required': true,
  'sales.stale_deal_days': 14,
  'notify.friday_nudge_time': '16:00',
  'notify.sla_digest_time': '09:30',
  'security.password_min_length': 10,
  'security.lockout_attempts': 5,
  'security.lockout_minutes': 15,
  'security.session_idle_minutes': 60,
  'security.require_2fa_admins': false,
  'ai.enabled': true,
  'finance.opening_cash_paise': 15_00_000_00,
  'finance.monthly_overheads_paise': 1_50_000_00,
  'finance.cost_loading_pct': 15,
  'team.default_productive_hours': 6,
}

export const DEFAULT_THEME: E.ThemeConfig = {
  preset: 'seereon',
  primary: '#0C6B4E',
  accent: '#DAB34F',
  radius: 'soft',
  density: 'comfortable',
  font: 'plex',
  mode: 'light',
  sidebar: 'light',
}

const L = (rupeesLakh: number) => Math.round(rupeesLakh * 1_00_000 * 100) // lakh → paise
const R = (rupees: number) => Math.round(rupees * 100)

export function buildSeed(): DB {
  const rnd = mulberry(20260930)
  const today = todayISO()
  const t0 = new Date().toISOString()
  const db: DB = {
    tenants: [], users: [], passwords: [], login_attempts: [], sessions: [], invites: [], reset_tokens: [], subscriptions: [],
    billing_invoices: [], holidays: [], delegations: [], projects: [], project_status_history: [], milestones: [], tasks: [],
    task_dependencies: [], comments: [], notifications: [], timesheet_weeks: [], timesheet_entries: [], leave: [], daily_updates: [],
    cost_rates: [], allocations: [], files: [], invoices: [], payments: [], payroll_runs: [], payroll_lines: [], ledger_entries: [],
    deals: [], deal_activities: [], deal_stage_history: [], change_requests: [], openings: [], ops_items: [], activity_log: [],
    saved_reports: [], data_exports: [], number_sequences: [], admin_audit: [],
    roles: [], change_sets: [], approval_workflows: [], locations: [], departments: [], designations: [], grades: [], cost_centres: [], shifts: [], email_templates: [], email_outbox: [],
    cost_estimates: [], wf_templates: [], wf_instances: [], doc_templates: [], issued_documents: [], employee_documents: [],
    task_reviews: [], documents: [], document_versions: [], document_acks: [], document_views: [], leave_requests: [], leave_policies: [],
    appraisal_cycles: [], appraisals: [], goals: [], feedback: [], candidates: [], interviews: [], lifecycle_checklists: [], assets: [],
    expense_claims: [], vendors: [], purchase_orders: [], vendor_bills: [], budgets: [], clients: [], contracts: [], revenue_leakage: [],
    objectives: [], key_results: [], pending_tokens: [],
  }
  let n = 0
  const id = (p: string) => `${p}_${(++n).toString(36).padStart(4, '0')}`
  const base = (tenant_id: string, extra: Partial<E.Base> = {}) => ({ id: id('r'), tenant_id, created_at: t0, updated_at: t0, created_by: null, version: 1, ...extra })

  /* ================= Tenant 1: Seereon ================= */
  const T1 = 'tn_seereon'
  db.tenants.push({
    id: T1, name: 'Seereon Consulting & IT Services', slug: 'seereon', status: 'active', industry: 'sap_consulting',
    trial_ends_on: null, time_zone: 'Asia/Kolkata', plan_code: 'growth', seats: 15, created_at: addDays(today, -210) + 'T05:00:00Z',
    logo_data_url: SEEREON_EMBLEM, theme: { ...DEFAULT_THEME }, settings: { ...DEFAULT_SETTINGS, 'pay.deduct_unapproved_days': true, 'timesheet.allow_future_entries': true }, version: 1,
  })

  type P = { key: string; name: string; title: string; role: E.Role; dept: E.User['department']; reports?: string; ctc: number; grants?: E.Grant[]; hue: number; variable?: number; joined: number }
  const people: P[] = [
    { key: 'santosh', name: 'Santosh Nayak', title: 'Founder & CEO', role: 'admin', dept: 'management', ctc: 0, grants: ['margins', 'salaries'], hue: 152, joined: -600 },
    { key: 'subhankar', name: 'Subhankar Rout', title: 'Delivery Head', role: 'pm', dept: 'delivery', reports: 'santosh', ctc: 90000, grants: ['margins'], hue: 210, joined: -420 },
    { key: 'hritesh', name: 'Hritesh Panda', title: 'Senior MERN Developer', role: 'employee', dept: 'delivery', reports: 'subhankar', ctc: 70000, hue: 18, joined: -380 },
    { key: 'bijaya', name: 'Bijaya Jena', title: 'FastAPI Developer', role: 'employee', dept: 'delivery', reports: 'subhankar', ctc: 40000, hue: 265, joined: -300 },
    { key: 'jagannath', name: 'Jagannath Nayak', title: 'FastAPI Developer', role: 'employee', dept: 'delivery', reports: 'subhankar', ctc: 40000, hue: 190, joined: -290 },
    { key: 'jayashree', name: 'Jayashree Dash', title: 'MERN Developer', role: 'employee', dept: 'delivery', reports: 'subhankar', ctc: 35000, hue: 330, joined: -250 },
    { key: 'pragyasmita', name: 'Pragyasmita Pallai', title: 'Full-stack Developer (Laravel/React)', role: 'employee', dept: 'delivery', reports: 'subhankar', ctc: 45000, hue: 45, joined: -200 },
    { key: 'baishali', name: 'Baishali Rout', title: 'Sales & Content Lead', role: 'sales', dept: 'sales', reports: 'santosh', ctc: 40000, variable: 20, hue: 0, joined: -330 },
    { key: 'subham', name: 'Subham Mohanty', title: 'Business Development', role: 'sales', dept: 'sales', reports: 'santosh', ctc: 30000, variable: 20, hue: 120, joined: -160 },
    { key: 'priya', name: 'Priya Mohapatra', title: 'HR & Accounts', role: 'ops', dept: 'operations', reports: 'santosh', ctc: 32000, grants: ['salaries'], hue: 290, joined: -310 },
    { key: 'debasish', name: 'Debasish Mishra', title: 'IT & Systems Administrator', role: 'admin', dept: 'operations', reports: 'santosh', ctc: 38000, hue: 175, joined: -280 },
  ]
  const U: Record<string, E.User> = {}
  for (const p of people) {
    const u: E.User = {
      ...base(T1), id: `u_${p.key}`, email: `${p.key}@seereon.co.in`, name: p.name, title: p.title, role: p.role, reports_to_id: null,
      grants: p.grants ?? [], role_key: '', extra_permissions: [], revoked_permissions: [], status: 'active', last_login_at: addDays(today, -Math.floor(rnd() * 3)) + 'T04:30:00Z', avatar_hue: p.hue,
      phone: '+91 9' + String(Math.floor(100000000 + rnd() * 899999999)), joined_on: addDays(today, p.joined), department: p.dept, two_factor: false, prefs: {}, // demo logins work without a second factor (2FA is real TOTP: turn it on under Settings → Security)
    }
    U[p.key] = u
    db.users.push(u)
    db.passwords.push({ user_id: u.id, password: DEMO_PASSWORD })
  }
  for (const p of people) if (p.reports) U[p.key].reports_to_id = U[p.reports].id
  // Santosh's own consulting value is tracked as revenue, but give him a notional rate for costing
  const ctcOf: Record<string, number> = { santosh: 250000 }
  for (const p of people) if (p.ctc) ctcOf[p.key] = p.ctc
  const APPRAISAL_ON = '2026-04-01'
  for (const p of people) {
    const joined = addDays(today, p.joined)
    // Sales target = monthly CTC of the rate in force (Feature Guide §12), so each rate carries its own CTC as target.
    if (joined < APPRAISAL_ON) {
      db.cost_rates.push({ ...base(T1), user_id: U[p.key].id, monthly_ctc_paise: R(Math.round(ctcOf[p.key] * 0.92)), variable_pct: p.variable ?? 0, sales_target_paise: p.variable ? R(Math.round(ctcOf[p.key] * 0.92)) : null, effective_from: joined })
      // increment effective from April (appraisal) — proves "rate valid on the day"
      db.cost_rates.push({ ...base(T1), user_id: U[p.key].id, monthly_ctc_paise: R(ctcOf[p.key]), variable_pct: p.variable ?? 0, sales_target_paise: p.variable ? R(ctcOf[p.key]) : null, effective_from: APPRAISAL_ON })
    } else {
      // joined after the April appraisal: one rate from the joining date (target = that CTC)
      db.cost_rates.push({ ...base(T1), user_id: U[p.key].id, monthly_ctc_paise: R(ctcOf[p.key]), variable_pct: p.variable ?? 0, sales_target_paise: p.variable ? R(ctcOf[p.key]) : null, effective_from: joined })
    }
  }
  db.invites.push({ ...base(T1), email: 'ritika@seereon.co.in', name: 'Ritika Senapati', role: 'employee', reports_to_id: U.subhankar.id, token: 'demo-invite-ritika', expires_at: addDays(today, 5) + 'T00:00:00Z', accepted_at: null })

  // Holidays (Odisha sample)
  const hol: [string, string, boolean?][] = [
    ['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-04-14', 'Maha Vishuba Sankranti'], ['2026-06-25', 'Ratha Yatra'],
    ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-17', 'Kumar Purnima', true], ['2026-10-20', 'Durga Puja (Dussehra)'],
    ['2026-11-08', 'Diwali'], ['2026-12-25', 'Christmas'], ['2027-01-26', 'Republic Day'], ['2027-03-23', 'Holi'],
  ]
  for (const [date, name, optional] of hol) db.holidays.push({ ...base(T1), date, name, optional: !!optional })

  const cal1: CalendarCtx = { settings: db.tenants[0].settings, holidays: db.holidays.filter((h) => h.tenant_id === T1) }

  /* ---- Projects ---- */
  type MS = { name: string; s: number; e: number; amt: number; billing?: E.MilestoneBilling; achieved?: number | null; slip?: number }
  type TK = { ms: number; title: string; owner: string; est: number; s: number; e: number; cx: E.Complexity; status?: E.TaskStatus; dep?: number[]; backup?: string; blocked?: string }
  type PJ = { key: string; name: string; client: string; type: E.ProjectType; billing: E.BillingModel; stream: E.RevenueStream; pm: string; status: E.ProjectStatus; s: number; e: number; value: number; pri: 1 | 2 | 3; desc: string; hue: number; ms: MS[]; tasks: TK[] }
  const projects: PJ[] = [
    {
      key: 'hrms', name: 'SeerHR — Mining Group HRMS', client: 'Mahanadi Minerals Group', type: 'product', billing: 'fixed', stream: 'products', pm: 'subhankar', status: 'active', s: -56, e: 72, value: 15, pri: 1, hue: 160,
      desc: 'HRMS with payroll, statutory (PF/ESI/TDS), shift attendance and AI assistant for a mining group. Perpetual licence.',
      ms: [
        { name: 'Gap analysis sign-off', s: -56, e: -35, amt: 1.5, billing: 'paid', achieved: -33, slip: 0 },
        { name: 'Core HR & payroll', s: -34, e: 14, amt: 4.5, slip: 5 },
        { name: 'Statutory & shift attendance', s: 10, e: 45, amt: 3.5 },
        { name: 'UAT sign-off', s: 40, e: 60, amt: 3 },
        { name: 'Go-live', s: 58, e: 72, amt: 2.5 },
      ],
      tasks: [
        { ms: 1, title: 'Client workshops and gap analysis', owner: 'subhankar', est: 36, s: -56, e: -44, cx: 'medium', status: 'done' },
        { ms: 1, title: 'Gap analysis document and sign-off', owner: 'subhankar', est: 14, s: -43, e: -35, cx: 'low', status: 'done', dep: [1] },
        { ms: 2, title: 'Employee master & org structure API', owner: 'bijaya', est: 48, s: -34, e: -20, cx: 'medium', status: 'done' },
        { ms: 2, title: 'Payroll engine: earnings, deductions, arrears', owner: 'jagannath', est: 90, s: -28, e: 4, cx: 'high', status: 'in_progress', dep: [3], backup: 'bijaya' },
        { ms: 2, title: 'Payroll UI and payslip PDF', owner: 'hritesh', est: 56, s: -14, e: 8, cx: 'medium', status: 'in_progress', dep: [3] },
        { ms: 2, title: 'Leave & attendance policies', owner: 'bijaya', est: 40, s: -12, e: 6, cx: 'medium', status: 'in_review' },
        { ms: 2, title: 'Payroll approval workflow', owner: 'jayashree', est: 30, s: -6, e: 14, cx: 'medium', status: 'blocked', dep: [4], blocked: 'Waiting on payroll engine run API' },
        { ms: 3, title: 'PF ECR, ESI and TDS computation', owner: 'jagannath', est: 70, s: 10, e: 34, cx: 'high', status: 'todo', dep: [4] },
        { ms: 3, title: 'Shift roster and punch integration', owner: 'pragyasmita', est: 60, s: 12, e: 40, cx: 'high', status: 'todo' },
        { ms: 3, title: 'AI policy assistant (cited answers)', owner: 'hritesh', est: 44, s: 20, e: 45, cx: 'high', status: 'todo' },
        { ms: 4, title: 'UAT scripts and client training', owner: 'subhankar', est: 30, s: 40, e: 55, cx: 'low', status: 'todo', dep: [8, 9] },
        { ms: 5, title: 'Production cutover & hypercare', owner: 'bijaya', est: 32, s: 58, e: 72, cx: 'medium', status: 'todo', dep: [11] },
      ],
    },
    {
      key: 'mgs', name: 'EduReon — Mother’s Group of Schools', client: "Mother's Group of Schools", type: 'product', billing: 'fixed', stream: 'products', pm: 'subhankar', status: 'active', s: -80, e: 25, value: 4.5, pri: 1, hue: 32,
      desc: 'Rollout of EduReon (meraCampus) across 2 campuses: admissions, fee collection, attendance, parent app.',
      ms: [
        { name: 'Setup & configuration', s: -80, e: -55, amt: 1, billing: 'paid', achieved: -54 },
        { name: 'Data migration', s: -54, e: -20, amt: 1.5, billing: 'invoiced', achieved: -14, slip: 6 },
        { name: 'Go-live both campuses', s: -18, e: 25, amt: 2 },
      ],
      tasks: [
        { ms: 1, title: 'Tenant setup, academic year and classes', owner: 'pragyasmita', est: 24, s: -80, e: -70, cx: 'low', status: 'done' },
        { ms: 1, title: 'Fee structures for both campuses', owner: 'pragyasmita', est: 20, s: -69, e: -56, cx: 'medium', status: 'done', dep: [1] },
        { ms: 2, title: 'Student & parent data import (4,200 records)', owner: 'jayashree', est: 40, s: -54, e: -30, cx: 'medium', status: 'done' },
        { ms: 2, title: 'Opening fee balances reconciliation', owner: 'jayashree', est: 26, s: -30, e: -20, cx: 'high', status: 'done', dep: [3] },
        { ms: 3, title: 'Parent app release (Play Store)', owner: 'hritesh', est: 30, s: -18, e: 2, cx: 'medium', status: 'in_progress' },
        { ms: 3, title: 'Teacher training sessions', owner: 'subhankar', est: 12, s: -6, e: 10, cx: 'low', status: 'in_progress' },
        { ms: 3, title: 'Fee receipt printing & Razorpay go-live', owner: 'pragyasmita', est: 22, s: -4, e: -1, cx: 'medium', status: 'in_progress' },
        { ms: 3, title: 'Hypercare and go-live sign-off', owner: 'jayashree', est: 20, s: 5, e: 25, cx: 'low', status: 'todo', dep: [5, 7] },
      ],
    },
    {
      key: 'crm', name: 'Sales CRM Phase 2', client: 'Digitalratha', type: 'service', billing: 'fixed', stream: 'services', pm: 'subhankar', status: 'active', s: -30, e: 40, value: 3, pri: 2, hue: 260,
      desc: 'Phase 2 of the custom sales CRM: WhatsApp follow-ups, territory reports and manager dashboards.',
      ms: [
        { name: 'Build', s: -30, e: 18, amt: 2 },
        { name: 'Go-live', s: 18, e: 40, amt: 1 },
      ],
      tasks: [
        { ms: 1, title: 'WhatsApp follow-up automation', owner: 'bijaya', est: 34, s: -30, e: -12, cx: 'medium', status: 'done' },
        { ms: 1, title: 'Territory & target reports', owner: 'jagannath', est: 30, s: -12, e: 6, cx: 'medium', status: 'in_progress' },
        { ms: 1, title: 'Manager dashboard UI', owner: 'jayashree', est: 36, s: -10, e: 12, cx: 'medium', status: 'in_progress', dep: [2] },
        { ms: 2, title: 'UAT with sales team', owner: 'subhankar', est: 10, s: 18, e: 30, cx: 'low', status: 'todo', dep: [3] },
        { ms: 2, title: 'Deployment & handover', owner: 'bijaya', est: 12, s: 30, e: 40, cx: 'low', status: 'todo', dep: [4] },
      ],
    },
    {
      key: 'rcu', name: 'SAP AMS — Royal Commission for AlUla', client: 'Royal Commission for AlUla', type: 'ams', billing: 'ams_retainer', stream: 'sap_consulting', pm: 'santosh', status: 'active', s: -200, e: 165, value: 42, pri: 1, hue: 140,
      desc: 'SAP ABAP/CPI/SuccessFactors application management: petty cash RAP apps, DMEE exits, funds management reports.',
      ms: [
        { name: 'Q1 retainer', s: -200, e: -110, amt: 10.5, billing: 'paid', achieved: -110 },
        { name: 'Q2 retainer', s: -109, e: -20, amt: 10.5, billing: 'paid', achieved: -20 },
        { name: 'Q3 retainer', s: -19, e: 72, amt: 10.5 },
        { name: 'Q4 retainer', s: 73, e: 165, amt: 10.5 },
      ],
      tasks: [
        { ms: 3, title: 'Petty cash finance dashboard (PCFIN)', owner: 'santosh', est: 60, s: -19, e: 12, cx: 'high', status: 'in_progress' },
        { ms: 3, title: 'SF delegations to Ariba iFlow', owner: 'santosh', est: 40, s: -10, e: 20, cx: 'high', status: 'in_progress' },
        { ms: 3, title: 'Budget total report fixes', owner: 'santosh', est: 16, s: 5, e: 18, cx: 'medium', status: 'todo' },
      ],
    },
    {
      key: 'edureon', name: 'EduReon v2 (meraCampus)', client: 'Internal', type: 'product', billing: 'fixed', stream: 'products', pm: 'subhankar', status: 'active', s: -45, e: 60, value: 0, pri: 2, hue: 20,
      desc: 'Next major version of the school ERP: admissions CRM, transport, and multi-campus reporting.',
      ms: [
        { name: 'Admissions CRM', s: -45, e: 5, amt: 0 },
        { name: 'Transport & multi-campus', s: 5, e: 60, amt: 0 },
      ],
      tasks: [
        { ms: 1, title: 'Admissions pipeline (LeadSync core)', owner: 'hritesh', est: 50, s: -45, e: -10, cx: 'high', status: 'done' },
        { ms: 1, title: 'Enquiry forms and counsellor app', owner: 'jayashree', est: 32, s: -20, e: 3, cx: 'medium', status: 'in_progress' },
        { ms: 2, title: 'Transport routes and GPS', owner: 'pragyasmita', est: 48, s: 5, e: 40, cx: 'high', status: 'todo' },
        { ms: 2, title: 'Multi-campus consolidated reports', owner: 'jagannath', est: 36, s: 20, e: 60, cx: 'medium', status: 'todo' },
      ],
    },
    {
      key: 'dms', name: 'Document Management System', client: 'Utkal Tubes Ltd', type: 'service', billing: 'tm', stream: 'services', pm: 'subhankar', status: 'on_hold', s: -90, e: 30, value: 6, pri: 3, hue: 350,
      desc: 'DMS with versioning and approval routing. On hold pending client IT infrastructure.',
      ms: [
        { name: 'Phase 1 build', s: -90, e: -40, amt: 3, billing: 'invoiced', achieved: -36, slip: 4 },
        { name: 'Phase 2 workflows', s: -39, e: 30, amt: 3 },
      ],
      tasks: [
        { ms: 1, title: 'Storage, versioning and search', owner: 'hritesh', est: 60, s: -90, e: -60, cx: 'high', status: 'done' },
        { ms: 1, title: 'Folder permissions', owner: 'bijaya', est: 30, s: -60, e: -40, cx: 'medium', status: 'done' },
        { ms: 2, title: 'Approval routing engine', owner: 'jagannath', est: 40, s: -39, e: -5, cx: 'high', status: 'blocked', blocked: 'Client server provisioning pending' },
      ],
    },
    {
      key: 'samet', name: 'SAMET Website & Admissions Portal', client: 'SAMET School of Management', type: 'service', billing: 'fixed', stream: 'services', pm: 'subhankar', status: 'completed', s: -150, e: -60, value: 2.2, pri: 3, hue: 220,
      desc: 'Brand website and online admissions portal.',
      ms: [
        { name: 'Design & build', s: -150, e: -95, amt: 1.2, billing: 'paid', achieved: -96 },
        { name: 'Launch', s: -95, e: -60, amt: 1, billing: 'paid', achieved: -58, slip: 2 },
      ],
      tasks: [
        { ms: 1, title: 'Website design system and pages', owner: 'pragyasmita', est: 60, s: -150, e: -100, cx: 'medium', status: 'done' },
        { ms: 2, title: 'Admissions portal with payments', owner: 'jayashree', est: 50, s: -95, e: -62, cx: 'medium', status: 'done' },
      ],
    },
  ]

  const P: Record<string, E.Project> = {}
  const TK: Record<string, E.Task[]> = {}
  const MSm: Record<string, E.Milestone[]> = {}
  let prjNo = 7
  for (const pj of projects) {
    const code = `PRJ-${String(prjNo++).padStart(3, '0')}`
    const p: E.Project = {
      ...base(T1, { created_by: U[pj.pm].id }), id: `p_${pj.key}`, code, name: pj.name, client: pj.client, type: pj.type, status: pj.status, pm_id: U[pj.pm].id,
      start_on: addDays(today, pj.s), end_on: addDays(today, pj.e), contract_value_paise: L(pj.value), billing_model: pj.billing, stream: pj.stream,
      description: pj.desc, priority: pj.pri, deal_id: null, baseline_end_on: addDays(today, pj.e), color_hue: pj.hue,
    }
    P[pj.key] = p
    db.projects.push(p)
    db.project_status_history.push({ ...base(T1), project_id: p.id, from_status: null, to_status: 'initiated', reason: null, changed_by: U[pj.pm].id, changed_at: addDays(today, pj.s - 5) + 'T06:00:00Z' })
    db.project_status_history.push({ ...base(T1), project_id: p.id, from_status: 'initiated', to_status: 'active', reason: null, changed_by: U[pj.pm].id, changed_at: addDays(today, pj.s) + 'T06:00:00Z' })
    if (pj.status === 'on_hold') db.project_status_history.push({ ...base(T1), project_id: p.id, from_status: 'active', to_status: 'on_hold', reason: 'Client IT has not provisioned the application server; resume once VM is handed over.', changed_by: U.subhankar.id, changed_at: addDays(today, -6) + 'T06:00:00Z' })
    if (pj.status === 'completed') db.project_status_history.push({ ...base(T1), project_id: p.id, from_status: 'active', to_status: 'completed', reason: null, changed_by: U.subhankar.id, changed_at: addDays(today, -57) + 'T06:00:00Z' })
    MSm[pj.key] = pj.ms.map((m, i) => {
      const ms: E.Milestone = {
        ...base(T1), id: `ms_${pj.key}_${i + 1}`, project_id: p.id, no: i + 1, name: m.name, planned_start: addDays(today, m.s), planned_end: addDays(today, m.e + (m.slip ?? 0)),
        baseline_end: addDays(today, m.e), billing_amount_paise: L(m.amt), billing_status: m.billing ?? 'none', achieved_on: m.achieved != null ? addDays(today, m.achieved) : null, empty_since: null, deleted_at: null,
      }
      db.milestones.push(ms)
      return ms
    })
    const counters: Record<number, number> = {}
    TK[pj.key] = pj.tasks.map((t, i) => {
      counters[t.ms] = (counters[t.ms] ?? 0) + 1
      const status = t.status ?? 'todo'
      const task: E.Task = {
        ...base(T1, { created_by: U[pj.pm].id }), id: `t_${pj.key}_${i + 1}`, project_id: p.id, milestone_id: MSm[pj.key][t.ms - 1].id, no: counters[t.ms], title: t.title,
        owner_id: U[t.owner].id, backup_id: t.backup ? U[t.backup].id : null, est_hours: t.est, start_on: addDays(today, t.s), due_on: addDays(today, t.e),
        done_on: status === 'done' ? addDays(today, Math.min(t.e + Math.round(rnd() * 4 - 1), -1)) : null, complexity: t.cx, status, description: '', blocked_reason: t.blocked ?? null,
      }
      db.tasks.push(task)
      return task
    })
    pj.tasks.forEach((t, i) => (t.dep ?? []).forEach((d) => db.task_dependencies.push({ ...base(T1), task_id: TK[pj.key][i].id, depends_on_task_id: TK[pj.key][d - 1].id })))
    // allocations per milestone for owners
    pj.ms.forEach((m, mi) => {
      const owners = [...new Set(pj.tasks.filter((t) => t.ms === mi + 1).map((t) => t.owner))]
      owners.forEach((o) => db.allocations.push({ ...base(T1), project_id: p.id, milestone_id: MSm[pj.key][mi].id, user_id: U[o].id, pct: o === 'santosh' ? 40 : o === 'subhankar' ? 30 : 50 + Math.round(rnd() * 3) * 10, from_on: addDays(today, m.s), to_on: addDays(today, m.e) }))
    })
  }
  db.number_sequences.push({ tenant_id: T1, scope: 'project', next_value: prjNo })
  // allocation % so each person sums to ~100% (Jagannath deliberately over-allocated)
  for (const a of db.allocations) {
    if (a.tenant_id !== T1) continue
    const overlap = db.allocations.filter((b) => b.user_id === a.user_id && b.from_on <= a.to_on && b.to_on >= a.from_on && b.tenant_id === T1).length
    const who = Object.keys(U).find((k) => U[k].id === a.user_id)!
    const cap = who === 'santosh' ? 60 : who === 'subhankar' ? 90 : who === 'jagannath' ? 125 : 100
    a.pct = Math.max(10, Math.round(cap / Math.max(1, overlap) / 5) * 5)
  }
  db.projects.find((p) => p.id === 'p_mgs')!.deal_id = 'd_mgs'

  /* ---- Timesheets: last 9 weeks + current ---- */
  const thisMon = weekStart(today)
  const workers = ['subhankar', 'hritesh', 'bijaya', 'jagannath', 'jayashree', 'pragyasmita', 'santosh', 'baishali', 'subham', 'priya', 'debasish']
  const leaveDays: Record<string, string[]> = {
    jayashree: [addDays(thisMon, -12), addDays(thisMon, -11)],
    bijaya: [addDays(thisMon, -26)],
    hritesh: [addDays(thisMon, -40)],
    pragyasmita: [addDays(thisMon, -5)],
  }
  for (const w of Object.keys(leaveDays)) for (const d of leaveDays[w]) db.leave.push({ ...base(T1), user_id: U[w].id, date: d, type: w === 'bijaya' ? 'sick' : 'casual', portion: 'full', source: 'timesheet', approved_by: U[w === 'subhankar' ? 'santosh' : 'subhankar'].id })

  const allTasks = Object.values(TK).flat()
  // how each person's actual effort tends to compare with the estimate (drives effort ratios)
  const RATIO: Record<string, number> = { santosh: 0.95, subhankar: 1.0, hritesh: 1.08, bijaya: 1.12, jagannath: 1.32, jayashree: 0.96, pragyasmita: 1.18 }
  const logged: Record<string, number> = {}
  const calNoLeave = { ...cal1, leaveDates: undefined }
  const workingDaysBetweenSeed = (a: string, b: string) => {
    let n = 0
    for (let d = a; d <= b; d = addDays(d, 1)) if (isWorkingDay(d, calNoLeave)) n++
    return n
  }
  for (let wk = 9; wk >= 0; wk--) {
    const mon = addDays(thisMon, -7 * wk)
    for (const w of workers) {
      const u = U[w]
      const approver = u.reports_to_id
      let status: E.WeekStatus = 'approved'
      if (wk === 0) status = 'open'
      else if (wk === 1) status = ['hritesh', 'bijaya', 'jayashree', 'baishali'].includes(w) ? 'submitted' : w === 'jagannath' ? 'locked' : w === 'subham' ? 'rejected' : 'approved'
      else if (wk === 2 && (w === 'pragyasmita' || w === 'priya')) status = 'submitted'
      if (w === 'santosh' && wk > 0) status = 'approved'
      const wkId = `wk_${w}_${mon}`
      const submittedAt = status === 'open' || status === 'locked' ? null : addDays(mon, wk === 1 && w === 'bijaya' ? 7 : 5) + 'T12:30:00Z'
      const weekRow: E.TimesheetWeek = {
        ...base(T1), id: wkId, user_id: u.id, week_start: mon, status, submitted_at: submittedAt, approver_id: approver,
        decided_by: status === 'approved' || status === 'rejected' ? approver ?? u.id : null,
        decided_at: status === 'approved' || status === 'rejected' ? addDays(mon, wk % 3 === 0 ? 10 : 7) + 'T05:00:00Z' : null,
        late: status === 'approved' && wk % 3 === 0 && w !== 'santosh', reject_reason: status === 'rejected' ? 'Wednesday has 3h on "Client meetings" without a deal reference. Split by deal and resubmit.' : null,
        unlock_requested_at: w === 'jagannath' && wk === 1 ? addDays(today, -1) + 'T09:10:00Z' : null,
        unlock_reason: w === 'jagannath' && wk === 1 ? 'Was at client site Friday–Saturday without laptop; need to log the payroll engine hours.' : null, unlock_until: null,
      }
      db.timesheet_weeks.push(weekRow)
      if (w === 'jagannath' && wk === 1) continue // locked with no entries
      const myTasks = allTasks.filter((t) => t.owner_id === u.id)
      const lv = new Set(leaveDays[w] ?? [])
      for (let d = 0; d < 7; d++) {
        const date = addDays(mon, d)
        if (date > today || (wk === 0 && date >= today)) continue
        if (!isWorkingDay(date, { ...cal1, leaveDates: undefined })) continue
        if (lv.has(date)) {
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'leave', task_id: null, internal_code: null, leave_type: 'casual', hours: 9, note: '' })
          continue
        }
        const active = myTasks.filter((t) => t.start_on <= date && (t.done_on ?? t.due_on) >= date)
        let left = [8.5, 9, 9, 9.5, 9, 10][Math.floor(rnd() * 6)]
        if (w === 'baishali' || w === 'subham') {
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'internal', task_id: null, internal_code: 'presales', leave_type: null, hours: left, note: 'Client calls, demos and follow-ups (see CRM)' })
          continue
        }
        if (w === 'priya') {
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'internal', task_id: null, internal_code: 'admin', leave_type: null, hours: left, note: 'Payroll, compliance and accounts' })
          continue
        }
        if (w === 'debasish') {
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'internal', task_id: null, internal_code: 'admin', leave_type: null, hours: left, note: 'Workspace administration, IT support and access requests' })
          continue
        }
        if (d === 0) {
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'internal', task_id: null, internal_code: 'meeting', leave_type: null, hours: 1, note: 'Monday planning' })
          left -= 1
        }
        for (const t of active) {
          if (left <= 0) break
          const target = t.est_hours * (RATIO[w] ?? 1)
          const wd = Math.max(1, workingDaysBetweenSeed(t.start_on, t.done_on ?? t.due_on))
          const share = Math.max(0.5, Math.round(((target / wd) * (0.85 + rnd() * 0.3)) * 2) / 2)
          const h = Math.min(left, share, Math.max(0, Math.round((target - (logged[t.id] ?? 0)) * 2) / 2))
          if (h <= 0) continue
          logged[t.id] = (logged[t.id] ?? 0) + h
          left -= h
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'task', task_id: t.id, internal_code: null, leave_type: null, hours: h, note: '' })
        }
        if (left > 0) {
          const code = w === 'santosh' ? 'presales' : active.length ? 'meeting' : 'learning'
          const note = w === 'santosh' ? 'Client meetings, BNI and business development' : active.length ? 'Code reviews, stand-ups and support' : 'Bench: upskilling and internal tooling'
          db.timesheet_entries.push({ ...base(T1), week_id: wkId, user_id: u.id, work_date: date, kind: 'internal', task_id: null, internal_code: code, leave_type: null, hours: left, note })
        }
      }
    }
  }

  /* ---- Invoices, payments and ledger ---- */
  let invNo = 1041
  for (const ms of db.milestones.filter((m) => m.tenant_id === T1 && m.billing_status !== 'none')) {
    const inv: E.Invoice = {
      ...base(T1), id: `inv_${ms.id}`, project_id: ms.project_id, milestone_id: ms.id, number: `SC/26-27/${invNo++}`, invoiced_on: ms.achieved_on ?? ms.planned_end,
      amount_paise: ms.billing_amount_paise, paid_amount_paise: ms.billing_status === 'paid' ? ms.billing_amount_paise : 0, paid_on: ms.billing_status === 'paid' ? addDays(ms.achieved_on ?? ms.planned_end, 21) : null,
      due_on: addDays(ms.achieved_on ?? ms.planned_end, 30), file_id: null,
    }
    if (inv.paid_on && inv.paid_on > today) inv.paid_on = addDays(today, -2)
    db.invoices.push(inv)
    const proj = db.projects.find((p) => p.id === ms.project_id)!
    db.ledger_entries.push({ ...base(T1), kind: 'income', category: 'Milestone invoice', description: `${inv.number} · ${proj.name} · M${ms.no} ${ms.name}`, amount_paise: inv.amount_paise, date: inv.invoiced_on, recurring: false, until_on: null, status: inv.paid_on ? 'received' : 'expected', project_id: proj.id, milestone_id: ms.id, invoice_id: inv.id, stream: proj.stream, locked: true })
    if (inv.paid_on) db.payments.push({ ...base(T1), invoice_id: inv.id, amount_paise: inv.paid_amount_paise, paid_on: inv.paid_on, reference: 'NEFT ' + Math.floor(rnd() * 1e9) })
  }
  // partial payment on MGS data migration
  const mgsInv = db.invoices.find((i) => i.milestone_id === 'ms_mgs_2')!
  mgsInv.paid_amount_paise = L(0.75)
  db.payments.push({ ...base(T1), invoice_id: mgsInv.id, amount_paise: L(0.75), paid_on: addDays(today, -4), reference: 'UPI 4417' })
  db.number_sequences.push({ tenant_id: T1, scope: 'invoice', next_value: invNo })

  // monthly items for the last 12 months. From the start of this FY the ledger holds the entries the
  // Feature Guide shows (screenshot 023) — recurring ones entered once; before that, month-by-month history.
  const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : String(Number(today.slice(0, 4)) - 1)}-04-01`
  const histStart = addMonths(`${monthOf(today)}-01`, -11)
  const recurring: { kind: E.LedgerKind; cat: string; desc: string; amt: number; stream?: E.RevenueStream; from?: number }[] = [
    { kind: 'income', cat: 'SAP consulting', desc: 'SAP CPI consulting — ZooPlus Germany', amt: 1.8, stream: 'sap_consulting' },
    { kind: 'income', cat: 'SAP consulting', desc: 'SAP ABAP consulting — Semtech', amt: 2.4, stream: 'sap_consulting', from: 4 },
    { kind: 'income', cat: 'Subscription / AMC', desc: 'EduReon subscriptions (MRR)', amt: 0.35, stream: 'saas', from: 5 },
    { kind: 'expense', cat: 'Rent', desc: 'Office rent — Khandagiri', amt: 0.4 },
    { kind: 'expense', cat: 'Tools & software', desc: 'AWS, GitHub, Google Workspace, Figma', amt: 0.14 },
    { kind: 'expense', cat: 'Marketing', desc: 'BNI membership, events and ads', amt: 0.12 },
  ]
  // Salaries follow the cost rates of everyone employed that month, so the ledger and the CTC-based P&L agree.
  const payrollOf = (ym: string) => people.filter((p) => U[p.key].joined_on <= monthRange(ym).to).reduce((sum, p) => sum + R(ctcOf[p.key] ?? 0), 0)
  for (let i = 0; i < 12; i++) {
    const m = addMonths(histStart, i)
    const ym = monthOf(m)
    const before = m < fyStart
    for (const r of before ? recurring : []) {
      if (r.from && i < r.from) continue
      const jitter = r.kind === 'income' ? 1 + (rnd() - 0.5) * 0.2 : 1 + (rnd() - 0.5) * 0.06
      const date = r.kind === 'income' ? monthRange(ym).to : addDays(m, 4)
      db.ledger_entries.push({ ...base(T1), kind: r.kind, category: r.cat, description: r.desc, amount_paise: Math.round(L(r.amt) * jitter), date, recurring: false, until_on: null, status: date <= today ? (r.kind === 'income' ? 'received' : 'paid') : 'expected', project_id: null, milestone_id: null, invoice_id: null, stream: r.stream ?? null, locked: false })
    }
    // AMS sub-contract and utilities keep a month-by-month history; salaries every month
    const ams = monthRange(ym).to
    if (before && ams <= addDays(today, 31)) db.ledger_entries.push({ ...base(T1), kind: 'income', category: 'AMS', description: 'Infosys SAP support sub-contract', amount_paise: Math.round(L(1.1) * (1 + (rnd() - 0.5) * 0.1)), date: ams, recurring: false, until_on: null, status: ams <= today ? 'received' : 'expected', project_id: null, milestone_id: null, invoice_id: null, stream: 'ams', locked: false })
    if (before) db.ledger_entries.push({ ...base(T1), kind: 'expense', category: 'Utilities', description: 'Electricity, internet', amount_paise: Math.round(L(0.06) * (1 + (rnd() - 0.5) * 0.1)), date: addDays(m, 6), recurring: false, until_on: null, status: addDays(m, 6) <= today ? 'paid' : 'expected', project_id: null, milestone_id: null, invoice_id: null, stream: null, locked: false })
    db.ledger_entries.push({ ...base(T1), kind: 'expense', category: 'Salaries', description: 'Team salaries', amount_paise: payrollOf(ym), date: m, recurring: false, until_on: null, status: m <= today ? 'paid' : 'expected', project_id: null, milestone_id: null, invoice_id: null, stream: null, locked: false })
  }
  // Feature Guide ledger entries (screenshot 023)
  const le = (kind: E.LedgerKind, category: string, description: string, amount: number, date: string, opts: { recurring?: boolean; status?: E.LedgerEntry['status']; stream?: E.RevenueStream | null } = {}) =>
    db.ledger_entries.push({
      ...base(T1, { created_by: U.santosh.id }), kind, category, description, amount_paise: R(amount), date, recurring: !!opts.recurring, until_on: null,
      status: opts.status ?? (date <= today ? (kind === 'income' ? 'received' : 'paid') : 'expected'), project_id: null, milestone_id: null, invoice_id: null, stream: kind === 'income' ? opts.stream ?? null : null, locked: false,
    })
  le('income', 'Subscription / AMC', "EduReon subscription, Mother's Group", 100000, addMonths(fyStart, 8), { recurring: true, stream: 'saas' })
  le('income', 'Services', 'Digitalratha CRM, phase 1', 175000, addDays(today, -23), { status: 'expected', stream: 'services' })
  le('income', 'Subscription / AMC', 'Digitalratha CRM AMC', 25000, addDays(today, -26), { recurring: true, stream: 'saas' })
  le('income', 'Services', 'Website redevelopment project', 85000, addDays(today, -50), { status: 'received', stream: 'services' })
  le('income', 'Services', 'Digitalratha CRM, advance', 175000, addDays(today, -65), { status: 'received', stream: 'services' })
  le('expense', 'Marketing', 'BNI annual membership', 45000, addMonths(fyStart, 3))
  le('income', 'SAP consulting', 'SAP consulting retainers (Santosh)', 600000, addDays(fyStart, 4), { recurring: true, stream: 'sap_consulting' })
  le('expense', 'Rent', 'Office rent, Khandagiri', 40000, fyStart, { recurring: true })
  le('expense', 'Tools & software', 'Cloud, licences, tools', 15000, fyStart, { recurring: true })
  le('income', 'AMS', 'Infosys SAP support sub-contract', 110000, addDays(fyStart, 27), { recurring: true, stream: 'ams' })
  le('expense', 'Utilities', 'Electricity, internet', 6000, addDays(fyStart, 6), { recurring: true })
  db.ledger_entries.push({ ...base(T1), kind: 'expense', category: 'Equipment', description: 'Laptops for 2 developers', amount_paise: L(1.6), date: addDays(today, -75), recurring: false, until_on: null, status: 'paid', project_id: null, milestone_id: null, invoice_id: null, stream: null, locked: false })
  db.ledger_entries.push({ ...base(T1), kind: 'expense', category: 'Compliance', description: 'ISO 9001:2015 surveillance audit', amount_paise: L(0.45), date: addDays(today, -40), recurring: false, until_on: null, status: 'paid', project_id: null, milestone_id: null, invoice_id: null, stream: null, locked: false })

  /* ---- Deals (Feature Guide §11–12: deal value = one-time + 12 × recurring) ---- */
  type DL = { key: string; title: string; client: string; product: string; source: E.DealSource; stage: E.DealStage; value: number; mrr: number; owner: string; age: number; close: number; contact: string; lost?: string; last: number; fc?: string; next?: [string, number]; email?: string }
  // wins "this month" land inside the current month whatever today's date is
  const dom = Number(today.slice(8, 10))
  const thisMonth = (n: number) => -Math.min(n, dom - 1)
  const deals: DL[] = [
    { key: 'mgs', title: 'EduReon for 2 campuses', client: "Mother's Group of Schools", product: 'EduReon', source: 'bni', stage: 'won', value: 4.5, mrr: 1, owner: 'baishali', age: -120, close: -85, contact: 'Aditya Sabat (CFO)', last: -30, fc: 'BNI one-to-one with the CFO. Two campuses on spreadsheets and a separate fee tool; wants one system before the new session.', email: 'cfo@mothersgroup.in' },
    { key: 'hrms', title: 'SeerHR perpetual licence', client: 'Mahanadi Minerals Group', product: 'SeerHR', source: 'referral', stage: 'won', value: 15, mrr: 0, owner: 'santosh', age: -110, close: -60, contact: 'HR Head', last: -40, fc: 'Referred by an SAP client. 1,400 workers across three mines; contract labour attendance is the pain.' },
    { key: 'wcs', title: 'SeerHR for The World Consultancy Group', client: 'The World Consultancy Group', product: 'SeerHR', source: 'referral', stage: 'negotiation', value: 15, mrr: 0, owner: 'santosh', age: -40, close: 21, contact: 'Sunit (CEO)', last: -3, fc: 'CEO saw the Mahanadi rollout. Needs payroll for 600 consultants across 4 states.', next: ['Send revised commercials', 3] },
    { key: 'dr2', title: 'Custom sales CRM phase 3', client: 'Digitalratha', product: 'Custom software', source: 'existing_client', stage: 'proposal', value: 3.2, mrr: 0, owner: 'baishali', age: -25, close: 30, contact: 'Deepak (CEO)', last: -6, fc: 'Deepak asked for field-sales tracking after phase 1 lifted closing rates by 27%.', next: ['Walk through proposal with Deepak', 2] },
    { key: 'samet', title: 'EduReon for SAMET', client: 'SAMET School of Management', product: 'EduReon', source: 'bni', stage: 'demo', value: 2.5, mrr: 0.08, owner: 'baishali', age: -18, close: 40, contact: 'Principal', last: -2, fc: 'Met the principal at a BNI visitor day. Admissions and fee collection are manual.', next: ['Share proposal', 4] },
    { key: 'dg', title: 'Bakery ordering app', client: 'Dessert Garden', product: 'Custom software', source: 'bni', stage: 'qualified', value: 1.8, mrr: 0, owner: 'subham', age: -22, close: 45, contact: 'Atish Mital', last: -19, fc: 'BNI referral. Wants pre-orders for cakes with delivery slots.', next: ['Send revised quote', -5] },
    { key: 'emaar', title: 'Lighting dealer portal', client: 'EMAAAR Lighting Solutions', product: 'Custom software', source: 'bni', stage: 'lead', value: 2, mrr: 0, owner: 'subham', age: -9, close: 95, contact: 'Lalatendu Acharya', last: -9, fc: 'BNI chapter member; dealers order on WhatsApp today.', next: ['Book discovery call', 1] },
    { key: 'zoo', title: 'SAP CPI support renewal', client: 'ZooPlus Germany', product: 'SAP consulting', source: 'existing_client', stage: 'won', value: 6, mrr: 0, owner: 'santosh', age: -70, close: -12, contact: 'Integration lead', last: -12, fc: 'Annual renewal of CPI support; scope adds two new iFlows.' },
    { key: 'jewel', title: 'Jewellery catalogue app', client: 'Rahul Shah Jewellers', product: 'Custom software', source: 'bni', stage: 'lost', value: 1.5, mrr: 0, owner: 'subham', age: -60, close: -20, contact: 'Rahul Shah', lost: 'Budget moved to next year', last: -20, fc: 'BNI feature presentation follow-up.' },
    { key: 'mz', title: 'Wealth advisory CRM', client: 'Moneyzenie', product: 'LeadSync', source: 'bni', stage: 'proposal', value: 1.2, mrr: 0.05, owner: 'baishali', age: -14, close: 20, contact: 'Rohit Mohapatra', last: -1, fc: 'Rohit wants every client conversation logged for compliance.', next: ['Follow up on proposal', 2] },
    { key: 'rgh', title: 'Site sales & booking app', client: 'Radha Govind Homes', product: 'Custom software', source: 'bni', stage: 'qualified', value: 3.5, mrr: 0, owner: 'subham', age: -12, close: 100, contact: 'Subham Mohanty (MD)', last: -4, fc: 'MD wants site visits and bookings tracked per salesperson.', next: ['Book demo', 3] },
    { key: 'munim', title: 'Munim AI pilot', client: 'Fusion Computers', product: 'Munim AI', source: 'bni', stage: 'demo', value: 0.6, mrr: 0.03, owner: 'subham', age: -16, close: 15, contact: 'Pankaj Agarwal', last: -17, fc: 'Runs Tally; wants daily receivables on WhatsApp.' },
    { key: 'vacron', title: 'IT asset tracker', client: 'Vacron Technologies', product: 'Custom software', source: 'bni', stage: 'lost', value: 0.9, mrr: 0, owner: 'baishali', age: -50, close: -30, contact: 'Sibasis Parida', lost: 'Chose an off-the-shelf tool', last: -30 },
    { key: 'semtech', title: 'SAP RAP extensions', client: 'Semtech Corporation', product: 'SAP consulting', source: 'existing_client', stage: 'won', value: 8, mrr: 0, owner: 'santosh', age: -45, close: -28, contact: 'SAP program manager', last: -28, fc: 'Extension of the ABAP engagement to RAP-based Fiori apps.' },
    // last 30 days (screenshots 019–021)
    { key: 'cec', title: 'EduReon for Coastal Engineering College', client: 'Coastal Engineering College', product: 'EduReon', source: 'cold_call', stage: 'qualified', value: 3, mrr: 0.2, owner: 'baishali', age: -9, close: 45, contact: 'Registrar', last: -6, fc: 'Cold outreach. Registrar interested; exams and hostel fees are the pain.', next: ['Book demo', 2], email: 'registrar@coastalengg.edu.in' },
    { key: 'esc', title: 'SeerHR for Eastern Steel Castings', client: 'Eastern Steel Castings', product: 'SeerHR', source: 'bni', stage: 'qualified', value: 4.8, mrr: 0, owner: 'baishali', age: -10, close: 110, contact: 'HR Manager', last: -7, fc: 'BNI referral, first call: 380 workers, two shifts, payroll in Excel.', next: ['Plant visit', 5] },
    { key: 'kps', title: 'EduReon for Kalinga Public School', client: 'Kalinga Public School', product: 'EduReon', source: 'referral', stage: 'demo', value: 2.4, mrr: 0.08, owner: 'baishali', age: -26, close: 30, contact: 'Principal', last: -8, fc: "Referred by Mother's Group. Principal wants a fee module walkthrough.", next: ['Fee module walkthrough', 3] },
    { key: 'sapret', title: 'SAP ABAP & CPI support retainer', client: 'Global manufacturer (Germany)', product: 'SAP consulting', source: 'partner', stage: 'proposal', value: 0, mrr: 1, owner: 'santosh', age: -40, close: 25, contact: 'IT director', last: -8, fc: 'Partner introduction. 40 hours a month of ABAP and CPI support.', next: ['Proposal review call', 6] },
    { key: 'gva', title: 'EduReon for Green Valley Academy (3 campuses)', client: 'Green Valley Academy', product: 'EduReon', source: 'referral', stage: 'negotiation', value: 6, mrr: 0.3, owner: 'santosh', age: -35, close: 14, contact: 'Trustee', last: -9, fc: 'Trustee saw EduReon at a principals’ meet; three campuses, one fee policy.', next: ['Decide on 10% discount', 1] },
    { key: 'svm', title: 'EduReon starter', client: 'Saraswati Vidya Mandir', product: 'EduReon', source: 'bni', stage: 'won', value: 0.36, mrr: 0.02, owner: 'baishali', age: thisMonth(5) - 21, close: thisMonth(5), contact: 'Headmaster', last: thisMonth(5), fc: 'Small school; starter plan for admissions and fees.' },
    { key: 'utkal', title: 'LeadSync CRM', client: 'Utkal Motors', product: 'LeadSync', source: 'event', stage: 'won', value: 0.04, mrr: 0.005, owner: 'subham', age: thisMonth(3) - 11, close: thisMonth(3), contact: 'Showroom manager', last: thisMonth(3), fc: 'Met at an auto dealers’ expo; 3 sales users.' },
    { key: 'sai', title: 'EduReon for Sai International School', client: 'Sai International School', product: 'EduReon', source: 'website', stage: 'lead', value: 2.2, mrr: 0.1, owner: 'subham', age: thisMonth(2), close: 75, contact: 'Admissions head', last: thisMonth(2), fc: 'Website enquiry form; wants an online admissions portal before January.', next: ['Book discovery call', 2] },
    { key: 'pan', title: 'Munim AI starter', client: 'Panchamukhi Enterprises', product: 'Munim AI', source: 'bni', stage: 'won', value: 0.16, mrr: 0.02, owner: 'subham', age: -58, close: -40, contact: 'Pankaj Agarwal', last: -40, fc: 'BNI member; Tally user wanting daily summaries.' },
  ]
  const stages: E.DealStage[] = ['lead', 'qualified', 'demo', 'proposal', 'negotiation', 'won']
  const actNote: Record<E.ActivityType, string> = {
    call: 'Discovery call — understood current process and pain points', meeting: 'In-person meeting with decision makers', email: 'Sent case study and pricing overview',
    demo: 'Live demo of core workflows; strong interest in reports', proposal: 'Proposal sent with phased delivery and payment milestones', follow_up: 'Followed up on proposal questions', whatsapp: 'Shared one-pager on WhatsApp',
  }
  // scripted activity trail for the last 30 days: [deal, days ago (negative), type, note]
  const scripted: [string, number, E.ActivityType, string][] = [
    ['cec', -9, 'call', 'Registrar interested'], ['cec', -6, 'email', 'Sent intro deck'], ['cec', -1, 'whatsapp', 'Shared hostel fee screens'],
    ['esc', -10, 'call', 'BNI referral, first call'], ['esc', -7, 'whatsapp', 'Shared SeerHR one-pager'], ['esc', -2, 'email', 'Sent plant visit agenda'],
    ['kps', -8, 'call', 'Principal wants fee module walkthrough'], ['kps', -15, 'demo', 'Demo for principal and accountant'],
    ['gva', -9, 'meeting', 'Trustee asked for 10% discount'], ['gva', -20, 'demo', 'Demo across three campus heads'], ['gva', -2, 'call', 'Trustee call on payment terms'],
    ['sapret', -12, 'demo', 'Walked through the support model and SLA'], ['sapret', -8, 'proposal', 'Retainer proposal sent: 40 h/month'],
    ['wcs', -3, 'meeting', 'Commercial negotiation with the CEO'], ['wcs', -16, 'whatsapp', 'Shared payroll compliance checklist'],
    ['samet', -2, 'demo', 'Admissions and fee demo for the principal'], ['samet', -11, 'whatsapp', 'Sent demo invite'],
    ['mz', -1, 'follow_up', 'Followed up on proposal questions'], ['mz', -5, 'proposal', 'Proposal sent with compliance log'],
    ['dr2', -6, 'proposal', 'Phase 3 proposal sent'], ['dr2', -13, 'meeting', 'Scoped field-sales tracking with Deepak'],
    ['rgh', -4, 'call', 'MD confirmed budget range'], ['rgh', -12, 'whatsapp', 'Shared booking app screenshots'],
    ['emaar', 0, 'call', 'Intro call with Lalatendu'],
  ]
  // stage moves recorded in the last 30 days (overrides the evenly spread history for these deals)
  const moves: Record<string, [E.DealStage, number][]> = {
    cec: [['lead', -9], ['qualified', -6]],
    esc: [['lead', -10], ['qualified', -7]],
    kps: [['lead', -26], ['qualified', -20], ['demo', -15]],
    sapret: [['lead', -40], ['qualified', -30], ['demo', -12], ['proposal', -8]],
    gva: [['lead', -35], ['qualified', -28], ['demo', -20], ['proposal', -14], ['negotiation', -9]],
  }
  for (const d of deals) {
    const scriptedDates = scripted.filter((x) => x[0] === d.key).map((x) => x[1])
    const last = Math.max(d.last, ...scriptedDates)
    const deal: E.Deal = {
      ...base(T1, { created_by: U[d.owner].id }), id: `d_${d.key}`, title: d.title, client: d.client, contact: d.contact, phone: '+91 98' + Math.floor(10000000 + rnd() * 89999999), email: d.email ?? '',
      product: d.product, source: d.source, owner_id: U[d.owner].id, stage: d.stage, value_paise: L(d.value), mrr_paise: L(d.mrr), expected_close: addDays(today, d.close),
      won_on: d.stage === 'won' ? addDays(today, d.close) : null, lost_on: d.stage === 'lost' ? addDays(today, d.close) : null, lost_reason: d.lost ?? null,
      project_id: d.key === 'mgs' ? 'p_mgs' : d.key === 'hrms' ? 'p_hrms' : null, last_activity_on: addDays(today, last), notes: '',
      first_conversation: d.fc ?? null, next_step: d.next && d.stage !== 'won' && d.stage !== 'lost' ? d.next[0] : null, next_step_on: d.next && d.stage !== 'won' && d.stage !== 'lost' ? addDays(today, d.next[1]) : null,
    }
    db.deals.push(deal)
    const reach = d.stage === 'lost' ? 3 : stages.indexOf(d.stage)
    const span = Math.max(1, (d.stage === 'won' || d.stage === 'lost' ? d.close : d.last) - d.age)
    const mv = moves[d.key]
    if (mv) mv.forEach(([st, off], i) => db.deal_stage_history.push({ ...base(T1), deal_id: deal.id, from_stage: i === 0 ? null : mv[i - 1][0], to_stage: st, by: deal.owner_id, at: addDays(today, off) + `T${String(5 + i).padStart(2, '0')}:30:00Z`, reason: null }))
    else
      for (let s = 0; s <= reach; s++) {
        const at = addDays(today, d.age + Math.round((span * s) / Math.max(1, reach)))
        db.deal_stage_history.push({ ...base(T1), deal_id: deal.id, from_stage: s === 0 ? null : stages[s - 1], to_stage: stages[s], by: deal.owner_id, at: at + 'T07:00:00Z', reason: null })
      }
    if (d.stage === 'lost') db.deal_stage_history.push({ ...base(T1), deal_id: deal.id, from_stage: stages[reach], to_stage: 'lost', by: deal.owner_id, at: addDays(today, d.close) + 'T07:00:00Z', reason: d.lost ?? null })
    const mine = scripted.filter((x) => x[0] === d.key)
    if (mine.length) {
      for (const [, off, type, note] of mine) db.deal_activities.push({ ...base(T1), deal_id: deal.id, date: addDays(today, off), type, note, by: deal.owner_id })
      continue
    }
    const types: E.ActivityType[] = ['call', 'whatsapp', 'meeting', 'email', 'demo', 'proposal', 'follow_up']
    const acts = 2 + Math.floor(rnd() * 4)
    for (let a = 0; a < acts; a++) {
      const date = addDays(today, d.age + Math.round(((d.last - d.age) * (a + 1)) / acts))
      const type = types[Math.min(types.length - 1, Math.floor((a / acts) * (reach + 3)))]
      db.deal_activities.push({ ...base(T1), deal_id: deal.id, date, type, note: actNote[type], by: deal.owner_id })
    }
  }

  /* ---- Change requests, openings, ops ---- */
  db.change_requests.push(
    { ...base(T1), project_id: 'p_hrms', title: 'Contract labour wage register', description: 'Client wants Form XIII / wage register for contract workers.', hours: 40, value_paise: L(1.2), status: 'estimated', raised_by: U.subhankar.id, milestone_id: null, decided_by: null, decided_at: null },
    { ...base(T1), project_id: 'p_mgs', title: 'Transport fee module', description: 'Per-route transport fee with monthly billing.', hours: 24, value_paise: L(0.6), status: 'approved', raised_by: U.subhankar.id, milestone_id: 'ms_mgs_3', decided_by: U.santosh.id, decided_at: addDays(today, -15) + 'T06:00:00Z' },
    { ...base(T1), project_id: 'p_crm', title: 'Hindi UI for field sales', description: 'Localised field app.', hours: 16, value_paise: L(0.4), status: 'raised', raised_by: U.subhankar.id, milestone_id: null, decided_by: null, decided_at: null },
  )
  db.openings.push(
    { ...base(T1), role: 'QA engineer', project_id: 'p_hrms', count: 1, status: 'interviewing', owner_id: U.priya.id, needed_by: addDays(today, 20), notes: '3 candidates in final round' },
    { ...base(T1), role: 'SAP CPI consultant', project_id: 'p_rcu', count: 1, status: 'open', owner_id: U.santosh.id, needed_by: addDays(today, 45), notes: 'For RCU scope expansion' },
    { ...base(T1), role: 'Flutter developer', project_id: 'p_edureon', count: 1, status: 'offered', owner_id: U.subhankar.id, needed_by: addDays(today, 10), notes: 'Offer rolled out, joining in 2 weeks' },
  )
  const nextOn = (dayOfMonth: number, offsetMonths = 0) => {
    const m = monthRange(monthOf(addMonths(today, offsetMonths)))
    const d = `${m.from.slice(0, 8)}${String(dayOfMonth).padStart(2, '0')}`
    return d
  }
  const ops: [string, E.OpsItem['category'], string, string, E.Recurrence, string][] = [
    ['Payroll processing', 'payroll', 'priya', nextOn(1, 1), 'monthly', ''],
    ['PF and ESI filing', 'compliance', 'priya', nextOn(15, 1), 'monthly', 'ECR upload on EPFO portal'],
    ['GST return (GSTR-3B)', 'compliance', 'priya', nextOn(20), 'monthly', ''],
    ['TDS deposit', 'compliance', 'priya', nextOn(7, 1), 'monthly', ''],
    ['Weekly invoicing review', 'finance', 'santosh', addDays(weekStart(today), 4), 'weekly', 'Check uninvoiced milestones and overdue receivables'],
    ['Advance tax', 'finance', 'priya', '2026-12-15', 'quarterly', ''],
    ['ISO 9001 internal audit', 'admin', 'subhankar', addDays(today, -3), 'yearly', 'Overdue — schedule with auditor'],
    ['Laptop & licence inventory', 'it', 'priya', addDays(today, 12), 'quarterly', ''],
  ]
  for (const [item, category, owner, due, rec, notes] of ops) db.ops_items.push({ ...base(T1), item, category, owner_id: U[owner].id, due_on: due, recurring: rec, status: 'open', last_done_on: null, notes })

  /* ---- Comments, daily updates, notifications, delegations ---- */
  db.comments.push(
    { ...base(T1), task_id: 't_hrms_7', body: '@Jagannath Nayak can you expose the run endpoint by Thursday? I am blocked on the approval screen.', mentions: [U.jagannath.id], author_id: U.jayashree.id, parent_id: null, created_at: addDays(today, -2) + 'T08:15:00Z' },
    { ...base(T1), task_id: 't_hrms_7', body: 'Yes — pushing a stub today, full calc by Thursday EOD.', mentions: [], author_id: U.jagannath.id, parent_id: null, created_at: addDays(today, -2) + 'T09:40:00Z' },
    { ...base(T1), task_id: 't_hrms_4', body: 'Arrears calculation needs the effective-dated salary structure. @Subhankar Rout please confirm scope with client.', mentions: [U.subhankar.id], author_id: U.jagannath.id, parent_id: null, created_at: addDays(today, -4) + 'T10:00:00Z' },
  )
  for (const w of ['hritesh', 'bijaya', 'jayashree', 'pragyasmita']) {
    for (let k = 1; k <= 4; k++) {
      const date = addDays(today, -k)
      if (!isWorkingDay(date, cal1)) continue
      const t = allTasks.find((x) => x.owner_id === U[w].id && x.status !== 'done' && x.status !== 'todo')
      db.daily_updates.push({ ...base(T1), user_id: U[w].id, date, done: t ? `Progress on “${t.title}”: completed the next sub-module and unit tests.` : 'Code review and bug fixes', proof_url: 'https://github.com/seereon/' + (t?.project_id.slice(2) ?? 'internal') + '/pull/' + (100 + Math.floor(rnd() * 80)), blocker: w === 'jayashree' && k === 1 ? 'Waiting on payroll run API' : '', demo_shown: k === 1 && w === 'hritesh' })
    }
  }
  const N = (user: string, type: E.NotificationType, title: string, body: string, link: string | null, ago: number, read = false) =>
    db.notifications.push({ ...base(T1), user_id: U[user].id, type, title, body, link, read_at: read ? t0 : null, created_at: new Date(Date.now() - ago * 3600000).toISOString() })
  N('subhankar', 'NTF-04', 'Timesheet submitted', 'Hritesh Panda submitted last week (47.5h).', '/approvals', 20)
  N('subhankar', 'NTF-07', 'Unlock requested', 'Jagannath Nayak asked to unlock last week: “Was at client site…”', '/approvals', 14)
  N('subhankar', 'NTF-10', 'Approvals overdue', '2 timesheets are past the 2-day approval SLA.', '/approvals', 6)
  N('subhankar', 'NTF-03', 'You were mentioned', 'Jagannath Nayak mentioned you on 2.1 Payroll engine.', '/tasks/t_hrms_4', 90, true)
  N('santosh', 'NTF-12', 'Deal going stale', 'Bakery ordering app (Dessert Garden) has had no activity for 19 days.', '/sales/d_dg', 30)
  N('santosh', 'NTF-13', 'Ops item overdue', 'ISO 9001 internal audit was due 3 days ago.', '/operations', 70)
  N('santosh', 'NTF-04', 'Timesheet submitted', 'Baishali Rout submitted last week.', '/approvals', 26)
  N('subham', 'NTF-06', 'Timesheet rejected', 'Santosh Nayak rejected last week: split client meetings by deal.', '/timesheet', 28)
  N('jayashree', 'NTF-14', 'Task assigned', 'Subhankar Rout assigned you 2.5 Payroll approval workflow.', '/tasks/t_hrms_7', 150, true)
  N('hritesh', 'NTF-09', 'Timesheet reminder', 'Submit this week by Sunday midnight to avoid the lock.', '/timesheet', 3)
  db.delegations.push({ ...base(T1), from_user_id: U.subhankar.id, to_user_id: U.hritesh.id, from_on: addDays(today, 18), to_on: addDays(today, 22), reason: 'Client site visit (Keonjhar)' })

  /* ---- Payroll: the month before last is final; last month is a DRAFT (Feature Guide §10: recalculate after approvals, then finalise) ---- */
  const lastMonth = monthOf(addMonths(today, -1))
  const prevMonth = monthOf(addMonths(today, -2))
  db.payroll_runs.push({ ...base(T1), id: 'pr_prev', month: prevMonth, status: 'final', finalised_by: U.santosh.id, finalised_at: `${addDays(monthRange(prevMonth).to, 5)}T12:00:00Z`, warnings: [] })
  db.payroll_runs.push({ ...base(T1), id: 'pr_last', month: lastMonth, status: 'draft', finalised_by: null, finalised_at: null, warnings: [] })

  /* ---- Saved / system reports ---- */
  const rep = (name: string, description: string, spec: import('@/types/reports').ReportSpec, pinned = false, source: E.SavedReport['source'] = 'system') =>
    db.saved_reports.push({ ...base(T1), name, description, spec, owner_id: U.santosh.id, shared: true, pinned, source, schedule: 'none', last_run_at: null })
  rep('Revenue by stream — this FY', 'Billed revenue split by business stream', { title: 'Revenue by stream', dataset: 'ledger', measures: [{ field: 'amount', agg: 'sum', label: 'Revenue' }], dimensions: [{ field: 'stream' }], filters: [{ field: 'kind', op: 'eq', value: 'income' }], period: { preset: 'this_fy' }, chart: 'pie' }, true)
  rep('Monthly billed, collected and costs', 'Last 12 months, month by month', { title: 'Billed, collected and costs by month', dataset: 'ledger', measures: [{ field: 'billed', agg: 'sum', label: 'Billed' }, { field: 'collected', agg: 'sum', label: 'Collected' }, { field: 'spent', agg: 'sum', label: 'Costs' }], dimensions: [{ field: 'date', grain: 'month' }], filters: [], period: { preset: 'last_12_months' }, chart: 'bar' }, true)
  rep('Hours by project — last 30 days', 'Approved and pending hours per project', { title: 'Hours by project', dataset: 'hours', measures: [{ field: 'hours', agg: 'sum' }], dimensions: [{ field: 'project' }], filters: [{ field: 'kind', op: 'eq', value: 'task' }], period: { preset: 'last_30_days' }, chart: 'hbar' })
  rep('Open pipeline by stage', 'Value of open deals per stage', { title: 'Pipeline by stage', dataset: 'deals', measures: [{ field: 'value', agg: 'sum' }, { field: '*', agg: 'count', label: 'Deals' }], dimensions: [{ field: 'stage' }], filters: [{ field: 'is_open', op: 'eq', value: true }], chart: 'bar' })
  rep('Overdue tasks', 'Open tasks past due date, by owner', { title: 'Overdue tasks', dataset: 'tasks', measures: [], dimensions: [], columns: ['code', 'title', 'project', 'owner', 'due_on', 'days_overdue', 'status'], filters: [{ field: 'is_overdue', op: 'eq', value: true }], sort: [{ field: 'days_overdue', dir: 'desc' }], chart: 'table' })

  /* ---- Subscriptions & billing ---- */
  db.subscriptions.push({ ...base(T1), plan_code: 'growth', status: 'active', current_period_end: addDays(today, 18), seats: 15, razorpay_subscription_id: 'sub_demo_seereon' })
  for (let i = 1; i <= 4; i++) db.billing_invoices.push({ ...base(T1), number: `SOS-${2026}-${100 + i}`, period: monthOf(addMonths(today, -i)), amount_paise: R(10 * 499 * 1.18), status: 'paid', issued_on: addMonths(today, -i) })

  /* ================= Tenant 2: Kalinga Softworks ================= */
  const T2 = 'tn_kalinga'
  db.tenants.push({
    id: T2, name: 'Kalinga Softworks', slug: 'kalinga', status: 'trial', industry: 'it_services', trial_ends_on: addDays(today, 9), time_zone: 'Asia/Kolkata', plan_code: 'trial', seats: 6,
    created_at: addDays(today, -5) + 'T05:00:00Z', logo_data_url: null,
    theme: { preset: 'ocean', primary: '#1D5FD1', accent: '#E0892B', radius: 'round', density: 'comfortable', font: 'inter', mode: 'light', sidebar: 'light' },
    settings: { ...DEFAULT_SETTINGS, 'calendar.saturday_rule': 'all_off', 'projects.code_prefix': 'KS', 'calendar.min_hours_per_day': 8 }, version: 1,
  })
  const k = (key: string, name: string, title: string, role: E.Role, reports: string | null, hue: number, ctc: number): E.User => {
    const u: E.User = { ...base(T2), id: `u_k_${key}`, email: `${key}@kalingasoft.in`, name, title, role, reports_to_id: reports, grants: role === 'admin' ? ['margins', 'salaries'] : [], role_key: '', extra_permissions: [], revoked_permissions: [], status: 'active', last_login_at: null, avatar_hue: hue, phone: null, joined_on: addDays(today, -5), department: role === 'sales' ? 'sales' : role === 'admin' ? 'management' : 'delivery', two_factor: false, prefs: {} }
    db.users.push(u)
    db.passwords.push({ user_id: u.id, password: DEMO_PASSWORD })
    db.cost_rates.push({ ...base(T2), user_id: u.id, monthly_ctc_paise: R(ctc), variable_pct: role === 'sales' ? 20 : 0, sales_target_paise: role === 'sales' ? R(ctc) : null, effective_from: addDays(today, -5) })
    return u
  }
  const ka = k('ananya', 'Ananya Mishra', 'Managing Director', 'admin', null, 200, 200000)
  const kr = k('rakesh', 'Rakesh Sahoo', 'Project Manager', 'pm', ka.id, 30, 85000)
  k('sneha', 'Sneha Patnaik', 'React Developer', 'employee', kr.id, 300, 45000)
  k('arjun', 'Arjun Behera', 'Python Developer', 'employee', kr.id, 100, 48000)
  k('meera', 'Meera Das', 'Sales Manager', 'sales', ka.id, 340, 50000)
  const kp: E.Project = { ...base(T2), id: 'p_k_1', code: 'KS-001', name: 'Hospital OPD Booking App', client: 'Kalinga Hospital', type: 'service', status: 'active', pm_id: kr.id, start_on: addDays(today, -4), end_on: addDays(today, 60), contract_value_paise: L(5.5), billing_model: 'fixed', stream: 'services', description: 'Patient OPD booking with doctor schedules.', priority: 1, deal_id: null, baseline_end_on: addDays(today, 60), color_hue: 200 }
  db.projects.push(kp)
  // KS-001 has a full plan so its margins are realistic: three billed milestones (₹1.5L + ₹2.5L + ₹1.5L = ₹5.5L), a WBS
  // that fills them, a resource allocation per milestone (people with cost rates above) and a saved costing plan.
  const KMS = [
    { id: 'ms_k_1', name: 'Design & prototype', s: -4, e: 20, amt: 1.5 },
    { id: 'ms_k_2', name: 'Booking engine & patient app', s: 21, e: 45, amt: 2.5 },
    { id: 'ms_k_3', name: 'UAT & go-live', s: 46, e: 60, amt: 1.5 },
  ]
  KMS.forEach((m, i) => db.milestones.push({ ...base(T2), id: m.id, project_id: kp.id, no: i + 1, name: m.name, planned_start: addDays(today, m.s), planned_end: addDays(today, m.e), baseline_end: addDays(today, m.e), billing_amount_paise: L(m.amt), billing_status: 'none', achieved_on: null, empty_since: null, deleted_at: null }))
  const KT: [ms: number, no: number, title: string, owner: string, est: number, s: number, e: number, status: E.TaskStatus][] = [
    [1, 1, 'Patient booking flow screens', 'sneha', 32, -4, 8, 'in_progress'],
    [1, 2, 'Doctor schedule data model and API', 'arjun', 40, -4, 10, 'in_progress'],
    [1, 3, 'Clickable prototype review with OPD staff', 'rakesh', 12, 11, 20, 'todo'],
    [2, 1, 'Slot booking and queue engine', 'arjun', 96, 21, 40, 'todo'],
    [2, 2, 'Patient app: booking, history and payments', 'sneha', 104, 21, 42, 'todo'],
    [2, 3, 'SMS and WhatsApp appointment reminders', 'arjun', 24, 41, 45, 'todo'],
    [3, 1, 'UAT with OPD front desk and fixes', 'sneha', 40, 46, 55, 'todo'],
    [3, 2, 'Go-live, data load and staff training', 'rakesh', 20, 54, 60, 'todo'],
  ]
  for (const [mi, no, title, owner, est, st, en, status] of KT)
    db.tasks.push({ ...base(T2), id: `t_k_${mi}_${no}`, project_id: kp.id, milestone_id: `ms_k_${mi}`, no, wbs_code: `${mi}.${no}`, title, owner_id: `u_k_${owner}`, backup_id: null, est_hours: est, start_on: addDays(today, st), due_on: addDays(today, en), done_on: null, complexity: est > 60 ? 'high' : 'medium', status, description: '', blocked_reason: null, stage: status === 'in_progress' ? 'in_development' : 'new', progress: status === 'in_progress' ? 25 : 0, baseline_due_on: addDays(today, en) } as E.Task)
  // allocation by milestone (% of each working day), spanning the milestone's dates
  const KA: [ms: number, who: string, pct: number][] = [
    [1, 'sneha', 60], [1, 'arjun', 60], [1, 'rakesh', 20],
    [2, 'sneha', 100], [2, 'arjun', 100], [2, 'rakesh', 20],
    [3, 'sneha', 60], [3, 'arjun', 30], [3, 'rakesh', 30],
  ]
  for (const [mi, who, pct] of KA) db.allocations.push({ ...base(T2), project_id: kp.id, milestone_id: `ms_k_${mi}`, user_id: `u_k_${who}`, pct, from_on: addDays(today, KMS[mi - 1].s), to_on: addDays(today, KMS[mi - 1].e) })
  kp.costing = {
    additional_costs: [
      { id: 'ac1', category: 'third_party', description: 'Freelance UI/UX designer for the patient app', amount_paise: R(45000) },
      { id: 'ac2', category: 'software', description: 'Cloud hosting and SMS / WhatsApp gateway credits (year 1)', amount_paise: R(18000) },
    ],
    maintenance_paise: R(15000),
    contingency_pct: 5,
    markup_pct: 99.1, // price ÷ planned cost (≈ ₹2.76L incl. contingency) − 1 → planned margin ≈ 50%
    price_paise: L(5.5),
    saved_at: addDays(today, -4) + 'T06:30:00Z',
    saved_by: kr.id,
  }
  db.deals.push({ ...base(T2), id: 'd_k_1', title: 'Clinic chain EMR', client: 'Sparsh Clinics', contact: 'Dr. Rath', phone: '', email: '', product: 'Custom software', source: 'referral', owner_id: 'u_k_meera', stage: 'proposal', value_paise: L(12), mrr_paise: 0, expected_close: addDays(today, 30), won_on: null, lost_on: null, lost_reason: null, project_id: null, last_activity_on: addDays(today, -2), notes: '' })
  db.holidays.push({ ...base(T2), date: '2026-10-02', name: 'Gandhi Jayanti', optional: false }, { ...base(T2), date: '2026-11-08', name: 'Diwali', optional: false })
  db.number_sequences.push({ tenant_id: T2, scope: 'project', next_value: 2 })
  db.subscriptions.push({ ...base(T2), plan_code: 'trial', status: 'trialing', current_period_end: addDays(today, 9), seats: 6, razorpay_subscription_id: null })

  /* ================= Platform super admin ================= */
  db.users.push({ ...base('platform'), id: 'u_platform', email: 'platform@seereon.co.in', name: 'Platform Admin', title: 'SeereonOS Operations', role: 'admin', reports_to_id: null, grants: [], role_key: 'administrator', extra_permissions: [], revoked_permissions: [], status: 'active', last_login_at: null, avatar_hue: 45, phone: null, joined_on: addDays(today, -300), department: 'management', two_factor: false, prefs: {}, is_super_admin: true })
  db.passwords.push({ user_id: 'u_platform', password: DEMO_PASSWORD })
  db.tenants.push(
    { id: 'tn_utkal', name: 'Utkal Digital Labs', slug: 'utkal', status: 'read_only', industry: 'it_services', trial_ends_on: addDays(today, -3), time_zone: 'Asia/Kolkata', plan_code: 'trial', seats: 8, created_at: addDays(today, -17) + 'T05:00:00Z', logo_data_url: null, theme: { ...DEFAULT_THEME, preset: 'graphite', primary: '#2F3A45', accent: '#C08A2E' }, settings: { ...DEFAULT_SETTINGS }, version: 1 },
    { id: 'tn_konark', name: 'Konark SAP Partners', slug: 'konark', status: 'active', industry: 'sap_consulting', trial_ends_on: null, time_zone: 'Asia/Kolkata', plan_code: 'starter', seats: 22, created_at: addDays(today, -95) + 'T05:00:00Z', logo_data_url: null, theme: { ...DEFAULT_THEME }, settings: { ...DEFAULT_SETTINGS }, version: 1 },
  )

  /* ---- Built-in "General & admin" project: line managers assign non-client work here ---- */
  for (const t of db.tenants) {
    const admin = db.users.find((u) => u.tenant_id === t.id && u.role === 'admin' && !u.is_super_admin)
    if (!admin) continue
    db.projects.push({
      ...base(t.id), id: `p_general_${t.slug}`, code: 'GEN', name: 'General & admin', client: 'Internal', type: 'service', status: 'active', pm_id: admin.id,
      start_on: addDays(today, -365), end_on: addDays(today, 365), contract_value_paise: 0, billing_model: 'fixed', stream: 'services',
      description: 'Internal work assigned by line managers: admin, compliance, learning, presales support, internal tooling.', priority: 3, deal_id: null, baseline_end_on: addDays(today, 365), color_hue: 210,
    })
  }

  extendSeed(db, { today, base: (tenant_id: string) => base(tenant_id), id, rnd })
  void parseISO
  void toISO
  return db
}
