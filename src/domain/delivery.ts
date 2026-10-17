// Delivery vocabulary from the Feature Guide: detailed task stages, task tags, project priorities,
// and the costing formulas (cost per hour = CTC ÷ (working days in the month × minimum hours), resource cost, markup ↔ margin).
import type { Paise, Task, TaskStage, TaskStatus, TaskTag } from '@/types/entities'
import type { Tone } from './labels'

export interface StageDef {
  key: TaskStage
  label: string
  short: string
  status: TaskStatus // the summary status every rule and KPI uses
  minProgress: number // moving into this stage raises progress to at least this
  tone: Tone
  group: 'not_started' | 'active' | 'testing' | 'waiting' | 'done'
}
/** Order matters: it is the delivery pipeline shown on the PM dashboard. */
export const TASK_STAGES: StageDef[] = [
  { key: 'new', label: 'New', short: 'New', status: 'todo', minProgress: 0, tone: 'neutral', group: 'not_started' },
  { key: 'selected', label: 'Selected for development', short: 'Selected', status: 'todo', minProgress: 0, tone: 'neutral', group: 'not_started' },
  { key: 'in_development', label: 'In development', short: 'In dev', status: 'in_progress', minProgress: 0, tone: 'info', group: 'active' },
  { key: 'unit_testing', label: 'Unit testing', short: 'Unit test', status: 'in_progress', minProgress: 60, tone: 'info', group: 'testing' },
  { key: 'functional_testing', label: 'Functional testing', short: 'Func. test', status: 'in_progress', minProgress: 75, tone: 'info', group: 'testing' },
  { key: 'uat', label: 'UAT', short: 'UAT', status: 'in_progress', minProgress: 90, tone: 'accent', group: 'testing' },
  { key: 'waiting_feedback', label: 'Waiting for feedback', short: 'Waiting', status: 'blocked', minProgress: 0, tone: 'warning', group: 'waiting' },
  { key: 'on_hold', label: 'On hold', short: 'On hold', status: 'blocked', minProgress: 0, tone: 'warning', group: 'waiting' },
  { key: 'blocked', label: 'Blocked', short: 'Blocked', status: 'blocked', minProgress: 0, tone: 'danger', group: 'waiting' },
  { key: 'completed', label: 'Completed', short: 'Done', status: 'done', minProgress: 100, tone: 'success', group: 'done' },
]
export const STAGE: Record<TaskStage, StageDef> = Object.fromEntries(TASK_STAGES.map((s) => [s.key, s])) as Record<TaskStage, StageDef>

/** Stage a task is in, derived from status for rows that predate stages. */
export function stageOf(t: Pick<Task, 'status'> & { stage?: TaskStage; progress?: number }): TaskStage {
  if (t.stage) return t.stage
  switch (t.status) {
    case 'todo':
      return 'new'
    case 'in_progress':
      return 'in_development'
    case 'blocked':
      return 'blocked'
    case 'in_review':
      return 'uat'
    case 'done':
      return 'completed'
  }
}
/** Progress % of a task: explicit progress, else derived from its state. */
export function progressOf(t: Pick<Task, 'status'> & { stage?: TaskStage; progress?: number }): number {
  if (t.status === 'done') return 100
  const p = typeof t.progress === 'number' ? t.progress : t.status === 'in_review' ? 95 : t.status === 'in_progress' ? 30 : 0
  return Math.max(0, Math.min(100, Math.max(p, STAGE[stageOf(t)].minProgress)))
}
/** Status a stage maps to. In-review (submitted for approval) is kept while the manager decides. */
export function statusForStage(stage: TaskStage, current: TaskStatus): TaskStatus {
  if (current === 'in_review' && stage !== 'completed') return 'in_review'
  return STAGE[stage].status
}

export const TASK_TAG: Record<TaskTag, { label: string; tone: Tone }> = {
  feature: { label: 'Feature', tone: 'neutral' },
  bug: { label: 'Bug', tone: 'danger' },
  improvement: { label: 'Improvement', tone: 'info' },
  documentation: { label: 'Documentation', tone: 'neutral' },
  support: { label: 'Support', tone: 'warning' },
  meeting: { label: 'Meeting', tone: 'neutral' },
}

export const PROJECT_PRIORITY: { value: number; label: string }[] = [
  { value: 1, label: '1 — Critical: revenue or reputation at stake' },
  { value: 2, label: '2 — Strategic client or product' },
  { value: 3, label: '3 — Client project' },
  { value: 4, label: '4 — Internal' },
  { value: 5, label: '5 — Backlog / when free' },
]
export const priorityLabel = (p: number) => PROJECT_PRIORITY.find((x) => x.value === p)?.label ?? `${p}`

/* ---------------- costing formulas ---------------- */
/** Cost per working day = monthly CTC ÷ working days (loading is legacy and 0 by default). */
export function costPerDay(monthlyCtcPaise: Paise, avgWorkingDaysPerMonth: number, loadingPct = 0): Paise {
  if (!avgWorkingDaysPerMonth) return 0
  return Math.round((monthlyCtcPaise / avgWorkingDaysPerMonth) * (1 + loadingPct / 100))
}
/** Resource cost = cost per day × allocation % × working days in the range. Man-days = working days × allocation. */
export function resourceCost(costPerDayPaise: Paise, allocPct: number, workingDays: number) {
  const manDays = Math.round(workingDays * (allocPct / 100) * 10) / 10
  return { manDays, costPaise: Math.round(costPerDayPaise * workingDays * (allocPct / 100)) }
}
export const marginFromMarkup = (markupPct: number) => (markupPct <= -100 ? 0 : (markupPct / (100 + markupPct)) * 100)
export const markupFromMargin = (marginPct: number) => (marginPct >= 100 ? Infinity : (marginPct / (100 - marginPct)) * 100)
/** Price from cost and markup, and markup implied by a price. */
export const priceFromMarkup = (costPaise: Paise, markupPct: number) => Math.round(costPaise * (1 + markupPct / 100))
export const markupFromPrice = (costPaise: Paise, pricePaise: Paise) => (costPaise > 0 ? ((pricePaise - costPaise) / costPaise) * 100 : 0)
