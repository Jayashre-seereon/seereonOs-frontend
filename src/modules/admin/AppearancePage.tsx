import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Laptop, Moon, RotateCcw, Sun } from '@/ui/icons'
import { authApi, coreApi } from '@/api/core'
import { useMut } from '@/api/query'
import { useSession } from '@/stores/session'
import { applyTheme, buildTokens, contrast, FONT_CHOICES, FONTS, onColor, PRESETS, resolveDark } from '@/theme/theme'
import { DEFAULT_THEME } from '@/mock/seed'
import type { ThemeConfig } from '@/types/entities'
import { Button, Input, PageHeader, Segmented, useCan, useConfirm, useReadOnly } from '@/ui'
import { cn } from '@/lib/utils'
import { SaveBar } from './kit'

const same = (a: ThemeConfig, b: ThemeConfig) => JSON.stringify(a) === JSON.stringify(b)
const HEX = /^#[0-9a-fA-F]{6}$/

export default function AppearancePage() {
  const c = useCan()
  return c('theme.edit') ? <WorkspaceAppearance /> : <MyAppearance />
}

/* ------------------------------------------------------------------ */
function ModeSegment({ value, onChange, disabled }: { value: ThemeConfig['mode']; onChange: (m: ThemeConfig['mode']) => void; disabled?: boolean }) {
  return (
    <Segmented
      value={value}
      onChange={(m) => !disabled && onChange(m)}
      options={[
        { value: 'system', label: <span className="flex items-center gap-1.5"><Laptop className="size-3.5" />System</span> },
        { value: 'light', label: <span className="flex items-center gap-1.5"><Sun className="size-3.5" />Light</span> },
        { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon className="size-3.5" />Dark</span> },
      ]}
    />
  )
}

/** Settings row: label and help on the left, control on the right (stacked on phones). */
function Row({ label, help, children, error }: { label: string; help?: string; children: React.ReactNode; error?: string | null }) {
  return (
    <div className="grid gap-3 border-t border-line px-4 py-4 first:border-t-0 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8 md:px-5">
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink">{label}</div>
        {help && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{help}</p>}
        {error && <p className="mt-1 text-[12.5px] font-medium text-danger-text">{error}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface">
      <header className="border-b border-line px-4 py-3 md:px-5">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
      </header>
      {children}
    </section>
  )
}

function MyAppearance() {
  const { user, tenant, patchUser } = useSession()
  const theme = tenant?.theme ?? DEFAULT_THEME
  const m = useMut((mode: ThemeConfig['mode']) => authApi.prefs({ theme_mode: mode }), { success: 'Appearance updated', onSuccess: (u) => patchUser({ prefs: u.prefs }) })
  const mode = user?.prefs?.theme_mode ?? theme.mode
  return (
    <div className="max-w-[960px] space-y-5">
      <PageHeader title="Appearance" subtitle="Your admin sets the workspace colours. You choose light or dark for yourself." />
      <Section title="My theme">
        <Row label="Mode" help="System follows your device setting.">
          <ModeSegment
            value={mode}
            onChange={(md) => {
              applyTheme(theme, md)
              m.mutate(md)
            }}
          />
        </Row>
      </Section>
      <Section title="Workspace theme" subtitle="Set by your admin.">
        <div className="p-4 md:p-5">
          <MiniApp theme={theme} dark={resolveDark(mode)} company={tenant?.name ?? ''} />
        </div>
      </Section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
function WorkspaceAppearance() {
  const { tenant, user, setTenant, patchUser } = useSession()
  const readOnly = useReadOnly()
  const { confirm } = useConfirm()
  const saved = tenant?.theme ?? DEFAULT_THEME
  const [draft, setDraft] = useState<ThemeConfig>(saved)
  const [hexP, setHexP] = useState(saved.primary)
  const [hexA, setHexA] = useState(saved.accent)
  const savedRef = useRef(saved)
  savedRef.current = saved
  const userMode = user?.prefs?.theme_mode

  useEffect(() => {
    applyTheme(draft, userMode)
  }, [draft, userMode])
  useEffect(() => () => applyTheme(savedRef.current, useSession.getState().user?.prefs?.theme_mode), [])

  const dirty = !same(draft, saved)
  const patch = (p: Partial<ThemeConfig>) => setDraft((d) => ({ ...d, ...p }))
  const pickPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!
    setHexP(p.primary)
    setHexA(p.accent)
    patch({ preset: p.id, primary: p.primary, accent: p.accent, sidebar: p.sidebar })
  }
  const save = useMut(() => coreApi.saveTheme(draft, tenant?.version), { invalidate: [['me'], ['settings']], success: 'Workspace theme saved', onSuccess: (t) => setTenant(t) })
  const myMode = useMut((mode: ThemeConfig['mode']) => authApi.prefs({ theme_mode: mode }), { success: 'Your appearance updated', onSuccess: (u) => patchUser({ prefs: u.prefs }) })

  const brandInk = onColor(draft.primary)
  const cBtn = contrast(draft.primary, brandInk)
  const cOnWhite = contrast(draft.primary, '#FFFFFF')
  const cAccent = contrast(draft.accent, onColor(draft.accent))
  const previewDark = resolveDark(userMode && userMode !== 'system' ? userMode : draft.mode)

  return (
    <div className="max-w-[960px] space-y-5 pb-28">
      <PageHeader
        title="Appearance"
        subtitle="Brand colours, shape and type for everyone in the workspace. Changes preview live; nothing is saved until you press Save."
        actions={
          <Button
            size="sm"
            icon={<RotateCcw className="size-3.5" />}
            disabled={readOnly || same(draft, DEFAULT_THEME)}
            onClick={async () => {
              if (await confirm({ title: 'Reset to the Seereon default?', body: 'Emerald and gold, soft corners, IBM Plex Sans, light sidebar, light mode. Nothing is saved until you press Save.', confirmLabel: 'Reset' })) {
                setDraft({ ...DEFAULT_THEME })
                setHexP(DEFAULT_THEME.primary)
                setHexA(DEFAULT_THEME.accent)
              }
            }}
          >
            Reset to default
          </Button>
        }
      />

      <section className="rounded-lg border border-line bg-surface">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 md:px-5">
          <h2 className="text-[14px] font-semibold text-ink">Preview</h2>
          <span className="text-[12.5px] text-ink-3">
            {previewDark ? 'Dark' : 'Light'} · {FONTS[draft.font].label} · {draft.radius === 'sharp' ? 'Sharp' : draft.radius === 'soft' ? 'Soft' : 'Round'} corners
            {dirty && <span className="ml-2 font-medium text-warning-text">Unsaved</span>}
          </span>
        </header>
        <div className="bg-surface-2/50 p-3 md:p-5">
          <MiniApp theme={draft} dark={previewDark} company={tenant?.name ?? 'Your company'} />
        </div>
      </section>

      <Section title="Colour scheme" subtitle="Start from a preset, then fine-tune the brand colours if you need to.">
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-5 md:p-5">
          {PRESETS.map((p) => {
            const active = draft.preset === p.id
            return (
              <button key={p.id} type="button" disabled={readOnly} onClick={() => pickPreset(p.id)} aria-pressed={active} className={cn('min-w-0 rounded-md border p-2.5 text-left transition disabled:opacity-60', active ? 'border-brand bg-brand-soft/60 ring-1 ring-brand' : 'border-line hover:border-line-strong')}>
                <PresetSwatch primary={p.primary} accent={p.accent} />
                <div className="mt-2 flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{p.name}</span>
                  {active && <Check className="size-3.5 shrink-0 text-brand-text" />}
                </div>
              </button>
            )
          })}
          <button type="button" disabled={readOnly} onClick={() => patch({ preset: 'custom' })} aria-pressed={draft.preset === 'custom'} className={cn('min-w-0 rounded-md border p-2.5 text-left transition disabled:opacity-60', draft.preset === 'custom' ? 'border-brand bg-brand-soft/60 ring-1 ring-brand' : 'border-dashed border-line-strong hover:border-ink-3')}>
            <PresetSwatch primary={draft.primary} accent={draft.accent} />
            <div className="mt-2 flex items-center gap-1">
              <span className="flex-1 text-[13px] font-medium">Custom</span>
              {draft.preset === 'custom' && <Check className="size-3.5 text-brand-text" />}
            </div>
          </button>
        </div>
        <Row label="Primary colour" help="Buttons, links, active navigation." error={!HEX.test(hexP) ? 'Use a 6-digit hex like #0C6B4E.' : null}>
          <ColorInput label="Primary colour" value={draft.primary} text={hexP} setText={setHexP} disabled={readOnly} onChange={(v) => patch({ primary: v, preset: 'custom' })} />
        </Row>
        <Row label="Accent colour" help="Highlights and secondary emphasis." error={!HEX.test(hexA) ? 'Use a 6-digit hex like #DAB34F.' : null}>
          <ColorInput label="Accent colour" value={draft.accent} text={hexA} setText={setHexA} disabled={readOnly} onChange={(v) => patch({ accent: v, preset: 'custom' })} />
        </Row>
        <Row label="Readability" help="WCAG contrast. Text needs 4.5:1; large elements 3:1.">
          <div className="overflow-hidden rounded-md border border-line">
            <ContrastLine label="Text on primary buttons" ratio={cBtn} fg={brandInk} bg={draft.primary} />
            <ContrastLine label="Primary colour on white" ratio={cOnWhite} fg={draft.primary} bg="#FFFFFF" large />
            <ContrastLine label="Text on accent" ratio={cAccent} fg={onColor(draft.accent)} bg={draft.accent} />
          </div>
          {cBtn < 4.5 && (
            <p className="mt-2 flex items-start gap-1.5 text-[12.5px] text-warning-text">
              <AlertTriangle className="mt-px size-3.5 shrink-0" /> Button text is hard to read on this primary colour. Choose a darker shade.
            </p>
          )}
        </Row>
      </Section>

      <Section title="Layout and type">
        <Row label="Corner radius">
          <Segmented value={draft.radius} onChange={(v) => !readOnly && patch({ radius: v })} options={[{ value: 'sharp', label: 'Sharp' }, { value: 'soft', label: 'Soft' }, { value: 'round', label: 'Round' }]} />
        </Row>
        <Row label="Density" help="Compact fits more rows on screen.">
          <Segmented value={draft.density} onChange={(v) => !readOnly && patch({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
        </Row>
        <Row label="Typeface">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {FONT_CHOICES.map((f) => (
              <button key={f} type="button" disabled={readOnly} onClick={() => patch({ font: f })} aria-pressed={draft.font === f} className={cn('flex min-w-0 items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition disabled:opacity-60', draft.font === f ? 'border-brand bg-brand-soft/60 ring-1 ring-brand' : 'border-line hover:border-line-strong')}>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium" style={{ fontFamily: FONTS[f].stack }}>{FONTS[f].label}</span>
                  <span className="tnum block truncate text-[12.5px] text-ink-3" style={{ fontFamily: FONTS[f].stack }}>₹12,48,900 · Q2 FY26-27</span>
                </span>
                {draft.font === f && <Check className="size-4 shrink-0 text-brand-text" />}
              </button>
            ))}
          </div>
        </Row>
        <Row label="Sidebar" help="Light is the cleanest; Tinted uses a deep shade of the primary colour.">
          <Segmented value={draft.sidebar} onChange={(v) => !readOnly && patch({ sidebar: v })} options={[{ value: 'light', label: 'Light' }, { value: 'tinted', label: 'Tinted' }, { value: 'dark', label: 'Dark' }]} />
        </Row>
      </Section>

      <Section title="Light and dark">
        <Row label="Workspace default" help="What everyone sees unless they choose otherwise.">
          <ModeSegment value={draft.mode} onChange={(m) => patch({ mode: m })} disabled={readOnly} />
        </Row>
        <Row label="My theme" help="Only for you. Overrides the workspace default.">
          <ModeSegment value={user?.prefs?.theme_mode ?? draft.mode} onChange={(md) => myMode.mutate(md)} />
        </Row>
      </Section>

      <SaveBar
        dirty={dirty && !readOnly}
        saving={save.isPending}
        label="Theme changes not saved"
        onDiscard={() => {
          setDraft(saved)
          setHexP(saved.primary)
          setHexA(saved.accent)
        }}
        onSave={() => save.mutate(undefined)}
      />
    </div>
  )
}

function ColorInput({ label, value, text, setText, onChange, disabled }: { label: string; value: string; text: string; setText: (s: string) => void; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <label className="relative size-[var(--ctl-h)] shrink-0 cursor-pointer overflow-hidden rounded-md border border-line-strong" style={{ background: value }}>
        <span className="sr-only">Pick {label}</span>
        <input
          type="color"
          disabled={disabled}
          value={value}
          onChange={(e) => {
            setText(e.target.value.toUpperCase())
            onChange(e.target.value.toUpperCase())
          }}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <div className="w-[140px]">
      <Input
        value={text}
        disabled={disabled}
        invalid={!HEX.test(text)}
        maxLength={7}
        spellCheck={false}
        aria-label={`${label} hex value`}
        className="tnum font-mono uppercase"
        onChange={(e) => {
          let v = e.target.value.trim()
          if (v && !v.startsWith('#')) v = '#' + v
          setText(v.toUpperCase())
          if (HEX.test(v)) onChange(v.toUpperCase())
        }}
      />
      </div>
    </div>
  )
}

function ContrastLine({ label, ratio, fg, bg, large }: { label: string; ratio: number; fg: string; bg: string; large?: boolean }) {
  const pass = ratio >= 4.5 || (large && ratio >= 3)
  return (
    <div className="flex items-center gap-3 border-t border-line px-3 py-2 first:border-t-0">
      <span className="grid h-7 w-9 shrink-0 place-items-center rounded-sm text-[12px] font-semibold ring-1 ring-black/10" style={{ background: bg, color: fg }}>
        Aa
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{label}</span>
      <span className="tnum shrink-0 text-[13px] font-medium text-ink">{ratio.toFixed(2)}:1</span>
      <span className={cn('w-12 shrink-0 text-right text-[12px] font-medium', pass ? 'text-success-text' : 'text-warning-text')}>{ratio >= 7 ? 'AAA' : pass ? 'AA' : 'Low'}</span>
    </div>
  )
}

/** Swatch: primary block with the accent beside it. */
function PresetSwatch({ primary, accent }: { primary: string; accent: string }) {
  return (
    <div className="flex h-10 overflow-hidden rounded-sm ring-1 ring-black/5">
      <span className="flex-[3]" style={{ background: primary }} />
      <span className="flex-1" style={{ background: accent }} />
      <span className="flex-1 bg-[#F3F4F6]" />
    </div>
  )
}

/** Self-contained mini app painted with the tokens of `theme` (independent of the live app theme). */
export function MiniApp({ theme, dark, company }: { theme: ThemeConfig; dark: boolean; company: string }) {
  const tk = useMemo(() => buildTokens(theme, dark), [theme, dark])
  const style = Object.fromEntries(Object.entries(tk)) as React.CSSProperties
  const bars = [42, 58, 51, 66, 72, 61, 80, 88]
  return (
    <div style={{ ...style, fontFamily: tk['--font-sans'], background: 'var(--bg)', color: 'var(--ink)', borderRadius: 'var(--r-xl)', borderColor: 'var(--line)' }} className="overflow-hidden border" aria-label="Theme preview">
      <div className="flex min-h-[300px]" style={{ borderColor: 'var(--line)' }}>
        <aside className="hidden w-[150px] shrink-0 flex-col gap-1 border-r p-2.5 min-[480px]:flex" style={{ background: 'var(--sidebar-bg)', color: 'var(--sidebar-ink)' }}>
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <span className="grid size-5 place-items-center text-[10px] font-semibold" style={{ background: 'var(--brand)', color: 'var(--brand-ink)', borderRadius: 'var(--r-sm)' }}>
              {company.trim()[0] ?? 'S'}
            </span>
            <span className="truncate text-[10.5px] font-semibold">{company}</span>
          </div>
          {['Home', 'Projects', 'Timesheet', 'Approvals', 'Insights'].map((l, i) => (
            <div key={l} className="flex items-center justify-between px-2 py-1.5 text-[11px] font-medium" style={{ borderRadius: 'var(--r-sm)', background: i === 1 ? 'var(--sidebar-active)' : 'transparent', color: i === 1 ? 'var(--sidebar-active-ink)' : 'var(--sidebar-muted)' }}>
              {l}
              {i === 3 && <span className="rounded-full px-1 text-[9px] font-semibold" style={{ background: 'var(--danger)', color: '#fff' }}>3</span>}
            </div>
          ))}
        </aside>
        <div className="min-w-0 flex-1 p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-[10px] font-medium" style={{ color: 'var(--ink-3)' }}>Q2 FY26-27</div>
              <div className="text-[15px] font-semibold tracking-tight">Projects</div>
            </div>
            <span className="px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: 'var(--brand)', color: 'var(--brand-ink)', borderRadius: 'var(--r-md)' }}>
              + New project
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {[
              ['Billed', '₹18.4L', 'var(--success-text)', '+12%'],
              ['Margin', '31.5%', 'var(--brand-text)', 'floor 25%'],
            ].map(([k, v, c, d]) => (
              <div key={k} className="border p-2" style={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 'var(--r-lg)' }}>
                <div className="text-[10px]" style={{ color: 'var(--ink-3)' }}>{k}</div>
                <div className="tnum text-[16px] font-semibold tracking-tight">{v}</div>
                <div className="text-[10px] font-semibold" style={{ color: c }}>{d}</div>
              </div>
            ))}
          </div>
          <div className="mt-2 border p-2" style={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 'var(--r-lg)' }}>
            <div className="mb-1.5 text-[10px] font-semibold" style={{ color: 'var(--ink-2)' }}>Revenue · 8 months</div>
            <div className="flex h-[54px] items-end gap-1">
              {bars.map((b, i) => (
                <span key={i} className="flex-1" style={{ height: `${b}%`, background: i === bars.length - 1 ? 'var(--brand)' : 'color-mix(in oklab, var(--brand) 55%, var(--surface))', borderRadius: '3px 3px 0 0' }} />
              ))}
            </div>
          </div>
          <div className="mt-2 overflow-hidden border" style={{ background: 'var(--surface)', borderColor: 'var(--line)', borderRadius: 'var(--r-lg)' }}>
            {[
              ['PRJ-014 · EduReon', 'Active', 'var(--info-soft)', 'var(--info-text)', '62%'],
              ['PRJ-011 · HRMS', 'At risk', 'var(--warning-soft)', 'var(--warning-text)', '41%'],
            ].map(([n, s, bg, fg, p], i) => (
              <div key={n} className="flex items-center gap-2 px-2 py-2 text-[11px]" style={{ borderTop: i ? '1px solid var(--line)' : undefined }}>
                <span className="min-w-0 flex-1 truncate font-semibold">{n}</span>
                <span className="rounded-full px-1.5 py-px text-[9.5px] font-semibold" style={{ background: bg, color: fg }}>{s}</span>
                <span className="h-1 w-10 overflow-hidden rounded-full" style={{ background: 'var(--surface-2)' }}>
                  <span className="block h-full" style={{ width: p, background: 'var(--brand)' }} />
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="px-2 py-1 text-[10.5px] font-semibold" style={{ background: 'var(--brand-soft)', color: 'var(--brand-text)', borderRadius: 'var(--r-md)' }}>Approve week</span>
            <span className="border px-2 py-1 text-[10.5px] font-semibold" style={{ background: 'var(--surface)', borderColor: 'var(--line-strong)', borderRadius: 'var(--r-md)' }}>Reject</span>
            <span className="rounded-full px-1.5 py-px text-[9.5px] font-semibold" style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)' }}>Trial · 9 days</span>
            <span className="text-[10.5px] font-semibold underline" style={{ color: 'var(--brand-text)' }}>View all</span>
          </div>
        </div>
      </div>
    </div>
  )
}
