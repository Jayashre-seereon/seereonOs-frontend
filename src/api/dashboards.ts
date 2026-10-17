// Module E — role dashboards, Insights and the weekly scorecard. Every "this week" figure follows the header
// week switcher (useWeek), passed to the server as ?week=<Monday>.
import { http } from './http'
import { useApi } from './query'
import type { PeriodKind } from '@/domain/calendar'
import type { CeoDashboard, EmployeeDashboard, InsightResult, InsightTab, InsightViewId, MentionRow, OpsDashboard, PmDashboard, SalesDashboard, Scorecard, SCORE_WEIGHTS } from '@/mock/routes/dashboards'
import type { OpsSummary } from '@/mock/routes/operations'

export type {
  ApproverRow, CeoDashboard, CoveringRow, DealRowLite, EmployeeDashboard, Health, InsightCell, InsightColType, InsightColumn, InsightResult, InsightTab, InsightViewId, LoadHoursRow, LoadRow, MentionRow, MilestoneRow, Money4,
  OpsDashboard, PeriodRow, PmDashboard, ProjectPill, SalesDashboard, ScoreCell, ScoreRow, Scorecard, TaskRow,
} from '@/mock/routes/dashboards'
export type { OpsOccurrence, OpsSummary } from '@/mock/routes/operations'
export interface ScoreRules { weights: typeof SCORE_WEIGHTS; thresholds: { green: number; amber: number } }

export const dashboardsApi = {
  ceo: (period: PeriodKind, anchor: string, week?: string) => http.get<CeoDashboard>('/dashboards/ceo', { period, anchor, ...(week ? { week } : {}) }),
  pm: (week?: string) => http.get<PmDashboard>('/dashboards/pm', week ? { week } : undefined),
  sales: () => http.get<SalesDashboard>('/dashboards/sales'),
  ops: () => http.get<OpsDashboard>('/dashboards/ops'),
  employee: (user?: string | null, week?: string) => http.get<EmployeeDashboard>('/dashboards/employee', { ...(user ? { user } : {}), ...(week ? { week } : {}) }),
  mentions: (user?: string) => http.get<MentionRow[]>('/dashboards/mentions', user ? { user } : undefined),
  insightTabs: () => http.get<InsightTab[]>('/insights'),
  insight: (view: InsightViewId) => http.get<InsightResult>(`/insights/${view}`),
  scorecard: (week?: string) => http.get<Scorecard>('/scorecard', week ? { week } : undefined),
  scoreRules: () => http.get<ScoreRules>('/rules/score'),
  opsSummary: () => http.get<OpsSummary>('/ops/summary'),
}

export const useCeoDashboard = (period: PeriodKind, anchor: string, week?: string) => useApi(['dash', 'ceo', period, anchor, week ?? ''], () => dashboardsApi.ceo(period, anchor, week), { placeholderData: (p) => p })
export const usePmDashboard = (enabled = true, week?: string) => useApi(['dash', 'pm', week ?? ''], () => dashboardsApi.pm(week), { enabled, placeholderData: (p) => p })
export const useSalesDashboard = (enabled = true) => useApi(['dash', 'sales'], dashboardsApi.sales, { enabled })
export const useOpsDashboard = (enabled = true) => useApi(['dash', 'ops'], dashboardsApi.ops, { enabled })
export const useEmployeeDashboard = (enabled = true, user?: string | null, week?: string) => useApi(['dash', 'employee', user ?? 'me', week ?? ''], () => dashboardsApi.employee(user, week), { enabled, placeholderData: (p) => p })
export const useInsightTabs = () => useApi(['insights', 'tabs'], dashboardsApi.insightTabs)
export const useInsight = (view: InsightViewId | null) => useApi(['insights', view], () => dashboardsApi.insight(view!), { enabled: !!view })
export const useScorecard = (week?: string) => useApi(['scorecard', week ?? 'current'], () => dashboardsApi.scorecard(week), { placeholderData: (p) => p })
export const useScoreRules = () => useApi(['rules', 'score'], dashboardsApi.scoreRules, { staleTime: 300_000 })
export const useOpsSummary = (enabled = true) => useApi(['ops', 'summary'], dashboardsApi.opsSummary, { enabled })
