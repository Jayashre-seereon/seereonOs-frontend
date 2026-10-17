import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown } from '@/ui/icons'
import { cn } from '@/lib/utils'
import { Checkbox } from './form'
import { EmptyState, ErrorState, Skeleton } from './data'
import { Button } from './Button'

export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode
  sortValue?: (row: T) => string | number | null | undefined
  align?: 'left' | 'right' | 'center'
  width?: string
  className?: string
  /** hide below md in the table layout (the mobile card decides what to show) */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl'
}

/** CMP-02 DataTable: sortable table on desktop, card list on phones. */
export function DataTable<T>({
  rows, columns, rowKey, onRowClick, rowLabel, mobileCard, loading, error, onRetry, empty, selectable, selected, onSelectedChange, initialSort, pageSize = 50, dense, footer, rowClassName, stickyHeader = true, className,
}: {
  rows: T[] | undefined
  columns: Column<T>[]
  rowKey: (r: T) => string
  onRowClick?: (r: T) => void
  /** Accessible name of a phone card's open action (defaults to “Open details”). */
  rowLabel?: (r: T) => string
  mobileCard?: (r: T) => ReactNode
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  empty?: ReactNode
  selectable?: boolean
  selected?: string[]
  onSelectedChange?: (ids: string[]) => void
  initialSort?: { key: string; dir: 'asc' | 'desc' }
  pageSize?: number
  dense?: boolean
  footer?: ReactNode
  rowClassName?: (r: T) => string | undefined
  stickyHeader?: boolean
  className?: string
}) {
  const [sort, setSort] = useState(initialSort ?? null)
  const [limit, setLimit] = useState(pageSize)
  const sorted = useMemo(() => {
    if (!rows) return []
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sortValue) return rows
    const f = col.sortValue
    return [...rows].sort((a, b) => {
      const x = f(a)
      const y = f(b)
      if (x === y) return 0
      if (x === null || x === undefined) return 1
      if (y === null || y === undefined) return -1
      const r = x < y ? -1 : 1
      return sort.dir === 'asc' ? r : -r
    })
  }, [rows, sort, columns])
  const visible = sorted.slice(0, limit)
  const sel = new Set(selected ?? [])
  const allSel = visible.length > 0 && visible.every((r) => sel.has(rowKey(r)))
  const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell' }

  if (error) return <ErrorState error={error} onRetry={onRetry} />
  if (loading)
    return (
      <div className={cn('overflow-hidden rounded-lg border border-line bg-surface', className)}>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-0">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-1/5" />
            <Skeleton className="ml-auto h-4 w-16" />
          </div>
        ))}
      </div>
    )
  if (!sorted.length) return <div className={cn('rounded-lg border border-line bg-surface', className)}>{empty ?? <EmptyState title="Nothing here yet" compact />}</div>

  return (
    <div className={className}>
      {/* phone: cards */}
      {mobileCard && (
        <div className="space-y-2 md:hidden">
          {visible.map((r) => (
            <div
              key={rowKey(r)}
              className={cn('rounded-lg border border-line bg-surface p-3.5', onRowClick && 'relative cursor-pointer active:bg-surface-2', rowClassName?.(r))}
            >
              {/* the card is a plain container; a stretched button is its primary action so buttons inside the card stay valid */}
              {onRowClick && (
                <button type="button" aria-label={rowLabel?.(r) ?? 'Open details'} onClick={() => onRowClick(r)} className="absolute inset-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-brand" />
              )}
              <div className={cn(onRowClick && 'pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto [&_input]:pointer-events-auto [&_label]:pointer-events-auto [&_select]:pointer-events-auto [&_textarea]:pointer-events-auto [&_[role=button]]:pointer-events-auto [&_[role=checkbox]]:pointer-events-auto')}>
              {selectable ? (
                <div className="flex items-start gap-3">
                  <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                    <Checkbox checked={sel.has(rowKey(r))} onChange={(v) => onSelectedChange?.(v ? [...sel, rowKey(r)] : [...sel].filter((x) => x !== rowKey(r)))} />
                  </div>
                  <div className="min-w-0 flex-1">{mobileCard(r)}</div>
                </div>
              ) : (
                mobileCard(r)
              )}
              </div>
            </div>
          ))}
        </div>
      )}
      {/* desktop / tablet: table */}
      <div className={cn('overflow-hidden rounded-lg border border-line bg-surface', mobileCard && 'hidden md:block')}>
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full border-collapse text-[13.5px]">
            <thead className={cn(stickyHeader && 'sticky top-0 z-[1]')}>
              <tr className="border-b border-line bg-surface-2/70">
                {selectable && (
                  <th className="w-10 pl-4">
                    <Checkbox checked={allSel} onChange={(v) => onSelectedChange?.(v ? visible.map(rowKey) : [])} />
                  </th>
                )}
                {columns.map((c) => {
                  const active = sort?.key === c.key
                  return (
                    <th
                      key={c.key}
                      style={{ width: c.width }}
                      aria-sort={c.sortValue ? (active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                      className={cn(
                        'h-10 whitespace-nowrap px-3 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3 first:pl-4 last:pr-4',
                        c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                        c.hideBelow && hide[c.hideBelow],
                      )}
                    >
                      {c.sortValue ? (
                        <button
                          type="button"
                          onClick={() => setSort(active ? (sort!.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' })}
                          className={cn('inline-flex items-center gap-1 uppercase hover:text-ink', active && 'text-ink', c.align === 'right' && 'flex-row-reverse')}
                        >
                          {c.header}
                          {active ? sort!.dir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={rowKey(r)}
                  onClick={() => onRowClick?.(r)}
                  className={cn('border-b border-line last:border-0', onRowClick && 'cursor-pointer transition-colors hover:bg-surface-2/70', sel.has(rowKey(r)) && 'bg-brand-soft/60', rowClassName?.(r))}
                >
                  {selectable && (
                    <td className="w-10 pl-4" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={sel.has(rowKey(r))} onChange={(v) => onSelectedChange?.(v ? [...sel, rowKey(r)] : [...sel].filter((x) => x !== rowKey(r)))} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 align-middle first:pl-4 last:pr-4',
                        dense ? 'py-2' : 'py-3',
                        c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                        c.hideBelow && hide[c.hideBelow],
                        c.className,
                      )}
                    >
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {footer && <tfoot className="border-t border-line-strong bg-surface-2/60 font-semibold">{footer}</tfoot>}
          </table>
        </div>
      </div>
      {sorted.length > limit && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" onClick={() => setLimit((l) => l + pageSize)}>
            Show {Math.min(pageSize, sorted.length - limit)} more of {sorted.length - limit}
          </Button>
        </div>
      )}
    </div>
  )
}
