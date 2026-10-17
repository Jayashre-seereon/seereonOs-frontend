// Shared building blocks for the People & HR screens.
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Badge, Segmented } from '@/ui'
import type { Tone } from '@/domain/labels'
import type { AppraisalStatus, Asset, CandidateStage } from '@/types/business'
import { fmtPct } from '@/domain/money'

export const APPRAISAL_STATUS: Record<AppraisalStatus, { label: string; tone: Tone }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  self_pending: { label: 'Self review', tone: 'info' },
  manager_pending: { label: 'Manager review', tone: 'warning' },
  hr_pending: { label: 'HR review', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
}
export const CYCLE_STATUS: Record<string, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  goal_setting: { label: 'Goal setting', tone: 'info' },
  self_review: { label: 'Self reviews', tone: 'info' },
  manager_review: { label: 'Manager reviews', tone: 'warning' },
  hr_review: { label: 'HR calibration', tone: 'accent' },
  closed: { label: 'Closed', tone: 'success' },
}
export const LEAVE_REQ_STATUS: Record<'pending' | 'approved' | 'rejected' | 'cancelled', { label: string; tone: Tone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
export const STAGES: CandidateStage[] = ['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']
export const CANDIDATE_STAGE: Record<CandidateStage, { label: string; tone: Tone }> = {
  applied: { label: 'Applied', tone: 'neutral' },
  screening: { label: 'Screening', tone: 'info' },
  interview: { label: 'Interview', tone: 'warning' },
  offer: { label: 'Offer', tone: 'accent' },
  hired: { label: 'Hired', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
}
export const SOURCE: Record<string, string> = { referral: 'Referral', job_portal: 'Job portal', linkedin: 'LinkedIn', campus: 'Campus', agency: 'Agency', website: 'Website', other: 'Other' }
export const ASSET_STATUS: Record<Asset['status'], { label: string; tone: Tone }> = {
  in_stock: { label: 'In stock', tone: 'info' },
  assigned: { label: 'Assigned', tone: 'success' },
  repair: { label: 'In repair', tone: 'warning' },
  retired: { label: 'Retired', tone: 'neutral' },
  lost: { label: 'Lost', tone: 'danger' },
}
export const ASSET_CATEGORY: Record<Asset['category'], string> = { laptop: 'Laptop', monitor: 'Monitor', phone: 'Phone', licence: 'Licence', furniture: 'Furniture', other: 'Other' }
export const OWNER_ROLE: Record<string, string> = { admin: 'Admin', pm: 'PM', ops: 'HR', employee: 'Employee', manager: 'Manager', it: 'IT', finance: 'Finance' }
export const FEEDBACK_KIND: Record<string, { label: string; tone: Tone }> = { praise: { label: 'Praise', tone: 'success' }, improvement: { label: 'To improve', tone: 'warning' }, one_on_one: { label: '1:1 note', tone: 'info' } }
export const VISIBILITY: Record<string, string> = { public: 'Visible to them and their managers', manager: 'Managers and HR only', private: 'Only you and them' }

export function ratingTone(v: number | null | undefined): Tone {
  if (v === null || v === undefined) return 'neutral'
  return v >= 4 ? 'success' : v >= 3 ? 'info' : v >= 2 ? 'warning' : 'danger'
}
export function Rating({ value, size = 'md', suffix = true }: { value: number | null | undefined; size?: 'sm' | 'md'; suffix?: boolean }) {
  if (value === null || value === undefined) return <span className="text-ink-3">—</span>
  return (
    <Badge tone={ratingTone(value)} size={size}>
      <span className="tnum">{Number.isInteger(value) ? value : value.toFixed(1)}{suffix ? ' / 5' : ''}</span>
    </Badge>
  )
}
export const RATING_LABEL: Record<number, string> = { 1: 'Below expectations', 2: 'Partly meets', 3: 'Meets expectations', 4: 'Exceeds', 5: 'Outstanding' }
export function RatingInput({ value, onChange, step = 1 }: { value: number | null; onChange: (v: number) => void; step?: 1 | 0.5 }) {
  const opts = step === 1 ? [1, 2, 3, 4, 5] : [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
  return (
    <div className="min-w-0">
      {step === 1 ? (
        <Segmented block value={value === null ? '' : String(value)} onChange={(v) => onChange(Number(v))} options={opts.map((n) => ({ value: String(n), label: <span className="tnum">{n}</span> }))} />
      ) : (
        <div role="radiogroup" className="grid grid-cols-5 gap-1 rounded-md bg-surface-2 p-[3px] sm:grid-cols-9">
          {opts.map((n) => (
            <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)} className={cn('tnum h-8 rounded-[calc(var(--r-md)-2px)] text-[13px] font-medium', value === n ? 'bg-surface text-ink ring-1 ring-line-strong' : 'text-ink-2 hover:text-ink')}>
              {n}
            </button>
          ))}
        </div>
      )}
      <div className="mt-1 text-[12px] text-ink-3">{value ? RATING_LABEL[Math.round(value)] : 'Pick 1 (below expectations) to 5 (outstanding)'}</div>
    </div>
  )
}

export function Timeliness({ t, variance }: { t: 'early' | 'on_time' | 'late' | null; variance: number | null }) {
  if (!t) return <span className="text-[12.5px] text-ink-3">Open</span>
  const map = { early: { l: 'Early', tone: 'success' as Tone }, on_time: { l: 'On time', tone: 'success' as Tone }, late: { l: 'Late', tone: 'danger' as Tone } }
  return (
    <Badge size="sm" tone={map[t].tone}>
      {map[t].l}
      {variance ? <span className="tnum"> · {variance > 0 ? '+' : '−'}{Math.abs(variance)}d</span> : null}
    </Badge>
  )
}

/** Compact metric row used in metric panels: label left, value right. */
export function MetricRow({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  const t = tone ? { neutral: 'text-ink', info: 'text-info-text', success: 'text-success-text', warning: 'text-warning-text', danger: 'text-danger-text', brand: 'text-brand-text', accent: 'text-accent-text' }[tone] : 'text-ink'
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[13px] text-ink-2">{label}</div>
        {hint && <div className="text-[12px] text-ink-3">{hint}</div>}
      </div>
      <div className={cn('tnum shrink-0 whitespace-nowrap text-[13.5px] font-semibold', t)}>{value}</div>
    </div>
  )
}
export const pct = (v: number | null | undefined, d = 0) => fmtPct(v, d)
export function pctTone(v: number | null | undefined, good = 0.85, ok = 0.7): Tone | undefined {
  if (v === null || v === undefined) return undefined
  return v >= good ? 'success' : v >= ok ? 'warning' : 'danger'
}
export function days(n: number | null | undefined) {
  if (n === null || n === undefined) return '—'
  const v = Math.round(n * 10) / 10
  return `${v > 0 ? '+' : ''}${v}d`
}
export function fmtDays(n: number) {
  return `${n} day${n === 1 ? '' : 's'}`
}
