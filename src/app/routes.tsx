import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { createBrowserRouter, createHashRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom'
import { useSession } from '@/stores/session'
import { applyTheme } from '@/theme/theme'
import { DEFAULT_THEME } from '@/mock/seed'
import { authApi } from '@/api/core'
import { useApi } from '@/api/query'
import AppShell, { PageLoading } from './AppShell'
import { useCan } from '@/ui'
import type { Action } from '@/domain/permissions'
import { CHANGE_NAV_ACTIONS, DELIVERY_GATES, SETUP_NAV_ACTIONS } from './nav'
import { ErrorState } from '@/ui'

const L = <T,>(f: () => Promise<{ default: T }>) => lazy(f as never)

// A — access & admin
const LoginPage = L(() => import('@/modules/auth/LoginPage'))
const SignupPage = L(() => import('@/modules/auth/SignupPage'))
const ResetPasswordPage = L(() => import('@/modules/auth/ResetPasswordPage'))
const InvitePage = L(() => import('@/modules/auth/InvitePage'))
const LegalPage = L(() => import('@/modules/auth/LegalPage'))
const OnboardingPage = L(() => import('@/modules/admin/OnboardingPage'))
const PeoplePage = L(() => import('@/modules/admin/PeoplePage'))
const SettingsLayout = L(() => import('@/modules/admin/SettingsLayout'))
const CompanySettingsPage = L(() => import('@/modules/admin/CompanySettingsPage'))
const AppearancePage = L(() => import('@/modules/admin/AppearancePage'))
const HolidaysPage = L(() => import('@/modules/admin/HolidaysPage'))
const CostRatesPage = L(() => import('@/modules/admin/CostRatesPage'))
const DelegationsPage = L(() => import('@/modules/admin/DelegationsPage'))
const SecurityPage = L(() => import('@/modules/admin/SecurityPage'))
const DataPage = L(() => import('@/modules/admin/DataPage'))
const ProfilePage = L(() => import('@/modules/admin/ProfilePage'))
const BillingPage = L(() => import('@/modules/admin/BillingPage'))
const SuperAdminPage = L(() => import('@/modules/admin/SuperAdminPage'))
// v4 — setup, access, maker-checker
const SetupLayout = L(() => import('@/modules/setup/SetupLayout'))
const SetupOverviewPage = L(() => import('@/modules/setup/SetupOverviewPage'))
const OrgProfilePage = L(() => import('@/modules/setup/OrgProfilePage'))
const LocationsPage = L(() => import('@/modules/setup/LocationsPage'))
const DepartmentsPage = L(() => import('@/modules/setup/DepartmentsPage'))
const DesignationsPage = L(() => import('@/modules/setup/DesignationsPage'))
const GradesPage = L(() => import('@/modules/setup/GradesPage'))
const CostCentresPage = L(() => import('@/modules/setup/CostCentresPage'))
const ShiftsPage = L(() => import('@/modules/setup/ShiftsPage'))
const EmailsPage = L(() => import('@/modules/setup/EmailsPage'))
const RolesPage = L(() => import('@/modules/setup/RolesPage'))
const RoleDetailPage = L(() => import('@/modules/setup/RoleDetailPage'))
const WorkflowsPage = L(() => import('@/modules/setup/WorkflowsPage'))
const MakerCheckerPage = L(() => import('@/modules/setup/MakerCheckerPage'))
const CreateEmployeePage = L(() => import('@/modules/admin/CreateEmployeePage'))
const FirstPasswordPage = L(() => import('@/modules/auth/FirstPasswordPage'))
const ChangesPage = L(() => import('@/modules/company/ChangesPage'))
// B — projects & delivery
const ProjectsPage = L(() => import('@/modules/projects/ProjectsPage'))
const ProjectPage = L(() => import('@/modules/projects/ProjectPage'))
const WbsImportPage = L(() => import('@/modules/projects/WbsImportPage'))
const OpeningsPage = L(() => import('@/modules/projects/OpeningsPage'))
const ClientViewPage = L(() => import('@/modules/projects/ClientViewPage'))
// v7
const EstimatesPage = L(() => import('@/modules/estimates/EstimatesPage'))
const EstimatePage = L(() => import('@/modules/estimates/EstimatePage'))
const CreateTaskPage = L(() => import('@/modules/work/CreateTaskPage'))
const WorkflowInboxPage = L(() => import('@/modules/wf/WorkflowInboxPage'))
const WfDesignerListPage = L(() => import('@/modules/wf/WfDesignerListPage'))
const WfDesignerPage = L(() => import('@/modules/wf/WfDesignerPage'))
const WfInstancePage = L(() => import('@/modules/wf/WfInstancePage'))
const DocumentsHub = L(() => import('@/modules/documents/DocumentsHub'))
const TemplateEditorPage = L(() => import('@/modules/documents/TemplateEditorPage'))
const EmployeeDocsPage = L(() => import('@/modules/documents/EmployeeDocsPage'))
const IssuedDocPage = L(() => import('@/modules/documents/IssuedDocPage'))
const InvoiceEditorPage = L(() => import('@/modules/finance/InvoiceEditorPage'))
const InvoiceViewPage = L(() => import('@/modules/finance/InvoiceViewPage'))
// v7 — project-scoped delivery areas in the sidebar (no need to open a project first)
const NewProjectPage = L(() => import('@/modules/delivery/NewProjectPage'))
const DeliveryMilestonesPage = L(() => import('@/modules/delivery/MilestonesPage'))
const DeliveryWbsPage = L(() => import('@/modules/delivery/WbsPage'))
const DeliverySchedulePage = L(() => import('@/modules/delivery/SchedulePage'))
const DeliveryChangeRequestsPage = L(() => import('@/modules/delivery/ChangeRequestsPage'))
const DeliveryAllocationPage = L(() => import('@/modules/delivery/AllocationPage'))
const DeliveryCostingPage = L(() => import('@/modules/delivery/CostingPage'))
const DeliveryDocumentsPage = L(() => import('@/modules/delivery/DocumentsPage'))
const DeliveryImportPage = L(() => import('@/modules/delivery/ImportPage'))
// v5 — Feature Guide parity
const AllTasksPage = L(() => import('@/modules/work/AllTasksPage'))
const TaskPage = L(() => import('@/modules/work/TaskPage'))
const MarginsPage = L(() => import('@/modules/finance/MarginsPage'))
const ActivityLogPage = L(() => import('@/modules/sales/ActivityLogPage'))
const ClientViewHubPage = L(() => import('@/modules/projects/ClientViewHubPage'))
const RulesPage = L(() => import('@/modules/company/RulesPage'))
const TeamRosterPage = L(() => import('@/modules/admin/TeamRosterPage'))
// C — work, time, payroll
const MyTasksPage = L(() => import('@/modules/work/MyTasksPage'))
const TimesheetPage = L(() => import('@/modules/work/TimesheetPage'))
const ApprovalsPage = L(() => import('@/modules/work/ApprovalsPage'))
const TeamPage = L(() => import('@/modules/work/TeamPage'))
const DailyUpdatePage = L(() => import('@/modules/work/DailyUpdatePage'))
const PayrollPage = L(() => import('@/modules/work/PayrollPage'))
const NotificationsPage = L(() => import('@/modules/work/NotificationsPage'))
const LeavePage = L(() => import('@/modules/work/LeavePage'))
// D — sales, finance, operations
const PipelinePage = L(() => import('@/modules/sales/PipelinePage'))
const DealPage = L(() => import('@/modules/sales/DealPage'))
const SalesPerformancePage = L(() => import('@/modules/sales/SalesPerformancePage'))
const CompensationPage = L(() => import('@/modules/sales/CompensationPage'))
const LedgerPage = L(() => import('@/modules/finance/LedgerPage'))
const InvoicesPage = L(() => import('@/modules/finance/InvoicesPage'))
const PnlPage = L(() => import('@/modules/finance/PnlPage'))
const OperationsPage = L(() => import('@/modules/finance/OperationsPage'))
// E — home, insights, reports, AI
const HomePage = L(() => import('@/modules/insights/HomePage'))
const InsightsPage = L(() => import('@/modules/insights/InsightsPage'))
const ScorecardPage = L(() => import('@/modules/insights/ScorecardPage'))
const ReportsPage = L(() => import('@/modules/reports/ReportsPage'))
const ReportBuilderPage = L(() => import('@/modules/reports/ReportBuilderPage'))
const ReportViewPage = L(() => import('@/modules/reports/ReportViewPage'))
const AIStudioPage = L(() => import('@/modules/reports/AIStudioPage'))
// v3 business processes
const InboxPage = L(() => import('@/modules/company/InboxPage'))
const OkrPage = L(() => import('@/modules/company/OkrPage'))
const AuditPage = L(() => import('@/modules/company/AuditPage'))
const DocumentsPage = L(() => import('@/modules/documents/DocumentsPage'))
const MyPerformancePage = L(() => import('@/modules/hr/MyPerformancePage'))
const AppraisalsPage = L(() => import('@/modules/hr/AppraisalsPage'))
const AppraisalPage = L(() => import('@/modules/hr/AppraisalPage'))
const RecruitmentPage = L(() => import('@/modules/hr/RecruitmentPage'))
const LifecyclePage = L(() => import('@/modules/hr/LifecyclePage'))
const AssetsPage = L(() => import('@/modules/hr/AssetsPage'))
const ExpensesPage = L(() => import('@/modules/spend/ExpensesPage'))
const PurchasesPage = L(() => import('@/modules/spend/PurchasesPage'))
const BudgetsPage = L(() => import('@/modules/spend/BudgetsPage'))
const LeakagePage = L(() => import('@/modules/spend/LeakagePage'))
const ClientsPage = L(() => import('@/modules/clients/ClientsPage'))
const ClientPage = L(() => import('@/modules/clients/ClientPage'))
const TeamTasksPage = L(() => import('@/modules/work/TeamTasksPage'))

/** Keeps session user/tenant fresh and the theme applied. */
function SessionSync() {
  const { token, tenant, user, setTenant, patchUser, logout } = useSession()
  const me = useApi(['me'], authApi.me, { enabled: !!token, refetchInterval: 60_000 })
  useEffect(() => {
    if (me.error && (me.error as { status?: number }).status === 401) logout()
  }, [me.error, logout])
  useEffect(() => {
    if (!me.data) return
    if (me.data.tenant && JSON.stringify(me.data.tenant) !== JSON.stringify(tenant)) setTenant(me.data.tenant)
    if (JSON.stringify(me.data.user) !== JSON.stringify(user)) patchUser(me.data.user)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data])
  useEffect(() => {
    applyTheme(tenant?.theme ?? DEFAULT_THEME, user?.prefs?.theme_mode)
  }, [tenant?.theme, user?.prefs?.theme_mode])
  return null
}

function RequireAuth() {
  const { token, user } = useSession()
  const loc = useLocation()
  if (!token || !user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />
  if (user.is_super_admin && !loc.pathname.startsWith('/admin') && !loc.pathname.startsWith('/settings/profile')) return <Navigate to="/admin" replace />
  return <AppShell />
}
function PublicOnly() {
  const { token, user } = useSession()
  const loc = useLocation()
  if (token) {
    // Mirror LoginPage's post-login destination so a cold deep link (route → login → back to route)
    // lands on the requested page whichever navigation renders last.
    const from = (loc.state as { from?: string } | null)?.from
    const to = user?.is_super_admin ? '/admin' : user?.must_change_password ? '/welcome/password' : from && from !== '/login' ? from : '/home'
    return <Navigate to={to} replace />
  }
  return (
    <Suspense fallback={<div className="p-8"><PageLoading /></div>}>
      <Outlet />
    </Suspense>
  )
}
export function Gate({ action, children }: { action: Action; children: ReactNode }) {
  const c = useCan()
  if (!c(action)) return <ErrorState error={{ code: 'FORBIDDEN', message: 'Your role does not include this area. Ask an admin if you need access.' }} />
  return <>{children}</>
}
export function GateAny({ actions, children }: { actions: Action[]; children: ReactNode }) {
  const c = useCan()
  if (!actions.some((a) => c(a))) return <ErrorState error={{ code: 'FORBIDDEN', message: 'Your role does not include this area. Ask an admin if you need access.' }} />
  return <>{children}</>
}
function RouteError() {
  return (
    <div className="p-8">
      <ErrorState error={{ message: 'This page failed to load. Reload the app to get the latest version.' }} onRetry={() => window.location.reload()} />
    </div>
  )
}

const routes = [
  {
    element: (
      <>
        <SessionSync />
        <Outlet />
      </>
    ),
    errorElement: <RouteError />,
    children: [
      {
        element: <PublicOnly />,
        children: [
          { path: '/login', element: <LoginPage /> },
          { path: '/signup', element: <SignupPage /> },
          { path: '/reset-password', element: <ResetPasswordPage /> },
        ],
      },
      {
        element: (
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        ),
        children: [
          { path: '/invite/:token', element: <InvitePage /> },
          { path: '/privacy', element: <LegalPage /> },
          { path: '/terms', element: <LegalPage /> },
        ],
      },
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <Navigate to="/home" replace /> },
          { path: '/home', element: <HomePage /> },
          { path: '/onboarding', element: <Gate action="settings.edit"><OnboardingPage /></Gate> },
          { path: '/ai', element: <Gate action="ai.use"><AIStudioPage /></Gate> },
          { path: '/my-tasks', element: <MyTasksPage /> },
          { path: '/tasks', element: <AllTasksPage /> },
          { path: '/tasks/new', element: <CreateTaskPage /> },
          { path: '/projects/cost-calculator', element: <Gate action="estimates.manage"><EstimatesPage /></Gate> },
          { path: '/projects/cost-calculator/:id', element: <Gate action="estimates.manage"><EstimatePage /></Gate> },
          { path: '/workflows', element: <WorkflowInboxPage /> },
          { path: '/workflows/designer', element: <Gate action="workflows.design"><WfDesignerListPage /></Gate> },
          { path: '/workflows/designer/:id', element: <Gate action="workflows.design"><WfDesignerPage /></Gate> },
          { path: '/workflows/run/:id', element: <WfInstancePage /> },
          { path: '/documents/templates/:id', element: <Gate action="documents.templates"><TemplateEditorPage /></Gate> },
          { path: '/documents/employees/:userId', element: <EmployeeDocsPage /> },
          { path: '/documents/issued/:id', element: <IssuedDocPage /> },
          { path: '/finance/invoices/new', element: <Gate action="finance.edit"><InvoiceEditorPage /></Gate> },
          { path: '/finance/invoices/:id', element: <Gate action="finance.view"><InvoiceViewPage /></Gate> },
          { path: '/finance/invoices/:id/edit', element: <Gate action="finance.edit"><InvoiceEditorPage /></Gate> },
          { path: '/finance/margins', element: <Gate action="margins.view"><MarginsPage /></Gate> },
          { path: '/sales/activity', element: <Gate action="deals.edit_own"><ActivityLogPage /></Gate> },
          { path: '/client-view', element: <ClientViewHubPage /> },
          { path: '/rules', element: <RulesPage /> },
          { path: '/tasks/:id', element: <TaskPage /> },
          { path: '/timesheet', element: <TimesheetPage /> },
          { path: '/timesheet/:week', element: <TimesheetPage /> },
          { path: '/approvals', element: <ApprovalsPage /> },
          { path: '/daily', element: <DailyUpdatePage /> },
          { path: '/leave', element: <LeavePage /> },
          { path: '/notifications', element: <NotificationsPage /> },
          { path: '/projects', element: <ProjectsPage /> },
          { path: '/projects/new', element: <Gate action="projects.create"><NewProjectPage /></Gate> },
          { path: '/delivery', element: <Navigate to="/delivery/wbs" replace /> },
          { path: '/delivery/milestones', element: <GateAny actions={DELIVERY_GATES.milestones}><DeliveryMilestonesPage /></GateAny> },
          { path: '/delivery/wbs', element: <DeliveryWbsPage /> },
          { path: '/delivery/schedule', element: <DeliverySchedulePage /> },
          { path: '/delivery/change-requests', element: <GateAny actions={DELIVERY_GATES.change_requests}><DeliveryChangeRequestsPage /></GateAny> },
          { path: '/delivery/allocation', element: <GateAny actions={DELIVERY_GATES.allocation}><DeliveryAllocationPage /></GateAny> },
          { path: '/delivery/costing', element: <Gate action={DELIVERY_GATES.costing}><DeliveryCostingPage /></Gate> },
          { path: '/delivery/documents', element: <DeliveryDocumentsPage /> },
          { path: '/delivery/client-view', element: <Navigate to="/client-view" replace /> },
          { path: '/delivery/import', element: <Gate action={DELIVERY_GATES.import}><DeliveryImportPage /></Gate> },
          { path: '/projects/:id', element: <ProjectPage /> },
          { path: '/projects/:id/:tab', element: <ProjectPage /> },
          { path: '/projects/:id/import', element: <Gate action="projects.edit"><WbsImportPage /></Gate> },
          { path: '/projects/:id/client-view', element: <ClientViewPage /> },
          { path: '/team', element: <Gate action="team.view"><TeamPage /></Gate> },
          { path: '/openings', element: <Gate action="openings.manage"><OpeningsPage /></Gate> },
          { path: '/scorecard', element: <Gate action="insights.view"><ScorecardPage /></Gate> },
          { path: '/sales', element: <Gate action="deals.edit_own"><PipelinePage /></Gate> },
          { path: '/sales/performance', element: <Gate action="sales.performance_own"><SalesPerformancePage /></Gate> },
          { path: '/sales/compensation', element: <Gate action="sales.performance_own"><CompensationPage /></Gate> },
          { path: '/sales/:id', element: <Gate action="deals.edit_own"><DealPage /></Gate> },
          { path: '/finance/invoices', element: <Gate action="finance.view"><InvoicesPage /></Gate> },
          { path: '/finance/ledger', element: <Gate action="ledger.view"><LedgerPage /></Gate> },
          { path: '/finance/pnl', element: <Gate action="finance.view"><PnlPage /></Gate> },
          { path: '/payroll', element: <Gate action="payroll.run"><PayrollPage /></Gate> },
          { path: '/payroll/:id', element: <Gate action="payroll.run"><PayrollPage /></Gate> },
          { path: '/operations', element: <Gate action="ops.manage"><OperationsPage /></Gate> },
          { path: '/insights', element: <Gate action="insights.view"><InsightsPage /></Gate> },
          { path: '/insights/:view', element: <Gate action="insights.view"><InsightsPage /></Gate> },
          { path: '/reports', element: <Gate action="reports.view"><ReportsPage /></Gate> },
          { path: '/reports/new', element: <Gate action="reports.build"><ReportBuilderPage /></Gate> },
          { path: '/reports/:id/edit', element: <Gate action="reports.build"><ReportBuilderPage /></Gate> },
          { path: '/reports/:id', element: <Gate action="reports.view"><ReportViewPage /></Gate> },
          { path: '/inbox', element: <InboxPage /> },
          { path: '/okrs', element: <OkrPage /> },
          { path: '/audit', element: <Gate action="audit.view"><AuditPage /></Gate> },
          { path: '/documents', element: <DocumentsHub /> },
          { path: '/documents/legacy', element: <DocumentsPage /> },
          { path: '/performance', element: <MyPerformancePage /> },
          { path: '/performance/:userId', element: <MyPerformancePage /> },
          { path: '/appraisals', element: <AppraisalsPage /> },
          { path: '/appraisals/:id', element: <AppraisalPage /> },
          { path: '/recruitment', element: <Gate action="recruitment.manage"><RecruitmentPage /></Gate> },
          { path: '/lifecycle', element: <Gate action="people.manage"><LifecyclePage /></Gate> },
          { path: '/assets', element: <AssetsPage /> },
          { path: '/expenses', element: <ExpensesPage /> },
          { path: '/purchases', element: <Gate action="procurement.manage"><PurchasesPage /></Gate> },
          { path: '/budgets', element: <Gate action="budgets.manage"><BudgetsPage /></Gate> },
          { path: '/leakage', element: <Gate action="leakage.view"><LeakagePage /></Gate> },
          { path: '/clients', element: <Gate action="clients.manage"><ClientsPage /></Gate> },
          { path: '/clients/:id', element: <Gate action="clients.manage"><ClientPage /></Gate> },
          { path: '/team-tasks', element: <Gate action="tasks.assign_team"><TeamTasksPage /></Gate> },
          { path: '/people', element: <Gate action="users.view"><PeoplePage /></Gate> },
          { path: '/people/new', element: <Gate action="employees.create"><CreateEmployeePage /></Gate> },
          { path: '/changes', element: <GateAny actions={CHANGE_NAV_ACTIONS}><ChangesPage /></GateAny> },
          { path: '/welcome/password', element: <FirstPasswordPage /> },
          {
            path: '/setup',
            element: <GateAny actions={SETUP_NAV_ACTIONS}><SetupLayout /></GateAny>,
            children: [
              { index: true, element: <Gate action="master.view"><SetupOverviewPage /></Gate> },
              { path: 'org', element: <Gate action="master.view"><OrgProfilePage /></Gate> },
              { path: 'locations', element: <Gate action="master.view"><LocationsPage /></Gate> },
              { path: 'departments', element: <Gate action="master.view"><DepartmentsPage /></Gate> },
              { path: 'designations', element: <Gate action="master.view"><DesignationsPage /></Gate> },
              { path: 'grades', element: <Gate action="master.view"><GradesPage /></Gate> },
              { path: 'cost-centres', element: <Gate action="master.view"><CostCentresPage /></Gate> },
              { path: 'shifts', element: <Gate action="master.view"><ShiftsPage /></Gate> },
              { path: 'emails', element: <Gate action="emails.view"><EmailsPage /></Gate> },
              { path: 'roles', element: <Gate action="roles.view"><RolesPage /></Gate> },
              { path: 'roles/:key', element: <Gate action="roles.view"><RoleDetailPage /></Gate> },
              { path: 'workflows', element: <Gate action="workflows.manage"><WorkflowsPage /></Gate> },
              { path: 'maker-checker', element: <Gate action="makerchecker.configure"><MakerCheckerPage /></Gate> },
            ],
          },
          { path: '/billing', element: <Gate action="billing.manage"><BillingPage /></Gate> },
          { path: '/admin', element: <SuperAdminPage /> },
          {
            path: '/settings',
            element: <SettingsLayout />,
            children: [
              { index: true, element: <Navigate to="/settings/profile" replace /> },
              { path: 'profile', element: <ProfilePage /> },
              { path: 'company', element: <Gate action="settings.edit"><CompanySettingsPage /></Gate> },
              { path: 'appearance', element: <AppearancePage /> },
              { path: 'holidays', element: <HolidaysPage /> },
              { path: 'cost-rates', element: <Gate action="cost_rates.view"><CostRatesPage /></Gate> },
              { path: 'delegations', element: <Gate action="delegations.manage"><DelegationsPage /></Gate> },
              { path: 'team', element: <Gate action="users.view"><TeamRosterPage /></Gate> },
              { path: 'security', element: <SecurityPage /> },
              { path: 'data', element: <Gate action="data.export"><DataPage /></Gate> },
            ],
          },
          { path: '*', element: <ErrorState error={{ code: 'NOT_FOUND', message: 'This page does not exist. Check the link or use search.' }} /> },
        ],
      },
    ],
  },
]

const useHash = (import.meta.env.VITE_ROUTER as string) === 'hash'
export const router = useHash ? createHashRouter(routes) : createBrowserRouter(routes)

export function AppRouter() {
  return <RouterProvider router={router} />
}
