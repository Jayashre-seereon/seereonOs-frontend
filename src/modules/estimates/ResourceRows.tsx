// Resource rows of an estimate: a named person (CTC from cost rates, shown only with the salaries permission) or a
// role placeholder with an assumed monthly CTC (people not hired yet). Milestone, % and dates are required like the
// create-project calculator; From/To default to the milestone's dates. Every number comes from the server preview.
import { User, Users, X } from '@/ui/icons'
import { useDirectory } from '@/api/core'
import type { EstimatePreview } from '@/api/estimates'
import { fmtMoney, fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Button, IconButton, Input, MoneyInput, Segmented, Select } from '@/ui'
import { newKey } from '@/modules/projects/costing/costingDraft'
import type { EstRow } from './estimateDraft'

const HEAD = 'text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3'
const LBL = 'mb-1 block text-[12px] font-medium text-ink-3 @min-[1040px]:hidden'
const GRID = '@min-[1040px]:grid-cols-[118px_minmax(150px,1fr)_76px_70px_132px_132px_50px_58px_82px_92px_36px]'

export function ResourceRows({ rows, onChange, preview, errors, readOnly, canName = true }: { rows: EstRow[]; onChange: (rows: EstRow[]) => void; preview: EstimatePreview | undefined; errors: Record<string, string>; readOnly?: boolean; /** salary access: without it only role placeholders */ canName?: boolean }) {
  const dir = useDirectory()
  const people = (dir.data ?? []).filter((p) => p.status === 'active').sort((a, b) => a.name.localeCompare(b.name))
  const ms = preview?.milestones ?? []
  const set = (key: string, patch: Partial<EstRow>) => onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const add = (kind: EstRow['kind']) => onChange([...rows, { key: newKey('r'), kind, user_id: null, role_label: '', ctc_paise: 0, ms: ms.length ? '0' : '', pct: '100', from_on: null, to_on: null }])
  const t = preview?.totals
  return (
    <div className="@container">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <p className="min-w-0 flex-1 basis-[260px] text-[12.5px] leading-relaxed text-ink-3">
          Pick a person for people you have, or a role with an assumed monthly CTC for people you would hire. Each row lands on a milestone; From and To follow that milestone unless you change them.
        </p>
        {t && <span className="tnum whitespace-nowrap text-[12.5px] text-ink-3">{fmtNum(t.man_days, 1)} man-days · {fmtMoney(t.resources)}</span>}
      </div>
      {rows.length > 0 && (
        <div className={cn('hidden gap-2 border-b border-line pb-2 @min-[1040px]:grid', GRID)}>
          <span className={HEAD}>Type</span>
          <span className={HEAD}>Resource</span>
          <span className={HEAD}>Milestone *</span>
          <span className={HEAD}>Alloc. %</span>
          <span className={HEAD}>From *</span>
          <span className={HEAD}>To *</span>
          <span className={cn(HEAD, 'text-right')}>Days</span>
          <span className={cn(HEAD, 'text-right')}>Man-days</span>
          <span className={cn(HEAD, 'text-right')}>Cost/day</span>
          <span className={cn(HEAD, 'text-right')}>Cost</span>
          <span />
        </div>
      )}
      <ul className="divide-y divide-line">
        {rows.map((r, i) => {
          const v = preview?.rows[i]?.key === r.key ? preview.rows[i] : undefined
          const e = (f: string) => errors[`resources.${i}.${f}`]
          const rowErr = e('user_id') || e('role_label') || e('monthly_ctc_paise') || e('milestone_id') || e('pct') || e('from_on') || e('to_on') || v?.error
          const soft = !!v?.error && v.error.includes('no cost rate')
          const fromVal = r.from_on ?? v?.from_on ?? ''
          const toVal = r.to_on ?? v?.to_on ?? ''
          const hidden = r.kind === 'person' && !preview?.can_see_rates
          return (
            <li key={r.key} className="py-2.5 @min-[1040px]:py-2">
              <div className={cn('grid grid-cols-2 items-center gap-2 @min-[560px]:grid-cols-4', GRID)}>
                <div className="min-w-0">
                  <span className={LBL}>Type</span>
                  <Segmented
                    size="sm"
                    block
                    value={r.kind}
                    onChange={(k) => !readOnly && set(r.key, { kind: k, user_id: k === 'person' ? r.user_id : null })}
                    options={canName || r.kind === 'person' ? [{ value: 'person', label: 'Person' }, { value: 'role', label: 'Role' }] : [{ value: 'role', label: 'Role' }]}
                  />
                </div>
                <div className="flex justify-end self-end @min-[560px]:col-span-3 @min-[1040px]:order-last @min-[1040px]:col-span-1 @min-[1040px]:self-center">
                  {!readOnly && (
                    <IconButton label={`Remove row ${i + 1}`} size="sm" onClick={() => onChange(rows.filter((x) => x.key !== r.key))}>
                      <X className="size-4" />
                    </IconButton>
                  )}
                </div>
                <div className="col-span-2 min-w-0 @min-[560px]:col-span-4 @min-[1040px]:col-span-1">
                  <span className={LBL}>{r.kind === 'person' ? 'Person' : 'Role and assumed monthly CTC'}</span>
                  {r.kind === 'person' ? (
                    <Select
                      aria-label={`Row ${i + 1} person`}
                      value={r.user_id ?? ''}
                      disabled={readOnly}
                      invalid={!!e('user_id')}
                      placeholder="Choose a person"
                      onChange={(ev) => set(r.key, { user_id: ev.target.value || null })}
                      options={people.map((p) => ({ value: p.id, label: p.name }))}
                    />
                  ) : (
                    <div className="grid grid-cols-[minmax(0,1fr)_112px] gap-2">
                      <Input aria-label={`Row ${i + 1} role`} value={r.role_label} disabled={readOnly} invalid={!!e('role_label')} placeholder="e.g. Senior React developer" onChange={(ev) => set(r.key, { role_label: ev.target.value })} />
                      <MoneyInput value={r.ctc_paise} disabled={readOnly} invalid={!!e('monthly_ctc_paise')} placeholder="CTC/month" onChange={(p) => set(r.key, { ctc_paise: p })} />
                    </div>
                  )}
                </div>
                <label className="min-w-0">
                  <span className={LBL}>Milestone *</span>
                  <Select aria-label={`Row ${i + 1} milestone`} value={r.ms} disabled={readOnly} invalid={!!e('milestone_id')} placeholder="—" onChange={(ev) => set(r.key, { ms: ev.target.value, from_on: null, to_on: null })} options={ms.map((m) => ({ value: String(m.index), label: m.code }))} />
                </label>
                <label className="min-w-0">
                  <span className={LBL}>Alloc. %</span>
                  <Input aria-label={`Row ${i + 1} allocation`} type="number" inputMode="numeric" min={1} max={100} step={5} value={r.pct} disabled={readOnly} invalid={!!e('pct')} onChange={(ev) => set(r.key, { pct: ev.target.value })} className="tnum" />
                </label>
                <label className="min-w-0">
                  <span className={LBL}>From *</span>
                  <Input aria-label={`Row ${i + 1} from`} type="date" value={fromVal} disabled={readOnly} invalid={!!e('from_on')} onChange={(ev) => set(r.key, { from_on: ev.target.value || null })} className="tnum" />
                </label>
                <label className="min-w-0">
                  <span className={LBL}>To *</span>
                  <Input aria-label={`Row ${i + 1} to`} type="date" value={toVal} min={fromVal || undefined} disabled={readOnly} invalid={!!e('to_on')} onChange={(ev) => set(r.key, { to_on: ev.target.value || null })} className="tnum" />
                </label>
                <Num label="Working days" value={v ? fmtNum(v.working_days) : '—'} />
                <Num label="Man-days" value={v ? fmtNum(v.man_days, 1) : '—'} />
                <Num label="Cost/day" value={hidden ? 'Private' : v && v.cost_per_day !== null ? fmtMoney(v.cost_per_day) : '—'} muted={hidden} />
                <Num label="Cost" strong value={hidden ? 'Private' : v && v.cost !== null ? fmtMoney(v.cost) : '—'} muted={hidden} />
              </div>
              {rowErr && <p className={cn('mt-1 text-[12.5px] font-medium', soft && !e('user_id') ? 'text-warning-text' : 'text-danger-text')}>{rowErr}</p>}
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && <p className="rounded-md border border-dashed border-line-strong px-3 py-4 text-center text-[13px] text-ink-3">No resources yet. Add the people you have, or roles you would hire.</p>}
      {preview && !preview.can_see_rates && preview.named_rows > 0 && (
        <p className="mt-2 text-[12.5px] text-ink-3">Cost of named people is private to the salaries permission; their cost is included in the totals.</p>
      )}
      {!canName && !readOnly && <p className="mt-2 text-[12.5px] text-ink-3">Named people need salary access — use a role with an assumed CTC; a PM or the CEO can assign people later.</p>}
      {!readOnly && (
        <div className="mt-2 flex flex-wrap gap-2">
          {canName && (
            <Button size="sm" icon={<User className="size-4" />} onClick={() => add('person')}>
              Add person
            </Button>
          )}
          <Button size="sm" icon={<Users className="size-4" />} onClick={() => add('role')}>
            Add role placeholder
          </Button>
        </div>
      )}
    </div>
  )
}

function Num({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="min-w-0 @min-[1040px]:text-right">
      <span className={LBL}>{label}</span>
      <span className={cn('tnum block whitespace-nowrap text-[13px]', muted ? 'text-ink-3' : strong ? 'font-medium text-ink' : 'text-ink-2')}>{value}</span>
    </div>
  )
}
