import { Link, useLocation } from 'react-router-dom'
import { ChevronLeft } from '@/ui/icons'
import { useSession } from '@/stores/session'
import { Wordmark } from '@/ui'

const UPDATED = '1 September 2026'
const CONTACT = 'privacy@seereon.co.in'
const GRIEVANCE = 'grievance@seereon.co.in'

type Sec = { h: string; p?: string[]; li?: string[] }

const PRIVACY: Sec[] = [
  { h: 'Who we are', p: ['SeereonOS is a business operating system provided by Seereon Consulting & IT Services Pvt. Ltd., Khandagiri, Bhubaneswar, Odisha 751003, India (“Seereon”, “we”).', 'When your company uses SeereonOS, your company is the Data Fiduciary for the work data it puts in the product. We act as its Data Processor and process that data only on its instructions. For your account details and how you use the service, we are the Data Fiduciary.'] },
  { h: 'What we collect', li: ['Account data: name, work email, phone (optional), job title, role and password (stored only as a salted hash).', 'Work data your company enters: projects, tasks, timesheets, leave, cost rates and salaries, invoices, deals and reports.', 'Usage data: sign-in times, device and browser type, IP address and actions for security and audit logs.', 'Billing data: company name, GSTIN and billing address. Card and UPI details are handled by our payment partner (Razorpay) and never stored by us.'] },
  { h: 'Why we use it', li: ['To provide the service your company signed up for.', 'To keep accounts secure — lockouts, two-step verification, audit logs.', 'To send service messages: invitations, password resets, approval reminders and billing notices.', 'To improve the product using aggregated, de-identified usage statistics.', 'To meet legal duties, such as tax and GST records.'], p: ['We do not sell personal data and we do not use your work data to train AI models.'] },
  { h: 'AI assistant', p: ['When the AI assistant is on, the question you ask and the minimum data needed to answer it are sent to our AI provider under a contract that forbids training on it and deletes it after processing. Admins can turn the assistant off for the whole workspace in Settings → Company & rules.'] },
  { h: 'Consent and your rights (DPDP Act, 2023)', p: ['Under the Digital Personal Data Protection Act, 2023 you may:'], li: ['Access a summary of your personal data and how it is processed.', 'Correct, complete or update it — most of it directly in Settings → My profile.', 'Ask for erasure when it is no longer needed for the purpose it was collected, subject to legal retention.', 'Withdraw consent, as easily as you gave it. Withdrawal does not affect processing already done.', 'Nominate another person to exercise these rights if you die or become incapable.', 'Raise a grievance with us, and then with the Data Protection Board of India.'] },
  { h: 'Where data is stored', p: ['Data is stored with our cloud provider in India (Mumbai region) and backed up to a second Indian region. Where a sub-processor outside India is used (for example email delivery), transfers follow Section 16 of the DPDP Act and any restrictions notified by the Government.'] },
  { h: 'How long we keep it', li: ['Workspace data: for as long as your company’s subscription is active, then 30 days to allow export, then deleted.', 'Backups: rolled off within 35 days of deletion.', 'Invoices and tax records: 8 years, as required by Indian tax law.', 'Security logs: 12 months.'] },
  { h: 'Security', p: ['Data is encrypted in transit (TLS 1.2+) and at rest (AES-256). Every table is isolated by tenant; staff access is logged and limited to support you have asked for. We will notify affected companies and the Data Protection Board of a personal data breach as the law requires.'] },
  { h: 'Children', p: ['SeereonOS is a workplace tool and is not meant for anyone under 18.'] },
  { h: 'Contact and grievances', p: [`Questions: ${CONTACT}. Grievance Officer: Santosh Nayak, ${GRIEVANCE}, +91 90 9070 5533. We acknowledge grievances within 48 hours and resolve them within 30 days.`] },
]

const TERMS: Sec[] = [
  { h: 'The agreement', p: ['These terms are between Seereon Consulting & IT Services Pvt. Ltd. (“Seereon”) and the company that creates a SeereonOS workspace (“Customer”). The person who signs up confirms they may bind the Customer.'] },
  { h: 'Trial and plans', li: ['New workspaces get a free 14-day trial of all features for up to 25 people.', 'Paid plans are billed per user per month in Indian rupees, plus 18% GST. Prices are on the Billing page.', 'Seats you add mid-cycle are charged pro-rata. Removing seats takes effect at the next renewal.', 'If a trial ends or a payment fails and is not fixed within 7 days, the workspace becomes read-only until billing is renewed. Your data is not deleted.'] },
  { h: 'Your data', p: ['The Customer owns all data it puts into SeereonOS. You can export all of it at any time from Settings → Data & export. We process it only to provide the service, as set out in the Privacy Policy, which forms part of these terms.'] },
  { h: 'Acceptable use', li: ['Keep passwords confidential; you are responsible for activity under your accounts.', 'Don’t upload unlawful content, malware or data you have no right to process.', 'Don’t probe, scrape or load-test the service without our written permission.', 'Don’t resell the service or use it to build a competing product.'] },
  { h: 'Availability and support', p: ['We aim for 99.5% monthly uptime, excluding announced maintenance. Support is by email on business days (IST); Growth and Scale plans get priority response.'] },
  { h: 'Fees, invoices and taxes', p: ['Invoices are GST-compliant and available on the Billing page. Fees are non-refundable except where the law requires or where we fail to provide the service. Please add your GSTIN before paying to claim input tax credit.'] },
  { h: 'Liability', p: ['The service is provided with reasonable skill and care. To the extent the law allows, our total liability in any 12 months is limited to the fees the Customer paid in that period, and neither party is liable for indirect or consequential loss. Nothing limits liability for fraud or wilful misconduct.'] },
  { h: 'Ending the agreement', p: ['You can cancel at any time from Billing; the workspace stays active until the end of the paid period. We may suspend a workspace for serious breach of these terms after notice, except where urgent action is needed to protect other customers.'] },
  { h: 'Law and disputes', p: ['These terms are governed by the laws of India. Courts in Bhubaneswar, Odisha have exclusive jurisdiction. We will first try to resolve any dispute in good faith within 30 days.'] },
  { h: 'Changes', p: ['We may update these terms and will give 30 days’ notice in the product for material changes. Continuing to use the service after that means you accept the new terms.'] },
]

export default function LegalPage() {
  const loc = useLocation()
  const token = useSession((s) => s.token)
  const privacy = loc.pathname.startsWith('/privacy')
  const secs = privacy ? PRIVACY : TERMS
  return (
    <div className="min-h-full bg-bg">
      <header className="sticky top-0 z-10 border-b border-line bg-surface">
        <div className="mx-auto flex h-14 max-w-[760px] items-center justify-between px-5">
          <Link to={token ? '/home' : '/login'} className="-ml-1 inline-flex items-center gap-0.5 text-[13.5px] font-medium text-brand-text hover:underline">
            <ChevronLeft className="size-4" /> {token ? 'Back to app' : 'Back to sign in'}
          </Link>
          <Wordmark className="text-[13px]" />
        </div>
      </header>
      <main className="mx-auto max-w-[760px] px-5 pb-20 pt-10 md:pt-14">
        <h1 className="text-[26px] font-semibold leading-tight md:text-[30px]">{privacy ? 'Privacy Policy' : 'Terms of Service'}</h1>
        <p className="mt-3 text-[14px] text-ink-3">Last updated {UPDATED}</p>
        <nav className="mt-5 flex gap-5 border-b border-line text-[13.5px] font-medium">
          <Link to="/privacy" className={privacy ? '-mb-px border-b-2 border-brand pb-2 text-ink' : 'pb-2 text-ink-3 hover:text-ink'}>Privacy</Link>
          <Link to="/terms" className={!privacy ? '-mb-px border-b-2 border-brand pb-2 text-ink' : 'pb-2 text-ink-3 hover:text-ink'}>Terms</Link>
        </nav>
        <div className="mt-8 rounded-lg border border-line bg-surface p-4 text-[14px] leading-relaxed text-ink-2">
          <span className="font-medium text-ink">In short: </span>
          {privacy
            ? 'your company owns its data; we process it only to run SeereonOS, keep it in India, never sell it, never train AI on it, and you can export or erase it.'
            : 'try free for 14 days, pay per user per month plus GST, export your data any time, and cancel whenever you like.'}
        </div>
        <ol className="mt-10 space-y-9">
          {secs.map((s, i) => (
            <li key={s.h} id={`s${i + 1}`} className="scroll-mt-20">
              <h2 className="text-[17px] font-semibold text-ink">
                <span className="tnum mr-2 text-ink-3">{i + 1}.</span>
                {s.h}
              </h2>
              {s.p?.map((t, k) => (
                <p key={k} className="mt-3 max-w-[68ch] text-[15px] leading-[1.7] text-ink-2">{t}</p>
              ))}
              {s.li && (
                <ul className="mt-3 max-w-[68ch] list-disc space-y-2 pl-5 text-[15px] leading-[1.65] text-ink-2 marker:text-ink-3">
                  {s.li.map((t) => <li key={t}>{t}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <p className="mt-14 border-t border-line pt-6 text-[13px] text-ink-3">Seereon Consulting &amp; IT Services Pvt. Ltd. · Khandagiri, Bhubaneswar 751003 · {CONTACT}</p>
      </main>
    </div>
  )
}
