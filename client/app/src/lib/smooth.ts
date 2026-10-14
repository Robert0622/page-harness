import { onBeforeUnmount, ref, watch, type Ref } from 'vue'

// Agents deliver text in bursts (several tokens every ~40ms, sometimes whole paragraphs at once).
// Revealing it frame by frame at a speed proportional to the backlog keeps the text flowing evenly
// while staying only a fraction of a second behind the stream.
const TAU_STREAMING = 160
const TAU_DONE = 70
const MIN_CPS = 40
const MAX_BACKLOG = 6000

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Returns a prefix of `source` that catches up smoothly while `streaming` (and briefly after it ends). */
export function useSmoothText(source: () => string, streaming: () => boolean): Ref<string> {
  const shown = ref(source())
  let pos = shown.value.length
  let frac = 0
  let raf = 0
  let last = 0

  const stop = () => {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }
  const tick = (now: number) => {
    raf = 0
    const src = source()
    const backlog = src.length - pos
    if (backlog <= 0 || backlog > MAX_BACKLOG || reducedMotion()) {
      pos = src.length
      shown.value = src
      return
    }
    const dt = Math.min(64, last ? now - last : 16)
    last = now
    const tau = streaming() ? TAU_STREAMING : TAU_DONE
    frac += Math.max(backlog * (1 - Math.exp(-dt / tau)), (MIN_CPS * dt) / 1000)
    let step = Math.floor(frac)
    if (step < 1) {
      raf = requestAnimationFrame(tick)
      return
    }
    frac -= step
    step = Math.min(step, backlog)
    let next = pos + step
    const code = src.charCodeAt(next - 1)
    if (code >= 0xd800 && code <= 0xdbff && next < src.length) next++
    pos = next
    shown.value = src.slice(0, pos)
    if (pos < src.length) raf = requestAnimationFrame(tick)
  }
  const kick = () => {
    if (raf) return
    last = 0
    raf = requestAnimationFrame(tick)
  }

  // Static content (history, artifact previews) is never animated.
  let live = streaming()
  watch(source, (src) => {
    if (!live || !src.startsWith(shown.value)) {
      stop()
      pos = src.length
      shown.value = src
      return
    }
    kick()
  })
  watch(streaming, (s) => {
    if (s) live = true
    if (source().length > pos) kick()
  })
  onBeforeUnmount(stop)
  return shown
}
