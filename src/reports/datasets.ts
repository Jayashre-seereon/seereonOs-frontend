// Dataset catalogue for the report engine (Custom Report Builder, AI Studio, saved reports).
// Pure definitions — shared by the "backend" (mock route builds rows + executes) and the client
// (builder pickers, AI prompt catalogue, spec validation). Money fields are paise.
import type { DatasetDef, DatasetId, FieldDef, PeriodPreset, Agg, FilterOp, ChartKind, TimeGrain } from '@/types/reports'
import type { PermissionKey } from '@/domain/permissionCatalog'
import { ACTIVITY_TYPE, CR_STATUS, DEAL_SOURCE, DEAL_STAGE, HEALTH, PROJECT_STATUS, PROJECT_TYPE, STREAM, TASK_STATUS, WEEK_STATUS, BILLING_MODEL, COMPLEXITY, LEAVE_TYPE, INTERNAL_CODES } from '@/domain/labels'
import { BILL_STATUS, EXPENSE_CATEGORY_LABEL, EXPENSE_STATUS, LEAKAGE_KIND, PO_STATUS } from '@/modules/spend/labels'

export interface FieldDefX extends FieldDef {
  /** Needs finance.view — invoices, collections, receivables. */
  adminOnly?: boolean
  /** Displayed as hours (number type). */
  unit?: 'hours' | 'days'
  /** Synonyms the rule-based planner matches in plain English. */
  aliases?: string[]
  /** Sensible as a grouping dimension. */
  groupable?: boolean
}
export interface DatasetDefX extends DatasetDef {
  /** Visible when the viewer holds ANY of these permissions; empty = everyone (rows are still scoped server-side). */
  perms: PermissionKey[]
  fields: FieldDefX[]
  /** noun for counts: "deals", "tasks" */
  noun: string
  /** Period presets cap at today (actuals: money booked, hours logged). */
  actuals?: boolean
  /** Default listing columns. */
  defaultColumns: string[]
  aliases: string[]
}

const opts = <K extends string>(m: Record<K, string | { label: string }>) => (Object.keys(m) as K[]).map((k) => ({ value: k, label: typeof m[k] === 'string' ? (m[k] as string) : (m[k] as { label: string }).label }))


export const MILESTONE_STATE = {
  achieved_on_time: { label: 'Achieved on time', tone: 'success' },
  achieved_late: { label: 'Achieved late', tone: 'warning' },
  on_track: { label: 'On track', tone: 'info' },
  at_risk: { label: 'At risk', tone: 'warning' },
  overdue: { label: 'Overdue', tone: 'danger' },
  not_started: { label: 'Not started', tone: 'neutral' },
} as const
const BILLING_STATUS = { none: 'Not invoiced', invoiced: 'Invoiced', paid: 'Paid' }
const INVOICE_STATUS = { unpaid: 'Unpaid', partial: 'Part paid', paid: 'Paid' }
const OPS_CATEGORY = { payroll: 'Payroll', compliance: 'Compliance', finance: 'Finance', admin: 'Admin', hr: 'HR', it: 'IT' }
const RECURRENCE = { none: 'One-off', weekly: 'Weekly', monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' }
const DEPARTMENT = { management: 'Management', delivery: 'Delivery', sales: 'Sales', operations: 'Operations' }
const ROLE = { admin: 'Admin (CEO)', pm: 'Project manager', sales: 'Sales', ops: 'Operations', employee: 'Employee' }
const ENTRY_KIND = { task: 'Project task', leave: 'Leave', internal: 'Internal' }
const LEDGER_KIND = { income: 'Income', expense: 'Expense' }
const LEDGER_STATUS = { expected: 'Expected', received: 'Received', paid: 'Paid' }
const LEDGER_ENTRY = { entry: 'Ledger entry', payment: 'Payment received' }
const PAYROLL_STATUS = { final: 'Final', draft: 'Draft', estimate: 'Estimate (no run yet)' }
const OPS_STATUS = { open: 'Open', done: 'Done' }
// v3
const TASK_KIND = { project: 'Project task', general: 'General task' }
const TASK_PRIORITY = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' }
const TIMELINESS = { early: 'Early', on_time: 'On time', late: 'Late' }
const REVIEW_DECISION = { approved: 'Approved', sent_back: 'Sent back', pending: 'Awaiting review' }
const LEAVE_STATUS = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected', cancelled: 'Cancelled' }
const BUDGET_KIND = { expense: 'Expense', revenue: 'Revenue' }
const LEAKAGE_STATUS = { open: 'Open', recovered: 'Recovered', accepted: 'Accepted (written off)' }
const APPRAISAL_STATUS = { not_started: 'Not started', self_pending: 'Self review pending', manager_pending: 'Manager review pending', hr_pending: 'HR review pending', completed: 'Completed' }
const CANDIDATE_STAGE = { applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', hired: 'Hired', rejected: 'Rejected', withdrawn: 'Withdrawn' }
const CANDIDATE_SOURCE = { referral: 'Referral', job_portal: 'Job portal', linkedin: 'LinkedIn', campus: 'Campus', agency: 'Agency', website: 'Website', other: 'Other' }
const DOC_CATEGORY = { requirements: 'Requirements', design: 'Design', technical: 'Technical', test: 'Testing', contract: 'Contract', meeting_notes: 'Meeting notes', process: 'Process', policy: 'Policy', training: 'Training', other: 'Other' }
const DOC_VISIBILITY = { project: 'Project team', company: 'Everyone', managers: 'Managers only' }
const MY_ACK = { acknowledged: 'Acknowledged', pending: 'Pending', not_required: 'Not required' }
const OKR_LEVEL = { company: 'Company', team: 'Team', person: 'Personal' }
const OKR_METRIC = { manual: 'Manual check-ins', revenue_billed: 'Revenue billed', revenue_collected: 'Revenue collected', deals_won_value: 'Value of deals won', on_time_task_pct: 'Tasks finished on time', timesheet_compliance: 'Timesheet compliance', margin_pct: 'Net margin', headcount: 'Active headcount', leakage: 'Revenue leakage' }
const OKR_STATUS = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track', done: 'Done', not_started: 'Not started' }

export const ENUM_LABELS: Record<string, Record<string, string>> = {
  stream: Object.fromEntries(Object.entries(STREAM)),
  project_status: Object.fromEntries(Object.entries(PROJECT_STATUS).map(([k, v]) => [k, v.label])),
  project_type: { ...PROJECT_TYPE },
  billing_model: { ...BILLING_MODEL },
  health: Object.fromEntries(Object.entries(HEALTH).map(([k, v]) => [k, v.label])),
  task_status: Object.fromEntries(Object.entries(TASK_STATUS).map(([k, v]) => [k, v.label])),
  complexity: Object.fromEntries(Object.entries(COMPLEXITY).map(([k, v]) => [k, v.label])),
  ms_state: Object.fromEntries(Object.entries(MILESTONE_STATE).map(([k, v]) => [k, v.label])),
  billing_status: BILLING_STATUS,
  invoice_status: INVOICE_STATUS,
  deal_stage: Object.fromEntries(Object.entries(DEAL_STAGE).map(([k, v]) => [k, v.label])),
  deal_source: { ...DEAL_SOURCE },
  activity_type: { ...ACTIVITY_TYPE },
  week_status: Object.fromEntries(Object.entries(WEEK_STATUS).map(([k, v]) => [k, v.label])),
  entry_kind: ENTRY_KIND,
  internal_code: { ...INTERNAL_CODES },
  leave_type: { ...LEAVE_TYPE },
  ledger_kind: LEDGER_KIND,
  ledger_status: LEDGER_STATUS,
  ledger_entry: LEDGER_ENTRY,
  payroll_status: PAYROLL_STATUS,
  department: DEPARTMENT,
  role: ROLE,
  ops_category: OPS_CATEGORY,
  recurrence: RECURRENCE,
  ops_status: OPS_STATUS,
  cr_status: Object.fromEntries(Object.entries(CR_STATUS).map(([k, v]) => [k, v.label])),
  task_kind: TASK_KIND,
  task_priority: TASK_PRIORITY,
  timeliness: TIMELINESS,
  review_decision: REVIEW_DECISION,
  leave_status: LEAVE_STATUS,
  expense_category: { ...EXPENSE_CATEGORY_LABEL },
  expense_status: Object.fromEntries(Object.entries(EXPENSE_STATUS).map(([k, v]) => [k, v.label])),
  po_status: Object.fromEntries(Object.entries(PO_STATUS).map(([k, v]) => [k, v.label])),
  bill_status: Object.fromEntries(Object.entries(BILL_STATUS).map(([k, v]) => [k, v.label])),
  budget_kind: BUDGET_KIND,
  leakage_kind: Object.fromEntries(Object.entries(LEAKAGE_KIND).map(([k, v]) => [k, v.label])),
  leakage_status: LEAKAGE_STATUS,
  appraisal_status: APPRAISAL_STATUS,
  candidate_stage: CANDIDATE_STAGE,
  candidate_source: CANDIDATE_SOURCE,
  doc_category: DOC_CATEGORY,
  doc_visibility: DOC_VISIBILITY,
  my_ack: MY_ACK,
  okr_level: OKR_LEVEL,
  okr_metric: OKR_METRIC,
  okr_status: OKR_STATUS,
}

const E = (key: string, label: string, map: keyof typeof ENUM_LABELS, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'enum', options: opts(ENUM_LABELS[map]), groupable: true, ...extra })
const S = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'string', ...extra })
const N = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'number', ...extra })
const H = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'number', unit: 'hours', ...extra })
const M = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'money', ...extra })
const P = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'percent', ...extra })
const D = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'date', groupable: true, ...extra })
const B = (key: string, label: string, extra: Partial<FieldDefX> = {}): FieldDefX => ({ key, label, type: 'boolean', ...extra })

export const DATASETS: DatasetDefX[] = [
  {
    id: 'projects', label: 'Projects', noun: 'projects', description: 'Every project with delivery and money metrics (progress, SPI, effort ratio, margin).', dateField: 'start_on', perms: ['projects.view_all', 'projects.edit'],
    aliases: ['project', 'projects', 'portfolio', 'engagement', 'margin', 'margins', 'health', 'contract'],
    defaultColumns: ['code', 'name', 'client', 'status', 'health', 'progress', 'contract_value'],
    fields: [
      S('code', 'Code'), S('name', 'Project', { groupable: true, aliases: ['project'] }), S('client', 'Client', { groupable: true, aliases: ['client', 'customer', 'account'] }),
      E('type', 'Project type', 'project_type', { aliases: ['type'] }), E('status', 'Status', 'project_status'), E('stream', 'Revenue stream', 'stream', { aliases: ['stream', 'business line'] }),
      E('billing_model', 'Billing model', 'billing_model', { aliases: ['billing model', 'commercial model'] }), S('pm', 'Project manager', { groupable: true, aliases: ['pm', 'project manager', 'manager'] }),
      N('priority', 'Priority'), D('start_on', 'Start date'), D('end_on', 'Planned end'),
      M('contract_value', 'Contract value', { aliases: ['contract', 'deal value', 'value'] }), M('invoiced', 'Invoiced', { adminOnly: true, aliases: ['invoiced', 'billed'] }), M('collected', 'Collected', { adminOnly: true }),
      M('outstanding', 'Outstanding', { adminOnly: true, aliases: ['receivable', 'outstanding'] }), M('uninvoiced', 'Not yet invoiced', { adminOnly: true, aliases: ['uninvoiced', 'unbilled'] }),
      H('est_hours', 'Estimated hours'), H('actual_hours', 'Logged hours'), H('remaining_hours', 'Remaining hours'), P('progress', 'Progress', { aliases: ['progress', 'complete'] }),
      N('effort_ratio', 'Effort ratio', { description: 'Actual ÷ estimated hours; above 1.2 is flagged.', aliases: ['effort ratio', 'effort'] }), N('spi', 'SPI', { description: 'Schedule performance index: earned ÷ planned by today.', aliases: ['spi', 'schedule performance'] }),
      M('planned_cost', 'Planned cost', { grant: 'margins' }), M('projected_cost', 'Projected cost', { grant: 'margins', aliases: ['cost'] }), M('actual_cost', 'Actual cost (approved)', { grant: 'margins' }),
      P('projected_margin', 'Projected margin', { grant: 'margins', aliases: ['margin', 'margins', 'profitability'] }), P('actual_margin', 'Actual margin', { grant: 'margins' }), P('projected_markup', 'Projected markup', { grant: 'margins', aliases: ['markup'] }),
      E('health', 'Health', 'health'), N('open_tasks', 'Open tasks'), N('overdue_tasks', 'Overdue tasks'), N('blocked_tasks', 'Blocked tasks'), N('overdue_milestones', 'Overdue milestones'),
    ],
  },
  {
    id: 'milestones', label: 'Milestones', noun: 'milestones', description: 'Milestones with delivery state, slip and billing.', dateField: 'planned_end', perms: ['projects.view_all', 'projects.edit'],
    aliases: ['milestone', 'milestones', 'deliverable', 'deliverables'],
    defaultColumns: ['label', 'project', 'planned_end', 'state', 'progress', 'billing_amount', 'billing_status'],
    fields: [
      S('label', 'Milestone'), S('project', 'Project', { groupable: true }), S('client', 'Client', { groupable: true }), N('no', 'Number'), S('pm', 'Project manager', { groupable: true }),
      D('planned_start', 'Planned start'), D('planned_end', 'Deadline', { aliases: ['deadline', 'due'] }), D('baseline_end', 'Baseline end'), N('slip_days', 'Slip (days)', { unit: 'days', aliases: ['slip'] }),
      M('billing_amount', 'Billing value', { aliases: ['billing', 'value'] }), E('billing_status', 'Billing status', 'billing_status'), E('state', 'Delivery state', 'ms_state'),
      P('progress', 'Progress'), D('achieved_on', 'Achieved on'), B('is_overdue', 'Overdue'), B('is_open', 'Open'), N('days_to_due', 'Days to deadline', { unit: 'days' }),
    ],
  },
  {
    id: 'tasks', label: 'Tasks', noun: 'tasks', description: 'Project and general tasks with owner, reviewer, dates, estimate vs actual, timeliness (early/on time/late), delay reason, quality rating and review rounds.', dateField: 'due_on', perms: [],
    aliases: ['task', 'tasks', 'work item', 'work items', 'wbs', 'todo', 'to-do', 'delivery', 'on-time', 'on time'],
    defaultColumns: ['code', 'title', 'project', 'owner', 'status', 'due_on', 'days_overdue'],
    fields: [
      S('code', 'WBS'), S('title', 'Task'), S('project', 'Project', { groupable: true }), S('client', 'Client', { groupable: true }), S('milestone', 'Milestone', { groupable: true }),
      S('owner', 'Owner', { groupable: true, aliases: ['owner', 'assignee', 'person', 'people', 'employee', 'developer', 'who'] }), S('backup', 'Backup'),
      E('status', 'Status', 'task_status'), E('complexity', 'Complexity', 'complexity'), D('start_on', 'Start'), D('due_on', 'Due date', { aliases: ['due'] }), D('done_on', 'Done on'),
      N('days_overdue', 'Days overdue', { unit: 'days' }), B('is_overdue', 'Overdue'), B('is_blocked', 'Blocked'), B('is_open', 'Open'), B('on_time', 'Done on time'),
      H('est', 'Estimated hours', { aliases: ['estimate', 'estimated'] }), H('actual', 'Actual hours', { aliases: ['actual', 'logged'] }), N('effort_ratio', 'Effort ratio', { aliases: ['effort ratio', 'effort'] }),
      E('kind', 'Task kind', 'task_kind', { aliases: ['general task', 'project task'] }), S('assigned_by', 'Assigned by', { groupable: true, aliases: ['assigned by', 'assigner'] }), S('reviewer', 'Reviewer', { groupable: true, aliases: ['reviewer', 'approver'] }),
      E('priority', 'Priority', 'task_priority'), D('submitted_on', 'Submitted for review'), D('approved_on', 'Approved on'),
      E('timeliness', 'Timeliness', 'timeliness', { description: 'Completed tasks only: early (≥1 working day before due), on time, or late.', aliases: ['timeliness', 'early', 'on time'] }),
      N('variance_days', 'Variance (working days)', { unit: 'days', description: 'Completed tasks: working days after (+) or before (−) the due date.', aliases: ['variance', 'delay days'] }),
      S('delay_reason', 'Delay reason', { groupable: true, aliases: ['delay reason', 'reason for delay', 'why delayed'] }), N('quality_rating', 'Quality rating', { description: 'Reviewer rating 1–5 given on approval.', aliases: ['quality', 'rating'] }),
      N('review_rounds', 'Review rounds'), N('sent_back_count', 'Times sent back', { aliases: ['sent back', 'rework'] }),
      P('on_time_rate', 'On-time rate', { description: 'Completed tasks: 100% if early or on time, 0% if late. Average it for on-time delivery %.', aliases: ['on-time delivery', 'on time delivery', 'on-time rate'] }),
      B('is_late', 'Completed late'), B('is_in_review', 'In review'),
    ],
  },
  {
    id: 'hours', label: 'Hours (timesheets)', noun: 'entries', description: 'Every timesheet entry, costed at the rate valid on the day it was worked.', dateField: 'date', perms: [], actuals: true,
    aliases: ['hour', 'hours', 'timesheet', 'timesheets', 'time', 'effort logged', 'logged', 'utilisation', 'utilization', 'leave', 'billable'],
    defaultColumns: ['date', 'person', 'project', 'task', 'kind', 'hours', 'approved'],
    fields: [
      D('date', 'Date'), S('person', 'Person', { groupable: true, aliases: ['person', 'people', 'employee', 'who', 'team member', 'resource'] }), E('department', 'Department', 'department'),
      S('project', 'Project', { groupable: true }), S('client', 'Client', { groupable: true }), S('task', 'Task'), E('kind', 'Entry type', 'entry_kind', { aliases: ['type', 'kind'] }),
      E('internal_code', 'Internal activity', 'internal_code'), E('leave_type', 'Leave type', 'leave_type'), H('hours', 'Hours'), B('approved', 'Approved'), E('week_status', 'Week status', 'week_status'),
      M('cost', 'Cost', { grant: 'salaries', aliases: ['cost', 'labour cost', 'labor cost'] }),
    ],
  },
  {
    id: 'allocations', label: 'Allocations', noun: 'allocations', description: 'Planned allocation of people to project milestones (percent of the day).', dateField: 'from_on', perms: ['projects.view_all', 'projects.edit', 'allocation.edit'],
    aliases: ['allocation', 'allocations', 'staffing', 'assignment'],
    defaultColumns: ['person', 'project', 'milestone', 'pct', 'from_on', 'to_on'],
    fields: [
      S('person', 'Person', { groupable: true }), S('project', 'Project', { groupable: true }), S('milestone', 'Milestone'), P('pct', 'Allocation'), D('from_on', 'From'), D('to_on', 'To'),
      N('working_days', 'Working days', { unit: 'days' }), H('planned_hours', 'Planned hours'), B('is_active', 'Active today'),
    ],
  },
  {
    id: 'invoices', label: 'Invoices', noun: 'invoices', description: 'Milestone invoices with payments and receivables ageing.', dateField: 'invoiced_on', perms: ['finance.view'], actuals: true,
    aliases: ['invoice', 'invoices', 'billing', 'receivable', 'receivables', 'collection', 'collections', 'dso'],
    defaultColumns: ['number', 'client', 'project', 'invoiced_on', 'amount', 'paid', 'outstanding', 'status'],
    fields: [
      S('number', 'Invoice no.'), S('client', 'Client', { groupable: true }), S('project', 'Project', { groupable: true }), S('milestone', 'Milestone'), E('stream', 'Revenue stream', 'stream'),
      D('invoiced_on', 'Invoice date'), D('due_on', 'Due date'), D('paid_on', 'Paid on'), M('amount', 'Invoice amount', { aliases: ['billing', 'billed', 'amount', 'invoiced'] }), M('paid', 'Paid'),
      M('outstanding', 'Outstanding', { aliases: ['outstanding', 'receivable', 'unpaid'] }), E('status', 'Status', 'invoice_status'), N('days_overdue', 'Days overdue', { unit: 'days' }), B('is_overdue', 'Overdue'), N('age_days', 'Age (days)', { unit: 'days' }),
    ],
  },
  {
    id: 'ledger', label: 'Ledger (income & costs)', noun: 'entries', description: 'Income and expense entries (recurring expanded monthly) plus payments received — the source of billed, collected and costs.', dateField: 'date', perms: ['ledger.view', 'finance.view'], actuals: true,
    aliases: ['revenue', 'income', 'expense', 'expenses', 'cost', 'costs', 'spend', 'ledger', 'cash', 'profit', 'earnings', 'p&l', 'pnl', 'billed', 'collected', 'net'],
    defaultColumns: ['date', 'kind', 'category', 'description', 'stream', 'amount', 'status'],
    fields: [
      D('date', 'Date'), E('kind', 'Type', 'ledger_kind'), S('category', 'Category', { groupable: true, aliases: ['category', 'head'] }), S('description', 'Description'), E('stream', 'Revenue stream', 'stream', { aliases: ['stream', 'business line', 'source of revenue'] }),
      S('project', 'Project', { groupable: true }), S('client', 'Client', { groupable: true }), M('amount', 'Amount'), M('billed', 'Revenue billed', { aliases: ['revenue', 'billed', 'income', 'sales', 'turnover'] }),
      M('collected', 'Cash collected', { aliases: ['collected', 'collection', 'cash in', 'received'] }), M('spent', 'Costs', { aliases: ['cost', 'costs', 'expense', 'expenses', 'spend'] }), M('net', 'Net (billed − costs)', { aliases: ['net', 'profit', 'earnings'] }),
      E('status', 'Status', 'ledger_status'), E('entry', 'Row type', 'ledger_entry'), B('recurring', 'Recurring'),
    ],
  },
  {
    id: 'deals', label: 'Deals (pipeline)', noun: 'deals', description: 'Sales opportunities with stage, value, weighted value and cycle.', dateField: 'created_on', perms: ['deals.edit_own', 'deals.view_all'],
    aliases: ['deal', 'deals', 'pipeline', 'lead', 'leads', 'opportunity', 'opportunities', 'sales', 'win rate', 'won', 'lost', 'funnel', 'crm'],
    defaultColumns: ['title', 'client', 'stage', 'owner', 'value', 'expected_close', 'days_idle'],
    fields: [
      S('title', 'Deal'), S('client', 'Client', { groupable: true }), S('product', 'Product', { groupable: true, aliases: ['product'] }), E('source', 'Lead source', 'deal_source', { aliases: ['source', 'channel'] }),
      E('stage', 'Stage', 'deal_stage'), S('owner', 'Owner', { groupable: true, aliases: ['owner', 'salesperson', 'rep', 'person', 'who'] }), B('is_open', 'Open'), B('is_won', 'Won'), B('is_lost', 'Lost'),
      M('value', 'Deal value', { aliases: ['value', 'amount', 'pipeline'] }), M('mrr', 'Recurring (per month)', { aliases: ['mrr', 'recurring'] }), M('weighted', 'Weighted value', { aliases: ['weighted'] }), P('chance', 'Stage probability'),
      P('win', 'Win rate', { description: 'Won = 100%, lost = 0%, open deals excluded. Average it to get win rate.', aliases: ['win rate', 'conversion'] }),
      D('created_on', 'Created'), D('expected_close', 'Expected close'), D('won_on', 'Won on'), D('lost_on', 'Lost on'), D('closed_on', 'Closed on'), D('last_activity_on', 'Last activity'),
      N('days_idle', 'Days since activity', { unit: 'days' }), B('is_stale', 'Stale'), N('cycle_days', 'Sales cycle (days)', { unit: 'days', aliases: ['cycle', 'days to close', 'sales cycle'] }), S('lost_reason', 'Lost reason', { groupable: true }),
    ],
  },
  {
    id: 'deal_activities', label: 'Sales activities', noun: 'activities', description: 'Calls, meetings, demos and follow-ups logged against deals.', dateField: 'date', perms: ['deals.edit_own', 'deals.view_all'], actuals: true,
    aliases: ['activity', 'activities', 'call', 'calls', 'meeting', 'meetings', 'demos', 'follow-up', 'follow-ups'],
    defaultColumns: ['date', 'owner', 'type', 'deal', 'client', 'note'],
    fields: [D('date', 'Date'), E('type', 'Activity', 'activity_type', { aliases: ['type'] }), S('deal', 'Deal', { groupable: true }), S('client', 'Client', { groupable: true }), E('stage', 'Deal stage', 'deal_stage'), S('owner', 'Logged by', { groupable: true, aliases: ['owner', 'person', 'salesperson', 'who'] }), S('note', 'Note')],
  },
  {
    id: 'payroll', label: 'Payroll', noun: 'payslips', description: 'Monthly pay per person: base, deductions for unapproved/LWP days, variable, net. Months without a run are estimated from CTC.', dateField: 'month', perms: ['payroll.run', 'payroll.finalise'], actuals: true,
    aliases: ['payroll', 'salary', 'salaries', 'pay', 'ctc', 'payslip', 'compensation', 'wage', 'wages'],
    defaultColumns: ['month', 'person', 'department', 'ctc', 'deduction', 'variable', 'net', 'status'],
    fields: [
      D('month', 'Month'), S('person', 'Person', { groupable: true }), E('department', 'Department', 'department', { aliases: ['department', 'team', 'function'] }), E('role', 'Role', 'role'),
      M('ctc', 'Monthly CTC', { aliases: ['cost', 'ctc', 'payroll cost', 'salary cost'] }), M('base', 'Base pay'), M('deduction', 'Deductions', { aliases: ['deduction', 'deductions'] }), M('variable', 'Variable earned', { aliases: ['variable', 'incentive', 'bonus'] }),
      M('net', 'Net pay', { aliases: ['net pay', 'take home'] }), N('working_days', 'Working days', { unit: 'days' }), N('unapproved_days', 'Unapproved days', { unit: 'days' }), N('lwp_days', 'LWP days', { unit: 'days' }), E('status', 'Run status', 'payroll_status'),
    ],
  },
  {
    id: 'people', label: 'People', noun: 'people', description: 'Team members with role, manager, load, delivery record and timesheet discipline.', dateField: 'joined_on', perms: ['people.view_all', 'team.view'],
    aliases: ['people', 'person', 'team', 'staff', 'employees', 'headcount', 'resource', 'resources', 'bench'],
    defaultColumns: ['name', 'title', 'role', 'manager', 'allocation_next_10d', 'open_tasks', 'last_week_status'],
    fields: [
      S('name', 'Person', { groupable: true }), S('title', 'Title'), E('role', 'Role', 'role'), E('department', 'Department', 'department', { aliases: ['department', 'team', 'function'] }), S('manager', 'Reports to', { groupable: true, aliases: ['manager', 'reports to'] }),
      D('joined_on', 'Joined'), M('ctc', 'Monthly CTC', { grant: 'salaries' }), M('cost_per_hour', 'Cost per hour', { grant: 'salaries' }),
      P('allocation_today', 'Allocation today'), P('allocation_next_10d', 'Allocation, next 10 working days', { aliases: ['allocation', 'utilisation', 'utilization', 'load'] }),
      N('open_tasks', 'Open tasks'), N('overdue_tasks', 'Overdue tasks'), N('effort_ratio', 'Effort ratio'), P('on_time', 'On-time delivery'), H('hours_30d', 'Hours, last 30 days'),
      E('last_week_status', 'Last week’s timesheet', 'week_status', { aliases: ['timesheet status'] }), N('unsubmitted_weeks_8w', 'Weeks not submitted (8 wks)'), P('ts_compliance_8w', 'Timesheet compliance (8 wks)'),
    ],
  },
  {
    id: 'ops', label: 'Operations register', noun: 'items', description: 'Recurring duties: payroll, statutory filings, finance and admin with due dates.', dateField: 'due_on', perms: ['ops.manage'],
    aliases: ['ops', 'operations', 'compliance', 'filing', 'filings', 'statutory', 'duty', 'duties'],
    defaultColumns: ['item', 'category', 'owner', 'due_on', 'recurring', 'status', 'days_overdue'],
    fields: [S('item', 'Item'), E('category', 'Category', 'ops_category'), S('owner', 'Owner', { groupable: true }), D('due_on', 'Due'), E('recurring', 'Repeats', 'recurrence'), E('status', 'Status', 'ops_status'), B('is_overdue', 'Overdue'), N('days_overdue', 'Days overdue', { unit: 'days' }), D('last_done_on', 'Last done')],
  },
  /* ---------------- v3 business data ---------------- */
  {
    id: 'task_reviews', label: 'Task reviews', noun: 'review rounds', description: 'Every submission of a task for review: reviewer, decision (approved / sent back), reason, quality rating and whether it was submitted after the due date.', dateField: 'submitted_at', perms: [], actuals: true,
    aliases: ['review', 'reviews', 'review round', 'review rounds', 'sent back', 'send back', 'rework', 'submission', 'submissions'],
    defaultColumns: ['submitted_at', 'task', 'project', 'owner', 'reviewer', 'round', 'decision', 'decision_reason', 'quality_rating'],
    fields: [
      S('task', 'Task'), S('project', 'Project', { groupable: true }), E('task_kind', 'Task kind', 'task_kind'), S('owner', 'Owner', { groupable: true, aliases: ['owner', 'assignee', 'person', 'who'] }),
      S('reviewer', 'Reviewer', { groupable: true, aliases: ['reviewer', 'approver'] }), N('round', 'Round'), D('submitted_at', 'Submitted on'), E('decision', 'Decision', 'review_decision'),
      D('decided_at', 'Decided on'), S('decision_reason', 'Send-back reason', { groupable: true }), N('quality_rating', 'Quality rating', { aliases: ['quality', 'rating'] }),
      S('delay_reason', 'Delay reason', { groupable: true }), B('late_at_submission', 'Submitted after due date'), B('is_sent_back', 'Sent back'), B('is_approved', 'Approved'), B('is_pending', 'Awaiting review'),
      N('days_to_decide', 'Days to decide', { unit: 'days' }),
    ],
  },
  {
    id: 'leave_requests', label: 'Leave requests', noun: 'leave requests', description: 'Leave applications with type, days, status and who decided. Employees see only their own; managers see their reports; HR sees everyone.', dateField: 'from_on', perms: [],
    aliases: ['leave', 'leaves', 'leave request', 'leave requests', 'time off', 'vacation', 'absence', 'holiday'],
    defaultColumns: ['person', 'type', 'from_on', 'to_on', 'days', 'status', 'decided_by'],
    fields: [
      S('person', 'Person', { groupable: true, aliases: ['person', 'employee', 'who'] }), S('manager', 'Manager', { groupable: true, aliases: ['manager'] }), E('type', 'Leave type', 'leave_type', { aliases: ['leave type', 'type'] }),
      D('from_on', 'From'), D('to_on', 'To'), N('days', 'Days', { unit: 'days', aliases: ['days', 'leave days'] }), E('status', 'Status', 'leave_status'), S('approver', 'Approver', { groupable: true }),
      S('decided_by', 'Decided by', { groupable: true }), S('decision_reason', 'Decision reason'), S('reason', 'Reason'), D('applied_on', 'Applied on'), B('is_pending', 'Pending'), B('is_approved', 'Approved'),
    ],
  },
  {
    id: 'expenses', label: 'Expense claims', noun: 'claims', description: 'Expense claims (reimbursements) with category, amount, status, approver, budget check and payment. Employees see their own; PMs their projects and team; admin and HR everyone.', dateField: 'spent_on', perms: [], actuals: true,
    aliases: ['expense claim', 'expense claims', 'claim', 'claims', 'reimbursement', 'reimbursements', 'reimburse'],
    defaultColumns: ['spent_on', 'person', 'category', 'description', 'project', 'amount', 'status', 'approver'],
    fields: [
      S('person', 'Person', { groupable: true, aliases: ['person', 'employee', 'who', 'claimant'] }), S('project', 'Project', { groupable: true }), E('category', 'Category', 'expense_category', { aliases: ['category', 'head'] }),
      S('description', 'Description'), M('amount', 'Amount', { aliases: ['amount', 'spend', 'spent', 'claimed'] }), D('spent_on', 'Spent on'), E('status', 'Status', 'expense_status'), S('approver', 'Approver', { groupable: true }),
      B('in_budget', 'Within budget'), B('billable', 'Billable to client'), D('paid_on', 'Paid on'), B('is_unpaid', 'Approved, not yet reimbursed'), B('is_pending', 'Awaiting approval'),
    ],
  },
  {
    id: 'purchases', label: 'Purchase orders', noun: 'purchase orders', description: 'Purchase orders to vendors with budget category, value (incl. GST), status and approval.', dateField: 'raised_on', perms: ['procurement.manage'],
    aliases: ['po', 'pos', 'purchase order', 'purchase orders', 'purchase', 'purchases', 'procurement'],
    defaultColumns: ['number', 'vendor', 'category', 'project', 'amount', 'status', 'requested_by', 'raised_on'],
    fields: [
      S('number', 'PO number'), S('title', 'Description'), S('vendor', 'Vendor', { groupable: true, aliases: ['vendor', 'supplier'] }), S('category', 'Budget category', { groupable: true, aliases: ['category'] }), S('project', 'Project', { groupable: true }),
      M('amount', 'PO value (incl. GST)', { aliases: ['value', 'amount'] }), E('status', 'Status', 'po_status'), S('requested_by', 'Requested by', { groupable: true }), S('approver', 'Approver', { groupable: true }),
      B('approved', 'Approved'), B('is_pending', 'Pending approval'), B('over_budget', 'Over budget'), D('raised_on', 'Raised on'), D('needed_by', 'Needed by'), M('billed', 'Billed against PO'),
    ],
  },
  {
    id: 'vendor_bills', label: 'Vendor bills', noun: 'bills', description: 'Bills from vendors (payables) with GST, TDS, due date, status and payment.', dateField: 'due_on', perms: ['procurement.manage'],
    aliases: ['bill', 'bills', 'vendor bill', 'vendor bills', 'payable', 'payables', 'creditors'],
    defaultColumns: ['number', 'vendor', 'po', 'bill_date', 'due_on', 'total', 'status', 'days_overdue'],
    fields: [
      S('number', 'Bill no.'), S('vendor', 'Vendor', { groupable: true, aliases: ['vendor', 'supplier'] }), S('po', 'PO number'), S('category', 'Category', { groupable: true }),
      M('amount', 'Amount (before GST)'), M('gst', 'GST'), M('tds', 'TDS'), M('total', 'Bill total', { aliases: ['total', 'amount', 'value'] }), M('payable', 'Net payable (after TDS)', { aliases: ['payable'] }),
      D('bill_date', 'Bill date'), D('due_on', 'Due date', { aliases: ['due'] }), E('status', 'Status', 'bill_status'), D('paid_on', 'Paid on'), B('is_overdue', 'Overdue'), B('is_unpaid', 'Unpaid'), N('days_overdue', 'Days overdue', { unit: 'days' }),
    ],
  },
  {
    id: 'budget_vs_actual', label: 'Budget vs actual', noun: 'budget lines', description: 'Monthly budget against actual for every expense category (actual = ledger costs + approved claims and bills) and every revenue stream. Same numbers as Spend → Budgets.', dateField: 'month', perms: ['budgets.manage', 'finance.view'], actuals: true,
    aliases: ['budget', 'budgets', 'budget vs actual', 'variance', 'over budget', 'under budget', 'overspend'],
    defaultColumns: ['month', 'kind', 'category', 'budget', 'actual', 'variance'],
    fields: [
      S('category', 'Category', { groupable: true, aliases: ['category', 'head'] }), E('kind', 'Type', 'budget_kind'), D('month', 'Month'), M('budget', 'Budget', { aliases: ['budget'] }), M('actual', 'Actual', { aliases: ['actual', 'spend', 'spent'] }),
      M('variance', 'Variance', { description: 'Expense: budget − actual (negative = over). Revenue: actual − budget.', aliases: ['variance'] }), P('variance_pct', 'Variance %'), B('is_over', 'Over budget this month'),
      B('over_budget_ytd', 'Category over budget (FY to date)'), B('has_budget', 'Has a budget'),
    ],
  },
  {
    id: 'revenue_leakage', label: 'Revenue leakage', noun: 'leakage items', description: 'Revenue lost or at risk: lost deals, unbilled hours, bad-debt risk and rejected change requests (auto) plus discounts, write-offs, credit notes, penalties and churn (manual).', dateField: 'date', perms: ['leakage.view'],
    aliases: ['leakage', 'revenue leakage', 'lost revenue', 'leak', 'write off', 'write-off', 'discounts', 'bad debt', 'unbilled'],
    defaultColumns: ['date', 'kind', 'client', 'project', 'amount', 'recovered', 'net', 'status'],
    fields: [
      E('kind', 'Type', 'leakage_kind', { aliases: ['kind', 'type'] }), S('client', 'Client', { groupable: true }), S('project', 'Project', { groupable: true }), M('amount', 'Amount', { aliases: ['amount'] }),
      M('recovered', 'Recovered'), M('net', 'Net lost', { aliases: ['net', 'lost', 'lost revenue'] }), D('date', 'Date'), E('status', 'Status', 'leakage_status'), B('auto', 'System-detected'),
      B('recoverable', 'Recoverable'), S('reason', 'Reason'), S('source', 'Source'),
    ],
  },
  {
    id: 'appraisals', label: 'Appraisals', noun: 'appraisals', description: 'Appraisal reviews per cycle: self, manager and final rating, increment, on-time delivery and the system-suggested score. HR sees everyone; managers see their reports.', dateField: 'period_from', perms: ['appraisals.manage', 'people.view_all', 'team.view'],
    aliases: ['appraisal', 'appraisals', 'performance review', 'review cycle', 'rating', 'ratings', 'increment', 'increments'],
    defaultColumns: ['cycle', 'person', 'manager', 'status', 'self_rating', 'manager_rating', 'final_rating', 'increment_pct'],
    fields: [
      S('cycle', 'Cycle', { groupable: true, aliases: ['cycle'] }), D('period_from', 'Cycle start'), S('person', 'Person', { groupable: true, aliases: ['person', 'employee', 'who'] }), S('manager', 'Manager', { groupable: true, aliases: ['manager'] }),
      E('status', 'Status', 'appraisal_status'), N('self_rating', 'Self rating'), N('manager_rating', 'Manager rating'), N('final_rating', 'Final rating', { aliases: ['rating', 'final rating'] }),
      P('increment_pct', 'Increment', { aliases: ['increment', 'hike', 'raise'] }), P('on_time_pct', 'On-time delivery'), N('system_score', 'System score', { description: 'Suggested rating from goals, task delivery, timesheets and behaviour (1–5).' }),
      B('is_completed', 'Completed'), S('promotion_to', 'Promotion to'),
    ],
  },
  {
    id: 'candidates', label: 'Candidates', noun: 'candidates', description: 'Recruitment pipeline: candidates per opening with source, stage, experience, expected CTC and days in the pipeline.', dateField: 'applied_on', perms: ['recruitment.manage'],
    aliases: ['candidate', 'candidates', 'recruitment', 'hiring', 'applicant', 'applicants', 'opening', 'openings', 'pipeline of candidates'],
    defaultColumns: ['name', 'opening', 'source', 'stage', 'experience', 'days_in_pipeline'],
    fields: [
      S('opening', 'Opening', { groupable: true, aliases: ['opening', 'role', 'position'] }), S('name', 'Candidate'), E('source', 'Source', 'candidate_source', { aliases: ['source', 'channel'] }), E('stage', 'Stage', 'candidate_stage'),
      N('experience', 'Experience (years)', { aliases: ['experience'] }), M('expected_ctc', 'Expected CTC', { grant: 'salaries' }), N('days_in_pipeline', 'Days in pipeline', { unit: 'days' }), D('applied_on', 'Applied on'),
      N('rating', 'Rating'), B('is_active', 'In process'), B('is_hired', 'Hired'),
    ],
  },
  {
    id: 'documents', label: 'Documents', noun: 'documents', description: 'Project and company documents you can see: category, version, must-read status and acknowledgement counts (counts only where you manage the document).', dateField: 'updated_on', perms: [],
    aliases: ['document', 'documents', 'doc', 'docs', 'policy', 'policies', 'must read', 'must-read', 'acknowledged', 'acknowledgement', 'sop'],
    defaultColumns: ['title', 'project', 'category', 'version', 'must_read', 'acknowledged', 'pending'],
    fields: [
      S('title', 'Document'), S('project', 'Project', { groupable: true }), E('category', 'Category', 'doc_category', { aliases: ['category'] }), E('visibility', 'Visibility', 'doc_visibility'), N('version', 'Version'),
      B('must_read', 'Must read'), N('acknowledged', 'Acknowledged'), N('pending', 'Not yet acknowledged', { aliases: ['pending'] }), N('audience', 'Required readers'), P('ack_pct', 'Acknowledged %'),
      E('my_ack', 'My acknowledgement', 'my_ack'), S('owner', 'Owner', { groupable: true }), D('updated_on', 'Last updated'), B('archived', 'Archived'),
    ],
  },
  {
    id: 'okr_key_results', label: 'OKR key results', noun: 'key results', description: 'Key results under company, team and personal objectives with current vs target, progress and status. Auto metrics are computed live; finance metrics are hidden without finance access.', dateField: 'period_from', perms: [],
    aliases: ['okr', 'okrs', 'objective', 'objectives', 'key result', 'key results', 'goal', 'goals', 'kr', 'krs'],
    defaultColumns: ['objective', 'key_result', 'owner', 'current', 'target', 'progress_pct', 'status'],
    fields: [
      S('objective', 'Objective', { groupable: true }), S('key_result', 'Key result'), E('level', 'Level', 'okr_level'), S('owner', 'Owner', { groupable: true, aliases: ['owner', 'person', 'who'] }), S('objective_owner', 'Objective owner', { groupable: true }),
      S('period', 'Period', { groupable: true }), D('period_from', 'Period start'), E('metric', 'Metric', 'okr_metric'), N('current', 'Current'), N('target', 'Target'), S('unit', 'Unit'),
      P('progress_pct', 'Progress', { aliases: ['progress'] }), E('status', 'Status', 'okr_status'), E('objective_status', 'Objective status', 'okr_status'), B('auto', 'Auto-tracked'),
    ],
  },
]

export const DATASET_MAP = Object.fromEntries(DATASETS.map((d) => [d.id, d])) as Record<DatasetId, DatasetDefX>

export const AGG_LABEL: Record<Agg, string> = { sum: 'Total', avg: 'Average', count: 'Count', min: 'Lowest', max: 'Highest', count_distinct: 'Distinct' }
export const GRAIN_LABEL: Record<TimeGrain, string> = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', fy: 'Financial year' }
export const OP_LABEL: Record<FilterOp, string> = {
  eq: 'is', neq: 'is not', in: 'is any of', nin: 'is none of', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', between: 'between', is_empty: 'is empty', not_empty: 'is not empty',
}
export const PRESET_LABEL: Record<PeriodPreset, string> = {
  this_month: 'This month', last_month: 'Last month', this_quarter: 'This quarter', last_quarter: 'Last quarter', this_fy: 'This financial year', last_fy: 'Last financial year',
  last_30_days: 'Last 30 days', last_90_days: 'Last 90 days', last_6_months: 'Last 6 months', last_12_months: 'Last 12 months', ytd: 'Financial year to date', all: 'All time',
}
export const CHART_LABEL: Record<ChartKind, string> = { table: 'Table', bar: 'Bar', hbar: 'Horizontal bar', line: 'Line', area: 'Area', pie: 'Donut', stacked: 'Stacked bar', kpi: 'Number' }

/** Datasets and fields this viewer may use, from their effective permissions. Fields needing a grant
 *  (margins.view / cost_rates.view) or finance.view (adminOnly) are removed. */
export function datasetsFor(perms: ReadonlySet<string> | readonly string[]): DatasetDefX[] {
  const set = perms instanceof Set ? (perms as ReadonlySet<string>) : new Set(perms as readonly string[])
  const margins = set.has('margins.view')
  const salaries = set.has('cost_rates.view')
  const finance = set.has('finance.view')
  return DATASETS.filter((d) => !d.perms.length || d.perms.some((k) => set.has(k))).map((d) => ({
    ...d,
    fields: d.fields.filter((f) => (f.grant === 'margins' ? margins : f.grant === 'salaries' ? salaries : true) && (!f.adminOnly || finance)),
  }))
}
export function fieldOf(ds: DatasetDef, key: string): FieldDefX | undefined {
  return (ds.fields as FieldDefX[]).find((f) => f.key === key)
}

/** Opsions allowed for a field type. */
export function opsFor(t: FieldDef['type']): FilterOp[] {
  if (t === 'number' || t === 'money' || t === 'percent') return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty']
  if (t === 'date') return ['eq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_empty', 'not_empty']
  if (t === 'boolean') return ['eq']
  if (t === 'enum') return ['eq', 'neq', 'in', 'nin', 'is_empty', 'not_empty']
  return ['eq', 'neq', 'contains', 'in', 'is_empty', 'not_empty']
}

/** Aggregations that make sense for a field type. */
export function aggsFor(t: FieldDef['type']): Agg[] {
  if (t === 'number' || t === 'money') return ['sum', 'avg', 'min', 'max']
  if (t === 'percent') return ['avg', 'min', 'max']
  if (t === 'date') return ['min', 'max', 'count_distinct']
  return ['count_distinct']
}
