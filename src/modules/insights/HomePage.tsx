// /home — the five dashboard views of the Feature Guide (CEO, Project manager, Sales, Operations, Employee).
// Each person lands on their own view; anyone allowed to open more than one gets a segmented switch
// (permissions decide which, the server enforces the same). The CEO view has Overview / Projects / Sales /
// Finance / Operations sub-tabs. Every "this week" number follows the header week switcher.
import type { Role } from '@/types/entities'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useSession, useEffectiveRole } from '@/stores/session'
import { useAiContext } from '@/api/reports'
import { Segmented, Tabs, useCan } from '@/ui'
import { todayISO } from '@/domain/calendar'
import OnboardingCard from '@/modules/admin/OnboardingCard'
import { AskBar } from './kit'
import CeoHome, { type CeoTab } from './home/CeoHome'
import PmHome from './home/PmHome'
import SalesHome from './home/SalesHome'
import OpsHome from './home/OpsHome'
import EmployeeHome from './home/EmployeeHome'

const FALLBACK: Record<string, string[]> = {
  admin: ['Revenue by stream this FY', 'Which projects are below 25% margin?', 'Cash collected vs billed by month last 6 months', 'Top 5 clients by billing'],
  pm: ['Overdue tasks by owner', 'Who is over-allocated?', 'Hours by person last month', 'Milestones due in the next 30 days'],
  sales: ['My open pipeline by stage', 'Win rate by source this quarter', 'Stale deals', 'Deals closing this month'],
  ops: ['Compliance items due', 'Who hasn’t submitted last week’s timesheet?', 'Expenses by category this FY'],
  employee: ['My hours by project last month', 'My overdue tasks', 'My tasks due this week'],
}

type Can = (k: Parameters<ReturnType<typeof useCan>>[0]) => boolean
/** Which dashboard views this viewer's permissions allow. */
const HOME_GATE: Record<Exclude<Role, 'employee'>, (c: Can) => boolean> = {
  admin: (c) => c('finance.view'),
  pm: (c) => c('projects.edit') || c('projects.manage_all'),
  sales: (c) => c('deals.edit_own'),
  ops: (c) => c('ops.manage'),
}
/** The persona's home when permitted; otherwise the first permitted of PM → Sales → Ops; else the employee home. */
export function homeFor(persona: Role, c: Can): Role {
  if (persona !== 'employee' && HOME_GATE[persona](c)) return persona
  for (const r of ['pm', 'sales', 'ops'] as const) if (HOME_GATE[r](c)) return r
  return 'employee'
}
const VIEW_ORDER: Role[] = ['admin', 'pm', 'sales', 'ops', 'employee']
const VIEW_LABEL: Record<Role, string> = { admin: 'CEO', pm: 'Project manager', sales: 'Sales', ops: 'Operations', employee: 'Employee' }
const VIEW_KEY: Record<Role, string> = { admin: 'ceo', pm: 'pm', sales: 'sales', ops: 'operations', employee: 'employee' }
const KEY_VIEW: Record<string, Role> = Object.fromEntries(Object.entries(VIEW_KEY).map(([k, v]) => [v, k as Role]))
/** Views this viewer may open (Employee is always their own view). */
export function viewsFor(c: Can): Role[] {
  return VIEW_ORDER.filter((r) => r === 'employee' || HOME_GATE[r as Exclude<Role, 'employee'>](c))
}
const CEO_TABS: { value: CeoTab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'projects', label: 'Projects' },
  { value: 'sales', label: 'Sales' },
  { value: 'finance', label: 'Finance' },
  { value: 'operations', label: 'Operations' },
]

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export default function HomePage() {
  const persona = useEffectiveRole() ?? 'employee'
  const { user, tenant, viewAs } = useSession()
  const c = useCan()
  const [sp, setSp] = useSearchParams()
  const home = homeFor(persona, c)
  const views = viewsFor(c)
  const asked = KEY_VIEW[sp.get('view') ?? '']
  const role: Role = asked && views.includes(asked) ? asked : home
  const tab = (CEO_TABS.find((t) => t.value === sp.get('tab'))?.value ?? 'overview') as CeoTab
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp)
    if (v === null) next.delete(k)
    else next.set(k, v)
    setSp(next, { replace: true })
  }
  const ai = useAiContext(c('ai.use'))
  const suggestions = useMemo(() => (ai.data?.suggestions?.length ? ai.data.suggestions : FALLBACK[role] ?? []).slice(0, 5), [ai.data, role])
  const today = new Date(todayISO() + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const aiOn = c('ai.use') && ai.data?.enabled !== false
  return (
    <div className="min-w-0 space-y-5">
      <header className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink md:text-[22px]">
            {greeting()}, {user?.name.split(' ')[0] ?? 'there'}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {viewAs ? `Viewing the ${viewAs.name} home` : role === 'admin' ? `Here is how ${tenant?.name ?? 'the company'} is doing.` : role === 'pm' ? 'Delivery control, the task pipeline and who has room for more work.' : role === 'sales' ? 'Your pipeline and what needs a nudge today.' : role === 'ops' ? 'What’s due, who’s out, and where payroll stands.' : 'Tasks tagged to you, what you are covering, and your week at a glance.'}
          </p>
        </div>
        <div className="tnum shrink-0 text-[13px] text-ink-3">{today}</div>
      </header>
      {views.length > 1 && (
        <Segmented
          block
          className="[&>button]:flex-1"
          value={VIEW_KEY[role]}
          onChange={(v) => {
            const next = new URLSearchParams(sp)
            next.set('view', v)
            next.delete('tab')
            if (v !== 'employee') next.delete('person')
            setSp(next, { replace: true })
          }}
          options={views.map((r) => ({ value: VIEW_KEY[r], label: VIEW_LABEL[r] }))}
        />
      )}
      {role === 'admin' && <Tabs className="-mt-1 mb-0" value={tab} onChange={(v) => setParam('tab', v === 'overview' ? null : v)} tabs={CEO_TABS} />}
      {aiOn && (role !== 'admin' || tab === 'overview') && <AskBar suggestions={suggestions} placeholder={role === 'admin' ? 'Ask about revenue, margins, projects or people…' : role === 'sales' ? 'Ask about your pipeline, wins or activities…' : 'Ask anything about your work…'} />}
      {role === 'admin' && tab === 'overview' && !viewAs && c('settings.edit') && <OnboardingCard />}
      {role === 'admin' && <CeoHome tab={tab} />}
      {role === 'pm' && <PmHome />}
      {role === 'sales' && <SalesHome />}
      {role === 'ops' && <OpsHome />}
      {role === 'employee' && <EmployeeHome person={sp.get('person')} onPerson={(id) => setParam('person', id)} />}
    </div>
  )
}
