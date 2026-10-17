// Client-side draft state for the project cost calculator. The server (POST /projects/costing/preview) computes every
// number; this module only shapes user input into the API payload and back.
import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData } from '@tanstack/react-query'
import { costingApi, type CostingInput, type CostingPreview, type CostingPreviewInput } from '@/api/projects'
import { useApi } from '@/api/query'

export interface DraftRow {
  key: string
  id: string | null // existing allocation id (project editor)
  user_id: string | null
  ms: string // '' = All milestones, 'i:<index>' = create-form milestone, 'id:<milestone id>' = saved milestone
  pct: string
  from_on: string | null // null = follow the milestone (or project) dates
  to_on: string | null
}
export interface DraftAdd {
  key: string
  category: string
  description: string
  amount_paise: number
}
export interface CostingDraft {
  rows: DraftRow[]
  additional: DraftAdd[]
  maintenance_paise: number
  contingency_pct: string
  markup_pct: string
  price_paise: number | null
  price_mode: 'markup' | 'price'
}

let seq = 0
export const newKey = (p = 'k') => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`

export function emptyDraft(): CostingDraft {
  return { rows: [], additional: [], maintenance_paise: 0, contingency_pct: '0', markup_pct: '0', price_paise: null, price_mode: 'markup' }
}

export function draftFromPreview(p: CostingPreview): CostingDraft {
  return {
    rows: p.rows.map((r) => ({
      key: r.key,
      id: r.id,
      user_id: r.user_id,
      ms: r.milestone_id ? `id:${r.milestone_id}` : r.milestone_index !== null && r.ms_code !== 'All' ? `i:${r.milestone_index}` : '',
      pct: r.pct === null ? '' : String(r.pct),
      from_on: r.from_on,
      to_on: r.to_on,
    })),
    additional: p.additional_costs.map((a) => ({ key: a.id ?? newKey('a'), category: a.category, description: a.description, amount_paise: a.amount_paise })),
    maintenance_paise: p.maintenance_paise,
    contingency_pct: String(p.contingency_pct ?? 0),
    markup_pct: p.markup_pct === null ? '0' : String(p.markup_pct),
    price_paise: p.price_paise,
    price_mode: 'price',
  }
}

const numOrNull = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s))

export function draftToInput(d: CostingDraft): CostingInput {
  return {
    resources: d.rows.map((r) => ({
      key: r.key,
      id: r.id,
      user_id: r.user_id,
      milestone_index: r.ms.startsWith('i:') ? Number(r.ms.slice(2)) : null,
      milestone_id: r.ms.startsWith('id:') ? r.ms.slice(3) : null,
      pct: numOrNull(r.pct),
      from_on: r.from_on || null,
      to_on: r.to_on || null,
    })),
    additional_costs: d.additional.map((a) => ({ id: a.key, category: a.category, description: a.description, amount_paise: a.amount_paise })),
    maintenance_paise: d.maintenance_paise,
    contingency_pct: numOrNull(d.contingency_pct) ?? 0,
    markup_pct: numOrNull(d.markup_pct),
    price_paise: d.price_paise,
    price_mode: d.price_mode,
  }
}

/** True when the draft holds anything worth saving. */
export const draftHasContent = (d: CostingDraft) => d.rows.length > 0 || d.additional.some((a) => a.amount_paise > 0 || a.description.trim()) || d.maintenance_paise > 0

function useDebounced<T>(v: T, ms: number): T {
  const [x, setX] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setX(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return x
}

/** Server-truth preview of the calculator, debounced while the user types. */
export function useCostingPreview(input: CostingPreviewInput | null, enabled = true) {
  const raw = useMemo(() => (input ? JSON.stringify(input) : ''), [input])
  const key = useDebounced(raw, 280)
  return useApi(['costing-preview', key], () => costingApi.preview(JSON.parse(key) as CostingPreviewInput), { enabled: enabled && !!key, placeholderData: keepPreviousData, staleTime: 30_000, retry: false })
}
