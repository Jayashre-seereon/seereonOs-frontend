// Save / update a report definition: name, description, share, pin, schedule.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReportSpec } from '@/types/reports'
import { reportsApi, type SavedReportView } from '@/api/reports'
import { useMut } from '@/api/query'
import { Button, Dialog, Field, Input, Segmented, Switch, Textarea, useReadOnly } from '@/ui'

export function SaveReportDialog({
  open, onOpenChange, spec, existing, source = 'builder', onSaved, navigateOnSave = true,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  spec: ReportSpec
  existing?: SavedReportView | null
  source?: 'builder' | 'ai'
  onSaved?: (r: SavedReportView) => void
  navigateOnSave?: boolean
}) {
  const nav = useNavigate()
  const readOnly = useReadOnly()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [shared, setShared] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [schedule, setSchedule] = useState<'none' | 'weekly' | 'monthly'>('none')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setName(existing?.name ?? spec.title ?? '')
    setDescription(existing?.description ?? spec.subtitle ?? '')
    setShared(existing?.shared ?? false)
    setPinned(existing?.pinned ?? false)
    setSchedule(existing?.schedule ?? 'none')
    setError(null)
  }, [open, existing, spec.title, spec.subtitle])
  const save = useMut(
    async () => {
      const body = { name: name.trim(), description: description.trim(), spec: { ...spec, title: name.trim() || spec.title }, shared, pinned, schedule, source }
      return existing?.can_edit ? reportsApi.update(existing.id, body, existing.version) : reportsApi.create(body)
    },
    {
      invalidate: [['reports']],
      success: existing?.can_edit ? 'Report updated' : 'Report saved',
      onSuccess: (r) => {
        onOpenChange(false)
        onSaved?.(r)
        if (navigateOnSave) nav(`/reports/${r.id}`)
      },
      onError: (e) => e.field === 'name' && setError(e.message),
    },
  )
  const submit = () => {
    if (name.trim().length < 2) return setError('Give the report a name of at least 2 characters.')
    save.mutate(undefined)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={existing?.can_edit ? 'Save changes' : 'Save report'}
      description="Saved reports re-run on live data every time they are opened."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={readOnly} onClick={submit}>
            {existing?.can_edit ? 'Save changes' : 'Save report'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required error={error}>
          <Input value={name} onChange={(e) => (setName(e.target.value), setError(null))} maxLength={120} autoFocus placeholder="e.g. Revenue by stream — this FY" onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label="Description" hint="Shown on the report card. Optional.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={400} rows={2} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line p-3">
            <Switch checked={shared} onChange={setShared} label="Share with the team" description="Everyone whose role can see this data can open it." />
          </div>
          <div className="rounded-lg border border-line p-3">
            <Switch checked={pinned} onChange={setPinned} label="Pin to the top" description="Pinned reports show first in the library." />
          </div>
        </div>
        <Field label="Email schedule" hint={schedule === 'none' ? 'Not emailed. Open it any time from Reports.' : `A PDF is emailed to you ${schedule === 'weekly' ? 'every Monday at 9:00' : 'on the 1st of each month at 9:00'}.`}>
          <Segmented
            value={schedule}
            onChange={setSchedule}
            options={[
              { value: 'none', label: 'Off' },
              { value: 'weekly', label: 'Weekly' },
              { value: 'monthly', label: 'Monthly' },
            ]}
          />
        </Field>
      </div>
    </Dialog>
  )
}
