// Documents seed: project libraries + company library for Seereon; a light set for Kalinga.
// Files are tiny generated placeholders (PDF / Markdown / CSV / PNG data URLs) or links to SharePoint/Drive.
import type { DB } from '../server'
import type { SeedHelpers } from './index'
import type { DocCategory, DocVisibility, DocumentRec, DocumentVersion } from '@/types/business'
import { addDays } from '@/domain/calendar'

const MOCKUP_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAeAAAAEsBAMAAADp0H1pAAAAMFBMVEX////k5+t4gIova0/19vcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/i1chAAAD/0lEQVR42u3dXW7iMBDA8aTdd9wboJ4AiSvs8RcpJ0DcIOYAkH1YqFYRkT9mWmcmf79mXPeH4/iT0P/uytKf2JlOb93GEmDAgAEDBgy4XfrlQvF+SIacPNVwhrc7imv4U/Q/3i/W2vBbo3JfpUNBUHXBe+E/ubdWw3RLgAEDBgwYMODq2dKYCOyDrxqeUoHzAOngv/XkISYjZxF3Wbn35rd0cTrz0GqWhoIguiWL6ZZRxSdxG16V+MTAA/DWwemBo7OhZZ8K7J3U8NdT+oM2DNjXLZ2b+o+NgafILQ0YMGDAgAEDBgwY8KZnS6mFzpzjfZZq+JYKvDmr4SEZOcyquGbDeGyct5PsPOzG8jwhts0reWj1NQsB17Z5ReBdTaYpNM1LPwwYMGCz4PTA0cnQ8jnweE8FvgxYHPVkDA4a5f0aaR1rPq6QMbRZWV4eWoABAwbsFxyLLzTPKztrOY3m8nJLAwYMGDBgwO2SbPfwbZ8sYPH7XI3yynYP0+UuhzTK+wQPyb8w0IYBAwYMGDBgwDrgQzLy4Atct3toefJwpA1npIsgpFFe2br0/WwuL90SYMCAAQMGbBB8rcn0OM7eKq8I/N8h8/y0a5tXNrS8VrzuYWycVwQ2eL6Dh9YWEt89XEo3Z7f0kIwcaMOAAQMGDBjwd420yueYwRR0nIEPyXHFfGi5G02Bn99Zq949rPoufsN0nd/SpbuHO2Pg6VHFPKUBAwYMGDBgwIABA/7p+fC/z2tfFn+um1hLXt4yyyys4b1CfMZCgigk0Ia32YbZPZwldg9pw5sAXxTiYzqbKCRqDjzuCr9vOakscOf+FW5pwIABmwSnB45OhpbVby4199tp06wfLt09NPfbaYGHFmDAgAHb6YcrU+lhrbHub2RM/ZbX3E6aNRwU4oNKMYfMK7RhwIABA3YMjgrxUaWYIfOKcOChsaassy59O+XFsXu4+Ak6a8ODoJHwlAYM2OB82Py6dHH+aAwcaMOAXYPTA0dnQ0veXEo//Lo3DmXx37cu/UPnpYNCfFApJmReoVsCDBgwYMfgqBAfVYqJmVfcrEtzXhowYMCANz0fZl167SnQhgEDBgzYcT/86I1DWTzr0h3r0rRhwIABA1YDR4X4qFJMzLzCujS3NGDAgAF7mA+zLr32FGjDgAEDBuy4H370xqEsnvd4dLzHgzYMGDBgwGrgqBAfVYoZMq9s7j0e3NKAAQMG7HI+zLr02lOgDQMGDBiw43740RuHsnjOS3ecl6YNAwYMGLAaOCrER5ViYuYVzktzSwMGDBiwh/kw69JrT4E2DBjwpsFXY9A+CsFTsAXeiaeHV1sd8SgG60xjeWgBBgwYMGDAgAEDBgwY8CrSX1sx9b3qwgHXAAAAAElFTkSuQmCC'

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)))
const textURL = (mime: string, s: string) => `data:${mime};base64,${b64(s)}`

/** A minimal, valid one-page PDF with a title and a few lines of text (ASCII only). */
function pdfURL(title: string, lines: string[]): { url: string; size: number } {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => '\\' + c).replace(/[^\x20-\x7e]/g, '-')
  let stream = 'BT /F1 18 Tf 56 770 Td (' + esc(title) + ') Tj ET\n'
  lines.forEach((l, i) => (stream += 'BT /F1 11 Tf 56 ' + (736 - i * 18) + ' Td (' + esc(l) + ') Tj ET\n'))
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => {
    offs.push(out.length)
    out += i + 1 + ' 0 obj\n' + o + '\nendobj\n'
  })
  const xref = out.length
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF'
  return { url: 'data:application/pdf;base64,' + btoa(out), size: out.length }
}

type Src =
  | { kind: 'pdf'; lines: string[] }
  | { kind: 'md'; text: string }
  | { kind: 'csv'; text: string }
  | { kind: 'png'; url: string; size: number }
  | { kind: 'link'; url: string; ext: 'docx' | 'xlsx' | 'pptx' | 'pdf'; size?: number }
interface V {
  note: string
  by: string
  ago: number // days ago
  src: Src
  name?: string
}
interface D {
  key: string
  project: string | null
  title: string
  description: string
  category: DocCategory
  visibility?: DocVisibility
  must_read?: boolean
  tags?: string[]
  owner: string
  versions: V[]
  acks?: Record<string, number> // user key → version acknowledged
  views?: string[]
  archived?: boolean
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  csv: 'text/csv',
  png: 'image/png',
}
const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')

const SEEREON: D[] = [
  /* ---- SeerHR — Mining Group HRMS ---- */
  {
    key: 'hrms_brd', project: 'p_hrms', title: 'Business requirements (BRD)', category: 'requirements', must_read: true, owner: 'subhankar', tags: ['brd', 'scope'],
    description: 'Signed-off scope for SeerHR: core HR, payroll, statutory compliance (PF, ESI, mines welfare) and shift attendance for 4 mine sites.',
    versions: [
      { note: 'First draft after discovery workshops', by: 'subhankar', ago: 52, src: { kind: 'pdf', lines: ['SeerHR - Business Requirements', 'Client: Mahanadi Minerals Group', 'Version 1 - discovery draft', '', '1. Core HR and employee master', '2. Payroll with PF / ESI / PT', '3. Shift attendance for 4 mine sites'] } },
      { note: 'Added contract labour and shift rules agreed in gap analysis', by: 'subhankar', ago: 30, src: { kind: 'pdf', lines: ['SeerHR - Business Requirements', 'Client: Mahanadi Minerals Group', 'Version 2 - signed off', '', '1. Core HR and employee master', '2. Payroll with PF / ESI / PT and arrears', '3. Shift attendance (A/B/C/General) for 4 sites', '4. Contract labour register (Form XIII)', '5. Mines welfare reports'] } },
    ],
    acks: { hritesh: 2, bijaya: 2, jagannath: 1, jayashree: 2 }, views: ['hritesh', 'bijaya', 'jagannath', 'jayashree', 'pragyasmita'],
  },
  {
    key: 'hrms_gap', project: 'p_hrms', title: 'Gap analysis sign-off', category: 'requirements', owner: 'subhankar', tags: ['sign-off'],
    description: 'Gap analysis between the client’s current SAP HCM process and SeerHR, with the client’s sign-off on each gap.',
    versions: [{ note: 'Client signed copy', by: 'subhankar', ago: 34, src: { kind: 'pdf', lines: ['Gap analysis sign-off', '42 gaps reviewed - 38 accepted, 4 deferred to phase 2', 'Signed: HR Head, Mahanadi Minerals Group'] } }],
    views: ['hritesh', 'jagannath'],
  },
  {
    key: 'hrms_api', project: 'p_hrms', title: 'Payroll API specification', category: 'technical', owner: 'subhankar', tags: ['api', 'payroll'],
    description: 'REST contract for payroll runs, payslips and statutory exports. FastAPI services own these endpoints.',
    versions: [
      { note: 'Initial endpoints', by: 'jagannath', ago: 26, src: { kind: 'md', text: '# Payroll API\n\n## POST /payroll/runs\nStart a run for a month.\n\n## GET /payroll/runs/{id}/payslips\nList payslips.\n' } },
      { note: 'Added arrears and statutory export endpoints', by: 'jagannath', ago: 9, src: { kind: 'md', text: '# Payroll API (v2)\n\n## POST /payroll/runs\nStart a run for a month.\n\n## POST /payroll/runs/{id}/arrears\nCompute arrears from effective-dated salary structures.\n\n## GET /payroll/runs/{id}/exports/pf-ecr\nPF ECR text file.\n\n## GET /payroll/runs/{id}/payslips\nList payslips.\n' } },
    ],
    views: ['hritesh', 'jayashree'],
  },
  {
    key: 'hrms_test', project: 'p_hrms', title: 'Test plan — Core HR & payroll', category: 'test', must_read: true, owner: 'subhankar', tags: ['uat', 'qa'],
    description: 'Scenarios, test data and exit criteria for the Core HR & payroll milestone. Read before picking up any QA task.',
    versions: [{ note: 'Test plan for milestone 2', by: 'subhankar', ago: 6, src: { kind: 'md', text: '# Test plan - Core HR & payroll\n\n| # | Scenario | Expected |\n|---|---|---|\n| 1 | Join mid-month | Pro-rated salary |\n| 2 | PF wage ceiling | Capped at 15,000 |\n| 3 | Night shift allowance | Paid for C shift |\n\nExit criteria: zero open P1 defects.\n' } }],
    acks: { bijaya: 1 }, views: ['bijaya'],
  },
  {
    key: 'hrms_matrix', project: 'p_hrms', title: 'Payroll rules matrix', category: 'technical', owner: 'subhankar', tags: ['payroll', 'statutory'],
    description: 'Earning and deduction rules per employee grade and site, maintained with the client’s payroll team.',
    versions: [{ note: 'Matrix agreed with client payroll team', by: 'subhankar', ago: 18, name: 'Payroll rules matrix.xlsx', src: { kind: 'link', url: 'https://seereon.sharepoint.com/sites/delivery/SeerHR/Payroll%20rules%20matrix.xlsx', ext: 'xlsx', size: 48_640 } }],
  },
  /* ---- EduReon — Mother's Group of Schools ---- */
  {
    key: 'mgs_fee', project: 'p_mgs', title: 'Fee structure sheet 2026–27', category: 'requirements', owner: 'subhankar', tags: ['fees'],
    description: 'Class-wise fee heads, instalments and concessions for both campuses, as shared by the school accounts office.',
    versions: [{ note: 'Received from school accounts', by: 'subhankar', ago: 60, name: 'Fee structure 2026-27.csv', src: { kind: 'csv', text: 'Class,Tuition (per term),Development,Transport (per month),Instalments\nNursery,18000,4000,1500,3\nI-V,22000,5000,1500,3\nVI-VIII,26000,6000,1800,3\nIX-X,30000,7000,1800,3\n' } }],
    views: ['pragyasmita', 'jayashree'],
  },
  {
    key: 'mgs_mig', project: 'p_mgs', title: 'Data migration template', category: 'other', owner: 'subhankar', tags: ['migration', 'template'],
    description: 'Template the school fills for student, guardian and fee-balance migration. One row per student.',
    versions: [
      { note: 'First template', by: 'pragyasmita', ago: 50, name: 'Student migration template.csv', src: { kind: 'csv', text: 'admission_no,student_name,class,section,guardian_name,guardian_phone\n' } },
      { note: 'Added opening fee balance column', by: 'pragyasmita', ago: 40, name: 'Student migration template.csv', src: { kind: 'csv', text: 'admission_no,student_name,class,section,guardian_name,guardian_phone,opening_fee_balance\nMGS-1001,Sample Student,V,A,Sample Guardian,9000000000,0\n' } },
    ],
  },
  {
    key: 'mgs_golive', project: 'p_mgs', title: 'Go-live checklist — both campuses', category: 'test', must_read: true, owner: 'subhankar', tags: ['go-live'],
    description: 'Cut-over steps, owners and sign-offs for the go-live of both campuses.',
    versions: [{ note: 'Checklist for go-live milestone', by: 'subhankar', ago: 4, src: { kind: 'md', text: '# Go-live checklist\n\n- [ ] Final data migration verified by school office\n- [ ] Fee receipts printer tested at both campuses\n- [ ] Parent app published on Play Store\n- [ ] Admin training completed\n- [ ] Rollback plan reviewed\n' } }],
    acks: { pragyasmita: 1 }, views: ['pragyasmita'],
  },
  /* ---- Sales CRM Phase 2 ---- */
  {
    key: 'crm_sow', project: 'p_crm', title: 'Statement of work — Phase 2', category: 'contract', visibility: 'managers', owner: 'subhankar', tags: ['sow', 'commercials'],
    description: 'Signed SOW with Digitalratha: scope, milestones, commercials and change-request terms.',
    versions: [{ note: 'Countersigned SOW', by: 'subhankar', ago: 31, src: { kind: 'pdf', lines: ['Statement of Work - Sales CRM Phase 2', 'Client: Digitalratha', 'Milestones: Build (2.0 L), Go-live (1.0 L)', 'Change requests billed at agreed day rate'] } }],
  },
  {
    key: 'crm_ui', project: 'p_crm', title: 'UI mockups — pipeline & lead screens', category: 'design', owner: 'subhankar', tags: ['ui', 'figma'],
    description: 'Approved wireframes for the pipeline board, lead detail and the field-sales activity log.',
    versions: [{ note: 'Approved by client on review call', by: 'jayashree', ago: 21, name: 'Pipeline wireframe.png', src: { kind: 'png', url: MOCKUP_PNG, size: 1140 } }],
    views: ['jayashree', 'bijaya'],
  },
  /* ---- RCU (Santosh is PM) ---- */
  {
    key: 'rcu_pc', project: 'p_rcu', title: 'Petty cash RAP — technical design', category: 'design', owner: 'santosh', tags: ['sap', 'rap', 'abap'],
    description: 'RAP business object design for petty cash request, invoice booking and the finance dashboard (PCINV / PCFIN).',
    versions: [{ note: 'Design after the header/item split', by: 'santosh', ago: 25, src: { kind: 'pdf', lines: ['Petty Cash RAP - Technical design', 'Root: ZI_PCINV_HDR, items: ZI_PCINV_ITM', 'Finance dashboard: ZSD_PCFIN_DASHBOARD', 'Budget reservation on submit; release on reject'] } }],
  },
  {
    key: 'rcu_cpi', project: 'p_rcu', title: 'CPI iFlow specification — SF to Ariba delegations', category: 'technical', owner: 'santosh', tags: ['sap', 'cpi', 'successfactors'],
    description: 'Integration spec for the SuccessFactors delegation sync to Ariba: mapping, schedule and error handling.',
    versions: [{ note: 'Spec for CPI build', by: 'santosh', ago: 12, name: 'SF-Ariba delegations iFlow spec.docx', src: { kind: 'link', url: 'https://seereon.sharepoint.com/sites/rcu/CPI/SF-Ariba-delegations-spec.docx', ext: 'docx', size: 212_480 } }],
  },
  /* ---- Company library ---- */
  {
    key: 'co_handbook', project: null, title: 'Employee handbook v1.0', category: 'policy', must_read: true, owner: 'priya', tags: ['hr', 'policy'],
    description: 'Working hours, Saturdays, probation, appraisal cycles, conduct and pay. Every employee must read and acknowledge.',
    versions: [{ note: 'Revised handbook, September 2026', by: 'priya', ago: 28, src: { kind: 'pdf', lines: ['Seereon Employee Handbook - v1.0', 'Working hours: 9:30 to 6:30, Monday to Friday', '1st and 3rd Saturdays are working days', 'Probation: 6 months', 'Appraisal cycles: April and October'] } }],
    acks: { subhankar: 1, hritesh: 1, bijaya: 1, jagannath: 1, jayashree: 1, pragyasmita: 1, baishali: 1, priya: 1, santosh: 1 }, views: ['hritesh', 'bijaya', 'baishali'],
  },
  {
    key: 'co_leave', project: null, title: 'Leave policy', category: 'policy', must_read: true, owner: 'priya', tags: ['hr', 'leave'],
    description: 'Casual, sick and earned leave entitlements, how to apply, and carry-forward rules.',
    versions: [
      { note: 'First version', by: 'priya', ago: 120, src: { kind: 'md', text: '# Leave policy\n\n- Casual leave: 8 days\n- Sick leave: 6 days\n- Earned leave: 12 days\n' } },
      { note: 'Earned leave carry-forward capped at 15 days', by: 'priya', ago: 8, src: { kind: 'md', text: '# Leave policy (v2)\n\n- Casual leave: 8 days a year\n- Sick leave: 6 days a year\n- Earned leave: 12 days a year, carry forward up to 15 days\n- Apply in SeereonOS at least 3 working days ahead (except sickness)\n' } },
    ],
    acks: { subhankar: 2, bijaya: 2, priya: 2, santosh: 2, hritesh: 1, jagannath: 1, jayashree: 1, baishali: 1 }, views: ['bijaya', 'subhankar'],
  },
  {
    key: 'co_timesheet', project: null, title: 'Timesheet policy', category: 'policy', must_read: true, owner: 'priya', tags: ['timesheet'],
    description: 'Log hours daily against tasks; submit by Friday 7 pm; what counts as internal time.',
    versions: [{ note: 'Policy effective from April', by: 'priya', ago: 70, src: { kind: 'md', text: '# Timesheet policy\n\n1. Log time every day against your tasks.\n2. Submit the week by Friday 7 pm.\n3. Internal codes: presales, admin, meeting, learning.\n4. Weeks not submitted by Monday noon are escalated to your manager.\n' } }],
    acks: { hritesh: 1, bijaya: 1, jagannath: 1, jayashree: 1, subhankar: 1, priya: 1 },
  },
  {
    key: 'co_expense', project: null, title: 'Expense reimbursement policy', category: 'policy', must_read: true, owner: 'priya', tags: ['finance', 'expenses'],
    description: 'What can be claimed, limits per category, bills required and the approval path.',
    versions: [{ note: 'Approved by CEO', by: 'priya', ago: 15, src: { kind: 'pdf', lines: ['Expense reimbursement policy', 'Local travel: actuals with receipts', 'Client meals: up to Rs 1,500 per head', 'Claims within 30 days, approved by reporting manager'] } }],
    acks: { subhankar: 1, baishali: 1, priya: 1 },
  },
  {
    key: 'co_review', project: null, title: 'Code review checklist', category: 'process', owner: 'subhankar', tags: ['engineering', 'quality'],
    description: 'What every pull request must pass before merge: tests, naming, security, and performance checks.',
    versions: [{ note: 'Checklist used in sprint reviews', by: 'subhankar', ago: 40, src: { kind: 'md', text: '# Code review checklist\n\n- [ ] Tests added or updated\n- [ ] No secrets in code or config\n- [ ] Inputs validated on the server\n- [ ] Queries indexed; no N+1\n- [ ] Clear names, no dead code\n' } }],
    views: ['hritesh', 'jagannath', 'jayashree'],
  },
  {
    key: 'co_iso', project: null, title: 'ISO 9001:2015 quality manual', category: 'process', owner: 'santosh', tags: ['iso', 'quality'],
    description: 'Seereon’s quality management system: scope, processes, roles, document control and internal audits.',
    versions: [{ note: 'Issue 3 after surveillance audit', by: 'santosh', ago: 38, src: { kind: 'pdf', lines: ['Quality Manual - ISO 9001:2015', 'Issue 3', 'Scope: software development and IT consulting', 'Document control: SeereonOS Documents', 'Internal audit: twice a year'] } }],
  },
  {
    key: 'co_onboarding', project: null, title: 'New joiner onboarding guide', category: 'training', owner: 'priya', tags: ['onboarding'],
    description: 'First-week checklist for new joiners: accounts, laptop, tools, who to meet and how we work.',
    versions: [{ note: 'Updated tool list', by: 'priya', ago: 22, src: { kind: 'md', text: '# Onboarding guide\n\nDay 1: laptop, email, SeereonOS login.\nDay 2: project walkthrough with your PM.\nDay 3: code review checklist and timesheet policy.\nWeek 1: first task with a buddy.\n' } }],
  },
  {
    key: 'co_sow_tpl', project: null, title: 'SOW template', category: 'other', visibility: 'managers', owner: 'santosh', tags: ['template', 'sales'],
    description: 'Statement-of-work template with standard scope, milestone and change-request clauses.',
    versions: [{ note: 'Standard template', by: 'santosh', ago: 90, name: 'Seereon SOW template.docx', src: { kind: 'link', url: 'https://seereon.sharepoint.com/sites/company/Templates/SOW-template.docx', ext: 'docx', size: 64_200 } }],
  },
]

function materialise(db: DB, h: SeedHelpers, tenant: string, userId: (k: string) => string, list: D[], prefix: string) {
  for (const d of list) {
    const id = `doc_${prefix}${d.key}`
    const last = d.versions[d.versions.length - 1]
    const doc: DocumentRec = {
      ...h.base(tenant), id, project_id: d.project, title: d.title, description: d.description, category: d.category,
      visibility: d.visibility ?? (d.project ? 'project' : 'company'), must_read: !!d.must_read, tags: d.tags ?? [], owner_id: userId(d.owner),
      current_version: d.versions.length, archived: !!d.archived,
    }
    doc.created_at = addDays(h.today, -d.versions[0].ago) + 'T06:30:00Z'
    doc.updated_at = addDays(h.today, -last.ago) + 'T06:30:00Z'
    doc.created_by = userId(d.owner)
    db.documents.push(doc)
    d.versions.forEach((v, i) => {
      const vid = `${id}_v${i + 1}`
      const at = addDays(h.today, -v.ago) + 'T0' + (5 + (i % 4)) + ':15:00Z'
      let file_id: string | null = null
      let url: string | null = null
      let mime: string
      let size: number
      let name: string
      const s = v.src
      if (s.kind === 'link') {
        url = s.url
        mime = MIME[s.ext]
        size = s.size ?? 0
        name = v.name ?? slug(d.title) + '.' + s.ext
      } else {
        let data: string
        if (s.kind === 'pdf') {
          const p = pdfURL(d.title, s.lines)
          data = p.url
          size = p.size
        } else if (s.kind === 'png') {
          data = s.url
          size = s.size
        } else {
          data = textURL(MIME[s.kind], s.text)
          size = new TextEncoder().encode(s.text).length
        }
        mime = MIME[s.kind]
        name = v.name ?? slug(d.title) + (d.versions.length > 1 ? `-v${i + 1}` : '') + '.' + s.kind
        file_id = `file_${vid}`
        db.files.push({ ...h.base(tenant), id: file_id, name, mime, size_bytes: size, entity: 'document_version', entity_id: vid, data_url: data })
      }
      const ver: DocumentVersion = { ...h.base(tenant), id: vid, document_id: id, version: i + 1, file_id, url, file_name: name, size_bytes: size, mime, note: v.note, uploaded_by: userId(v.by), uploaded_at: at }
      ver.created_at = at
      ver.updated_at = at
      db.document_versions.push(ver)
    })
    const acks = { ...(d.acks ?? {}) }
    if (d.must_read && !acks[last.by]) acks[last.by] = d.versions.length // the uploader has read what they published
    for (const [u, ver] of Object.entries(acks)) {
      const vAgo = d.versions[ver - 1]?.ago ?? last.ago
      const at = addDays(h.today, -Math.max(0, vAgo - 1 - Math.floor(h.rnd() * Math.min(3, vAgo)))) + 'T10:' + String(10 + Math.floor(h.rnd() * 40)) + ':00Z'
      db.document_acks.push({ ...h.base(tenant), document_id: id, version: ver, user_id: userId(u), at })
    }
    for (const u of d.views ?? []) {
      const at = addDays(h.today, -Math.max(0, last.ago - 1 - Math.floor(h.rnd() * 3))) + 'T09:' + String(10 + Math.floor(h.rnd() * 40)) + ':00Z'
      db.document_views.push({ ...h.base(tenant), document_id: id, user_id: userId(u), at })
    }
  }
}

const KALINGA: D[] = [
  {
    key: 'leave', project: null, title: 'Leave policy', category: 'policy', must_read: true, owner: 'ananya', tags: ['hr'],
    description: 'Leave entitlements for Kalinga Softworks.',
    versions: [{ note: 'First version', by: 'ananya', ago: 4, src: { kind: 'md', text: '# Leave policy\n\n- Casual leave: 10 days\n- Sick leave: 7 days\n' } }],
    acks: { ananya: 1, rakesh: 1 },
  },
  {
    key: 'opd_brd', project: 'p_k_1', title: 'OPD booking requirements', category: 'requirements', owner: 'rakesh', tags: ['brd'],
    description: 'Patient booking, doctor schedules and SMS reminders.',
    versions: [{ note: 'Draft from client workshop', by: 'rakesh', ago: 3, src: { kind: 'pdf', lines: ['OPD booking - requirements', 'Client: Kalinga Hospital', 'Patient booking, doctor schedules, SMS reminders'] } }],
  },
]

export function seed(db: DB, h: SeedHelpers) {
  const users = new Set(db.users.map((u) => u.id))
  const seereon = (k: string) => `u_${k}`
  if (db.tenants.some((t) => t.id === 'tn_seereon') && users.has('u_santosh')) materialise(db, h, 'tn_seereon', seereon, SEEREON, '')
  if (db.tenants.some((t) => t.id === 'tn_kalinga') && users.has('u_k_ananya')) materialise(db, h, 'tn_kalinga', (k) => `u_k_${k}`, KALINGA, 'k_')
}
