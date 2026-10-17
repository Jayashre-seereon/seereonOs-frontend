// v4 access provisioning: default roles, maker-checker config, approval workflows and the system
// email templates. `provisionTenant` runs for seeded tenants and for every new signup, so a fresh
// workspace starts with the same building blocks. Master data (org profile, locations, departments…)
// is provisioned by ./master.
import type { DB } from '../server'
import type * as E from '@/types/entities'
import type { EmailTemplate, MakerCheckerConfig } from '@/types/access'
import { DEFAULT_ROLES } from '@/domain/permissionCatalog'
import { provisionWorkflows } from '../workflows'
import type { SeedHelpers } from './index'
import { provisionMaster, seedMaster } from './master'
import { provisionDocDefaults } from '../docgen'
import { provisionWfTemplates } from './workflows'

export const SYSTEM_EMAIL_TEMPLATES: Pick<EmailTemplate, 'key' | 'name' | 'subject' | 'body'>[] = [
  {
    key: 'welcome', name: 'Welcome & login details',
    subject: 'Welcome to {{company}}, {{employee_name}} — your SeereonOS login',
    body: 'Hi {{employee_name}},\n\nWelcome to {{company}}! Your SeereonOS account is ready.\n\nSign in: {{login_url}}\nUsername: {{username}}\nTemporary password: {{temp_password}}\n\nYou will be asked to set your own password the first time you sign in.\n\nYour role: {{role_name}}\nReporting manager: {{manager_name}}\nJoining date: {{joining_date}}\n\nSee you on day one,\n{{company}} HR',
  },
  {
    key: 'password_reset', name: 'Password reset by admin',
    subject: 'Your {{company}} SeereonOS password was reset',
    body: 'Hi {{employee_name}},\n\nAn administrator reset your SeereonOS password.\n\nSign in: {{login_url}}\nUsername: {{username}}\nTemporary password: {{temp_password}}\n\nYou will be asked to choose a new password when you sign in.\n\n{{company}} HR',
  },
  { key: 'leave_decision', name: 'Leave decision', subject: 'Your leave request was {{decision}}', body: 'Hi {{employee_name}},\n\n{{manager_name}} {{decision}} your leave from {{from_date}} to {{to_date}}.\n{{reason}}\n\n{{company}}' },
  { key: 'expense_decision', name: 'Expense decision', subject: 'Your expense claim was {{decision}}', body: 'Hi {{employee_name}},\n\nYour claim of {{amount}} for "{{description}}" was {{decision}} by {{approver_name}}.\n{{reason}}\n\n{{company}}' },
  { key: 'task_assigned', name: 'Task assigned', subject: 'New task: {{task_title}}', body: 'Hi {{employee_name}},\n\n{{manager_name}} assigned you "{{task_title}}", due {{due_date}}.\n\nOpen it: {{login_url}}\n\n{{company}}' },
  { key: 'appraisal_completed', name: 'Appraisal completed', subject: 'Your {{cycle_name}} appraisal is complete', body: 'Hi {{employee_name}},\n\nYour appraisal for {{cycle_name}} is complete. Final rating: {{rating}}.\n\nSee the details in SeereonOS: {{login_url}}\n\n{{company}} HR' },
]

/** Defaults for a brand-new (single-admin) workspace: maker-checker available but off. */
export const NEW_TENANT_MC: MakerCheckerConfig = { enabled: false, entities: ['role', 'user_access', 'cost_rate', 'workflow', 'payroll_finalise', 'vendor', 'org_profile'], sla_days: 2 }

/** `v7Defaults: false` is only for the demo seed, whose documents/workflows seeds provision these later (keeps seeded ids stable). */
export function provisionTenant(db: DB, tenant: E.Tenant, base: () => E.Base, opts: { v7Defaults?: boolean } = {}) {
  for (const r of DEFAULT_ROLES)
    if (!db.roles.some((x) => x.tenant_id === tenant.id && x.key === r.key))
      db.roles.push({ ...base(), key: r.key, name: r.name, description: r.description, persona: r.persona, permissions: [...r.permissions], is_system: true, active: true })
  for (const t of SYSTEM_EMAIL_TEMPLATES)
    if (!db.email_templates.some((x) => x.tenant_id === tenant.id && x.key === t.key)) db.email_templates.push({ ...base(), ...t, active: true })
  provisionWorkflows(db, tenant.id, base)
  if (!tenant.maker_checker) tenant.maker_checker = { ...NEW_TENANT_MC, entities: [...NEW_TENANT_MC.entities] }
  provisionMaster(db, tenant, base)
  if (opts.v7Defaults !== false) {
    // v7: letter templates (payslip, offer, joining, appraisal…) and the default workflow templates
    provisionDocDefaults(db, tenant.id, base)
    provisionWfTemplates(db, tenant.id, base)
  }
}

/** Role assignment for the demo people (persona `role` is kept in sync with the role definition). */
const ROLE_OF: Record<string, { key: string; extra?: string[] }> = {
  u_santosh: { key: 'ceo' },
  u_debasish: { key: 'administrator' },
  u_subhankar: { key: 'project_manager', extra: ['margins.view', 'documents.view_all'] },
  u_baishali: { key: 'sales_manager' },
  u_subham: { key: 'sales_executive' },
  u_priya: { key: 'hr_manager', extra: ['documents.view_all'] },
  u_k_ananya: { key: 'ceo' },
  u_k_rakesh: { key: 'project_manager' },
  u_k_meera: { key: 'sales_manager' },
}

export function seed(db: DB, h: SeedHelpers) {
  for (const t of db.tenants) provisionTenant(db, t, () => h.base(t.id), { v7Defaults: false })
  // Seereon runs with maker-checker on: sensitive changes need a second person.
  const seereon = db.tenants.find((t) => t.slug === 'seereon')
  if (seereon) seereon.maker_checker = { enabled: true, entities: ['role', 'user_access', 'cost_rate', 'workflow', 'payroll_finalise', 'vendor', 'org_profile'], sla_days: 2 }
  for (const u of db.users) {
    if (u.is_super_admin) continue
    const m = ROLE_OF[u.id]
    const fallback = u.role === 'admin' ? 'ceo' : u.role === 'pm' ? 'project_manager' : u.role === 'sales' ? 'sales_executive' : u.role === 'ops' ? 'hr_executive' : 'employee'
    u.role_key = m?.key ?? (u.role_key || fallback)
    u.extra_permissions = m?.extra ?? u.extra_permissions ?? []
    u.revoked_permissions = u.revoked_permissions ?? []
    const def = DEFAULT_ROLES.find((r) => r.key === u.role_key)
    if (def) u.role = def.persona
  }
  for (const inv of db.invites) inv.role_key = inv.role_key ?? (inv.role === 'pm' ? 'project_manager' : inv.role === 'sales' ? 'sales_executive' : inv.role === 'ops' ? 'hr_executive' : inv.role === 'admin' ? 'ceo' : 'employee')
  seedMaster(db, h)
}
