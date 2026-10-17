// Maker-checker client contract (shared by every guarded write).
import { toast } from 'sonner'
import { http } from './http'
import { useApi } from './query'
import type { ChangeSet, MakerCheckerConfig, ChangeEntity } from '@/types/access'
import type { CheckerRow, PendingBrief } from '@/mock/makerChecker'

export type { CheckerRow, PendingBrief }

export interface ChangeView extends ChangeSet {
  entity_label: string
  maker_name: string
  maker_hue: number
  maker_title: string
  checker_name: string | null
  required_permission_label: string
  can_check: boolean
  can_withdraw: boolean
  overdue: boolean
  age_days: number
}
/** What a guarded write returns: applied now, or waiting for a checker. */
export type Proposed<R> = { pending: true; change: ChangeView } | { pending: false; result: R; result_id: string | null }

export const isPending = <R,>(r: Proposed<R>): r is { pending: true; change: ChangeView } => !!r && (r as { pending?: boolean }).pending === true
/** Toast helper for guarded writes: "Saved" when applied, "Sent for approval" when pending. */
export function announce<R>(r: Proposed<R>, appliedMessage: string) {
  if (isPending(r)) toast.message('Sent for approval', { description: `${r.change.summary}. It takes effect once someone with “Check changes” approves it.` })
  else toast.success(appliedMessage)
}

/**
 * Call a guarded write and return its data. Rule warnings toast as usual; the "sent for approval"
 * warning is left to `announce()` so the person sees one message, not two.
 */
export async function guarded<R>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, ifMatch?: number): Promise<Proposed<R>> {
  const res = await http.full<Proposed<R>>(method, path, { body, ifMatch })
  for (const w of res.warnings) if (w.code !== 'PENDING_APPROVAL') toast.warning(w.message)
  return res.data
}

export const changesApi = {
  list: (q: { status?: 'pending' | 'decided' | 'all' | 'approved' | 'rejected' | 'withdrawn' | 'failed'; scope?: 'to_check' | 'mine' | 'all'; entity?: ChangeEntity } = {}) => http.get<ChangeView[]>('/changes', q),
  summary: () => http.get<{ to_check: number; mine_pending: number; enabled: boolean }>('/changes/summary'),
  get: (id: string) => http.get<ChangeView>(`/changes/${id}`),
  approve: (id: string, note?: string) => http.post<ChangeView>(`/changes/${id}/approve`, { note }),
  reject: (id: string, reason: string) => http.post<ChangeView>(`/changes/${id}/reject`, { reason }),
  withdraw: (id: string) => http.post<ChangeView>(`/changes/${id}/withdraw`),
  config: () => http.get<MakerCheckerConfig & { recommended: ChangeEntity[]; entity_labels: Record<ChangeEntity, string> }>('/maker-checker/config'),
  saveConfig: (c: MakerCheckerConfig) => guarded<MakerCheckerConfig>('PUT', '/maker-checker/config', c),
  checkers: () => http.get<CheckerRow[]>('/maker-checker/checkers'),
}

/** Every decision on a change can move the record it touches, so refresh broadly. */
export const CHANGE_INVALIDATE = [['changes'], ['inbox'], ['workflows'], ['payroll'], ['cost-rates'], ['purchases'], ['budgets'], ['mc-config'], ['mc-checkers'], ['roles'], ['users'], ['people'], ['master'], ['setup'], ['directory']]

export const useChangesSummary = () => useApi(['changes', 'summary'], changesApi.summary, { refetchInterval: 60_000 })
