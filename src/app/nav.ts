import type { LucideIcon } from '@/ui/icons'
import {
  BarChart3, Briefcase, Building2, Calculator, CalendarClock, CheckSquare, ClipboardCheck, ClipboardList, Coins, CreditCard, Database, Eye, FileBarChart, FileText, FileUp,
  Flag, FolderKanban, Gauge, GitBranch, HandCoins, History, Home, Inbox, Laptop, LineChart, ListChecks, ListTree, Palmtree, Plus, Receipt, Route, Settings, Shield,
  SlidersHorizontal, Sparkles, Stamp, Target, TrendingDown, TrendingUp, Trophy, UserCheck, UserPlus, Users, Wallet, Workflow, Wrench, Award, BookOpen, PencilRuler, Paperclip, Landmark, UserCog,
} from '@/ui/icons'
const Milestone = Flag
const Openings = Briefcase
const TeamIcon = UserCog
const DocFolder = Paperclip
const Org = Landmark
const FilePlus = Plus
import type { Action } from '@/domain/permissions'
import type { Role } from '@/types/entities'

/**
 * Sidebar information architecture (v7): top-level items, some of which are groups with children.
 * A group (an item with `children`) is not a link itself: it opens and closes. `to` is still set on a group — it is
 * the group's id (used to remember open/closed state) and where the collapsed rail sends a click.
 * Permission filtering (`action` / `anyOf`) applies to groups and children; a group whose children are all hidden is hidden.
 */
export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  action?: Action
  /** Visible when the user holds any of these (used for areas with several entry permissions). */
  anyOf?: Action[]
  roles?: Role[]
  badge?: 'approvals' | 'notifications' | 'changes'
  /** Only an exact path match makes this item active (not its sub-paths). */
  end?: boolean
  /** Extra words for the command palette. */
  keywords?: string
  children?: NavItem[]
}
export interface NavSection {
  title: string | null
  items: NavItem[]
}

export const SETUP_NAV_ACTIONS: Action[] = ['master.view', 'roles.view', 'makerchecker.configure', 'workflows.manage', 'emails.view']
/** Anyone who can check changes, or make a change that may need checking, sees the change queue. */
export const CHANGE_NAV_ACTIONS: Action[] = ['makerchecker.check', 'makerchecker.configure', 'roles.manage', 'users.manage', 'workflows.manage', 'master.edit', 'cost_rates.edit', 'payroll.finalise', 'procurement.manage', 'budgets.manage']

/** Project-scoped delivery areas reachable without opening a project first (/delivery/<area>). Same gates as the project tabs. */
export const DELIVERY_GATES = {
  milestones: ['projects.view_all', 'projects.edit', 'finance.view'] as Action[],
  change_requests: ['change_requests.manage', 'projects.view_all'] as Action[],
  allocation: ['allocation.edit', 'projects.view_all'] as Action[],
  costing: 'margins.view' as Action,
  import: 'projects.edit' as Action,
  client_view: ['projects.view_all', 'projects.edit'] as Action[],
}

export const NAV: NavSection[] = [
  {
    title: null,
    items: [
      { to: '/home', label: 'Dashboard', icon: Home, keywords: 'home' },
      { to: '/inbox', label: 'Approvals inbox', icon: Inbox, badge: 'approvals', keywords: 'approve pending' },
      { to: '/ai', label: 'Ask AI', icon: Sparkles, action: 'ai.use' },
    ],
  },
  {
    title: null,
    items: [
      {
        to: 'grp:mywork',
        label: 'My work',
        icon: CheckSquare,
        children: [
          { to: '/my-tasks', label: 'My tasks', icon: CheckSquare },
          // Feature Guide tab "Timesheet & log": the weekly timesheet, end-of-day update and Friday demo (/daily redirects here)
          { to: '/timesheet', label: 'Timesheet & log', icon: CalendarClock, keywords: 'daily update demo hours' },
          { to: '/leave', label: 'Leave', icon: Palmtree, keywords: 'holiday time off' },
          { to: '/expenses', label: 'Expenses', icon: Receipt, keywords: 'claims reimbursement' },
          { to: '/performance', label: 'My performance', icon: Trophy, keywords: 'appraisal kpi' },
        ],
      },
      {
        to: 'grp:projects',
        label: 'Projects & WBS',
        icon: FolderKanban,
        keywords: 'projects wbs delivery',
        children: [
          { to: '/projects', label: 'All projects', icon: FolderKanban, keywords: 'projects wbs list' },
          { to: '/projects/new', label: 'Create project', icon: Plus, action: 'projects.create', end: true, keywords: 'new project' },
          { to: '/projects/cost-calculator', label: 'Project cost calculator', icon: Calculator, action: 'estimates.manage', keywords: 'estimate prospective price quote' },
          { to: '/delivery/milestones', label: 'Milestones & billing', icon: Milestone, anyOf: DELIVERY_GATES.milestones, keywords: 'milestone billing invoice deadline' },
          { to: '/delivery/wbs', label: 'WBS', icon: ListTree, keywords: 'work breakdown tasks plan' },
          { to: '/delivery/schedule', label: 'Schedule & critical path', icon: Route, keywords: 'gantt critical path float' },
          { to: '/delivery/change-requests', label: 'Change requests', icon: GitBranch, anyOf: DELIVERY_GATES.change_requests, keywords: 'cr scope change' },
          { to: '/delivery/allocation', label: 'Resource allocation', icon: Users, anyOf: DELIVERY_GATES.allocation, keywords: 'team allocation load capacity' },
          { to: '/delivery/costing', label: 'Costing & margin', icon: Coins, action: DELIVERY_GATES.costing, keywords: 'budget cost margin money' },
          { to: '/delivery/documents', label: 'Project documents', icon: DocFolder, keywords: 'sow contract files' },
          { to: '/client-view', label: 'Client view', icon: Eye, anyOf: DELIVERY_GATES.client_view, keywords: 'status report client' },
          { to: '/delivery/import', label: 'Import WBS', icon: FileUp, action: DELIVERY_GATES.import, keywords: 'excel upload wbs' },
        ],
      },
      {
        to: 'grp:tasks',
        label: 'Tasks',
        icon: ListChecks,
        children: [
          // Feature Guide §7: the Tasks tab, for everyone (server scopes what each person sees)
          { to: '/tasks', label: 'All tasks', icon: ListChecks, keywords: 'tasks' },
          { to: '/tasks/new', label: 'Create task', icon: Plus, end: true, keywords: 'new task assign' },
          { to: '/team-tasks', label: 'Team tasks', icon: ClipboardList, action: 'tasks.assign_team' },
          { to: '/approvals', label: 'Timesheet approvals', icon: ClipboardCheck, anyOf: ['team.view', 'leave.approve', 'tasks.review', 'people.view_all'] },
        ],
      },
      {
        to: 'grp:workflows',
        label: 'Workflows',
        icon: Workflow,
        children: [
          { to: '/workflows', label: 'Workflow inbox', icon: Inbox, end: true, keywords: 'workflow review stage' },
          { to: '/workflows/designer', label: 'Workflow designer', icon: PencilRuler, action: 'workflows.design', keywords: 'design workflow template' },
        ],
      },
    ],
  },
  {
    title: null,
    items: [
      {
        to: 'grp:people',
        label: 'People',
        icon: Users,
        children: [
          { to: '/appraisals', label: 'Appraisals', icon: Award, action: 'appraisals.manage' },
          { to: '/recruitment', label: 'Recruitment', icon: UserPlus, action: 'recruitment.manage', keywords: 'candidates hiring' },
          { to: '/openings', label: 'Openings', icon: Openings, action: 'openings.manage' },
          { to: '/lifecycle', label: 'Onboarding & exits', icon: UserCheck, action: 'people.manage' },
          { to: '/assets', label: 'Assets', icon: Laptop, action: 'people.manage' },
          { to: '/team', label: 'Team', icon: TeamIcon, action: 'team.view', keywords: 'utilisation timesheet grid' },
        ],
      },
      {
        to: 'grp:sales',
        label: 'Sales',
        icon: Target,
        children: [
          { to: '/sales', label: 'Pipeline', icon: Target, action: 'deals.edit_own', end: true, keywords: 'deals' },
          { to: '/sales/activity', label: 'Activity log', icon: History, action: 'deals.edit_own' },
          { to: '/clients', label: 'Clients & contracts', icon: Building2, action: 'clients.manage' },
          { to: '/sales/performance', label: 'Performance', icon: TrendingUp, action: 'sales.performance_own' },
          { to: '/sales/compensation', label: 'Compensation', icon: HandCoins, action: 'sales.performance_own', keywords: 'commission incentive' },
        ],
      },
      {
        to: 'grp:finance',
        label: 'Finance',
        icon: Wallet,
        children: [
          { to: '/finance/invoices', label: 'Invoices', icon: Receipt, action: 'finance.view' },
          { to: '/finance/invoices/new', label: 'Create invoice', icon: FilePlus, action: 'finance.edit', end: true, keywords: 'gst invoice new bill' },
          { to: '/finance/margins', label: 'Profit margins', icon: TrendingUp, action: 'margins.view' },
          { to: '/purchases', label: 'Purchases & vendors', icon: CreditCard, action: 'procurement.manage' },
          { to: '/budgets', label: 'Budgets', icon: Wallet, action: 'budgets.manage' },
          { to: '/leakage', label: 'Lost revenue', icon: TrendingDown, action: 'leakage.view' },
          { to: '/finance/ledger', label: 'Ledger', icon: Database, action: 'ledger.view' },
          { to: '/finance/pnl', label: 'Profit & loss', icon: LineChart, action: 'finance.view' },
          { to: '/payroll', label: 'Payroll', icon: Coins, action: 'payroll.run' },
        ],
      },
      {
        to: 'grp:documents',
        label: 'Documents',
        icon: FileText,
        children: [
          { to: '/documents?tab=templates', label: 'Templates', icon: FileText, action: 'documents.templates', keywords: 'payslip offer letter joining letter template' },
          { to: '/documents?tab=issued', label: 'Issued documents', icon: Stamp, action: 'documents.templates', keywords: 'letters issued shared' },
          { to: '/documents?tab=policies', label: 'Policies', icon: Shield, keywords: 'policy handbook' },
          { to: '/documents?tab=employees', label: 'Employee documents', icon: Users, action: 'documents.employee_files', keywords: 'employee files uploads' },
          { to: '/documents?tab=mine', label: 'My documents', icon: FileText, keywords: 'payslips letters my files' },
        ],
      },
      {
        to: 'grp:company',
        label: 'Company',
        icon: Org,
        children: [
          { to: '/scorecard', label: 'Weekly scorecard', icon: Gauge, action: 'insights.view', keywords: 'scorecard' },
          { to: '/insights', label: 'Insights', icon: BarChart3, action: 'insights.view' },
          { to: '/okrs', label: 'Goals & OKRs', icon: Flag },
          { to: '/operations', label: 'Operations', icon: Wrench, action: 'ops.manage' },
          { to: '/reports', label: 'Reports', icon: FileBarChart, action: 'reports.view' },
          { to: '/audit', label: 'Audit trail', icon: History, action: 'audit.view' },
          { to: '/rules', label: 'Rules', icon: BookOpen, keywords: 'rules kpis kpi definitions' },
        ],
      },
      {
        to: 'grp:admin',
        label: 'Admin',
        icon: SlidersHorizontal,
        children: [
          { to: '/setup', label: 'Organisation setup', icon: SlidersHorizontal, anyOf: SETUP_NAV_ACTIONS, keywords: 'master data roles departments' },
          { to: '/people', label: 'People & users', icon: Users, action: 'users.view', keywords: 'employees users' },
          { to: '/changes', label: 'Change approvals', icon: Stamp, anyOf: CHANGE_NAV_ACTIONS, badge: 'changes', keywords: 'maker checker' },
          { to: '/billing', label: 'Billing', icon: CreditCard, action: 'billing.manage', keywords: 'plan subscription' },
          { to: '/settings', label: 'Team & settings', icon: Settings, keywords: 'settings team profile' },
        ],
      },
    ],
  },
]

export const SUPER_NAV: NavSection[] = [
  { title: null, items: [{ to: '/admin', label: 'Tenants', icon: Building2 }, { to: '/settings/profile', label: 'My profile', icon: Settings }] },
]

/** Bottom tab bar on phones: four role-specific shortcuts + More (the More sheet shows the full hierarchy). */
export const MOBILE_TABS: Record<Role, NavItem[]> = {
  admin: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'approvals' },
  ],
  pm: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/projects', label: 'Projects', icon: FolderKanban },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/inbox', label: 'Inbox', icon: Inbox, badge: 'approvals' },
  ],
  sales: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/sales', label: 'Pipeline', icon: Target },
    { to: '/ai', label: 'Ask AI', icon: Sparkles },
    { to: '/timesheet', label: 'Timesheet', icon: CalendarClock },
  ],
  ops: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/operations', label: 'Ops', icon: Wrench },
    { to: '/ai', label: 'Ask AI', icon: Sparkles },
    { to: '/timesheet', label: 'Timesheet', icon: CalendarClock },
  ],
  employee: [
    { to: '/home', label: 'Dashboard', icon: Home },
    { to: '/tasks', label: 'Tasks', icon: ListChecks },
    { to: '/ai', label: 'Ask AI', icon: Sparkles },
    { to: '/timesheet', label: 'Timesheet', icon: CalendarClock },
  ],
}

/* ---------------- matching & filtering helpers (shared by the sidebar, More sheet and command palette) ---------------- */

export type Can = (a: Action) => boolean
export const isGroup = (i: NavItem) => !!i.children?.length
const allowed = (i: NavItem, can: Can) => (!i.action || can(i.action)) && (!i.anyOf || i.anyOf.some((a) => can(a)))

/** Items the user may see; groups keep only visible children and disappear when none are left. */
export function filterNav(sections: NavSection[], can: Can): NavSection[] {
  return sections
    .map((s) => ({
      ...s,
      items: s.items
        .filter((i) => allowed(i, can))
        .map((i) => (i.children ? { ...i, children: i.children.filter((c) => allowed(c, can)) } : i))
        .filter((i) => !i.children || i.children.length > 0),
    }))
    .filter((s) => s.items.length)
}

/** Every link (children flattened, groups dropped) with its group label. */
export type FlatNavItem = NavItem & { group: string | null }
export function flattenNav(sections: NavSection[]): FlatNavItem[] {
  return sections.flatMap((s) => s.items.flatMap((i): FlatNavItem[] => (i.children ? i.children.map((c) => ({ ...c, group: i.label })) : [{ ...i, group: null }])))
}

function splitTo(to: string) {
  const [path, qs = ''] = to.split('?')
  return { path, params: new URLSearchParams(qs) }
}

/**
 * The single best-matching link for a location: the longest path that equals or prefixes the current path
 * (`end` items need an exact match); query parameters on a link must match the URL, and a link whose parameter
 * is absent from the URL still matches (the first such link wins — e.g. /documents with no tab).
 */
export function activeLink(links: NavItem[], pathname: string, search: string): string | null {
  const cur = new URLSearchParams(search)
  let best: { to: string; score: number } | null = null
  for (const l of links) {
    if (isGroup(l)) continue
    const { path, params } = splitTo(l.to)
    const exact = pathname === path
    const prefix = !l.end && path !== '/' && pathname.startsWith(path + '/')
    if (!exact && !prefix) continue
    let score = path.length * 4 + (exact ? 2 : 0)
    let conflict = false
    params.forEach((v, k) => {
      const c = cur.get(k)
      if (c === null) return
      if (c === v) score += 1
      else conflict = true
    })
    if (conflict) continue
    if (!best || score > best.score) best = { to: l.to, score }
  }
  return best?.to ?? null
}
