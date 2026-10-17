import { useMemo, useState } from 'react'
import type { CostCentre } from '@/types/access'
import { useMasterList } from '@/api/master'
import { Field, Input, PeoplePicker, PersonName } from '@/ui'
import { InactiveBadge, MasterListPage, PeopleCount, RecordDialog, errOf, useSaveRecord } from './master/kit'

export default function CostCentresPage() {
  const deps = useMasterList('departments')
  const depsOf = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const d of deps.data ?? []) if (d.cost_centre_id) m.set(d.cost_centre_id, [...(m.get(d.cost_centre_id) ?? []), d.name])
    return m
  }, [deps.data])
  return (
    <MasterListPage
      type="cost-centres"
      title="Cost centres"
      subtitle="Where salary and spend are booked. Departments point to a cost centre; people inherit it."
      addLabel="Add cost centre"
      emptyBody="Add a cost centre for each budget owner, then link departments to them."
      order={(r) => [...r].sort((a, b) => a.code.localeCompare(b.code))}
      matches={(r, q) => [r.code, r.name].some((x) => x.toLowerCase().includes(q))}
      columns={(usage) => [
        {
          key: 'name',
          header: 'Cost centre',
          sortValue: (r) => r.code,
          cell: (r) => (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="shrink-0 font-mono text-[12.5px] font-medium text-ink">{r.code}</span>
              <span className="truncate text-ink">{r.name}</span>
              {!r.active && <InactiveBadge />}
            </div>
          ),
        },
        { key: 'owner', header: 'Owner', cell: (r) => (r.owner_id ? <PersonName id={r.owner_id} size={24} /> : <span className="text-ink-3">No owner</span>) },
        { key: 'deps', header: 'Departments', hideBelow: 'lg', cell: (r) => <span className="text-ink-2">{depsOf.get(r.id)?.join(', ') ?? '—'}</span> },
        { key: 'people', header: 'People', align: 'right', sortValue: (r) => usage[r.id] ?? 0, cell: (r) => <PeopleCount n={usage[r.id]} /> },
      ]}
      mobileCard={(r, usage) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium">{r.code}</span>
            <span className="truncate text-[14px] font-medium">{r.name}</span>
            {!r.active && <InactiveBadge />}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">{depsOf.get(r.id)?.join(', ') ?? 'No departments'}</div>
          <div className="mt-2 flex items-center justify-between gap-3">
            {r.owner_id ? <PersonName id={r.owner_id} size={22} className="text-[13px]" /> : <span className="text-[13px] text-ink-3">No owner</span>}
            <PeopleCount n={usage[r.id]} />
          </div>
        </div>
      )}
      renderDialog={(row, close) => <CostCentreDialog row={row} onClose={close} />}
    />
  )
}

function CostCentreDialog({ row, onClose }: { row: CostCentre | null; onClose: () => void }) {
  const [f, setF] = useState({ code: row?.code ?? '', name: row?.name ?? '', owner_id: row?.owner_id ?? null })
  const m = useSaveRecord('cost-centres', row, onClose)
  const e = m.error
  return (
    <RecordDialog title={row ? `Edit ${row.code}` : 'Add cost centre'} onClose={onClose} onSave={() => m.mutate(f)} saving={m.isPending} saveLabel={row ? 'Save' : 'Add cost centre'} size="sm">
      <div className="grid grid-cols-[130px_1fr] gap-4">
        <Field label="Code" htmlFor="cc-code" required error={errOf(e, 'code')}>
          <Input id="cc-code" value={f.code} onChange={(x) => setF({ ...f, code: x.target.value.toUpperCase() })} placeholder="CC-DEL" maxLength={16} invalid={!!errOf(e, 'code')} />
        </Field>
        <Field label="Name" htmlFor="cc-name" required error={errOf(e, 'name')}>
          <Input id="cc-name" value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} placeholder="Delivery" invalid={!!errOf(e, 'name')} />
        </Field>
      </div>
      <Field label="Owner" error={errOf(e, 'owner_id')} hint="The person accountable for this budget.">
        <PeoplePicker value={f.owner_id} onChange={(v) => setF({ ...f, owner_id: v })} clearable placeholder="Choose an owner" invalid={!!errOf(e, 'owner_id')} />
      </Field>
    </RecordDialog>
  )
}
