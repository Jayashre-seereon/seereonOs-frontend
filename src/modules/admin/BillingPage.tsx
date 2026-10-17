import { useEffect, useMemo, useState } from 'react'
import { Check, CheckCircle2, CreditCard, Download, Lock, Minus, Plus, Smartphone } from '@/ui/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useMut, useScopeKey } from '@/api/query'
import type { ApiError } from '@/api/http'
import { adminApi, useBilling, type BillingState } from '@/api/admin'
import { useSession } from '@/stores/session'
import { diffDays, fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import type { BillingInvoice, Plan } from '@/types/entities'
import { exportTable } from '@/reports/export'
import { Badge, Button, Callout, Checkbox, Dialog, ErrorState, Field, IconButton, Input, PageHeader, Progress, SectionTitle, Segmented, SkeletonCards, toast } from '@/ui'
import { cn } from '@/lib/utils'
import { errField } from './kit'

export default function BillingPage() {
  const q = useBilling()
  const [checkout, setCheckout] = useState<{ plan: Plan; seats: number } | null>(null)
  const [seatsOpen, setSeatsOpen] = useState(false)
  if (q.isLoading)
    return (
      <div>
        <PageHeader title="Billing" />
        <SkeletonCards n={3} />
      </div>
    )
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const b = q.data
  const paid = b.tenant.status === 'active' && b.subscription.status === 'active'
  return (
    <div className="max-w-[1200px] pb-10">
      <PageHeader title="Billing" subtitle="Plan, seats and invoices. Prices are per person per month, plus 18% GST." />
      <StatusBanner b={b} onChoose={() => document.getElementById('plans')?.scrollIntoView({ behavior: 'smooth' })} />
      <CurrentPlan b={b} onSeats={() => setSeatsOpen(true)} />

      <SectionTitle className="mt-8">
        <span id="plans" className="scroll-mt-24">Plans</span>
      </SectionTitle>
      <PlanTable b={b} onPick={(p) => setCheckout({ plan: p, seats: Math.max(b.seats_used, paid ? b.subscription.seats : Math.max(b.seats_used, 5)) })} />

      <SectionTitle className="mt-8">Invoices</SectionTitle>
      <Invoices list={b.invoices} company={b.tenant.name} gst={b.gst_pct} />

      {checkout && <Checkout b={b} plan={checkout.plan} initialSeats={checkout.seats} onClose={() => setCheckout(null)} />}
      {seatsOpen && <SeatsDialog b={b} onClose={() => setSeatsOpen(false)} />}
    </div>
  )
}

function StatusBanner({ b, onChoose }: { b: BillingState; onChoose: () => void }) {
  const t = b.tenant
  if (t.status === 'read_only')
    return (
      <Callout tone="danger" className="mb-4" title="Your workspace is read-only" action={<Button size="sm" variant="primary" onClick={onChoose}>Choose a plan</Button>}>
        Your trial or last payment has lapsed. Everyone can still sign in and view data; pick a plan to make changes again. No data has been deleted.
      </Callout>
    )
  if (b.subscription.status === 'past_due')
    return (
      <Callout tone="warning" className="mb-4" title="Last payment failed">
        Update your payment method before {fmtDate(b.subscription.current_period_end, 'long')} to keep the workspace active.
      </Callout>
    )
  if (t.status === 'trial' && t.trial_ends_on) {
    const left = diffDays(t.trial_ends_on, todayISO())
    return (
      <Callout tone={left <= 3 ? 'warning' : 'brand'} className="mb-4" action={<Button size="sm" variant="primary" onClick={onChoose}>Upgrade</Button>}>
        Free trial · {left} day{left === 1 ? '' : 's'} left (ends {fmtDate(t.trial_ends_on, 'long')}). All features are unlocked until then.
      </Callout>
    )
  }
  return null
}

function CurrentPlan({ b, onSeats }: { b: BillingState; onSeats: () => void }) {
  const s = b.subscription
  const statusTone = s.status === 'active' ? 'success' : s.status === 'trialing' ? 'brand' : s.status === 'past_due' ? 'warning' : 'neutral'
  const statusLabel = { active: 'Active', trialing: 'Trial', past_due: 'Payment due', cancelled: 'Cancelled' }[s.status]
  const seats = s.status === 'trialing' ? b.plan.max_users ?? 25 : s.seats
  return (
    <div className="grid overflow-hidden rounded-lg border border-line bg-surface sm:grid-cols-3 sm:divide-x sm:divide-line max-sm:divide-y max-sm:divide-line">
      <div className="min-w-0 px-4 py-3.5 md:px-5">
        <div className="text-[12.5px] text-ink-3">Current plan</div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[18px] font-semibold">{b.plan.name}</span>
          <Badge tone={statusTone} size="sm">{statusLabel}</Badge>
        </div>
        <div className="mt-0.5 text-[12.5px] text-ink-3">{b.plan.price_per_user_paise ? `${fmtMoney(b.plan.price_per_user_paise)} per person / month + GST` : 'Free for 14 days'}</div>
      </div>
      <div className="min-w-0 px-4 py-3.5 md:px-5">
        <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
          <span>Seats in use</span>
          {s.status === 'active' && <button type="button" onClick={onSeats} className="font-medium text-brand-text hover:underline">Change</button>}
        </div>
        <div className="tnum mt-1 whitespace-nowrap text-[18px] font-semibold">
          {b.seats_used}
          <span className="text-[14px] font-normal text-ink-3"> of {seats}</span>
        </div>
        <Progress value={b.seats_used / Math.max(1, seats)} tone={b.seats_used >= seats ? 'warning' : 'brand'} className="mt-2" />
      </div>
      <div className="min-w-0 px-4 py-3.5 md:px-5">
        <div className="text-[12.5px] text-ink-3">{s.status === 'trialing' ? 'Trial ends' : 'Renews on'}</div>
        <div className="tnum mt-1 whitespace-nowrap text-[18px] font-semibold">{fmtDate(s.current_period_end, 'long')}</div>
        {b.next_charge && (
          <div className="tnum mt-0.5 text-[12.5px] text-ink-3">
            Next charge <span className="font-medium text-ink">{fmtMoney(b.next_charge.total_paise)}</span> incl. GST
          </div>
        )}
      </div>
    </div>
  )
}

type PlanCell = boolean | string
const PLAN_ROWS: { label: string; v: Record<string, PlanCell> }[] = [
  { label: 'Projects, tasks & timesheets', v: { starter: true, growth: true, scale: true } },
  { label: 'Approvals with SLA', v: { starter: true, growth: true, scale: true } },
  { label: 'Holidays & working calendar', v: { starter: true, growth: true, scale: true } },
  { label: 'CSV exports', v: { starter: true, growth: true, scale: true } },
  { label: 'Margins, cost rates & payroll', v: { starter: false, growth: true, scale: true } },
  { label: 'Sales pipeline & compensation', v: { starter: false, growth: true, scale: true } },
  { label: 'Insights & report builder', v: { starter: false, growth: true, scale: true } },
  { label: 'AI assistant', v: { starter: false, growth: true, scale: true } },
  { label: 'Two-step verification enforcement', v: { starter: false, growth: false, scale: true } },
  { label: 'Scheduled reports', v: { starter: false, growth: false, scale: true } },
  { label: 'Data residency in India', v: { starter: false, growth: false, scale: true } },
  { label: 'Support', v: { starter: 'Email', growth: 'Priority', scale: 'Dedicated manager' } },
]

function planAction(plan: Plan, b: BillingState) {
  const current = b.subscription.plan_code === plan.code && b.subscription.status !== 'trialing' && b.tenant.status === 'active'
  const curPrice = b.plans.find((p) => p.code === b.subscription.plan_code)?.price_per_user_paise ?? 0
  const label = current ? 'Current plan' : b.tenant.status === 'active' && plan.price_per_user_paise < curPrice ? `Switch to ${plan.name}` : `Upgrade to ${plan.name}`
  return { current, label }
}

function Cell({ v }: { v: PlanCell | undefined }) {
  if (typeof v === 'string') return <span className="text-ink-2">{v}</span>
  return v ? <Check className="mx-auto size-4 text-ink" aria-label="Included" /> : <span className="text-ink-3" aria-label="Not included">—</span>
}

/** Plan comparison: a table on tablet/desktop, a stacked list on phones. */
function PlanTable({ b, onPick }: { b: BillingState; onPick: (p: Plan) => void }) {
  const plans = b.plans.filter((p) => p.code !== 'trial')
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-surface md:block">
        <table className="w-full min-w-[640px] table-fixed border-collapse text-[13.5px]">
          <colgroup>
            <col className="w-[34%]" />
            {plans.map((p) => <col key={p.code} />)}
          </colgroup>
          <thead>
            <tr className="border-b border-line align-top">
              <th className="px-4 py-4 text-left text-[12.5px] font-normal text-ink-3">Prices per person per month, plus {b.gst_pct}% GST.</th>
              {plans.map((p) => {
                const a = planAction(p, b)
                return (
                  <th key={p.code} className={cn('border-l border-line px-4 py-4 text-left font-normal', a.current && 'bg-brand-soft/50')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-semibold text-ink">{p.name}</span>
                      {p.code === 'growth' && <Badge size="sm" tone="brand">Recommended</Badge>}
                    </div>
                    <div className="tnum mt-1 whitespace-nowrap text-[20px] font-semibold text-ink">{fmtMoney(p.price_per_user_paise)}</div>
                    <div className="text-[12px] text-ink-3">{p.max_users ? `Up to ${p.max_users} people` : 'Unlimited people'}</div>
                    <Button className="mt-3" size="sm" block variant={a.current ? 'secondary' : p.code === 'growth' ? 'primary' : 'secondary'} disabled={a.current} onClick={() => onPick(p)}>
                      {a.current ? 'Current plan' : `Choose ${p.name}`}
                    </Button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {PLAN_ROWS.map((r) => (
              <tr key={r.label}>
                <td className="px-4 py-2.5 text-ink-2">{r.label}</td>
                {plans.map((p) => (
                  <td key={p.code} className={cn('border-l border-line px-4 py-2.5 text-center', planAction(p, b).current && 'bg-brand-soft/50')}>
                    <Cell v={r.v[p.code]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface md:hidden">
        {plans.map((p) => {
          const a = planAction(p, b)
          return (
            <div key={p.code} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[15px] font-semibold">{p.name}</span>
                    {p.code === 'growth' && <Badge size="sm" tone="brand">Recommended</Badge>}
                    {a.current && <Badge size="sm" tone="success">Current</Badge>}
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-ink-3">{p.max_users ? `Up to ${p.max_users} people` : 'Unlimited people'}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="tnum whitespace-nowrap text-[16px] font-semibold">{fmtMoney(p.price_per_user_paise)}</div>
                  <div className="text-[11.5px] text-ink-3">per person / mo</div>
                </div>
              </div>
              <ul className="mt-2.5 space-y-1 text-[13px] text-ink-2">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                    <span className="min-w-0">{f}</span>
                  </li>
                ))}
              </ul>
              {!a.current && (
                <Button className="mt-3" block variant={p.code === 'growth' ? 'primary' : 'secondary'} onClick={() => onPick(p)}>
                  {a.label}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

function Invoices({ list, company, gst }: { list: BillingInvoice[]; company: string; gst: number }) {
  const download = async (i: BillingInvoice) => {
    const sub = Math.round(i.amount_paise / (1 + gst / 100))
    const r = await exportTable(
      {
        title: `Tax invoice ${i.number}`,
        subtitle: `${company} · period ${i.period} · issued ${fmtDate(i.issued_on, 'long')}`,
        columns: [
          { key: 'item', label: 'Item', type: 'string' },
          { key: 'period', label: 'Period', type: 'string' },
          { key: 'amount', label: 'Amount', type: 'money' },
        ],
        rows: [
          { item: 'SeereonOS subscription', period: i.period, amount: sub },
          { item: `GST @ ${gst}% (IGST)`, period: '', amount: i.amount_paise - sub },
        ],
        totals: { amount: i.amount_paise },
        kpis: [
          { label: 'Status', value: i.status === 'paid' ? 'Paid' : i.status === 'failed' ? 'Payment failed' : 'Due' },
          { label: 'Billed by', value: 'Seereon Consulting & IT Services Pvt. Ltd.' },
        ],
        notes: ['SAC 998314 — IT design and development services.', 'This is a computer-generated invoice.'],
      },
      'pdf',
      `invoice-${i.number}`,
    )
    if (r === 'saved') toast.success(`Invoice ${i.number} downloaded`)
  }
  if (!list.length)
    return (
      <div className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center text-[13.5px] text-ink-3">
        No invoices yet. They appear here after your first payment.
      </div>
    )
  return (
    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
      {list.map((i) => (
        <div key={i.id} className="flex items-center gap-3 px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
              {i.number}
              <Badge size="sm" tone={i.status === 'paid' ? 'success' : i.status === 'failed' ? 'danger' : 'warning'}>{i.status === 'paid' ? 'Paid' : i.status === 'failed' ? 'Failed' : 'Due'}</Badge>
            </div>
            <div className="text-[12.5px] text-ink-3">
              {fmtDate(i.issued_on, 'long')} · {new Date(i.period + '-01').toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
            </div>
          </div>
          <span className="tnum shrink-0 whitespace-nowrap text-[13.5px] font-medium">{fmtMoney(i.amount_paise)}</span>
          <IconButton size="sm" label={`Download ${i.number}`} onClick={() => download(i)}>
            <Download className="size-4" />
          </IconButton>
        </div>
      ))}
    </div>
  )
}

function SeatStepper({ value, onChange, min, max }: { value: number; onChange: (n: number) => void; min: number; max: number | null }) {
  return (
    <div className="flex items-center gap-2">
      <IconButton variant="secondary" label="Fewer seats" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Minus className="size-4" />
      </IconButton>
      <Input type="number" inputMode="numeric" className="tnum w-[90px] text-center text-[16px] font-medium" value={String(value)} min={min} max={max ?? undefined} onChange={(e) => onChange(Math.max(1, Math.floor(Number(e.target.value) || 0)))} />
      <IconButton variant="secondary" label="More seats" disabled={max !== null && value >= max} onClick={() => onChange(value + 1)}>
        <Plus className="size-4" />
      </IconButton>
    </div>
  )
}

function Checkout({ b, plan, initialSeats, onClose }: { b: BillingState; plan: Plan; initialSeats: number; onClose: () => void }) {
  const { setTenant } = useSession()
  const qc = useQueryClient()
  const scope = useScopeKey()
  const [seats, setSeats] = useState(initialSeats)
  const [method, setMethod] = useState<'card' | 'upi'>('card')
  const [card, setCard] = useState({ number: '4111 1111 1111 1111', expiry: '12/29', cvv: '123', name: b.tenant.name })
  const [upi, setUpi] = useState('seereon@okhdfc')
  const [fail, setFail] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const sub = plan.price_per_user_paise * seats
  const gst = Math.round((sub * b.gst_pct) / 100)
  const total = sub + gst
  const pay = useMut(
    () => adminApi.checkout({ plan_code: plan.code, seats, method, card_number: card.number, expiry: card.expiry, cvv: card.cvv, name_on_card: card.name, upi_id: upi, simulate_failure: fail }),
    {
      invalidate: [['billing'], ['me'], ['notifications']],
      onSuccess: (r) => {
        setTenant(r.tenant)
        setDone(r.payment_id)
      },
      silentError: true,
      onError: (e) => {
        if (e.code === 'PAYMENT_FAILED') {
          qc.invalidateQueries({ queryKey: [...scope, 'billing'] })
          qc.invalidateQueries({ queryKey: [...scope, 'notifications'] })
          toast.error('Payment failed', { description: e.message })
        } else toast.error(e.status === 403 ? 'Not allowed' : 'Check the payment details', { description: e.message })
      },
    },
  )
  const e = pay.error as ApiError | null
  useEffect(() => {
    if (seats < b.seats_used) setSeats(b.seats_used)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const tooMany = plan.max_users !== null && seats > plan.max_users

  if (done)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()} size="sm" title="Payment successful" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        <div className="flex flex-col items-center py-4 text-center">
          <CheckCircle2 className="size-8 text-success-text" />
          <div className="tnum mt-3 text-[22px] font-semibold">{fmtMoney(total)}</div>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {plan.name} · {seats} seats. Your workspace is active. Payment ID <span className="font-mono">{done}</span>
          </p>
        </div>
      </Dialog>
    )

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !pay.isPending && onClose()}
      title={`Upgrade to ${plan.name}`}
      description="Secure checkout powered by Razorpay (simulated in this preview)."
      footer={
        <>
          <Button onClick={onClose} disabled={pay.isPending}>Cancel</Button>
          <Button variant="primary" icon={<Lock className="size-4" />} loading={pay.isPending} disabled={tooMany || seats < b.seats_used} onClick={() => pay.mutate(undefined)}>
            Pay {fmtMoney(total)}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {e && !e.field && <Callout tone="danger" title={e.code === 'PAYMENT_FAILED' ? 'Payment failed' : undefined}>{e.message}</Callout>}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line p-3">
          <div>
            <div className="text-[13.5px] font-medium">Seats</div>
            <div className="text-[12px] text-ink-3">You have {b.seats_used} people and pending invites{plan.max_users ? ` · max ${plan.max_users}` : ''}</div>
          </div>
          <SeatStepper value={seats} onChange={setSeats} min={Math.max(1, b.seats_used)} max={plan.max_users} />
        </div>
        {(tooMany || errField(e, 'seats')) && <p className="-mt-3 text-[12.5px] font-medium text-danger-text">{errField(e, 'seats') ?? `${plan.name} supports up to ${plan.max_users} people.`}</p>}

        <dl className="tnum space-y-1.5 rounded-lg bg-surface-2 p-3.5 text-[13.5px]">
          <div className="flex justify-between"><dt className="text-ink-2">{fmtMoney(plan.price_per_user_paise)} × {seats} people × 1 month</dt><dd>{fmtMoney(sub)}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">GST @ {b.gst_pct}%</dt><dd>{fmtMoney(gst)}</dd></div>
          <div className="flex justify-between border-t border-line pt-1.5 text-[15px] font-semibold"><dt>Total today</dt><dd>{fmtMoney(total)}</dd></div>
        </dl>

        <div>
          <Segmented block value={method} onChange={setMethod} options={[{ value: 'card', label: <span className="flex items-center gap-1.5"><CreditCard className="size-4" />Card</span> }, { value: 'upi', label: <span className="flex items-center gap-1.5"><Smartphone className="size-4" />UPI</span> }]} />
          {method === 'card' ? (
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Field label="Card number" htmlFor="cn" className="col-span-2" error={errField(e, 'card_number')}>
                <Input id="cn" inputMode="numeric" autoComplete="cc-number" value={card.number} onChange={(ev) => setCard({ ...card, number: ev.target.value.replace(/[^\d ]/g, '').slice(0, 23) })} invalid={!!errField(e, 'card_number')} />
              </Field>
              <Field label="Expiry (MM/YY)" htmlFor="ce" error={errField(e, 'expiry')}>
                <Input id="ce" inputMode="numeric" autoComplete="cc-exp" value={card.expiry} placeholder="MM/YY" onChange={(ev) => setCard({ ...card, expiry: ev.target.value.slice(0, 5) })} invalid={!!errField(e, 'expiry')} />
              </Field>
              <Field label="CVV" htmlFor="cv" error={errField(e, 'cvv')}>
                <Input id="cv" inputMode="numeric" autoComplete="cc-csc" type="password" value={card.cvv} maxLength={4} onChange={(ev) => setCard({ ...card, cvv: ev.target.value.replace(/\D/g, '') })} invalid={!!errField(e, 'cvv')} />
              </Field>
              <Field label="Name on card" htmlFor="cnm" className="col-span-2">
                <Input id="cnm" autoComplete="cc-name" value={card.name} onChange={(ev) => setCard({ ...card, name: ev.target.value })} />
              </Field>
            </div>
          ) : (
            <div className="mt-4">
              <Field label="UPI ID" htmlFor="upi" hint="You’ll approve the request in your UPI app." error={errField(e, 'upi_id')}>
                <Input id="upi" autoCapitalize="none" value={upi} onChange={(ev) => setUpi(ev.target.value.trim())} placeholder="name@okhdfc" invalid={!!errField(e, 'upi_id')} />
              </Field>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-dashed border-line-strong px-3 py-2.5">
          <Checkbox checked={fail} onChange={setFail} label="Simulate a declined payment" description="Demo only: shows the failure path and sends the payment-failed notification." />
        </div>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-3"><Lock className="size-3.5" /> Card and UPI details go to Razorpay and are never stored by SeereonOS.</p>
      </div>
    </Dialog>
  )
}

function SeatsDialog({ b, onClose }: { b: BillingState; onClose: () => void }) {
  const { setTenant } = useSession()
  const [seats, setSeats] = useState(b.subscription.seats)
  const m = useMut(() => adminApi.seats(seats), {
    invalidate: [['billing'], ['me']],
    success: (r) => (r.invoice ? `Seats updated · charged ${fmtMoney(r.invoice.amount_paise)} pro-rata` : 'Seats updated from next renewal'),
    onSuccess: (r) => {
      setTenant(r.tenant)
      onClose()
    },
  })
  const diff = seats - b.subscription.seats
  const days = Math.max(1, diffDays(b.subscription.current_period_end, todayISO()))
  const pro = useMemo(() => {
    if (diff <= 0) return 0
    const s = Math.round((b.plan.price_per_user_paise * diff * Math.min(30, days)) / 30)
    return s + Math.round((s * b.gst_pct) / 100)
  }, [diff, days, b])
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Change seats"
      description={`${b.plan.name} · ${fmtMoney(b.plan.price_per_user_paise)} per person / month`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={diff === 0 || seats < b.seats_used} onClick={() => m.mutate(undefined)}>
            {diff > 0 ? `Add ${diff} seat${diff === 1 ? '' : 's'}` : diff < 0 ? `Remove ${-diff} seat${diff === -1 ? '' : 's'}` : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-3 py-2">
        <SeatStepper value={seats} onChange={setSeats} min={Math.max(1, b.seats_used)} max={b.plan.max_users} />
        <p className="text-center text-[13px] text-ink-3">
          {seats < b.seats_used
            ? `You have ${b.seats_used} people and invites; deactivate people first.`
            : diff > 0
              ? `Charged ${fmtMoney(pro)} now (incl. GST) for the ${days} days left in this period.`
              : diff < 0
                ? 'Your next invoice will be lower. No refund for the current period.'
                : `${b.seats_used} of ${seats} seats in use.`}
        </p>
      </div>
    </Dialog>
  )
}
