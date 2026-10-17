// Organisation setup: master data, access control and process configuration in one place.
// Mirrors the Settings layout (side nav ≥ xl, grouped list on smaller screens).
import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import type { LucideIcon } from '@/ui/icons'
import { Building2, Clock, IdCard, Landmark, Layers, ListTree, Mail, MapPin, Rocket, ShieldCheck, UserCog, Workflow } from '@/ui/icons'
import type { Action } from '@/domain/permissions'
import { ListGroup, ListRow, PageHeader, useCan } from '@/ui'
import { cn } from '@/lib/utils'

export interface SetupItem {
  to: string
  label: string
  icon: LucideIcon
  hint: string
  action: Action
  end?: boolean
}
export const SETUP_GROUPS: { title: string; items: SetupItem[] }[] = [
  {
    title: 'Get started',
    items: [{ to: '/setup', label: 'Setup checklist', icon: Rocket, hint: 'Org data → roles → people', action: 'master.view', end: true }],
  },
  {
    title: 'Organisation',
    items: [
      { to: '/setup/org', label: 'Organisation profile', icon: Building2, hint: 'Legal name, tax IDs, addresses', action: 'master.view' },
      { to: '/setup/locations', label: 'Locations', icon: MapPin, hint: 'Offices and their calendars', action: 'master.view' },
      { to: '/setup/departments', label: 'Departments', icon: ListTree, hint: 'Structure, heads, cost centres', action: 'master.view' },
      { to: '/setup/designations', label: 'Designations', icon: IdCard, hint: 'Job titles and default roles', action: 'master.view' },
      { to: '/setup/grades', label: 'Grades & bands', icon: Layers, hint: 'Levels and CTC bands', action: 'master.view' },
      { to: '/setup/cost-centres', label: 'Cost centres', icon: Landmark, hint: 'Where cost is booked', action: 'master.view' },
      { to: '/setup/shifts', label: 'Shifts', icon: Clock, hint: 'Timings, grace, working days', action: 'master.view' },
    ],
  },
  {
    title: 'Access & controls',
    items: [
      { to: '/setup/roles', label: 'Roles & permissions', icon: UserCog, hint: 'Who can see and do what', action: 'roles.view' },
      { to: '/setup/maker-checker', label: 'Maker-checker', icon: ShieldCheck, hint: 'Changes that need a second person', action: 'makerchecker.configure' },
    ],
  },
  {
    title: 'Processes',
    items: [
      { to: '/setup/workflows', label: 'Approval workflows', icon: Workflow, hint: 'Approvers, amounts, SLAs', action: 'workflows.manage' },
      { to: '/setup/emails', label: 'Emails', icon: Mail, hint: 'Templates and sent emails', action: 'emails.view' },
    ],
  },
]
export const SETUP_ACTIONS: Action[] = ['master.view', 'roles.view', 'makerchecker.configure', 'workflows.manage', 'emails.view']

function useIsDesktop() {
  const q = '(min-width: 1280px)'
  const [d, setD] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(q).matches)
  useEffect(() => {
    const m = window.matchMedia?.(q)
    if (!m) return
    const f = () => setD(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [])
  return d
}

/** Back link to the setup list — only below xl, where the side nav is hidden. */
export function SetupBack() {
  return (
    <div className="xl:hidden">
      <NavLink to="/setup?list=1" className="-ml-1 mb-2 inline-flex items-center gap-0.5 text-[13.5px] font-medium text-brand-text">
        <svg className="size-4" viewBox="0 0 16 16" aria-hidden><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Setup
      </NavLink>
    </div>
  )
}

export default function SetupLayout() {
  const loc = useLocation()
  const c = useCan()
  const desktop = useIsDesktop()
  const groups = SETUP_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => c(i.action)) })).filter((g) => g.items.length)
  const listMode = !desktop && loc.pathname.replace(/\/$/, '') === '/setup' && new URLSearchParams(loc.search).get('list') === '1'
  const first = groups[0]?.items[0]
  if (!groups.length) return <Navigate to="/home" replace />
  if (loc.pathname.replace(/\/$/, '') === '/setup' && !c('master.view') && first) return <Navigate to={first.to} replace />

  if (listMode)
    return (
      <div className="mx-auto max-w-[640px]">
        <PageHeader title="Organisation setup" subtitle="Master data, access and approval processes" />
        {groups.map((g) => (
          <section key={g.title} className="mb-6">
            <h2 className="mb-1.5 px-4 text-[13px] font-medium text-ink-3">{g.title}</h2>
            <ListGroup>
              {g.items.map((i) => (
                <ListRow key={i.to} to={i.to} chevron leading={<i.icon className="shrink-0 text-ink-3" size={20} />} title={i.label} subtitle={i.hint} />
              ))}
            </ListGroup>
          </section>
        ))}
      </div>
    )

  return (
    <div className="xl:grid xl:grid-cols-[232px_minmax(0,1fr)] xl:gap-10">
      <aside className="hidden xl:block">
        <div className="sticky top-[76px]">
          <h1 className="mb-4 px-2 text-[20px] font-semibold">Setup</h1>
          {groups.map((g) => (
            <nav key={g.title} className="mb-5" aria-label={g.title}>
              <div className="mb-1 px-2 text-[12px] font-medium text-ink-3">{g.title}</div>
              <ul className="space-y-0.5">
                {g.items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} end={i.end} className={({ isActive }) => cn('flex h-9 items-center gap-2.5 rounded-md px-2 text-[13.5px] font-medium transition', isActive ? 'bg-brand-soft text-brand-text [&>svg]:text-brand-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                      <i.icon className="shrink-0 text-ink-3" size={18} />
                      <span className="truncate">{i.label}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </aside>
      <div className="min-w-0 max-w-[1040px]">
        {loc.pathname.replace(/\/$/, '') !== '/setup' && <SetupBack />}
        <Outlet />
      </div>
    </div>
  )
}


