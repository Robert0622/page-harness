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

function encode(canvas: HTMLCanvasElement): string | undefined {
  let scale = Math.min(1, MAX_W / Math.max(1, canvas.width), MAX_H / Math.max(1, canvas.height))
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
      if (url.startsWith('data:image/jpeg') && url.length <= MAX_IMG) return url
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

export async function snapshotPair(el: HTMLElement, revert: () => void, restore: () => void): Promise<ReviewLook> {
  const after = await snapshotLook(el)
  revert()
  const before = await snapshotLook(el)
  restore()
  return { beforeHtml: before.html, afterHtml: after.html, beforeImage: before.image, afterImage: after.image }
}
