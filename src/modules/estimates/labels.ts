import type { Tone } from '@/domain/labels'
import type { EstimateStatus } from '@/api/estimates'

export const ESTIMATE_STATUS: Record<EstimateStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  shared: { label: 'Shared', tone: 'info' },
  won: { label: 'Won', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
  converted: { label: 'Converted', tone: 'brand' },
}
export const ESTIMATE_STATUS_ORDER: EstimateStatus[] = ['draft', 'shared', 'won', 'lost', 'converted']

/** Margin colour against the tenant floor (status colour only). */
export function marginTone(m: number | null | undefined, floorPct: number): Tone {
  if (m === null || m === undefined) return 'neutral'
  if (m < floorPct / 100) return 'danger'
  if (m < floorPct / 100 + 0.1) return 'warning'
  return 'success'
}
