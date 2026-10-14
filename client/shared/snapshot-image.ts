// Rasterises an element for the review card and page-review.md.
// Text and lists are drawn with the browser (foreignObject) from a styled clone, so a tight line
// box, a modern color, or a scrolled page cannot turn the shot into a blank strip or only the
// tail of a list. Photos stay on html2canvas, which already keeps their border and tilt.
import html2canvas from 'html2canvas'
import type { ReviewLook } from '@shared/protocol'
import { snapshotHtml } from './snapshot'

const MAX_IMG = 160_000
const MAX_W = 480
const MAX_H = 640
const PAD = 10

function hasMedia(el: HTMLElement): boolean {
  return el.tagName === 'IMG' || el.tagName === 'CANVAS' || el.tagName === 'VIDEO' || !!el.querySelector('img, canvas, video, svg')
}

/** True when the bitmap is more than a flat white or empty bar. */
function hasInk(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx || canvas.width < 2 || canvas.height < 2) return false
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  } catch {
    return false
  }
  let n = 0
  for (let i = 0; i < data.length; i += 64) {
    if (data[i] < 210 || data[i + 1] < 210 || data[i + 2] < 210) {
      n++
      if (n >= 8) return true
    }
  }
  return false
}

/** Crops the white margin around the ink, so a full-width heading is not a tiny word in a wide strip. */
function trim(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d')
  if (!ctx) return canvas
  const { width: w, height: h } = canvas
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, w, h).data
  } catch {
    return canvas
  }
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < 0) return canvas
  x0 = Math.max(0, x0 - PAD)
  y0 = Math.max(0, y0 - PAD)
  x1 = Math.min(w - 1, x1 + PAD)
  y1 = Math.min(h - 1, y1 + PAD)
  if (x0 === 0 && y0 === 0 && x1 === w - 1 && y1 === h - 1) return canvas
  const out = document.createElement('canvas')
  out.width = x1 - x0 + 1
  out.height = y1 - y0 + 1
  out.getContext('2d')?.drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height)
  return out
}

function encode(source: HTMLCanvasElement, limits = { w: MAX_W, h: MAX_H, bytes: MAX_IMG, trim: true }): string | undefined {
  const canvas = limits.trim ? trim(source) : source
  let scale = Math.min(1, limits.w / Math.max(1, canvas.width), limits.h / Math.max(1, canvas.height))
  for (let q = 0.72; q >= 0.45 && scale >= 0.2; q -= 0.12) {
    const out = document.createElement('canvas')
    out.width = Math.max(1, Math.round(canvas.width * scale))
    out.height = Math.max(1, Math.round(canvas.height * scale))
    const ctx = out.getContext('2d')
    if (!ctx) return undefined
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(canvas, 0, 0, out.width, out.height)
    try {
      const url = out.toDataURL('image/jpeg', q)
      if (url.startsWith('data:image/jpeg') && url.length <= limits.bytes) return url
    } catch {
      return undefined
    }
    scale *= 0.8
  }
  return undefined
}

/** Full element, plus padding so italic and descenders are not clipped to a blank line. */
function foreignCanvas(el: HTMLElement): Promise<HTMLCanvasElement | undefined> {
  const rect = el.getBoundingClientRect()
  const innerW = Math.max(1, Math.ceil(Math.max(rect.width, el.scrollWidth)))
  const innerH = Math.max(1, Math.ceil(Math.max(rect.height, el.scrollHeight)))
  const w = innerW + PAD * 2
  const h = innerH + PAD * 2
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  const fo = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject')
  fo.setAttribute('x', '0')
  fo.setAttribute('y', '0')
  fo.setAttribute('width', String(w))
  fo.setAttribute('height', String(h))
  const wrap = document.createElementNS('http://www.w3.org/1999/xhtml', 'div')
  wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')
  wrap.setAttribute('style', `box-sizing:border-box;background:#ffffff;margin:0;padding:${PAD}px;width:${w}px;overflow:visible`)
  wrap.innerHTML = snapshotHtml(el)
  const root = wrap.firstElementChild
  if (root instanceof HTMLElement) root.style.margin = '0'
  fo.appendChild(wrap)
  svg.appendChild(fo)
  const xml = new XMLSerializer().serializeToString(svg)
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(undefined)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      try {
        ctx.drawImage(img, 0, 0, w, h)
      } catch {
        return resolve(undefined)
      }
      resolve(canvas)
    }
    img.onerror = () => resolve(undefined)
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
  })
}

async function mediaCanvas(el: HTMLElement): Promise<HTMLCanvasElement | undefined> {
  try {
    return await html2canvas(el, { backgroundColor: '#ffffff', scale: 1, useCORS: true, logging: false, imageTimeout: 1500 })
  } catch {
    return undefined
  }
}

async function raster(el: HTMLElement): Promise<string | undefined> {
  if (hasMedia(el)) {
    const canvas = await mediaCanvas(el)
    return canvas && hasInk(canvas) ? encode(canvas) : undefined
  }
  const drawn = await foreignCanvas(el)
  if (drawn && hasInk(drawn)) return encode(drawn)
  const fallback = await mediaCanvas(el)
  return fallback && hasInk(fallback) ? encode(fallback) : undefined
}

export async function snapshotLook(el: HTMLElement): Promise<{ html: string; image?: string }> {
  const html = snapshotHtml(el)
  const image = await raster(el)
  return image ? { html, image } : { html }
}

const PAGE_W = 900
const PAGE_MAX_H = 6000
const PAGE_MAX_IMG = 240_000
const PAGE_LIMITS = { w: PAGE_W, h: 2400, bytes: PAGE_MAX_IMG, trim: false }

export interface PageShot {
  canvas: HTMLCanvasElement
  scale: number
}

/** An element's box in page coordinates, measured in the same state the page shot was taken in. */
export interface PageBox {
  x: number
  y: number
  w: number
  h: number
}

export function pageBox(el: Element): PageBox {
  const r = el.getBoundingClientRect()
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height }
}

/**
 * Renders the page without the overlay. html2canvas clones the DOM before its first await,
 * so the caller may change the page again as soon as this returns.
 */
export function pageShot(): Promise<PageShot | undefined> {
  const doc = document.documentElement
  const w = Math.max(doc.scrollWidth, doc.clientWidth)
  const h = Math.min(PAGE_MAX_H, Math.max(doc.scrollHeight, doc.clientHeight))
  const scale = Math.min(1, PAGE_W / Math.max(1, w))
  return html2canvas(doc, {
    x: 0,
    y: 0,
    width: w,
    height: h,
    scale,
    backgroundColor: '#ffffff',
    useCORS: true,
    logging: false,
    imageTimeout: 1500,
    ignoreElements: (n) => n.hasAttribute?.('data-page-harness') ?? false,
  }).then(
    (canvas) => ({ canvas, scale }),
    () => undefined,
  )
}

/** A window of the page shot around the box, with the box outlined. */
export function markPage(shot: PageShot, box: PageBox): string | undefined {
  const { canvas, scale } = shot
  const bx = box.x * scale
  const by = box.y * scale
  if (!box.w || !box.h || by > canvas.height) return undefined
  const winH = Math.min(canvas.height, Math.round(innerHeight * 2.5 * scale))
  const y0 = Math.min(Math.max(0, Math.round(by + (box.h * scale) / 2 - winH / 2)), canvas.height - winH)
  const out = document.createElement('canvas')
  out.width = canvas.width
  out.height = winH
  const ctx = out.getContext('2d')
  if (!ctx) return undefined
  ctx.drawImage(canvas, 0, y0, canvas.width, winH, 0, 0, canvas.width, winH)
  const pad = 6
  const rect: [number, number, number, number] = [bx - pad, by - y0 - pad, box.w * scale + pad * 2, box.h * scale + pad * 2]
  ctx.fillStyle = 'rgba(123, 97, 255, 0.12)'
  ctx.fillRect(...rect)
  ctx.lineWidth = 3
  ctx.strokeStyle = '#7b61ff'
  ctx.strokeRect(...rect)
  return encode(out, PAGE_LIMITS)
}

export async function snapshotPair(el: HTMLElement, revert: () => void, restore: () => void): Promise<ReviewLook> {
  const after = await snapshotLook(el)
  revert()
  const before = await snapshotLook(el)
  restore()
  return { beforeHtml: before.html, afterHtml: after.html, beforeImage: before.image, afterImage: after.image }
}
