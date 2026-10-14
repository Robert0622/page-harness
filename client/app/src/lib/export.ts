// PNG / PDF export of rendered (non-HTML) artifacts. Both libraries are loaded only when used.
function stamp(name: string, ext: string) {
  return `${name.replace(/\.[^.]+$/, '')}.${ext}`
}

async function capture(el: HTMLElement): Promise<HTMLCanvasElement> {
  const { default: html2canvas } = await import('html2canvas')
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#fff'
  return html2canvas(el, { backgroundColor: bg, scale: Math.min(2, window.devicePixelRatio || 1), useCORS: true, windowWidth: el.scrollWidth, height: el.scrollHeight, windowHeight: el.scrollHeight })
}

function save(href: string, filename: string) {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export async function exportPng(el: HTMLElement, name: string) {
  const canvas = await capture(el)
  save(canvas.toDataURL('image/png'), stamp(name, 'png'))
}

export async function exportPdf(el: HTMLElement, name: string) {
  const canvas = await capture(el)
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'portrait' })
  const pw = pdf.internal.pageSize.getWidth()
  const ph = pdf.internal.pageSize.getHeight()
  const margin = 24
  const w = pw - margin * 2
  const scale = w / canvas.width
  const sliceH = Math.floor((ph - margin * 2) / scale)
  for (let y = 0, page = 0; y < canvas.height; y += sliceH, page++) {
    const part = document.createElement('canvas')
    part.width = canvas.width
    part.height = Math.min(sliceH, canvas.height - y)
    part.getContext('2d')!.drawImage(canvas, 0, y, canvas.width, part.height, 0, 0, canvas.width, part.height)
    if (page) pdf.addPage()
    pdf.addImage(part.toDataURL('image/png'), 'PNG', margin, margin, w, part.height * scale)
  }
  pdf.save(stamp(name, 'pdf'))
}
