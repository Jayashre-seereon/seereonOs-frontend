import type { ReactNode } from 'react'
import { SeereonLogo } from '@/ui'

/** Frame for sign-in, sign-up, reset and invite screens.
 *  Desktop: a solid brand panel with the logo beside a white form column. Phone: form only, logo on top. */
export default function AuthLayout({ title, subtitle, children, footer, aside }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; aside?: ReactNode }) {
  return (
    <div className="grid min-h-full bg-surface lg:grid-cols-[minmax(380px,5fr)_7fr]">
      <aside className="hidden flex-col justify-between bg-[#0B4F3A] px-12 py-12 text-white lg:flex xl:px-16">
        <div className="self-start">
          <SeereonLogo height={56} />
        </div>
        {aside ?? (
          <div className="max-w-[420px]">
            <h2 className="text-[28px] font-semibold leading-[1.25] text-white">SeereonOS</h2>
            <p className="mt-3 text-[15px] leading-relaxed text-white/75">Projects, timesheets, approvals, billing, payroll and sales in one system, with reports your leadership can act on.</p>
          </div>
        )}
        <p className="text-[12px] text-white/55">© {new Date().getFullYear()} Seereon Consulting &amp; IT Services Pvt. Ltd. · Bhubaneswar · ISO 9001:2015</p>
      </aside>
      <main className="flex min-h-full flex-col bg-surface px-5 pb-[max(24px,env(safe-area-inset-bottom,0px))] pt-[max(24px,env(safe-area-inset-top,0px))] sm:px-10">
        <div className="self-start rounded-md bg-[#0B4F3A] px-3 py-2 lg:hidden">
          <SeereonLogo height={30} />
        </div>
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
          <h1 className="text-[24px] font-semibold leading-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1.5 text-[14px] text-ink-3">{subtitle}</p>}
          <div className="mt-7">{children}</div>
        </div>
        {footer && <div className="mx-auto w-full max-w-[400px] text-center text-[13px] text-ink-3">{footer}</div>}
      </main>
    </div>
  )
}
