// v4 permission catalogue. Every capability in SeereonOS is a permission key; roles are data
// (RoleDef rows per tenant) that bundle keys. A user's effective permissions are
//   role.permissions ∪ user.extra_permissions − user.revoked_permissions.
// The UI hides what a user cannot do; the server (mock and real) enforces the same keys.
import type { Role } from '@/types/entities'

export type PermissionModule = 'my_work' | 'delivery' | 'team' | 'people' | 'sales' | 'finance' | 'company' | 'admin' | 'access'

export const MODULE_LABEL: Record<PermissionModule, string> = {
  my_work: 'My work',
  delivery: 'Projects & delivery',
  team: 'Team & performance',
  people: 'People & HR',
  sales: 'Sales & clients',
  finance: 'Finance & spend',
  company: 'Reports & company',
  admin: 'Workspace administration',
  access: 'Users, roles & controls',
}
export const MODULE_ORDER: PermissionModule[] = ['my_work', 'delivery', 'team', 'people', 'sales', 'finance', 'company', 'admin', 'access']

export type PermissionKind = 'view' | 'create' | 'edit' | 'approve' | 'manage' | 'sensitive'

export interface PermissionDef {
  key: string
  label: string
  description: string
  module: PermissionModule
  kind: PermissionKind
  /** Shown with a lock badge; granting it is itself a sensitive change. */
  sensitive?: boolean
  /** Permissions this one implies are needed to be useful (UI auto-ticks them). */
  requires?: string[]
}

const P = (module: PermissionModule, key: string, label: string, description: string, kind: PermissionKind, extra: Partial<PermissionDef> = {}): PermissionDef => ({ key, label, description, module, kind, ...extra })

export const PERMISSIONS = [
  // My work — the self-service floor
  P('my_work', 'timesheet.own', 'Log own timesheet', 'Fill and submit weekly timesheets.', 'create'),
  P('my_work', 'daily_update.post', 'Post daily updates', 'Post the daily stand-up update with proof.', 'create'),
  P('my_work', 'approvals.act', 'Act on own approvals', 'Approve items routed to them (reports-to and workflow scope still apply).', 'approve'),
  P('my_work', 'ai.use', 'Use Ask AI', 'Ask questions in plain language and build AI reports within their own data access.', 'view'),

  // Delivery
  P('delivery', 'projects.view_all', 'See all projects', 'Every project in the company, not only the ones they work on.', 'view'),
  P('delivery', 'projects.create', 'Create projects', 'Start new projects and import a WBS.', 'create'),
  P('delivery', 'projects.edit', 'Edit projects they manage', 'Plan, milestones, status and team of projects where they are the PM.', 'edit'),
  P('delivery', 'projects.manage_all', 'Manage every project', 'Edit any project and its tasks, and hand a project to another project manager.', 'manage', { requires: ['projects.view_all', 'projects.edit'] }),
  P('delivery', 'tasks.edit', 'Plan and edit tasks', 'Create, assign and reschedule project tasks.', 'edit'),
  P('delivery', 'tasks.status_any', 'Change any task status', 'Move tasks that are owned by someone else.', 'edit'),
  P('delivery', 'allocation.edit', 'Allocate people', 'Change allocation % of people on projects.', 'edit'),
  P('delivery', 'change_requests.manage', 'Handle change requests', 'Raise, price and close client change requests.', 'manage'),
  P('delivery', 'documents.manage', 'Manage project documents', 'Upload, version and archive project documents.', 'manage'),
  P('delivery', 'estimates.manage', 'Project cost calculator', 'Estimate cost, margin and price for prospective projects before they exist; convert an estimate into a project.', 'create'),
  P('delivery', 'documents.view_all', 'See all project documents', 'Open documents of projects they are not on.', 'view'),
  P('delivery', 'openings.manage', 'Manage openings', 'Raise and track staffing openings.', 'manage'),

  // Team & performance
  P('team', 'team.view', 'See team pages', 'Team workload, timesheets and availability of their reports.', 'view'),
  P('team', 'tasks.assign_team', 'Assign tasks to reports', 'Give general tasks to people who report to them.', 'create'),
  P('team', 'tasks.review', 'Review submitted tasks', 'Approve or send back tasks where they are the reviewer.', 'approve'),
  P('team', 'tasks.view_all', 'See all tasks', 'Every task in the company with a filter by employee (managers, HR, admins, CXOs). Without it people see only their own tasks.', 'view'),
  P('team', 'tasks.analytics', 'Task timeliness analytics', 'Early / on-time / late completion and delay reasons across people.', 'view'),
  P('team', 'insights.view', 'Insights & scorecards', 'Manager dashboards and scorecards.', 'view'),
  P('team', 'delegations.manage', 'Delegate approvals', 'Hand approvals to someone else while away.', 'manage'),

  // People & HR
  P('people', 'people.view_all', 'See everyone’s HR records', 'Profiles, leave and lifecycle of all employees.', 'view'),
  P('people', 'people.manage', 'Manage HR operations', 'Lifecycle checklists, assets and leave policy.', 'manage'),
  P('people', 'leave.approve', 'Approve leave', 'Approve leave for people in their approval scope.', 'approve'),
  P('people', 'leave.hr_entry', 'Record leave for others', 'Enter leave on behalf of employees.', 'edit'),
  P('people', 'appraisals.manage', 'Run appraisals', 'Open cycles, calibrate and close appraisals.', 'manage'),
  P('people', 'recruitment.manage', 'Recruitment', 'Candidates, interviews and offers.', 'manage'),
  P('people', 'cost_rates.view', 'See salaries & cost rates', 'CTC and cost per hour (read-only).', 'sensitive', { sensitive: true }),
  P('people', 'cost_rates.edit', 'Change salaries & cost rates', 'Set CTC and cost per hour.', 'sensitive', { sensitive: true, requires: ['cost_rates.view'] }),
  P('people', 'payroll.run', 'Prepare payroll', 'Create and calculate monthly payroll runs.', 'sensitive', { sensitive: true }),
  P('people', 'payroll.finalise', 'Finalise payroll', 'Lock a payroll run and post it to the ledger.', 'sensitive', { sensitive: true, requires: ['payroll.run'] }),

  // Sales
  P('sales', 'deals.view_all', 'See all deals', 'The whole pipeline, not only deals they own.', 'view'),
  P('sales', 'deals.edit_own', 'Work own deals', 'Create deals and move deals they own.', 'edit'),
  P('sales', 'deals.edit_all', 'Edit any deal', 'Reassign and edit anyone’s deals.', 'manage', { requires: ['deals.view_all', 'deals.edit_own'] }),
  P('sales', 'sales.performance_own', 'Own sales performance', 'Their own targets, attainment and incentives.', 'view'),
  P('sales', 'sales.performance_all', 'Team sales performance', 'Targets and attainment of the whole sales team.', 'view'),
  P('sales', 'clients.manage', 'Manage clients & contracts', 'Client master, contracts and renewals.', 'manage'),

  // Finance & spend
  P('finance', 'finance.view', 'See finance', 'Invoices, payments, revenue and the CEO dashboard.', 'view', { sensitive: true }),
  P('finance', 'finance.edit', 'Raise invoices & record payments', 'Create invoices and record receipts.', 'edit', { sensitive: true, requires: ['finance.view'] }),
  P('finance', 'margins.view', 'See project margins', 'Revenue, cost and margin of projects they can see.', 'sensitive', { sensitive: true }),
  P('finance', 'ledger.view', 'See the ledger', 'Company income and expense ledger.', 'view'),
  P('finance', 'ops.manage', 'Operations register', 'Recurring company costs, renewals and compliance items.', 'manage'),
  P('finance', 'expenses.approve', 'Approve expense claims', 'Approve claims in their workflow step.', 'approve'),
  P('finance', 'expenses.pay', 'Pay expense claims', 'Mark approved claims as reimbursed.', 'sensitive', { sensitive: true }),
  P('finance', 'procurement.manage', 'Procurement', 'Vendors, purchase orders and vendor bills.', 'manage'),
  P('finance', 'budgets.manage', 'Budgets', 'Set department and project budgets.', 'manage'),
  P('finance', 'leakage.view', 'Revenue leakage', 'Lost and unbilled revenue analysis.', 'view', { sensitive: true }),

  // Reports & company
  P('company', 'reports.view', 'Open reports', 'Standard and saved reports within their data access.', 'view'),
  P('company', 'reports.build', 'Build custom reports', 'Custom report builder and AI report studio.', 'create', { requires: ['reports.view'] }),
  P('company', 'okrs.manage', 'Company OKRs', 'Set objectives and key results.', 'manage'),
  P('company', 'documents.templates', 'Document templates & issuing', 'Create letter templates (offer, joining, appraisal, payslip…) and issue documents to employees.', 'manage'),
  P('company', 'documents.employee_files', 'Employee documents', 'See, upload and verify documents of every employee.', 'sensitive', { sensitive: true }),
  P('company', 'workflows.design', 'Design workflows', 'Create multi-stage workflows with reviewer parameters and automatic actions.', 'manage'),
  P('company', 'workflows.start', 'Start workflows for others', 'Launch workflows (e.g. an appraisal cycle) for employees.', 'create'),
  P('company', 'documents.company', 'Company library', 'Manage policies and company-wide documents.', 'manage'),
  P('company', 'audit.view', 'Audit trail', 'Who changed what, and when.', 'view'),
  P('company', 'data.export', 'Export all data', 'Full workspace data export.', 'sensitive', { sensitive: true }),

  // Workspace administration
  P('admin', 'settings.edit', 'Company settings', 'Calendar, timesheet, pay and project rules.', 'manage'),
  P('admin', 'theme.edit', 'Brand & appearance', 'Workspace colours, fonts and logo.', 'manage'),
  P('admin', 'holidays.edit', 'Holiday calendar', 'Add and remove company holidays.', 'manage'),
  P('admin', 'master.view', 'See master data', 'Org profile, locations, departments, designations, grades and shifts.', 'view'),
  P('admin', 'master.edit', 'Edit master data', 'Change the organisation’s master data.', 'manage', { requires: ['master.view'] }),
  P('admin', 'shifts.manage', 'Shifts', 'Create shifts and assign people to them.', 'manage', { requires: ['master.view'] }),
  P('admin', 'workflows.manage', 'Approval workflows', 'Who approves what, in which order, with SLAs.', 'manage', { requires: ['master.view'] }),
  P('admin', 'emails.view', 'Email templates & outbox', 'Edit templates and see emails the system sent.', 'manage'),
  P('admin', 'billing.manage', 'Billing & plan', 'Subscription, seats and invoices for SeereonOS.', 'manage'),

  // Users, roles & controls
  P('access', 'users.view', 'See users', 'The user list with roles and status.', 'view'),
  P('access', 'users.manage', 'Manage user access', 'Change a user’s role, reporting line and extra permissions.', 'sensitive', { sensitive: true, requires: ['users.view'] }),
  P('access', 'employees.create', 'Create employees', 'Onboard a new employee and send the welcome email.', 'create', { requires: ['users.view'] }),
  P('access', 'employees.edit', 'Edit employee records', 'Job details, department, designation, shift.', 'edit', { requires: ['users.view'] }),
  P('access', 'employees.deactivate', 'Deactivate employees', 'Turn off access when someone leaves.', 'sensitive', { sensitive: true, requires: ['users.view'] }),
  P('access', 'roles.view', 'See roles', 'Roles and their permission matrix.', 'view'),
  P('access', 'roles.manage', 'Manage roles', 'Create roles and change what each role can do.', 'sensitive', { sensitive: true, requires: ['roles.view'] }),
  P('access', 'makerchecker.check', 'Check changes (maker-checker)', 'Approve or reject sensitive changes made by someone else.', 'approve'),
  P('access', 'makerchecker.configure', 'Configure maker-checker', 'Choose which changes need a second person.', 'sensitive', { sensitive: true }),
  P('access', 'view_as', 'View as another role', 'Preview the product as any role (read-only).', 'view'),
] as const satisfies readonly PermissionDef[]

export type PermissionKey = (typeof PERMISSIONS)[number]['key']
export const PERMISSION_KEYS: PermissionKey[] = PERMISSIONS.map((p) => p.key)
export const PERMISSION_BY_KEY: Record<string, PermissionDef> = Object.fromEntries(PERMISSIONS.map((p) => [p.key, p]))
export const isPermissionKey = (k: string): k is PermissionKey => k in PERMISSION_BY_KEY

/* ------------------------------------------------------------------ */
/* Default roles shipped with every workspace                           */
/* ------------------------------------------------------------------ */
export interface DefaultRole {
  key: string
  name: string
  description: string
  persona: Role
  permissions: PermissionKey[]
  /** Administrator cannot lose role/user management — there must always be a way back in. */
  locked?: boolean
}

const BASE: PermissionKey[] = ['timesheet.own', 'daily_update.post', 'approvals.act', 'ai.use']
const DELIVERY_LEAD: PermissionKey[] = [
  'tasks.view_all', 'estimates.manage', 'projects.create', 'projects.edit', 'tasks.edit', 'tasks.status_any', 'allocation.edit', 'change_requests.manage', 'documents.manage', 'openings.manage',
  'team.view', 'tasks.assign_team', 'tasks.review', 'tasks.analytics', 'insights.view', 'delegations.manage', 'leave.approve', 'expenses.approve', 'recruitment.manage', 'reports.view', 'reports.build',
]
const uniq = (a: PermissionKey[]) => [...new Set(a)]

export const DEFAULT_ROLES: DefaultRole[] = [
  {
    key: 'administrator', name: 'Administrator', persona: 'admin', locked: true,
    description: 'Sets up the workspace: master data, users, roles and controls. Full access.',
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'ceo', name: 'CEO', persona: 'admin',
    description: 'Runs the company. Sees every number and is the final approver.',
    permissions: [...PERMISSION_KEYS],
  },
  {
    key: 'cto', name: 'CTO', persona: 'pm',
    description: 'Owns delivery and technology across all projects, without company finance.',
    permissions: uniq([...BASE, ...DELIVERY_LEAD, 'projects.view_all', 'projects.manage_all', 'documents.view_all', 'margins.view', 'people.view_all', 'users.view', 'roles.view', 'master.view', 'audit.view']),
  },
  {
    key: 'project_manager', name: 'Project Manager', persona: 'pm',
    description: 'Plans and delivers projects, assigns and reviews the team’s work.',
    permissions: uniq([...BASE, ...DELIVERY_LEAD]),
  },
  {
    key: 'hr_manager', name: 'HR Manager', persona: 'ops',
    description: 'Owns people operations: onboarding, leave, appraisals, payroll preparation and procurement.',
    permissions: uniq([
      ...BASE, 'projects.view_all', 'openings.manage', 'team.view', 'tasks.assign_team', 'tasks.review', 'tasks.analytics', 'insights.view', 'delegations.manage',
      'people.view_all', 'people.manage', 'leave.approve', 'leave.hr_entry', 'appraisals.manage', 'recruitment.manage', 'cost_rates.view', 'payroll.run',
      'ledger.view', 'ops.manage', 'expenses.approve', 'expenses.pay', 'procurement.manage', 'reports.view', 'reports.build', 'documents.company', 'holidays.edit',
      'master.view', 'master.edit', 'shifts.manage', 'emails.view', 'tasks.view_all', 'documents.templates', 'documents.employee_files', 'workflows.design', 'workflows.start', 'users.view', 'employees.create', 'employees.edit', 'employees.deactivate', 'roles.view', 'makerchecker.check',
    ]),
  },
  {
    key: 'hr_executive', name: 'HR Executive', persona: 'ops',
    description: 'Day-to-day HR: onboards employees, records leave, runs recruitment. Sensitive changes go to the HR Manager.',
    permissions: uniq([...BASE, 'tasks.view_all', 'documents.templates', 'documents.employee_files', 'workflows.start', 'people.view_all', 'leave.hr_entry', 'recruitment.manage', 'openings.manage', 'documents.company', 'ops.manage', 'reports.view', 'master.view', 'emails.view', 'users.view', 'employees.create', 'employees.edit']),
  },
  {
    key: 'sales_manager', name: 'Sales Manager', persona: 'sales',
    description: 'Runs the sales team and the whole pipeline.',
    permissions: uniq([
      ...BASE, 'deals.view_all', 'deals.edit_own', 'deals.edit_all', 'sales.performance_own', 'sales.performance_all', 'clients.manage',
      'team.view', 'tasks.assign_team', 'tasks.review', 'tasks.view_all', 'estimates.manage', 'insights.view', 'delegations.manage', 'leave.approve', 'expenses.approve', 'reports.view', 'reports.build', 'leakage.view',
    ]),
  },
  {
    key: 'sales_executive', name: 'Sales Executive', persona: 'sales',
    description: 'Works their own deals and clients.',
    permissions: uniq([...BASE, 'deals.edit_own', 'sales.performance_own', 'clients.manage', 'insights.view', 'reports.view', 'reports.build']),
  },
  {
    key: 'employee', name: 'Employee', persona: 'employee',
    description: 'Self-service: tasks, timesheets, leave, expenses, documents and appraisal.',
    permissions: [...BASE],
  },
]
export const LOCKED_PERMISSIONS: PermissionKey[] = ['roles.view', 'roles.manage', 'users.view', 'users.manage']

export const PERSONA_LABEL: Record<Role, string> = {
  admin: 'Leadership dashboard',
  pm: 'Delivery dashboard',
  sales: 'Sales dashboard',
  ops: 'HR & operations dashboard',
  employee: 'Employee home',
}

/** Effective permissions of a user given their role's permissions and per-user overrides. */
export function effectivePermissions(rolePerms: readonly string[] | undefined, extra: readonly string[] = [], revoked: readonly string[] = []): string[] {
  const set = new Set<string>([...(rolePerms ?? []), ...extra])
  for (const r of revoked) set.delete(r)
  return [...set].filter(isPermissionKey).sort()
}
