// Setup → Maker-checker: which sensitive changes need a second person, and who can check them.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ChangeEntity, MakerCheckerConfig } from '@/types/access'
import { announce, changesApi, CHANGE_INVALIDATE, isPending, type CheckerRow } from '@/api/changes'
import { useApi, useMut } from '@/api/query'
import { cn } from '@/lib/utils'
import { Avatar, Badge, Button, Callout, Card, ErrorState, Field, Input, PageHeader, SkeletonRows, Switch, Tooltip, useReadOnly } from '@/ui'

const GROUPS: { title: string; hint: string; entities: ChangeEntity[] }[] = [
  { title: 'Access', hint: 'Who can sign in and what they can do', entities: ['role', 'user_access', 'employee'] },
  { title: 'Money', hint: 'Salaries, payroll and who gets paid', entities: ['cost_rate', 'payroll_finalise', 'vendor', 'budget'] },
  { title: 'Configuration', hint: 'How the organisation and its processes are set up', entities: ['workflow', 'org_profile', 'master_record', 'shift', 'settings'] },
]
const ENTITY_HINT: Partial<Record<ChangeEntity, string>> = {
  role: 'Creating, editing or deleting roles and their permissions',
  user_access: 'A person’s role, extra and removed permissions',
  employee: 'Creating and deactivating employees',
  cost_rate: 'New monthly CTC or removing a future rate',
  payroll_finalise: 'Locking a payroll run',
  vendor: 'New vendors and changes to GSTIN, PAN or bank account',
  budget: 'Budget lines, removals and copying a year',
  workflow: 'Approval workflow steps',
  org_profile: 'Legal name, tax IDs, addresses, bank details',
  master_record: 'Departments, designations, grades, locations, cost centres',
  shift: 'Shift timings and assignments',
  settings: 'Company rules (calendar, timesheets, pay)',
}

export default function MakerCheckerPage() {
  const ro = useReadOnly()
  const cfg = useApi(['mc-config'], changesApi.config)
  const checkers = useApi(['mc-checkers'], changesApi.checkers)
  const pending = useApi(['changes', 'list', 'mc-config'], () => changesApi.list({ status: 'pending', entity: 'makerchecker_config', scope: 'all' }))
  const [draft, setDraft] = useState<MakerCheckerConfig | null>(null)
  useEffect(() => {
    if (cfg.data) setDraft({ enabled: cfg.data.enabled, entities: [...cfg.data.entities], sla_days: cfg.data.sla_days })
  }, [cfg.data])
  const save = useMut((c: MakerCheckerConfig) => changesApi.saveConfig(c), {
    invalidate: CHANGE_INVALIDATE,
    onSuccess: (r) => announce(r, 'Maker-checker settings saved'),
  })
  const rowsBy = useMemo(() => new Map((checkers.data ?? []).map((r) => [r.entity, r])), [checkers.data])
  if (cfg.isLoading || checkers.isLoading || !draft) return cfg.error || checkers.error ? <ErrorState error={cfg.error ?? checkers.error} onRetry={() => (cfg.refetch(), checkers.refetch())} /> : <><PageHeader title="Maker-checker" /><SkeletonRows rows={8} /></>
  const base = cfg.data!
  const dirty = draft.enabled !== base.enabled || draft.sla_days !== base.sla_days || draft.entities.length !== base.entities.length || draft.entities.some((e) => !base.entities.includes(e))
  const recommended = new Set(base.recommended)
  const toggle = (e: ChangeEntity, on: boolean) => setDraft((d) => d && { ...d, entities: on ? [...new Set([...d.entities, e])] : d.entities.filter((x) => x !== e) })
  const lonely = draft.enabled ? draft.entities.filter((e) => (rowsBy.get(e)?.others ?? 0) === 0) : []
  const slaBad = !Number.isInteger(draft.sla_days) || draft.sla_days < 1 || draft.sla_days > 10
  const pend = pending.data?.[0]
  const cfgRow = rowsBy.get('makerchecker_config')

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader title="Maker-checker" subtitle="Choose which changes need a second person before they take effect." />

      <Card className="mb-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <p className="max-w-[640px] text-[13.5px] leading-relaxed text-ink-2">
            The four-eyes principle: one person proposes a sensitive change (the maker) and a different person approves it (the checker) before it is applied. Nobody can approve their own change, the checker must hold the same permission the change needs, and a change fails safely if the record moved on in the meantime.
          </p>
          <div className="shrink-0 md:pt-0.5">
            <Switch checked={draft.enabled} disabled={ro} onChange={(v) => setDraft({ ...draft, enabled: v })} label={draft.enabled ? 'On' : 'Off'} />
          </div>
        </div>
        {pend && (
          <Callout tone="warning" className="mt-4" title="A settings change is waiting for approval" action={<Link to={`/changes?id=${pend.id}`}><Button size="sm">Open</Button></Link>}>
            {pend.summary} — proposed by {pend.maker_name}. You can’t save another change until it is decided.
          </Callout>
        )}
        {base.enabled && (
          <p className="mt-3 text-[12.5px] text-ink-3">
            While maker-checker is on, changes to these settings are themselves checked{cfgRow ? ` (by ${cfgRow.checkers.length ? cfgRow.checkers.map((c) => c.name.split(' ')[0]).join(', ') : 'nobody yet'})` : ''}.
          </p>
        )}
      </Card>

      <div className={cn('space-y-5', !draft.enabled && 'opacity-60')}>
        {GROUPS.map((g) => (
          <section key={g.title}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 px-1">
              <h2 className="text-[14px] font-semibold text-ink">{g.title}</h2>
              <span className="text-[12.5px] text-ink-3">{g.hint}</span>
            </div>
            <Card pad={false}>
              <ul className="divide-y divide-line">
                {g.entities.map((e) => (
                  <EntityRow key={e} e={e} label={base.entity_labels[e] ?? e} row={rowsBy.get(e)} on={draft.entities.includes(e)} master={draft.enabled} recommended={recommended.has(e)} disabled={ro} onChange={(v) => toggle(e, v)} />
                ))}
              </ul>
            </Card>
          </section>
        ))}
      </div>

      <Card className="mt-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_200px] md:items-end">
          <div>
            <h2 className="text-[14px] font-semibold text-ink">Checking deadline</h2>
            <p className="mt-0.5 text-[13px] text-ink-3">Changes waiting longer than this are marked overdue in Change approvals and the inbox.</p>
          </div>
          <Field label="Working days" htmlFor="mc-sla" error={slaBad ? 'Enter 1 to 10 working days.' : null}>
            <Input id="mc-sla" type="number" min={1} max={10} value={String(draft.sla_days)} disabled={ro} invalid={slaBad} onChange={(ev) => setDraft({ ...draft, sla_days: Number(ev.target.value) })} />
          </Field>
        </div>
      </Card>

      {lonely.length > 0 && (
        <Callout tone="danger" className="mt-5" title="Some changes would be refused">
          Nobody other than you can check {lonely.map((e) => (base.entity_labels[e] ?? e).toLowerCase()).join(', ')}. Give a second person “Check changes” and the permission shown, or turn those off.
        </Callout>
      )}

      {!ro && (
        <div className="fixed inset-x-0 bottom-[calc(58px+env(safe-area-inset-bottom))] z-20 flex gap-2 border-t border-line bg-surface px-4 py-3 lg:static lg:mt-5 lg:justify-end lg:border-0 lg:bg-transparent lg:p-0">
          <Button className="flex-1 lg:flex-none" disabled={!dirty || save.isPending} onClick={() => setDraft({ enabled: base.enabled, entities: [...base.entities], sla_days: base.sla_days })}>Discard</Button>
          <Button className="flex-1 lg:flex-none" variant="primary" disabled={!dirty || slaBad || !!pend} loading={save.isPending} onClick={() => save.mutate(draft)}>
            {base.enabled ? 'Propose changes' : 'Save settings'}
          </Button>
        </div>
      )}
      {save.data && isPending(save.data) && (
        <Callout tone="info" className="mt-4" title="Sent for approval">Your settings apply once a checker approves them in Change approvals.</Callout>
      )}
    </div>
  )
}

function EntityRow({ e, label, row, on, master, recommended, disabled, onChange }: { e: ChangeEntity; label: string; row: CheckerRow | undefined; on: boolean; master: boolean; recommended: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  const others = row?.others ?? 0
  const people = row?.checkers ?? []
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13.5px] font-medium text-ink">{label}</span>
          {recommended && <Badge size="sm" tone="brand">Recommended</Badge>}
        </div>
        {ENTITY_HINT[e] && <p className="mt-0.5 text-[12.5px] text-ink-3">{ENTITY_HINT[e]}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
          <span className="text-ink-3">Checked by</span>
          {people.length ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              {people.slice(0, 4).map((p) => (
                <Tooltip key={p.id} content={p.title || p.name}>
                  <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-ink-2">
                    <Avatar name={p.name} hue={p.hue} size={18} />
                    <span className="max-w-[120px] truncate">{p.name}</span>
                  </span>
                </Tooltip>
              ))}
              {people.length > 4 && <span className="text-ink-3">+{people.length - 4} more</span>}
            </span>
          ) : (
            <span className="text-ink-3">nobody yet</span>
          )}
        </div>
        <p className={cn('mt-1 text-[12px]', on && master && others === 0 ? 'text-danger-text' : 'text-ink-3')}>
          {on && master && others === 0 ? `No one else can check this. Give someone “Check changes” and “${row?.required_label ?? ''}”.` : `Checker needs “Check changes” and “${row?.required_label ?? '—'}”.`}
        </p>
      </div>
      <div className="shrink-0">
        <Switch checked={on} disabled={disabled || !master} onChange={onChange} label={<span className="sr-only">{label}</span>} />
      </div>
    </li>
  )
}
