// Roles & permissions — list of roles, create / duplicate / delete, and a roles × permissions compare view.
import { Fragment, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Check, Copy, MoreHorizontal, Plus, Trash2, UserCog } from '@/ui/icons'
import { useMut } from '@/api/query'
import { accessApi, useRoles, type RoleRow } from '@/api/access'
import { isPending } from '@/api/changes'
import { MODULE_LABEL, MODULE_ORDER, PERMISSIONS, PERSONA_LABEL, type PermissionDef } from '@/domain/permissionCatalog'
import type { Role } from '@/types/entities'
import {
  Badge, Button, Callout, DataTable, Dialog, EmptyState, Field, IconButton, Input, Menu, PageHeader, SearchInput, Select, Switch, Tabs, Textarea, useCan, useConfirm, useReadOnly, type Column,
} from '@/ui'
import { cn } from '@/lib/utils'
import { errField } from '../admin/kit'
import { announceNamed } from '../access/kit'

const PERSONAS: Role[] = ['admin', 'pm', 'sales', 'ops', 'employee']
export const PERSONA_OPTIONS = PERSONAS.map((p) => ({ value: p, label: PERSONA_LABEL[p] }))
const INV = [['roles'], ['changes'], ['setup-status']]

export function RoleTypeBadges({ r }: { r: RoleRow }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {r.is_system ? <Badge size="sm">Built-in</Badge> : <Badge tone="brand" size="sm">Custom</Badge>}
      {!r.active && <Badge tone="danger" size="sm">Inactive</Badge>}
      {r.pending && <Badge tone="warning" size="sm">Pending approval</Badge>}
    </span>
  )
}

export default function RolesPage() {
  const q = useRoles()
  const c = useCan()
  const readOnly = useReadOnly()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') === 'compare' ? 'compare' : 'roles') as 'roles' | 'compare'
  const [creating, setCreating] = useState<string | null | false>(false)
  const { confirm } = useConfirm()
  const canManage = c('roles.manage') && !readOnly

  const clone = useMut((r: RoleRow) => accessApi.cloneRole(r.key), {
    invalidate: INV,
    onSuccess: (res) => {
      announceNamed(res, 'Role duplicated')
      if (!isPending(res)) nav(`/setup/roles/${res.result.key}`)
    },
  })
  const del = useMut((r: RoleRow) => accessApi.deleteRole(r.key), { invalidate: INV, onSuccess: (res) => announceNamed(res, 'Role deleted') })

  const roles = q.data ?? []
  const cols: Column<RoleRow>[] = [
    {
      key: 'name',
      header: 'Role',
      sortValue: (r) => r.name,
      cell: (r) => (
        <span className="block min-w-0 max-w-[420px]">
          <span className="block truncate font-medium text-ink">{r.name}</span>
          <span className="block truncate text-[12.5px] text-ink-3">{r.description || '—'}</span>
        </span>
      ),
    },
    { key: 'home', header: 'Home', sortValue: (r) => PERSONA_LABEL[r.persona], cell: (r) => <span className="whitespace-nowrap text-ink-2">{PERSONA_LABEL[r.persona]}</span>, hideBelow: 'xl' },
    { key: 'perms', header: 'Permissions', align: 'right', sortValue: (r) => r.permissions.length, cell: (r) => <span className="tnum">{r.permissions.length}</span> },
    { key: 'people', header: 'People', align: 'right', sortValue: (r) => r.user_count, cell: (r) => <span className="tnum">{r.user_count}</span> },
    { key: 'type', header: 'Type', cell: (r) => <RoleTypeBadges r={r} />, hideBelow: 'lg' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '52px',
      cell: (r) =>
        canManage ? (
          <span onClick={(e) => e.stopPropagation()} className="inline-flex">
            <Menu
              label={`Actions for ${r.name}`}
              trigger={
                <IconButton size="sm" variant="ghost" label="More">
                  <MoreHorizontal className="size-4" />
                </IconButton>
              }
              items={[
                { label: 'Open', icon: <UserCog />, onSelect: () => nav(`/setup/roles/${r.key}`) },
                { label: 'Duplicate', icon: <Copy />, onSelect: () => clone.mutate(r) },
                ...(!r.is_system
                  ? [
                      { separator: true, label: '' },
                      {
                        label: 'Delete role',
                        icon: <Trash2 />,
                        danger: true,
                        disabled: r.user_count > 0,
                        hint: r.user_count > 0 ? 'In use' : undefined,
                        onSelect: async () => (await confirm({ title: `Delete ${r.name}?`, body: 'Nobody holds this role. Deleting it can’t be undone.', confirmLabel: 'Delete role', tone: 'danger' })) && del.mutate(r),
                      },
                    ]
                  : []),
              ]}
            />
          </span>
        ) : null,
    },
  ]

  return (
    <div>
      <PageHeader
        title="Roles & permissions"
        subtitle="A role bundles what people can see and do. Give someone extra permissions on top of their role from People."
        actions={
          canManage && (
            <Button variant="primary" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(null)}>
              New role
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(v) => {
          if (v === 'compare') params.set('tab', 'compare')
          else params.delete('tab')
          setParams(params, { replace: true })
        }}
        tabs={[
          { value: 'roles', label: 'Roles', count: roles.length },
          { value: 'compare', label: 'Compare roles' },
        ]}
      />
      {tab === 'roles' ? (
        <DataTable
          rows={roles}
          columns={cols}
          rowKey={(r) => r.key}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => q.refetch()}
          onRowClick={(r) => nav(`/setup/roles/${r.key}`)}
          rowClassName={(r) => (!r.active ? 'opacity-60' : undefined)}
          empty={<EmptyState compact icon={<UserCog />} title="No roles yet" />}
          mobileCard={(r) => (
            <div className="min-w-0">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-[14px] font-semibold">{r.name}</span>
                <span className="tnum shrink-0 text-[12.5px] text-ink-3">
                  {r.user_count} {r.user_count === 1 ? 'person' : 'people'}
                </span>
              </div>
              {r.description && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{r.description}</p>}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <RoleTypeBadges r={r} />
                <span className="text-[12px] text-ink-3">
                  {r.permissions.length} permissions · {PERSONA_LABEL[r.persona]}
                </span>
              </div>
            </div>
          )}
        />
      ) : (
        <CompareRoles roles={roles} loading={q.isLoading} />
      )}
      {creating !== false && <NewRoleDialog roles={roles} copyFrom={creating} onClose={() => setCreating(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
function NewRoleDialog({ roles, copyFrom, onClose }: { roles: RoleRow[]; copyFrom: string | null; onClose: () => void }) {
  const nav = useNavigate()
  const [f, setF] = useState({ name: '', description: '', persona: 'employee' as Role, copy_from: copyFrom ?? 'employee' })
  const src = roles.find((r) => r.key === f.copy_from)
  const m = useMut(
    () => accessApi.createRole({ name: f.name.trim(), description: f.description.trim(), persona: f.persona, permissions: src ? src.permissions : [], copy_from: f.copy_from || null }),
    {
      invalidate: INV,
      onSuccess: (res) => {
        announceNamed(res, `${f.name.trim()} created`)
        onClose()
        if (!isPending(res)) nav(`/setup/roles/${res.result.key}`)
      },
    },
  )
  const e = m.error
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="New role"
      description="Start from an existing role and adjust its permissions next."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} disabled={f.name.trim().length < 2} onClick={() => m.mutate(undefined)}>
            Create role
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {e && !e.field && <Callout tone="danger">{e.message}</Callout>}
        <Field label="Name" htmlFor="r-name" required error={errField(e, 'name')}>
          <Input id="r-name" autoFocus value={f.name} onChange={(ev) => setF({ ...f, name: ev.target.value })} placeholder="e.g. Finance Executive" invalid={!!errField(e, 'name')} />
        </Field>
        <Field label="Description" htmlFor="r-desc" hint="One line about who this role is for.">
          <Textarea id="r-desc" rows={2} value={f.description} onChange={(ev) => setF({ ...f, description: ev.target.value })} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start from" htmlFor="r-from" hint={src ? `${src.permissions.length} permissions copied` : 'No permissions — add them next'}>
            <Select
              id="r-from"
              value={f.copy_from}
              onChange={(ev) => {
                const r = roles.find((x) => x.key === ev.target.value)
                setF({ ...f, copy_from: ev.target.value, persona: r?.persona ?? f.persona })
              }}
              options={[{ value: '', label: 'Blank role' }, ...roles.filter((r) => r.active).map((r) => ({ value: r.key, label: r.name }))]}
            />
          </Field>
          <Field label="Home & default views" htmlFor="r-persona" error={errField(e, 'persona')}>
            <Select id="r-persona" value={f.persona} onChange={(ev) => setF({ ...f, persona: ev.target.value as Role })} options={PERSONA_OPTIONS} />
          </Field>
        </div>
      </div>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
function CompareRoles({ roles, loading }: { roles: RoleRow[]; loading: boolean }) {
  const [q, setQ] = useState('')
  const [diffOnly, setDiffOnly] = useState(false)
  const [showInactive, setShowInactive] = useState(false)
  const cols = roles.filter((r) => showInactive || r.active)
  const sets = useMemo(() => new Map(cols.map((r) => [r.key, new Set(r.permissions)])), [cols])
  const s = q.trim().toLowerCase()
  const groups = MODULE_ORDER.map((m) => ({
    m,
    perms: (PERMISSIONS as readonly PermissionDef[]).filter((p) => {
      if (p.module !== m) return false
      if (s && !`${p.label} ${p.key}`.toLowerCase().includes(s)) return false
      if (diffOnly) {
        const n = cols.filter((r) => sets.get(r.key)!.has(p.key)).length
        if (n === 0 || n === cols.length) return false
      }
      return true
    }),
  })).filter((g) => g.perms.length)
  if (loading) return <div className="skeleton h-64 rounded-lg" />
  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <SearchInput value={q} onChange={setQ} placeholder="Search permissions" className="sm:w-[260px] sm:shrink-0" />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <Switch checked={diffOnly} onChange={setDiffOnly} /> Only differences
          </label>
          {roles.some((r) => !r.active) && (
            <label className="flex items-center gap-2 text-[13px] text-ink-2">
              <Switch checked={showInactive} onChange={setShowInactive} /> Inactive roles
            </label>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="max-h-[70vh] overflow-auto scroll-thin">
          <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 min-w-[180px] max-w-[240px] border-b border-r border-line bg-surface-2 px-3 py-2 text-left text-[11.5px] font-medium uppercase tracking-[0.04em] text-ink-3 sm:min-w-[260px]">Permission</th>
                {cols.map((r) => (
                  <th key={r.key} className="sticky top-0 z-10 w-[92px] min-w-[92px] border-b border-line bg-surface-2 px-2 py-2 text-center align-bottom text-[12px] font-medium leading-tight text-ink-2">
                    <span className="line-clamp-2 break-words">{r.name}</span>
                    <span className="tnum mt-0.5 block text-[11px] font-normal text-ink-3">{r.permissions.length}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.m}>
                  <tr>
                    <td className="sticky left-0 z-[5] border-b border-line bg-surface px-3 pb-1.5 pt-3 text-[12.5px] font-semibold text-ink">{MODULE_LABEL[g.m]}</td>
                    <td colSpan={cols.length} className="border-b border-line bg-surface" />
                  </tr>
                  {g.perms.map((p) => (
                    <tr key={p.key} className="group">
                      <td className="sticky left-0 z-[5] max-w-[240px] border-b border-r border-line bg-surface px-3 py-2 group-hover:bg-surface-2">
                        <span className="block truncate text-ink-2" title={p.description}>{p.label}</span>
                      </td>
                      {cols.map((r) => {
                        const on = sets.get(r.key)!.has(p.key)
                        return (
                          <td key={r.key} className={cn('border-b border-line px-2 py-2 text-center group-hover:bg-surface-2')}>
                            {on ? <Check className="mx-auto size-4 text-brand-text" aria-label="Yes" /> : <span className="text-ink-3/60" aria-label="No">–</span>}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
              {!groups.length && (
                <tr>
                  <td colSpan={cols.length + 1} className="px-4 py-10 text-center text-ink-3">
                    {diffOnly ? 'These roles agree on every permission that matches.' : 'No permission matches your search.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
