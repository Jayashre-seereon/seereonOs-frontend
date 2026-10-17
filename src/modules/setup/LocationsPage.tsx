import { useState } from 'react'
import type { Location } from '@/types/access'
import { INDIAN_STATES } from '@/api/master'
import { Badge, Checkbox, Field, Input, Select } from '@/ui'
import { InactiveBadge, MasterListPage, PeopleCount, RecordDialog, errOf, useSaveRecord } from './master/kit'

const ZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'UTC']

export default function LocationsPage() {
  return (
    <MasterListPage
      type="locations"
      title="Locations"
      subtitle="Offices and client sites people work from. The head office address goes on letters and payslips."
      addLabel="Add location"
      emptyBody="Add your head office first, then any branch or client site where people are based."
      order={(r) => [...r].sort((a, b) => Number(b.is_head_office) - Number(a.is_head_office) || a.name.localeCompare(b.name))}
      matches={(r, q) => [r.name, r.code, r.city, r.state].some((x) => x.toLowerCase().includes(q))}
      columns={(usage) => [
        {
          key: 'name',
          header: 'Location',
          sortValue: (r) => r.name,
          cell: (r) => (
            <div className="flex min-w-0 items-center gap-2">
              <div className="min-w-0">
                <div className="truncate font-medium text-ink">{r.name}</div>
                <div className="truncate text-[12.5px] text-ink-3">{r.address || 'No address yet'}</div>
              </div>
              {r.is_head_office && <Badge size="sm" tone="brand">Head office</Badge>}
              {!r.active && <InactiveBadge />}
            </div>
          ),
        },
        { key: 'code', header: 'Code', sortValue: (r) => r.code, cell: (r) => <span className="font-mono text-[12.5px] text-ink-2">{r.code}</span> },
        { key: 'city', header: 'City', sortValue: (r) => r.city, cell: (r) => <span className="whitespace-nowrap">{[r.city, r.state].filter(Boolean).join(', ') || '—'}</span>, hideBelow: 'lg' },
        { key: 'cal', header: 'Holiday calendar', cell: (r) => <span className="text-ink-2">{r.holiday_calendar}</span>, hideBelow: 'xl' },
        { key: 'people', header: 'People', align: 'right', sortValue: (r) => usage[r.id] ?? 0, cell: (r) => <PeopleCount n={usage[r.id]} /> },
      ]}
      mobileCard={(r, usage) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[14px] font-medium">{r.name}</span>
            {r.is_head_office && <Badge size="sm" tone="brand">Head office</Badge>}
            {!r.active && <InactiveBadge />}
          </div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-3">
            {r.code} · {[r.city, r.state].filter(Boolean).join(', ') || 'No city'}
          </div>
          <div className="mt-1.5">
            <PeopleCount n={usage[r.id]} />
          </div>
        </div>
      )}
      renderDialog={(row, close) => <LocationDialog row={row} onClose={close} />}
    />
  )
}

function LocationDialog({ row, onClose }: { row: Location | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: row?.name ?? '', code: row?.code ?? '', address: row?.address ?? '', city: row?.city ?? '', state: row?.state ?? '',
    timezone: row?.timezone ?? 'Asia/Kolkata', holiday_calendar: row?.holiday_calendar ?? 'Company holidays', is_head_office: row?.is_head_office ?? false,
  })
  const m = useSaveRecord('locations', row, onClose)
  const e = m.error
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  const states = f.state && !INDIAN_STATES.includes(f.state) ? [f.state, ...INDIAN_STATES] : INDIAN_STATES
  return (
    <RecordDialog title={row ? `Edit ${row.name}` : 'Add location'} onClose={onClose} onSave={() => m.mutate(f)} saving={m.isPending} saveLabel={row ? 'Save' : 'Add location'}>
      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <Field label="Name" htmlFor="loc-name" required error={errOf(e, 'name')}>
          <Input id="loc-name" value={f.name} onChange={(x) => set('name', x.target.value)} placeholder="e.g. Bhubaneswar HQ" invalid={!!errOf(e, 'name')} />
        </Field>
        <Field label="Code" htmlFor="loc-code" required error={errOf(e, 'code')}>
          <Input id="loc-code" value={f.code} onChange={(x) => set('code', x.target.value.toUpperCase())} placeholder="BBS" maxLength={12} invalid={!!errOf(e, 'code')} />
        </Field>
      </div>
      <Field label="Address" htmlFor="loc-addr" error={errOf(e, 'address')}>
        <Input id="loc-addr" value={f.address} onChange={(x) => set('address', x.target.value)} placeholder="Building, street, area" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="City" htmlFor="loc-city">
          <Input id="loc-city" value={f.city} onChange={(x) => set('city', x.target.value)} />
        </Field>
        <Field label="State" htmlFor="loc-state">
          <Select id="loc-state" value={f.state} onChange={(x) => set('state', x.target.value)} placeholder="Choose a state" options={states} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Time zone" htmlFor="loc-tz">
          <Select id="loc-tz" value={f.timezone} onChange={(x) => set('timezone', x.target.value)} options={ZONES.includes(f.timezone) ? ZONES : [f.timezone, ...ZONES]} />
        </Field>
        <Field label="Holiday calendar" htmlFor="loc-cal" hint="Name of the calendar people here follow.">
          <Input id="loc-cal" value={f.holiday_calendar} onChange={(x) => set('holiday_calendar', x.target.value)} />
        </Field>
      </div>
      <Checkbox
        checked={f.is_head_office}
        disabled={!!row?.is_head_office}
        onChange={(v) => set('is_head_office', v)}
        label="Head office"
        description={row?.is_head_office ? 'This is the head office. To change it, mark another location as head office.' : 'Its address is used on letters and payslips. Only one location can be the head office.'}
      />
      {errOf(e, 'is_head_office') && <p className="text-[12.5px] font-medium text-danger-text">{errOf(e, 'is_head_office')}</p>}
    </RecordDialog>
  )
}
