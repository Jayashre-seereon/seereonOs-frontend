// Role detail: granular permission matrix, members and role details. Saves go through maker-checker.
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Copy, Trash2, Users } from '@/ui/icons'
import { useMut } from '@/api/query'
import { accessApi, useRole } from '@/api/access'
import { changesApi, isPending } from '@/api/changes'
import { LOCKED_PERMISSIONS, PERSONA_LABEL } from '@/domain/permissionCatalog'
import { relTime } from '@/domain/calendar'
import type { Role } from '@/types/entities'
import { Avatar, Badge, Button, Callout, EmptyState, ErrorState, Field, Input, ListGroup, PageHeader, Select, SkeletonRows, Switch, Tabs, Textarea, useCan, useConfirm, useReadOnly } from '@/ui'
import { SaveBar, errField } from '../admin/kit'
import { PermissionMatrix } from '../access/PermissionMatrix'
import { PendingBanner, announceNamed } from '../access/kit'
import { PERSONA_OPTIONS, RoleTypeBadges } from './RolesPage'

type Tab = 'permissions' | 'members' | 'details'
interface Draft {
  name: string
  description: string
  persona: Role
  active: boolean
  permissions: string[]
}

export default function RoleDetailPage() {
  const { key = '' } = useParams()
  const q = useRole(key)
  const c = useCan()
  const readOnly = useReadOnly()
  const nav = useNavigate()
  const { confirm } = useConfirm()
  const [tab, setTab] = useState<Tab>('permissions')
  const role = q.data
  const init: Draft | null = useMemo(() => (role ? { name: role.name, description: role.description, persona: role.persona, active: role.active, permissions: [...role.permissions].sort() } : null), [role])
  const [d, setD] = useState<Draft | null>(init)
  useEffect(() => setD(init), [init])

  const inv = [['roles'], ['changes'], ['setup-status'], ['users'], ['directory']]
  const save = useMut(() => accessApi.updateRole(key, d!, role!.version), { invalidate: inv, onSuccess: (r) => announceNamed(r, 'Role saved') })
  const clone = useMut(() => accessApi.cloneRole(key), {
    invalidate: inv,
    onSuccess: (r) => {
      announceNamed(r, 'Role duplicated')
      if (!isPending(r)) nav(`/setup/roles/${r.result.key}`)
    },
  })
  const del = useMut(() => accessApi.deleteRole(key), {
    invalidate: inv,
    onSuccess: (r) => {
      announceNamed(r, 'Role deleted')
      if (!isPending(r)) nav('/setup/roles')
    },
  })
  const withdraw = useMut((id: string) => changesApi.withdraw(id), { invalidate: inv, success: 'Change withdrawn' })

  if (q.isLoading || (!d && !q.error)) return <SkeletonRows rows={8} />
  if (q.error || !role || !d) return <ErrorState error={q.error} onRetry={() => q.refetch()} />

  const canEdit = c('roles.manage') && !readOnly && !role.pending
  const before = new Set(role.permissions)
  const after = new Set(d.permissions)
  const plus = d.permissions.filter((k) => !before.has(k)).length
  const minus = role.permissions.filter((k) => !after.has(k)).length
  const metaDirty = d.name !== role.name || d.description !== role.description || d.persona !== role.persona || d.active !== role.active
  const dirty = plus + minus > 0 || metaDirty
  const changeLabel = [plus ? `+${plus}` : '', minus ? `−${minus}` : ''].filter(Boolean).join(' / ')
  const isAdmin = role.key === 'administrator'

  return (
    <div className="pb-24">
      <PageHeader
        eyebrow={
          <Link to="/setup/roles" className="hover:text-ink hover:underline">
            Roles & permissions
          </Link>
        }
        title={role.name}
        subtitle={role.description || undefined}
        meta={
          <>
            <RoleTypeBadges r={role} />
            <span className="text-[12.5px] text-ink-3">
              {role.permissions.length} permissions · {role.user_count} {role.user_count === 1 ? 'person' : 'people'} · {PERSONA_LABEL[role.persona]}
            </span>
          </>
        }
        actions={
          c('roles.manage') &&
          !readOnly && (
            <Button size="sm" icon={<Copy className="size-3.5" />} loading={clone.isPending} onClick={() => clone.mutate(undefined)}>
              Duplicate
            </Button>
          )
        }
      />

      {role.pending && (
        <PendingBanner
          pending={role.pending}
          what="Your change to this role"
          action={
            role.pending.mine && !readOnly ? (
              <Button size="sm" variant="secondary" loading={withdraw.isPending} onClick={() => withdraw.mutate(role.pending!.id)}>
                Withdraw
              </Button>
            ) : undefined
          }
        />
      )}
      {isAdmin && <Callout tone="neutral" className="mb-4">Administrator always keeps role and user management, so there is always a way back in.</Callout>}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'permissions', label: 'Permissions', count: d.permissions.length },
          { value: 'members', label: 'People', count: role.members.length },
          { value: 'details', label: 'Details' },
        ]}
      />

      {tab === 'permissions' && (
        <PermissionMatrix
          value={d.permissions}
          onChange={canEdit ? (p) => setD({ ...d, permissions: p }) : undefined}
          disabled={!canEdit}
          locked={isAdmin ? [...LOCKED_PERMISSIONS] : []}
          lockedNote="Always on"
        />
      )}

      {tab === 'members' && (
        <>
          {role.members.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState compact icon={<Users />} title="Nobody holds this role" body="Assign it from People, or when you create an employee." action={c('employees.create') && <Link to="/people/new" className="text-[13.5px] font-medium text-brand-text hover:underline">Create employee</Link>} />
            </div>
          ) : (
            <ListGroup>
              {role.members.map((m) => {
                const overrides = m.extra_permissions.length + m.revoked_permissions.length
                const inner = (
                  <>
                    <Avatar name={m.name} hue={m.avatar_hue} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-[14px] font-medium text-ink">{m.name}</span>
                        {m.status === 'deactivated' && <Badge size="sm">Deactivated</Badge>}
                      </span>
                      <span className="block truncate text-[12.5px] text-ink-3">
                        {m.title || m.email}
                        {overrides > 0 && ` · ${[m.extra_permissions.length && `+${m.extra_permissions.length} extra`, m.revoked_permissions.length && `−${m.revoked_permissions.length} removed`].filter(Boolean).join(', ')}`}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-[12.5px] text-ink-3 sm:block">{m.last_login_at ? relTime(m.last_login_at) : 'Never signed in'}</span>
                  </>
                )
                return c('users.view') ? (
                  <Link key={m.id} to={`/people?focus=${m.id}`} className="flex items-center gap-3 px-4 py-3 transition hover:bg-surface-2">
                    {inner}
                  </Link>
                ) : (
                  <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                    {inner}
                  </div>
                )
              })}
            </ListGroup>
          )}
        </>
      )}

      {tab === 'details' && (
        <div className="max-w-[640px] space-y-5">
          {save.error && !save.error.field && <Callout tone="danger">{save.error.message}</Callout>}
          <Field label="Name" htmlFor="rd-name" required error={errField(save.error, 'name')}>
            <Input id="rd-name" value={d.name} disabled={!canEdit} onChange={(e) => setD({ ...d, name: e.target.value })} invalid={!!errField(save.error, 'name')} />
          </Field>
          <Field label="Description" htmlFor="rd-desc">
            <Textarea id="rd-desc" rows={2} value={d.description} disabled={!canEdit} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </Field>
          <Field label="Home & default views" htmlFor="rd-persona" hint="Which dashboard people with this role land on. What they can do is decided by permissions only." error={errField(save.error, 'persona')}>
            <Select id="rd-persona" value={d.persona} disabled={!canEdit || isAdmin} onChange={(e) => setD({ ...d, persona: e.target.value as Role })} options={PERSONA_OPTIONS} />
          </Field>
          <div className="rounded-lg border border-line bg-surface px-4 py-3">
            <Switch
              checked={d.active}
              disabled={!canEdit || role.is_system}
              onChange={(v) => setD({ ...d, active: v })}
              label="Active"
              description={role.is_system ? 'Built-in roles are always active.' : role.user_count ? 'Move its people to another role before deactivating.' : 'Inactive roles can’t be assigned.'}
            />
          </div>
          {!role.is_system && c('roles.manage') && !readOnly && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">Delete role</div>
                <div className="text-[12.5px] text-ink-3">{role.user_count ? `${role.user_count} people hold it — move them first.` : 'Nobody holds this role. Deleting can’t be undone.'}</div>
              </div>
              <Button
                variant="outline-danger"
                size="sm"
                icon={<Trash2 className="size-3.5" />}
                disabled={role.members.length > 0 || !!role.pending}
                loading={del.isPending}
                onClick={async () => (await confirm({ title: `Delete ${role.name}?`, body: 'This can’t be undone.', confirmLabel: 'Delete role', tone: 'danger' })) && del.mutate(undefined)}
              >
                Delete role
              </Button>
            </div>
          )}
          {role.created_by_name && <p className="text-[12.5px] text-ink-3">Created by {role.created_by_name}.</p>}
        </div>
      )}

      <SaveBar dirty={dirty && canEdit} saving={save.isPending} onSave={() => save.mutate(undefined)} onDiscard={() => setD(init)} label={changeLabel ? `${changeLabel} permission ${plus + minus === 1 ? 'change' : 'changes'}${metaDirty ? ' and details' : ''}` : 'Unsaved role details'} />
    </div>
  )
}
