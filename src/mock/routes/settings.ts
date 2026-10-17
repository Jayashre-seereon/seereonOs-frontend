// Module A — tenant settings (UI-06), holidays (UI-07), cost rates (UI-17), data export (UI-26),
// onboarding checklist (UI-25).
import type * as E from '@/types/entities'
import { addDays, avgWorkingDaysPerMonth, fyLabel, fyStartYear, isRealISODate, monthOf, monthRange, parseISO, todayISO, workingDaysInMonth } from '@/domain/calendar'
import { DEFAULT_SETTINGS } from '../seed'
import {
  calendarFor, canSeeSalaries, err, find, getDb, has, insert, logActivity, nextNumber, notify, nowISO, permissionsOf, persist, remove, requireAction, rows, update, uid, userName, warn, type Ctx, type DB, type Router,
} from '../server'
import { tenantOf } from './auth'
import { assertBaseVersion, pendingBrief, propose, registerApplier } from '../makerChecker'
import { fmtMoney } from '@/domain/money'

/* ------------------------------------------------------------------ */
/* Settings validation                                                  */
/* ------------------------------------------------------------------ */
type K = keyof E.TenantSettings
type Rule = { kind: 'num'; min: number; max: number; step?: number; label: string } | { kind: 'bool'; label: string } | { kind: 'enum'; values: (string | number)[]; label: string } | { kind: 'time'; label: string } | { kind: 'text'; max: number; label: string } | { kind: 'days'; label: string } | { kind: 'weeks'; label: string } | { kind: 'fixed'; label: string }

export const SETTING_RULES: Record<K, Rule> = {
  'company.fy_start_month': { kind: 'num', min: 1, max: 12, label: 'Financial year start' },
  'company.currency': { kind: 'fixed', label: 'Currency' },
  'calendar.weekly_off': { kind: 'days', label: 'Weekly off days' },
  'calendar.saturday_rule': { kind: 'enum', values: ['all_on', 'all_off', 'some_off'], label: 'Saturday rule' },
  'calendar.saturday_off_weeks': { kind: 'weeks', label: 'Saturdays off' },
  'calendar.min_hours_per_day': { kind: 'num', min: 1, max: 12, step: 0.5, label: 'Minimum hours per day' },
  'calendar.max_hours_per_day': { kind: 'num', min: 8, max: 24, step: 0.5, label: 'Maximum hours per day' },
  'calendar.breaks_count': { kind: 'bool', label: 'Breaks count as work' },
  'timesheet.hours_step': { kind: 'enum', values: [0.25, 0.5, 1], label: 'Hours step' },
  'timesheet.allow_future_entries': { kind: 'bool', label: 'Allow future entries' },
  'timesheet.internal_note_required': { kind: 'bool', label: 'Note required on internal time' },
  'timesheet.weekly_lock': { kind: 'bool', label: 'Weekly lock' },
  'timesheet.unlock_max_days': { kind: 'num', min: 1, max: 14, label: 'Unlock window' },
  'approval.sla_working_days': { kind: 'num', min: 1, max: 10, label: 'Approval SLA' },
  'approval.bulk_approve': { kind: 'bool', label: 'Bulk approve' },
  'pay.deduct_unapproved_days': { kind: 'bool', label: 'Deduct unapproved days' },
  'pay.variable_default_pct': { kind: 'num', min: 0, max: 50, label: 'Default variable pay' },
  'pay.target_default': { kind: 'enum', values: ['ctc', 'manual'], label: 'Default sales target' },
  'pay.variable_threshold_pct': { kind: 'num', min: 80, max: 120, label: 'Variable pay threshold' },
  'projects.code_prefix': { kind: 'text', max: 6, label: 'Project code prefix' },
  'projects.empty_milestone_days': { kind: 'num', min: 0, max: 60, label: 'Empty milestone clean-up' },
  'projects.margin_floor_pct': { kind: 'num', min: 0, max: 90, label: 'Margin floor' },
  'projects.effort_ratio_alert': { kind: 'num', min: 1, max: 3, step: 0.05, label: 'Effort ratio alert' },
  'allocation.max_pct_per_person': { kind: 'num', min: 50, max: 150, label: 'Max allocation per person' },
  'allocation.block_over': { kind: 'bool', label: 'Block over-allocation' },
  'daily.proof_required': { kind: 'bool', label: 'Proof link required' },
  'sales.stale_deal_days': { kind: 'num', min: 3, max: 90, label: 'Stale deal after' },
  'notify.friday_nudge_time': { kind: 'time', label: 'Friday nudge time' },
  'notify.sla_digest_time': { kind: 'time', label: 'SLA digest time' },
  'security.password_min_length': { kind: 'num', min: 8, max: 64, label: 'Minimum password length' },
  'security.lockout_attempts': { kind: 'num', min: 3, max: 10, label: 'Lockout attempts' },
  'security.lockout_minutes': { kind: 'num', min: 5, max: 120, label: 'Lockout duration' },
  'security.session_idle_minutes': { kind: 'num', min: 15, max: 720, label: 'Idle sign-out' },
  'security.require_2fa_admins': { kind: 'bool', label: 'Require 2-step for admins' },
  'ai.enabled': { kind: 'bool', label: 'AI assistant' },
  'finance.opening_cash_paise': { kind: 'num', min: 0, max: 1e13, label: 'Opening cash' },
  'finance.monthly_overheads_paise': { kind: 'num', min: 0, max: 1e12, label: 'Monthly overheads' },
  'finance.cost_loading_pct': { kind: 'num', min: 0, max: 200, label: 'Cost loading' },
  'team.default_productive_hours': { kind: 'num', min: 1, max: 12, label: 'Default productive hours a day' },
}

function validateSetting(key: K, v: unknown): unknown {
  const r = SETTING_RULES[key]
  if (!r) err(422, 'VALIDATION', `Unknown setting ${key}.`, key)
  switch (r.kind) {
    case 'fixed':
      err(422, 'VALIDATION', `${r.label} cannot be changed.`, key)
    // eslint-disable-next-line no-fallthrough
    case 'num': {
      const n = Number(v)
      if (!Number.isFinite(n) || n < r.min || n > r.max) err(422, 'VALIDATION', `${r.label} must be between ${r.min} and ${r.max}.`, key)
      if (r.step && Math.abs(n / r.step - Math.round(n / r.step)) > 1e-9) err(422, 'VALIDATION', `${r.label} must be in steps of ${r.step}.`, key)
      if (!r.step && !key.startsWith('finance.') && !Number.isInteger(n)) err(422, 'VALIDATION', `${r.label} must be a whole number.`, key)
      return n
    }
    case 'bool':
      if (typeof v !== 'boolean') err(422, 'VALIDATION', `${r.label} must be on or off.`, key)
      return v
    case 'enum':
      if (!r.values.includes(v as string)) err(422, 'VALIDATION', `Choose a valid ${r.label.toLowerCase()}.`, key)
      return v
    case 'time':
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) err(422, 'VALIDATION', `${r.label} must be a time like 16:00.`, key)
      return v
    case 'text': {
      const s = String(v ?? '').trim().toUpperCase()
      if (!/^[A-Z][A-Z0-9]{1,5}$/.test(s) || s.length > r.max) err(422, 'VALIDATION', `${r.label} must be 2–${r.max} letters or digits, starting with a letter.`, key)
      return s
    }
    case 'days': {
      const a = [...new Set((v as number[]) ?? [])].map(Number).sort()
      if (a.some((d) => !Number.isInteger(d) || d < 0 || d > 5)) err(422, 'VALIDATION', 'Weekly offs are Sunday to Friday; Saturdays use the Saturday rule.', key)
      if (a.length > 3) err(422, 'VALIDATION', 'Choose at most three weekly off days.', key)
      return a
    }
    case 'weeks': {
      const a = [...new Set((v as number[]) ?? [])].map(Number).sort()
      if (a.some((d) => !Number.isInteger(d) || d < 1 || d > 5)) err(422, 'VALIDATION', 'Saturdays off must be 1st to 5th.', key)
      return a
    }
  }
}

const TIME_ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Australia/Sydney']

/** Admin touched workspace settings? (derived — activity log, non-default values, or a logo) */
function settingsTouched(ctx: Ctx) {
  const t = tenantOf(ctx)
  if (rows(ctx, 'activity_log').some((a) => a.entity === 'tenant_settings')) return true
  if (t.logo_data_url) return true
  return (Object.keys(DEFAULT_SETTINGS) as K[]).some((k) => JSON.stringify(t.settings[k]) !== JSON.stringify(DEFAULT_SETTINGS[k]))
}

/* ------------------------------------------------------------------ */
/* Cost rates                                                           */
/* ------------------------------------------------------------------ */
function rateOn(list: E.CostRate[], date: string) {
  return list.filter((r) => r.effective_from <= date).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null
}
function lockedMonths(ctx: Ctx) {
  return new Set(rows(ctx, 'payroll_runs').filter((p) => p.status === 'final').map((p) => p.month))
}

/* ------------------------------------------------------------------ */
/* Export                                                               */
/* ------------------------------------------------------------------ */
const EXPORT_SKIP = new Set(['passwords', 'login_attempts', 'sessions', 'reset_tokens', 'admin_audit', 'number_sequences', 'tenants', 'pending_tokens'])
function tenantDump(ctx: Ctx) {
  const d = getDb() as unknown as Record<string, { tenant_id?: string }[]>
  const tables: Record<string, unknown[]> = {}
  for (const name of Object.keys(d)) {
    if (EXPORT_SKIP.has(name)) continue
    const list = d[name].filter((r) => r.tenant_id === ctx.tenant.id)
    tables[name] = name === 'invites' ? list.map((r) => ({ ...r, token: '[redacted]' })) : name === 'files' ? list.map((r) => ({ ...r, data_url: r && (r as { data_url?: string }).data_url ? '[binary omitted]' : null })) : list
  }
  const t = tenantOf(ctx)
  return { tenant: { id: t.id, name: t.name, slug: t.slug, industry: t.industry, time_zone: t.time_zone, settings: t.settings, theme: t.theme }, tables }
}

/* ------------------------------------------------------------------ */
export function register(r: Router) {
  /* ---- settings (UI-06) ---- */
  r.get('/settings', ({ ctx }) => {
    const t = tenantOf(ctx)
    if (!t) err(404, 'NOT_FOUND', 'Workspace not found.') // the platform admin has no workspace (was a TypeError → 500)
    const fm = t.settings['company.fy_start_month']
    const fy = fyStartYear(todayISO(), fm)
    // Feature Guide §16: average working days a month this FY, after weekly offs and holidays
    const calendar_stats = { fy_label: fyLabel(fy), avg_working_days: avgWorkingDaysPerMonth(fy, calendarFor(ctx), fm) }
    return { tenant: t, time_zones: TIME_ZONES, rules: SETTING_RULES, defaults: DEFAULT_SETTINGS, calendar_stats }
  })

  r.put('/settings', ({ ctx, body, ifMatch }) => {
    requireAction(ctx, 'settings.edit', 'Only admins can change workspace settings.')
    const t = tenantOf(ctx)
    if (ifMatch !== undefined && ifMatch !== t.version) err(409, 'STALE', 'Settings were changed by someone else. Reload to see the latest, then make your change again.')
    const changed: string[] = []
    const next = { ...t.settings } as Record<string, unknown>
    for (const [key, v] of Object.entries((body.settings ?? {}) as Record<string, unknown>)) {
      if (JSON.stringify(t.settings[key as K]) === JSON.stringify(v)) continue
      next[key] = validateSetting(key as K, v)
      changed.push(SETTING_RULES[key as K].label)
    }
    const s = next as unknown as E.TenantSettings
    if (s['calendar.max_hours_per_day'] < s['calendar.min_hours_per_day']) err(422, 'VALIDATION', 'Maximum hours must be at least the minimum hours.', 'calendar.max_hours_per_day')
    if (s['calendar.saturday_rule'] === 'some_off' && s['calendar.saturday_off_weeks'].length === 0) err(422, 'VALIDATION', 'Pick which Saturdays are off, or choose "All Saturdays on".', 'calendar.saturday_off_weeks')
    const tb = (body.tenant ?? {}) as Partial<Pick<E.Tenant, 'name' | 'time_zone' | 'industry'>>
    const tenantPatch: Partial<E.Tenant> = {}
    if (tb.name !== undefined && tb.name !== t.name) {
      if (String(tb.name).trim().length < 2) err(422, 'VALIDATION', 'Enter the company name.', 'name')
      tenantPatch.name = String(tb.name).trim().slice(0, 80)
      changed.push('Company name')
    }
    if (tb.time_zone !== undefined && tb.time_zone !== t.time_zone) {
      if (!TIME_ZONES.includes(tb.time_zone)) err(422, 'VALIDATION', 'Choose a supported time zone.', 'time_zone')
      tenantPatch.time_zone = tb.time_zone
      changed.push('Time zone')
    }
    if (tb.industry !== undefined && tb.industry !== t.industry) {
      if (!['it_services', 'sap_consulting', 'product', 'other'].includes(tb.industry)) err(422, 'VALIDATION', 'Choose an industry.', 'industry')
      tenantPatch.industry = tb.industry
      changed.push('Industry')
    }
    if (!changed.length) return { pending: false, result: t, result_id: t.id }
    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(tenantPatch)) {
      before[k] = (t as unknown as Record<string, unknown>)[k]
      after[k] = v
    }
    for (const k of Object.keys(next)) if (JSON.stringify(t.settings[k as K]) !== JSON.stringify(next[k])) {
      before[SETTING_RULES[k as K]?.label ?? k] = t.settings[k as K]
      after[SETTING_RULES[k as K]?.label ?? k] = next[k]
    }
    return propose(ctx, {
      entity: 'settings', entity_id: t.id, action: 'update', summary: `Company settings: ${changed.join(', ')}`,
      before, after, payload: { settings: s, tenant: tenantPatch, changed }, required_permission: 'settings.edit', base_version: t.version,
    })
  })

  /* ---- holidays (UI-07) ---- */
  r.get('/holidays', ({ ctx, query }) => {
    const year = String(query.year ?? todayISO().slice(0, 4))
    const cal = calendarFor(ctx)
    const list = rows(ctx, 'holidays').filter((h) => h.date.startsWith(year)).sort((a, b) => a.date.localeCompare(b.date))
    const months = Array.from({ length: 12 }, (_, i) => {
      const ym = `${year}-${String(i + 1).padStart(2, '0')}`
      return { month: ym, working_days: workingDaysInMonth(ym, cal) }
    })
    const years = [...new Set(rows(ctx, 'holidays').map((h) => h.date.slice(0, 4)))]
    return { year: Number(year), holidays: list, months, years }
  })

  const holidayInput = (ctx: Ctx, body: Record<string, unknown>, exceptId?: string) => {
    const date = String(body.date ?? '')
    const name = String(body.name ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseISO(date).getTime())) err(422, 'VALIDATION', 'Choose a date.', 'date')
    if (name.length < 2) err(422, 'VALIDATION', 'Enter the holiday name.', 'name')
    if (name.length > 60) err(422, 'VALIDATION', 'Keep the name under 60 characters.', 'name')
    const dup = rows(ctx, 'holidays').find((h) => h.date === date && h.id !== exceptId)
    if (dup) err(409, 'HOLIDAY_EXISTS', `${dup.name} is already on that date.`, 'date')
    return { date, name, optional: !!body.optional }
  }

  r.post('/holidays', ({ ctx, body }) => {
    requireAction(ctx, 'holidays.edit', 'Only admins can change holidays.')
    const v = holidayInput(ctx, body)
    const out = insert(ctx, 'holidays', v as never)
    const locked = lockedMonths(ctx)
    if (locked.has(monthOf(v.date))) warn(ctx, 'PAYROLL_FINAL', `Payroll for ${monthOf(v.date)} is already final; this holiday will not change it.`)
    logActivity(ctx, 'holiday', out.id, 'create', `Added holiday ${v.name} on ${v.date}`)
    return out
  })
  r.patch('/holidays/:id', ({ ctx, params, body, ifMatch }) => {
    requireAction(ctx, 'holidays.edit', 'Only admins can change holidays.')
    const h = find(ctx, 'holidays', params.id, 'Holiday')
    const v = holidayInput(ctx, { date: body.date ?? h.date, name: body.name ?? h.name, optional: body.optional ?? h.optional }, h.id)
    const out = update(ctx, 'holidays', h.id, v, ifMatch)
    logActivity(ctx, 'holiday', h.id, 'update', `Updated holiday ${v.name}`)
    return out
  })
  r.del('/holidays/:id', ({ ctx, params }) => {
    requireAction(ctx, 'holidays.edit', 'Only admins can change holidays.')
    const h = find(ctx, 'holidays', params.id, 'Holiday')
    remove(ctx, 'holidays', h.id)
    logActivity(ctx, 'holiday', h.id, 'delete', `Deleted holiday ${h.name}`)
    return { ok: true }
  })
  r.post('/holidays/import', ({ ctx, body }) => {
    requireAction(ctx, 'holidays.edit', 'Only admins can import holidays.')
    const input = (body.rows ?? []) as { date?: string; name?: string; optional?: string | boolean }[]
    if (!input.length) err(422, 'VALIDATION', 'Paste at least one row: date,name[,optional].')
    const existing = new Map(rows(ctx, 'holidays').map((h) => [h.date, h.name]))
    const seen = new Set<string>()
    const out = input.map((row, i) => {
      const errors: string[] = []
      let date = String(row.date ?? '').trim()
      const dm = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(date)
      if (dm) date = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`
      const name = String(row.name ?? '').trim()
      const optRaw = String(row.optional ?? '').trim().toLowerCase()
      const optional = row.optional === true || ['yes', 'y', 'true', '1', 'optional'].includes(optRaw)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parseISO(date).getTime()) || parseISO(date).getDate() !== Number(date.slice(8, 10))) errors.push('Date must be YYYY-MM-DD or DD/MM/YYYY')
      if (name.length < 2) errors.push('Name is missing')
      if (existing.has(date)) errors.push(`Already a holiday: ${existing.get(date)}`)
      if (seen.has(date)) errors.push('Date appears twice in this file')
      seen.add(date)
      return { line: i + 1, date, name, optional, errors }
    })
    const bad = out.filter((x) => x.errors.length).length
    if (body.mode !== 'commit') return { rows: out, valid: out.length - bad, invalid: bad, committed: false }
    if (bad) err(422, 'VALIDATION', `${bad} row${bad === 1 ? ' has' : 's have'} errors. Fix them and import again — nothing was added.`)
    for (const x of out) insert(ctx, 'holidays', { date: x.date, name: x.name, optional: x.optional } as never)
    logActivity(ctx, 'holiday', 'import', 'create', `Imported ${out.length} holidays`)
    return { rows: out, valid: out.length, invalid: 0, committed: true }
  })

  /* ---- cost rates (UI-17) ---- */
  r.get('/cost-rates', ({ ctx }) => {
    if (!canSeeSalaries(ctx)) err(403, 'FORBIDDEN', 'Cost rates need the salaries grant. Ask an admin.')
    const today = todayISO()
    const ym = monthOf(today)
    const cal = calendarFor(ctx)
    const wd = workingDaysInMonth(ym, cal)
    const minH = ctx.tenant.settings['calendar.min_hours_per_day']
    const locked = lockedMonths(ctx)
    const all = rows(ctx, 'cost_rates')
    const people = rows(ctx, 'users')
      .filter((u) => u.status !== 'invited')
      .map((u) => {
        const hist = all.filter((x) => x.user_id === u.id).sort((a, b) => b.effective_from.localeCompare(a.effective_from))
        const cur = rateOn(hist, today)
        const next = hist.find((x) => x.effective_from > today) ?? null
        const cph = cur && wd > 0 ? Math.round(cur.monthly_ctc_paise / (wd * minH)) : null
        return {
          user_id: u.id,
          status: u.status,
          current: cur,
          upcoming: next,
          cost_per_hour_paise: cph,
          variable_paise: cur ? Math.round((cur.monthly_ctc_paise * cur.variable_pct) / 100) : null,
          history: hist.map((h) => ({ ...h, locked: [...locked].some((m) => h.effective_from <= monthRange(m).to), cost_per_hour_paise: wd > 0 ? Math.round(h.monthly_ctc_paise / (wd * minH)) : null })),
          // v4: a salary change waiting for a checker (maker-checker entity `cost_rate`, keyed by person)
          pending_change: pendingBrief(ctx, 'cost_rate', u.id),
        }
      })
    const lastFinal = [...locked].sort().pop() ?? null
    return {
      month: ym, working_days: wd, min_hours: minH, locked_through: lastFinal ? monthRange(lastFinal).to : null, can_edit: has(ctx, 'cost_rates.edit'), people,
      total_ctc_paise: people.reduce((s, p) => s + (p.status === 'active' ? p.current?.monthly_ctc_paise ?? 0 : 0), 0),
    }
  })

  // Salary changes are maker-checked (entity `cost_rate`, one pending change per person).
  r.post('/cost-rates', ({ ctx, body }) => {
    requireAction(ctx, 'cost_rates.edit', 'Only admins can change cost rates.')
    const v = validateRate(ctx, body)
    const hist = rows(ctx, 'cost_rates').filter((x) => x.user_id === v.user.id).sort((a, b) => b.effective_from.localeCompare(a.effective_from))
    const cur = rateOn(hist, todayISO())
    const show = (r: { monthly_ctc_paise: number; variable_pct: number; sales_target_paise: number | null; effective_from: string } | null) =>
      r ? { 'Monthly CTC': fmtMoney(r.monthly_ctc_paise), 'Variable pay': `${r.variable_pct}%`, ...(v.user.role === 'sales' ? { 'Sales target': fmtMoney(r.sales_target_paise) } : {}), 'Effective from': r.effective_from } : null
    const delta = cur ? ` (${v.ctc >= cur.monthly_ctc_paise ? '+' : ''}${(((v.ctc - cur.monthly_ctc_paise) / cur.monthly_ctc_paise) * 100).toFixed(1)}%)` : ''
    return propose<E.CostRate>(ctx, {
      entity: 'cost_rate', entity_id: v.user.id, action: 'create', required_permission: 'cost_rates.edit', base_version: hist.length,
      summary: `New rate for ${v.user.name}: ${fmtMoney(v.ctc)}/month from ${v.eff}${delta}`,
      before: show(cur), after: show({ monthly_ctc_paise: v.ctc, variable_pct: v.vp, sales_target_paise: v.target, effective_from: v.eff }),
      payload: { op: 'add', user_id: v.user.id, monthly_ctc_paise: v.ctc, variable_pct: v.vp, sales_target_paise: v.target, effective_from: v.eff },
    })
  })

  r.del('/cost-rates/:id', ({ ctx, params }) => {
    requireAction(ctx, 'cost_rates.edit', 'Only admins can change cost rates.')
    const cr = find(ctx, 'cost_rates', params.id, 'Rate')
    if (cr.effective_from <= todayISO()) err(409, 'RATE_PERIOD_LOCKED', 'Only future rates can be removed. Add a new row instead.')
    const u = find(ctx, 'users', cr.user_id, 'Person')
    return propose<{ ok: true }>(ctx, {
      entity: 'cost_rate', entity_id: u.id, action: 'delete', required_permission: 'cost_rates.edit', base_version: rows(ctx, 'cost_rates').filter((x) => x.user_id === u.id).length,
      summary: `Remove ${u.name}’s future rate of ${fmtMoney(cr.monthly_ctc_paise)} from ${cr.effective_from}`,
      before: { 'Monthly CTC': fmtMoney(cr.monthly_ctc_paise), 'Variable pay': `${cr.variable_pct}%`, 'Effective from': cr.effective_from }, after: null,
      payload: { op: 'remove', rate_id: cr.id, user_id: u.id },
    })
  })
  registerAfterRates(r)
}

/** Validation shared by the proposal and the applier (rules are re-checked at approval time). */
function validateRate(ctx: Ctx, body: Record<string, unknown>, quiet = false) {
    const u = find(ctx, 'users', String(body.user_id ?? ''), 'Person')
    const ctc = Number(body.monthly_ctc_paise)
    const vp = Number(body.variable_pct ?? 0)
    const eff = String(body.effective_from ?? '')
    if (!Number.isInteger(ctc) || ctc <= 0) err(422, 'MONEY_INVALID', 'Enter a monthly CTC above zero.', 'monthly_ctc_paise')
    if (ctc > 1e10) err(422, 'MONEY_INVALID', 'That CTC looks too large. Enter the monthly amount in rupees.', 'monthly_ctc_paise')
    if (!Number.isFinite(vp) || vp < 0 || vp > 50) err(422, 'VALIDATION', 'Variable pay must be between 0% and 50%.', 'variable_pct')
    if (!isRealISODate(eff)) err(422, 'VALIDATION', 'Choose the effective-from date.', 'effective_from')
    const locked = lockedMonths(ctx)
    if (locked.has(monthOf(eff))) err(409, 'RATE_PERIOD_LOCKED', `Payroll for ${monthOf(eff)} is final. Choose a date after ${monthRange([...locked].sort().pop()!).to}.`, 'effective_from')
    const lastLocked = [...locked].sort().pop()
    if (lastLocked && eff <= monthRange(lastLocked).to) err(409, 'RATE_PERIOD_LOCKED', `Rates before ${monthRange(lastLocked).to} are locked by a final payroll run.`, 'effective_from')
    const hist = rows(ctx, 'cost_rates').filter((x) => x.user_id === u.id)
    if (hist.some((x) => x.effective_from === eff)) err(409, 'RATE_EXISTS', 'A rate already starts on that date. Rates are never edited — pick a new date.', 'effective_from')
    const latest = hist.map((x) => x.effective_from).sort().pop()
    if (latest && eff < latest) err(409, 'RATE_PERIOD_LOCKED', `History is append-only. The latest rate starts ${latest}; choose a later date.`, 'effective_from')
    let target: number | null = null
    if (u.role === 'sales') {
      if (body.sales_target_paise === null || body.sales_target_paise === undefined || body.sales_target_paise === '') target = ctx.tenant.settings['pay.target_default'] === 'ctc' ? ctc : null
      else {
        target = Number(body.sales_target_paise)
        if (!Number.isInteger(target) || target < 0) err(422, 'MONEY_INVALID', 'Enter a valid sales target.', 'sales_target_paise')
      }
    }
    if (eff < todayISO() && !quiet) warn(ctx, 'RATE_BACKDATED', 'Backdated rate: project costs from that date will be recomputed with it.')
    return { user: u, ctc, vp, eff, target }
}

registerApplier('cost_rate', (ctx, cs) => {
  const p = cs.payload as { op: 'add' | 'remove'; user_id: string; rate_id?: string; monthly_ctc_paise?: number; variable_pct?: number; sales_target_paise?: number | null; effective_from?: string }
  assertBaseVersion(cs, rows(ctx, 'cost_rates').filter((x) => x.user_id === p.user_id).length)
  const by = cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''
  if (p.op === 'remove') {
    const cr = find(ctx, 'cost_rates', p.rate_id!, 'Rate')
    if (cr.effective_from <= todayISO()) err(409, 'RATE_PERIOD_LOCKED', 'That rate has already started, so it can no longer be removed.')
    remove(ctx, 'cost_rates', cr.id)
    logActivity(ctx, 'cost_rate', cr.id, 'delete', `Removed ${userName(ctx, p.user_id)}’s future rate from ${cr.effective_from}${by}`)
    return { result: { ok: true }, result_id: cr.id }
  }
  const v = validateRate(ctx, p as unknown as Record<string, unknown>, true)
  const out = insert(ctx, 'cost_rates', { user_id: v.user.id, monthly_ctc_paise: v.ctc, variable_pct: v.vp, sales_target_paise: v.target, effective_from: v.eff } as never)
  logActivity(ctx, 'cost_rate', out.id, 'create', `New rate for ${v.user.name} from ${v.eff}: ${fmtMoney(v.ctc)}/month${by}`)
  return { result: out, result_id: out.id }
})

function registerAfterRates(r: Router) {

  /* ---- data export (UI-26) ---- */
  r.get('/exports', ({ ctx }) => {
    requireAction(ctx, 'data.export', 'Only admins can export workspace data.')
    const now = nowISO()
    return rows(ctx, 'data_exports')
      .map((x) => (x.status === 'ready' && x.expires_at && x.expires_at < now ? { ...x, status: 'expired' as const } : x))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
  })
  r.post('/exports', ({ ctx }) => {
    requireAction(ctx, 'data.export', 'Only admins can export workspace data.')
    const recent = rows(ctx, 'data_exports').filter((x) => Date.now() - new Date(x.created_at).getTime() < 60_000)
    if (recent.length >= 3) err(429, 'RATE_LIMITED', 'You just requested several exports. Wait a minute and try again.')
    const dump = tenantDump(ctx)
    const size = JSON.stringify(dump).length
    const ready = nowISO()
    const out = insert(ctx, 'data_exports', { requested_by: ctx.user.id, status: 'ready', ready_at: ready, expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(), size_bytes: size } as never)
    notify(ctx, ctx.user.id, 'NTF-17', 'Your data export is ready', `Download it within 24 hours (${Math.max(1, Math.round(size / 1024))} KB).`, '/settings/data')
    logActivity(ctx, 'data_export', out.id, 'create', 'Requested a full data export')
    return out
  })
  r.get('/exports/:id/download', ({ ctx, params }) => {
    requireAction(ctx, 'data.export', 'Only admins can export workspace data.')
    const x = find(ctx, 'data_exports', params.id, 'Export')
    if (x.status !== 'ready' || (x.expires_at && x.expires_at < nowISO())) err(410, 'EXPORT_EXPIRED', 'This export link has expired. Request a new export.')
    logActivity(ctx, 'data_export', x.id, 'download', 'Downloaded a data export')
    return { generated_at: x.ready_at, ...tenantDump(ctx) }
  })

  /* ---- onboarding (UI-25) ---- */
  r.get('/onboarding', ({ ctx }) => {
    requireAction(ctx, 'settings.edit')
    const users = rows(ctx, 'users')
    const steps = [
      { key: 'settings', title: 'Set company rules', body: 'Working days, hours, approval SLA and pay rules.', to: '/settings/company', done: settingsTouched(ctx) },
      { key: 'holidays', title: 'Add this year’s holidays', body: 'Holidays drive working days, SLA and payroll.', to: '/settings/holidays', done: rows(ctx, 'holidays').length > 0 },
      { key: 'people', title: 'Invite your team', body: 'Set roles and who approves whose timesheet.', to: '/people', done: users.length > 1 || rows(ctx, 'invites').length > 0 },
      { key: 'project', title: 'Create your first project', body: 'Milestones, tasks and estimates tie hours to money.', to: '/projects', done: rows(ctx, 'projects').length > 0 },
      { key: 'timesheet', title: 'Submit a first timesheet week', body: 'Log hours against a task and submit for approval.', to: '/timesheet', done: rows(ctx, 'timesheet_weeks').some((w) => w.status !== 'open' && w.status !== 'locked') },
    ]
    const dismissed = rows(ctx, 'activity_log').some((a) => a.entity === 'onboarding' && a.action === 'dismiss')
    return {
      steps, done: steps.filter((s) => s.done).length, total: steps.length, complete: steps.every((s) => s.done), dismissed,
      can_load_sample: rows(ctx, 'projects').length === 0 && users.length <= 1,
      tenant_age_days: Math.max(0, Math.round((Date.now() - new Date(tenantOf(ctx).created_at).getTime()) / 86400000)),
    }
  })
  r.post('/onboarding/dismiss', ({ ctx }) => {
    requireAction(ctx, 'settings.edit')
    logActivity(ctx, 'onboarding', ctx.tenant.id, 'dismiss', 'Dismissed the getting-started checklist')
    return { ok: true }
  })
  r.post('/onboarding/restore', ({ ctx }) => {
    requireAction(ctx, 'settings.edit')
    const d = getDb()
    d.activity_log = d.activity_log.filter((a) => !(a.tenant_id === ctx.tenant.id && a.entity === 'onboarding' && a.action === 'dismiss'))
    persist()
    return { ok: true }
  })
  r.post('/onboarding/sample', ({ ctx }) => {
    requireAction(ctx, 'settings.edit', 'Only admins can load sample data.')
    if (rows(ctx, 'projects').length > 0 || rows(ctx, 'users').length > 1) err(409, 'SAMPLE_NOT_EMPTY', 'Sample data can only be loaded into an empty workspace.')
    loadSample(ctx)
    logActivity(ctx, 'onboarding', ctx.tenant.id, 'sample', 'Loaded sample data')
    return { ok: true }
  })
}

/* ------------------------------------------------------------------ */
/* Sample data for a brand-new tenant (stays inside that tenant)        */
/* ------------------------------------------------------------------ */
function loadSample(ctx: Ctx) {
  const today = todayISO()
  const y = today.slice(0, 4)
  const t = tenantOf(ctx)
  const dom = t.slug.replace(/[^a-z0-9]/g, '') + '.example'
  const me = ctx.user
  const mk = (name: string, title: string, role: E.Role, reports: string | null, hue: number, ctcRupees: number, dept: E.User['department']) => {
    const u = insert(ctx, 'users', {
      email: `${name.split(' ')[0].toLowerCase()}@${dom}`, name, title, role, reports_to_id: reports, grants: [], status: 'active', last_login_at: null, avatar_hue: hue,
      phone: null, joined_on: addDays(today, -30), department: dept, two_factor: false, prefs: {},
    } as never) as E.User
    insert(ctx, 'cost_rates', { user_id: u.id, monthly_ctc_paise: ctcRupees * 100, variable_pct: role === 'sales' ? 20 : 0, sales_target_paise: role === 'sales' ? ctcRupees * 100 : null, effective_from: addDays(today, -30) } as never)
    return u
  }
  if (!rows(ctx, 'cost_rates').some((c) => c.user_id === me.id)) insert(ctx, 'cost_rates', { user_id: me.id, monthly_ctc_paise: 150000_00, variable_pct: 0, sales_target_paise: null, effective_from: addDays(today, -30) } as never)
  const pm = mk('Aarav Mishra (sample)', 'Project Manager', 'pm', me.id, 210, 85000, 'delivery')
  const dev1 = mk('Diya Sahoo (sample)', 'React Developer', 'employee', pm.id, 18, 45000, 'delivery')
  const dev2 = mk('Kabir Das (sample)', 'Python Developer', 'employee', pm.id, 265, 50000, 'delivery')
  mk('Isha Patra (sample)', 'Business Development', 'sales', me.id, 330, 40000, 'sales')

  if (!rows(ctx, 'holidays').length)
    for (const [d, n, o] of [
      [`${y}-01-26`, 'Republic Day', false], [`${y}-03-14`, 'Holi', false], [`${y}-08-15`, 'Independence Day', false], [`${y}-10-02`, 'Gandhi Jayanti', false], [`${y}-10-20`, 'Diwali', false], [`${y}-12-25`, 'Christmas', true],
    ] as [string, string, boolean][])
      insert(ctx, 'holidays', { date: d, name: n, optional: o } as never)

  const prefix = t.settings['projects.code_prefix']
  const no = nextNumber(ctx, 'project', 1)
  const p = insert(ctx, 'projects', {
    code: `${prefix}-${String(no).padStart(3, '0')}`, name: 'Customer portal (sample)', client: 'Sample Client Pvt Ltd', type: 'service', status: 'active', pm_id: pm.id,
    start_on: addDays(today, -14), end_on: addDays(today, 60), contract_value_paise: 6_00_000_00, billing_model: 'fixed', stream: 'services', description: 'A sample project to explore milestones, tasks and margins. Delete it any time.',
    priority: 2, deal_id: null, baseline_end_on: addDays(today, 60), color_hue: 200,
  } as never) as E.Project
  insert(ctx, 'project_status_history', { project_id: p.id, from_status: null, to_status: 'active', reason: null, changed_by: me.id, changed_at: nowISO() } as never)
  const ms = [
    { no: 1, name: 'Discovery & design', s: -14, e: 10, amt: 1_50_000_00 },
    { no: 2, name: 'Build & integrate', s: 11, e: 45, amt: 3_00_000_00 },
    { no: 3, name: 'UAT & go-live', s: 46, e: 60, amt: 1_50_000_00 },
  ].map((m) =>
    insert(ctx, 'milestones', { project_id: p.id, no: m.no, name: m.name, planned_start: addDays(today, m.s), planned_end: addDays(today, m.e), baseline_end: addDays(today, m.e), billing_amount_paise: m.amt, billing_status: 'none', achieved_on: null, empty_since: null, deleted_at: null } as never) as E.Milestone,
  )
  const tasks: [number, string, E.User, number, number, number, E.TaskStatus][] = [
    [0, 'Requirement workshops', pm, 16, -14, -8, 'done'],
    [0, 'Wireframes and clickable prototype', dev1, 32, -7, 6, 'in_progress'],
    [0, 'API contract', dev2, 12, -3, 8, 'todo'],
    [1, 'Login and profile screens', dev1, 24, 11, 22, 'todo'],
    [1, 'Orders API', dev2, 40, 11, 30, 'todo'],
    [2, 'UAT support', pm, 20, 46, 58, 'todo'],
  ]
  const counters = [0, 0, 0]
  for (const [mi, title, owner, est, s, e, status] of tasks) {
    counters[mi]++
    insert(ctx, 'tasks', { project_id: p.id, milestone_id: ms[mi].id, no: counters[mi], title, owner_id: owner.id, backup_id: null, est_hours: est, start_on: addDays(today, s), due_on: addDays(today, e), done_on: status === 'done' ? addDays(today, e) : null, complexity: 'medium', status, description: '', blocked_reason: null } as never)
  }
  for (const u of [pm, dev1, dev2]) insert(ctx, 'allocations', { project_id: p.id, milestone_id: ms[0].id, user_id: u.id, pct: u.id === pm.id ? 40 : 80, from_on: addDays(today, -14), to_on: addDays(today, 10) } as never)
  void uid
  void (null as unknown as DB)
}

registerApplier('settings', (ctx, cs) => {
  const t = tenantOf(ctx)
  assertBaseVersion(cs, t.version)
  const s = cs.payload.settings as E.TenantSettings
  Object.assign(t, cs.payload.tenant as Partial<E.Tenant>, { settings: s })
  t.version++
  persist()
  if (s['security.require_2fa_admins']) {
    const without = rows(ctx, 'users').filter((u) => u.status === 'active' && !u.two_factor && !u.is_super_admin && (() => { const p = permissionsOf(u); return p.includes('roles.manage') || p.includes('users.manage') })())
    if (without.length) warn(ctx, 'TWO_FACTOR_PENDING', `${without.map((u) => u.name).join(', ')} must set up two-step verification at next sign-in.`)
  }
  logActivity(ctx, 'tenant_settings', t.id, 'update', `Changed ${(cs.payload.changed as string[]).join(', ')}${cs.id !== 'cs_direct' ? ` (proposed by ${userName(ctx, cs.maker_id)})` : ''}`)
  return { result: t, result_id: t.id }
})

