import { NavLink, Navigate, Outlet, useLocation } from 'react-router-dom'
import type { LucideIcon } from '@/ui/icons'
import { Building2, CalendarClock, CalendarDays, Database, IndianRupee, Palette, Palmtree, Repeat2, Shield, UserRound, Users } from '@/ui/icons'
import { useEffect, useState } from 'react'
import { useSession } from '@/stores/session'
import type { Action } from '@/domain/permissions'
import { ROLE_LABEL } from '@/domain/permissions'
import { Avatar, ListGroup, ListRow, PageHeader, useCan } from '@/ui'
import { cn } from '@/lib/utils'

export interface SettingsItem {
  to: string
  label: string
  icon: LucideIcon
  hint: string
  action?: Action
}
/** Feature Guide §16 "Team & settings": Team, Working hours & calendar (+ holiday calendar), Leave, Delegations — then the other settings. */
export const SETTINGS_GROUPS: { title: string; items: SettingsItem[] }[] = [
  {
    title: 'Team & settings',
    items: [
      { to: '/settings/team', label: 'Team', icon: Users, hint: 'Role, function, joined, reports to, access, hours a day, CTC', action: 'users.view' },
      { to: '/settings/company#calendar', label: 'Working hours & calendar', icon: CalendarClock, hint: 'Minimum hours, breaks, weekly off, Saturdays, approval deadline', action: 'settings.edit' },
      { to: '/settings/holidays', label: 'Holidays', icon: CalendarDays, hint: 'Public holidays for the year' },
      { to: '/leave?tab=hr', label: 'Leave', icon: Palmtree, hint: 'Record leave; leave taken this financial year', action: 'leave.hr_entry' },
      { to: '/settings/delegations', label: 'Delegations', icon: Repeat2, hint: 'Hand approvals to someone for a date range', action: 'delegations.manage' },
    ],
  },
  {
    title: 'Account',
    items: [
      { to: '/settings/profile', label: 'My profile', icon: UserRound, hint: 'Name, title, phone, avatar' },
      { to: '/settings/security', label: 'Security', icon: Shield, hint: 'Password, two-step, sessions' },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { to: '/settings/company', label: 'Company & rules', icon: Building2, hint: 'Timesheets, pay, finance, projects, AI', action: 'settings.edit' },
      { to: '/settings/appearance', label: 'Appearance', icon: Palette, hint: 'Colours, font, light & dark' },
      { to: '/settings/cost-rates', label: 'Cost rates', icon: IndianRupee, hint: 'CTC, variable, cost per hour', action: 'cost_rates.view' },
      { to: '/settings/data', label: 'Data & export', icon: Database, hint: 'Export everything', action: 'data.export' },
    ],
  },
]

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

function NavIcon({ icon: Icon, size = 18 }: { icon: LucideIcon; size?: number }) {
  return <Icon className="shrink-0 text-ink-3" size={size} />
}

/** Back link to the list — only below xl, where the side nav is hidden. */
export function SettingsBack({ wide }: { wide?: boolean } = {}) {
  return (
    <div className={wide ? '2xl:hidden' : 'xl:hidden'}>
      <NavLink to="/settings" className="-ml-1 mb-2 inline-flex items-center gap-0.5 text-[13.5px] font-medium text-brand-text">
        <svg className="size-4" viewBox="0 0 16 16" aria-hidden><path d="M10 3.5 5.5 8 10 12.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Team &amp; settings
      </NavLink>
    </div>
  )
}

/** Pages whose tables need the full width: the settings side nav shows only from 2xl (≥1536 px) there. */
const WIDE = ['/settings/team']
/** A link is active on its path, and an anchor link (…#calendar) only while that anchor is in the URL. */
function isActiveItem(to: string, pathname: string, hash: string) {
  const [path, anchor] = to.split('#')
  if (path.includes('?')) return false
  if (pathname !== path) return false
  return anchor ? hash === '#' + anchor : !hash || !SETTINGS_GROUPS.some((g) => g.items.some((i) => i.to === `${path}${hash}`))
}

export default function SettingsLayout() {
  const loc = useLocation()
  const c = useCan()
  const { user, tenant } = useSession()
  const desktop = useIsDesktop()
  const groups = SETTINGS_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => (user?.is_super_admin ? i.to === '/settings/profile' : !i.action || c(i.action))) })).filter((g) => g.items.length)
  const atRoot = loc.pathname.replace(/\/$/, '') === '/settings'

  const wide = WIDE.includes(loc.pathname.replace(/\/$/, ''))
  // desktop: open on the first page of the guide's "Team & settings" group the person can open
  if (atRoot && desktop) return <Navigate to={groups[0]?.items.find((i) => !i.to.includes('#') && !i.to.includes('?'))?.to ?? '/settings/profile'} replace />

  if (atRoot)
    return (
      <div className="mx-auto max-w-[640px]">
        <PageHeader title="Team & settings" />
        {user && (
          <ListGroup className="mb-6">
            <ListRow to="/settings/profile" chevron leading={<Avatar name={user.name} hue={user.avatar_hue} size={52} />} title={<span className="text-[16px]">{user.name}</span>} subtitle={`${user.role_name ?? ROLE_LABEL[user.role]} · ${tenant?.name ?? ''}`} className="py-3.5" />
          </ListGroup>
        )}
        {groups.map((g) => (
          <section key={g.title} className="mb-6">
            <h2 className="mb-1.5 px-4 text-[13px] font-medium text-ink-3">{g.title}</h2>
            <ListGroup>
              {g.items.map((i) => (
                <ListRow key={i.to} to={i.to} chevron leading={<NavIcon icon={i.icon} size={20} />} title={i.label} subtitle={i.hint} />
              ))}
            </ListGroup>
          </section>
        ))}
      </div>
    )

  return (
    <div className={wide ? '2xl:grid 2xl:grid-cols-[220px_minmax(0,1fr)] 2xl:gap-10' : 'xl:grid xl:grid-cols-[220px_minmax(0,1fr)] xl:gap-10'}>
      <aside className={wide ? 'hidden 2xl:block' : 'hidden xl:block'}>
        <div className="sticky top-[76px]">
          <h1 className="mb-4 px-2 text-[20px] font-semibold">Team &amp; settings</h1>
          {groups.map((g) => (
            <nav key={g.title} className="mb-5" aria-label={g.title}>
              <div className="mb-1 px-2 text-[12px] font-medium text-ink-3">{g.title}</div>
              <ul className="space-y-0.5">
                {g.items.map((i) => (
                  <li key={i.to}>
                    <NavLink to={i.to} className={() => cn('flex h-9 items-center gap-2.5 rounded-md px-2 text-[13.5px] font-medium transition', isActiveItem(i.to, loc.pathname, loc.hash) ? 'bg-brand-soft text-brand-text [&>svg]:text-brand-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                      <NavIcon icon={i.icon} />
                      {i.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </aside>
      <div className={cn('min-w-0', !wide && 'max-w-[960px]')}>
        <SettingsBack wide={wide} />
        <Outlet />
      </div>
    </div>
  )
}
