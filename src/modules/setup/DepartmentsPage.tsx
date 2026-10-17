import { useMemo, useState } from 'react'
import type { Department } from '@/types/access'
import { useMasterList } from '@/api/master'
import { Field, Input, PeoplePicker, PersonName, Select } from '@/ui'
import { CornerDownRight } from '@/ui/icons'
import { InactiveBadge, MasterListPage, PeopleCount, RecordDialog, errOf, useSaveRecord } from './master/kit'

const KIND: Record<Department['kind'], string> = { management: 'Management', delivery: 'Delivery', sales: 'Sales', operations: 'Operations' }

/** Depth-first order with depth, so children sit under their parent. */
function tree(rows: Department[], all: Department[]) {
  const ids = new Set(rows.map((r) => r.id))
  const depthOf = new Map<string, number>()
  const out: Department[] = []
  const kids = (pid: string | null) => rows.filter((r) => (r.parent_id && ids.has(r.parent_id) ? r.parent_id : null) === pid).sort((a, b) => a.name.localeCompare(b.name))
  const walk = (pid: string | null, d: number) => {
    for (const k of kids(pid)) {
      if (depthOf.has(k.id)) continue
      depthOf.set(k.id, d)
      out.push(k)
      walk(k.id, d + 1)
    }
  }
  walk(null, 0)
  for (const r of rows) if (!depthOf.has(r.id)) (depthOf.set(r.id, 0), out.push(r))
  void all
  return { list: out, depth: depthOf }
}

export default function DepartmentsPage() {
  const deps = useMasterList('departments')
  const ccs = useMasterList('cost-centres')
  const ccOf = useMemo(() => new Map((ccs.data ?? []).map((c) => [c.id, c])), [ccs.data])
  const depth = useMemo(() => tree(deps.data ?? [], deps.data ?? []).depth, [deps.data])
  const parentName = (id: string | null) => (deps.data ?? []).find((d) => d.id === id)?.name
  return (
    <MasterListPage
      type="departments"
      title="Departments"
      subtitle="How the organisation is structured. Each department has a head and books its cost to a cost centre."
      addLabel="Add department"
      emptyBody="Start with your top-level functions (e.g. Delivery, Sales, HR & operations) and nest teams under them."
      order={(rows) => tree(rows, deps.data ?? []).list}
      matches={(r, q) => [r.name, r.code].some((x) => x.toLowerCase().includes(q))}
      columns={(usage) => [
        {
          key: 'name',
          header: 'Department',
          cell: (r) => {
            const d = depth.get(r.id) ?? 0
            return (
              <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: Math.min(d, 4) * 20 }}>
                {d > 0 && <CornerDownRight className="size-3.5 shrink-0 text-ink-3" />}
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">{r.name}</div>
                  <div className="truncate text-[12.5px] text-ink-3">
                    {r.code} · {KIND[r.kind]}
                  </div>
                </div>
                {!r.active && <InactiveBadge />}
              </div>
            )
          },
        },
        { key: 'head', header: 'Head', cell: (r) => (r.head_id ? <PersonName id={r.head_id} size={24} /> : <span className="text-ink-3">No head</span>) },
        {
          key: 'cc',
          header: 'Cost centre',
          hideBelow: 'lg',
          cell: (r) => {
            const c = r.cost_centre_id ? ccOf.get(r.cost_centre_id) : null
            return c ? (
              <span className="whitespace-nowrap">
                <span className="font-mono text-[12.5px] text-ink-2">{c.code}</span>
              </span>
            ) : (
              <span className="text-ink-3">—</span>
            )
          },
        },
        { key: 'people', header: 'People', align: 'right', sortValue: (r) => usage[r.id] ?? 0, cell: (r) => <PeopleCount n={usage[r.id]} /> },
      ]}
      mobileCard={(r, usage) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{r.name}</span>
            {!r.active && <InactiveBadge />}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
            {r.code}
            {r.parent_id ? ` · under ${parentName(r.parent_id) ?? '—'}` : ' · top level'}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            {r.head_id ? <PersonName id={r.head_id} size={22} className="text-[13px]" /> : <span className="text-[13px] text-ink-3">No head</span>}
            <PeopleCount n={usage[r.id]} />
          </div>
        </div>
      )}
      renderDialog={(row, close) => <DepartmentDialog row={row} all={deps.data ?? []} onClose={close} />}
    />
  )
}

function DepartmentDialog({ row, all, onClose }: { row: Department | null; all: Department[]; onClose: () => void }) {
  const ccs = useMasterList('cost-centres')
  const [f, setF] = useState({ name: row?.name ?? '', code: row?.code ?? '', kind: row?.kind ?? 'delivery', parent_id: row?.parent_id ?? '', head_id: row?.head_id ?? null, cost_centre_id: row?.cost_centre_id ?? '' })
  const m = useSaveRecord('departments', row, onClose)
  const e = m.error
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  // a department can't move under itself or one of its own sub-departments
  const blocked = useMemo(() => {
    const s = new Set<string>()
    if (!row) return s
    const add = (id: string) => {
      s.add(id)
      for (const d of all) if (d.parent_id === id && !s.has(d.id)) add(d.id)
    }
    add(row.id)
    return s
  }, [row, all])
  const parents = all.filter((d) => !blocked.has(d.id) && (d.active || d.id === f.parent_id)).sort((a, b) => a.name.localeCompare(b.name))
  const ccOpts = (ccs.data ?? []).filter((c) => c.active || c.id === f.cost_centre_id).map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : 'Add department'}
      onClose={onClose}
      onSave={() => m.mutate({ ...f, parent_id: f.parent_id || null, cost_centre_id: f.cost_centre_id || null } as Partial<Department>)}
      saving={m.isPending}
      saveLabel={row ? 'Save' : 'Add department'}
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Name" htmlFor="dep-name" required error={errOf(e, 'name')}>
          <Input id="dep-name" value={f.name} onChange={(x) => set('name', x.target.value)} placeholder="e.g. Delivery" invalid={!!errOf(e, 'name')} />
        </Field>
        <Field label="Code" htmlFor="dep-code" required error={errOf(e, 'code')}>
          <Input id="dep-code" value={f.code} onChange={(x) => set('code', x.target.value.toUpperCase())} placeholder="DEL" maxLength={12} invalid={!!errOf(e, 'code')} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Parent department" htmlFor="dep-parent" error={errOf(e, 'parent_id')} hint="Leave empty for a top-level department.">
          <Select id="dep-parent" value={f.parent_id} onChange={(x) => set('parent_id', x.target.value)} placeholder="None (top level)" options={parents.map((d) => ({ value: d.id, label: d.name }))} invalid={!!errOf(e, 'parent_id')} />
        </Field>
        <Field label="Kind" htmlFor="dep-kind" hint="Groups people in reports." error={errOf(e, 'kind')}>
          <Select id="dep-kind" value={f.kind} onChange={(x) => set('kind', x.target.value as Department['kind'])} options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
        </Field>
      </div>
      <Field label="Head" error={errOf(e, 'head_id')} hint="Approves leave and expenses where a workflow uses “department head”.">
        <PeoplePicker value={f.head_id} onChange={(v) => set('head_id', v)} clearable placeholder="Choose the department head" invalid={!!errOf(e, 'head_id')} />
      </Field>
      <Field label="Cost centre" htmlFor="dep-cc" error={errOf(e, 'cost_centre_id')}>
        <Select id="dep-cc" value={f.cost_centre_id} onChange={(x) => set('cost_centre_id', x.target.value)} placeholder="No cost centre" options={ccOpts} invalid={!!errOf(e, 'cost_centre_id')} />
      </Field>
    </RecordDialog>
  )
}
