// UI-36 /insights and /insights/:view — ten role-scoped views as tabs: the 8 spec views plus
// delivery predictions (P50/P80 Monte-Carlo) and estimation accuracy. Each view: explanation, KPIs,
// table (cards on phones), Export and "Ask AI about this".
import { useMemo } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { BarChart3, Sparkles } from '@/ui/icons'
import { useInsight, useInsightTabs, type InsightCell, type InsightColumn, type InsightResult, type InsightViewId } from '@/api/dashboards'
import { useUI } from '@/stores/ui'
import { Avatar, Badge, Button, Card, DataTable, EmptyState, ErrorState, PageHeader, SkeletonCards, SkeletonRows, Tooltip, useCan, type Column } from '@/ui'
import { ExportMenu } from '@/reports/ExportMenu'
import type { ExportColType, ExportTable } from '@/reports/export'
import { fmtDate, weekLabel } from '@/domain/calendar'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'
import { WEEK_STATUS, type Tone } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { Kpi } from './kit'

type Row = Record<string, InsightCell>

const GROUP_LABEL = { prediction: 'Looking ahead', delivery: 'Delivery', people: 'People', sales: 'Sales' } as const
/** Feature Guide §15: Insights looks ahead first — it opens on Delivery predictions, then Estimation accuracy. */
const GROUP_ORDER = ['prediction', 'delivery', 'people', 'sales'] as const

function chanceTone(v: number): Tone {
  return v >= 0.8 ? 'success' : v >= 0.5 ? 'warning' : 'danger'
}

function Cell({ col, row }: { col: InsightColumn; row: Row }) {
  const v = row[col.key]
  const openTask = useUI((s) => s.openTask)
  if (v === null || v === undefined || v === '') return <span className="text-ink-3">—</span>
  switch (col.type) {
    case 'money':
      return <span className="tnum">{fmtMoney(v as number)}</span>
    case 'percent':
      return <span className="tnum">{fmtPct(v as number, 0)}</span>
    case 'hours':
      return <span className="tnum">{fmtNum(v as number, 1)}h</span>
    case 'days': {
      const n = v as number
      return <span className={cn('tnum', col.key === 'late' || col.key === 'days_idle' || col.key === 'since' ? 'font-semibold text-danger-text' : n <= 1 ? 'font-semibold text-warning-text' : '')}>{n}d</span>
    }
    case 'ratio': {
      const n = v as number
      const tone = (row[`${col.key}_tone`] as Tone | undefined) ?? (n > 1.3 ? 'danger' : n > 1.1 ? 'warning' : 'success')
      return <span className={cn('tnum font-semibold', tone === 'danger' ? 'text-danger-text' : tone === 'warning' ? 'text-warning-text' : 'text-success-text')}>×{n.toFixed(2)}</span>
    }
    case 'number':
      return <span className="tnum">{fmtNum(v as number, 2)}</span>
    case 'date':
      return <span className="tnum whitespace-nowrap">{fmtDate(v as string)}</span>
    case 'chance': {
      const n = v as number
      return (
        <Badge size="sm" tone={chanceTone(n)}>
          {fmtPct(n, 0)}
        </Badge>
      )
    }
    case 'badge':
      return (
        <Badge size="sm" tone={(row[`${col.key}_tone`] as Tone) ?? 'neutral'}>
          {String(v)}
        </Badge>
      )
    case 'person':
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          <Avatar name={String(v)} hue={(row[`${col.key}_hue`] as number) ?? 150} size={24} />
          <span className="truncate font-medium">{String(v)}</span>
        </span>
      )
    case 'task':
      return (
        <button onClick={(e) => (e.stopPropagation(), openTask(String(row.task_id ?? row.id)))} className="block max-w-full truncate text-left font-medium text-ink hover:text-brand-text hover:underline md:max-w-[340px]">
          {String(v)}
        </button>
      )
    case 'project':
      return row.project_id ? (
        <Link to={`/projects/${row.project_id}`} onClick={(e) => e.stopPropagation()} className="block max-w-[240px] truncate hover:text-brand-text hover:underline">
          {String(v)}
        </Link>
      ) : (
        <span>{String(v)}</span>
      )
    case 'deal':
      return (
        <Link to={`/sales/${row.deal_id ?? row.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-brand-text hover:underline">
          {String(v)}
        </Link>
      )
    case 'weeks': {
      const ws = v as string[]
      return (
        <span className="inline-flex gap-1">
          {ws.map((w, i) => (
            <Tooltip key={i} content={w === 'missing' ? 'Not started' : WEEK_STATUS[w as keyof typeof WEEK_STATUS]?.label ?? w}>
              <span className={cn('h-5 w-3 rounded-[3px]', w === 'approved' ? 'bg-success' : w === 'submitted' ? 'bg-warning' : w === 'open' ? 'bg-info/60' : 'bg-danger')} />
            </Tooltip>
          ))}
        </span>
      )
    }
    default:
      return <span className="line-clamp-2">{String(v)}</span>
  }
}

/** A cell plus its optional second line (row[`${key}_sub`]), e.g. "76% done, 148h left" or "backup Hritesh Panda". */
function CellSub({ col, row }: { col: InsightColumn; row: Row }) {
  const sub = row[`${col.key}_sub`]
  if (sub === undefined || sub === null || sub === '') return <Cell col={col} row={row} />
  return (
    <span className={cn('flex min-w-0 max-w-full flex-col', col.align === 'right' ? 'items-end' : 'items-start')}>
      <Cell col={col} row={row} />
      <span className="mt-0.5 max-w-full truncate text-[11.5px] font-normal text-ink-3">{String(sub)}</span>
    </span>
  )
}

function exportType(t: InsightColumn['type']): ExportColType {
  return t === 'money' ? 'money' : t === 'percent' || t === 'chance' ? 'percent' : t === 'hours' ? 'hours' : t === 'date' ? 'date' : t === 'number' || t === 'days' || t === 'ratio' ? 'number' : 'string'
}
function toExport(d: InsightResult, cols: InsightColumn[], rows: Row[], title: string, weeks?: string[]): ExportTable {
  return {
    title,
    subtitle: `Insights · ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    columns: cols.map((c) => ({ key: c.key, label: c.label, type: exportType(c.type) })),
    rows: rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, Array.isArray(r[c.key]) ? (r[c.key] as string[]).map((w, i) => `${weeks?.[i] ? weekLabel(weeks[i]).split(' – ')[0] : ''}: ${w}`).join('; ') : (r[c.key] as string | number | null)]))),
    kpis: d.kpis.map((k) => ({ label: k.label, value: k.value === null ? '—' : k.format === 'money' ? fmtMoney(k.value) : k.format === 'percent' ? fmtPct(k.value, 0) : k.format === 'ratio' ? `×${k.value.toFixed(2)}` : k.format === 'hours' ? `${fmtNum(k.value, 1)}h` : k.format === 'days' ? `${k.value}d` : fmtNum(k.value) })),
    notes: [d.explanation],
  }
}

function InsightTable({ cols, rows, empty }: { cols: InsightColumn[]; rows: Row[]; empty: string }) {
  const openTask = useUI((s) => s.openTask)
  const nav = useNavigate()
  const columns: Column<Row>[] = cols.map((c) => ({
    key: c.key,
    header: c.label,
    align: c.align,
    hideBelow: c.hideBelow,
    cell: (r) => <CellSub col={c} row={r} />,
    sortValue: c.type === 'weeks' ? undefined : (r) => (typeof r[c.key] === 'number' || typeof r[c.key] === 'string' ? (r[c.key] as string | number) : null),
  }))
  const title = cols[0]
  const rest = cols.slice(1)
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => String(r.id)}
      columns={columns}
      dense
      onRowClick={(r) => (r.task_id ? openTask(String(r.task_id)) : r.deal_id ? nav(`/sales/${r.deal_id}`) : r.project_id ? nav(`/projects/${r.project_id}`) : undefined)}
      empty={<EmptyState compact title="All clear" body={empty} />}
      mobileCard={(r) => (
        <div className="space-y-2">
          <div className="min-w-0 text-[14px]">
            <CellSub col={title} row={r} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12.5px]">
            {rest.map((c) => (
              <div key={c.key} className={cn('min-w-0', c.type === 'weeks' && 'col-span-2')}>
                <dt className="text-[11px] text-ink-3">{c.label}</dt>
                <dd className="min-w-0 truncate">
                  <CellSub col={c} row={r} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    />
  )
}

function InsightView({ view }: { view: InsightViewId }) {
  const q = useInsight(view)
  const openAI = useUI((s) => s.openAI)
  const c = useCan()
  const d = q.data
  if (q.isLoading)
    return (
      <div className="space-y-4">
        <SkeletonCards n={3} />
        <SkeletonRows rows={6} />
      </div>
    )
  if (q.error || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <p className="max-w-[80ch] text-[13.5px] leading-relaxed text-ink-2">{d.explanation}</p>
        <div className="flex shrink-0 items-center gap-2">
          {c('ai.use') && (
            <Button size="sm" onClick={() => openAI(d.ask, `insight:${view}`)}>
              Ask AI about this
            </Button>
          )}
          <ExportMenu table={() => toExport(d, d.columns, d.rows as Row[], d.title, d.weeks)} filename={`insight-${view}`} />
        </div>
      </div>
      <div className={cn('grid grid-cols-2 gap-2.5 md:gap-3', d.kpis.length >= 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-3')}>
        {d.kpis.map((k) => (
          <Kpi
            key={k.label}
            label={k.label}
            hint={k.hint}
            tone={k.tone}
            value={k.value === null ? '—' : k.format === 'money' ? fmtMoney(k.value) : k.format === 'percent' ? fmtPct(k.value, 0) : k.format === 'ratio' ? `×${k.value.toFixed(2)}` : k.format === 'hours' ? `${fmtNum(k.value, 1)}h` : k.format === 'days' ? `${k.value}d` : fmtNum(k.value)}
          />
        ))}
      </div>
      {d.main_title && <h2 className="pt-2 text-[14px] font-semibold">{d.main_title}</h2>}
      <InsightTable cols={d.columns} rows={d.rows as Row[]} empty={d.empty} />
      {d.sections?.map((s) => (
        <section key={s.title} className="pt-2">
          <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-[14px] font-semibold">{s.title}</h2>
              {s.subtitle && <p className="text-[12.5px] text-ink-3">{s.subtitle}</p>}
            </div>
            <ExportMenu size="xs" variant="ghost" table={() => toExport(d, s.columns, s.rows as Row[], `${d.title} — ${s.title}`)} filename={`insight-${view}-${s.title}`} />
          </div>
          <InsightTable cols={s.columns} rows={s.rows as Row[]} empty={s.empty} />
        </section>
      ))}
    </div>
  )
}

export default function InsightsPage() {
  const { view } = useParams<{ view?: string }>()
  const tabs = useInsightTabs()
  const nav = useNavigate()
  const list = useMemo(() => [...(tabs.data ?? [])].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)), [tabs.data])
  if (tabs.isLoading)
    return (
      <div>
        <PageHeader title="Insights" />
        <SkeletonRows rows={6} />
      </div>
    )
  if (tabs.error) return <ErrorState error={tabs.error} onRetry={() => tabs.refetch()} />
  if (!list.length)
    return (
      <div>
        <PageHeader title="Insights" />
        <Card>
          <EmptyState icon={<BarChart3 />} title="No insights for your role" body="Insights cover delivery, people and sales. Your dashboard has everything for your own work." />
        </Card>
      </div>
    )
  const current = list.find((t) => t.id === view)?.id
  if (!current) return <Navigate to={`/insights/${(list.find((t) => t.id === 'predictions') ?? list[0]).id}`} replace />
  const groups = GROUP_ORDER.map((g) => ({ g, items: list.filter((t) => t.group === g) })).filter((x) => x.items.length)
  const cur = list.find((t) => t.id === current)!
  return (
    <div>
      <PageHeader title="Insights" subtitle="Predictions and exceptions built from your own history. Everything here is computed live from tasks, hours, allocations and deals." />
      <div className="lg:grid lg:grid-cols-[232px_minmax(0,1fr)] lg:gap-6">
        {/* desktop: grouped side nav */}
        <nav className="hidden lg:block" aria-label="Insight views">
          <div className="sticky top-24 space-y-4">
            {groups.map(({ g, items }) => (
              <div key={g}>
                <div className="mb-1 px-2.5 text-[12px] font-medium text-ink-3">{GROUP_LABEL[g]}</div>
                <ul className="space-y-0.5">
                  {items.map((t) => (
                    <li key={t.id}>
                      <Link to={`/insights/${t.id}`} className={cn('flex h-9 items-center justify-between gap-2 rounded-md px-2.5 text-[13.5px] font-medium transition', t.id === current ? 'bg-brand-soft text-brand-text' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
                        <span className="truncate">{t.label}</span>
                        {t.count !== null && <span className={cn('tnum shrink-0 text-[12px]', t.count ? 'text-ink-2' : 'text-ink-3')}>{t.count}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </nav>
        {/* phone/tablet: swipeable chips */}
        <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 no-scrollbar md:mx-0 md:flex-wrap md:px-0 lg:hidden">
          {list.map((t) => (
            <button key={t.id} onClick={() => nav(`/insights/${t.id}`)} aria-pressed={t.id === current} className={cn('inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium transition', t.id === current ? 'border-brand bg-brand-soft text-brand-text' : 'border-line bg-surface text-ink-2')}>
              {t.label}
              {t.count !== null && <span className={cn('tnum text-[12px]', t.id === current ? 'opacity-70' : 'text-ink-3')}>{t.count}</span>}
            </button>
          ))}
        </div>
        <div className="min-w-0">
          <h2 className="mb-2 hidden text-[16px] font-semibold lg:block">{cur.label}</h2>
          <InsightView key={current} view={current} />
        </div>
      </div>
    </div>
  )
}
