// Module A — billing (UI-23). Razorpay is simulated: checkout creates a billing invoice and
// activates the subscription. A read-only tenant may call these (router allows /billing).
import type * as E from '@/types/entities'
import { addDays, addMonths, monthOf, todayISO } from '@/domain/calendar'
import { err, find, getDb, insert, logActivity, notify, nowISO, persist, requireAction, rows, update, usersWith, type Ctx, type Router } from '../server'
import { tenantOf } from './auth'

export const GST_PCT = 18
export const PLANS: E.Plan[] = [
  { code: 'trial', name: 'Trial', price_per_user_paise: 0, billing_period: 'monthly', max_users: 25, features: ['All features for 14 days', 'Up to 25 people', 'Sample data', 'Email support'] },
  { code: 'starter', name: 'Starter', price_per_user_paise: 399_00, billing_period: 'monthly', max_users: 25, features: ['Projects, tasks & timesheets', 'Approvals with SLA', 'Holidays & working calendar', 'CSV exports', 'Email support'] },
  { code: 'growth', name: 'Growth', price_per_user_paise: 499_00, billing_period: 'monthly', max_users: 100, features: ['Everything in Starter', 'Margins, cost rates & payroll', 'Sales pipeline & compensation', 'Insights & report builder', 'AI assistant', 'Priority support'] },
  { code: 'scale', name: 'Scale', price_per_user_paise: 699_00, billing_period: 'monthly', max_users: null, features: ['Everything in Growth', 'Unlimited people', 'Two-step verification enforcement', 'Scheduled reports', 'Dedicated success manager', 'Data residency in India'] },
]
const plan = (code: string) => PLANS.find((p) => p.code === code)

function subOf(ctx: Ctx) {
  let s = rows(ctx, 'subscriptions')[0]
  if (!s) s = insert(ctx, 'subscriptions', { plan_code: 'trial', status: 'trialing', current_period_end: addDays(todayISO(), 14), seats: 5, razorpay_subscription_id: null } as never) as E.Subscription
  return s
}
function quote(p: E.Plan, seats: number) {
  const subtotal = p.price_per_user_paise * seats
  const gst = Math.round((subtotal * GST_PCT) / 100)
  return { plan_code: p.code, seats, unit_paise: p.price_per_user_paise, subtotal_paise: subtotal, gst_paise: gst, total_paise: subtotal + gst }
}
function seatsUsed(ctx: Ctx) {
  return rows(ctx, 'users').filter((u) => u.status === 'active').length + rows(ctx, 'invites').filter((i) => !i.accepted_at && i.expires_at > nowISO()).length
}

export function register(r: Router) {
  r.get('/billing', ({ ctx }) => {
    requireAction(ctx, 'billing.manage', 'Only admins can see billing.')
    const t = tenantOf(ctx)
    const s = subOf(ctx)
    const p = plan(s.plan_code) ?? PLANS[0]
    return {
      tenant: { id: t.id, name: t.name, status: t.status, trial_ends_on: t.trial_ends_on, plan_code: t.plan_code, seats: t.seats },
      subscription: s,
      plan: p,
      plans: PLANS,
      gst_pct: GST_PCT,
      seats_used: seatsUsed(ctx),
      next_charge: s.status === 'trialing' ? null : quote(p, s.seats),
      invoices: rows(ctx, 'billing_invoices').sort((a, b) => b.issued_on.localeCompare(a.issued_on)),
    }
  })

  r.post('/billing/quote', ({ ctx, body }) => {
    requireAction(ctx, 'billing.manage')
    const p = plan(body.plan_code)
    if (!p || p.code === 'trial') err(422, 'VALIDATION', 'Choose a paid plan.', 'plan_code')
    return quote(p, Math.max(1, Number(body.seats) || 1))
  })

  r.post('/billing/checkout', ({ ctx, body }) => {
    requireAction(ctx, 'billing.manage', 'Only admins can change the plan.')
    const p = plan(body.plan_code)
    if (!p || p.code === 'trial') err(422, 'VALIDATION', 'Choose a paid plan.', 'plan_code')
    const seats = Number(body.seats)
    const used = seatsUsed(ctx)
    if (!Number.isInteger(seats) || seats < 1) err(422, 'VALIDATION', 'Enter the number of seats.', 'seats')
    if (seats < used) err(409, 'SEATS_BELOW_USAGE', `You have ${used} people and pending invites. Buy at least ${used} seats, or deactivate people first.`, 'seats')
    if (p.max_users && seats > p.max_users) err(409, 'PLAN_LIMIT', `${p.name} supports up to ${p.max_users} people. Choose a bigger plan.`, 'seats')
    const method = body.method === 'upi' ? 'upi' : 'card'
    if (method === 'upi' && !/^[\w.-]+@[a-z]{2,}$/i.test(String(body.upi_id ?? ''))) err(422, 'VALIDATION', 'Enter a UPI ID like name@okhdfc.', 'upi_id')
    if (method === 'card') {
      const num = String(body.card_number ?? '').replace(/\s/g, '')
      if (!/^\d{12,19}$/.test(num)) err(422, 'VALIDATION', 'Enter a valid card number.', 'card_number')
      if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(String(body.expiry ?? ''))) err(422, 'VALIDATION', 'Expiry must be MM/YY.', 'expiry')
      if (!/^\d{3,4}$/.test(String(body.cvv ?? ''))) err(422, 'VALIDATION', 'Enter the CVV.', 'cvv')
    }
    const q = quote(p, seats)
    const t = tenantOf(ctx)
    const s = subOf(ctx)
    const d = getDb()
    const seqNo = d.billing_invoices.length + 101
    if (body.simulate_failure) {
      const inv = insert(ctx, 'billing_invoices', { number: `SOS-${todayISO().slice(0, 4)}-${seqNo}`, period: monthOf(todayISO()), amount_paise: q.total_paise, status: 'failed', issued_on: todayISO() } as never)
      update(ctx, 'subscriptions', s.id, { status: s.status === 'trialing' ? 'trialing' : 'past_due' })
      for (const a of usersWith(ctx, 'billing.manage'))
        notify(ctx, a.id, 'NTF-16', 'Payment failed', `We couldn’t charge ${method === 'upi' ? 'your UPI ID' : 'your card'} for ${p.name}. Update the payment method to keep the workspace active.`, '/billing')
      logActivity(ctx, 'billing', inv.id, 'payment_failed', `Payment failed for ${p.name} × ${seats}`)
      persist()
      err(402, 'PAYMENT_FAILED', 'The bank declined this payment. Try another card or UPI ID. Nothing was charged.')
    }
    const base = s.current_period_end > todayISO() && s.status === 'active' ? s.current_period_end : todayISO()
    const end = addMonths(base, 1)
    const inv = insert(ctx, 'billing_invoices', { number: `SOS-${todayISO().slice(0, 4)}-${seqNo}`, period: monthOf(todayISO()), amount_paise: q.total_paise, status: 'paid', issued_on: todayISO() } as never)
    update(ctx, 'subscriptions', s.id, { plan_code: p.code, status: 'active', seats, current_period_end: end, razorpay_subscription_id: s.razorpay_subscription_id ?? 'sub_' + Math.random().toString(36).slice(2, 12) })
    Object.assign(t, { status: 'active', plan_code: p.code, seats, trial_ends_on: null })
    t.version++
    persist()
    logActivity(ctx, 'billing', inv.id, 'checkout', `Paid ${p.name} × ${seats} seats`)
    return { invoice: inv, tenant: t, payment_id: 'pay_' + Math.random().toString(36).slice(2, 14), method }
  })

  r.post('/billing/seats', ({ ctx, body }) => {
    requireAction(ctx, 'billing.manage', 'Only admins can change seats.')
    const t = tenantOf(ctx)
    const s = subOf(ctx)
    if (s.status === 'trialing' || t.status !== 'active') err(409, 'PLAN_REQUIRED', 'Choose a paid plan first; seats are set during checkout.')
    const seats = Number(body.seats)
    const used = seatsUsed(ctx)
    const p = plan(s.plan_code)!
    if (!Number.isInteger(seats) || seats < 1) err(422, 'VALIDATION', 'Enter the number of seats.', 'seats')
    if (seats < used) err(409, 'SEATS_BELOW_USAGE', `You have ${used} people and pending invites. Keep at least ${used} seats.`, 'seats')
    if (p.max_users && seats > p.max_users) err(409, 'PLAN_LIMIT', `${p.name} supports up to ${p.max_users} people. Upgrade the plan.`, 'seats')
    const added = seats - s.seats
    let invoice: E.BillingInvoice | null = null
    if (added > 0) {
      // prorated for the rest of the period
      const daysLeft = Math.max(1, Math.round((new Date(s.current_period_end).getTime() - Date.now()) / 86400000))
      const sub = Math.round((p.price_per_user_paise * added * Math.min(30, daysLeft)) / 30)
      invoice = insert(ctx, 'billing_invoices', { number: `SOS-${todayISO().slice(0, 4)}-${getDb().billing_invoices.length + 101}`, period: monthOf(todayISO()), amount_paise: sub + Math.round((sub * GST_PCT) / 100), status: 'paid', issued_on: todayISO() } as never) as E.BillingInvoice
    }
    const before = s.seats // update() changes s in place: read the old value first (the log said "45 → 45")
    update(ctx, 'subscriptions', s.id, { seats })
    t.seats = seats
    t.version++
    persist()
    logActivity(ctx, 'billing', s.id, 'seats', `Seats changed ${before} → ${seats}`)
    return { tenant: t, invoice }
  })

  r.get('/billing/invoices/:id', ({ ctx, params }) => {
    requireAction(ctx, 'billing.manage')
    return find(ctx, 'billing_invoices', params.id, 'Invoice')
  })
}
