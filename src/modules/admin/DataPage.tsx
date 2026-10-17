import { useState } from 'react'
import { Download, FileJson, FileSpreadsheet } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, useExports } from '@/api/admin'
import { fmtDateTime } from '@/domain/calendar'
import type { DataExport } from '@/types/entities'
import { Badge, Button, Callout, Card, Dialog, EmptyState, ErrorState, PageHeader, SectionTitle, SkeletonRows, toast, useReadOnly } from '@/ui'
import { saveFile, toCSV } from '@/lib/utils'
import { useSession } from '@/stores/session'

type Dump = Awaited<ReturnType<typeof adminApi.downloadExport>>

function left(iso: string | null) {
  const ms = iso ? new Date(iso).getTime() - Date.now() : 0
  const h = Math.floor(ms / 3600000)
  return h >= 1 ? `${h}h ${Math.floor((ms % 3600000) / 60000)}m` : `${Math.max(1, Math.round(ms / 60000))}m`
}

function flat(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'object') return JSON.stringify(v)
  return v as string | number | boolean
}

export default function DataPage() {
  const q = useExports()
  const { tenant } = useSession()
  const readOnly = useReadOnly()
  const [picked, setPicked] = useState<{ x: DataExport; dump: Dump } | null>(null)
  const req = useMut(() => adminApi.requestExport(), { invalidate: [['exports'], ['notifications']], success: 'Export ready — download it within 24 hours' })
  const fetchDump = useMut((x: DataExport) => adminApi.downloadExport(x.id), { invalidate: [['exports']], onSuccess: (dump, x) => setPicked({ x, dump }) })
  const slug = tenant?.slug ?? 'workspace'

  const saveJson = async (d: Dump) => {
    const r = await saveFile(`${slug}-export-${d.generated_at?.slice(0, 10)}.json`, JSON.stringify(d, null, 2), 'application/json')
    if (r === 'saved') toast.success('JSON downloaded')
  }
  const saveCsv = async (name: string, list: Record<string, unknown>[]) => {
    const cols = [...new Set(list.flatMap((r) => Object.keys(r)))]
    const r = await saveFile(`${slug}-${name}.csv`, toCSV([cols, ...list.map((row) => cols.map((c) => flat(row[c])))]), 'text/csv')
    if (r === 'saved') toast.success(`${name}.csv downloaded`)
  }

  const now = new Date().toISOString()
  const status = (x: DataExport) => (x.status === 'ready' && x.expires_at && x.expires_at < now ? 'expired' : x.status)

  return (
    <div>
      <PageHeader title="Data & export" subtitle="Your company owns its data. Export everything, any time." />
      <Card className="mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <h2 className="text-[14px] font-semibold">Full workspace export</h2>
            <p className="mt-0.5 text-[13.5px] text-ink-3">People, projects, tasks, timesheets, leave, cost rates, invoices, payroll, deals, ledger and settings — as one JSON file plus a CSV per table. Passwords and session tokens are never included.</p>
          </div>
          <Button variant="primary" loading={req.isPending} disabled={readOnly} onClick={() => req.mutate(undefined)} className="w-full sm:w-auto">
            Request export
          </Button>
        </div>
      </Card>
      <Callout tone="neutral" className="mb-2">
        Download links expire 24 hours after the export is ready. Every request and download is recorded in the activity log. You’ll get a notification when an export is ready.
      </Callout>

      <SectionTitle>History</SectionTitle>
      {q.isLoading ? (
        <SkeletonRows rows={3} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data?.length ? (
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState compact icon={<Download />} title="No exports yet" body="Request one above. It’s ready in seconds." />
        </div>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {q.data.map((x) => {
            const s = status(x)
            return (
              <div key={x.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">
                    Export · {fmtDateTime(x.created_at)}
                    <Badge size="sm" tone={s === 'ready' ? 'success' : s === 'queued' ? 'info' : 'neutral'}>{s === 'ready' ? 'Ready' : s === 'queued' ? 'Preparing' : 'Expired'}</Badge>
                  </div>
                  <div className="text-[12.5px] text-ink-3">
                    {Math.max(1, Math.round(x.size_bytes / 1024))} KB · {s === 'ready' ? `link expires in ${left(x.expires_at)}` : s === 'expired' ? `expired ${fmtDateTime(x.expires_at)}` : 'preparing'}
                  </div>
                </div>
                <Button size="sm" variant={s === 'ready' ? 'secondary' : 'ghost'} disabled={s !== 'ready'} loading={fetchDump.isPending && fetchDump.variables?.id === x.id} icon={<Download className="size-3.5" />} onClick={() => fetchDump.mutate(x)}>
                  Download
                </Button>
              </div>
            )
          })}
        </div>
      )}

      {picked && (
        <Dialog
          open
          onOpenChange={(o) => !o && setPicked(null)}
          size="lg"
          title="Download export"
          description={`Generated ${fmtDateTime(picked.dump.generated_at)} · ${Object.values(picked.dump.tables).reduce((s, t) => s + t.length, 0).toLocaleString('en-IN')} rows in ${Object.keys(picked.dump.tables).length} tables`}
          footer={<Button onClick={() => setPicked(null)}>Done</Button>}
        >
          <Button variant="primary" block size="lg" icon={<FileJson className="size-4" />} onClick={() => saveJson(picked.dump)}>
            Download everything (.json)
          </Button>
          <h3 className="mb-2 mt-5 text-[13.5px] font-semibold text-ink">Or one table as CSV</h3>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {Object.entries(picked.dump.tables)
              .filter(([, t]) => t.length)
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([name, list]) => (
                <button key={name} type="button" onClick={() => saveCsv(name, list)} className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-left transition hover:bg-surface-2">
                  <FileSpreadsheet className="size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{name}</span>
                  <span className="tnum text-[12px] text-ink-3">{list.length}</span>
                </button>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  )
}
