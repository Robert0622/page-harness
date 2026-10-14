// The panel's private channel to the page it is embedded in: a MessagePort handed to the parent once.
import type { PanelRole, ToPage, ToPanel } from '@shared/protocol'

export function connectPage(role: PanelRole, onMessage: (m: ToPanel) => void) {
  const appOrigin = document.documentElement.dataset.appOrigin
  const embedded = window.parent !== window && !!appOrigin
  let port: MessagePort | null = null
  if (embedded) {
    const ch = new MessageChannel()
    port = ch.port1
    port.onmessage = (e) => {
      const m = e.data as ToPanel
      if (m && typeof m === 'object' && typeof m.type === 'string') onMessage(m)
    }
    window.parent.postMessage({ type: 'ph:hello', role }, appOrigin!, [ch.port2])
  }
  return {
    embedded,
    send(m: ToPage) {
      port?.postMessage(m)
    },
  }
}
