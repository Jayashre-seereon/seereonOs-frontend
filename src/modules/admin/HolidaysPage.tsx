import { useMemo, useState } from 'react'
import { CalendarPlus, ChevronLeft, ChevronRight, Download, FileUp, MoreHorizontal, Pencil, Trash2 } from '@/ui/icons'
import { useMut } from '@/api/query'
import { adminApi, useHolidays, type HolidayImportRow } from '@/api/admin'
import { useSession } from '@/stores/session'
import { dayKind, parseISO, todayISO, type CalendarCtx } from '@/domain/calendar'
import type { Holiday } from '@/types/entities'
import { Badge, Button, Callout, Checkbox, Dialog, EmptyState, ErrorState, Field, FileUpload, IconButton, Input, Menu, PageHeader, Segmented, SkeletonRows, Textarea, useCan, useConfirm, useReadOnly } from '@/ui'
import { cn, groupBy, parseCSV, readFileAsText, saveFile, toCSV } from '@/lib/utils'
import { errField } from './kit'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export default function HolidaysPage() {
  const thisYear = Number(todayISO().slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const q = useHolidays(year)
  const c = useCan()
  const readOnly = useReadOnly()
  const canEdit = c('holidays.edit') && !readOnly
  const { tenant } = useSession()
  const { confirm } = useConfirm()
  const [edit, setEdit] = useState<Holiday | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [view, setView] = useState<'list' | 'calendar'>('list')

  const del = useMut((h: Holiday) => adminApi.deleteHoliday(h.id), { invalidate: [['holidays'], ['onboarding']], success: (_, h) => `${h.name} deleted` })

  const cal: CalendarCtx | null = useMemo(() => (tenant && q.data ? { settings: tenant.settings, holidays: q.data.holidays } : null), [tenant, q.data])
  const byMonth = useMemo(() => groupBy(q.data?.holidays ?? [], (h) => Number(h.date.slice(5, 7)) - 1), [q.data])
  const totalWorking = (q.data?.months ?? []).reduce((s, m) => s + m.working_days, 0)
  const mandatory = (q.data?.holidays ?? []).filter((h) => !h.optional).length

  const exportCsv = () => saveFile(`holidays-${year}.csv`, toCSV([['date', 'name', 'optional'], ...(q.data?.holidays ?? []).map((h) => [h.date, h.name, h.optional ? 'yes' : 'no'])]), 'text/csv')

  return (
    <div>
      <PageHeader
        title="Holidays & calendar"
        subtitle={canEdit ? 'Holidays and weekly offs decide working days for timesheets, SLA and payroll.' : 'Your company’s holidays and working days. Only admins can change them.'}
        actions={
          <>
            {q.data && q.data.holidays.length > 0 && (
              <Button size="sm" icon={<Download className="size-3.5" />} onClick={exportCsv}>
                CSV
              </Button>
            )}
            {canEdit && (
              <>
                <Button size="sm" icon={<FileUp className="size-3.5" />} onClick={() => setImporting(true)}>
                  Import
                </Button>
                <Button size="sm" variant="primary" icon={<CalendarPlus className="size-3.5" />} onClick={() => setEdit('new')}>
                  Add holiday
                </Button>
              </>
            )}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center rounded-md border border-line bg-surface">
          <IconButton size="sm" label="Previous year" onClick={() => setYear((y) => y - 1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <span className="tnum min-w-[56px] text-center text-[14px] font-medium">{year}</span>
          <IconButton size="sm" label="Next year" onClick={() => setYear((y) => y + 1)} disabled={year >= thisYear + 2}>
            <ChevronRight className="size-4" />
          </IconButton>
        </div>
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'list', label: 'List' }, { value: 'calendar', label: 'Calendar' }]} />
      </div>

      {q.isLoading ? (
        <SkeletonRows rows={6} />
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          <div className="mb-5 grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {[
              ['Holidays', `${mandatory}`, q.data.holidays.length - mandatory ? `+${q.data.holidays.length - mandatory} optional` : 'all mandatory'],
              ['Working days', `${totalWorking}`, `in ${year}`],
              ['Saturdays', tenant?.settings['calendar.saturday_rule'] === 'all_off' ? 'All off' : tenant?.settings['calendar.saturday_rule'] === 'all_on' ? 'Working' : tenant?.settings['calendar.saturday_off_weeks'].map((n) => ['1st', '2nd', '3rd', '4th', '5th'][n - 1]).join(' & ') + ' off', 'weekly rule'],
            ].map(([k, v, s]) => (
              <div key={k} className="min-w-0 px-3.5 py-3 md:px-4">
                <div className="text-[12.5px] leading-tight text-ink-3">{k}</div>
                <div className="tnum mt-1.5 text-[16px] font-semibold leading-tight md:text-[20px]">{v}</div>
                <div className="mt-0.5 truncate text-[12px] text-ink-3">{s}</div>
              </div>
            ))}
          </div>

          {view === 'calendar' && cal ? (
            <YearCalendar year={year} cal={cal} months={q.data.months} />
          ) : q.data.holidays.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState
                icon={<CalendarPlus />}
                title={`No holidays for ${year}`}
                body={canEdit ? 'Add them one by one or import a CSV of date,name. Holidays reduce working days and pause the approval SLA.' : 'Your admin hasn’t added holidays for this year yet.'}
                action={canEdit && (
                  <div className="flex gap-2">
                    <Button onClick={() => setImporting(true)} icon={<FileUp className="size-4" />}>Import CSV</Button>
                    <Button variant="primary" onClick={() => setEdit('new')} icon={<CalendarPlus className="size-4" />}>Add holiday</Button>
                  </div>
                )}
              />
            </div>
          ) : (
            <div className="space-y-5">
              {MONTHS.map((m, i) =>
                byMonth[i]?.length ? (
                  <section key={m}>
                    <div className="mb-1.5 flex items-baseline justify-between px-1">
                      <h2 className="text-[13.5px] font-semibold text-ink">{m}</h2>
                      <span className="tnum text-[12px] text-ink-3">{q.data!.months[i].working_days} working days</span>
                    </div>
                    <div className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
                      {byMonth[i].map((h) => {
                        const d = parseISO(h.date)
                        const past = h.date < todayISO()
                        return (
                          <div key={h.id} className={cn('flex items-center gap-3 px-4 py-2.5', past && 'opacity-60')}>
                            <div className="tnum w-[52px] shrink-0 whitespace-nowrap text-[13.5px] font-medium text-ink">{d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[14px] font-medium">{h.name}</div>
                              <div className="text-[12.5px] text-ink-3">
                                {d.toLocaleDateString('en-IN', { weekday: 'long' })}
                                {cal && dayKind(h.date, { ...cal, holidays: new Set() }) === 'weekly_off' && ' · falls on a weekly off'}
                              </div>
                            </div>
                            {h.optional && <Badge tone="accent" size="sm">Optional</Badge>}
                            {h.date === todayISO() && <Badge tone="brand" size="sm">Today</Badge>}
                            {canEdit && (
                              <Menu
                                label={`Actions for ${h.name}`}
                                trigger={
                                  <IconButton size="sm" label="More">
                                    <MoreHorizontal className="size-4" />
                                  </IconButton>
                                }
                                items={[
                                  { label: 'Edit', icon: <Pencil />, onSelect: () => setEdit(h) },
                                  {
                                    label: 'Delete',
                                    icon: <Trash2 />,
                                    danger: true,
                                    onSelect: async () => (await confirm({ title: `Delete ${h.name}?`, body: `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })} becomes a working day again.`, confirmLabel: 'Delete', tone: 'danger' })) && del.mutate(h),
                                  },
                                ]}
                              />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </section>
                ) : null,
              )}
            </div>
          )}
        </>
      )}
      {edit && <HolidayDialog holiday={edit === 'new' ? null : edit} year={year} onClose={() => setEdit(null)} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  )
}

function YearCalendar({ year, cal, months }: { year: number; cal: CalendarCtx; months: { working_days: number }[] }) {
  const today = todayISO()
  const names = new Map((cal.holidays as Holiday[]).map((h) => [h.date, h]))
  return (
    <div>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {MONTHS.map((m, mi) => {
          const first = new Date(year, mi, 1)
          const lead = (first.getDay() + 6) % 7
          const days = new Date(year, mi + 1, 0).getDate()
          return (
            <div key={m} className="rounded-lg border border-line bg-surface p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-[13px] font-semibold">{m}</span>
                <span className="tnum text-[11.5px] text-ink-3">{months[mi].working_days} days</span>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {WD.map((w, i) => (
                  <span key={i} className="text-[10px] font-semibold text-ink-3">{w}</span>
                ))}
                {Array.from({ length: lead }).map((_, i) => <span key={'l' + i} />)}
                {Array.from({ length: days }).map((_, i) => {
                  const iso = `${year}-${String(mi + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
                  const h = names.get(iso)
                  const kind = dayKind(iso, cal)
                  return (
                    <span
                      key={iso}
                      title={h ? `${h.name}${h.optional ? ' (optional)' : ''}` : kind === 'weekly_off' ? 'Weekly off' : undefined}
                      className={cn(
                        'tnum grid aspect-square place-items-center rounded-[6px] text-[11px] font-medium',
                        h && !h.optional && 'bg-danger-soft font-semibold text-danger-text',
                        h && h.optional && 'bg-surface-2 font-semibold text-ink ring-1 ring-inset ring-line-strong',
                        !h && kind === 'weekly_off' && 'bg-surface-2 text-ink-3',
                        iso === today && 'ring-2 ring-brand ring-offset-1 ring-offset-surface',
                      )}
                    >
                      {i + 1}
                    </span>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] bg-danger-soft ring-1 ring-danger/30" /> Holiday</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] bg-surface-2 ring-1 ring-line-strong" /> Optional</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] bg-surface-2 ring-1 ring-line" /> Weekly off</span>
        <span className="flex items-center gap-1.5"><span className="size-3 rounded-[3px] ring-2 ring-brand" /> Today</span>
      </div>
    </div>
  )
}

function HolidayDialog({ holiday, year, onClose }: { holiday: Holiday | null; year: number; onClose: () => void }) {
  const [f, setF] = useState({ date: holiday?.date ?? (String(year) === todayISO().slice(0, 4) ? todayISO() : `${year}-01-01`), name: holiday?.name ?? '', optional: holiday?.optional ?? false })
  const m = useMut(() => (holiday ? adminApi.updateHoliday(holiday.id, f, holiday.version) : adminApi.addHoliday(f)), {
    invalidate: [['holidays'], ['onboarding']],
    success: holiday ? 'Holiday updated' : 'Holiday added',
    onSuccess: onClose,
  })
  const e = m.error
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={holiday ? 'Edit holiday' : 'Add holiday'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => m.mutate(undefined)}>
            {holiday ? 'Save' : 'Add holiday'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Date" htmlFor="h-date" required error={errField(e, 'date')}>
          <Input id="h-date" type="date" value={f.date} onChange={(ev) => setF({ ...f, date: ev.target.value })} invalid={!!errField(e, 'date')} />
        </Field>
        <Field label="Name" htmlFor="h-name" required error={errField(e, 'name')}>
          <Input id="h-name" value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} placeholder="e.g. Rath Yatra" invalid={!!errField(e, 'name')} autoFocus />
        </Field>
        <Checkbox checked={f.optional} onChange={(v) => setF({ ...f, optional: v })} label="Optional holiday" description="People may take it as leave; it does not reduce working days." />
      </div>
    </Dialog>
  )
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [preview, setPreview] = useState<{ rows: HolidayImportRow[]; valid: number; invalid: number } | null>(null)
  const parsed = useMemo(() => {
    const rows = parseCSV(text.trim())
    const body = rows.length && /date/i.test(rows[0][0] ?? '') ? rows.slice(1) : rows
    return body.map((r) => ({ date: (r[0] ?? '').trim(), name: (r[1] ?? '').trim(), optional: (r[2] ?? '').trim() }))
  }, [text])
  const pre = useMut(() => adminApi.importHolidays(parsed, 'preview'), { onSuccess: (r) => setPreview(r) })
  const commit = useMut(() => adminApi.importHolidays(parsed, 'commit'), { invalidate: [['holidays'], ['onboarding']], success: (r) => `${r.rows.length} holidays imported`, onSuccess: onClose })

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title="Import holidays"
      description="Paste or upload a CSV with columns date, name and optionally optional (yes/no). Dates as YYYY-MM-DD or DD/MM/YYYY."
      footer={
        preview ? (
          <>
            <Button onClick={() => setPreview(null)}>Back</Button>
            <Button variant="primary" disabled={preview.invalid > 0} loading={commit.isPending} onClick={() => commit.mutate(undefined)}>
              Import {preview.valid} holiday{preview.valid === 1 ? '' : 's'}
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              icon={<Download className="size-4" />}
              onClick={() => saveFile('holidays-template.csv', toCSV([['date', 'name', 'optional'], [`${todayISO().slice(0, 4)}-06-27`, 'Rath Yatra', 'no'], [`${todayISO().slice(0, 4)}-10-20`, 'Diwali', 'no']]), 'text/csv')}
            >
              Template
            </Button>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!parsed.length} loading={pre.isPending} onClick={() => pre.mutate(undefined)}>
              Check {parsed.length || ''} row{parsed.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {!preview ? (
        <div className="space-y-4">
          <FileUpload
            accept=".csv,text/csv,text/plain"
            label="Drop a CSV or browse"
            hint="CSV · up to 1 MB"
            maxMb={1}
            file={file}
            onClear={() => {
              setFile(null)
              setText('')
            }}
            onFile={async (f) => {
              setFile({ name: f.name, size: f.size })
              setText(await readFileAsText(f))
            }}
          />
          <Field label="…or paste rows" htmlFor="csv">
            <Textarea id="csv" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder={'date,name,optional\n2026-10-02,Gandhi Jayanti,no\n2026-10-20,Diwali,no'} className="font-mono text-[13px]" />
          </Field>
        </div>
      ) : (
        <div className="space-y-3">
          {preview.invalid > 0 ? (
            <Callout tone="danger" title={`${preview.invalid} row${preview.invalid === 1 ? '' : 's'} need fixing`}>Nothing is imported until every row is valid. Go back, fix the rows and check again.</Callout>
          ) : (
            <Callout tone="success" title="All rows look good">{preview.valid} holidays will be added.</Callout>
          )}
          <div className="overflow-x-auto rounded-lg border border-line scroll-thin">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-2 text-left text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr key={r.line} className={cn('border-t border-line', r.errors.length && 'bg-danger-soft/50')}>
                    <td className="tnum px-3 py-2 text-ink-3">{r.line}</td>
                    <td className="tnum whitespace-nowrap px-3 py-2">{r.date}</td>
                    <td className="px-3 py-2">
                      {r.name}
                      {r.optional && <Badge tone="accent" size="sm" className="ml-1.5">Optional</Badge>}
                    </td>
                    <td className="px-3 py-2">{r.errors.length ? <span className="font-medium text-danger-text">{r.errors.join('; ')}</span> : <span className="text-success-text">OK</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Dialog>
  )
}
