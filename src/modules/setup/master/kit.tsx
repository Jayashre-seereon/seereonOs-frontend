// Shared building blocks for the Setup → master-data screens (list page, record dialog, row actions).
import { useMemo, useState, type ReactNode } from 'react'
import { Ban, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2 } from '@/ui/icons'
import { announce, isPending, type Proposed } from '@/api/changes'
import type { ApiError } from '@/api/http'
import { toastError, useMut } from '@/api/query'
import { masterApi, useMasterList, useMasterUsage, type MasterRowOf, type MasterType } from '@/api/master'
import { Badge, Button, Dialog, EmptyState, IconButton, Menu, PageHeader, SearchInput, Switch, useCan, useConfirm, useReadOnly, type Column, DataTable, type MenuItem } from '@/ui'
import { cn } from '@/lib/utils'

export const LABEL: Record<MasterType, { one: string; many: string }> = {
  locations: { one: 'location', many: 'locations' },
  departments: { one: 'department', many: 'departments' },
  designations: { one: 'designation', many: 'designations' },
  grades: { one: 'grade', many: 'grades' },
  'cost-centres': { one: 'cost centre', many: 'cost centres' },
  shifts: { one: 'shift', many: 'shifts' },
}
const nameOf = (r: { name?: string; code?: string }) => r.name || r.code || ''
const INVALIDATE = [['master'], ['changes'], ['directory'], ['onboarding'], ['setup']]

export function errOf(e: unknown, f: string) {
  const x = e as ApiError | null
  return x?.field === f ? x.message : null
}

/** Can this person change this kind of master data right now? */
export function useMasterEdit(type: MasterType) {
  const c = useCan()
  const ro = useReadOnly()
  return !ro && c(type === 'shifts' ? 'shifts.manage' : 'master.edit')
}

/** Create / update / delete / (de)activate with maker-checker aware toasts and the IN_USE → deactivate offer. */
export function useMasterActions<T extends MasterType>(type: T) {
  const { confirm } = useConfirm()
  const one = LABEL[type].one
  const setActive = useMut((v: { row: MasterRowOf[T]; active: boolean }) => masterApi.setActive(type, v.row.id, v.active), {
    invalidate: INVALIDATE,
    onSuccess: (r, v) => announce(r, `${cap(nameOf(v.row as { name?: string }))} ${v.active ? 'activated' : 'deactivated'}`),
  })
  const del = useMut((row: MasterRowOf[T]) => masterApi.remove(type, row.id, row.version), {
    invalidate: INVALIDATE,
    silentError: true,
    onSuccess: (r, row) => announce(r, `${cap(nameOf(row as { name?: string }))} deleted`),
    onError: async (e, row) => {
      if (e.code === 'IN_USE' && (row as { active?: boolean }).active) {
        const ok = await confirm({ title: `Can’t delete ${nameOf(row as { name?: string })}`, body: e.message, confirmLabel: 'Deactivate instead', cancelLabel: 'Keep it' })
        if (ok) setActive.mutate({ row, active: false })
      } else toastError(e)
    },
  })
  const askDelete = async (row: MasterRowOf[T]) => {
    const n = nameOf(row as { name?: string })
    if (await confirm({ title: `Delete ${n}?`, body: `The ${one} is removed for good. Records that only mention it by name are not affected.`, confirmLabel: 'Delete', tone: 'danger' })) del.mutate(row)
  }
  const askDeactivate = async (row: MasterRowOf[T]) => {
    const n = nameOf(row as { name?: string })
    if (await confirm({ title: `Deactivate ${n}?`, body: `People already on it keep it, but it can’t be picked for anyone new. You can activate it again any time.`, confirmLabel: 'Deactivate' })) setActive.mutate({ row, active: false })
  }
  return { askDelete, askDeactivate, activate: (row: MasterRowOf[T]) => setActive.mutate({ row, active: true }), busy: del.isPending || setActive.isPending }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Save hook for a record dialog: create or update, closes on success (applied or sent for approval). */
export function useSaveRecord<T extends MasterType>(type: T, row: MasterRowOf[T] | null, onDone: () => void) {
  return useMut((body: Partial<MasterRowOf[T]>) => (row ? masterApi.update(type, row.id, body, row.version) : masterApi.create(type, body)), {
    invalidate: INVALIDATE,
    onSuccess: (r: Proposed<MasterRowOf[T]>) => {
      announce(r, row ? `${cap(LABEL[type].one)} saved` : `${cap(LABEL[type].one)} added`)
      onDone()
    },
  })
}

interface RowActions<R> {
  askDelete: (r: R) => unknown
  askDeactivate: (r: R) => unknown
  activate: (r: R) => unknown
}
export function rowMenu<R extends { active: boolean }>(row: R, a: RowActions<R>, onEdit: () => void, extra: MenuItem[] = []): MenuItem[] {
  const active = row.active
  return [
    { label: 'Edit', icon: <Pencil />, onSelect: onEdit },
    ...extra,
    active ? { label: 'Deactivate', icon: <Ban />, onSelect: () => a.askDeactivate(row) } : { label: 'Activate', icon: <RotateCcw />, onSelect: () => a.activate(row) },
    { separator: true, label: '' },
    { label: 'Delete', icon: <Trash2 />, danger: true, onSelect: () => a.askDelete(row) },
  ]
}

export function RowMenu({ items, label }: { items: MenuItem[]; label: string }) {
  return (
    <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} className="inline-flex">
      <Menu
        label={label}
        trigger={
          <IconButton size="sm" label={label}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        }
        items={items}
      />
    </div>
  )
}

export function PeopleCount({ n }: { n: number | undefined }) {
  const v = n ?? 0
  return <span className={cn('tnum whitespace-nowrap text-[13px]', v ? 'text-ink-2' : 'text-ink-3')}>{v === 1 ? '1 person' : `${v} people`}</span>
}
export function InactiveBadge() {
  return (
    <Badge size="sm" tone="neutral">
      Inactive
    </Badge>
  )
}

/** Toolbar row: search + "Show inactive". */
export function ListToolbar({ search, onSearch, showInactive, onShowInactive, inactiveCount, placeholder }: { search: string; onSearch: (v: string) => void; showInactive: boolean; onShowInactive: (v: boolean) => void; inactiveCount: number; placeholder: string }) {
  return (
    <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <SearchInput value={search} onChange={onSearch} placeholder={placeholder} className="sm:w-[280px]" />
      <label className="flex items-center gap-2.5 text-[13.5px] text-ink-2">
        <Switch checked={showInactive} onChange={onShowInactive} />
        <span>
          Show inactive<span className="tnum text-ink-3"> ({inactiveCount})</span>
        </span>
      </label>
    </div>
  )
}

/** Generic master-data list page (header, toolbar, table/cards, dialogs). */
export function MasterListPage<T extends MasterType>({
  type, title, subtitle, columns, mobileCard, renderDialog, order, matches, extraMenu, emptyBody, addLabel,
}: {
  type: T
  title: string
  subtitle: string
  columns: (usage: Record<string, number>) => Column<MasterRowOf[T]>[]
  mobileCard: (r: MasterRowOf[T], usage: Record<string, number>) => ReactNode
  renderDialog: (row: MasterRowOf[T] | null, onClose: () => void) => ReactNode
  order?: (rows: MasterRowOf[T][]) => MasterRowOf[T][]
  matches: (r: MasterRowOf[T], q: string) => boolean
  extraMenu?: (r: MasterRowOf[T]) => MenuItem[]
  emptyBody: string
  addLabel: string
}) {
  const q = useMasterList(type)
  const usageQ = useMasterUsage()
  const usage = usageQ.data?.[type] ?? {}
  const canEdit = useMasterEdit(type)
  const actions = useMasterActions(type)
  const [edit, setEdit] = useState<MasterRowOf[T] | 'new' | null>(null)
  const [search, setSearch] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const all = q.data as MasterRowOf[T][] | undefined
  const inactive = (all ?? []).filter((r) => !(r as { active: boolean }).active).length
  const visible = useMemo(() => {
    const list = (all ?? []).filter((r) => (showInactive || (r as { active: boolean }).active) && (!search.trim() || matches(r, search.trim().toLowerCase())))
    return order ? order(list) : list
  }, [all, showInactive, search, order, matches])

  const menuCol: Column<MasterRowOf[T]> = {
    key: '_menu',
    header: <span className="sr-only">Actions</span>,
    width: '52px',
    align: 'right',
    cell: (r) => <RowMenu label={`Actions for ${nameOf(r as { name?: string })}`} items={rowMenu(r, actions, () => setEdit(r), extraMenu?.(r))} />,
  }
  const cols = [...columns(usage), ...(canEdit ? [menuCol] : [])]
  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          canEdit && (
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setEdit('new')}>
              {addLabel}
            </Button>
          )
        }
      />
      {(all?.length ?? 0) > 0 && <ListToolbar search={search} onSearch={setSearch} showInactive={showInactive} onShowInactive={setShowInactive} inactiveCount={inactive} placeholder={`Search ${LABEL[type].many}`} />}
      <DataTable
        rows={visible}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => q.refetch()}
        columns={cols}
        rowKey={(r) => r.id}
        onRowClick={canEdit ? (r) => setEdit(r) : undefined}
        rowClassName={(r) => ((r as { active: boolean }).active ? undefined : 'bg-surface-2/50 [&>td:not(:last-child)]:opacity-55 [&>div>div:first-child]:opacity-60')}
        mobileCard={(r) => (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">{mobileCard(r, usage)}</div>
            {canEdit && <RowMenu label={`Actions for ${nameOf(r as { name?: string })}`} items={rowMenu(r, actions, () => setEdit(r), extraMenu?.(r))} />}
          </div>
        )}
        empty={
          <EmptyState
            title={all?.length ? `No ${LABEL[type].many} match` : `No ${LABEL[type].many} yet`}
            body={all?.length ? (showInactive ? 'Try a different search.' : 'Try a different search, or turn on “Show inactive”.') : emptyBody}
            action={!all?.length && canEdit ? <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>{addLabel}</Button> : undefined}
          />
        }
      />
      {edit && renderDialog(edit === 'new' ? null : edit, () => setEdit(null))}
    </div>
  )
}

/** Standard record dialog chrome. */
export function RecordDialog({ open = true, title, description, onClose, onSave, saving, saveLabel, children, size = 'md' }: { open?: boolean; title: string; description?: ReactNode; onClose: () => void; onSave: () => void; saving: boolean; saveLabel: string; children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={onSave}>
            {saveLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          onSave()
        }}
      >
        {children}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

export { isPending }
