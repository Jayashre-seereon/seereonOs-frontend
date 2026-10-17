// Sales rules shared by the mock server and screens (Feature Guide §11–12).
import type { ActivityType, DealStage } from '@/types/entities'

/**
 * G12.06 — deal value = one-time value + 12 months of recurring value.
 * Use this everywhere a deal's worth is summed: pipeline, weighted pipeline, won/closed,
 * targets and achievement, average deal size, sales variable in payroll.
 */
export function dealValue(d: { value_paise: number; mrr_paise?: number | null }): number {
  return (d.value_paise || 0) + 12 * (d.mrr_paise || 0)
}

/** Stage names as the activity log and funnel say them (the board keeps the short names). */
export const STAGE_LONG: Record<DealStage, string> = {
  lead: 'Lead', qualified: 'Qualified', demo: 'Demo', proposal: 'Proposal', negotiation: 'Negotiation', won: 'Won', lost: 'Lost',
}

/** What a line in the sales activity log is. */
export type SalesLogKind = ActivityType | 'stage' | 'new_lead'
export const SALES_LOG_KIND: Record<SalesLogKind, string> = {
  email: 'Email', whatsapp: 'WhatsApp', call: 'Call', meeting: 'Meeting', demo: 'Demo', proposal: 'Proposal', follow_up: 'Follow-up', stage: 'Stage', new_lead: 'New lead',
}

/** Phone: optional; digits with spaces, +, -, (), between 7 and 15 digits. */
export function validPhone(s: string): boolean {
  const t = s.trim()
  if (!t) return true
  if (!/^[+\d][\d\s\-()]*$/.test(t)) return false
  const n = t.replace(/\D/g, '').length
  return n >= 7 && n <= 15
}
export const validEmail = (s: string) => !s.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())

/** Median of a list (null when empty). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
