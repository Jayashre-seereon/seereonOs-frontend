// Feature Guide §6 "Resource allocation by milestone": each row names a person, the milestone (M1, M2, by code), the %
// of their time and a from and to date — all four required, so cost always lands on a milestone and a period. Rows
// show their paid hours and cost; add / edit / remove use the same allocation dialog as the Team tab.
import { useState } from 'react'
import { MoreHorizontal, Pencil, Plus, Trash2, Users } from '@/ui/icons'
import { projectsApi, type AllocationCostRow, type AllocationView, type CostingAnalysis, type ProjectDetail } from '@/api/projects'
import { useMut } from '@/api/query'
import { fmtDate } from '@/domain/calendar'
import { fmtMoney, fmtNum } from '@/domain/money'
import { cn } from '@/lib/utils'
import { Button, Card, CardHeader, EmptyState, IconButton, Menu, PersonName, useConfirm, useReadOnly } from '@/ui'
import { AllocationDialog } from '../tabs/TeamTab'
import { CostPerHourNote, TD, TH } from './MarginAnalysis'

export function AllocationByMilestoneCard({ d, a }: { d: ProjectDetail; a: CostingAnalysis }) {
  const readOnly = useReadOnly()
  const editable = d.can_edit && !readOnly
  const { confirm } = useConfirm()
  const [dlg, setDlg] = useState<{ open: boolean; a: AllocationView | null }>({ open: false, a: null })
  const del = useMut((id: string) => projectsApi.deleteAllocation(id), { invalidate: [['project', d.project.id], ['projects'], ['margins']], success: 'Allocation removed' })
  const rows = a.allocations ?? []
  const showCost = rows.some((r) => r.cost !== null)
  const totalH = rows.reduce((s, r) => s + r.hours, 0)
  const totalC = rows.reduce((s, r) => s + (r.cost ?? 0), 0)
  const viewOf = (r: AllocationCostRow) => d.allocations.find((x) => x.id === r.id) ?? null
  const edit = (r: AllocationCostRow) => editable && setDlg({ open: true, a: viewOf(r) })
  const remove = async (r: AllocationCostRow) => {
    if (await confirm({ title: 'Remove this allocation?', body: 'Planned cost, margins and resource load update straight away.', confirmLabel: 'Remove', tone: 'danger' })) del.mutate(r.id)
  }
  const menu = (r: AllocationCostRow) =>
    editable ? (
      <div onClick={(e) => e.stopPropagation()}>
        <Menu
          label="Allocation actions"
          trigger={<IconButton size="sm" label={`Actions for ${r.ms_code} allocation`}><MoreHorizontal className="size-4" /></IconButton>}
          items={[
            { label: 'Edit allocation', icon: <Pencil />, onSelect: () => edit(r) },
            { label: 'Remove', icon: <Trash2 />, danger: true, onSelect: () => remove(r) },
          ]}
        />
      </div>
    ) : null
  return (
    <Card>
      <CardHeader
        title="Resource allocation by milestone"
        subtitle="Each resource row names a person, the milestone (M1, M2, shown by code), the % of their time, and a from and to date. All four are required, so cost always lands on a milestone and a period."
        action={editable ? <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={() => setDlg({ open: true, a: null })}>Add resource</Button> : undefined}
      />
      {!rows.length ? (
        <EmptyState compact icon={<Users />} title="No one allocated yet" body="Allocate people to milestones so planned cost and the margins are accurate." />
      ) : (
        <>
          <div className="-mx-4 hidden overflow-x-auto px-4 scroll-thin md:-mx-5 md:block md:px-5">
            <table className="w-full min-w-[820px] text-[13.5px]">
              <thead className="bg-surface-2/60">
                <tr>
                  <th className={cn(TH, 'text-left')}>Person</th>
                  <th className={cn(TH, 'text-left')}>Milestone *</th>
                  <th className={cn(TH, 'text-right')}>% of time *</th>
                  <th className={cn(TH, 'text-left')}>From *</th>
                  <th className={cn(TH, 'text-left')}>To *</th>
                  <th className={cn(TH, 'text-right')}>Working days</th>
                  <th className={cn(TH, 'text-right')}>Hours</th>
                  {showCost && <th className={cn(TH, 'text-right')}>Cost</th>}
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => edit(r)} className={cn('border-b border-line last:border-0', editable && 'cursor-pointer hover:bg-surface-2/50')}>
                    <td className={cn(TD, 'max-w-[220px] py-2')}><PersonName id={r.user_id} size={22} className="max-w-full" /></td>
                    <td className={cn(TD, 'max-w-[240px] py-2')}>
                      <span className="tnum font-semibold text-ink">{r.ms_code}</span> <span className="text-ink-3">{r.ms_name}</span>
                    </td>
                    <td className={cn(TD, 'tnum py-2 text-right font-medium')}>{r.pct}%</td>
                    <td className={cn(TD, 'tnum whitespace-nowrap py-2')}>{fmtDate(r.from_on)}</td>
                    <td className={cn(TD, 'tnum whitespace-nowrap py-2')}>{fmtDate(r.to_on)}</td>
                    <td className={cn(TD, 'tnum py-2 text-right text-ink-2')}>{r.working_days}</td>
                    <td className={cn(TD, 'tnum py-2 text-right')}>{fmtNum(r.hours, 1)}</td>
                    {showCost && <td className={cn(TD, 'tnum whitespace-nowrap py-2 text-right font-medium')}>{fmtMoney(r.cost)}</td>}
                    <td className="py-1 pr-1 text-right">{menu(r)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td className={cn(TD, 'py-2')} colSpan={6}>Total, {rows.length} row{rows.length === 1 ? '' : 's'}</td>
                  <td className={cn(TD, 'tnum py-2 text-right')}>{fmtNum(totalH, 1)}</td>
                  {showCost && <td className={cn(TD, 'tnum whitespace-nowrap py-2 text-right')}>{fmtMoney(totalC)}</td>}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <ul className="divide-y divide-line md:hidden">
            {rows.map((r) => (
              <li key={r.id} className="flex items-start gap-2 py-2.5">
                <button type="button" disabled={!editable} onClick={() => edit(r)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2">
                    <PersonName id={r.user_id} size={24} className="min-w-0 flex-1" />
                    <span className="tnum shrink-0 text-[14px] font-semibold">{r.pct}%</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-baseline justify-between gap-3 pl-8 text-[12.5px] text-ink-3">
                    <span className="min-w-0 truncate"><span className="tnum font-semibold text-ink-2">{r.ms_code}</span> {r.ms_name}</span>
                    <span className="tnum shrink-0 whitespace-nowrap">{fmtDate(r.from_on)} – {fmtDate(r.to_on)}</span>
                  </div>
                  <div className="tnum mt-0.5 pl-8 text-[12.5px] text-ink-2">
                    {r.working_days} working days · {fmtNum(r.hours, 1)} h{r.cost !== null && <> · <span className="font-medium text-ink">{fmtMoney(r.cost)}</span></>}
                  </div>
                </button>
                {menu(r)}
              </li>
            ))}
            <li className="tnum flex justify-between py-2.5 text-[13px] font-semibold">
              <span>Total</span>
              <span>{fmtNum(totalH, 1)} h{showCost && <> · {fmtMoney(totalC)}</>}</span>
            </li>
          </ul>
        </>
      )}
      <div className="mt-4">
        <CostPerHourNote a={a} />
      </div>
      <AllocationDialog d={d} open={dlg.open} a={dlg.a} onOpenChange={(o) => setDlg((x) => ({ ...x, open: o }))} />
    </Card>
  )
}
