// Corporate-style exports shared by every module (reports, payroll, ledger, invoices…), laid out
// like a board pack. PDF (jsPDF + autotable, A4, 18 mm margins): white page, tenant logo at its true
// aspect ratio with company + report category on the right over a thin brand rule; 18 pt title,
// period, a metadata line; bordered KPI boxes; optional chart with legend and caption; a table with
// a light-grey header, hairline rules, right-aligned Indian-grouped ₹ figures and a bold total row,
// header repeated on every page; "Confidential · Company" and "Page x of y" footer. Landscape is
// chosen automatically above 7 columns. Excel (ExcelJS): a gridline-free Summary sheet (logo, title,
// period, prepared by, KPI block) and a Data sheet (grey bold header, frozen, autofilter, ₹/%/date
// formats, SUM totals, print setup with page numbers). CSV unchanged.
// The signature of exportTable() is the cross-module contract — do not change it.
import { saveFile, toCSV } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { SEEREON_LOGO, SEEREON_GOLD } from '@/assets/brand'
import { hexToRgb, onColor } from '@/theme/theme'
import { fmtMoney, fmtNum, fmtPct } from '@/domain/money'

export type ExportColType = 'string' | 'number' | 'money' | 'percent' | 'date' | 'hours'
export interface ExportTable {
  title: string
  subtitle?: string // e.g. period "Q2 FY26-27"
  columns: { key: string; label: string; type: ExportColType }[]
  rows: Record<string, string | number | boolean | null | undefined>[]
  totals?: Record<string, number | null>
  kpis?: { label: string; value: string }[]
  notes?: string[]
  chartSvg?: SVGSVGElement | null // optional chart rendered into the PDF
  orientation?: 'portrait' | 'landscape'
  /** Optional legend drawn under the chart image (colours may be CSS variables). */
  legend?: { label: string; color: string }[]
  /** Report category shown top-right under the company name (default "Management report"). */
  category?: string
  /** ISO date the figures are valid for (default today). */
  asOf?: string
}
export type ExportFormat = 'pdf' | 'xlsx' | 'csv'

/* ------------------------------------------------------------------ */
/* Shared helpers                                                       */
/* ------------------------------------------------------------------ */
function fileBase(t: ExportTable, filename?: string) {
  return (filename ?? t.title).replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'export'
}
function brandInfo() {
  const s = useSession.getState()
  const tenant = s.tenant
  const primary = tenant?.theme?.primary && /^#[0-9a-f]{6}$/i.test(tenant.theme.primary) ? tenant.theme.primary : '#0C6B4E'
  const accent = tenant?.theme?.accent && /^#[0-9a-f]{6}$/i.test(tenant.theme.accent) ? tenant.theme.accent : SEEREON_GOLD
  const isSeereon = tenant?.slug === 'seereon' || /seereon/i.test(tenant?.name ?? '')
  return {
    tenantName: tenant?.name ?? 'SeereonOS',
    logo: isSeereon ? SEEREON_LOGO : tenant?.logo_data_url ?? null,
    primary,
    accent,
    user: s.user?.name ?? 'SeereonOS',
  }
}
const nowLabel = () => new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
const dayLabel = (iso?: string) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? new Date(iso.slice(0, 10) + 'T00:00:00') : new Date()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
/** Landscape above 7 columns unless the caller forces an orientation. */
const orientationOf = (t: ExportTable): 'portrait' | 'landscape' => t.orientation ?? (t.columns.length > 7 ? 'landscape' : 'portrait')
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
function fmtDateCell(v: unknown) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return v === null || v === undefined ? '' : String(v)
  return new Date(v.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}
/** Text for a cell in PDF / CSV-like contexts. Money is paise. */
export function exportCellText(v: unknown, type: ExportColType): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (type === 'money' && isNum(v)) return fmtMoney(v)
  if (type === 'percent' && isNum(v)) return fmtPct(v)
  if (type === 'hours' && isNum(v)) return fmtNum(v, 1)
  if (type === 'number' && isNum(v)) return fmtNum(v, Math.abs(v) < 10 && !Number.isInteger(v) ? 2 : 0)
  if (type === 'date') return fmtDateCell(v)
  return String(v)
}
const numericType = (t: ExportColType) => t === 'money' || t === 'number' || t === 'percent' || t === 'hours'

/** Loads any image URL (png/svg/data URL) and re-encodes it as a PNG data URL via canvas. */
async function toPngDataUrl(src: string, maxW = 600): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.crossOrigin = 'anonymous'
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('image'))
      i.src = src
    })
    const w0 = img.naturalWidth || img.width || 200
    const h0 = img.naturalHeight || img.height || 200
    const k = Math.min(1, maxW / w0)
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(w0 * k))
    c.height = Math.max(1, Math.round(h0 * k))
    const g = c.getContext('2d')
    if (!g) return null
    g.drawImage(img, 0, 0, c.width, c.height)
    return { data: c.toDataURL('image/png'), w: c.width, h: c.height }
  } catch {
    return null
  }
}

function resolveColor(c: string): string {
  const m = c.match(/^var\((--[\w-]+)\)$/)
  if (!m) return c
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#0C6B4E'
}
function luminance(css: string) {
  const m = css.match(/rgba?\(([^)]+)\)/)
  if (!m) return 0
  const [r, g, b] = m[1].split(',').map((x) => Number(x.trim()))
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Serialises a live (Recharts) SVG with computed styles inlined → PNG on a white background. */
async function svgToPng(svg: SVGSVGElement): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const rect = svg.getBoundingClientRect()
    const w = Math.round(rect.width || Number(svg.getAttribute('width')) || 0)
    const h = Math.round(rect.height || Number(svg.getAttribute('height')) || 0)
    if (!w || !h) return null
    const clone = svg.cloneNode(true) as SVGSVGElement
    const src = svg.querySelectorAll('*')
    const dst = clone.querySelectorAll('*')
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'fill-opacity', 'stroke-opacity', 'stop-color', 'stop-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline']
    src.forEach((el, i) => {
      const cs = getComputedStyle(el)
      const d = dst[i] as SVGElement
      for (const p of props) {
        const v = cs.getPropertyValue(p)
        if (v) d.style.setProperty(p, v)
      }
      // text drawn for a dark UI must stay readable on white paper
      if (el.tagName === 'text' || el.tagName === 'tspan') {
        if (luminance(cs.getPropertyValue('fill')) > 0.6) d.style.setProperty('fill', '#4a5550')
      }
      if ((el.tagName === 'line' || el.tagName === 'path') && el.closest('.recharts-cartesian-grid') && luminance(cs.getPropertyValue('stroke')) < 0.35) d.style.setProperty('stroke', '#e3e7e5')
    })
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('width', String(w))
    clone.setAttribute('height', String(h))
    const xml = new XMLSerializer().serializeToString(clone)
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('svg'))
      i.src = url
    })
    const scale = 2
    const c = document.createElement('canvas')
    c.width = w * scale
    c.height = h * scale
    const g = c.getContext('2d')
    if (!g) return null
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(img, 0, 0, c.width, c.height)
    return { data: c.toDataURL('image/png'), w, h }
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                  */
/* ------------------------------------------------------------------ */
function csvOf(t: ExportTable) {
  const val = (c: ExportTable['columns'][number], v: unknown) => (c.type === 'money' && isNum(v) ? v / 100 : c.type === 'percent' && isNum(v) ? Math.round(v * 10000) / 100 : (v as string | number | boolean | null | undefined))
  const head = t.columns.map((c) => (c.type === 'money' ? `${c.label} (INR)` : c.type === 'percent' ? `${c.label} (%)` : c.label))
  const body = t.rows.map((r) => t.columns.map((c) => val(c, r[c.key])))
  const out: (string | number | boolean | null | undefined)[][] = [head, ...body]
  if (t.totals && Object.values(t.totals).some((x) => x !== null && x !== undefined)) out.push(t.columns.map((c, i) => (i === 0 ? 'Total' : t.totals![c.key] !== undefined ? val(c, t.totals![c.key]) : '')))
  return toCSV(out)
}

/* ------------------------------------------------------------------ */
/* PDF                                                                  */
/* ------------------------------------------------------------------ */
type RGB = [number, number, number]
const INK: RGB = [17, 24, 39] // #111827
const INK2: RGB = [55, 65, 81] // #374151
const MUTED: RGB = [107, 114, 128] // #6B7280
const RULE: RGB = [229, 231, 235] // #E5E7EB
const BOX: RGB = [209, 213, 219] // #D1D5DB
const HEAD_FILL: RGB = [243, 244, 246] // #F3F4F6
const PT = 0.3528 // mm per point

async function pdfOf(t: ExportTable): Promise<Blob> {
  const [{ jsPDF }, autoTableMod, fontMod] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('./pdfFont')])
  const autoTable = (autoTableMod as unknown as { default: (d: unknown, o: unknown) => void }).default
  const b = brandInfo()
  const orientation = orientationOf(t)
  const doc = new jsPDF({ orientation, unit: 'mm', format: 'a4', compress: true })
  let font = 'helvetica'
  try {
    doc.addFileToVFS('Carlito-Regular.ttf', fontMod.CARLITO_REGULAR)
    doc.addFont('Carlito-Regular.ttf', 'Carlito', 'normal')
    doc.addFileToVFS('Carlito-Bold.ttf', fontMod.CARLITO_BOLD)
    doc.addFont('Carlito-Bold.ttf', 'Carlito', 'bold')
    doc.setFont('Carlito', 'normal')
    font = 'Carlito'
  } catch {
    font = 'helvetica'
  }
  // Fonts without the rupee glyph fall back to "Rs."; Carlito lacks ≤ ≥.
  const tx = (s: string) => {
    const x = s.replace(/≤/g, '<=').replace(/≥/g, '>=')
    return font === 'Carlito' ? x : x.replace(/₹/g, 'Rs. ').replace(/−/g, '-').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[’]/g, "'").replace(/·/g, '-')
  }
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 18
  const CW = W - 2 * M
  const brand = hexToRgb(b.primary) as RGB
  const category = t.category ?? 'Management report'
  const setText = (size: number, color: RGB, weight: 'normal' | 'bold' = 'normal') => {
    doc.setFont(font, weight)
    doc.setFontSize(size)
    doc.setTextColor(...color)
  }

  /* ---- letterhead (page 1) ---- */
  const logo = b.logo ? await toPngDataUrl(b.logo, 900) : null
  const top = 14
  let headBottom = top + 12
  let leftDrawn = false
  if (logo) {
    const lh = 12
    const lw = Math.min(48, (logo.w / logo.h) * lh)
    const h = (logo.h / logo.w) * lw // keep the true aspect ratio even if width was capped
    try {
      doc.addImage(logo.data, 'PNG', M, top, lw, h, undefined, 'FAST')
      headBottom = top + Math.max(h, 12)
      leftDrawn = true
    } catch {
      /* fall back to the company name */
    }
  }
  if (!leftDrawn) {
    setText(13, INK, 'bold')
    doc.text(tx(b.tenantName), M, top + 7)
  }
  // right block: company + category (company omitted when it's already the left-hand text)
  if (leftDrawn) {
    setText(9.5, INK, 'bold')
    doc.text(tx(b.tenantName), W - M, top + 4.5, { align: 'right' })
    setText(8.5, MUTED)
    doc.text(tx(category), W - M, top + 9, { align: 'right' })
  } else {
    setText(8.5, MUTED)
    doc.text(tx(category), W - M, top + 7, { align: 'right' })
  }
  const ruleY = headBottom + 3
  doc.setDrawColor(...brand)
  doc.setLineWidth(0.5 * PT)
  doc.line(M, ruleY, W - M, ruleY)

  /* ---- title block ---- */
  let y = ruleY + 11
  setText(18, INK, 'bold')
  const titleLines = doc.splitTextToSize(tx(t.title), CW) as string[]
  doc.text(titleLines, M, y)
  y += (titleLines.length - 1) * 7.2 + 5.6
  if (t.subtitle) {
    setText(10, MUTED)
    const sub = doc.splitTextToSize(tx(t.subtitle), CW) as string[]
    doc.text(sub, M, y)
    y += sub.length * 4.4
  }
  y += 1
  setText(8, MUTED)
  const meta = `Prepared by ${b.user}   ·   Generated on ${nowLabel()}   ·   Data as of ${dayLabel(t.asOf)}`
  doc.text(doc.splitTextToSize(tx(meta), CW) as string[], M, y)
  y += 8

  /* ---- KPI boxes ---- */
  if (t.kpis?.length) {
    const maxPer = orientation === 'landscape' ? 5 : 4
    const per = Math.min(maxPer, t.kpis.length)
    const slots = Math.max(per, 3) // one or two KPIs keep a sensible box width
    const gap = 4
    const bw = (CW - gap * (slots - 1)) / slots
    const bh = 19
    t.kpis.forEach((k, i) => {
      const col = i % per
      const row = Math.floor(i / per)
      const bx = M + col * (bw + gap)
      const by = y + row * (bh + gap)
      doc.setDrawColor(...BOX)
      doc.setLineWidth(0.2)
      doc.rect(bx, by, bw, bh, 'S')
      // "₹12,34,567  (+3.2%)" → value + a small change line
      const mm = k.value.match(/^(.*?)\s{2}\((.+)\)$/)
      const main = tx(mm ? mm[1] : k.value)
      const change = mm ? tx(mm[2]) : null
      setText(7.5, MUTED)
      const lab = (doc.splitTextToSize(tx(k.label), bw - 7) as string[])[0]
      doc.text(lab, bx + 3.5, by + 5.5)
      let fs = 14
      doc.setFont(font, 'bold')
      doc.setFontSize(fs)
      while (fs > 9 && doc.getTextWidth(main) > bw - 7) doc.setFontSize((fs -= 0.5))
      setText(fs, INK, 'bold')
      doc.text(main, bx + 3.5, by + 12.3)
      if (change) {
        setText(7.5, MUTED)
        doc.text(`${change} vs previous period`, bx + 3.5, by + 16.4)
      }
    })
    y += Math.ceil(t.kpis.length / per) * (bh + gap) + 3
  }

  /* ---- chart ---- */
  if (t.chartSvg) {
    const png = await svgToPng(t.chartSvg)
    if (png) {
      const maxH = orientation === 'landscape' ? 70 : 82
      let cw = CW
      let ch = (png.h / png.w) * cw
      if (ch > maxH) {
        ch = maxH
        cw = (png.w / png.h) * ch
      }
      if (y + ch + 14 > H - 22) {
        doc.addPage()
        y = 30
      }
      doc.addImage(png.data, 'PNG', M, y, cw, ch, undefined, 'FAST')
      y += ch + 3
      if (t.legend?.length) {
        let lx = M
        setText(8, INK2)
        for (const l of t.legend) {
          const label = tx(l.label)
          const wv = 5 + doc.getTextWidth(label) + 6
          if (lx + wv > W - M) {
            lx = M
            y += 4.5
          }
          doc.setFillColor(...hexToRgbSafe(resolveColor(l.color)))
          doc.rect(lx, y - 2.3, 2.6, 2.6, 'F')
          doc.text(label, lx + 4, y)
          lx += wv
        }
        y += 4.5
      }
      setText(8, MUTED)
      doc.text(tx(`Figure 1. ${t.title}${t.subtitle ? ` — ${t.subtitle}` : ''}`), M, y)
      y += 7
    }
  }

  /* ---- notes ---- */
  if (t.notes?.length) {
    setText(8, MUTED)
    for (const n of t.notes) {
      const lines = doc.splitTextToSize(tx(`Note: ${n}`), CW) as string[]
      if (y + lines.length * 3.6 > H - 30) {
        doc.addPage()
        y = 30
      }
      doc.text(lines, M, y)
      y += lines.length * 3.6 + 1
    }
    y += 3
  }

  /* ---- table ---- */
  if (y > H - 50) {
    doc.addPage()
    y = 30
  }
  setText(10, INK, 'bold')
  doc.text('Detail', M, y)
  setText(8, MUTED)
  doc.text(`${t.rows.length} ${t.rows.length === 1 ? 'row' : 'rows'}`, W - M, y, { align: 'right' })
  y += 3

  const head = [t.columns.map((c) => tx(c.label))]
  const body = t.rows.map((r) => t.columns.map((c) => tx(exportCellText(r[c.key], c.type))))
  const hasTotals = !!t.totals && t.columns.some((c) => t.totals![c.key] !== undefined && t.totals![c.key] !== null)
  const foot = hasTotals ? [t.columns.map((c, i) => (i === 0 ? 'Total' : t.totals![c.key] !== undefined && t.totals![c.key] !== null ? tx(exportCellText(t.totals![c.key], c.type)) : ''))] : undefined
  const wide = t.columns.length > 9
  const columnStyles: Record<number, { halign?: 'right' | 'left'; cellWidth?: 'wrap' | 'auto' }> = {}
  t.columns.forEach((c, i) => {
    // numbers and dates never wrap mid-value
    if (numericType(c.type)) columnStyles[i] = { halign: 'right', cellWidth: 'wrap' }
    else if (c.type === 'date') columnStyles[i] = { cellWidth: 'wrap' }
  })
  autoTable(doc, {
    startY: y,
    head,
    body,
    foot,
    showHead: 'everyPage',
    showFoot: 'lastPage',
    margin: { left: M, right: M, top: 26, bottom: 20 },
    theme: 'plain',
    tableWidth: CW,
    styles: { font, fontSize: wide ? 7.6 : 8.5, cellPadding: { top: 2, bottom: 2, left: 2.2, right: 2.2 }, textColor: INK, lineColor: RULE, lineWidth: { bottom: 0.15 }, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: HEAD_FILL, textColor: INK, fontStyle: 'bold', fontSize: wide ? 7.4 : 8, lineColor: BOX, lineWidth: { bottom: 0.25 } },
    footStyles: { fillColor: [255, 255, 255], textColor: INK, fontStyle: 'bold', lineColor: INK2, lineWidth: { top: 0.35 } },
    columnStyles,
    didParseCell: (data: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => {
      const c = t.columns[data.column.index]
      if (c && numericType(c.type)) data.cell.styles.halign = 'right'
    },
  })
  if (!t.rows.length) {
    const last = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? y
    setText(9, MUTED)
    doc.text('No rows match this report.', M, last + 7)
  }

  /* ---- footer on every page ---- */
  const pages = doc.getNumberOfPages()
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p)
    if (p > 1) {
      // running header on continuation pages
      setText(8, INK2, 'bold')
      doc.text(tx(b.tenantName), M, 14)
      setText(8, MUTED)
      doc.text(tx(t.title), W - M, 14, { align: 'right' })
      doc.setDrawColor(...brand)
      doc.setLineWidth(0.5 * PT)
      doc.line(M, 17, W - M, 17)
    }
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.2)
    doc.line(M, H - 13, W - M, H - 13)
    setText(8, MUTED)
    doc.text(tx(`Confidential · ${b.tenantName}`), M, H - 9)
    doc.text(`Page ${p} of ${pages}`, W - M, H - 9, { align: 'right' })
  }
  return doc.output('blob')
}
function hexToRgbSafe(c: string): RGB {
  if (/^#[0-9a-f]{6}$/i.test(c)) return hexToRgb(c) as RGB
  const m = c.match(/rgba?\(([^)]+)\)/)
  if (m) {
    const [r, g, bb] = m[1].split(',').map((x) => Number(x.trim()))
    return [r, g, bb]
  }
  return [12, 107, 78]
}

/* ------------------------------------------------------------------ */
/* Excel                                                                */
/* ------------------------------------------------------------------ */
// Indian grouping via the en-IN locale tag (₹1,23,45,678).
const INR_FMT = '[$₹-4009] #,##,##0.00;-[$₹-4009] #,##,##0.00'
const INR_FMT_WHOLE = '[$₹-4009] #,##,##0;-[$₹-4009] #,##,##0'
const X_INK = 'FF111827'
const X_MUTED = 'FF6B7280'
const X_RULE = 'FFD1D5DB'
const X_HEAD = 'FFF3F4F6'

async function xlsxOf(t: ExportTable): Promise<Blob> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs'); Workbook?: typeof import('exceljs').Workbook }
  const ExcelJS = (mod.default ?? mod) as typeof import('exceljs')
  const b = brandInfo()
  const brandArgb = 'FF' + b.primary.replace('#', '').toUpperCase()
  const orientation = orientationOf(t)
  const category = t.category ?? 'Management report'
  const wb = new ExcelJS.Workbook()
  wb.creator = b.user
  wb.company = b.tenantName
  wb.created = new Date()
  wb.title = t.title
  wb.subject = category
  const hf = (title: string) => ({
    oddHeader: `&L&8&K6B7280${b.tenantName.replace(/&/g, '&&')}&R&8&K6B7280${title.replace(/&/g, '&&')}`,
    oddFooter: `&L&8&K6B7280Confidential · ${b.tenantName.replace(/&/g, '&&')}&R&8&K6B7280Page &P of &N`,
  })

  /* ---- Summary ---- */
  const sum = wb.addWorksheet('Summary', { views: [{ showGridLines: false }], properties: { tabColor: { argb: brandArgb } } })
  sum.columns = [{ width: 30 }, { width: 30 }, { width: 22 }, { width: 30 }]
  sum.pageSetup = { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } }
  sum.headerFooter = hf(t.title)
  for (const r of [1, 2, 3]) sum.getRow(r).height = 18
  let logoPlaced = false
  if (b.logo) {
    const png = await toPngDataUrl(b.logo, 500)
    if (png) {
      try {
        const id = wb.addImage({ base64: png.data, extension: 'png' })
        const hh = 46
        sum.addImage(id, { tl: { col: 0, row: 0.15 }, ext: { width: Math.round((png.w / png.h) * hh), height: hh }, editAs: 'absolute' } as never)
        logoPlaced = true
      } catch {
        /* logo optional */
      }
    }
  }
  if (!logoPlaced) {
    const c = sum.getCell('A1')
    c.value = b.tenantName
    c.font = { bold: true, size: 14, color: { argb: X_INK } }
  }
  const rc = (addr: string, v: string, font: Partial<import('exceljs').Font>) => {
    const c = sum.getCell(addr)
    c.value = v
    c.font = font
    c.alignment = { horizontal: 'right', vertical: 'middle' }
  }
  if (logoPlaced) rc('D1', b.tenantName, { bold: true, size: 10, color: { argb: X_INK } })
  rc(logoPlaced ? 'D2' : 'D1', category, { size: 9, color: { argb: X_MUTED } })
  for (const col of ['A', 'B', 'C', 'D']) sum.getCell(`${col}4`).border = { bottom: { style: 'thin', color: { argb: brandArgb } } }
  sum.getRow(4).height = 6

  sum.mergeCells('A6:D6')
  const title = sum.getCell('A6')
  title.value = t.title
  title.font = { bold: true, size: 18, color: { argb: X_INK } }
  sum.getRow(6).height = 26
  let r = 7
  if (t.subtitle) {
    sum.mergeCells(`A${r}:D${r}`)
    const c = sum.getCell(`A${r}`)
    c.value = t.subtitle
    c.font = { size: 10.5, color: { argb: X_MUTED } }
    r++
  }
  r++
  const meta = (label: string, value: string) => {
    sum.getCell(`A${r}`).value = label
    sum.getCell(`A${r}`).font = { size: 9.5, color: { argb: X_MUTED } }
    sum.getCell(`B${r}`).value = value
    sum.getCell(`B${r}`).font = { size: 10, color: { argb: X_INK } }
    r++
  }
  meta('Prepared by', b.user)
  meta('Generated on', nowLabel())
  meta('Data as of', dayLabel(t.asOf))
  meta('Rows', String(t.rows.length))
  if (t.kpis?.length) {
    r++
    const kh = sum.getCell(`A${r}`)
    kh.value = 'Key figures'
    kh.font = { bold: true, size: 11, color: { argb: X_INK } }
    for (const col of ['A', 'B']) sum.getCell(`${col}${r}`).border = { bottom: { style: 'thin', color: { argb: X_RULE } } }
    r++
    for (const k of t.kpis) {
      const mm = k.value.match(/^(.*?)\s{2}\((.+)\)$/)
      sum.getCell(`A${r}`).value = k.label
      sum.getCell(`A${r}`).font = { size: 10, color: { argb: X_MUTED } }
      const v = sum.getCell(`B${r}`)
      v.value = mm ? mm[1] : k.value
      v.font = { bold: true, size: 12, color: { argb: X_INK } }
      v.alignment = { horizontal: 'right' }
      if (mm) {
        sum.getCell(`C${r}`).value = `${mm[2]} vs previous`
        sum.getCell(`C${r}`).font = { size: 9, color: { argb: X_MUTED } }
      }
      for (const col of ['A', 'B']) sum.getCell(`${col}${r}`).border = { bottom: { style: 'hair', color: { argb: X_RULE } } }
      sum.getRow(r).height = 20
      sum.getRow(r).alignment = { vertical: 'middle' }
      r++
    }
  }
  if (t.notes?.length) {
    r++
    for (const n of t.notes) {
      sum.mergeCells(`A${r}:D${r}`)
      const c = sum.getCell(`A${r}`)
      c.value = `Note: ${n}`
      c.font = { size: 9, color: { argb: X_MUTED } }
      c.alignment = { wrapText: true, vertical: 'top' }
      sum.getRow(r).height = Math.max(15, Math.ceil(n.length / 105) * 13)
      r++
    }
  }
  r++
  sum.getCell(`A${r}`).value = `Confidential · ${b.tenantName}. The detail is on the Data sheet.`
  sum.getCell(`A${r}`).font = { size: 8.5, color: { argb: 'FF9CA3AF' } }

  /* ---- Data ---- */
  const ws = wb.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }] })
  const wholeRupees = (key: string) => t.rows.every((row) => !isNum(row[key]) || Math.round(row[key] as number) % 100 === 0)
  const intOnly = (key: string) => t.rows.every((row) => !isNum(row[key]) || Number.isInteger(row[key]))
  ws.columns = t.columns.map((c) => {
    const sample = t.rows.slice(0, 300).map((row) => exportCellText(row[c.key], c.type).length)
    const longest = Math.max(c.label.length + (c.type === 'money' ? 4 : 0) + 3, ...sample.map((n) => n + 2))
    return { header: c.type === 'money' ? `${c.label} (₹)` : c.label, key: c.key, width: Math.min(c.type === 'string' ? 50 : 22, Math.max(numericType(c.type) ? 12 : 10, longest)) }
  })
  const header = ws.getRow(1)
  header.height = 22
  header.eachCell((cell, col) => {
    const c = t.columns[col - 1]
    cell.font = { bold: true, color: { argb: X_INK }, size: 10 }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: X_HEAD } }
    cell.alignment = { vertical: 'middle', horizontal: c && numericType(c.type) ? 'right' : 'left', wrapText: false }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } }
  })
  const cellValue = (c: ExportTable['columns'][number], v: unknown) => {
    if (v === null || v === undefined || v === '') return null
    if (typeof v === 'boolean') return v ? 'Yes' : 'No'
    if (c.type === 'money' && isNum(v)) return Math.round(v) / 100
    if (c.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
      const [y, m, d] = v.slice(0, 10).split('-').map(Number)
      return new Date(Date.UTC(y, m - 1, d))
    }
    return v as string | number
  }
  for (const row of t.rows) ws.addRow(Object.fromEntries(t.columns.map((c) => [c.key, cellValue(c, row[c.key])])))
  const fmtFor = (c: ExportTable['columns'][number]) =>
    c.type === 'money' ? (wholeRupees(c.key) ? INR_FMT_WHOLE : INR_FMT) : c.type === 'percent' ? '0.0%' : c.type === 'hours' ? '#,##0.0' : c.type === 'number' ? (intOnly(c.key) ? '#,##0' : '#,##0.00') : c.type === 'date' ? 'dd-mmm-yyyy' : undefined
  t.columns.forEach((c, i) => {
    const f = fmtFor(c)
    const col = ws.getColumn(i + 1)
    col.eachCell({ includeEmpty: false }, (cell, rowNo) => {
      if (rowNo === 1) return
      if (f) cell.numFmt = f
      cell.font = { size: 10, color: { argb: X_INK } }
      cell.alignment = { vertical: 'middle', horizontal: numericType(c.type) ? 'right' : c.type === 'date' ? 'left' : undefined }
    })
  })
  if (t.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: t.rows.length + 1, column: t.columns.length } }
  // totals row with SUM formulas for additive columns
  if (t.rows.length) {
    const tr = ws.addRow({})
    const first = 2
    const last = t.rows.length + 1
    tr.height = 20
    t.columns.forEach((c, i) => {
      const cell = tr.getCell(i + 1)
      const letter = ws.getColumn(i + 1).letter
      const tot = t.totals?.[c.key]
      const additive = c.type === 'money' || c.type === 'hours' || c.type === 'number'
      if (i === 0) cell.value = 'Total'
      else if (additive && (t.totals ? tot !== undefined && tot !== null : c.type !== 'number')) {
        const result = c.type === 'money' ? (isNum(tot) ? tot / 100 : undefined) : isNum(tot) ? tot : undefined
        cell.value = { formula: `SUM(${letter}${first}:${letter}${last})`, result } as import('exceljs').CellFormulaValue
      } else if (isNum(tot) && c.type === 'percent') cell.value = tot
      const f = fmtFor(c)
      if (f && i > 0) cell.numFmt = f
      cell.font = { bold: true, size: 10, color: { argb: X_INK } }
      cell.alignment = { vertical: 'middle', horizontal: numericType(c.type) ? 'right' : undefined }
      cell.border = { top: { style: 'thin', color: { argb: 'FF374151' } } }
    })
  }
  ws.pageSetup = { paperSize: 9, orientation, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1', horizontalCentered: false, margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 } }
  ws.headerFooter = hf(t.title)
  const buf = await wb.xlsx.writeBuffer()
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

/* ------------------------------------------------------------------ */
/* Public contract                                                      */
/* ------------------------------------------------------------------ */
export async function exportTable(t: ExportTable, format: ExportFormat, filename?: string): Promise<'saved' | 'declined' | 'failed'> {
  const name = fileBase(t, filename)
  try {
    if (format === 'csv') return await saveFile(`${name}.csv`, '﻿' + csvOf(t), 'text/csv')
    if (format === 'pdf') return await saveFile(`${name}.pdf`, await pdfOf(t), 'application/pdf')
    return await saveFile(`${name}.xlsx`, await xlsxOf(t), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  } catch (e) {
    console.error('export failed', e)
    return 'failed'
  }
}
