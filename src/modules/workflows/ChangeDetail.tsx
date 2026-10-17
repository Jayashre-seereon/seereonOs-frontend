// Detail + decision controls for one maker-checker change (used by /changes and the inbox).
import { useState } from 'react'
import { changesApi, CHANGE_INVALIDATE, type ChangeView } from '@/api/changes'
import { useMut } from '@/api/query'
import { fmtDateTime, relTime } from '@/domain/calendar'
import type { Tone } from '@/domain/labels'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { Avatar, Badge, Button, Callout, Dialog, Field, Textarea, useConfirm, useReadOnly } from '@/ui'
import { ChangeDiff } from './ChangeDiff'

export const CHANGE_STATUS: Record<ChangeView['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Waiting', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'danger' },
}
export const ACTION_LABEL: Record<ChangeView['action'], string> = { create: 'New', update: 'Change', delete: 'Removal', execute: 'Action' }

export function ageText(c: Pick<ChangeView, 'status' | 'age_days' | 'created_at'>) {
  if (c.status !== 'pending') return relTime(c.created_at)
  if (c.age_days <= 0) return 'Today'
  return `${c.age_days} working day${c.age_days === 1 ? '' : 's'}`
}

export function ChangeBody({ c }: { c: ChangeView }) {
  const me = useSession((s) => s.user?.id)
  const pending = c.status === 'pending'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm">{c.entity_label}</Badge>
        <Badge size="sm" tone={CHANGE_STATUS[c.status].tone}>{CHANGE_STATUS[c.status].label}</Badge>
        {pending && c.overdue && <Badge size="sm" tone="danger">Overdue</Badge>}
        <span className="text-[12.5px] text-ink-3">{ACTION_LABEL[c.action]}</span>
      </div>
      <div className="flex items-center gap-3">
        <Avatar name={c.maker_name} hue={c.maker_hue} size={34} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">{c.maker_name}{c.maker_id === me ? ' (you)' : ''}</div>
          <div className="truncate text-[12.5px] text-ink-3">Proposed {fmtDateTime(c.created_at)}{pending ? ` · waiting ${ageText(c).toLowerCase()}` : ''}</div>
        </div>
      </div>

      {pending && c.maker_id === me && (
        <Callout tone="info" title="Waiting for a second person">You proposed this, so someone else with “Check changes” and “{c.required_permission_label}” must approve it. You can withdraw it until then.</Callout>
      )}
      {pending && c.maker_id !== me && !c.can_check && (
        <Callout tone="info" title="You can’t decide this one">Approving it needs both “Check changes” and “{c.required_permission_label}”.</Callout>
      )}
      {c.status === 'failed' && (
        <Callout tone="danger" title="Not applied">{c.error ?? 'The change could not be applied.'} Ask {c.maker_name.split(' ')[0]} to propose it again on the current record.</Callout>
      )}
      {c.status === 'rejected' && c.reason && (
        <Callout tone="danger" title={`Rejected by ${c.checker_name ?? '—'}`}>“{c.reason}”</Callout>
      )}
      {c.status === 'approved' && (
        <Callout tone="success" title={`Approved by ${c.checker_name ?? '—'}${c.decided_at ? ` · ${fmtDateTime(c.decided_at)}` : ''}`}>{c.reason ? `“${c.reason}”` : 'Applied.'}</Callout>
      )}

      <section>
        <h3 className="mb-2 text-[14px] font-semibold text-ink">What changes</h3>
        <ChangeDiff c={c} />
      </section>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 border-t border-line pt-3 text-[12.5px] sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-ink-3">Checker needs</dt>
          <dd className="mt-0.5 text-[13.5px] text-ink">Check changes + {c.required_permission_label}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-ink-3">{pending ? 'Waiting' : 'Decided'}</dt>
          <dd className={cn('mt-0.5 text-[13.5px] text-ink', pending && c.overdue && 'text-danger-text')}>{pending ? ageText(c) : c.decided_at ? fmtDateTime(c.decided_at) : '—'}</dd>
        </div>
      </dl>
    </div>
  )
}

/** Approve / reject (checker) or withdraw (maker). Hidden when the viewer can do neither. */
export function ChangeActions({ c, onDone, block }: { c: ChangeView; onDone?: () => void; block?: boolean }) {
  const ro = useReadOnly()
  const { askReason, confirm } = useConfirm()
  const [approveOpen, setApproveOpen] = useState(false)
  const [note, setNote] = useState('')
  const done = () => {
    setApproveOpen(false)
    setNote('')
    onDone?.()
  }
  const approve = useMut((n: string) => changesApi.approve(c.id, n || undefined), { invalidate: CHANGE_INVALIDATE, success: 'Change approved and applied', onSuccess: done, onError: () => setApproveOpen(false) })
  const reject = useMut((reason: string) => changesApi.reject(c.id, reason), { invalidate: CHANGE_INVALIDATE, success: 'Change rejected', onSuccess: done })
  const withdraw = useMut(() => changesApi.withdraw(c.id), { invalidate: CHANGE_INVALIDATE, success: 'Change withdrawn', onSuccess: done })
  if (ro || c.status !== 'pending') return null
  const busy = approve.isPending || reject.isPending || withdraw.isPending
  if (c.can_check)
    return (
      <>
        <Button
          variant="secondary"
          disabled={busy}
          className={cn(block && 'flex-1')}
          onClick={async () => {
            const r = await askReason({ title: 'Reject this change', body: `${c.summary}. ${c.maker_name.split(' ')[0]} sees your reason.`, label: 'Reason', placeholder: 'e.g. The new IFSC doesn’t match the cancelled cheque on file.', confirmLabel: 'Reject', minLength: 10, tone: 'danger' })
            if (r) reject.mutate(r)
          }}
        >
          Reject
        </Button>
        <Button variant="primary" loading={approve.isPending} disabled={busy} className={cn(block && 'flex-1')} onClick={() => setApproveOpen(true)}>Approve</Button>
        <Dialog
          open={approveOpen}
          onOpenChange={setApproveOpen}
          size="sm"
          title="Approve and apply"
          description={c.summary}
          footer={
            <>
              <Button onClick={() => setApproveOpen(false)}>Cancel</Button>
              <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate(note.trim())}>Approve</Button>
            </>
          }
        >
          <p className="mb-3 text-[13.5px] text-ink-2">It takes effect immediately. If the record changed since {c.maker_name.split(' ')[0]} proposed it, the change fails instead of overwriting newer data.</p>
          <Field label="Note for the maker">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Optional" />
          </Field>
        </Dialog>
      </>
    )
  if (c.can_withdraw)
    return (
      <Button
        variant="secondary"
        loading={withdraw.isPending}
        className={cn(block && 'flex-1')}
        onClick={async () => (await confirm({ title: 'Withdraw this change?', body: `${c.summary}. Nothing is applied; you can propose it again later.`, confirmLabel: 'Withdraw' })) && withdraw.mutate(undefined)}
      >
        Withdraw
      </Button>
    )
  return null
}
