import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as RP from '@radix-ui/react-popover'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, Eye, LogOut, Menu as MenuIcon, MoreHorizontal, Moon, Search, Sparkles, Sun, SunMoon, User as UserIcon, X, Settings as SettingsIcon, RotateCcw, AlertTriangle } from '@/ui/icons'
import { useQueryClient } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { useSession, useEffectivePermissions, useEffectiveRole, useEffectiveRoleName, type ViewAsRole } from '@/stores/session'
import { useUI } from '@/stores/ui'

import { authApi } from '@/api/core'
import { http } from '@/api/http'
import { useApi } from '@/api/query'
import { applyTheme } from '@/theme/theme'
import { Avatar, Badge, Button, IconButton, Menu, Sheet, SkeletonRows, TenantMark, Wordmark, useCan } from '@/ui'
import { activeLink, filterNav, flattenNav, MOBILE_TABS, NAV, SUPER_NAV, type NavItem, type NavSection } from './nav'
import { storage } from '@/lib/storage'
import CommandPalette from './CommandPalette'
import NotificationBell from '@/modules/work/NotificationBell'
import TaskDrawerHost from '@/modules/work/TaskDrawerHost'
import AIAssistantHost from '@/modules/reports/AIAssistantHost'
import { addDays, diffDays, parseISO, todayISO, weekStart } from '@/domain/calendar'

function useBadges() {
  const role = useEffectiveRole()
  const q = useApi(['inbox', 'summary'], () => http.get<{ pending: number; overdue: number }>('/inbox/summary'), { refetchInterval: 30_000, enabled: !!role, retry: false })
  const ch = useApi(['changes', 'summary'], () => http.get<{ to_check: number; mine_pending: number }>('/changes/summary'), { refetchInterval: 30_000, enabled: !!role, retry: false })
  return { approvals: q.data?.pending ?? 0, approvalsOverdue: q.data?.overdue ?? 0, changes: ch.data?.to_check ?? 0 }
}

function useVisibleNav() {
  const c = useCan()
  const perms = useEffectivePermissions().join()
  const { user } = useSession()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (user?.is_super_admin ? SUPER_NAV : filterNav(NAV, c)), [user?.is_super_admin, perms])
}

/** The link that is active for the current location (one at most) and the group that holds it. */
function useActiveNav(sections: NavSection[]) {
  const loc = useLocation()
  return useMemo(() => {
    const links = flattenNav(sections)
    const to = activeLink(links, loc.pathname, loc.search)
    const group = sections.flatMap((s) => s.items).find((i) => i.children?.some((c) => c.to === to))?.to ?? null
    return { to, group }
  }, [sections, loc.pathname, loc.search])
}

/** Which groups are open; remembered per user (browser storage, never required), and the active route's group opens itself. */
function useOpenGroups(activeGroup: string | null) {
  const { user } = useSession()
  const key = `seereonos.nav.open.${user?.id ?? 'anon'}`
  const [open, setOpen] = useState<Record<string, boolean>>(() => storage.get<Record<string, boolean>>(key, {}))
  useEffect(() => setOpen(storage.get<Record<string, boolean>>(key, {})), [key])
  useEffect(() => {
    if (!activeGroup) return
    setOpen((o) => {
      if (o[activeGroup]) return o
      const n = { ...o, [activeGroup]: true }
      storage.set(key, n)
      return n
    })
  }, [activeGroup, key])
  const toggle = useCallback(
    (id: string, v?: boolean) =>
      setOpen((o) => {
        const n = { ...o, [id]: v ?? !o[id] }
        storage.set(key, n)
        return n
      }),
    [key],
  )
  return { open, toggle }
}

function badgeCount(item: NavItem, badges: ReturnType<typeof useBadges>): number {
  if (item.children) return item.children.reduce((s, c) => s + badgeCount(c, badges), 0)
  return item.badge === 'approvals' ? badges.approvals : item.badge === 'changes' ? badges.changes : 0
}

function NavBadge({ item, badges, collapsed }: { item: NavItem; badges: ReturnType<typeof useBadges>; collapsed?: boolean }) {
  const n = badgeCount(item, badges)
  if (!n) return null
  const urgent = item.badge === 'approvals' && badges.approvalsOverdue
  return (
    <span className={cn('tnum grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full px-1 text-[11px] font-semibold', urgent ? 'bg-danger text-white' : 'bg-accent text-accent-ink', collapsed && 'absolute -right-0.5 -top-0.5')}>
      {n}
    </span>
  )
}

const rowCls = 'relative flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/40'
const rowIdle = 'text-sidebar-ink/80 hover:bg-sidebar-active/60 hover:text-sidebar-ink'
const rowActive = 'bg-sidebar-active font-medium text-sidebar-active-ink'

function Sidebar() {
  const sections = useVisibleNav()
  const { tenant, user } = useSession()
  const badges = useBadges()
  const { sidebarCollapsed: collapsed, toggleSidebar } = useUI()
  const active = useActiveNav(sections)
  const { open, toggle } = useOpenGroups(active.group)
  return (
    <aside data-sidebar="" className={cn('fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-sidebar-line bg-sidebar text-sidebar-ink transition-[width] duration-200 lg:flex', collapsed ? 'w-[72px]' : 'w-[248px]')}>
      <div className={cn('flex h-16 shrink-0 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <TenantMark name={tenant?.name ?? 'Seereon'} logo={tenant?.logo_data_url} size={36} />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="line-clamp-2 text-[13px] font-semibold leading-[1.2]">{user?.is_super_admin ? 'SeereonOS Platform' : tenant?.name}</div>
            <div className="mt-0.5 text-[11.5px] text-sidebar-muted">SeereonOS</div>
          </div>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-4 no-scrollbar" aria-label="Main">
        {sections.map((s, i) => (
          <div key={i} className={cn(i > 0 && 'mt-3 border-t border-sidebar-line pt-3', i === 0 && 'mt-1')}>
            {s.title && !collapsed && <div className="mb-1 px-2.5 text-[11.5px] font-medium text-sidebar-muted">{s.title}</div>}
            <ul className="space-y-0.5">
              {s.items.map((it) => (
                <li key={it.to}>
                  {it.children ? (
                    collapsed ? (
                      <RailGroup item={it} activeTo={active.to} hasActive={active.group === it.to} badges={badges} />
                    ) : (
                      <SidebarGroup item={it} open={!!open[it.to]} onToggle={(v) => toggle(it.to, v)} activeTo={active.to} hasActive={active.group === it.to} badges={badges} />
                    )
                  ) : (
                    <Link to={it.to} title={collapsed ? it.label : undefined} aria-current={active.to === it.to ? 'page' : undefined} className={cn(rowCls, collapsed && 'justify-center px-0', active.to === it.to ? rowActive : rowIdle)}>
                      <it.icon className="size-[18px] shrink-0" />
                      {!collapsed && <span className="min-w-0 flex-1 truncate">{it.label}</span>}
                      {collapsed && <span className="sr-only">{it.label}</span>}
                      <NavBadge item={it} badges={badges} collapsed={collapsed} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <button onClick={toggleSidebar} className={cn('mx-3 mb-3 flex h-9 items-center gap-2 rounded-md px-2.5 text-[12.5px] font-medium text-sidebar-muted hover:bg-sidebar-active/60 hover:text-sidebar-ink', collapsed && 'justify-center')} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
        <ChevronsLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
        {!collapsed && 'Collapse'}
      </button>
    </aside>
  )
}

/** Expanded sidebar: a group header that opens and closes, with its links indented underneath. */
function SidebarGroup({ item, open, onToggle, activeTo, hasActive, badges }: { item: NavItem; open: boolean; onToggle: (v?: boolean) => void; activeTo: string | null; hasActive: boolean; badges: ReturnType<typeof useBadges> }) {
  const id = `nav-${item.to.replace(/[^a-z0-9]/gi, '-')}`
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onToggle()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' && !open) { e.preventDefault(); onToggle(true) }
          if (e.key === 'ArrowLeft' && open) { e.preventDefault(); onToggle(false) }
        }}
        className={cn(rowCls, rowIdle, hasActive && 'font-medium text-sidebar-ink')}
      >
        <item.icon className="size-[18px] shrink-0" />
        <span className="min-w-0 flex-1 truncate">{item.label}</span>
        {!open && <NavBadge item={item} badges={badges} />}
        <ChevronDown className={cn('size-3.5 shrink-0 text-sidebar-muted transition-transform', !open && '-rotate-90')} />
      </button>
      {open && (
        <ul id={id} className="mb-1 ml-[18px] mt-0.5 space-y-0.5 border-l border-sidebar-line pl-2" aria-label={item.label}>
          {item.children!.map((c) => (
            <li key={c.to}>
              <Link to={c.to} aria-current={activeTo === c.to ? 'page' : undefined} className={cn(rowCls, 'h-[30px] px-2 text-[13px]', activeTo === c.to ? rowActive : rowIdle)}>
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                <NavBadge item={c} badges={badges} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** Collapsed rail: the group's icon opens a flyout with its links (click, Enter or hover). */
function RailGroup({ item, activeTo, hasActive, badges }: { item: NavItem; activeTo: string | null; hasActive: boolean; badges: ReturnType<typeof useBadges> }) {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const hold = () => window.clearTimeout(timer.current)
  const leave = () => {
    hold()
    timer.current = window.setTimeout(() => setOpen(false), 180)
  }
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild>
        <button
          type="button"
          aria-label={item.label}
          aria-haspopup="menu"
          onMouseEnter={() => { hold(); setOpen(true) }}
          onMouseLeave={leave}
          className={cn(rowCls, 'justify-center px-0', hasActive ? rowActive : rowIdle)}
        >
          <item.icon className="size-[18px] shrink-0" />
          <NavBadge item={item} badges={badges} collapsed />
        </button>
      </RP.Trigger>
      <RP.Portal>
        <RP.Content
          side="right"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          onMouseEnter={hold}
          onMouseLeave={leave}
          className="z-[60] w-[232px] rounded-lg border border-line bg-elevated p-1.5 shadow-lg outline-none animate-[fade_.12s_ease]"
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[12px] font-semibold text-ink-3">{item.label}</div>
          <ul aria-label={item.label} className="space-y-0.5">
            {item.children!.map((c) => (
              <li key={c.to}>
                <Link
                  to={c.to}
                  onClick={() => setOpen(false)}
                  aria-current={activeTo === c.to ? 'page' : undefined}
                  className={cn('flex h-8 items-center gap-2 rounded-md px-2.5 text-[13.5px] outline-none focus-visible:bg-surface-2', activeTo === c.to ? 'bg-brand-soft font-medium text-brand-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
                >
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <NavBadge item={c} badges={badges} />
                </Link>
              </li>
            ))}
          </ul>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  )
}

function UserMenu() {
  const { user, logout, patchUser, tenant } = useSession()
  const nav = useNavigate()
  const qc = useQueryClient()
  if (!user) return null
  const setMode = (m: 'system' | 'light' | 'dark') => {
    patchUser({ prefs: { ...user.prefs, theme_mode: m } })
    if (tenant) applyTheme(tenant.theme, m)
    authApi.prefs({ theme_mode: m }).catch(() => {})
  }
  const mode = user.prefs?.theme_mode ?? 'system'
  return (
    <Menu
      label="Account"
      trigger={
        <button className="flex items-center gap-2 rounded-full p-0.5 hover:bg-surface-2 xl:pr-2.5">
          <Avatar name={user.name} hue={user.avatar_hue} size={32} />
          <span className="hidden text-left xl:block">
            <span className="block max-w-[140px] truncate text-[13px] font-semibold leading-tight">{user.name}</span>
            <span className="block max-w-[140px] truncate text-[11.5px] leading-tight text-ink-3">{user.role_name ?? user.title}</span>
          </span>
        </button>
      }
      items={[
        { label: user.email, icon: <UserIcon />, disabled: true },
        { separator: true, label: '' },
        { label: 'My profile', icon: <UserIcon />, onSelect: () => nav('/settings/profile') },
        { label: 'Settings', icon: <SettingsIcon />, onSelect: () => nav('/settings') },
        { separator: true, label: '' },
        { label: 'Light', icon: <Sun />, hint: mode === 'light' ? '✓' : '', onSelect: () => setMode('light') },
        { label: 'Dark', icon: <Moon />, hint: mode === 'dark' ? '✓' : '', onSelect: () => setMode('dark') },
        { label: 'Match system', icon: <SunMoon />, hint: mode === 'system' ? '✓' : '', onSelect: () => setMode('system') },
        { separator: true, label: '' },
        {
          label: 'Sign out',
          icon: <LogOut />,
          danger: true,
          onSelect: async () => {
            await authApi.logout().catch(() => {})
            logout()
            qc.clear()
            nav('/login')
          },
        },
      ]}
    />
  )
}

/** Roles the signed-in user may preview with View as (their own role first). */
function useViewAsRoles() {
  const { user } = useSession()
  const allowed = !!user?.permissions?.includes('view_as') && !user?.is_super_admin
  const q = useApi(['roles', 'view-as'], () => http.get<(ViewAsRole & { active: boolean; user_count: number })[]>('/roles'), { enabled: allowed, staleTime: 60_000 })
  return { allowed, roles: (q.data ?? []).filter((r) => r.active) }
}

function ViewAsSwitch() {
  const { user, viewAs, setViewAs } = useSession()
  const qc = useQueryClient()
  const { allowed, roles } = useViewAsRoles()
  if (!user || !allowed) return null
  const current = viewAs?.key ?? user.role_key
  return (
    <Menu
      label="View as"
      trigger={
        <Button variant="ghost" size="sm" icon={<Eye className="size-4" />} className="max-md:hidden!">
          <span className="hidden max-w-[180px] truncate xl:inline">{viewAs ? `Viewing as ${viewAs.name}` : 'View as'}</span>
        </Button>
      }
      items={roles.map((r) => ({
        label: r.name,
        hint: current === r.key ? '✓' : '',
        onSelect: () => {
          setViewAs(r.key === user.role_key ? null : { key: r.key, name: r.name, persona: r.persona, permissions: r.permissions })
          qc.invalidateQueries()
        },
      }))}
    />
  )
}

/* ---------------- header week switcher (Feature Guide §1) ---------------- */
const dm = (d: string) => parseISO(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
/** "28 Sept – 2 Oct 2026" (Monday to Friday of the viewed week). */
export function weekRangeLabel(monday: string) {
  const fri = addDays(monday, 4)
  return `${dm(monday)} – ${dm(fri)} ${parseISO(fri).getFullYear()}`
}
/** "This week", "Last week", "Next week", "3 weeks ago", "In 2 weeks". */
export function weekRelLabel(monday: string) {
  const n = Math.round(diffDays(monday, weekStart(todayISO())) / 7)
  return n === 0 ? 'This week' : n === -1 ? 'Last week' : n === 1 ? 'Next week' : n < 0 ? `${-n} weeks ago` : `In ${n} weeks`
}
/** Routes whose numbers follow the header week; on phones the compact switcher shows only there. */
const WEEK_ROUTES = ['/home', '/scorecard', '/timesheet', '/tasks', '/my-tasks', '/sales']

function WeekSwitcher({ compact }: { compact?: boolean }) {
  const week = useUI((s) => s.week)
  const setWeek = useUI((s) => s.setWeek)
  const current = weekStart(todayISO())
  const isCurrent = week === current
  const btn = 'grid size-8 shrink-0 place-items-center rounded-md border border-line bg-surface text-ink-2 transition hover:border-line-strong hover:text-ink'
  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', compact && 'w-full justify-between')} role="group" aria-label="Week">
      <button type="button" className={btn} onClick={() => setWeek(addDays(week, -7))} aria-label="Previous week">
        <ChevronLeft className="size-4" />
      </button>
      <div className={cn('min-w-0 px-1 leading-tight', compact ? 'flex flex-1 items-baseline justify-center gap-2' : 'text-left')}>
        <div className="tnum truncate whitespace-nowrap text-[13.5px] font-semibold text-ink" aria-live="polite">{weekRangeLabel(week)}</div>
        <div className={cn('whitespace-nowrap text-[11.5px]', isCurrent ? 'text-ink-3' : 'font-medium text-brand-text')}>{weekRelLabel(week)}</div>
      </div>
      <button type="button" className={btn} onClick={() => setWeek(addDays(week, 7))} aria-label="Next week">
        <ChevronRight className="size-4" />
      </button>
      {!isCurrent && (
        <button type="button" onClick={() => setWeek(current)} className="ml-0.5 h-8 shrink-0 whitespace-nowrap rounded-md px-2 text-[12.5px] font-medium text-brand-text hover:bg-brand-soft" aria-label="Jump to this week">
          {compact ? 'Today' : 'This week'}
        </button>
      )}
    </div>
  )
}

function MobileWeekBar() {
  const loc = useLocation()
  const { user } = useSession()
  if (user?.is_super_admin || !WEEK_ROUTES.some((r) => loc.pathname === r || (r !== '/sales' && loc.pathname.startsWith(r + '/')))) return null
  return (
    <div className="border-t border-line px-4 py-1.5 md:hidden">
      <WeekSwitcher compact />
    </div>
  )
}

function TopBar() {
  const setCommand = useUI((s) => s.setCommand)
  const openAI = useUI((s) => s.openAI)
  const { tenant, user } = useSession()
  const c = useCan()
  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface pt-[env(safe-area-inset-top,0px)]">
      <div className="flex h-14 items-center gap-2 px-4 lg:px-6">
        <Link to="/home" className="flex min-w-0 items-center gap-2 lg:hidden">
          <TenantMark name={tenant?.name ?? 'S'} logo={tenant?.logo_data_url} size={30} />
          <span className="truncate text-[15px] font-semibold">{user?.is_super_admin ? 'Platform' : tenant?.name?.split(' ')[0]}</span>
        </Link>
        {!user?.is_super_admin && (
          <div className="hidden min-w-0 md:ml-3 md:flex lg:ml-0">
            <WeekSwitcher />
          </div>
        )}
        <button
          onClick={() => setCommand(true)}
          className="ml-auto flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-line bg-surface-2/60 px-2.5 text-[13px] text-ink-3 transition hover:border-line-strong hover:text-ink-2 2xl:w-[300px] 2xl:justify-start 2xl:px-3"
          aria-label="Search"
        >
          <Search className="size-4" />
          <span className="hidden 2xl:inline">Search people, projects, deals…</span>
          <kbd className="ml-auto hidden rounded border border-line bg-surface px-1.5 text-[11px] font-medium text-ink-3 2xl:inline">⌘K</kbd>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <ViewAsSwitch />
          {c('ai.use') && !user?.is_super_admin && (
            <Button variant="subtle" size="sm" className="max-md:hidden!" icon={<Sparkles className="size-4" />} onClick={() => openAI()} aria-label="Ask AI">
              <span className="hidden xl:inline">Ask AI</span>
            </Button>
          )}
          {!user?.is_super_admin && <NotificationBell />}
          <UserMenu />
        </div>
      </div>
      <MobileWeekBar />
    </header>
  )
}

function Banners() {
  const { viewAs, setViewAs, tenant, user } = useSession()
  const qc = useQueryClient()
  const out: ReactNode[] = []
  if (viewAs)
    out.push(
      <div key="va" className="flex items-center justify-center gap-3 bg-accent px-4 py-2 text-center text-[13px] font-semibold text-accent-ink">
        <Eye className="size-4" />
        Viewing as {viewAs.name} — read-only. Changes are disabled.
        <button
          onClick={() => {
            setViewAs(null)
            qc.invalidateQueries()
          }}
          className="rounded-full bg-black/15 px-2.5 py-0.5 text-[12px] hover:bg-black/25"
        >
          Exit
        </button>
      </div>,
    )
  if (tenant?.status === 'read_only')
    out.push(
      <div key="ro" className="flex items-center justify-center gap-2 bg-danger px-4 py-2 text-[13px] font-semibold text-white">
        <AlertTriangle className="size-4" /> Your trial has ended. The workspace is read-only.
        {user?.role === 'admin' && (
          <Link to="/billing" className="underline underline-offset-2">
            Choose a plan
          </Link>
        )}
      </div>,
    )
  else if (tenant?.status === 'trial' && tenant.trial_ends_on) {
    const left = diffDays(tenant.trial_ends_on, todayISO())
    out.push(
      <div key="tr" className="flex items-center justify-center gap-2 bg-brand-soft px-4 py-1.5 text-[12.5px] font-medium text-brand-text">
        Trial: {left} day{left === 1 ? '' : 's'} left.
        {user?.role === 'admin' && (
          <Link to="/billing" className="font-semibold underline underline-offset-2">
            Upgrade
          </Link>
        )}
      </div>,
    )
  }
  return <>{out}</>
}

function MobileTabBar() {
  const role = useEffectiveRole() ?? 'employee'
  const { user } = useSession()
  const setMore = useUI((s) => s.setMore)
  const badges = useBadges()
  const loc = useLocation()
  if (user?.is_super_admin) return null
  const tabs = MOBILE_TABS[role]
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom,0px)] lg:hidden" aria-label="Primary">
      <ul className="mx-auto grid h-[58px] max-w-lg grid-cols-5">
        {tabs.map((t) => {
          const active = loc.pathname === t.to || (t.to !== '/home' && loc.pathname.startsWith(t.to + '/'))
          return (
            <li key={t.to} className="flex">
              <NavLink to={t.to} className="relative flex flex-1 flex-col items-center justify-center gap-0.5">
                <span className="relative">
                  <t.icon className={cn('size-[22px]', active ? 'text-brand-text' : 'text-ink-3')} weight={active ? 'fill' : 'regular'} />
                  {t.badge === 'approvals' && badges.approvals > 0 && <span className="absolute -right-2 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">{badges.approvals}</span>}
                </span>
                <span className={cn('text-[10.5px] font-medium', active ? 'text-brand-text' : 'text-ink-3')}>{t.label}</span>
              </NavLink>
            </li>
          )
        })}
        <li className="flex">
          <button onClick={() => setMore(true)} className="flex flex-1 flex-col items-center justify-center gap-0.5" aria-label="More">
            <MoreHorizontal className="size-[22px] text-ink-3" />
            <span className="text-[10.5px] font-medium text-ink-3">More</span>
          </button>
        </li>
      </ul>
    </nav>
  )
}

function MoreSheet() {
  const { more, setMore } = useUI()
  const sections = useVisibleNav()
  const { user, tenant, viewAs, setViewAs } = useSession()
  const roleName = useEffectiveRoleName()
  const { allowed: canViewAs, roles: viewRoles } = useViewAsRoles()
  const badges = useBadges()
  const loc = useLocation()
  const qc = useQueryClient()
  const active = useActiveNav(sections)
  const { open, toggle } = useOpenGroups(active.group)
  useEffect(() => setMore(false), [loc.pathname, loc.search, setMore])
  return (
    <Sheet open={more} onOpenChange={setMore} title={tenant?.name ?? 'Menu'} subtitle={user ? `${user.name} · ${roleName}` : undefined}>
      {user && canViewAs && (
        <div className="mb-5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">View as</div>
          <div className="flex flex-wrap gap-1.5">
            {viewRoles.map((r) => (
              <button
                key={r.key}
                onClick={() => {
                  setViewAs(r.key === user.role_key ? null : { key: r.key, name: r.name, persona: r.persona, permissions: r.permissions })
                  qc.invalidateQueries()
                }}
                className={cn('h-8 rounded-full border px-3 text-[12.5px] font-semibold', (viewAs?.key ?? user.role_key) === r.key ? 'border-transparent bg-ink text-surface' : 'border-line-strong text-ink-2')}
              >
                {r.name}
              </button>
            ))}
          </div>
        </div>
      )}
      {sections.map((s, i) => {
        const tiles = s.items.filter((it) => !it.children)
        const groups = s.items.filter((it) => it.children)
        return (
          <div key={i} className="mb-4">
            {s.title && <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3">{s.title}</div>}
            {tiles.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {tiles.map((it) => (
                  <Link key={it.to} to={it.to} aria-current={active.to === it.to ? 'page' : undefined} className={cn('relative flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center text-[12px] font-semibold', active.to === it.to ? 'border-brand/30 bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2')}>
                    <it.icon className="size-5" />
                    {it.label}
                    {it.badge === 'approvals' && badges.approvals > 0 && <span className="absolute right-2 top-2"><Badge tone="danger" size="sm">{badges.approvals}</Badge></span>}
                  </Link>
                ))}
              </div>
            )}
            {groups.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                {groups.map((g) => {
                  const isOpen = !!open[g.to]
                  const id = `more-${g.to.replace(/[^a-z0-9]/gi, '-')}`
                  return (
                    <div key={g.to} className="border-b border-line last:border-0">
                      <button type="button" aria-expanded={isOpen} aria-controls={id} onClick={() => toggle(g.to)} className={cn('flex h-12 w-full items-center gap-3 px-3.5 text-left text-[14px]', active.group === g.to ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>
                        <g.icon className="size-5 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1 truncate">{g.label}</span>
                        {!isOpen && <NavBadge item={g} badges={badges} />}
                        <ChevronDown className={cn('size-4 shrink-0 text-ink-3 transition-transform', !isOpen && '-rotate-90')} />
                      </button>
                      {isOpen && (
                        <ul id={id} aria-label={g.label} className="pb-1.5">
                          {g.children!.map((c) => (
                            <li key={c.to}>
                              <Link to={c.to} aria-current={active.to === c.to ? 'page' : undefined} className={cn('mx-1.5 flex h-11 items-center gap-3 rounded-md pl-[46px] pr-3 text-[14px]', active.to === c.to ? 'bg-brand-soft font-semibold text-brand-text' : 'text-ink-2 active:bg-surface-2')}>
                                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                                <NavBadge item={c} badges={badges} />
                              </Link>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </Sheet>
  )
}

/** Keep the signed-in user's permissions and role in sync (an admin may change them while they work). */
function useSyncAccess() {
  const { user, patchUser } = useSession()
  const nav = useNavigate()
  const loc = useLocation()
  const me = useApi(['me'], () => authApi.me(), { enabled: !!user && !user.is_super_admin, refetchInterval: 60_000 })
  const fresh = me.data?.user
  useEffect(() => {
    if (!fresh || !user) return
    const same = fresh.role_key === user.role_key && fresh.role_name === user.role_name && fresh.must_change_password === user.must_change_password && (fresh.permissions ?? []).join() === (user.permissions ?? []).join()
    if (!same) patchUser({ role: fresh.role, role_key: fresh.role_key, role_name: fresh.role_name, permissions: fresh.permissions, must_change_password: fresh.must_change_password })
  }, [fresh, user, patchUser])
  useEffect(() => {
    if (user?.must_change_password && loc.pathname !== '/welcome/password') nav('/welcome/password', { replace: true })
  }, [user?.must_change_password, loc.pathname, nav])
}

export default function AppShell() {
  useSyncAccess()
  const { sidebarCollapsed } = useUI()
  const setCommand = useUI((s) => s.setCommand)
  const loc = useLocation()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCommand(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setCommand])
  useEffect(() => {
    document.getElementById('main')?.scrollTo?.(0, 0)
    window.scrollTo(0, 0)
  }, [loc.pathname])
  // Truncated text gets a native tooltip on hover: any ellipsised leaf without its own title
  // shows its full text, so truncation never hides information (CONVENTIONS visual sweep).
  useEffect(() => {
    const onOver = (e: Event) => {
      const t = e.target
      if (!(t instanceof HTMLElement) || t.title || t.childElementCount > 0) return
      const cs = getComputedStyle(t)
      if (cs.textOverflow === 'ellipsis' && t.scrollWidth > t.clientWidth + 1) t.title = t.textContent?.trim() ?? ''
    }
    document.addEventListener('mouseover', onOver, { passive: true })
    return () => document.removeEventListener('mouseover', onOver)
  }, [])
  return (
    <div className="min-h-full">
      <Sidebar />
      <div className={cn('flex min-h-full flex-col transition-[padding] duration-200', sidebarCollapsed ? 'lg:pl-[72px]' : 'lg:pl-[248px]')}>
        <Banners />
        <TopBar />
        <main id="main" className="mx-auto w-full max-w-[1680px] flex-1 px-4 pb-[calc(88px+env(safe-area-inset-bottom,0px))] pt-5 md:px-6 lg:px-8 lg:pb-12 lg:pt-7">
          <Suspense fallback={<PageLoading />}>
            <div key={loc.pathname.split('/').slice(0, 2).join('/')} className="fade-up">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>
      <MobileTabBar />
      <MoreSheet />
      <CommandPalette />
      <TaskDrawerHost />
      <AIAssistantHost />
    </div>
  )
}

export function PageLoading() {
  return (
    <div className="space-y-6 pt-2">
      <div className="skeleton h-8 w-56" />
      <SkeletonRows rows={7} />
    </div>
  )
}

export { MenuIcon, X, RotateCcw, IconButton }
