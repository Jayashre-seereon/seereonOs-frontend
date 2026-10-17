// Letter / payslip PDF: lays out an issued document's markup (letterhead, headings, paragraphs with bold runs,
// lists, tables) on A4 with jsPDF. Same markup parser as the server renderer, so the PDF matches the screen.
import type { Letterhead } from '@/api/docs'
import { parseMarkup, runsText, type Run } from '@/mock/docMarkup'
import { SEEREON_LOGO } from '@/assets/brand'
import { useSession } from '@/stores/session'
import { saveFile } from '@/lib/utils'

type RGB = [number, number, number]
const INK: RGB = [17, 24, 39]
const INK2: RGB = [55, 65, 81]
const INK3: RGB = [107, 114, 128]
const RULE: RGB = [209, 213, 219]
const HEAD_FILL: RGB = [243, 244, 246]

function hexRgb(hex: string): RGB {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}
async function pngOf(src: string, maxW = 700): Promise<{ data: string; w: number; h: number } | null> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.crossOrigin = 'anonymous'
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('image'))
      i.src = src
    })
    const w0 = img.naturalWidth || 200
    const h0 = img.naturalHeight || 200
    const k = Math.min(1, maxW / w0)
    const c = document.createElement('canvas')
    c.width = Math.round(w0 * k)
    c.height = Math.round(h0 * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return { data: c.toDataURL('image/png'), w: c.width, h: c.height }
  } catch {
    return null
  }
}

export interface LetterPdfInput {
  title: string
  ref_no: string
  body_md: string
  letterhead: Letterhead | null
  status: string
  issued_on: string | null
  filename: string
}

export async function letterPdfBlob(d: LetterPdfInput): Promise<Blob> {
  const [{ jsPDF }, autoTableMod, fontMod] = await Promise.all([import('jspdf'), import('jspdf-autotable'), import('@/reports/pdfFont')])
  const autoTable = (autoTableMod as unknown as { default: (doc: unknown, o: unknown) => void }).default
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true })
  let font = 'helvetica'
  try {
    doc.addFileToVFS('Carlito-Regular.ttf', fontMod.CARLITO_REGULAR)
    doc.addFont('Carlito-Regular.ttf', 'Carlito', 'normal')
    doc.addFileToVFS('Carlito-Bold.ttf', fontMod.CARLITO_BOLD)
    doc.addFont('Carlito-Bold.ttf', 'Carlito', 'bold')
    font = 'Carlito'
  } catch {
    font = 'helvetica'
  }
  const tx = (s: string) => (font === 'Carlito' ? s : s.replace(/₹/g, 'Rs. ').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[’‘]/g, "'").replace(/·/g, '-'))
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()
  const M = 20
  const CW = W - 2 * M
  const BOTTOM = H - 22
  const tenant = useSession.getState().tenant
  const brand: RGB = tenant?.theme?.primary && /^#[0-9a-f]{6}$/i.test(tenant.theme.primary) ? hexRgb(tenant.theme.primary) : [12, 107, 78]
  const set = (size: number, color: RGB, bold = false) => {
    doc.setFont(font, bold ? 'bold' : 'normal')
    doc.setFontSize(size)
    doc.setTextColor(...color)
  }

  /* ---- letterhead ---- */
  let y = 16
  const lh = d.letterhead
  if (lh) {
    const logoSrc = lh.logo === 'seereon' ? SEEREON_LOGO : lh.logo
    const logo = logoSrc ? await pngOf(logoSrc) : null
    let logoW = 0
    if (logo) {
      const ratio = logo.w / logo.h
      logoW = Math.min(46, ratio * 15)
      doc.addImage(logo.data, 'PNG', M, y - 2, logoW, logoW / ratio)
    }
    const rx = W - M
    set(11.5, INK, true)
    doc.text(tx(lh.legal_name), rx, y + 2, { align: 'right' })
    set(8.5, INK3)
    const lines = [lh.address, [lh.cin && `CIN ${lh.cin}`, lh.gstin && `GSTIN ${lh.gstin}`].filter(Boolean).join('  ·  '), [lh.email, lh.phone, lh.website].filter(Boolean).join('  ·  ')].filter(Boolean)
    let ly = y + 7
    for (const l of lines) {
      for (const part of doc.splitTextToSize(tx(l), CW - logoW - 8) as string[]) {
        doc.text(part, rx, ly, { align: 'right' })
        ly += 3.8
      }
    }
    y = Math.max(y + 16, ly) + 2
    doc.setDrawColor(...brand)
    doc.setLineWidth(0.6)
    doc.line(M, y, W - M, y)
    y += 9
  } else y = 22

  if (d.status === 'revoked' || d.status === 'draft') {
    set(9, d.status === 'revoked' ? [185, 28, 28] : INK3, true)
    doc.text(d.status === 'revoked' ? 'REVOKED — NOT VALID' : 'DRAFT — NOT ISSUED', W - M, y - 3, { align: 'right' })
  }

  const ensure = (h: number) => {
    if (y + h > BOTTOM) {
      doc.addPage()
      y = 22
    }
  }

  /* ---- rich line layout (bold runs, wrap, alignment) ---- */
  const SIZE = 10.5
  const LH = 5.1
  const layout = (runs: Run[], width: number) => {
    type Seg = { text: string; bold: boolean; w: number }
    const lines: Seg[][] = [[]]
    let cur = 0
    for (const r of runs) {
      const parts = tx(r.text).split(/(\s+)/).filter((p) => p.length)
      for (const p of parts) {
        doc.setFont(font, r.bold ? 'bold' : 'normal')
        doc.setFontSize(SIZE)
        const w = doc.getTextWidth(p)
        const isSpace = /^\s+$/.test(p)
        if (!isSpace && cur + w > width && cur > 0) {
          lines.push([])
          cur = 0
        }
        if (isSpace && cur === 0) continue
        lines[lines.length - 1].push({ text: p, bold: r.bold, w })
        cur += w
      }
    }
    return lines.map((l) => {
      while (l.length && /^\s+$/.test(l[l.length - 1].text)) l.pop()
      return l
    })
  }
  const drawRich = (runs: Run[], x: number, width: number, align: 'left' | 'center' | 'right', color: RGB = INK2) => {
    for (const line of layout(runs, width)) {
      ensure(LH)
      const lw = line.reduce((s, g) => s + g.w, 0)
      let cx = align === 'center' ? x + (width - lw) / 2 : align === 'right' ? x + width - lw : x
      for (const g of line) {
        set(SIZE, g.bold ? INK : color, g.bold)
        doc.text(g.text, cx, y)
        cx += g.w
      }
      y += LH
    }
  }

  for (const b of parseMarkup(d.body_md)) {
    if (b.type === 'h') {
      const size = b.level === 1 ? 16 : b.level === 2 ? 13 : 11
      ensure(size * 0.5 + 6)
      y += b.level === 3 ? 1.5 : 2.5
      set(size, INK, true)
      const text = tx(runsText(b.runs))
      for (const part of doc.splitTextToSize(text, CW) as string[]) {
        doc.text(part, b.align === 'center' ? W / 2 : b.align === 'right' ? W - M : M, y, { align: b.align })
        y += size * 0.45
      }
      y += 2.5
    } else if (b.type === 'p') {
      for (const line of b.lines) drawRich(line, M, CW, b.align)
      y += 2.6
    } else if (b.type === 'ul' || b.type === 'ol') {
      b.items.forEach((it, i) => {
        ensure(LH)
        set(SIZE, INK2)
        doc.text(b.type === 'ul' ? '•' : `${i + 1}.`, M + 1.5, y)
        drawRich(it, M + 7, CW - 7, 'left')
        y += 0.8
      })
      y += 2
    } else if (b.type === 'hr') {
      ensure(6)
      doc.setDrawColor(...RULE)
      doc.setLineWidth(0.3)
      doc.line(M, y - 1, W - M, y - 1)
      y += 5
    } else if (b.type === 'table') {
      const cols = Math.max(b.header?.length ?? 0, ...b.rows.map((r) => r.length))
      const pad = (r: Run[][]) => [...r, ...Array.from({ length: Math.max(0, cols - r.length) }, () => [] as Run[])]
      const numeric = (c: Run[]) => /^[-−]?\s*(₹|Rs\.?)?\s*[\d,]+(\.\d+)?\s*%?$/.test(runsText(c).trim())
      const cell = (c: Run[]) => ({ content: tx(runsText(c)), styles: { fontStyle: c.some((r) => r.bold) ? 'bold' : 'normal', halign: numeric(c) ? 'right' : 'left', textColor: c.some((r) => r.bold) ? INK : INK2 } })
      ensure(14)
      autoTable(doc, {
        startY: y - 2,
        margin: { left: M, right: M, bottom: H - BOTTOM },
        head: b.header ? [pad(b.header).map((c) => ({ ...cell(c), styles: { ...cell(c).styles, fontStyle: 'bold', textColor: INK, fillColor: HEAD_FILL } }))] : undefined,
        body: b.rows.map((r) => pad(r).map(cell)),
        theme: 'grid',
        styles: { font, fontSize: 9.5, cellPadding: { top: 1.8, bottom: 1.8, left: 2.5, right: 2.5 }, lineColor: RULE, lineWidth: 0.2, textColor: INK2, valign: 'middle' },
        headStyles: { fillColor: HEAD_FILL, textColor: INK, fontStyle: 'bold' },
        didDrawPage: () => undefined,
      })
      y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6
    }
  }

  /* ---- footer on every page ---- */
  const pages = doc.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i)
    doc.setDrawColor(...RULE)
    doc.setLineWidth(0.2)
    doc.line(M, H - 14, W - M, H - 14)
    set(8, INK3)
    doc.text(tx(`Ref ${d.ref_no || '—'}${d.issued_on ? `  ·  Issued ${d.issued_on}` : ''}  ·  ${d.title}`).slice(0, 120), M, H - 9.5)
    doc.text(`Page ${i} of ${pages}`, W - M, H - 9.5, { align: 'right' })
  }
  return doc.output('blob')
}

export async function downloadLetterPdf(d: LetterPdfInput): Promise<'saved' | 'declined' | 'failed'> {
  try {
    const blob = await letterPdfBlob(d)
    return await saveFile(d.filename, blob, 'application/pdf')
  } catch (e) {
    console.error('letter pdf failed', e)
    return 'failed'
  }
}
export function pdfName(title: string, ref: string) {
  return `${(ref || title).replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}.pdf`
}
