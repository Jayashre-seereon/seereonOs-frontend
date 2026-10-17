// v4 email outbox. The mock never sends real email: it renders the tenant's template and stores the
// message in `email_outbox`, where admins can read exactly what was "sent" (Setup → Emails → Sent).
import type { EmailMessage, EmailTemplate } from '@/types/access'
import { getDb, insert, nowISO, rows, type Ctx } from './server'

export function renderTemplate(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])))
}
export function templateFor(ctx: Ctx, key: EmailTemplate['key']): EmailTemplate | null {
  return rows(ctx, 'email_templates').find((t) => t.key === key && t.active) ?? null
}
/** Login URL shown in emails (the preview runs from a file, so use the product URL). */
export const LOGIN_URL = 'https://app.seereonos.com/login'

export function sendEmail(
  ctx: Ctx,
  key: EmailTemplate['key'],
  to: { email: string; user_id?: string | null },
  vars: Record<string, string | number | null | undefined>,
  related?: { entity: string; id: string },
): EmailMessage | null {
  const t = templateFor(ctx, key)
  if (!t) return null
  const tenant = getDb().tenants.find((x) => x.id === ctx.tenant.id)
  const all = { company: tenant?.org?.brand_name || tenant?.name || '', login_url: LOGIN_URL, ...vars }
  return insert(ctx, 'email_outbox', {
    to: to.email, to_user_id: to.user_id ?? null, subject: renderTemplate(t.subject, all), body: renderTemplate(t.body, all), template_key: key,
    related_entity: related?.entity ?? null, related_id: related?.id ?? null, status: 'sent', sent_at: nowISO(),
  } as never) as EmailMessage
}
