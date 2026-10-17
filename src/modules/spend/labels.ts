// Labels, tones and category maps for the spend & commercial area. Pure constants (no React) so the
// mock routes can share them with the screens.
import type { Tone } from '@/domain/labels'
import type { Client, Contract, ExpenseClaim, ExpenseStatus, LeakageKind, PurchaseOrder, RevenueLeakage, VendorBill } from '@/types/business'

export type ExpenseCategory = ExpenseClaim['category']

/** Expense-claim category → the ledger / budget category it books to. */
export const EXPENSE_CATEGORY: Record<ExpenseCategory, string> = {
  travel: 'Travel',
  food: 'Food & meals',
  lodging: 'Lodging',
  client_entertainment: 'Client entertainment',
  software: 'Tools & software',
  hardware: 'Equipment',
  internet_phone: 'Internet & phone',
  training: 'Training',
  office: 'Office supplies',
  other: 'Other',
}
export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  travel: 'Travel',
  food: 'Food & meals',
  lodging: 'Lodging',
  client_entertainment: 'Client entertainment',
  software: 'Software & subscriptions',
  hardware: 'Hardware',
  internet_phone: 'Internet & phone',
  training: 'Training & courses',
  office: 'Office supplies',
  other: 'Other',
}

/** Ledger expense categories (finance) + the ones claims and purchases book to. */
export const BUDGET_EXPENSE_CATEGORIES = [
  'Salaries', 'Rent', 'Tools & software', 'Marketing', 'Utilities', 'Internet & phone', 'Travel', 'Lodging', 'Food & meals', 'Client entertainment',
  'Training', 'Office supplies', 'Equipment', 'Compliance', 'Professional fees', 'Subcontractors', 'Other',
]

export const RECEIPT_LIMIT_PAISE = 500_00
export const SECOND_APPROVAL_PAISE = 25_000_00
export const EXPENSE_MAX_AGE_DAYS = 90

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  submitted: { label: 'Submitted', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'danger' },
  paid: { label: 'Paid', tone: 'success' },
}
export const PO_STATUS: Record<PurchaseOrder['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending: { label: 'Pending approval', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  rejected: { label: 'Rejected', tone: 'danger' },
  closed: { label: 'Closed', tone: 'success' },
}
export const BILL_STATUS: Record<VendorBill['status'], { label: string; tone: Tone }> = {
  received: { label: 'Received', tone: 'warning' },
  approved: { label: 'Approved', tone: 'info' },
  paid: { label: 'Paid', tone: 'success' },
  disputed: { label: 'Disputed', tone: 'danger' },
}
export const VENDOR_STATUS: Record<'active' | 'blocked', { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  blocked: { label: 'Blocked', tone: 'danger' },
}

export const LEAKAGE_KIND: Record<LeakageKind, { label: string; auto: boolean }> = {
  lost_deal: { label: 'Lost deal', auto: true },
  unbilled_hours: { label: 'Unbilled hours', auto: true },
  bad_debt: { label: 'Bad-debt risk', auto: true },
  scope_creep: { label: 'Scope creep', auto: false },
  discount: { label: 'Discount', auto: false },
  write_off: { label: 'Write-off', auto: false },
  credit_note: { label: 'Credit note', auto: false },
  penalty: { label: 'Penalty', auto: false },
  churn: { label: 'Churn', auto: false },
}
export const MANUAL_LEAKAGE_KINDS: LeakageKind[] = ['discount', 'write_off', 'credit_note', 'penalty', 'scope_creep', 'churn']
export const LEAKAGE_STATUS: Record<RevenueLeakage['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warning' },
  recovered: { label: 'Recovered', tone: 'success' },
  accepted: { label: 'Accepted', tone: 'neutral' },
}

export const CLIENT_STATUS: Record<Client['status'], { label: string; tone: Tone }> = {
  prospect: { label: 'Prospect', tone: 'info' },
  active: { label: 'Active', tone: 'success' },
  dormant: { label: 'Dormant', tone: 'neutral' },
  churned: { label: 'Churned', tone: 'danger' },
}
export const CLIENT_HEALTH: Record<'good' | 'watch' | 'at_risk', { label: string; tone: Tone }> = {
  good: { label: 'Good', tone: 'success' },
  watch: { label: 'Watch', tone: 'warning' },
  at_risk: { label: 'At risk', tone: 'danger' },
}
export const CONTRACT_KIND: Record<Contract['kind'], string> = { msa: 'MSA', sow: 'SOW', amc: 'AMC', licence: 'Licence', nda: 'NDA', retainer: 'Retainer' }
export const CONTRACT_STATUS: Record<Contract['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  expiring: { label: 'Expiring', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
  terminated: { label: 'Terminated', tone: 'neutral' },
  renewed: { label: 'Renewed', tone: 'info' },
}
export const RENEWAL_WINDOW_DAYS = 60

export const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
export const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
