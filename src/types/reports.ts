// Report specification: the single contract shared by the Custom Report Builder,
// the AI Report Studio and saved/system reports.
// The AI only ever produces a ReportSpec (JSON). Numbers are always computed by the
// report engine from data rows — the model never calculates figures itself.

export type DatasetId =
  | 'projects'
  | 'milestones'
  | 'tasks'
  | 'hours'
  | 'allocations'
  | 'invoices'
  | 'ledger'
  | 'deals'
  | 'deal_activities'
  | 'payroll'
  | 'people'
  | 'ops'
  // v3 business data
  | 'task_reviews'
  | 'leave_requests'
  | 'expenses'
  | 'purchases'
  | 'vendor_bills'
  | 'budget_vs_actual'
  | 'revenue_leakage'
  | 'appraisals'
  | 'candidates'
  | 'documents'
  | 'okr_key_results'

export type FieldType = 'string' | 'number' | 'money' | 'percent' | 'date' | 'enum' | 'boolean'
export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'count_distinct'
export type TimeGrain = 'day' | 'week' | 'month' | 'quarter' | 'fy'
export type FilterOp = 'eq' | 'neq' | 'in' | 'nin' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'between' | 'is_empty' | 'not_empty'
export type ChartKind = 'table' | 'bar' | 'hbar' | 'line' | 'area' | 'pie' | 'stacked' | 'kpi'

export interface FieldDef {
  key: string
  label: string
  type: FieldType
  options?: { value: string; label: string }[]
  grant?: 'margins' | 'salaries' // stripped when viewer lacks the grant
  description?: string
}

export interface DatasetDef {
  id: DatasetId
  label: string
  description: string
  dateField: string | null // default field used by period filters and time grains
  fields: FieldDef[]
  /** @deprecated v4: visibility is permission-based (DatasetDefX.perms in src/reports/datasets.ts). */
  roles?: ('admin' | 'pm' | 'sales' | 'ops' | 'employee')[]
}

export interface Measure {
  field: string // '*' for count
  agg: Agg
  label?: string
}

export interface Dimension {
  field: string
  grain?: TimeGrain // only for date fields
}

export interface Filter {
  field: string
  op: FilterOp
  value?: string | number | boolean | (string | number)[] | null
}

export type PeriodPreset =
  | 'this_month' | 'last_month' | 'this_quarter' | 'last_quarter' | 'this_fy' | 'last_fy'
  | 'last_30_days' | 'last_90_days' | 'last_6_months' | 'last_12_months' | 'ytd' | 'all'

export interface ReportSpec {
  title: string
  subtitle?: string
  dataset: DatasetId
  measures: Measure[] // empty => row-level listing of `columns`
  dimensions: Dimension[]
  columns?: string[] // used for listings (no measures)
  filters: Filter[]
  period?: { preset?: PeriodPreset; from?: string; to?: string; field?: string }
  sort?: { field: string; dir: 'asc' | 'desc' }[]
  limit?: number
  chart: ChartKind
  compare?: 'previous_period' | 'none'
  notes?: string // narrative the AI may attach (qualitative, never numbers)
}

export interface ReportColumn {
  key: string
  label: string
  type: FieldType
}

export interface ReportResult {
  spec: ReportSpec
  columns: ReportColumn[]
  rows: Record<string, string | number | boolean | null>[]
  totals: Record<string, number | null>
  rowCount: number
  generatedAt: string
  periodLabel: string
  warnings: string[]
}
