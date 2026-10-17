import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ImageUp, RotateCcw, Trash2 } from '@/ui/icons'
import { coreApi } from '@/api/core'
import { useMut } from '@/api/query'
import { announce, isPending } from '@/api/changes'
import type { ApiError } from '@/api/http'
import { adminApi, useHolidays, useSettings, type SettingRule } from '@/api/admin'
import { fmtDate, todayISO } from '@/domain/calendar'
import { useSession } from '@/stores/session'
import { DEFAULT_SETTINGS } from '@/mock/seed'
import type { Industry, Tenant, TenantSettings } from '@/types/entities'
import { Badge, Button, ErrorState, Input, MoneyInput, PageHeader, Segmented, Select, SkeletonRows, Switch, TenantMark, toast, useConfirm, useReadOnly } from '@/ui'
import { cn, readFileAsDataURL } from '@/lib/utils'
import { SaveBar, SettingRow, SettingsCard } from './kit'

type S = TenantSettings
type TenantDraft = { name: string; time_zone: string; industry: Industry }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri']
const ORD = ['1st', '2nd', '3rd', '4th', '5th']
const SECTIONS = [
  ['company', 'Company'],
  ['calendar', 'Working hours & calendar'],
  ['holidays', 'Holiday calendar'],
  ['timesheets', 'Timesheets & approvals'],
  ['pay', 'Pay'],
  ['finance', 'Finance'],
  ['projects', 'Projects & allocation'],
  ['sales', 'Sales & daily updates'],
  ['notify', 'Notifications'],
  ['security', 'Security'],
  ['ai', 'AI'],
] as const

export default function CompanySettingsPage() {
  const q = useSettings()
  if (q.isLoading)
    return (
      <div>
        <PageHeader title="Company & rules" />
        <SkeletonRows rows={8} />
      </div>
    )
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return <Editor key={q.data.tenant.version} tenant={q.data.tenant} zones={q.data.time_zones} rules={q.data.rules ?? {}} stats={q.data.calendar_stats} />
}

function Editor({ tenant, zones, rules, stats }: { tenant: Tenant; zones: string[]; rules: Record<string, SettingRule>; stats?: { fy_label: string; avg_working_days: number } }) {
  const { setTenant } = useSession()
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const loc = useLocation()
  const initS = tenant.settings
  const initT: TenantDraft = { name: tenant.name, time_zone: tenant.time_zone, industry: tenant.industry }
  const [s, setS] = useState<S>(initS)
  const [t, setT] = useState<TenantDraft>(initT)
  const [err, setErr] = useState<ApiError | null>(null)
  const resetDraft = () => {
    setS(initS)
    setT(initT)
  }

  useEffect(() => {
    if (loc.hash) setTimeout(() => document.getElementById(loc.hash.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }, [loc.hash])

  const changedKeys = useMemo(() => (Object.keys(s) as (keyof S)[]).filter((k) => JSON.stringify(s[k]) !== JSON.stringify(initS[k])), [s, initS])
  const tChanged = (Object.keys(t) as (keyof TenantDraft)[]).filter((k) => t[k] !== initT[k])
  const dirty = changedKeys.length + tChanged.length > 0
  const set = <K extends keyof S>(k: K, v: S[K]) => {
    setS((p) => ({ ...p, [k]: v }))
    if (err?.field === k) setErr(null)
  }

  const save = useMut(
    () =>
      adminApi.saveSettings(
        { settings: Object.fromEntries(changedKeys.map((k) => [k, s[k]])) as Partial<S>, tenant: Object.fromEntries(tChanged.map((k) => [k, t[k]])) as Partial<TenantDraft> },
        tenant.version,
      ),
    {
      invalidate: [['settings'], ['me'], ['tenant'], ['holidays'], ['cost-rates'], ['onboarding']],
      onSuccess: (r) => {
        announce(r, 'Settings saved')
        if (!isPending(r)) setTenant(r.result)
        else resetDraft()
        setErr(null)
      },
      onError: (e) => {
        setErr(e)
        if (e.field) document.querySelector(`[data-k="${e.field}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      },
    },
  )

  const fe = (k: string) => (err?.field === k ? err.message : null)
  const dis = readOnly

  const num = (k: keyof S, min: number, max: number, step = 1, suffix?: string) => (
    <Input
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      disabled={dis}
      value={String(s[k])}
      suffix={suffix}
      invalid={!!fe(k)}
      className="sm:w-[160px]"
      onChange={(e) => set(k, (e.target.value === '' ? '' : Number(e.target.value)) as never)}
    />
  )
  const sw = (k: keyof S) => <Switch checked={!!s[k]} disabled={dis} onChange={(v) => set(k, v as never)} />
  const row = (k: keyof S | string, label: ReactNode, help: ReactNode, control: ReactNode, stack?: boolean) => (
    <div data-k={k} key={String(k)}>
      <SettingRow label={label} help={help} error={fe(String(k))} stack={stack}>
        {control}
      </SettingRow>
    </div>
  )
  // Feature Guide §16 / G16.06: every setting shows its default and the allowed range
  const def = (k: keyof S, fmt: (v: never) => string = (v) => String(v)) => {
    const r = rules[k as string]
    const unit = (n: number) => fmt(n as never)
    const range = r?.kind === 'num' && r.min !== undefined && r.max !== undefined ? ` Allowed ${unit(r.min)} to ${unit(r.max)}${r.step ? ` in steps of ${r.step}` : ''}.` : r?.kind === 'bool' ? ' On or off.' : r?.kind === 'time' ? ' Any time of day.' : ''
    return (
      <span className="text-ink-3/90">
        {' '}
        Default {fmt(DEFAULT_SETTINGS[k] as never)}.{range}
      </span>
    )
  }

  return (
    <div className="pb-28">
      <PageHeader
        title="Company & rules"
        subtitle="These rules drive timesheets, approvals, payroll, costing and alerts for everyone."
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw className="size-3.5" />}
            disabled={dis}
            onClick={async () => {
              if (await confirm({ title: 'Restore default rules?', body: 'All rule values on this page go back to SeereonOS defaults. Company name, logo and time zone stay. Nothing is saved until you press Save.', confirmLabel: 'Restore defaults' })) setS({ ...DEFAULT_SETTINGS, 'finance.opening_cash_paise': s['finance.opening_cash_paise'], 'finance.monthly_overheads_paise': s['finance.monthly_overheads_paise'] })
            }}
          >
            Defaults
          </Button>
        }
      />

      <nav className="-mx-4 mb-6 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:flex-wrap md:px-0" aria-label="Sections">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} className="inline-flex h-8 shrink-0 items-center rounded-md border border-line bg-surface px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
            {label}
          </a>
        ))}
      </nav>

      <SettingsCard id="company" title="Company">
        {row('name', 'Company name', 'Shown in the sidebar, invitations and invoices.', <Input value={t.name} disabled={dis} invalid={!!fe('name')} onChange={(e) => setT({ ...t, name: e.target.value })} />)}
        <LogoRow tenant={tenant} disabled={dis} />
        {row('industry', 'Industry', 'Tunes sample data and report templates.', <Select value={t.industry} disabled={dis} onChange={(e) => setT({ ...t, industry: e.target.value as Industry })} options={[{ value: 'it_services', label: 'IT services' }, { value: 'sap_consulting', label: 'SAP consulting' }, { value: 'product', label: 'Software product' }, { value: 'other', label: 'Other' }]} />)}
        {row('time_zone', 'Time zone', 'Weekly locks (Monday 00:00), reminders and SLA clocks use this zone. Default Asia/Kolkata.', <Select value={t.time_zone} disabled={dis} onChange={(e) => setT({ ...t, time_zone: e.target.value })} options={zones} />)}
        {row('company.fy_start_month', 'Financial year starts', <>Quarters, FY totals and the CEO dashboard follow this.{def('company.fy_start_month', (v: number) => MONTHS[v - 1])}</>, <Select value={String(s['company.fy_start_month'])} disabled={dis} onChange={(e) => set('company.fy_start_month', Number(e.target.value))} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />)}
        {row('company.currency', 'Currency', 'All money is in Indian rupees. Fixed for this workspace.', <div className="text-[14px] text-ink-2 sm:text-right">INR (₹)</div>)}
      </SettingsCard>

      <SettingsCard id="calendar" title="Working hours and calendar" subtitle="The company rules everything else calculates from. A working day is not a weekly off, not a holiday and not the person’s approved leave.">
        {row('calendar.min_hours_per_day', 'Minimum working hours per day', <>The timesheet target for every working day; also the divisor for cost per hour.{def('calendar.min_hours_per_day', (v: number) => `${v}h`)}</>, num('calendar.min_hours_per_day', 1, 12, 0.5, 'h'))}
        {row('calendar.breaks_count', 'Breaks count toward the minimum', <>When on, “Lunch, tea and stand-up” hours count toward the daily minimum.{def('calendar.breaks_count', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('calendar.breaks_count'))}
        {row(
          'calendar.weekly_off',
          'Weekly off days',
          <>Sunday to Friday. Saturdays use the rule below. Up to three days.{def('calendar.weekly_off', () => 'Sunday')}</>,
          <div className="flex flex-wrap gap-1 sm:justify-end">
            {DAYS.map((d, i) => {
              const on = s['calendar.weekly_off'].includes(i)
              return (
                <button key={d} type="button" disabled={dis} aria-pressed={on} onClick={() => set('calendar.weekly_off', on ? s['calendar.weekly_off'].filter((x) => x !== i) : [...s['calendar.weekly_off'], i].sort())} className={cn('h-9 min-w-[40px] rounded-md border px-1.5 text-[13px] font-medium transition disabled:opacity-60', on ? 'border-brand bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2 hover:text-ink')}>
                  {d}
                </button>
              )
            })}
          </div>,
          false,
        )}
        {row(
          'calendar.saturday_rule',
          'Saturdays',
          <>Common in India: 2nd and 4th Saturdays off.{def('calendar.saturday_rule', () => 'selected Saturdays are off (2nd and 4th)')}</>,
          <Select
            value={s['calendar.saturday_rule']}
            disabled={dis}
            onChange={(e) => set('calendar.saturday_rule', e.target.value as S['calendar.saturday_rule'])}
            options={[
              { value: 'all_on', label: 'All Saturdays are working days' },
              { value: 'some_off', label: 'Selected Saturdays are off' },
              { value: 'all_off', label: 'All Saturdays are off' },
            ]}
          />,
        )}
        {s['calendar.saturday_rule'] === 'some_off' &&
          row(
            'calendar.saturday_off_weeks',
            'Saturdays off',
            <>Counted within each month.{def('calendar.saturday_off_weeks', () => '2nd and 4th')}</>,
            <div className="flex flex-wrap gap-1 sm:justify-end">
              {ORD.map((o, i) => {
                const n = i + 1
                const on = s['calendar.saturday_off_weeks'].includes(n)
                return (
                  <button key={o} type="button" disabled={dis} aria-pressed={on} onClick={() => set('calendar.saturday_off_weeks', on ? s['calendar.saturday_off_weeks'].filter((x) => x !== n) : [...s['calendar.saturday_off_weeks'], n].sort())} className={cn('h-9 min-w-[40px] rounded-md border px-1.5 text-[13px] font-medium transition disabled:opacity-60', on ? 'border-brand bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2 hover:text-ink')}>
                    {o}
                  </button>
                )
              })}
            </div>,
          )}
        {row('approval.sla_working_days', 'Manager approval deadline (working days after submission)', <>Timesheets lock when their week ends. Each missed deadline counts as a lapse on the manager’s Approvals KPI (part of their weekly score).{def('approval.sla_working_days', (v: number) => `${v} day${v === 1 ? '' : 's'}`)}</>, num('approval.sla_working_days', 1, 10, 1, 'days'))}
        {row('calendar.max_hours_per_day', 'Maximum hours per day', <>Entries above this are blocked.{def('calendar.max_hours_per_day', (v: number) => `${v}h`)}</>, num('calendar.max_hours_per_day', 8, 24, 0.5, 'h'))}
        {row('team.default_productive_hours', 'Default productive hours a day', <>Hours of task work planning and forecasts assume for someone with no value of their own in the team table.{def('team.default_productive_hours', (v: number) => `${v}h`)}</>, num('team.default_productive_hours', 1, 12, 1, 'h'))}
        <div className="space-y-1.5 px-4 py-3.5 md:px-5">
          {stats && (
            <p className="text-[13px] text-ink-2">
              <span className="tnum font-semibold text-ink">{stats.avg_working_days}</span> working days a month on average this financial year ({stats.fy_label}), after holidays.
            </p>
          )}
          <p className="text-[12.5px] leading-snug text-ink-3">The minimum is the timesheet target for every working day. Productive hours/day in the team table is separate: it is how many hours of task work planning and forecasts assume.</p>
        </div>
      </SettingsCard>

      <HolidayCalendar />

      <SettingsCard id="timesheets" title="Timesheets & approvals">
        {row('timesheet.hours_step', 'Hours step', <>Smallest unit people can log.{def('timesheet.hours_step', (v: number) => `${v} h`)}</>, <Segmented size="sm" value={String(s['timesheet.hours_step']) as '0.25' | '0.5' | '1'} onChange={(v) => set('timesheet.hours_step', Number(v) as S['timesheet.hours_step'])} options={[{ value: '0.25', label: '15 min' }, { value: '0.5', label: '30 min' }, { value: '1', label: '1 hour' }]} />)}
        {row('timesheet.allow_future_entries', 'Allow future entries', <>Log time for days that haven’t happened yet (leave is always allowed).{def('timesheet.allow_future_entries', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('timesheet.allow_future_entries'))}
        {row('timesheet.internal_note_required', 'Note required on internal time', <>Meetings, learning and admin hours need a short note.{def('timesheet.internal_note_required', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('timesheet.internal_note_required'))}
        {row('timesheet.weekly_lock', 'Lock unsubmitted weeks', <>A week that isn’t submitted locks Monday 00:00. The approver can unlock it.{def('timesheet.weekly_lock', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('timesheet.weekly_lock'))}
        {row('timesheet.unlock_max_days', 'Longest unlock window', <>How long an unlocked week stays editable.{def('timesheet.unlock_max_days')}</>, num('timesheet.unlock_max_days', 1, 14, 1, 'days'))}
        {row('approval.bulk_approve', 'Bulk approve', <>Let approvers approve several weeks at once.{def('approval.bulk_approve', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('approval.bulk_approve'))}
      </SettingsCard>

      <SettingsCard id="pay" title="Pay">
        {row('pay.deduct_unapproved_days', 'Deduct unapproved days', <>Payroll pays only for approved days. Deduction = monthly base ÷ working days in the month × (unapproved days + leave-without-pay days).{def('pay.deduct_unapproved_days', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('pay.deduct_unapproved_days'))}
        {row('pay.variable_default_pct', 'Default variable pay (sales)', <>Share of CTC at stake for new sales people.{def('pay.variable_default_pct', (v: number) => `${v}%`)}</>, num('pay.variable_default_pct', 0, 50, 1, '%'))}
        {row('pay.target_default', 'Default monthly sales target', <>“Equal to CTC” sets target = monthly CTC automatically.{def('pay.target_default', () => 'equal to CTC')}</>, <Segmented size="sm" value={s['pay.target_default']} onChange={(v) => set('pay.target_default', v)} options={[{ value: 'ctc', label: 'Equal to CTC' }, { value: 'manual', label: 'Set manually' }]} />)}
        {row('pay.variable_threshold_pct', 'Variable pay threshold', <>Variable is paid in full only when achievement reaches this.{def('pay.variable_threshold_pct', (v: number) => `${v}%`)}</>, num('pay.variable_threshold_pct', 80, 120, 1, '%'))}
      </SettingsCard>

      <SettingsCard id="finance" title="Finance">
        {row('finance.opening_cash_paise', 'Cash in bank', <>Starting balance for the cash-runway figure on the P&L and CEO dashboard.<span className="text-ink-3/90"> Default ₹15,00,000. Any amount of ₹0 or more.</span></>, <MoneyInput className="sm:w-[200px]" disabled={dis} value={s['finance.opening_cash_paise']} invalid={!!fe('finance.opening_cash_paise')} onChange={(v) => set('finance.opening_cash_paise', v)} />)}
        {row('finance.monthly_overheads_paise', 'Monthly overheads', <>Fixed costs not entered in the ledger (used when estimating burn).<span className="text-ink-3/90"> Default ₹1,50,000. Any amount of ₹0 or more.</span></>, <MoneyInput className="sm:w-[200px]" disabled={dis} value={s['finance.monthly_overheads_paise']} invalid={!!fe('finance.monthly_overheads_paise')} onChange={(v) => set('finance.monthly_overheads_paise', v)} />)}
      </SettingsCard>

      <SettingsCard id="projects" title="Projects & allocation">
        {row('projects.code_prefix', 'Project code prefix', <>New projects get codes like {s['projects.code_prefix'] || 'PRJ'}-014. 2–6 letters or digits, starting with a letter.{def('projects.code_prefix')}</>, <Input value={s['projects.code_prefix']} disabled={dis} maxLength={6} invalid={!!fe('projects.code_prefix')} onChange={(e) => set('projects.code_prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} className="sm:w-[160px]" />)}
        {row('projects.empty_milestone_days', 'Delete empty milestones after', <>Milestones with no tasks are removed after this many days unless invoiced. 0 turns it off.{def('projects.empty_milestone_days')}</>, num('projects.empty_milestone_days', 0, 60, 1, 'days'))}
        {row('projects.margin_floor_pct', 'Margin floor', <>Projects projected below this turn red and count as At risk.{def('projects.margin_floor_pct', (v: number) => `${v}%`)}</>, num('projects.margin_floor_pct', 0, 90, 1, '%'))}
        {row('projects.effort_ratio_alert', 'Effort ratio alert', <>Flag tasks and projects when actual ÷ estimated hours goes above this.{def('projects.effort_ratio_alert', (v: number) => `${v}×`)}</>, num('projects.effort_ratio_alert', 1, 3, 0.05, '×'))}
        {row('allocation.max_pct_per_person', 'Max allocation per person', <>Warn when someone is booked above this across projects on any day.{def('allocation.max_pct_per_person', (v: number) => `${v}%`)}</>, num('allocation.max_pct_per_person', 50, 150, 5, '%'))}
        {row('allocation.block_over', 'Block over-allocation', <>Stop saving an allocation that goes over the max, instead of only warning.{def('allocation.block_over', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('allocation.block_over'))}
      </SettingsCard>

      <SettingsCard id="sales" title="Sales & daily updates">
        {row('sales.stale_deal_days', 'Deal goes stale after', <>Open deals with no activity for this long are flagged to the owner.{def('sales.stale_deal_days')}</>, num('sales.stale_deal_days', 3, 90, 1, 'days'))}
        {row('daily.proof_required', 'Proof link on daily update', <>Require a link (PR, build, document) on every daily update.{def('daily.proof_required', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('daily.proof_required'))}
      </SettingsCard>

      <SettingsCard id="notify" title="Notifications" subtitle={`Times are in ${t.time_zone}.`}>
        {row('notify.friday_nudge_time', 'Friday timesheet nudge', <>Reminds people with an unsubmitted week.{def('notify.friday_nudge_time')}</>, <Input type="time" value={s['notify.friday_nudge_time']} disabled={dis} invalid={!!fe('notify.friday_nudge_time')} onChange={(e) => set('notify.friday_nudge_time', e.target.value)} className="sm:w-[160px]" />)}
        {row('notify.sla_digest_time', 'Overdue approvals digest', <>Daily summary to managers with weeks past the SLA.{def('notify.sla_digest_time')}</>, <Input type="time" value={s['notify.sla_digest_time']} disabled={dis} invalid={!!fe('notify.sla_digest_time')} onChange={(e) => set('notify.sla_digest_time', e.target.value)} className="sm:w-[160px]" />)}
      </SettingsCard>

      <SettingsCard id="security" title="Security">
        {row('security.password_min_length', 'Minimum password length', <>Applies to new and changed passwords.{def('security.password_min_length')}</>, num('security.password_min_length', 8, 64, 1, 'chars'))}
        {row('security.lockout_attempts', 'Failed sign-ins before lockout', <>Then the account locks for the duration below.{def('security.lockout_attempts')}</>, num('security.lockout_attempts', 3, 10))}
        {row('security.lockout_minutes', 'Lockout duration', <>How long a locked account stays locked.{def('security.lockout_minutes', (v: number) => `${v} min`)}</>, num('security.lockout_minutes', 5, 120, 1, 'min'))}
        {row('security.session_idle_minutes', 'Sign out after idle', <>Signs people out after this long without activity.{def('security.session_idle_minutes', (v: number) => `${v} min`)}</>, num('security.session_idle_minutes', 15, 720, 5, 'min'))}
        {row('security.require_2fa_admins', 'Require two-step for admins', <>Admins must use an authenticator app.{def('security.require_2fa_admins', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('security.require_2fa_admins'))}
      </SettingsCard>

      <SettingsCard id="ai" title="AI">
        {row('ai.enabled', 'AI assistant', <>Lets people ask questions in plain English and build reports. Only the data a person can already see is used, and it is never used for training.{def('ai.enabled', (v: boolean) => (v ? 'on' : 'off'))}</>, sw('ai.enabled'))}
      </SettingsCard>

      <SaveBar
        dirty={dirty && !dis}
        saving={save.isPending}
        count={changedKeys.length + tChanged.length}
        label={`${changedKeys.length + tChanged.length} unsaved change${changedKeys.length + tChanged.length === 1 ? '' : 's'}`}
        onDiscard={() => {
          setS(initS)
          setT(initT)
          setErr(null)
        }}
        onSave={() => {
          const bad = (Object.keys(s) as (keyof S)[]).find((k) => typeof DEFAULT_SETTINGS[k] === 'number' && (s[k] as unknown) === '')
          if (bad) {
            setErr({ field: bad, message: 'Enter a value.' } as ApiError)
            toast.error('Check the form', { description: 'A number field is empty.' })
            return
          }
          save.mutate(undefined)
        }}
      />
    </div>
  )
}

/** Feature Guide §16: "The holiday calendar below it lists public holidays for the year." */
function HolidayCalendar() {
  const year = Number(todayISO().slice(0, 4))
  const q = useHolidays(year)
  const today = todayISO()
  const list = q.data?.holidays ?? []
  return (
    <SettingsCard
      id="holidays"
      title={`Holiday calendar ${year}`}
      subtitle="Public holidays for the year. Holidays are not working days for timesheets, approvals and payroll; optional holidays don’t reduce working days."
      action={<Link to="/settings/holidays" className="shrink-0 text-[13px] font-medium text-brand-text hover:underline">Manage holidays</Link>}
    >
      {q.isLoading ? (
        <SkeletonRows rows={3} className="p-4" />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !list.length ? (
        <p className="px-4 py-3.5 text-[13px] text-ink-3 md:px-5">No holidays for {year} yet. Add them in Manage holidays.</p>
      ) : (
        <ul className="grid divide-y divide-line sm:grid-cols-2 sm:divide-y-0">
          {list.map((h) => (
            <li key={h.id} className={cn('flex min-h-[40px] items-center gap-3 px-4 py-2 text-[13.5px] sm:border-b sm:border-line md:px-5', h.date < today && 'text-ink-3')}>
              <span className="tnum w-[92px] shrink-0 whitespace-nowrap">{fmtDate(h.date, 'long').replace(/ \d{4}$/, '')}</span>
              <span className="min-w-0 flex-1 truncate">{h.name}</span>
              {h.optional && <Badge size="sm" tone="neutral">Optional</Badge>}
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}

function LogoRow({ tenant, disabled }: { tenant: Tenant; disabled: boolean }) {
  const { setTenant } = useSession()
  const ref = useRef<HTMLInputElement>(null)
  const m = useMut((d: string | null) => coreApi.saveLogo(d), { invalidate: [['settings'], ['me'], ['onboarding']], success: (t) => (t.logo_data_url ? 'Logo updated' : 'Logo removed'), onSuccess: (t) => setTenant(t) })
  return (
    <SettingRow label="Logo" help="PNG, SVG, JPG or WebP up to 1 MB. A wide logo on a transparent background works best.">
      <div className="flex items-center gap-3 sm:justify-end">
        <div className="grid h-12 min-w-12 place-items-center rounded-lg border border-line bg-surface-2 px-2">
          <TenantMark name={tenant.name} logo={tenant.logo_data_url} size={32} />
        </div>
        <Button size="sm" icon={<ImageUp className="size-3.5" />} disabled={disabled} loading={m.isPending && m.variables !== null} onClick={() => ref.current?.click()}>
          {tenant.logo_data_url ? 'Replace' : 'Upload'}
        </Button>
        {tenant.logo_data_url && (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} disabled={disabled} loading={m.isPending && m.variables === null} onClick={() => m.mutate(null)} aria-label="Remove logo">
            Remove
          </Button>
        )}
        <input
          ref={ref}
          type="file"
          hidden
          accept="image/png,image/svg+xml,image/jpeg,image/webp"
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            if (f.size > 1024 * 1024) return toast.error('Logo is too large', { description: 'Use an image of 1 MB or less.' })
            m.mutate(await readFileAsDataURL(f))
          }}
        />
      </div>
    </SettingRow>
  )
}
