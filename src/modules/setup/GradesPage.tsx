import { useState } from 'react'
import type { Grade } from '@/types/access'
import { fmtMoneyCompact } from '@/domain/money'
import { Field, Input, MoneyInput } from '@/ui'
import { InactiveBadge, MasterListPage, PeopleCount, RecordDialog, errOf, useSaveRecord } from './master/kit'

function band(g: Grade) {
  if (g.min_ctc_paise == null && g.max_ctc_paise == null) return null
  if (g.max_ctc_paise == null) return `${fmtMoneyCompact(g.min_ctc_paise)}+`
  if (g.min_ctc_paise == null) return `Up to ${fmtMoneyCompact(g.max_ctc_paise)}`
  return `${fmtMoneyCompact(g.min_ctc_paise)} – ${fmtMoneyCompact(g.max_ctc_paise)}`
}
const lm = (n: number) => `×${Number(n.toFixed(2))}`

export default function GradesPage() {
  return (
    <MasterListPage
      type="grades"
      title="Grades & bands"
      subtitle="Levels with their annual CTC band. The leave multiplier scales leave entitlement for the grade."
      addLabel="Add grade"
      emptyBody="Add your levels (e.g. L1 Trainee to L6 Leadership) with the annual CTC range for each."
      order={(r) => [...r].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))}
      matches={(r, q) => [r.code, r.name].some((x) => x.toLowerCase().includes(q))}
      columns={(usage) => [
        {
          key: 'code',
          header: 'Grade',
          sortValue: (r) => r.code,
          cell: (r) => (
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="w-8 shrink-0 font-mono text-[12.5px] font-medium text-ink">{r.code}</span>
              <span className="truncate text-ink">{r.name}</span>
              {!r.active && <InactiveBadge />}
            </div>
          ),
        },
        { key: 'band', header: 'Annual CTC band', align: 'right', sortValue: (r) => r.min_ctc_paise ?? 0, cell: (r) => <span className="tnum whitespace-nowrap">{band(r) ?? <span className="text-ink-3">Not set</span>}</span> },
        { key: 'lm', header: 'Leave', align: 'right', sortValue: (r) => r.leave_multiplier, cell: (r) => <span className="tnum whitespace-nowrap text-ink-2">{lm(r.leave_multiplier)}</span> },
        { key: 'people', header: 'People', align: 'right', sortValue: (r) => usage[r.id] ?? 0, cell: (r) => <PeopleCount n={usage[r.id]} /> },
      ]}
      mobileCard={(r, usage) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[13px] font-medium">{r.code}</span>
            <span className="truncate text-[14px] font-medium">{r.name}</span>
            {!r.active && <InactiveBadge />}
          </div>
          <div className="tnum mt-0.5 text-[12.5px] text-ink-3">
            {band(r) ?? 'No CTC band'} · leave {lm(r.leave_multiplier)}
          </div>
          <div className="mt-1.5">
            <PeopleCount n={usage[r.id]} />
          </div>
        </div>
      )}
      renderDialog={(row, close) => <GradeDialog row={row} onClose={close} />}
    />
  )
}

function GradeDialog({ row, onClose }: { row: Grade | null; onClose: () => void }) {
  const [f, setF] = useState({ code: row?.code ?? '', name: row?.name ?? '', min_ctc_paise: row?.min_ctc_paise ?? 0, max_ctc_paise: row?.max_ctc_paise ?? 0, leave_multiplier: String(row?.leave_multiplier ?? 1) })
  const m = useSaveRecord('grades', row, onClose)
  const e = m.error
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }))
  return (
    <RecordDialog
      title={row ? `Edit ${row.code}` : 'Add grade'}
      onClose={onClose}
      onSave={() => m.mutate({ code: f.code, name: f.name, min_ctc_paise: f.min_ctc_paise || null, max_ctc_paise: f.max_ctc_paise || null, leave_multiplier: Number(f.leave_multiplier) })}
      saving={m.isPending}
      saveLabel={row ? 'Save' : 'Add grade'}
      size="sm"
    >
      <div className="grid grid-cols-[110px_1fr] gap-4">
        <Field label="Code" htmlFor="gr-code" required error={errOf(e, 'code')}>
          <Input id="gr-code" value={f.code} onChange={(x) => set('code', x.target.value.toUpperCase())} placeholder="L3" maxLength={8} invalid={!!errOf(e, 'code')} />
        </Field>
        <Field label="Name" htmlFor="gr-name" required error={errOf(e, 'name')}>
          <Input id="gr-name" value={f.name} onChange={(x) => set('name', x.target.value)} placeholder="Senior associate" invalid={!!errOf(e, 'name')} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minimum annual CTC" htmlFor="gr-min" error={errOf(e, 'min_ctc_paise')}>
          <MoneyInput id="gr-min" value={f.min_ctc_paise} onChange={(v) => set('min_ctc_paise', v)} invalid={!!errOf(e, 'min_ctc_paise')} />
        </Field>
        <Field label="Maximum annual CTC" htmlFor="gr-max" error={errOf(e, 'max_ctc_paise')} hint="Leave empty for no upper limit.">
          <MoneyInput id="gr-max" value={f.max_ctc_paise} onChange={(v) => set('max_ctc_paise', v)} invalid={!!errOf(e, 'max_ctc_paise')} />
        </Field>
      </div>
      <Field label="Leave multiplier" htmlFor="gr-lm" error={errOf(e, 'leave_multiplier')} hint="1 = standard leave. 1.2 gives 20% more days.">
        <Input id="gr-lm" type="number" inputMode="decimal" step="0.05" min="0.5" max="3" value={f.leave_multiplier} onChange={(x) => set('leave_multiplier', x.target.value)} className="sm:w-[140px]" invalid={!!errOf(e, 'leave_multiplier')} />
      </Field>
    </RecordDialog>
  )
}
