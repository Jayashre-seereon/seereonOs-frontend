import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertCircle, CheckCircle2, ClipboardPaste, Download, FileSpreadsheet, RotateCcw, Upload } from '@/ui/icons'
import { projectsApi, WBS_COLUMNS, type ImportPreview } from '@/api/projects'
import { useApi, useMut } from '@/api/query'
import { ApiError } from '@/api/http'
import { COMPLEXITY } from '@/domain/labels'
import { addDays, fmtDate, todayISO } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { cn, readFileAsText, saveFile, toCSV } from '@/lib/utils'
import { Badge, Button, Callout, Card, CardHeader, ErrorState, FileUpload, PageHeader, Segmented, Skeleton, StatusBadge, Textarea, toast, useReadOnly } from '@/ui'

type Mode = 'paste' | 'file'

export default function WbsImportPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const proj = useApi(['project', id], () => projectsApi.detail(id))
  const [mode, setMode] = useState<Mode>('paste')
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const run = useMut((t: string) => projectsApi.importPreview(id, t), {
    silentError: true,
    onSuccess: (p) => {
      setPreview(p)
      setFormError(null)
      setOnlyErrors(p.error_count > 0)
    },
    onError: (e: ApiError) => {
      setPreview(null)
      setFormError(e.message)
    },
  })
  const commit = useMut(() => projectsApi.importCommit(id, preview!.token), {
    invalidate: [['project', id], ['projects'], ['my-tasks']],
    success: (r) => `Imported ${r.tasks} task${r.tasks === 1 ? '' : 's'}${r.milestones ? ` and ${r.milestones} milestone${r.milestones === 1 ? '' : 's'}` : ''}`,
    onSuccess: () => nav(`/projects/${id}/wbs`),
    onError: (e) => {
      if (e.code === 'STALE' || e.code === 'WBS_INVALID') setPreview(null)
    },
  })

  const doPreview = async () => {
    let body = text
    if (mode === 'file') {
      if (!file) return setFormError('Choose a CSV file first.')
      if (/\.xlsx?$/i.test(file.name)) return setFormError('Excel files: open the file, select all cells and paste them in the Paste tab, or save as CSV.')
      body = await readFileAsText(file)
    }
    if (!body.trim()) return setFormError('Paste a header row and at least one task row. Use the template.')
    run.mutate(body)
  }

  const downloadTemplate = async () => {
    const d = proj.data
    const firstMs = d?.milestones[0]?.name ?? 'Build'
    const owner = 'Full name or email'
    const t = todayISO()
    const rows = [
      [...WBS_COLUMNS],
      [firstMs, 'Requirement workshop', owner, 16, t, addDays(t, 4), 'Low', '', ''],
      [firstMs, 'Solution design', owner, 24, addDays(t, 5), addDays(t, 10), 'Medium', `${d?.milestones[0]?.no ?? 1}.1`, ''],
      ['UAT sign-off', 'UAT scripts and training', owner, 12, addDays(t, 20), addDays(t, 26), 'Low', '', 200000],
    ]
    const r = await saveFile('wbs-template.csv', toCSV(rows), 'text/csv')
    if (r === 'saved') toast.success('Template downloaded')
  }

  const shown = useMemo(() => (preview ? (onlyErrors ? preview.rows.filter((r) => r.errors.length) : preview.rows) : []), [preview, onlyErrors])

  if (proj.isLoading)
    return (
      <div>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="mt-6 h-64 w-full rounded-lg" />
      </div>
    )
  if (proj.error || !proj.data) return <Card><ErrorState error={proj.error} onRetry={() => proj.refetch()} /></Card>
  const d = proj.data
  if (!d.can_edit)
    return (
      <div>
        <PageHeader title="Import WBS" back={{ to: `/projects/${id}`, label: d.project.name }} />
        <Card><ErrorState error={{ code: 'FORBIDDEN', message: 'Only the project manager of this project or an admin can import a WBS.' }} /></Card>
      </div>
    )

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader
        title="Import WBS"
        subtitle={`${d.project.code} ${d.project.name}. Milestones are matched by name or created; tasks get the next free numbers. All rows import together or none do.`}
        back={{ to: `/projects/${id}/wbs`, label: d.project.name }}
        actions={<Button icon={<Download className="size-4" />} onClick={downloadTemplate}>Download template</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title="1. Add your rows" subtitle="Copy cells straight from Excel or Google Sheets, or upload a CSV." action={<Segmented size="sm" value={mode} onChange={(m) => { setMode(m); setFormError(null) }} options={[{ value: 'paste', label: 'Paste' }, { value: 'file', label: 'CSV file' }]} />} />
          {mode === 'paste' ? (
            <Textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                setPreview(null)
              }}
              rows={10}
              spellCheck={false}
              className="font-mono text-[12.5px]"
              placeholder={`${WBS_COLUMNS.join('\t')}\nBuild\tPayroll engine\thritesh@seereon.co.in\t40\t2026-10-05\t2026-10-16\tHigh\t\t`}
              aria-label="Paste WBS rows"
            />
          ) : (
            <FileUpload
              accept=".csv,.tsv,.txt,text/csv"
              file={file ? { name: file.name, size: file.size } : null}
              onFile={(f) => {
                setFile(f)
                setPreview(null)
              }}
              onClear={() => setFile(null)}
              label="Drop a CSV or browse"
              hint="CSV or TSV · up to 1,000 rows"
            />
          )}
          {formError && (
            <Callout tone="danger" icon={<AlertCircle />} className="mt-3">
              {formError}
            </Callout>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant={preview ? 'secondary' : 'primary'} icon={<ClipboardPaste className="size-4" />} loading={run.isPending} disabled={readOnly} onClick={doPreview}>
              {preview ? 'Preview again' : 'Preview'}
            </Button>
            {(text || file || preview) && (
              <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => { setText(''); setFile(null); setPreview(null); setFormError(null) }}>
                Start over
              </Button>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Columns" subtitle="Header row must match the template." />
          <ul className="space-y-1.5 text-[13px]">
            {[
              ['Milestone', 'Existing name, or a new one (created as the next M-number)'],
              ['Task', 'Title, up to 200 characters'],
              ['Owner', 'Full name or email of an active team member'],
              ['Estimated hours', '0.5 to 999'],
              ['Start / End', 'YYYY-MM-DD, DD/MM/YYYY or 5 Oct 2026'],
              ['Complexity', 'Low, Medium, High or Very high (blank = Medium)'],
              ['Depends on', 'WBS codes like 1.2; separate with commas'],
              ['Milestone billing', 'Amount in ₹ for a new milestone (optional)'],
            ].map(([k, v]) => (
              <li key={k} className="flex flex-col">
                <span className="font-semibold text-ink">{k}</span>
                <span className="text-[12.5px] text-ink-3">{v}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {preview && (
        <Card className="mt-4" pad={false}>
          <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:p-5">
            <div>
              <h2 className="text-[14px] font-semibold">2. Check the preview</h2>
              <p className="mt-0.5 text-[13px] text-ink-3">
                {preview.task_count} task{preview.task_count === 1 ? '' : 's'}
                {preview.new_milestones.length ? `, ${preview.new_milestones.length} new milestone${preview.new_milestones.length === 1 ? '' : 's'} (${preview.new_milestones.map((m) => `${m.code} ${m.name}${m.billing_paise ? ` · ${fmtMoney(m.billing_paise)}` : ''}`).join(', ')})` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {preview.error_count > 0 ? (
                <Badge tone="danger" dot>{preview.error_count} row{preview.error_count === 1 ? '' : 's'} with errors</Badge>
              ) : (
                <Badge tone="success" dot>All rows valid</Badge>
              )}
              {preview.error_count > 0 && (
                <Segmented size="sm" value={onlyErrors ? 'err' : 'all'} onChange={(v) => setOnlyErrors(v === 'err')} options={[{ value: 'err', label: 'Errors' }, { value: 'all', label: 'All rows' }]} />
              )}
            </div>
          </div>
          <div className="overflow-x-auto border-t border-line scroll-thin">
            <table className="w-full min-w-[860px] text-[13px]">
              <thead className="bg-surface-2/70 text-[11.5px] font-semibold uppercase tracking-[0.04em] text-ink-3">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">Line</th>
                  <th className="px-3 py-2 text-left font-semibold">WBS</th>
                  <th className="px-3 py-2 text-left font-semibold">Milestone</th>
                  <th className="px-3 py-2 text-left font-semibold">Task</th>
                  <th className="px-3 py-2 text-left font-semibold">Owner</th>
                  <th className="px-3 py-2 text-right font-semibold">Hours</th>
                  <th className="px-3 py-2 text-left font-semibold">Dates</th>
                  <th className="px-3 py-2 text-left font-semibold">Size</th>
                  <th className="px-3 py-2 text-left font-semibold">After</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.line} className={cn('border-t border-line align-top', r.errors.length && 'bg-danger-soft/40')}>
                    <td className="tnum px-3 py-2 text-ink-3">{r.line}</td>
                    <td className="tnum px-3 py-2">{r.wbs || '—'}</td>
                    <td className="px-3 py-2">
                      <span className="tnum text-ink-3">{r.milestone_code}</span> {r.milestone}
                      {r.milestone_new && <Badge tone="brand" size="sm" className="ml-1.5">New</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.title || <span className="text-ink-3">—</span>}</div>
                      {r.errors.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {r.errors.map((e, i) => (
                            <li key={i} className="flex items-start gap-1 text-[12px] font-medium text-danger-text">
                              <AlertCircle className="mt-px size-3.5 shrink-0" />
                              {e}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className={cn('px-3 py-2', !r.owner_id && 'text-danger-text')}>{r.owner_label || '—'}</td>
                    <td className="tnum px-3 py-2 text-right">{r.est_hours ?? '—'}</td>
                    <td className="tnum whitespace-nowrap px-3 py-2">{r.start_on ? fmtDate(r.start_on) : '—'} – {r.due_on ? fmtDate(r.due_on) : '—'}</td>
                    <td className="px-3 py-2">{r.complexity ? <StatusBadge map={COMPLEXITY} value={r.complexity} size="sm" /> : '—'}</td>
                    <td className="tnum px-3 py-2">{r.depends_on.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 border-t border-line bg-surface/95 p-3 backdrop-blur lg:static lg:bottom-auto lg:z-auto lg:bg-transparent lg:p-5 lg:backdrop-blur-none">
            <div className="flex items-center gap-3 lg:justify-end">
              <p className="hidden flex-1 text-[13px] text-ink-3 md:block">{preview.error_count ? 'Fix the rows marked in red in your sheet, paste again and preview.' : 'Everything checks out. Owners are notified of their new tasks.'}</p>
              <Button
                variant="primary"
                block
                className="lg:w-auto"
                icon={preview.error_count ? <AlertCircle className="size-4" /> : <CheckCircle2 className="size-4" />}
                disabled={preview.error_count > 0 || readOnly}
                loading={commit.isPending}
                onClick={() => commit.mutate(undefined)}
              >
                {preview.error_count ? `Fix ${preview.error_count} row${preview.error_count === 1 ? '' : 's'} to import` : `Import ${preview.task_count} task${preview.task_count === 1 ? '' : 's'}${preview.new_milestones.length ? ` and ${preview.new_milestones.length} milestone${preview.new_milestones.length === 1 ? '' : 's'}` : ''}`}
              </Button>
            </div>
          </div>
        </Card>
      )}
      {!preview && !formError && (
        <p className="mt-4 flex items-center gap-2 text-[13px] text-ink-3">
          <Upload className="size-4" />
          Nothing is saved until you import. Preview checks owners, dates, complexity and dependency codes.
        </p>
      )}
    </div>
  )
}
