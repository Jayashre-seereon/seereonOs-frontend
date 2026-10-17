import { useMemo, useState } from 'react'
import type { Designation } from '@/types/access'
import { useMasterList, useRolesLite } from '@/api/master'
import { Badge, Field, Input, Select, useCan } from '@/ui'
import { InactiveBadge, MasterListPage, PeopleCount, RecordDialog, errOf, useSaveRecord } from './master/kit'

/** Role names by key (designation.default_role_id stores a role KEY). Falls back to a readable key. */
function useRoleNames() {
  const c = useCan()
  const q = useRolesLite(c('roles.view') || c('view_as'))
  const map = useMemo(() => new Map((q.data ?? []).map((r) => [r.key, r.name])), [q.data])
  return { roles: q.data ?? [], name: (key: string | null) => (key ? map.get(key) ?? key.replace(/_/g, ' ').replace(/^./, (s) => s.toUpperCase()) : null) }
}

export default function DesignationsPage() {
  const deps = useMasterList('departments')
  const grades = useMasterList('grades')
  const depOf = useMemo(() => new Map((deps.data ?? []).map((d) => [d.id, d])), [deps.data])
  const gradeOf = useMemo(() => new Map((grades.data ?? []).map((g) => [g.id, g])), [grades.data])
  const roles = useRoleNames()
  return (
    <MasterListPage
      type="designations"
      title="Designations"
      subtitle="Job titles. Each one suggests a department, grade and the role a new joiner gets by default."
      addLabel="Add designation"
      emptyBody="Add the job titles you hire for. When you create an employee, picking a designation fills in department, grade and role."
      order={(r) => [...r].sort((a, b) => (depOf.get(a.department_id ?? '')?.name ?? '~').localeCompare(depOf.get(b.department_id ?? '')?.name ?? '~') || a.name.localeCompare(b.name))}
      matches={(r, q) => r.name.toLowerCase().includes(q) || (depOf.get(r.department_id ?? '')?.name ?? '').toLowerCase().includes(q)}
      columns={(usage) => [
        {
          key: 'name',
          header: 'Designation',
          sortValue: (r) => r.name,
          cell: (r) => (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-ink">{r.name}</span>
              {!r.active && <InactiveBadge />}
            </div>
          ),
        },
        { key: 'dep', header: 'Department', sortValue: (r) => depOf.get(r.department_id ?? '')?.name ?? '', cell: (r) => <span className="whitespace-nowrap text-ink-2">{depOf.get(r.department_id ?? '')?.name ?? '—'}</span>, hideBelow: 'lg' },
        { key: 'grade', header: 'Grade', sortValue: (r) => gradeOf.get(r.grade_id ?? '')?.code ?? '', cell: (r) => <span className="whitespace-nowrap font-mono text-[12.5px] text-ink-2">{gradeOf.get(r.grade_id ?? '')?.code ?? '—'}</span> },
        { key: 'role', header: 'Default role', cell: (r) => (r.default_role_id ? <Badge size="sm">{roles.name(r.default_role_id)}</Badge> : <span className="text-ink-3">—</span>) },
        { key: 'people', header: 'People', align: 'right', sortValue: (r) => usage[r.id] ?? 0, cell: (r) => <PeopleCount n={usage[r.id]} /> },
      ]}
      mobileCard={(r, usage) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{r.name}</span>
            {!r.active && <InactiveBadge />}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
            {[depOf.get(r.department_id ?? '')?.name, gradeOf.get(r.grade_id ?? '')?.code].filter(Boolean).join(' · ') || 'No department'}
          </div>
          <div className="mt-2 flex items-center justify-between gap-3">
            {r.default_role_id ? <Badge size="sm">{roles.name(r.default_role_id)}</Badge> : <span className="text-[13px] text-ink-3">No default role</span>}
            <PeopleCount n={usage[r.id]} />
          </div>
        </div>
      )}
      renderDialog={(row, close) => <DesignationDialog row={row} onClose={close} />}
    />
  )
}

function DesignationDialog({ row, onClose }: { row: Designation | null; onClose: () => void }) {
  const deps = useMasterList('departments')
  const grades = useMasterList('grades')
  const roles = useRoleNames()
  const [f, setF] = useState({ name: row?.name ?? '', department_id: row?.department_id ?? '', grade_id: row?.grade_id ?? '', default_role_id: row?.default_role_id ?? '' })
  const m = useSaveRecord('designations', row, onClose)
  const e = m.error
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const roleOpts = roles.roles.filter((r) => r.active || r.key === f.default_role_id).map((r) => ({ value: r.key, label: r.name }))
  if (f.default_role_id && !roleOpts.some((o) => o.value === f.default_role_id)) roleOpts.unshift({ value: f.default_role_id, label: roles.name(f.default_role_id) ?? f.default_role_id })
  return (
    <RecordDialog
      title={row ? `Edit ${row.name}` : 'Add designation'}
      onClose={onClose}
      onSave={() => m.mutate({ name: f.name, department_id: f.department_id || null, grade_id: f.grade_id || null, default_role_id: f.default_role_id || null })}
      saving={m.isPending}
      saveLabel={row ? 'Save' : 'Add designation'}
    >
      <Field label="Job title" htmlFor="des-name" required error={errOf(e, 'name')}>
        <Input id="des-name" value={f.name} onChange={(x) => set('name', x.target.value)} placeholder="e.g. Senior MERN Developer" invalid={!!errOf(e, 'name')} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Department" htmlFor="des-dep" error={errOf(e, 'department_id')}>
          <Select id="des-dep" value={f.department_id} onChange={(x) => set('department_id', x.target.value)} placeholder="Any department" options={(deps.data ?? []).filter((d) => d.active || d.id === f.department_id).map((d) => ({ value: d.id, label: d.name }))} invalid={!!errOf(e, 'department_id')} />
        </Field>
        <Field label="Grade" htmlFor="des-grade" error={errOf(e, 'grade_id')}>
          <Select id="des-grade" value={f.grade_id} onChange={(x) => set('grade_id', x.target.value)} placeholder="No grade" options={(grades.data ?? []).filter((g) => g.active || g.id === f.grade_id).map((g) => ({ value: g.id, label: `${g.code} · ${g.name}` }))} invalid={!!errOf(e, 'grade_id')} />
        </Field>
      </div>
      <Field label="Default role" htmlFor="des-role" error={errOf(e, 'default_role_id')} hint="What a new joiner with this title can see and do. You can still change it per person.">
        <Select id="des-role" value={f.default_role_id} onChange={(x) => set('default_role_id', x.target.value)} placeholder="Choose when creating the employee" options={roleOpts} invalid={!!errOf(e, 'default_role_id')} />
      </Field>
    </RecordDialog>
  )
}
