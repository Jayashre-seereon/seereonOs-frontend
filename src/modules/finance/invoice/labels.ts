// Shared labels for GST invoices (screens only format; numbers come from the mock server).
import type { Tone } from '@/domain/labels'
import type { InvoiceDisplayStatus, TaxMode } from '@/api/invoices'
import { fmtMoney } from '@/domain/money'

export const INVOICE_STATUS: Record<InvoiceDisplayStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  issued: { label: 'Issued', tone: 'info' },
  partially_paid: { label: 'Partially paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}
export const TAX_MODE: Record<TaxMode, { label: string; short: string }> = {
  intra: { label: 'Intra-state supply — CGST + SGST', short: 'CGST + SGST' },
  inter: { label: 'Inter-state supply — IGST', short: 'IGST' },
  export: { label: 'Export of services under LUT — zero-rated, no IGST', short: 'Export (LUT)' },
}
export const PAY_MODES = ['NEFT', 'RTGS', 'IMPS', 'UPI', 'Cheque', 'Bank transfer']
/** ₹1,18,000.00 — invoices always show paise. */
export const inr = (p: number | null | undefined) => fmtMoney(p ?? 0, { decimals: true })
export const pct = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`
export const fmtQty = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''))
export const fileNameOf = (number: string) => `${number.replace(/[^\w-]+/g, '-')}.pdf`
/** 14 Oct 2026 — the date style printed on invoices. */
export const invDate = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(iso.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')
