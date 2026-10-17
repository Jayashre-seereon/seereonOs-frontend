// Expenses: everyone files claims; PMs / managers approve (admin second step above ₹25,000);
// HR & operations reimburse, which books the ledger. Budget fit is checked on approval.
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Banknote, Check, CheckCircle2, Copy, Eye, MoreHorizontal, Paperclip, Pencil, Plus, Receipt, Send, Trash2, X } from '@/ui/icons'
import {
  Badge, Button, Callout, Combobox, DataTable, Dialog, EmptyState, Field, FileUpload, IconButton, Input, KV, Menu, Money, MoneyInput, PageHeader, PersonName, SearchInput, Select, Sheet,
  SkeletonCards, StatCard, StatusBadge, Switch, Tabs, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { useMut } from '@/api/query'
import { ApprovalRoute } from '@/modules/workflows/ApprovalRoute'
import { readFile, SPEND_INVALIDATE, spendApi, useExpense, useExpenses, useSpendMeta, type ExpenseInput, type ExpenseRow, type ExpenseTab, type FileInput } from '@/api/spend'
import { ExportMenu } from '@/reports/ExportMenu'
import { addDays, fmtDate, fmtDateTime } from '@/domain/calendar'
import { fmtMoney, fmtMoneyCompact } from '@/domain/money'
import { cn } from '@/lib/utils'
import { EXPENSE_CATEGORY_LABEL, EXPENSE_MAX_AGE_DAYS, EXPENSE_STATUS, RECEIPT_LIMIT_PAISE, SECOND_APPROVAL_PAISE, type ExpenseCategory } from './labels'
import { KpiRow, Meta, useFieldErrors } from './components'

const TABS: ExpenseTab[] = ['mine', 'approve', 'pay', 'all']

export default function ExpensesPage() {
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as ExpenseTab) ? params.get('tab') : 'mine') as ExpenseTab
  const setTab = (t: ExpenseTab) => setParams((p) => { p.set('tab', t); return p }, { replace: true })
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const list = useExpenses(tab, { status: status || undefined, q: q || undefined })
  const meta = useSpendMeta()
  const readOnly = useReadOnly()
  const [editing, setEditing] = useState<ExpenseRow | 'new' | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const d = list.data
  const can = d?.can
  const act = useExpenseActions()

  const cols: Column<ExpenseRow>[] = [
    { key: 'date', header: 'Date', width: '92px', sortValue: (r) => r.spent_on, cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{fmtDate(r.spent_on)}</span> },
    {
      key: 'claim', header: 'Claim', sortValue: (r) => r.description.toLowerCase(),
      cell: (r) => (
        <div className="min-w-0 max-w-[380px]">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-ink">{r.description}</span>
            {r.receipt_name && <Paperclip className="size-3.5 shrink-0 text-ink-3" aria-label="Receipt attached" />}
          </div>
          <div className="truncate text-[12px] text-ink-3">
            {EXPENSE_CATEGORY_LABEL[r.category]}
            {r.project_code && ` · ${r.project_code} ${r.client ?? ''}`}
            {r.billable_to_client && ' · re-bill to client'}
          </div>
        </div>
      ),
    },
    ...(tab === 'mine' ? [] : [{ key: 'who', header: 'Claimed by', sortValue: (r: ExpenseRow) => r.user_name, cell: (r: ExpenseRow) => <PersonName id={r.user_id} size={22} />, hideBelow: 'lg' as const }]),
    { key: 'status', header: 'Status', sortValue: (r) => r.status, cell: (r) => <StatusCell r={r} /> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (r) => r.amount_paise, cell: (r) => <Money value={r.amount_paise} className="font-medium" /> },
    {
      key: 'act', header: '', align: 'right', width: tab === 'approve' ? '196px' : tab === 'pay' ? '120px' : tab === 'all' ? '84px' : '52px',
      cell: (r) => <RowActions r={r} tab={tab} readOnly={readOnly} onEdit={() => setEditing(r)} onView={() => setViewing(r.id)} act={act} />,
    },
  ]

  const exportTable = () => ({
    title: tab === 'mine' ? 'My expense claims' : tab === 'approve' ? 'Expense claims to approve' : tab === 'pay' ? 'Expense claims to reimburse' : 'Expense claims',
    orientation: 'landscape' as const,
    category: 'Spend register',
    columns: [
      { key: 'date', label: 'Date', type: 'date' as const }, { key: 'person', label: 'Claimed by', type: 'string' as const }, { key: 'category', label: 'Category', type: 'string' as const },
      { key: 'description', label: 'Description', type: 'string' as const }, { key: 'project', label: 'Project', type: 'string' as const }, { key: 'billable', label: 'Re-bill', type: 'string' as const },
      { key: 'status', label: 'Status', type: 'string' as const }, { key: 'budget', label: 'Budget', type: 'string' as const }, { key: 'amount', label: 'Amount', type: 'money' as const },
    ],
    rows: (d?.items ?? []).map((r) => ({
      date: r.spent_on, person: r.user_name, category: EXPENSE_CATEGORY_LABEL[r.category], description: r.description, project: r.project_code ? `${r.project_code} ${r.project_name}` : '',
      billable: r.billable_to_client ? 'Yes' : '', status: EXPENSE_STATUS[r.status].label, budget: r.in_budget === false ? 'Outside budget' : r.in_budget ? 'In budget' : '', amount: r.amount_paise,
    })),
    totals: { amount: (d?.items ?? []).reduce((a, r) => a + r.amount_paise, 0) },
    kpis: d ? [{ label: 'Awaiting approval', value: fmtMoneyCompact(d.totals.pending) }, { label: 'Approved, unpaid', value: fmtMoneyCompact(d.totals.approved_unpaid) }, { label: 'Reimbursed', value: fmtMoneyCompact(d.totals.paid) }] : [],
  })

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle="Claim what you spent for work. Your PM or manager approves it, accounts reimburses it, and it books against the budget."
        actions={
          <>
            <ExportMenu table={d?.items.length ? exportTable : null} filename="expense-claims" />
            {!readOnly && (
              <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} className="flex-1 md:flex-none">
                New claim
              </Button>
            )}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => { setTab(t); setStatus('') }}
        tabs={[
          { value: 'mine', label: 'My claims', count: d?.counts.mine || undefined },
          { value: 'approve', label: 'To approve', count: d?.counts.approve ?? undefined, hidden: !!d && !can?.approve },
          { value: 'pay', label: 'To pay', count: d?.counts.pay ?? undefined, hidden: !!d && !can?.pay },
          { value: 'all', label: 'All claims', hidden: !!d && !can?.all },
        ]}
      />
      {list.isLoading ? (
        <SkeletonCards n={4} />
      ) : d ? (
        <KpiRow>
          <StatCard label="Awaiting approval" value={fmtMoneyCompact(d.totals.pending)} sub={tab === 'mine' ? 'With your approver' : 'Submitted claims'} />
          <StatCard label="Approved, not paid" value={fmtMoneyCompact(d.totals.approved_unpaid)} sub="Due for reimbursement" />
          <StatCard label="Reimbursed" value={fmtMoneyCompact(d.totals.paid)} sub="Paid and in the ledger" />
          <StatCard label="Outside budget" tone={d.totals.out_of_budget ? 'warning' : undefined} value={fmtMoneyCompact(d.totals.out_of_budget)} sub="Approved beyond the category budget" />
        </KpiRow>
      ) : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchInput value={q} onChange={setQ} placeholder={tab === 'mine' ? 'Search your claims' : 'Search claim or person'} className="w-full sm:w-72" />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: 'Any status' }, ...Object.entries(EXPENSE_STATUS).map(([value, s]) => ({ value, label: s.label }))]}
          className="w-full sm:w-44"
        />
      </div>

      <div className="mt-4">
        <DataTable
          rows={d?.items}
          loading={list.isLoading}
          error={list.error}
          onRetry={() => list.refetch()}
          columns={cols}
          rowKey={(r) => r.id}
          initialSort={{ key: 'date', dir: 'desc' }}
          onRowClick={(r) => setViewing(r.id)}
          empty={
            tab === 'mine' ? (
              <EmptyState icon={<Receipt />} title="No claims yet" body={`Spent money on travel, a client lunch or a course for work? Claim it within ${EXPENSE_MAX_AGE_DAYS} days.`} action={!readOnly && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>New claim</Button>} />
            ) : tab === 'approve' ? (
              <EmptyState icon={<CheckCircle2 />} title="Nothing to approve" body="Claims your team submits appear here." compact />
            ) : tab === 'pay' ? (
              <EmptyState icon={<CheckCircle2 />} title="Nothing to reimburse" body="Approved claims waiting for payment appear here." compact />
            ) : (
              <EmptyState title="No claims match" body="Clear the filters to see every claim." compact />
            )
          }
          mobileCard={(r) => (
            <div>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="line-clamp-2 break-words text-[14px] font-medium leading-snug text-ink">{r.description}</div>
                  <Meta>
                    {fmtDate(r.spent_on)} · {EXPENSE_CATEGORY_LABEL[r.category]}
                    {tab !== 'mine' && ` · ${r.user_name}`}
                  </Meta>
                  {r.project_code && <Meta>{r.project_code} {r.client}</Meta>}
                </div>
                <Money value={r.amount_paise} className="shrink-0 text-[14px] font-semibold" />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <StatusCell r={r} />
                <div onClick={(e) => e.stopPropagation()}>
                  <RowActions r={r} tab={tab} readOnly={readOnly} onEdit={() => setEditing(r)} onView={() => setViewing(r.id)} act={act} />
                </div>
              </div>
            </div>
          )}
        />
      </div>

      {editing && meta.data && <ClaimDialog row={editing === 'new' ? null : editing} meta={meta.data} onClose={() => setEditing(null)} />}
      <ClaimSheet id={viewing} onClose={() => setViewing(null)} act={act} readOnly={readOnly} onEdit={(r) => { setViewing(null); setEditing(r) }} />
    </div>
  )
}

function StatusCell({ r }: { r: ExpenseRow }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <StatusBadge map={EXPENSE_STATUS} value={r.status} size="sm" />
      {r.status === 'submitted' && (r.step_label ? <Badge tone="accent" size="sm">{r.step_label.split(' · ')[0]}</Badge> : r.step === 'admin' ? <Badge tone="accent" size="sm">CEO approval</Badge> : null)}
      {r.in_budget === false && <Badge tone="warning" size="sm">Outside budget</Badge>}
      {r.duplicate && r.status !== 'paid' && <Badge tone="danger" size="sm">Possible duplicate</Badge>}
    </div>
  )
}

/* ---------------- actions ---------------- */
function useExpenseActions() {
  const { askReason, confirm } = useConfirm()
  const approve = useMut((r: ExpenseRow) => spendApi.approveExpense(r.id, undefined, r.version), {
    invalidate: SPEND_INVALIDATE,
    // moving to the next workflow step is announced by the server's warning instead
    success: (res, r) => ((res as ExpenseRow | undefined)?.status === 'submitted' || (!res && r.amount_paise > SECOND_APPROVAL_PAISE && r.step === 'manager') ? null : 'Claim approved'),
  })
  const reject = useMut((v: { r: ExpenseRow; reason: string }) => spendApi.rejectExpense(v.r.id, v.reason, v.r.version), { invalidate: SPEND_INVALIDATE, success: 'Claim rejected' })
  const pay = useMut((r: ExpenseRow) => spendApi.payExpense(r.id, undefined, r.version), { invalidate: SPEND_INVALIDATE, success: 'Claim reimbursed and booked to the ledger' })
  const submit = useMut((r: ExpenseRow) => spendApi.submitExpense(r.id, r.version), { invalidate: SPEND_INVALIDATE, success: 'Claim submitted' })
  const del = useMut((r: ExpenseRow) => spendApi.deleteExpense(r.id, r.version), { invalidate: SPEND_INVALIDATE, success: 'Claim deleted' })
  return {
    busy: approve.isPending || reject.isPending || pay.isPending || submit.isPending || del.isPending,
    approve: (r: ExpenseRow) => approve.mutate(r),
    reject: async (r: ExpenseRow) => {
      const reason = await askReason({ title: `Reject ${fmtMoney(r.amount_paise)} claim?`, body: `${r.user_name} · ${r.description}`, label: 'What needs fixing', placeholder: 'e.g. Attach the GST invoice, not the card slip', confirmLabel: 'Reject claim', minLength: 5, tone: 'danger' })
      if (reason) reject.mutate({ r, reason })
    },
    pay: async (r: ExpenseRow) => {
      const ok = await confirm({ title: `Reimburse ${fmtMoney(r.amount_paise)} to ${r.user_name}?`, body: `A paid expense of ${fmtMoney(r.amount_paise)} is booked to the ledger under ${r.ledger_category}${r.project_code ? ` for ${r.project_code}` : ''}.`, confirmLabel: 'Mark paid' })
      if (ok) pay.mutate(r)
    },
    submit: (r: ExpenseRow) => submit.mutate(r),
    remove: async (r: ExpenseRow) => {
      const ok = await confirm({ title: 'Delete this claim?', body: `“${r.description}” (${fmtMoney(r.amount_paise)}) is removed.`, confirmLabel: 'Delete claim', tone: 'danger' })
      if (ok) del.mutate(r)
    },
  }
}
type Actions = ReturnType<typeof useExpenseActions>

function RowActions({ r, tab, readOnly, onEdit, onView, act }: { r: ExpenseRow; tab: ExpenseTab; readOnly: boolean; onEdit: () => void; onView: () => void; act: Actions }) {
  if (readOnly) return null
  if (tab === 'all' && (r.can_approve || r.can_pay))
    return (
      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
        {r.can_approve ? (
          <>
            <IconButton label="Reject" size="sm" variant="secondary" onClick={() => act.reject(r)} disabled={act.busy}><X className="size-4" /></IconButton>
            <IconButton label="Approve" size="sm" variant="primary" onClick={() => act.approve(r)} disabled={act.busy}><Check className="size-4" /></IconButton>
          </>
        ) : (
          <IconButton label="Mark paid" size="sm" variant="primary" onClick={() => act.pay(r)} disabled={act.busy}><Banknote className="size-4" /></IconButton>
        )}
      </div>
    )
  if (tab === 'approve' && r.can_approve)
    return (
      <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="secondary" icon={<X className="size-3.5" />} onClick={() => act.reject(r)} disabled={act.busy}>Reject</Button>
        <Button size="sm" variant="primary" icon={<Check className="size-3.5" />} onClick={() => act.approve(r)} disabled={act.busy}>Approve</Button>
      </div>
    )
  if (tab === 'pay' && r.can_pay)
    return (
      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
        <Button size="sm" variant="primary" onClick={() => act.pay(r)} disabled={act.busy}>Mark paid</Button>
      </div>
    )
  if (!r.can_edit) return null
  return (
    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
      <Menu
        label="Claim actions"
        trigger={<IconButton label="Claim actions" size="sm" variant="ghost"><MoreHorizontal className="size-4" /></IconButton>}
        items={[
          { label: 'Submit for approval', icon: <Send />, onSelect: () => act.submit(r) },
          { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
          { label: 'View details', icon: <Eye />, onSelect: onView },
          { separator: true, label: '' },
          { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => act.remove(r) },
        ]}
      />
    </div>
  )
}

/* ---------------- detail sheet ---------------- */
function ClaimSheet({ id, onClose, act, readOnly, onEdit }: { id: string | null; onClose: () => void; act: Actions; readOnly: boolean; onEdit: (r: ExpenseRow) => void }) {
  const q = useExpense(id)
  const e = q.data
  const footer = e && !readOnly ? (
    e.can_approve ? (
      <>
        <Button onClick={() => act.reject(e)} disabled={act.busy}>Reject</Button>
        <Button variant="primary" onClick={() => { act.approve(e); onClose() }} disabled={act.busy}>Approve</Button>
      </>
    ) : e.can_pay ? (
      <Button variant="primary" onClick={() => { act.pay(e); onClose() }} disabled={act.busy}>Mark paid</Button>
    ) : e.can_edit ? (
      <>
        <Button icon={<Pencil className="size-4" />} onClick={() => onEdit(e)}>Edit</Button>
        <Button variant="primary" icon={<Send className="size-4" />} onClick={() => { act.submit(e); onClose() }}>Submit for approval</Button>
      </>
    ) : undefined
  ) : undefined
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()} title={e ? fmtMoney(e.amount_paise) : 'Expense claim'} subtitle={e?.description ?? ''} footer={footer}>
      {q.isLoading || !e ? (
        <div className="space-y-3"><div className="skeleton h-5 w-1/2" /><div className="skeleton h-5 w-2/3" /><div className="skeleton h-24 w-full" /></div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-1.5"><StatusCell r={e} /></div>
          {e.status === 'rejected' && e.decision_reason && <Callout tone="danger" title="Rejected">{e.decision_reason}</Callout>}
          {e.duplicate && e.status !== 'paid' && <Callout tone="warning" title="Possible duplicate">Another claim by {e.user_name} has the same amount and date.</Callout>}
          <KV
            items={[
              { label: 'Claimed by', value: <PersonName id={e.user_id} size={22} /> },
              { label: 'Spent on', value: fmtDate(e.spent_on, 'long') },
              { label: 'Category', value: `${EXPENSE_CATEGORY_LABEL[e.category]}`, hint: `Books to ${e.ledger_category}` },
              { label: 'Project', value: e.project_code ? `${e.project_code} ${e.project_name}` : 'None (overhead)', hint: e.billable_to_client ? `Re-bill to ${e.client}` : undefined },
              { label: 'Approver', value: e.status === 'draft' ? '—' : e.approver_name, hint: e.first_approved_by_name ? `Approved first by ${e.first_approved_by_name}` : undefined },
              { label: 'Budget', value: e.in_budget === null ? 'Checked on approval' : e.in_budget ? 'Within budget' : 'Outside budget' },
              ...(e.paid_on ? [{ label: 'Reimbursed', value: fmtDate(e.paid_on, 'long') }] : []),
            ]}
          />
          {e.route && <ApprovalRoute route={e.route} dueOn={e.due_on} escalatesTo={e.escalates_to} />}
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-ink-3">Receipt</div>
            {e.receipt ? (
              e.receipt.data_url ? (
                <a href={e.receipt.data_url} download={e.receipt.name} className="inline-flex max-w-full items-center gap-2 rounded-md border border-line px-3 py-2 text-[13.5px] font-medium text-brand-text hover:bg-surface-2">
                  <Paperclip className="size-4 shrink-0" />
                  <span className="truncate">{e.receipt.name}</span>
                </a>
              ) : (
                <span className="inline-flex max-w-full items-center gap-2 text-[13.5px] text-ink-2"><Paperclip className="size-4 shrink-0 text-ink-3" /><span className="truncate">{e.receipt.name}</span></span>
              )
            ) : (
              <span className="text-[13.5px] text-ink-3">{e.amount_paise > RECEIPT_LIMIT_PAISE ? 'Missing — required above ₹500' : 'Not attached'}</span>
            )}
          </div>
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-3">History</div>
            {e.history.length ? (
              <ol className="space-y-2.5 border-l border-line pl-4">
                {e.history.map((h, i) => (
                  <li key={i} className="text-[13px]">
                    <div className="text-ink">{h.summary}</div>
                    <div className="text-[12px] text-ink-3">{h.actor} · {fmtDateTime(h.at)}</div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[13px] text-ink-3">No activity yet.</p>
            )}
          </div>
        </div>
      )}
    </Sheet>
  )
}

/* ---------------- create / edit ---------------- */
function ClaimDialog({ row, meta, onClose }: { row: ExpenseRow | null; meta: NonNullable<ReturnType<typeof useSpendMeta>['data']>; onClose: () => void }) {
  const [f, setF] = useState({
    category: (row?.category ?? '') as ExpenseCategory | '',
    description: row?.description ?? '',
    amount_paise: row?.amount_paise ?? 0,
    spent_on: row?.spent_on ?? meta.today,
    project_id: row?.project_id ?? null as string | null,
    billable_to_client: row?.billable_to_client ?? false,
  })
  const [file, setFile] = useState<FileInput | null>(null)
  const [hasReceipt, setHasReceipt] = useState(!!row?.receipt_name)
  const fe = useFieldErrors()
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => { setF((x) => ({ ...x, [k]: v })); fe.unset(k) }
  const save = useMut(
    (v: { submit: boolean }) => {
      const body: ExpenseInput = { ...f, category: f.category as ExpenseCategory, receipt: file, remove_receipt: !hasReceipt && !file && !!row?.receipt_name, submit: v.submit }
      return row ? spendApi.updateExpense(row.id, body, row.version) : spendApi.createExpense(body)
    },
    { invalidate: SPEND_INVALIDATE, success: (_r, v) => (v.submit ? 'Claim submitted for approval' : 'Draft saved'), onSuccess: onClose, onError: (e) => fe.take(e) },
  )
  const project = meta.projects.find((p) => p.id === f.project_id)
  const needsReceipt = f.amount_paise > RECEIPT_LIMIT_PAISE
  const projectOpts = useMemo(() => meta.projects.map((p) => ({ value: p.id, label: `${p.code} ${p.name}`, hint: p.client })), [meta.projects])
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={row ? 'Edit claim' : 'New expense claim'}
      description={`Claims must be filed within ${EXPENSE_MAX_AGE_DAYS} days. Attach the receipt for anything above ${fmtMoney(RECEIPT_LIMIT_PAISE)}.`}
      footer={
        <>
          <Button onClick={() => save.mutate({ submit: false })} loading={save.isPending && !save.variables?.submit} disabled={save.isPending}>Save draft</Button>
          <Button variant="primary" icon={<Send className="size-4" />} onClick={() => save.mutate({ submit: true })} loading={save.isPending && !!save.variables?.submit} disabled={save.isPending}>Submit claim</Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" required error={fe.errors.category}>
          <Select aria-label="Category" value={f.category} onChange={(e) => set('category', e.target.value as ExpenseCategory)} placeholder="Choose…" options={meta.expense_categories.map((c) => ({ value: c.value, label: c.label }))} invalid={!!fe.errors.category} />
        </Field>
        <Field label="Amount" required error={fe.errors.amount_paise} hint={f.amount_paise > SECOND_APPROVAL_PAISE ? 'Above ₹25,000 — the CEO approves after your manager.' : undefined}>
          <MoneyInput value={f.amount_paise} onChange={(v) => set('amount_paise', v)} invalid={!!fe.errors.amount_paise} />
        </Field>
        <Field label="What was it for" required error={fe.errors.description} className="sm:col-span-2">
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. Cab to client site, Keonjhar" maxLength={200} invalid={!!fe.errors.description} />
        </Field>
        <Field label="Date spent" required error={fe.errors.spent_on}>
          <Input type="date" value={f.spent_on} max={meta.today} min={addDays(meta.today, -EXPENSE_MAX_AGE_DAYS)} onChange={(e) => set('spent_on', e.target.value)} invalid={!!fe.errors.spent_on} />
        </Field>
        <Field label="Project" hint="Leave empty for office overheads." error={fe.errors.project_id}>
          <Combobox value={f.project_id} onChange={(v) => { set('project_id', v); if (!v) set('billable_to_client', false) }} clearable placeholder="No project" options={projectOpts} invalid={!!fe.errors.project_id} />
        </Field>
        {project && project.client !== 'Internal' && (
          <div className="sm:col-span-2">
            <Switch checked={f.billable_to_client} onChange={(v) => set('billable_to_client', v)} label="Re-bill to the client" description={`Shows on ${project.client} as an expense to recover on the next invoice.`} />
          </div>
        )}
        <Field label="Receipt" required={needsReceipt} error={fe.errors.receipt} className="sm:col-span-2" hint={needsReceipt ? undefined : 'Optional for ₹500 and below.'}>
          {hasReceipt && !file ? (
            <FileUpload onFile={() => undefined} file={{ name: row?.receipt_name ?? 'Receipt' }} onClear={() => setHasReceipt(false)} />
          ) : (
            <FileUpload
              accept="application/pdf,image/png,image/jpeg"
              label="Attach receipt"
              hint="PDF, PNG or JPG · up to 10 MB"
              file={file ? { name: file.name, size: file.size_bytes } : null}
              onClear={() => setFile(null)}
              onFile={async (fl) => { setFile(await readFile(fl)); fe.unset('receipt') }}
            />
          )}
        </Field>
      </div>
      {row?.status === 'rejected' && row.decision_reason && <Callout tone="danger" className="mt-4" title="Why it was rejected">{row.decision_reason}</Callout>}
      {row?.duplicate && <Callout tone="warning" className="mt-4" icon={<Copy />}>You have another claim with the same amount and date.</Callout>}
      <p className={cn('mt-4 text-[12.5px] text-ink-3')}>
        Goes to {project ? `the project manager of ${project.code}` : 'your reporting manager'} for approval.
      </p>
    </Dialog>
  )
}
