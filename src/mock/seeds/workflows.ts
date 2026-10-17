// v7 workflow management — ready-made workflow templates (annual appraisal, probation confirmation, onboarding,
// exit clearance, promotion, document approval), the letter / email templates they use, and a few in-flight
// instances for the Seereon demo. `defaultWfTemplates()` is shared with the lazy provisioning in
// routes/workflowsV7.ts so every new workspace starts with the same building blocks.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type * as V7 from '@/types/v7'
import type { ChangeSet, EmailTemplate } from '@/types/access'
import { addDays, fmtDate } from '@/domain/calendar'
import { fmtMoney } from '@/domain/money'
import { renderTemplate } from '../email'
import { longDate, renderBody, standardVarsFor } from '../docgen'
import type { SeedHelpers } from './index'

type F = V7.WfField
const f = (key: string, label: string, type: V7.WfFieldType, required: boolean, visible_to: string[], extra: Partial<F> = {}): F => ({ key, label, type, required, visible_to, ...extra })

export type WfTemplateDef = Omit<V7.WfTemplate, keyof E.Base>

/** Built-in templates. Stage keys are stable — field references ("hr.normalised_hike_pct") depend on them. */
export function defaultWfTemplates(): WfTemplateDef[] {
  const appraisalVars = { hike_pct: 'finance.approved_hike_pct', effective_from: 'hr.effective_date', new_designation: 'hr.new_designation', rating: 'hr.final_rating' }
  const ctcCfg = {
    hike_field: 'finance.approved_hike_pct', effective_field: 'hr.effective_date',
    recommended_field: 'manager.recommended_hike_pct', endorsed_field: 'unit_head.endorsed_hike_pct', normalised_field: 'hr.normalised_hike_pct',
  }
  return [
    {
      key: 'annual_appraisal', name: 'Annual appraisal', process: 'appraisal', active: true, rev: 1, self_service: false,
      description: 'Employee self-appraisal → manager / TL review → unit head review → HR review → finance approval. On approval the appraisal letter is generated and emailed, and the new CTC goes to Cost rates for a checker.',
      stages: [
        {
          key: 'self', name: 'Employee self-appraisal', assignee: 'subject', sla_days: 5, can_send_back: false,
          instructions: 'Rate yourself honestly against your goals and the competencies. Give examples — your manager sees the same delivery data.',
          fields: [
            f('goals_rating', 'Self rating — goals & KRAs', 'rating', true, ['manager', 'unit_head', 'hr']),
            f('competency_rating', 'Self rating — competencies', 'rating', true, ['manager', 'unit_head', 'hr']),
            f('overall_self_rating', 'Overall self rating', 'rating', true, ['manager', 'unit_head', 'hr']),
            f('achievements', 'Key achievements', 'textarea', true, ['manager', 'unit_head', 'hr'], { min: 30, help: 'What you delivered and the impact it had.' }),
            f('challenges', 'Challenges faced', 'textarea', false, ['manager', 'unit_head', 'hr']),
            f('development_needs', 'Development needs', 'textarea', false, ['manager', 'unit_head', 'hr'], { help: 'Skills, training or exposure you want next.' }),
          ],
        },
        {
          key: 'manager', name: 'Manager / TL review', assignee: 'reports_to', sla_days: 5, can_send_back: true,
          instructions: 'Rate each parameter on evidence from the period. Your private comments go to HR only — the employee, unit head and finance never see them.',
          fields: [
            f('delivery', 'Delivery', 'rating', true, ['unit_head', 'hr']),
            f('quality', 'Quality', 'rating', true, ['unit_head', 'hr']),
            f('ownership', 'Ownership', 'rating', true, ['unit_head', 'hr']),
            f('collaboration', 'Collaboration', 'rating', true, ['unit_head', 'hr']),
            f('overall_rating', 'Overall rating', 'rating', true, ['unit_head', 'hr', 'finance']),
            f('feedback', 'Feedback for the review panel', 'textarea', true, ['unit_head', 'hr'], { min: 30 }),
            f('recommended_hike_pct', 'Recommended hike', 'percent', true, ['unit_head', 'hr', 'finance'], { min: 0, max: 40 }),
            f('promotion', 'Promotion recommendation', 'select', true, ['unit_head', 'hr', 'finance'], { options: ['No', 'Ready now', 'Ready in 6 months'] }),
            f('private_comments', 'Private comments to HR', 'textarea', false, ['hr'], { help: 'Only HR sees this.' }),
          ],
        },
        {
          key: 'unit_head', name: 'Unit head review', assignee: 'department_head', sla_days: 3, can_send_back: true,
          instructions: 'Calibrate across your unit. Endorse the manager’s recommended hike or modify it.',
          fields: [
            f('calibrated_rating', 'Calibrated rating', 'rating', true, ['hr', 'finance']),
            f('hike_decision', 'Recommended hike', 'select', true, ['hr', 'finance'], { options: ['Endorse', 'Modify'] }),
            f('endorsed_hike_pct', 'Endorsed hike', 'percent', true, ['hr', 'finance'], { min: 0, max: 40, help: 'Same as the manager’s unless you modify it.' }),
            f('unit_comments', 'Comments', 'textarea', false, ['hr']),
          ],
        },
        {
          key: 'hr', name: 'HR review', assignee: 'role', role_key: 'hr_manager', sla_days: 3, can_send_back: true, sees_compensation: true,
          instructions: 'Check the pay band, normalise the hike across the company and set the outcome.',
          fields: [
            f('band_check', 'Policy band check', 'select', true, ['finance'], { options: ['Within band', 'Above band — exception', 'Below band'] }),
            f('final_rating', 'Final rating', 'rating', true, ['finance', 'subject']),
            f('normalised_hike_pct', 'Normalised hike', 'percent', true, ['finance'], { min: 0, max: 40 }),
            f('new_designation', 'New designation', 'text', false, ['finance', 'subject'], { help: 'Leave empty to keep the current designation.' }),
            f('effective_date', 'Effective date', 'date', true, ['finance', 'subject']),
            f('hr_comments', 'HR comments', 'textarea', false, ['finance']),
          ],
        },
        {
          key: 'finance', name: 'Finance approval', assignee: 'role', role_key: 'ceo', sla_days: 3, can_send_back: true, sees_compensation: true,
          instructions: 'Approve the hike. Going above HR’s normalised hike needs a written reason.',
          fields: [
            f('approved_hike_pct', 'Approved hike', 'percent', true, ['hr', 'subject'], { min: 0, max: 40, max_from: 'hr.normalised_hike_pct', override_field: 'override_reason' }),
            f('override_reason', 'Reason for exceeding the normalised hike', 'textarea', false, ['hr']),
            f('finance_comments', 'Finance comments', 'textarea', false, []),
          ],
        },
      ],
      on_complete: [
        { type: 'update_ctc', config: ctcCfg },
        { type: 'generate_document', template_key: 'appraisal_letter', config: { vars: appraisalVars } },
        { type: 'send_email', template_key: 'appraisal_letter', config: { to: 'subject', vars: appraisalVars } },
        { type: 'notify', config: { to: 'reports_to', message: 'The appraisal is complete and the letter has been issued.' } },
      ],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The appraisal workflow was rejected.' } }],
    },
    {
      key: 'probation_confirmation', name: 'Probation confirmation', process: 'confirmation', active: true, rev: 1, self_service: false,
      description: 'Manager assesses the probation period, HR decides and the confirmation letter is issued.',
      stages: [
        {
          key: 'manager', name: 'Manager assessment', assignee: 'reports_to', sla_days: 5, can_send_back: false,
          fields: [
            f('performance_rating', 'Performance during probation', 'rating', true, ['hr']),
            f('recommendation', 'Recommendation', 'select', true, ['hr'], { options: ['Confirm', 'Extend by 3 months', 'Do not confirm'] }),
            f('strengths', 'Strengths', 'textarea', true, ['hr'], { min: 20 }),
            f('improvement_areas', 'Areas to improve', 'textarea', false, ['hr']),
          ],
        },
        {
          key: 'hr', name: 'HR decision', assignee: 'role', role_key: 'hr_manager', sla_days: 3, can_send_back: true,
          fields: [
            f('decision', 'Decision', 'select', true, ['subject'], { options: ['Confirm', 'Extend', 'Do not confirm'] }),
            f('probation_end_date', 'Probation ends / ended on', 'date', true, ['subject']),
            f('confirmation_date', 'Confirmation / review date', 'date', true, ['subject']),
            f('notice_period_days', 'Notice period after confirmation (days)', 'number', true, ['subject'], { min: 0, max: 180 }),
            f('hr_notes', 'HR notes', 'textarea', false, []),
          ],
        },
      ],
      on_complete: [
        { type: 'generate_document', template_key: 'confirmation_letter', config: { when: { field: 'hr.decision', equals: 'Confirm' }, vars: { confirmation_date: 'hr.confirmation_date', probation_end_date: 'hr.probation_end_date', notice_period_days: 'hr.notice_period_days' } } },
        { type: 'notify', config: { to: 'subject', message: 'Your probation review is complete.' } },
      ],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The probation confirmation was rejected.' } }],
    },
    {
      key: 'employee_onboarding', name: 'Employee onboarding', process: 'onboarding', active: true, rev: 1, self_service: false,
      description: 'HR completes joining formalities, IT / admin sets up the laptop and accounts, the manager plans the first week, then the joining letter is issued.',
      stages: [
        {
          key: 'hr', name: 'HR formalities', assignee: 'role', role_key: 'hr_manager', sla_days: 3, can_send_back: false,
          fields: [
            f('joining_date', 'Joining date', 'date', true, ['all']),
            f('documents_verified', 'ID, PAN and bank documents verified', 'checkbox', true, ['all']),
            f('offer_signed', 'Signed offer letter received', 'checkbox', true, ['all']),
            f('probation_months', 'Probation (months)', 'number', true, ['all'], { min: 0, max: 12 }),
            f('notice_period_days', 'Notice period (days)', 'number', true, ['all'], { min: 0, max: 180 }),
            f('hr_notes', 'Notes for IT and the manager', 'textarea', false, ['it_admin', 'manager']),
          ],
        },
        {
          key: 'it_admin', name: 'IT & admin setup', assignee: 'role', role_key: 'administrator', sla_days: 2, can_send_back: true,
          fields: [
            f('laptop', 'Laptop', 'select', true, ['all'], { options: ['Company laptop issued', 'Own device approved', 'Pending'] }),
            f('email_created', 'Email and SeereonOS account created', 'checkbox', true, ['all']),
            f('access_notes', 'Access granted (Git, VPN, tools)', 'textarea', false, ['manager']),
          ],
        },
        {
          key: 'manager', name: 'Manager induction', assignee: 'reports_to', sla_days: 3, can_send_back: true,
          fields: [
            f('buddy', 'Buddy', 'text', true, ['all']),
            f('first_week_plan', 'First-week plan', 'textarea', true, ['all'], { min: 20 }),
            f('induction_done', 'Induction meeting held', 'checkbox', true, ['all']),
          ],
        },
      ],
      on_complete: [
        { type: 'generate_document', template_key: 'joining_letter', config: { vars: { joining_date: 'hr.joining_date', probation_months: 'hr.probation_months', notice_period_days: 'hr.notice_period_days' } } },
        { type: 'create_task', config: { to: 'subject', title: 'Complete your first-week plan', due_days: 5 } },
        { type: 'notify', config: { to: 'subject', message: 'Welcome aboard — your joining letter is in Documents.' } },
      ],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The onboarding workflow was rejected.' } }],
    },
    {
      key: 'exit_clearance', name: 'Exit clearance', process: 'exit', active: true, rev: 1, self_service: false,
      description: 'Manager confirms handover, IT recovers assets and access, finance settles dues and HR closes the exit with relieving and experience letters.',
      stages: [
        {
          key: 'manager', name: 'Manager handover', assignee: 'reports_to', sla_days: 3, can_send_back: false,
          fields: [
            f('resignation_date', 'Resignation date', 'date', true, ['all']),
            f('last_working_day', 'Last working day', 'date', true, ['all']),
            f('key_work', 'Key work (for the experience letter)', 'text', true, ['hr'], { help: 'e.g. the EduReon parent app and HRMS payroll APIs' }),
            f('kt_complete', 'Knowledge transfer complete', 'checkbox', true, ['all']),
            f('handover_notes', 'Handover notes', 'textarea', true, ['hr'], { min: 20 }),
          ],
        },
        {
          key: 'it_assets', name: 'IT & assets', assignee: 'role', role_key: 'administrator', sla_days: 2, can_send_back: true,
          fields: [
            f('assets_returned', 'All assets returned', 'checkbox', true, ['all']),
            f('access_revoked', 'Access revoked', 'checkbox', true, ['all']),
            f('asset_notes', 'Asset notes', 'text', false, ['finance', 'hr']),
          ],
        },
        {
          key: 'finance', name: 'Finance clearance', assignee: 'role', role_key: 'ceo', sla_days: 3, can_send_back: true,
          fields: [
            f('dues', 'Dues', 'select', true, ['hr'], { options: ['No dues', 'Recover in full & final', 'Pay in full & final'] }),
            f('fnf_amount', 'Full & final amount', 'money', false, ['hr']),
            f('finance_notes', 'Finance notes', 'textarea', false, ['hr']),
          ],
        },
        {
          key: 'hr', name: 'HR closure', assignee: 'role', role_key: 'hr_manager', sla_days: 3, can_send_back: true,
          fields: [
            f('exit_interview_done', 'Exit interview held', 'checkbox', true, []),
            f('rehire_eligible', 'Eligible for rehire', 'select', true, [], { options: ['Yes', 'No'] }),
            f('relieving_date', 'Relieving date', 'date', true, ['subject']),
          ],
        },
      ],
      on_complete: [
        { type: 'generate_document', template_key: 'relieving_letter', config: { vars: { resignation_date: 'manager.resignation_date', last_working_day: 'manager.last_working_day', relieving_date: 'hr.relieving_date' } } },
        { type: 'generate_document', template_key: 'experience_letter', config: { vars: { last_working_day: 'manager.last_working_day', key_work: 'manager.key_work' } } },
        { type: 'notify', config: { to: 'subject', message: 'Your exit clearance is complete. Relieving and experience letters are in Documents.' } },
      ],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The exit clearance was rejected.' } }],
    },
    {
      key: 'promotion', name: 'Promotion', process: 'promotion', active: true, rev: 1, self_service: false,
      description: 'Manager proposes a promotion, the unit head endorses, HR sets the designation and hike, finance approves and the promotion letter is issued.',
      stages: [
        {
          key: 'manager', name: 'Manager proposal', assignee: 'reports_to', sla_days: 5, can_send_back: false,
          fields: [
            f('proposed_designation', 'Proposed designation', 'text', true, ['all']),
            f('justification', 'Justification', 'textarea', true, ['unit_head', 'hr', 'finance'], { min: 30 }),
            f('recommended_hike_pct', 'Recommended hike', 'percent', true, ['unit_head', 'hr', 'finance'], { min: 0, max: 50 }),
          ],
        },
        {
          key: 'unit_head', name: 'Unit head endorsement', assignee: 'department_head', sla_days: 3, can_send_back: true,
          fields: [
            f('endorse', 'Endorsement', 'select', true, ['hr', 'finance'], { options: ['Endorse', 'Endorse with changes'] }),
            f('endorsed_hike_pct', 'Endorsed hike', 'percent', true, ['hr', 'finance'], { min: 0, max: 50 }),
            f('comments', 'Comments', 'textarea', false, ['hr']),
          ],
        },
        {
          key: 'hr', name: 'HR review', assignee: 'role', role_key: 'hr_manager', sla_days: 3, can_send_back: true, sees_compensation: true,
          fields: [
            f('new_designation', 'New designation', 'text', true, ['finance', 'subject']),
            f('normalised_hike_pct', 'Normalised hike', 'percent', true, ['finance'], { min: 0, max: 50 }),
            f('effective_date', 'Effective date', 'date', true, ['finance', 'subject']),
          ],
        },
        {
          key: 'finance', name: 'Finance approval', assignee: 'role', role_key: 'ceo', sla_days: 3, can_send_back: true, sees_compensation: true,
          fields: [
            f('approved_hike_pct', 'Approved hike', 'percent', true, ['hr', 'subject'], { min: 0, max: 50, max_from: 'hr.normalised_hike_pct', override_field: 'override_reason' }),
            f('override_reason', 'Reason for exceeding the normalised hike', 'textarea', false, ['hr']),
          ],
        },
      ],
      on_complete: [
        { type: 'update_ctc', config: { hike_field: 'finance.approved_hike_pct', effective_field: 'hr.effective_date', recommended_field: 'manager.recommended_hike_pct', endorsed_field: 'unit_head.endorsed_hike_pct', normalised_field: 'hr.normalised_hike_pct' } },
        { type: 'generate_document', template_key: 'promotion_letter', config: { vars: { new_designation: 'hr.new_designation', effective_from: 'hr.effective_date', hike_pct: 'finance.approved_hike_pct' } } },
        { type: 'notify', config: { to: 'subject', message: 'Congratulations — your promotion letter is in Documents.' } },
      ],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'The promotion proposal was rejected.' } }],
    },
    {
      key: 'document_approval', name: 'Document approval', process: 'document_approval', active: true, rev: 1, self_service: true,
      description: 'Submit a document (proposal, policy draft, quotation) for your manager’s review and the CEO’s approval.',
      stages: [
        {
          key: 'submit', name: 'Submit document', assignee: 'initiator', sla_days: 2, can_send_back: false,
          fields: [
            f('document_title', 'Document title', 'text', true, ['all']),
            f('document', 'Document', 'file', true, ['all']),
            f('purpose', 'What needs approval and why', 'textarea', true, ['all'], { min: 15 }),
          ],
        },
        {
          key: 'review', name: 'Manager review', assignee: 'reports_to', sla_days: 2, can_send_back: true,
          fields: [f('review_notes', 'Review notes', 'textarea', false, ['all'])],
        },
        {
          key: 'approve', name: 'CEO approval', assignee: 'role', role_key: 'ceo', sla_days: 2, can_send_back: true,
          fields: [f('approval_notes', 'Approval notes', 'textarea', false, ['all'])],
        },
      ],
      on_complete: [{ type: 'notify', config: { to: 'initiator', message: 'Your document was approved.' } }],
      on_reject: [{ type: 'notify', config: { to: 'initiator', message: 'Your document was not approved.' } }],
    },
  ]
}

/* ---------------- letters & email used by the templates ---------------- */
// The standard letters (appraisal, confirmation, joining, relieving, experience) come from the Documents defaults
// (seeds/documentsV7.ts). Workflows add the one letter Documents doesn't ship: the promotion letter. Placeholders
// follow the Documents catalogue (employee_first_name, signatory_name, …) plus the workflow variables.
export const WF_DOC_TEMPLATES: Pick<V7.DocTemplate, 'key' | 'name' | 'category' | 'body' | 'placeholders' | 'letterhead' | 'description'>[] = [
  {
    key: 'promotion_letter', name: 'Promotion letter', category: 'other', letterhead: true,
    description: 'Issued by the Promotion workflow: new designation, revised CTC and effective date.',
    placeholders: ['ref_no', 'today', 'employee_name', 'employee_code', 'employee_first_name', 'designation', 'new_designation', 'hike_pct', 'old_ctc', 'new_ctc', 'effective_from', 'company', 'signatory_name', 'signatory_designation'],
    body: `:::right
Ref: {{ref_no}}
Date: {{today}}
:::

**{{employee_name}}**
Employee code: {{employee_code}}

## Promotion letter

Dear {{employee_first_name}},

We are pleased to promote you from **{{designation}}** to **{{new_designation}}** with effect from **{{effective_from}}**.

| Component | Amount |
|---|---|
| Current annual CTC | {{old_ctc}} |
| Revised annual CTC | {{new_ctc}} |
| Increase | {{hike_pct}}% |

All other terms of your appointment remain unchanged. Congratulations on the new role.

Yours sincerely,

**{{signatory_name}}**
{{signatory_designation}}
For {{company}}`,
  },
]
export const WF_EMAIL_TEMPLATES: (Pick<EmailTemplate, 'name' | 'subject' | 'body'> & { key: string })[] = [
  {
    key: 'appraisal_letter', name: 'Appraisal letter',
    subject: 'Your appraisal letter — {{appraisal_period}}',
    body: 'Hi {{employee_name}},\n\nYour appraisal for {{appraisal_period}} is complete. Final rating: {{rating}}. Your revised annual CTC is {{new_ctc}} ({{hike_pct}}% hike), effective {{effective_from}}.\n\nYour appraisal letter is in SeereonOS under Documents → My documents: {{login_url}}\n\n{{company}} HR',
  },
]

/** Adds the workflow letter / email templates a tenant is missing (never duplicates a key). */
export function ensureWfLetters(db: DB, tenantId: string, base: () => E.Base) {
  for (const t of WF_DOC_TEMPLATES)
    if (!db.doc_templates.some((x) => x.tenant_id === tenantId && x.key === t.key)) db.doc_templates.push({ ...base(), ...t, custom_placeholders: [], active: true, updated_by: null } as V7.DocTemplate)
  for (const t of WF_EMAIL_TEMPLATES)
    if (!db.email_templates.some((x) => x.tenant_id === tenantId && x.key === t.key)) db.email_templates.push({ ...base(), ...t, active: true } as unknown as EmailTemplate)
}
/** Workflow templates + letters for a tenant (idempotent by template key). */
export function provisionWfTemplates(db: DB, tenantId: string, base: () => E.Base) {
  ensureWfLetters(db, tenantId, base)
  for (const t of defaultWfTemplates())
    if (!db.wf_templates.some((x) => x.tenant_id === tenantId && x.key === t.key)) db.wf_templates.push({ ...base(), ...t } as V7.WfTemplate)
}

/* ------------------------------------------------------------------ */
/* Demo seed                                                            */
/* ------------------------------------------------------------------ */
export function seed(db: DB, h: SeedHelpers) {
  for (const t of db.tenants) provisionWfTemplates(db, t.id, () => h.base(t.id))
  const T = db.tenants.find((t) => t.slug === 'seereon')
  if (!T) return
  const tid = T.id
  const today = h.today
  const user = (id: string) => db.users.find((u) => u.id === id)
  const tpl = (key: string) => db.wf_templates.find((x) => x.tenant_id === tid && x.key === key)!
  const ts = (d: string, hh = '05:30') => `${d}T${hh}:00.000Z`
  const snapOf = (t: V7.WfTemplate): V7.WfSnapshot => JSON.parse(JSON.stringify({ name: t.name, process: t.process, stages: t.stages, on_complete: t.on_complete, on_reject: t.on_reject }))
  const rateNow = (uid: string) => db.cost_rates.filter((r) => r.tenant_id === tid && r.user_id === uid && r.effective_from <= today).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
  const cycle = db.appraisal_cycles.find((c) => c.tenant_id === tid && c.id === 'ac_h1_fy2627')
  const apr = (k: string) => db.appraisals.find((a) => a.tenant_id === tid && a.id === `apr_h1_${k}`)
  const effective = addDays(today.slice(0, 8) + '01', 40).slice(0, 8) + '01' // first day of next month

  const selfVals = (g: number, c: number, o: number, ach: string) => ({
    goals_rating: g, competency_rating: c, overall_self_rating: o, achievements: ach,
    challenges: 'Context-switching between client escalations and planned sprint work in the second quarter.',
    development_needs: 'System design for multi-tenant products and leading client demos.',
  })
  type H = V7.WfInstance['history'][number]
  const mk = (key: string, subject: string, title: string, initiated: string, stageIdx: number, assignee: string | null, values: V7.WfInstance['values'], history: H[], extra: Partial<V7.WfInstance> = {}) => {
    const t = tpl(key)
    const st = t.stages[stageIdx]
    const inst: V7.WfInstance = {
      ...h.base(tid), id: h.id('wfi'), template_id: t.id, title, subject_user_id: subject, initiated_by: initiated, status: 'in_progress', current_stage: stageIdx, current_assignee_id: assignee,
      stage_due_on: st ? addDays(today, st.sla_days) : null, values, history, context: {}, outputs: [], template_rev: t.rev ?? 1, snapshot: snapOf(t),
      stage_started_at: history.length ? history[history.length - 1].at : ts(today), escalated_stage: null, comments: [], completed_at: null, ...extra,
    }
    inst.created_at = history[0]?.at ?? inst.created_at
    db.wf_instances.push(inst)
    return inst
  }
  const link = (inst: V7.WfInstance, k: string) => {
    const a = apr(k)
    const cur = rateNow(inst.subject_user_id!)
    inst.context = { cycle_id: cycle?.id ?? null, cycle_name: cycle?.name ?? null, appraisal_id: a?.id ?? null, current_ctc_paise: cur?.monthly_ctc_paise ?? null }
    return a
  }

  /* Hritesh — waiting at manager review (Subhankar) */
  if (user('u_hritesh') && cycle) {
    const d0 = addDays(today, -9)
    const i = mk('annual_appraisal', 'u_hritesh', `Annual appraisal ${cycle.name} — Hritesh Panda`, 'u_priya', 1, 'u_subhankar', {
      self: selfVals(4, 4, 4, 'Shipped 20 of 24 screens of the EduReon parent app, raised unit-test coverage on core services from 48% to 64% and ran 10 paired review sessions with the juniors.'),
    }, [
      { stage_key: 'self', by: 'u_priya', action: 'started', note: 'Started from the appraisal cycle', at: ts(d0, '04:40') },
      { stage_key: 'self', by: 'u_hritesh', action: 'submitted', note: '', at: ts(addDays(today, -3), '10:15') },
    ])
    i.stage_due_on = addDays(today, 4)
    const a = link(i, 'hritesh')
    if (a) Object.assign(a, { status: 'manager_pending', self_rating: 4, self_comments: (i.values.self.achievements as string), submitted_self_at: ts(addDays(today, -3), '10:15') })
  }

  /* Bijaya — waiting at HR review (Priya) */
  if (user('u_bijaya') && cycle) {
    const d0 = addDays(today, -12)
    const i = mk('annual_appraisal', 'u_bijaya', `Annual appraisal ${cycle.name} — Bijaya Jena`, 'u_priya', 3, 'u_priya', {
      self: selfVals(4, 3, 4, 'Brought the payroll run endpoint p95 down from 340 ms to 160 ms, closed 21 of 30 assigned bugs within SLA and finished 6 of 10 advanced FastAPI modules.'),
      manager: { delivery: 3, quality: 4, ownership: 3, collaboration: 4, overall_rating: 3.5, feedback: 'Solid quality on the payroll APIs and good with the QA team. Ownership of estimates needs work — two tasks slipped without an early flag.', recommended_hike_pct: 10, promotion: 'No', private_comments: 'Has asked about a move to the SAP practice; worth discussing at the HR one-to-one before the next cycle.' },
      unit_head: { calibrated_rating: 3.5, hike_decision: 'Modify', endorsed_hike_pct: 9, unit_comments: 'Calibrated against the delivery team; 9% keeps parity with peers at the same rating.' },
    }, [
      { stage_key: 'self', by: 'u_priya', action: 'started', note: 'Started from the appraisal cycle', at: ts(d0, '04:40') },
      { stage_key: 'self', by: 'u_bijaya', action: 'submitted', note: '', at: ts(addDays(today, -8), '11:05') },
      { stage_key: 'manager', by: 'u_subhankar', action: 'approved', note: '', at: ts(addDays(today, -5), '09:20') },
      { stage_key: 'unit_head', by: 'u_santosh', action: 'approved', note: '', at: ts(addDays(today, -1), '12:40') },
    ])
    i.stage_due_on = addDays(today, 2)
    const a = link(i, 'bijaya')
    if (a) Object.assign(a, { status: 'hr_pending', self_rating: 4, self_comments: i.values.self.achievements, manager_rating: 3.5, manager_comments: i.values.manager.feedback, submitted_self_at: ts(addDays(today, -8), '11:05'), submitted_manager_at: ts(addDays(today, -5), '09:20') })
  }

  /* Jagannath — completed: letter issued, CTC change waiting for a checker */
  if (user('u_jagannath') && cycle) {
    const jag = user('u_jagannath')!
    const d0 = addDays(today, -16)
    const cur = rateNow('u_jagannath')
    const hike = 12
    const newCtc = cur ? Math.round(cur.monthly_ctc_paise * (1 + hike / 100)) : 0
    const i = mk('annual_appraisal', 'u_jagannath', `Annual appraisal ${cycle.name} — Jagannath Nayak`, 'u_priya', 4, null, {
      self: selfVals(4, 4, 4, 'Implemented 15 of 18 payroll rules in the HRMS engine, documented all 40 public endpoints and kept 17 of 20 weeks incident-free.'),
      manager: { delivery: 4, quality: 4, ownership: 4, collaboration: 3, overall_rating: 4, feedback: 'Dependable owner of the payroll engine with complete API documentation. Should pull the QA team in earlier on rule changes.', recommended_hike_pct: 12, promotion: 'Ready in 6 months', private_comments: 'Strong retention priority — has an outside offer feeler from a Pune product company.' },
      unit_head: { calibrated_rating: 4, hike_decision: 'Endorse', endorsed_hike_pct: 12, unit_comments: 'Endorsed.' },
      hr: { band_check: 'Within band', final_rating: 4, normalised_hike_pct: 12, new_designation: '', effective_date: effective, hr_comments: 'Within the L2 band after the revision.' },
      finance: { approved_hike_pct: hike, override_reason: '', finance_comments: 'Approved within the FY26-27 increment budget.' },
    }, [
      { stage_key: 'self', by: 'u_priya', action: 'started', note: 'Started from the appraisal cycle', at: ts(d0, '04:40') },
      { stage_key: 'self', by: 'u_jagannath', action: 'submitted', note: '', at: ts(addDays(today, -13), '10:00') },
      { stage_key: 'manager', by: 'u_subhankar', action: 'approved', note: '', at: ts(addDays(today, -10), '15:30') },
      { stage_key: 'unit_head', by: 'u_santosh', action: 'approved', note: '', at: ts(addDays(today, -7), '11:10') },
      { stage_key: 'hr', by: 'u_priya', action: 'approved', note: '', at: ts(addDays(today, -4), '12:00') },
      { stage_key: 'finance', by: 'u_santosh', action: 'approved', note: '', at: ts(addDays(today, -2), '09:45') },
      { stage_key: 'finance', by: 'u_santosh', action: 'completed', note: 'Appraisal letter issued and emailed; new CTC sent to Cost rates for approval', at: ts(addDays(today, -2), '09:45') },
    ], { status: 'completed', stage_due_on: null, completed_at: ts(addDays(today, -2), '09:45') })
    const a = link(i, 'jagannath')
    // letter + email, rendered exactly like issueDocument / runActions do at runtime
    const doc = db.doc_templates.find((x) => x.tenant_id === tid && x.key === 'appraisal_letter' && x.active)
    const on = addDays(today, -2)
    const std = standardVarsFor(db, tid, jag.id, 'u_santosh', on)
    const vars: Record<string, string> = {
      ...std, appraisal_period: cycle.name, rating: '4 / 5', hike_pct: String(hike), new_designation: std.designation, effective_from: longDate(effective),
      old_ctc: fmtMoney((cur?.monthly_ctc_paise ?? 0) * 12), new_ctc: fmtMoney(newCtc * 12), current_monthly_ctc: fmtMoney(cur?.monthly_ctc_paise ?? 0), new_monthly_ctc: fmtMoney(newCtc),
      ref_no: `${T.org?.employee_code_prefix || 'DOC'}/HR/${on.slice(0, 4)}/WF${String(db.issued_documents.filter((d) => d.tenant_id === tid).length + 1).padStart(3, '0')}`,
    }
    if (doc) {
      const { body_md, body_html } = renderBody(doc.body, vars)
      const d = {
        ...h.base(tid), id: h.id('isd'), created_at: ts(on, '09:45'), updated_at: ts(on, '09:45'), template_id: doc.id, category: doc.category, title: `${doc.name} ${cycle.name} — ${jag.name}`, employee_id: jag.id,
        body_html, body_md, vars: { ref_no: vars.ref_no, appraisal_period: vars.appraisal_period, rating: vars.rating, hike_pct: vars.hike_pct, new_designation: vars.new_designation, effective_from: vars.effective_from, old_ctc: vars.old_ctc, new_ctc: vars.new_ctc },
        letterhead: true, ref_no: vars.ref_no, period: cycle.name, status: 'issued', issued_by: 'u_santosh', issued_on: on, acknowledged_on: null, source: { kind: 'workflow', ref_id: i.id },
        revoked_on: null, revoked_by: null, revoke_reason: null, replaces_id: null, replaced_by_id: null, emailed_to: jag.email,
      } as V7.IssuedDocument
      db.issued_documents.push(d)
      i.outputs.push({ kind: 'document', ref_id: d.id, label: d.title })
    }
    const et = db.email_templates.find((x) => x.tenant_id === tid && (x.key as string) === 'appraisal_letter')
    if (et) {
      const all = { ...vars, login_url: 'https://app.seereonos.com/login', company: T.org?.brand_name || T.name }
      const m = { ...h.base(tid), id: h.id('eml'), created_at: ts(on, '09:45'), updated_at: ts(on, '09:45'), to: jag.email, to_user_id: jag.id, subject: renderTemplate(et.subject, all), body: renderTemplate(et.body, all), template_key: 'appraisal_letter', related_entity: 'wf_instance', related_id: i.id, status: 'sent', sent_at: ts(on, '09:45') }
      db.email_outbox.push(m as never)
      i.outputs.push({ kind: 'email', ref_id: m.id, label: `${m.subject} → ${jag.email}` })
    }
    if (cur) {
      const hist = db.cost_rates.filter((r) => r.tenant_id === tid && r.user_id === jag.id)
      const show = (c: number, from: string) => ({ 'Monthly CTC': fmtMoney(c), 'Variable pay': `${cur.variable_pct}%`, 'Effective from': from })
      const cs: ChangeSet = {
        ...h.base(tid), id: h.id('cs'), entity: 'cost_rate', entity_id: jag.id, action: 'create', summary: `New rate for ${jag.name}: ${fmtMoney(newCtc)}/month from ${effective} (+${hike}.0%) — appraisal ${cycle.name}`,
        before: show(cur.monthly_ctc_paise, cur.effective_from), after: show(newCtc, effective),
        payload: { op: 'add', user_id: jag.id, monthly_ctc_paise: newCtc, variable_pct: cur.variable_pct, sales_target_paise: null, effective_from: effective, source: 'workflow', wf_instance_id: i.id },
        maker_id: 'u_santosh', required_permission: 'cost_rates.edit', base_version: hist.length, status: 'pending', checker_id: null, decided_at: null, reason: null, applied_at: null, result_id: null, error: null,
      }
      cs.created_at = ts(addDays(today, -2), '09:45')
      db.change_sets.push(cs)
      i.outputs.unshift({ kind: 'cost_rate_change', ref_id: cs.id, label: `New CTC ${fmtMoney(newCtc)}/month from ${fmtDate(effective)}` })
    }
    if (a) Object.assign(a, {
      status: 'completed', self_rating: 4, self_comments: i.values.self.achievements, manager_rating: 4, manager_comments: i.values.manager.feedback, hr_rating: 4, hr_comments: 'Within the L2 band after the revision.',
      final_rating: 4, increment_pct: hike, promotion_to: null, submitted_self_at: ts(addDays(today, -13), '10:00'), submitted_manager_at: ts(addDays(today, -10), '15:30'), closed_at: ts(addDays(today, -2), '09:45'),
    })
  }

  /* Onboarding in progress — Ritika (invited, joining in 6 days): HR done, waiting on IT & admin (Debasish) */
  const ritika = db.invites.find((x) => x.tenant_id === tid && x.email === 'ritika@seereon.co.in')
  if (ritika) {
    const i = mk('employee_onboarding', ritika.id, 'Onboarding — Ritika Senapati', 'u_priya', 1, 'u_debasish', {
      hr: { joining_date: addDays(today, 6), documents_verified: true, offer_signed: true, hr_notes: 'Joins the EduReon team under Subhankar. Needs Git, Jira and the staging VPN on day one.' },
    }, [
      { stage_key: 'hr', by: 'u_priya', action: 'started', note: '', at: ts(addDays(today, -4), '06:00') },
      { stage_key: 'hr', by: 'u_priya', action: 'submitted', note: '', at: ts(addDays(today, -1), '07:20') },
    ])
    i.stage_due_on = addDays(today, 1)
    i.context = { candidate: true, joining_on: addDays(today, 6) }
  }
}
