// /documents — the Documents hub (v7). Tabs (?tab=): Templates, Issued documents, Policies, Employee documents,
// Project documents and My documents. Tab visibility follows permissions; the server enforces the same rules.
// ?doc=<id> opens a policy / project document (v3 notifications and the Approvals inbox link here).
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Avatar, Badge, Button, Callout, Card, Combobox, DataTable, Dialog, EmptyState, Field, FilterChips, PageHeader, Progress, SearchInput, Segmented, Select, SkeletonRows, StatCard, Tabs, Tooltip, useCan, useReadOnly, type Column } from '@/ui'
import { CheckCircle2, FileText, FileUp, Plus, Send, X } from '@/ui/icons'
import { useApi, useMut } from '@/api/query'
import { usePeopleMap } from '@/api/core'
import { documentsApi, useDocuments, type DocListItem } from '@/api/documents'
import { DOCS7_KEYS, docsApi, useEmpFile, useEmpPeople, useIssued, usePayslipStatus, useTemplates, type EmployeeSummaryRow, type IssuedQuery, type TemplateRow } from '@/api/docs'
import { workApi } from '@/api/work'
import { CATEGORY_LABEL, TEMPLATE_CATEGORIES } from '@/mock/docMarkup'
import { addDays, fmtDate, monthOf, parseISO, todayISO } from '@/domain/calendar'
import { ByProject } from './DocumentsPage'
import { DocLibrary, DocSheet, FileIcon } from './shared'
import { EmpDocUploadDialog, EmpDocsTable, IssueSheet, IssuedTable, MissingKinds, ReviewDialog } from './docUi'
import type { EmpDocRow } from '@/api/docs'

type Tab = 'templates' | 'issued' | 'policies' | 'employees' | 'projects' | 'mine'
const ALL_TABS: Tab[] = ['templates', 'issued', 'policies', 'employees', 'projects', 'mine']
const monthName = (ym: string) => parseISO(`${ym}-01`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

export default function DocumentsHub() {
  const c = useCan()
  const [params, setParams] = useSearchParams()
  const allowed: Record<Tab, boolean> = { templates: c('documents.templates'), issued: c('documents.templates'), policies: true, employees: c('documents.employee_files'), projects: true, mine: true }
  const requested = params.get('tab') as Tab | null
  const fallback: Tab = allowed.templates ? 'templates' : 'mine'
  const tab: Tab = requested && ALL_TABS.includes(requested) && allowed[requested] ? requested : fallback
  const openId = params.get('doc')
  useEffect(() => {
    if (requested !== tab)
      setParams(
        (p) => {
          const n = new URLSearchParams(p)
          n.set('tab', tab)
          return n
        },
        { replace: true },
      )
  }, [requested, tab, setParams])
  const setParam = (k: string, v: string | null, replace = false) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        if (k === 'tab') {
          n.delete('project')
          n.delete('run')
        }
        return n
      },
      { replace },
    )
  const mine = useIssued({ mine: true })
  const toAck = (mine.data ?? []).filter((d) => d.status === 'issued').length
  const policyList = useDocuments({ scope: 'mine' })
  const toRead = policyList.data?.pending_count ?? 0

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle={allowed.templates ? 'Letter templates and everything issued from them, company policies, employee files and project documents.' : 'Your letters and payslips, the documents you have uploaded, company policies and project documents.'}
      />
      <Tabs
        value={tab}
        onChange={(v) => setParam('tab', v)}
        tabs={[
          { value: 'templates', label: 'Templates', hidden: !allowed.templates },
          { value: 'issued', label: 'Issued documents', hidden: !allowed.issued },
          { value: 'policies', label: 'Policies' },
          { value: 'employees', label: 'Employee documents', hidden: !allowed.employees },
          { value: 'projects', label: 'Project documents' },
          { value: 'mine', label: 'My documents', count: toAck + toRead || undefined },
        ]}
      />
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'issued' && <IssuedTab />}
      {tab === 'policies' && <PoliciesTab onOpen={(id) => setParam('doc', id)} />}
      {tab === 'employees' && <EmployeesTab />}
      {tab === 'projects' && <ByProject onOpen={(id) => setParam('doc', id)} />}
      {tab === 'mine' && <MineTab onOpen={(id) => setParam('doc', id)} />}
      <DocSheet id={openId} onClose={() => setParam('doc', null, true)} />
    </div>
  )
}

/* ================= Templates ================= */
function TemplatesTab() {
  const nav = useNavigate()
  const ro = useReadOnly()
  const q = useTemplates()
  const issued = useIssued({})
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState('')
  const [issueTpl, setIssueTpl] = useState<TemplateRow | null>(null)
  const list = (q.data ?? []).filter((t) => (!cat || t.category === cat) && (!search || `${t.name} ${t.description ?? ''}`.toLowerCase().includes(search.toLowerCase())))
  const all = q.data ?? []
  const docs = issued.data ?? []
  const thisMonth = monthOf(todayISO())
  const cols: Column<TemplateRow>[] = [
    {
      key: 'name', header: 'Template', sortValue: (t) => t.name.toLowerCase(),
      cell: (t) => (
        <div className="min-w-0 max-w-[260px] lg:max-w-[300px] xl:max-w-[400px] 2xl:max-w-[560px]">
          <div className="truncate font-medium text-ink">{t.name}</div>
          <div className="truncate text-[12px] text-ink-3">{t.description || CATEGORY_LABEL[t.category]}</div>
        </div>
      ),
    },
    { key: 'cat', header: 'Category', width: '170px', hideBelow: 'md', sortValue: (t) => CATEGORY_LABEL[t.category], cell: (t) => <span className="whitespace-nowrap text-ink-2">{CATEGORY_LABEL[t.category]}</span> },
    {
      key: 'ph', header: 'Placeholders', width: '130px', hideBelow: 'xl', sortValue: (t) => t.placeholders.length,
      cell: (t) => (
        <Tooltip content={t.placeholders.map((p) => `{{${p}}}`).join(' ')}>
          <span className="tnum whitespace-nowrap text-ink-2">
            {t.placeholders.length} <span className="text-ink-3">· {t.process_placeholders.length} to fill</span>
          </span>
        </Tooltip>
      ),
    },
    { key: 'n', header: 'Issued', width: '80px', align: 'right', sortValue: (t) => t.issued_count, cell: (t) => <span className="tnum text-ink-2">{t.issued_count}</span> },
    { key: 'last', header: 'Last used', width: '110px', hideBelow: 'lg', sortValue: (t) => t.last_used_on ?? '', cell: (t) => <span className="tnum whitespace-nowrap text-ink-2">{t.last_used_on ? fmtDate(t.last_used_on) : '—'}</span> },
    { key: 'st', header: 'Status', width: '90px', sortValue: (t) => Number(t.active), cell: (t) => <Badge size="sm" tone={t.active ? 'success' : 'neutral'}>{t.active ? 'Active' : 'Off'}</Badge> },
    {
      key: 'act', header: '', width: '96px', align: 'right',
      cell: (t) =>
        t.active && t.category !== 'payslip' && !ro ? (
          <span onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="secondary" icon={<Send className="size-4" />} onClick={() => setIssueTpl(t)}>
              Issue
            </Button>
          </span>
        ) : null,
    },
  ]
  const card = (t: TemplateRow) => (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">{t.name}</div>
          <div className="truncate text-[12.5px] text-ink-3">
            {CATEGORY_LABEL[t.category]} · issued {t.issued_count} · {t.last_used_on ? `last ${fmtDate(t.last_used_on)}` : 'never used'}
          </div>
        </div>
        <Badge size="sm" tone={t.active ? 'success' : 'neutral'}>{t.active ? 'Active' : 'Off'}</Badge>
      </div>
      {t.active && t.category !== 'payslip' && !ro && (
        <div className="mt-2" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="secondary" icon={<Send className="size-4" />} onClick={() => setIssueTpl(t)}>
            Issue to employees
          </Button>
        </div>
      )}
    </div>
  )
  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active templates" value={q.isLoading ? '–' : all.filter((t) => t.active).length} sub={`${all.length} in total`} />
        <StatCard label="Issued this month" value={issued.isLoading ? '–' : docs.filter((d) => d.issued_on && monthOf(d.issued_on) === thisMonth).length} sub={monthName(thisMonth)} onClick={() => nav('/documents?tab=issued&period=month')} />
        <StatCard label="Awaiting acknowledgement" value={issued.isLoading ? '–' : docs.filter((d) => d.status === 'issued').length} tone={docs.some((d) => d.status === 'issued') ? 'warning' : undefined} sub="Issued, not yet read" onClick={() => nav('/documents?tab=issued&status=issued')} />
        <StatCard label="Drafts" value={issued.isLoading ? '–' : docs.filter((d) => d.status === 'draft').length} sub="Saved, not issued" onClick={() => nav('/documents?tab=issued&status=draft')} />
      </div>
      <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search templates" className="md:max-w-[320px] md:flex-1" />
        <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} placeholder="All categories" options={TEMPLATE_CATEGORIES.map((x) => ({ value: x, label: CATEGORY_LABEL[x] }))} className="md:w-[220px]" />
        {!ro && (
          <Button variant="primary" icon={<Plus className="size-4" />} className="md:ml-auto" onClick={() => nav(`/documents/templates/new${cat ? `?category=${cat}` : ''}`)}>
            Add new template
          </Button>
        )}
      </div>
      <DataTable
        rows={list}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        columns={cols}
        rowKey={(t) => t.id}
        onRowClick={(t) => nav(`/documents/templates/${t.id}`)}
        mobileCard={card}
        stickyHeader={false}
        empty={<EmptyState icon={<FileText />} title={search || cat ? 'No templates match' : 'No templates yet'} body={search || cat ? 'Try another search or category.' : 'Add your offer letter, joining letter and payslip templates.'} />}
      />
      <IssueSheet template={issueTpl} open={!!issueTpl} onOpenChange={(o) => !o && setIssueTpl(null)} />
    </div>
  )
}

/* ================= Issued documents ================= */
const PERIODS = [
  { value: '', label: 'Any time' },
  { value: 'month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: '90', label: 'Last 90 days' },
  { value: 'year', label: 'This year' },
]
function periodRange(p: string): { from?: string; to?: string } {
  const t = todayISO()
  if (p === 'month') return { from: `${monthOf(t)}-01`, to: t }
  if (p === 'last_month') {
    const m = monthOf(addDays(`${monthOf(t)}-01`, -1))
    return { from: `${m}-01`, to: addDays(`${monthOf(t)}-01`, -1) }
  }
  if (p === '90') return { from: addDays(t, -90), to: t }
  if (p === 'year') return { from: `${t.slice(0, 4)}-01-01`, to: t }
  return {}
}
function IssuedTab() {
  const c = useCan()
  const ro = useReadOnly()
  const [params, setParams] = useSearchParams()
  const people = usePeopleMap()
  const [search, setSearch] = useState('')
  const status = params.get('status') ?? ''
  const category = params.get('category') ?? ''
  const period = params.get('period') ?? ''
  const emp = params.get('employee')
  const runId = params.get('run')
  const set = (k: string, v: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v) n.set(k, v)
        else n.delete(k)
        return n
      },
      { replace: true },
    )
  const query: IssuedQuery = { status: status || undefined, category: category || undefined, employee_id: emp || undefined, q: search.trim() || undefined, run_id: runId || undefined, ...periodRange(period) }
  const q = useIssued(query)
  const templates = useTemplates()
  const [pickOpen, setPickOpen] = useState(false)
  const [tplId, setTplId] = useState('')
  const [issueTpl, setIssueTpl] = useState<TemplateRow | null>(null)
  const activeTpls = (templates.data ?? []).filter((t) => t.active && t.category !== 'payslip')
  const rows = q.data ?? []
  const filtered = !!(status || category || period || emp || runId || search)
  return (
    <div>
      {c('payroll.run') && <PayslipCard onShowRun={(id) => set('run', id)} />}
      <div className="mb-4 flex flex-col gap-2.5 xl:flex-row xl:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search title, employee or reference" className="xl:max-w-[300px] xl:flex-1" />
        <div className="grid min-w-0 grid-cols-2 gap-2.5 md:grid-cols-4 xl:flex xl:flex-1">
          <Combobox
            value={emp}
            onChange={(v) => set('employee', v)}
            clearable
            placeholder="All employees"
            searchPlaceholder="Search people"
            options={(people.data ?? []).filter((p) => p.status === 'active').map((p) => ({ value: p.id, label: p.name, hint: p.title }))}
            className="min-w-0 xl:w-[200px]"
          />
          <Select aria-label="Category" value={category} onChange={(e) => set('category', e.target.value || null)} placeholder="All categories" options={TEMPLATE_CATEGORIES.map((x) => ({ value: x, label: CATEGORY_LABEL[x] }))} className="min-w-0 xl:w-[180px]" />
          <Select
            aria-label="Status"
            value={status}
            onChange={(e) => set('status', e.target.value || null)}
            placeholder="All statuses"
            options={[{ value: 'draft', label: 'Draft' }, { value: 'issued', label: 'Awaiting acknowledgement' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'revoked', label: 'Revoked' }]}
            className="min-w-0 xl:w-[200px]"
          />
          <Select aria-label="Period" value={period} onChange={(e) => set('period', e.target.value || null)} options={PERIODS} className="min-w-0 xl:w-[150px]" />
        </div>
        {!ro && (
          <Button variant="primary" icon={<Send className="size-4" />} onClick={() => setPickOpen(true)}>
            Issue a document
          </Button>
        )}
      </div>
      {runId && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-2">
          <Badge tone="info">Payslips of one payroll run</Badge>
          <button type="button" className="inline-flex items-center gap-1 text-brand-text hover:underline" onClick={() => set('run', null)}>
            <X className="size-3.5" /> Show all documents
          </button>
        </div>
      )}
      <div className="mb-2 flex items-center justify-between text-[12.5px] text-ink-3">
        <span className="tnum">
          {q.isLoading ? 'Loading…' : `${rows.length} ${rows.length === 1 ? 'document' : 'documents'}`} · {rows.filter((d) => d.status === 'issued').length} awaiting acknowledgement
        </span>
        {filtered && (
          <button
            type="button"
            className="text-brand-text hover:underline"
            onClick={() => {
              setSearch('')
              setParams({ tab: 'issued' }, { replace: true })
            }}
          >
            Clear filters
          </button>
        )}
      </div>
      <IssuedTable rows={rows} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} empty={<EmptyState icon={<FileText />} title={filtered ? 'No documents match' : 'Nothing issued yet'} body={filtered ? 'Change the filters to see more.' : 'Issue a letter from a template, or generate payslips from a finalised payroll run.'} />} />
      <Dialog
        open={pickOpen}
        onOpenChange={setPickOpen}
        size="sm"
        title="Issue a document"
        description="Choose the template to issue from."
        footer={
          <>
            <Button onClick={() => setPickOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!tplId}
              onClick={() => {
                setIssueTpl(activeTpls.find((t) => t.id === tplId) ?? null)
                setPickOpen(false)
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        <Field label="Template" required>
          <Select value={tplId} onChange={(e) => setTplId(e.target.value)} placeholder="Choose a template" options={activeTpls.map((t) => ({ value: t.id, label: `${t.name} · ${CATEGORY_LABEL[t.category]}` }))} />
        </Field>
      </Dialog>
      <IssueSheet template={issueTpl} open={!!issueTpl} onOpenChange={(o) => !o && setIssueTpl(null)} presetIds={emp ? [emp] : undefined} />
    </div>
  )
}

/** Payslips for the latest payroll runs: how many are issued, and a button to generate the missing ones. */
function PayslipCard({ onShowRun }: { onShowRun: (id: string) => void }) {
  const ro = useReadOnly()
  const runs = useApi(['payroll', 'list'], workApi.payrollRuns)
  const finals = (runs.data ?? []).filter((r) => r.status === 'final')
  const [runId, setRunId] = useState<string>('')
  const id = runId || finals[0]?.id || null
  const st = usePayslipStatus(id)
  const gen = useMut(() => docsApi.generatePayslips(id!), { invalidate: [...DOCS7_KEYS, ['payroll']], success: (r) => (r.created ? `${r.created} payslip${r.created === 1 ? '' : 's'} issued` : 'Every payslip for this run is already issued') })
  if (runs.isLoading || !finals.length) return null
  const s = st.data
  const missing = s ? Math.max(0, s.eligible - s.issued) : 0
  return (
    <Card className="mb-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-ink">Payslips from payroll</h2>
          <p className="text-[12.5px] text-ink-3">Issued automatically when a payroll run is finalised. Generate any that are missing.</p>
        </div>
        <Select aria-label="Payroll run" value={id ?? ''} onChange={(e) => setRunId(e.target.value)} options={finals.map((r) => ({ value: r.id, label: `${monthName(r.month)} · final` }))} className="lg:w-[220px]" />
        <div className="min-w-0 lg:w-[220px]">
          {s ? (
            <>
              <div className="tnum text-[13px] text-ink-2">
                {s.issued} of {s.eligible} issued · {s.acknowledged} acknowledged
              </div>
              <Progress value={s.eligible ? s.issued / s.eligible : 0} height={4} tone={missing ? 'brand' : 'success'} className="mt-1" />
            </>
          ) : (
            <SkeletonRows rows={1} />
          )}
        </div>
        <div className="flex gap-2">
          <Button disabled={!s?.issued} onClick={() => id && onShowRun(id)}>
            View
          </Button>
          <Button variant="primary" disabled={ro || !s?.can_generate || !missing} loading={gen.isPending} onClick={() => gen.mutate(undefined)}>
            {missing ? `Generate ${missing} payslip${missing === 1 ? '' : 's'}` : 'All issued'}
          </Button>
        </div>
      </div>
    </Card>
  )
}

/* ================= Policies ================= */
function PoliciesTab({ onOpen }: { onOpen: (id: string) => void }) {
  const c = useCan()
  const manager = c('documents.company') || c('documents.employee_files') || c('documents.view_all')
  return (
    <div className="space-y-8">
      <DocLibrary projectId={null} onOpen={onOpen} />
      {manager && <AckStatus onOpen={onOpen} />}
    </div>
  )
}
function AckStatus({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useApi(['documents', 'policy-status'], documentsApi.policyStatus)
  const [view, setView] = useState<'policy' | 'person'>('person')
  const nav = useNavigate()
  const c = useCan()
  const d = q.data
  type P = NonNullable<typeof d>['policies'][number]
  type U = NonNullable<typeof d>['people'][number]
  const pc: Column<P>[] = [
    { key: 't', header: 'Policy', sortValue: (p) => p.title, cell: (p) => <div className="min-w-0"><div className="truncate font-medium text-ink">{p.title}</div><div className="truncate text-[12px] text-ink-3">v{p.current_version}{p.effective_on ? ` · effective ${fmtDate(p.effective_on)}` : ''}</div></div> },
    { key: 'a', header: 'Acknowledged', width: '200px', sortValue: (p) => (p.total ? p.acked / p.total : 1), cell: (p) => <div className="min-w-[120px]"><div className="tnum text-[12.5px] text-ink-2">{p.acked} of {p.total}</div><Progress value={p.total ? p.acked / p.total : 0} height={4} tone={p.acked >= p.total ? 'success' : 'brand'} className="mt-1" /></div> },
  ]
  const uc: Column<U>[] = [
    { key: 'n', header: 'Employee', sortValue: (u) => u.name, cell: (u) => <span className="font-medium text-ink">{u.name}</span> },
    { key: 'a', header: 'Read', width: '110px', align: 'right', sortValue: (u) => u.acked, cell: (u) => <span className="tnum whitespace-nowrap text-ink-2">{u.acked} of {u.required}</span> },
    { key: 'p', header: 'Still to read', hideBelow: 'md', cell: (u) => (u.pending.length ? <span className="line-clamp-2 text-[13px] text-ink-2">{u.pending.map((p) => p.title).join(', ')}</span> : <Badge size="sm" tone="success">All read</Badge>) },
  ]
  return (
    <section>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-[15px] font-semibold text-ink">Acknowledgement status</h3>
          <p className="text-[12.5px] text-ink-3">Who has read the current version of each must-read policy.</p>
        </div>
        <Segmented size="sm" value={view} onChange={setView} options={[{ value: 'person', label: 'By employee' }, { value: 'policy', label: 'By policy' }]} />
      </div>
      {view === 'policy' ? (
        <DataTable rows={d?.policies} loading={q.isLoading} error={q.error} onRetry={() => q.refetch()} columns={pc} rowKey={(p) => p.id} onRowClick={(p) => onOpen(p.id)} stickyHeader={false} empty={<EmptyState compact title="No must-read policies" />} />
      ) : (
        <DataTable
          rows={d?.people}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          columns={uc}
          rowKey={(u) => u.user_id}
          onRowClick={c('documents.employee_files') ? (u) => nav(`/documents/employees/${u.user_id}`) : undefined}
          mobileCard={(u) => (
            <div className="min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-ink">{u.name}</span>
                <span className="tnum shrink-0 text-[12.5px] text-ink-2">{u.acked} of {u.required}</span>
              </div>
              {u.pending.length > 0 && <div className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{u.pending.map((p) => p.title).join(', ')}</div>}
            </div>
          )}
          stickyHeader={false}
        />
      )}
    </section>
  )
}

/* ================= Employee documents ================= */
function EmployeesTab() {
  const nav = useNavigate()
  const q = useEmpPeople()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'verify' | 'missing' | 'expiring'>('all')
  const rows = q.data ?? []
  const shown = rows.filter((r) => (filter === 'verify' ? r.pending > 0 : filter === 'missing' ? r.missing.length > 0 : filter === 'expiring' ? r.expiring > 0 : true) && (!search || `${r.name} ${r.code} ${r.department} ${r.designation}`.toLowerCase().includes(search.toLowerCase())))
  const cols: Column<EmployeeSummaryRow>[] = [
    {
      key: 'n', header: 'Employee', sortValue: (r) => r.name,
      cell: (r) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar name={r.name} hue={r.avatar_hue} size={28} />
          <div className="min-w-0">
            <div className="truncate font-medium text-ink">{r.name}</div>
            <div className="truncate text-[12px] text-ink-3">
              <span className="tnum">{r.code}</span> · {r.designation}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'd', header: 'Department', width: '150px', hideBelow: 'lg', sortValue: (r) => r.department, cell: (r) => <span className="truncate text-ink-2">{r.department || '—'}</span> },
    { key: 'docs', header: 'Documents', width: '100px', align: 'right', sortValue: (r) => r.docs, cell: (r) => <span className="tnum text-ink-2">{r.docs}</span> },
    { key: 'p', header: 'To verify', width: '96px', align: 'right', sortValue: (r) => r.pending, cell: (r) => (r.pending ? <Badge size="sm" tone="warning">{r.pending}</Badge> : <span className="text-ink-3">0</span>) },
    { key: 'm', header: 'Missing mandatory', width: '240px', hideBelow: 'md', sortValue: (r) => r.missing.length, cell: (r) => <MissingKinds kinds={r.missing} /> },
    { key: 'i', header: 'Letters', width: '84px', align: 'right', hideBelow: 'xl', sortValue: (r) => r.issued, cell: (r) => <span className="tnum text-ink-2">{r.issued}</span> },
  ]
  const card = (r: EmployeeSummaryRow) => (
    <div className="flex min-w-0 items-start gap-2.5">
      <Avatar name={r.name} hue={r.avatar_hue} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[14px] font-medium text-ink">{r.name}</span>
          {r.pending > 0 && <Badge size="sm" tone="warning">{r.pending} to verify</Badge>}
        </div>
        <div className="truncate text-[12.5px] text-ink-3">
          {r.code} · {r.department || r.designation} · {r.docs} docs
        </div>
        {r.missing.length > 0 && <MissingKinds kinds={r.missing} className="mt-1.5" />}
      </div>
    </div>
  )
  return (
    <div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Employees" value={q.isLoading ? '–' : rows.length} sub={`${rows.reduce((s, r) => s + r.docs, 0)} documents on file`} onClick={() => setFilter('all')} />
        <StatCard label="Waiting for verification" value={q.isLoading ? '–' : rows.reduce((s, r) => s + r.pending, 0)} tone={rows.some((r) => r.pending) ? 'warning' : undefined} sub={`${rows.filter((r) => r.pending).length} people`} onClick={() => setFilter('verify')} />
        <StatCard label="Missing mandatory documents" value={q.isLoading ? '–' : rows.filter((r) => r.missing.length).length} tone={rows.some((r) => r.missing.length) ? 'danger' : undefined} sub="PAN, Aadhaar, education, bank" onClick={() => setFilter('missing')} />
        <StatCard label="Expiring in 60 days" value={q.isLoading ? '–' : rows.reduce((s, r) => s + r.expiring, 0)} sub="Passports and IDs" onClick={() => setFilter('expiring')} />
      </div>
      <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-center">
        <SearchInput value={search} onChange={setSearch} placeholder="Search name, code or department" className="md:max-w-[320px] md:flex-1" />
        <FilterChips
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: rows.length },
            { value: 'verify', label: 'To verify', count: rows.filter((r) => r.pending).length },
            { value: 'missing', label: 'Missing documents', count: rows.filter((r) => r.missing.length).length },
            { value: 'expiring', label: 'Expiring', count: rows.filter((r) => r.expiring).length },
          ]}
        />
      </div>
      <DataTable
        rows={shown}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        columns={cols}
        rowKey={(r) => r.user_id}
        onRowClick={(r) => nav(`/documents/employees/${r.user_id}`)}
        mobileCard={card}
        stickyHeader={false}
        empty={<EmptyState compact title="No one matches" body="Change the search or filter." />}
      />
    </div>
  )
}

/* ================= My documents ================= */
function MineTab({ onOpen }: { onOpen: (id: string) => void }) {
  const ro = useReadOnly()
  const issued = useIssued({ mine: true })
  const file = useEmpFile('me')
  const docs = useDocuments({ scope: 'mine' })
  const [kind, setKind] = useState<'all' | 'letters' | 'payslips'>('all')
  const [upload, setUpload] = useState<{ open: boolean; kind?: EmpDocRow['kind'] }>({ open: false })
  const [review, setReview] = useState<{ doc: EmpDocRow | null; action: 'verify' | 'reject' }>({ doc: null, action: 'verify' })
  const all = issued.data ?? []
  const list = useMemo(() => all.filter((d) => (kind === 'payslips' ? d.category === 'payslip' : kind === 'letters' ? d.category !== 'payslip' : true)), [all, kind])
  const toAck = all.filter((d) => d.status === 'issued')
  const toRead = (docs.data?.items ?? []).filter((d) => d.my_ack === 'pending')
  const mineDocs = file.data?.docs ?? []
  const missing = file.data?.missing ?? []
  const readCols: Column<DocListItem>[] = [
    { key: 't', header: 'Document', cell: (d) => <div className="flex min-w-0 items-start gap-2.5"><FileIcon name={d.file_name} isLink={d.is_link} className="mt-0.5" /><div className="min-w-0"><div className="truncate font-medium text-ink">{d.title}</div><div className="truncate text-[12px] text-ink-3">{d.project_id ? `${d.project_code} · ${d.project_name}` : 'Company policy'} · v{d.current_version}</div></div></div> },
    { key: 's', header: 'Status', width: '150px', cell: () => <Badge size="sm" tone="warning">Read required</Badge> },
  ]
  return (
    <div className="space-y-8">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="To acknowledge" value={issued.isLoading ? '–' : toAck.length} tone={toAck.length ? 'warning' : undefined} sub="Letters and payslips" />
        <StatCard label="Policies to read" value={docs.isLoading ? '–' : toRead.length} tone={toRead.length ? 'warning' : undefined} sub={toRead.length ? 'Must-read documents' : 'All caught up'} />
        <StatCard label="Payslips" value={issued.isLoading ? '–' : all.filter((d) => d.category === 'payslip').length} sub={all.find((d) => d.category === 'payslip')?.period ? `Latest ${monthName(all.find((d) => d.category === 'payslip')!.period!)}` : 'None yet'} />
        <StatCard label="My uploads" value={file.isLoading ? '–' : mineDocs.length} tone={missing.length ? 'danger' : undefined} sub={missing.length ? `${missing.length} mandatory missing` : `${mineDocs.filter((d) => d.status === 'pending').length} waiting for HR`} />
      </div>

      <section>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-[15px] font-semibold text-ink">Letters & payslips</h3>
          <Segmented size="sm" value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'letters', label: 'Letters' }, { value: 'payslips', label: 'Payslips' }]} />
        </div>
        {toAck.length > 0 && (
          <Callout tone="warning" className="mb-3" title={`${toAck.length} ${toAck.length === 1 ? 'document needs' : 'documents need'} your acknowledgement`}>
            Open {toAck.length === 1 ? 'it' : 'each one'}, read it and select Acknowledge.
          </Callout>
        )}
        <IssuedTable rows={list} loading={issued.isLoading} error={issued.error} onRetry={() => issued.refetch()} showEmployee={false} empty={<EmptyState compact icon={<FileText />} title="Nothing issued to you yet" body="Offer and joining letters, appraisal letters and payslips appear here." />} />
      </section>

      <section>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-[15px] font-semibold text-ink">My uploaded documents</h3>
            <p className="text-[12.5px] text-ink-3">ID proofs, PAN, Aadhaar, education, bank details. HR verifies each one.</p>
          </div>
          {!ro && (
            <Button variant="primary" icon={<FileUp className="size-4" />} onClick={() => setUpload({ open: true })}>
              Upload document
            </Button>
          )}
        </div>
        {missing.length > 0 && (
          <Callout tone="warning" className="mb-3" title="Mandatory documents missing">
            <div className="mt-1 flex flex-wrap gap-2">
              {missing.map((k) => (
                <Button key={k} size="sm" variant="secondary" disabled={ro} onClick={() => setUpload({ open: true, kind: k })}>
                  Upload {k === 'pan' ? 'PAN' : k === 'aadhaar' ? 'Aadhaar' : k === 'bank' ? 'bank details' : 'education certificate'}
                </Button>
              ))}
            </div>
          </Callout>
        )}
        {file.isLoading ? <SkeletonRows rows={3} /> : <EmpDocsTable rows={mineDocs} canVerify={false} canDelete={(d) => d.status !== 'verified'} onReview={(doc, action) => setReview({ doc, action })} empty={<EmptyState compact icon={<FileUp />} title="You have not uploaded anything yet" body="Start with your PAN, Aadhaar, education certificate and bank details." />} />}
      </section>

      <section>
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="text-[15px] font-semibold text-ink">To read</h3>
          <Link to="/documents?tab=policies" className="text-[13px] font-medium text-brand-text hover:underline">
            All policies
          </Link>
        </div>
        {docs.isLoading ? (
          <SkeletonRows rows={2} />
        ) : toRead.length ? (
          <DataTable rows={toRead} columns={readCols} rowKey={(d) => d.id} onRowClick={(d) => onOpen(d.id)} stickyHeader={false} />
        ) : (
          <Card>
            <p className="flex items-center gap-2 text-[13.5px] text-ink-2">
              <CheckCircle2 className="size-4 text-success-text" /> You have read every must-read policy and project document.
            </p>
          </Card>
        )}
      </section>
      <EmpDocUploadDialog open={upload.open} onOpenChange={(o) => setUpload({ open: o, kind: upload.kind })} defaultKind={upload.kind} />
      <ReviewDialog doc={review.doc} action={review.action} onClose={() => setReview({ doc: null, action: 'verify' })} />
    </div>
  )
}

