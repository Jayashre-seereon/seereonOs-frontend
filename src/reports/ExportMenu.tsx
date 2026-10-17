// Export button + menu (PDF / Excel / CSV) used by every module. Pass the table to export — or a
// function that builds it at click time (so a chart SVG can be picked from the DOM at that moment).
import { useState } from 'react'
import { Download, FileSpreadsheet, FileText, FileType2 } from '@/ui/icons'
import { Button, IconButton, Menu, toast } from '@/ui'
import { exportTable, type ExportFormat, type ExportTable } from './export'

export function ExportMenu({
  table, filename, size = 'sm', label = 'Export', iconOnly, formats = ['pdf', 'xlsx', 'csv'], disabled, variant = 'secondary',
}: {
  table: ExportTable | (() => ExportTable | Promise<ExportTable>) | null | undefined
  filename?: string
  size?: 'xs' | 'sm' | 'md'
  label?: string
  iconOnly?: boolean
  formats?: ExportFormat[]
  disabled?: boolean
  variant?: 'secondary' | 'ghost' | 'subtle'
}) {
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const run = async (f: ExportFormat) => {
    if (!table) return
    setBusy(f)
    try {
      const t = typeof table === 'function' ? await table() : table
      const r = await exportTable(t, f, filename)
      const kind = f === 'pdf' ? 'PDF' : f === 'xlsx' ? 'Excel file' : 'CSV'
      if (r === 'saved') toast.success(`${kind} ready`, { description: `${t.title} was exported.` })
      else if (r === 'failed') toast.error('Export failed', { description: 'The file couldn’t be created. Try again, or use CSV.' })
    } finally {
      setBusy(null)
    }
  }
  const items = [
    { f: 'pdf' as const, label: 'PDF report', hint: 'A4, branded', icon: <FileText /> },
    { f: 'xlsx' as const, label: 'Excel workbook', hint: '.xlsx', icon: <FileSpreadsheet /> },
    { f: 'csv' as const, label: 'CSV data', hint: '.csv', icon: <FileType2 /> },
  ].filter((i) => formats.includes(i.f))
  const trigger = iconOnly ? (
    <IconButton label={label} size={size === 'md' ? 'md' : 'sm'} variant={variant === 'subtle' ? 'ghost' : variant} disabled={disabled || !table || !!busy}>
      <Download className="size-4" />
    </IconButton>
  ) : (
    <Button size={size} variant={variant} icon={<Download className="size-3.5" />} loading={!!busy} disabled={disabled || !table}>
      {label}
    </Button>
  )
  return <Menu trigger={trigger} label={label} items={items.map((i) => ({ label: i.label, hint: i.hint, icon: i.icon, onSelect: () => void run(i.f) }))} />
}

export default ExportMenu
