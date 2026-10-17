// G11.05 Sales activity log: every activity, stage change and new lead in the last N days, by person and deal.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download } from '@/ui/icons'
import { Badge, Button, Card, DataTable, EmptyState, PageHeader, Segmented, Select, type Column } from '@/ui'
import { useSalesActivity, type ActivityLogItem } from '@/api/sales'
import { fmtDate } from '@/domain/calendar'
import { SALES_LOG_KIND, type SalesLogKind } from '@/domain/sales'
import { exportTable } from '@/reports/export'

const DAYS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]
const KIND_TONE: Partial<Record<SalesLogKind, 'success' | 'info' | 'brand' | 'neutral' | 'warning'>> = { new_lead: 'success', stage: 'info', proposal: 'brand', demo: 'brand' }
const short = (d: string) => fmtDate(d).replace(/\s\d{4}$/, '')

export default function ActivityLogPage() {
  const nav = useNavigate()
  const [days, setDays] = useState('30')
  const [who, setWho] = useState('')
  const q = useSalesActivity({ days: Number(days), user_id: who || undefined })
  const d = q.data
  const everyone = d?.total ?? 0

  const doExport = () => {
    if (!d) return
    exportTable(
      {
        title: `Sales activity log, last ${days} days`,
        subtitle: `${fmtDate(d.from, 'long')} – ${fmtDate(d.to, 'long')}${who ? ` · ${d.people.find((p) => p.user_id === who)?.name ?? ''}` : ' · Everyone'}`,
        orientation: 'landscape',
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'who', label: 'Who', type: 'string' }, { key: 'deal', label: 'Deal', type: 'string' }, { key: 'client', label: 'Company', type: 'string' },
          { key: 'what', label: 'What', type: 'string' }, { key: 'detail', label: 'Detail', type: 'string' },
        ],
        rows: d.items.map((x) => ({ date: x.date, who: x.who_name, deal: x.deal_title, client: x.client, what: x.what, detail: x.detail })),
      },
      'xlsx',
    )
  }

  const cols: Column<ActivityLogItem>[] = [
    { key: 'date', header: 'Date', width: '92px', sortValue: (x) => x.at, cell: (x) => <span className="tnum whitespace-nowrap text-ink-2">{short(x.date)}</span> },
    { key: 'who', header: 'Who', sortValue: (x) => x.who_name, cell: (x) => <span className="whitespace-nowrap text-ink">{x.who_name}</span> },
    {
      key: 'deal', header: 'Deal', sortValue: (x) => x.deal_title.toLowerCase(),
      cell: (x) => (
        <div className="min-w-0">
          <div className="truncate text-ink">{x.deal_title}</div>
          <div className="truncate text-[12px] text-ink-3">{x.client}</div>
        </div>
      ),
    },
    { key: 'what', header: 'What', sortValue: (x) => x.what, cell: (x) => <WhatBadge x={x} /> },
    { key: 'detail', header: 'Detail', cell: (x) => <span className="line-clamp-2 break-words text-ink-2">{x.detail}</span> },
  ]

  const personOptions = [{ value: '', label: `Everyone (${everyone})` }, ...(d?.people ?? []).map((p) => ({ value: p.user_id, label: `${p.name} (${p.count})` }))]

  return (
    <div>
      <PageHeader
        title="Sales activity log"
        subtitle="Every call, message, meeting, demo, proposal, stage change and new lead — by person and deal."
        actions={
          <Button icon={<Download className="size-4" />} onClick={doExport} disabled={!d?.items.length} className="flex-1 md:flex-none">
            Export
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <Segmented size="sm" value={days} onChange={setDays} options={DAYS} />
        <Select aria-label="Salesperson" value={who} onChange={(e) => setWho(e.target.value)} options={personOptions} className="sm:w-64" />
        {d && (
          <p className="tnum text-[12.5px] text-ink-3 sm:ml-auto">
            {d.items.length} {d.items.length === 1 ? 'entry' : 'entries'} · {short(d.from)} – {short(d.to)}
          </p>
        )}
      </div>
      {d && d.items.length > 0 && (
        <Card className="mb-4">
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5 lg:grid-cols-9">
            {(Object.keys(SALES_LOG_KIND) as SalesLogKind[]).map((k) => (
              <div key={k} className="min-w-0">
                <dt className="truncate text-[12px] text-ink-3">{SALES_LOG_KIND[k]}</dt>
                <dd className="tnum text-[16px] font-semibold text-ink">{d.by_kind[k] ?? 0}</dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
      <DataTable
        rows={d?.items}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        columns={cols}
        rowKey={(x) => x.id}
        onRowClick={(x) => nav(`/sales/${x.deal_id}`)}
        initialSort={{ key: 'date', dir: 'desc' }}
        empty={<EmptyState title="No sales activity" body={who ? 'Nothing logged by this person in the period. Try Everyone or a longer period.' : 'Log calls, WhatsApp messages and meetings on a deal; stage changes and new leads appear here too.'} compact />}
        mobileCard={(x) => (
          <div className="min-w-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium text-ink">{x.deal_title}</div>
                <div className="truncate text-[12.5px] text-ink-3">{x.client}</div>
              </div>
              <WhatBadge x={x} />
            </div>
            <p className="mt-1.5 line-clamp-2 break-words text-[13px] text-ink-2">{x.detail}</p>
            <p className="tnum mt-1 text-[12px] text-ink-3">{short(x.date)} · {x.who_name}</p>
          </div>
        )}
      />
    </div>
  )
}

function WhatBadge({ x }: { x: ActivityLogItem }) {
  const tone = KIND_TONE[x.kind]
  return tone ? <Badge tone={tone} size="sm">{x.what}</Badge> : <span className="whitespace-nowrap text-ink">{x.what}</span>
}
