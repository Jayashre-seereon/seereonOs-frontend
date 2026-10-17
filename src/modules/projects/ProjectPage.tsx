import { useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { ChevronLeft, Eye, FileUp, Pencil, Receipt } from '@/ui/icons'
import { projectsApi, type ProjectDetail } from '@/api/projects'
import { useApi } from '@/api/query'
import { HEALTH, PROJECT_STATUS, PROJECT_TYPE, BILLING_MODEL } from '@/domain/labels'
import { fmtDate, diffDays } from '@/domain/calendar'
import { fmtHours, fmtMoneyCompact, fmtPct } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Badge, Button, Card, ErrorState, NavTabs, PersonName, Skeleton, SkeletonCards, StatusBadge, useCan, useReadOnly } from '@/ui'
import { ProjectFormDialog } from './components/ProjectFormDialog'
import { fmtRatio, marginTone, MiniStat, PROJECT_STATUS_MEANING, ProjectStatusMenu, ratioTone, spiTone, useProjectStatusChange } from './components/shared'
import { OverviewTab } from './tabs/OverviewTab'
import { WbsTab } from './tabs/WbsTab'
import { ScheduleTab } from './tabs/ScheduleTab'
import { TeamTab } from './tabs/TeamTab'
import { CostingTab } from './tabs/CostingTab'
import { ChangesTab } from './tabs/ChangesTab'
import { ActivityTab } from './tabs/ActivityTab'
import ProjectDocumentsPanel from '@/modules/documents/ProjectDocumentsPanel'

const TABS = ['overview', 'wbs', 'schedule', 'team', 'documents', 'costing', 'changes', 'activity'] as const
type TabKey = (typeof TABS)[number]
const ALIAS: Record<string, TabKey> = { allocation: 'team', gantt: 'schedule', 'change-requests': 'changes', money: 'costing', margins: 'costing' }

export default function ProjectPage() {
  const { id = '', tab: rawTab } = useParams()
  const tab: TabKey | null = !rawTab ? 'overview' : (TABS as readonly string[]).includes(rawTab) ? (rawTab as TabKey) : ALIAS[rawTab] ?? null
  const q = useApi(['project', id], () => projectsApi.detail(id))
  if (rawTab && !tab) return <Navigate to={`/projects/${id}`} replace />
  if (rawTab && ALIAS[rawTab]) return <Navigate to={`/projects/${id}/${ALIAS[rawTab]}`} replace />
  if (q.isLoading) return <HeaderSkeleton />
  if (q.error || !q.data)
    return (
      <div>
        <BackLink />
        <Card>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </Card>
      </div>
    )
  const d = q.data
  const showMoney = d.can_see_money
  const showChanges = d.can_edit || d.change_requests.length > 0
  const current: TabKey = (tab === 'costing' && !showMoney) || (tab === 'changes' && !showChanges) ? 'overview' : tab!
  return (
    <div>
      <Header d={d} />
      <NavTabs
        tabs={[
          { to: `/projects/${id}`, label: 'Overview', end: true },
          { to: `/projects/${id}/wbs`, label: 'WBS' },
          { to: `/projects/${id}/schedule`, label: 'Schedule' },
          { to: `/projects/${id}/team`, label: 'Team & allocation' },
          { to: `/projects/${id}/documents`, label: 'Documents' },
          { to: `/projects/${id}/costing`, label: 'Costing & margin', hidden: !showMoney },
          { to: `/projects/${id}/changes`, label: 'Changes', hidden: !showChanges },
          { to: `/projects/${id}/activity`, label: 'Activity' },
        ]}
      />
      {current === 'overview' && <OverviewTab d={d} />}
      {current === 'wbs' && <WbsTab d={d} />}
      {current === 'schedule' && <ScheduleTab d={d} />}
      {current === 'team' && <TeamTab d={d} />}
      {current === 'documents' && <ProjectDocumentsPanel projectId={d.project.id} />}
      {current === 'costing' && <CostingTab d={d} />}
      {current === 'changes' && <ChangesTab d={d} />}
      {current === 'activity' && <ActivityTab d={d} />}
    </div>
  )
}

function BackLink() {
  return (
    <Link to="/projects" className="-ml-0.5 mb-1.5 inline-flex items-center gap-1 text-[13px] font-medium text-ink-3 hover:text-ink">
      <ChevronLeft className="size-3.5" />
      Projects & WBS
    </Link>
  )
}

function HeaderSkeleton() {
  return (
    <div aria-busy="true">
      <Skeleton className="mb-3 h-3 w-20" />
      <Skeleton className="h-8 w-2/3 max-w-[420px]" />
      <Skeleton className="mt-3 h-4 w-1/2 max-w-[300px]" />
      <div className="mt-6">
        <SkeletonCards n={4} />
      </div>
      <Skeleton className="mt-6 h-10 w-full" />
    </div>
  )
}

function Header({ d }: { d: ProjectDetail }) {
  const p = d.project
  const m = d.metrics
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const canInvoice = useCan()('finance.edit')
  const [editing, setEditing] = useState(false)
  const { change, pending } = useProjectStatusChange()
  const lateBy = p.baseline_end_on && p.end_on > p.baseline_end_on ? diffDays(p.end_on, p.baseline_end_on) : 0
  const live = ['active', 'initiated'].includes(p.status)
  const kpis = [
    { label: 'Progress', value: fmtPct(m.progress, 0), sub: `${fmtHours(m.est_hours - m.remaining_hours)} of ${fmtHours(m.est_hours)}`, tone: undefined },
    { label: 'Effort ratio', value: fmtRatio(m.effort_ratio), sub: `${fmtHours(m.actual_hours)} logged`, tone: ratioTone(m.effort_ratio) },
    { label: 'SPI', value: m.spi === null ? '—' : m.spi.toFixed(2), sub: m.overdue_tasks ? `${m.overdue_tasks} overdue tasks` : 'Earned ÷ planned', tone: spiTone(m.spi) },
    ...(m.projected_margin !== null ? [{ label: 'Projected margin', value: fmtPct(m.projected_margin), sub: `Cost ${fmtMoneyCompact(m.projected_cost)}`, tone: marginTone(m.projected_margin) }] : []),
    ...(m.invoiced !== null ? [{ label: 'Invoiced', value: fmtMoneyCompact(m.invoiced), sub: m.contract_value !== null ? `of ${fmtMoneyCompact(m.contract_value)} contract` : 'Raised to date', tone: undefined }] : []),
    ...(m.collected !== null ? [{ label: 'Collected', value: fmtMoneyCompact(m.collected), sub: m.outstanding ? `${fmtMoneyCompact(m.outstanding)} outstanding` : 'Nothing outstanding', tone: undefined }] : []),
  ]
  return (
    <header className="mb-4">
      <BackLink />
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.01em] text-ink md:text-[22px]">{p.name}</h1>
          <div className="mt-1 text-[13px] text-ink-3">
            <span className="tnum">{p.code}</span> · {p.client} · {PROJECT_TYPE[p.type]} · {BILLING_MODEL[p.billing_model]} · P{p.priority}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="inline-flex items-center gap-1.5">
              <ProjectStatusMenu p={p} disabled={!d.can_edit || readOnly || pending} title={`${PROJECT_STATUS[p.status].label}: ${PROJECT_STATUS_MEANING[p.status]}`} onChange={(s) => change(p, s)}>
                <StatusBadge map={PROJECT_STATUS} value={p.status} />
              </ProjectStatusMenu>
              {live && <StatusBadge map={HEALTH} value={m.health} />}
            </span>
            <span className="inline-flex min-w-0 items-center text-[13px] text-ink-2">
              <PersonName id={p.pm_id} size={20} />
            </span>
            <span className="tnum whitespace-nowrap text-[13px] text-ink-3">
              {fmtDate(p.start_on)} – {fmtDate(p.end_on)}
            </span>
            {lateBy > 0 && (
              <Badge tone="danger" size="sm">
                +{lateBy}d vs baseline
              </Badge>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
          <Button size="sm" icon={<Eye className="size-4" />} onClick={() => nav(`/projects/${p.id}/client-view`)}>
            Client view
          </Button>
          {canInvoice && (
            <Button size="sm" icon={<Receipt className="size-4" />} disabled={readOnly} onClick={() => nav(`/finance/invoices/new?project=${p.id}`)}>
              Create invoice
            </Button>
          )}
          {d.can_edit && (
            <>
              <Button size="sm" icon={<FileUp className="size-4" />} disabled={readOnly} onClick={() => nav(`/projects/${p.id}/import`)}>
                Import WBS
              </Button>
              <Button size="sm" icon={<Pencil className="size-4" />} disabled={readOnly} onClick={() => setEditing(true)}>
                Edit
              </Button>
            </>
          )}
        </div>
      </div>
      <Card className="mt-4 overflow-hidden" pad={false}>
        <div className={cn('-mb-px -mr-px grid grid-cols-2', kpis.length >= 5 ? 'md:grid-cols-3 xl:grid-cols-6' : 'md:grid-cols-4', kpis.length === 5 && 'xl:grid-cols-5')}>
          {kpis.map((k) => (
            <div key={k.label} className="min-w-0 border-b border-r border-line px-4 py-3">
              <MiniStat label={k.label} value={k.value} sub={k.sub} tone={k.tone} />
            </div>
          ))}
        </div>
      </Card>
      {d.can_edit && <ProjectFormDialog open={editing} onOpenChange={setEditing} project={p} />}
    </header>
  )
}
