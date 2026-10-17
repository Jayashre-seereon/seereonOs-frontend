import { cn } from '@/lib/utils'
import { SEEREON_EMBLEM, SEEREON_LOGO } from '@/assets/brand'

/** Official Seereon logo lockup (emblem + SEEREON + CONSULTING & IT SERVICES), gold on transparent. */
export function SeereonLogo({ className, height = 40 }: { className?: string; height?: number }) {
  return <img src={SEEREON_LOGO} alt="Seereon Consulting & IT Services" style={{ height }} className={cn('w-auto select-none', className)} draggable={false} />
}
export function SeereonEmblem({ size = 32, className }: { size?: number; className?: string }) {
  return <img src={SEEREON_EMBLEM} alt="Seereon" style={{ height: size, width: 'auto' }} className={cn('shrink-0 select-none', className)} draggable={false} />
}

/** Product name: the Seereon emblem followed by "SeereonOS". */
export function Wordmark({ className, inverted, emblem = true }: { className?: string; inverted?: boolean; emblem?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {emblem && <SeereonEmblem size={22} />}
      <span className={cn('font-semibold tracking-[0.14em]', inverted ? 'text-white' : 'text-ink')}>
        SEEREON<span className={cn('ml-1 rounded-[5px] px-1 py-px text-[0.7em] tracking-[0.06em]', inverted ? 'bg-white/15 text-white' : 'bg-accent-soft text-accent-text')}>OS</span>
      </span>
    </span>
  )
}

/** Tenant mark: the tenant's uploaded logo, or a monogram tile from the company name. */
export function TenantMark({ name, logo, size = 32, className }: { name: string; logo?: string | null; size?: number; className?: string }) {
  if (logo) return <img src={logo} alt={name} style={{ height: size, width: 'auto', maxWidth: size * 4 }} className={cn('shrink-0 object-contain', className)} />
  const letter = name.trim()[0]?.toUpperCase() ?? 'S'
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.46 }}
      className={cn('grid shrink-0 place-items-center rounded-[28%] bg-brand font-semibold text-brand-ink shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)]', className)}
    >
      {letter}
    </span>
  )
}
