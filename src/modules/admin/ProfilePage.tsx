import { useEffect, useMemo, useState } from 'react'
import { Laptop, Moon, Sun } from '@/ui/icons'
import { authApi, usePeopleMap } from '@/api/core'
import { useMut } from '@/api/query'
import { adminApi } from '@/api/admin'
import { useSession } from '@/stores/session'
import { ROLE_LABEL } from '@/domain/permissions'
import { fmtDate } from '@/domain/calendar'
import { applyTheme } from '@/theme/theme'
import { DEFAULT_THEME } from '@/mock/seed'
import { Avatar, Input, PageHeader, Segmented, useReadOnly } from '@/ui'
import type { User } from '@/types/entities'
import { cn } from '@/lib/utils'
import { SaveBar, SettingRow, SettingsCard, errField } from './kit'

const HUES = [152, 200, 210, 250, 280, 320, 0, 18, 35, 45, 90, 175]

export default function ProfilePage() {
  const { user, tenant, patchUser } = useSession()
  const readOnly = useReadOnly()
  const people = usePeopleMap()
  const init = useMemo(() => ({ name: user?.name ?? '', title: user?.title ?? '', phone: user?.phone ?? '', hue: user?.avatar_hue ?? 150 }), [user?.name, user?.title, user?.phone, user?.avatar_hue])
  const [f, setF] = useState(init)
  useEffect(() => setF(init), [init])
  const dirty = f.name !== init.name || f.title !== init.title || f.phone !== init.phone || f.hue !== init.hue

  const save = useMut(
    async () => {
      let u: User = await authApi.profile({ name: f.name.trim(), title: f.title.trim(), phone: f.phone.trim() || null })
      if (f.hue !== init.hue) u = await adminApi.avatar(f.hue)
      return u
    },
    { success: 'Profile saved', invalidate: [['directory'], ['me']], onSuccess: (u) => patchUser(u) },
  )
  const mode = useMut((m: 'system' | 'light' | 'dark') => authApi.prefs({ theme_mode: m }), {
    success: 'Appearance updated',
    onSuccess: (u) => patchUser({ prefs: u.prefs }),
  })

  if (!user) return null
  const phoneErr = f.phone && !/^\+?[\d\s-]{8,16}$/.test(f.phone) ? 'Use digits, spaces or dashes, e.g. +91 90907 05533.' : null
  const nameErr = f.name.trim().length < 2 ? 'Enter your name.' : errField(save.error, 'name')
  const manager = people.get(user.reports_to_id)

  return (
    <div className="pb-24">
      <PageHeader title="My profile" subtitle="How you appear to your team across SeereonOS." />
      <div className="mb-6 flex items-center gap-4 rounded-lg border border-line bg-surface px-4 py-3.5 md:px-5">
        <Avatar name={f.name || user.name} hue={f.hue} size={48} />
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold">{f.name || user.name}</div>
          <div className="truncate text-[13.5px] text-ink-3">{f.title || 'No title yet'}</div>
          <div className="mt-1 truncate text-[12.5px] text-ink-3">{user.is_super_admin ? 'Platform administrator' : `${user.role_name ?? ROLE_LABEL[user.role]} · ${tenant?.name ?? ''}`}</div>
        </div>
      </div>

      <SettingsCard title="Personal details">
        <SettingRow label="Full name" error={nameErr}>
          <Input value={f.name} disabled={readOnly} onChange={(e) => setF({ ...f, name: e.target.value })} invalid={!!nameErr} autoComplete="name" />
        </SettingRow>
        <SettingRow label="Job title" help="Shown next to your name in pickers and the team page.">
          <Input value={f.title} disabled={readOnly} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Senior MERN Developer" />
        </SettingRow>
        <SettingRow label="Phone" help="Optional. Visible to admins only." error={phoneErr}>
          <Input value={f.phone} disabled={readOnly} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91" invalid={!!phoneErr} autoComplete="tel" />
        </SettingRow>
        <SettingRow label="Avatar colour" help="Your initials sit on this colour." stack>
          <div className="flex flex-wrap gap-2">
            {HUES.map((h) => (
              <button
                key={h}
                type="button"
                disabled={readOnly}
                onClick={() => setF({ ...f, hue: h })}
                aria-label={`Hue ${h}`}
                aria-pressed={f.hue === h}
                className={cn('grid size-9 place-items-center rounded-full ring-offset-2 ring-offset-surface transition', f.hue === h && 'ring-2 ring-brand')}
              >
                <Avatar name={f.name || user.name} hue={h} size={32} />
              </button>
            ))}
          </div>
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Work" subtitle="Set by your admin.">
        <SettingRow label="Email">
          <div className="truncate text-[14px] text-ink-2 sm:text-right">{user.email}</div>
        </SettingRow>
        {!user.is_super_admin && (
          <>
            <SettingRow label="Role">
              <div className="text-[14px] text-ink-2 sm:text-right">{user.role_name ?? ROLE_LABEL[user.role]}</div>
            </SettingRow>
            <SettingRow label="Reports to" help="Approves your timesheets.">
              <div className="text-[14px] text-ink-2 sm:text-right">{manager?.name ?? 'No one — your weeks are auto-approved'}</div>
            </SettingRow>
            <SettingRow label="Joined">
              <div className="text-[14px] text-ink-2 sm:text-right">{fmtDate(user.joined_on, 'long')}</div>
            </SettingRow>
          </>
        )}
      </SettingsCard>

      <SettingsCard title="My appearance" subtitle="Only changes how SeereonOS looks for you.">
        <SettingRow label="Theme" help="System follows your device’s light or dark setting.">
          <Segmented
            value={user.prefs?.theme_mode ?? 'system'}
            onChange={(m) => {
              applyTheme(tenant?.theme ?? DEFAULT_THEME, m)
              mode.mutate(m)
            }}
            options={[
              { value: 'system', label: <span className="flex items-center gap-1.5"><Laptop className="size-3.5" />System</span> },
              { value: 'light', label: <span className="flex items-center gap-1.5"><Sun className="size-3.5" />Light</span> },
              { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon className="size-3.5" />Dark</span> },
            ]}
          />
        </SettingRow>
      </SettingsCard>

      <SaveBar dirty={dirty && !readOnly} saving={save.isPending} onDiscard={() => setF(init)} onSave={() => !nameErr && !phoneErr && save.mutate(undefined)} />
    </div>
  )
}
