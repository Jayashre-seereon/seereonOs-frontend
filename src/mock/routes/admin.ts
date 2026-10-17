// Module A — platform super admin (UI-24). Sees tenants, never tenant business data.
import type * as E from '@/types/entities'
import { addDays, diffDays, todayISO } from '@/domain/calendar'
import { err, getDb, nowISO, persist, uid, type Ctx, type Router } from '../server'
import { PLANS, GST_PCT } from './billing'

function tenantRow(t: E.Tenant) {
  const d = getDb()
  const users = d.users.filter((u) => u.tenant_id === t.id)
  const sub = d.subscriptions.find((s) => s.tenant_id === t.id) ?? null
  const plan = PLANS.find((p) => p.code === t.plan_code)
  const mrr = t.status === 'active' && plan ? plan.price_per_user_paise * t.seats : 0
  const lastLogin = users.map((u) => u.last_login_at).filter(Boolean).sort().pop() ?? null
  return {
    id: t.id, name: t.name, slug: t.slug, status: t.status, industry: t.industry, plan_code: t.plan_code, plan_name: plan?.name ?? t.plan_code, seats: t.seats,
    users_active: users.filter((u) => u.status === 'active').length, users_total: users.length, created_at: t.created_at, trial_ends_on: t.trial_ends_on,
    trial_days_left: t.trial_ends_on ? diffDays(t.trial_ends_on, todayISO()) : null, subscription_status: sub?.status ?? null, period_end: sub?.current_period_end ?? null,
    mrr_paise: mrr, last_activity_at: lastLogin,
  }
}

function audit(ctx: Ctx, tenantId: string, action: string, reason: string) {
  getDb().admin_audit.push({ id: 'aud_' + uid(), actor_id: ctx.user.id, tenant_id: tenantId, action, reason, at: nowISO() })
  persist()
}
function tenantById(id: string) {
  const t = getDb().tenants.find((x) => x.id === id)
  if (!t) err(404, 'NOT_FOUND', 'Tenant not found.')
  return t
}
function reasonOf(body: { reason?: string }) {
  const r = String(body.reason ?? '').trim()
  if (r.length < 5) err(422, 'VALIDATION', 'Give a reason of at least 5 characters. It goes into the audit log.', 'reason')
  return r
}

export function register(r: Router) {
  const SA = { superAdmin: true }
  r.get(
    '/admin/tenants',
    () => {
      const list = getDb().tenants.map(tenantRow).sort((a, b) => b.created_at.localeCompare(a.created_at))
      const by = (s: E.TenantStatus) => list.filter((t) => t.status === s).length
      return {
        tenants: list,
        kpis: {
          total: list.length, trial: by('trial'), active: by('active'), read_only: by('read_only'), suspended: by('suspended'),
          mrr_paise: list.reduce((s, t) => s + t.mrr_paise, 0), gst_pct: GST_PCT,
          seats_paid: list.filter((t) => t.status === 'active').reduce((s, t) => s + t.seats, 0),
          trials_ending_7d: list.filter((t) => t.status === 'trial' && t.trial_days_left !== null && t.trial_days_left <= 7).length,
        },
      }
    },
    SA,
  )

  r.post(
    '/admin/tenants/:id/extend',
    ({ ctx, params, body }) => {
      const t = tenantById(params.id)
      const days = Number(body.days)
      if (!Number.isInteger(days) || days < 1 || days > 30) err(422, 'VALIDATION', 'Extend by 1 to 30 days.', 'days')
      const reason = reasonOf(body)
      if (t.status === 'active') err(409, 'TENANT_ACTIVE', 'This tenant is on a paid plan; there is no trial to extend.')
      if (t.status === 'suspended') err(409, 'TENANT_SUSPENDED', 'Reactivate the tenant before extending its trial.')
      const baseDate = t.trial_ends_on && t.trial_ends_on > todayISO() ? t.trial_ends_on : todayISO()
      t.trial_ends_on = addDays(baseDate, days)
      t.status = 'trial'
      t.version++
      const sub = getDb().subscriptions.find((s) => s.tenant_id === t.id)
      if (sub) Object.assign(sub, { status: 'trialing', current_period_end: t.trial_ends_on })
      audit(ctx, t.id, `extend_trial:+${days}d`, reason)
      return tenantRow(t)
    },
    SA,
  )
  r.post(
    '/admin/tenants/:id/suspend',
    ({ ctx, params, body }) => {
      const t = tenantById(params.id)
      if (t.status === 'suspended') err(409, 'TENANT_SUSPENDED', 'This tenant is already suspended.')
      const reason = reasonOf(body)
      t.status = 'suspended'
      t.version++
      const d = getDb()
      const ids = new Set(d.users.filter((u) => u.tenant_id === t.id).map((u) => u.id))
      d.sessions = d.sessions.filter((s) => !ids.has(s.user_id))
      audit(ctx, t.id, 'suspend', reason)
      return tenantRow(t)
    },
    SA,
  )
  r.post(
    '/admin/tenants/:id/reactivate',
    ({ ctx, params, body }) => {
      const t = tenantById(params.id)
      if (t.status !== 'suspended' && t.status !== 'read_only') err(409, 'TENANT_ACTIVE', 'Only suspended or read-only tenants can be reactivated.')
      const reason = reasonOf(body)
      const sub = getDb().subscriptions.find((s) => s.tenant_id === t.id)
      const paid = t.plan_code !== 'trial' && sub?.status === 'active' && sub.current_period_end >= todayISO()
      if (paid) t.status = 'active'
      else {
        t.status = 'trial'
        if (!t.trial_ends_on || t.trial_ends_on < todayISO()) t.trial_ends_on = addDays(todayISO(), 7)
        if (sub) Object.assign(sub, { status: 'trialing', current_period_end: t.trial_ends_on })
      }
      t.version++
      audit(ctx, t.id, 'reactivate', reason)
      return tenantRow(t)
    },
    SA,
  )
  r.get(
    '/admin/audit',
    () => {
      const d = getDb()
      return d.admin_audit
        .map((a) => ({ ...a, tenant_name: d.tenants.find((t) => t.id === a.tenant_id)?.name ?? a.tenant_id, actor_name: d.users.find((u) => u.id === a.actor_id)?.name ?? 'Platform' }))
        .sort((a, b) => b.at.localeCompare(a.at))
    },
    SA,
  )
}
