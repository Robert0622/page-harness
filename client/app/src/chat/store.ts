// Reactive state of the chat panel: server connection, current chat, page bridge and settings.
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import type {
  AgentInfo,
  AskAnswer,
  Attachment,
  ChatMeta,
  HarnessMode,
  LiveDisplay,
  LiveRequest,
  LiveSession,
  Mark,
  ModelInfo,
  PageCaps,
  PageControlStatus,
  Pick,
  Me,
  QueueItem,
  ReviewState,
  ServerMsg,
  ToPanel,
  TurnView,
} from '@shared/protocol'
import { PAGE_CONTROL_VERSION } from '@shared/protocol'
import { applyEvent } from '@shared/turns'
import { api } from '../lib/api'
import { connectPage } from '../lib/bridge'
import { lang, langExplicit, setLang } from '../lib/i18n'
import { theme } from '../lib/theme'
import { createSocket } from '../lib/ws'

const bool = (k: string, d: boolean) => {
  try {
    const v = localStorage.getItem(k)
    return v === null ? d : v === '1'
  } catch {
    return d
  }
}
const saveBool = (k: string, v: boolean) => {
  try {
    localStorage.setItem(k, v ? '1' : '0')
  } catch {}
}

export interface DraftAttachment extends Attachment {
  preview?: string
  uploading?: boolean
  error?: string
}

export function createChatStore() {
  const agents = ref<AgentInfo[]>([])
  const defaultAgent = ref('')
  const project = ref('')
  const target = ref('')
  const mode = ref<HarnessMode>('source')
  const review = ref<ReviewState>({ items: [], approvals: [] })
  const me = ref<Me | null>(null)
  const share = ref<string | undefined>()
  const chats = ref<ChatMeta[]>([])
  const chat = ref<ChatMeta | null>(null)
  const turns = ref<TurnView[]>([])
  const hasMore = ref(false)
  const loadingOlder = ref(false)
  const queue = ref<QueueItem[]>([])
  const running = ref<string | null>(null)
  const pendingAsks = ref<Set<string>>(new Set())
  const liveSessions = ref<LiveSession[]>([])
  const liveViews = reactive<Record<string, { current: number; display: LiveDisplay }>>({})
  const pageStatus = ref<PageControlStatus>('disabled')
  const pageBusy = ref(false)
  const error = ref<string | null>(null)
  const notice = ref<string | null>(null)
  const models = shallowRef<Record<string, ModelInfo[] | null>>({})

  // page
  const page = reactive({ attached: false, tab: '', url: '', title: '', visible: true, caps: { pageControl: null, live: null } as PageCaps })
  const controlOn = ref(bool('ph:control', false))
  const liveOn = ref(bool('ph:live', true))

  // draft
  const draft = reactive({ text: '', picks: [] as Pick[], marks: [] as Mark[], attachments: [] as DraftAttachment[] })

  const savedChat = () => {
    try {
      return localStorage.getItem('ph:chat')
    } catch {
      return null
    }
  }

  const bridge = connectPage('chat', (m: ToPanel) => onPage(m))

  const sock = createSocket(
    (m) => onServer(m),
    () => {
      sock.send({ type: 'subscribe', chat: chat.value?.id ?? savedChat(), role: 'chat' })
      syncControl()
    },
  )

  watch(
    () => sock.state.value,
    (s, old) => {
      if (s === 'error' && old !== 'error') bridge.send({ type: 'ph:session-dead' })
    },
  )

  function syncControl() {
    sock.send({ type: 'page_control', on: controlOn.value && page.attached, attached: page.attached, visible: page.visible, tab: page.tab, version: page.caps.pageControl })
  }

  function onServer(m: ServerMsg) {
    switch (m.type) {
      case 'hello':
        agents.value = m.agents
        defaultAgent.value = m.defaultAgent
        project.value = m.project
        target.value = m.target
        mode.value = m.mode
        me.value = m.me
        share.value = m.share
        sendLiveCaps()
        sendReview()
        break
      case 'chats':
        chats.value = m.chats
        break
      case 'snapshot': {
        const s = m.snapshot
        chat.value = s.chat
        turns.value = s.turns
        hasMore.value = s.hasMore
        queue.value = s.queue
        running.value = s.running
        pendingAsks.value = new Set(s.pendingAsks)
        try {
          localStorage.setItem('ph:chat', s.chat.id)
        } catch {}
        break
      }
      case 'event': {
        if (m.event.chatId !== chat.value?.id) break
        applyEvent(turns.value, m.event)
        if (m.event.t === 'ask') pendingAsks.value = new Set([...pendingAsks.value, m.event.askId])
        if (m.event.t === 'ask_answer') {
          const next = new Set(pendingAsks.value)
          next.delete(m.event.askId)
          pendingAsks.value = next
        }
        turns.value = [...turns.value]
        break
      }
      case 'state':
        if (m.chatId !== chat.value?.id) break
        chat.value = m.chat
        queue.value = m.queue
        running.value = m.running
        break
      case 'live':
        liveSessions.value = m.sessions
        bridge.send({ type: 'ph:live-sessions', sessions: JSON.parse(JSON.stringify(m.sessions)) })
        break
      case 'review':
        review.value = m.review
        sendReview()
        break
      case 'page_probe':
        bridge.send({ type: 'ph:probe', id: m.id, selector: m.selector })
        break
      case 'artifacts':
        if (m.open) bridge.send({ type: 'ph:open', what: 'artifacts' })
        break
      case 'page_cmd':
        bridge.send({ type: 'ph:cmd', id: m.id, cmd: m.cmd })
        break
      case 'page_cancel':
        bridge.send({ type: 'ph:cmd-cancel', id: m.id })
        break
      case 'page_status':
        pageStatus.value = m.status
        if (pageBusy.value !== m.busy) bridge.send({ type: 'ph:busy', busy: m.busy })
        pageBusy.value = m.busy
        break
      case 'notice':
        notice.value = m.message
        break
      case 'error':
        error.value = m.message
        setTimeout(() => error.value === m.message && (error.value = null), 5000)
        break
    }
  }

  function onPage(m: ToPanel) {
    switch (m.type) {
      case 'ph:attach':
        page.attached = true
        page.tab = m.tab
        page.url = m.url
        page.title = m.title
        page.visible = m.visible
        page.caps = m.caps
        theme.value = m.theme
        if (!langExplicit.value && m.lang !== lang.value) setLang(m.lang, false)
        bridge.send({ type: 'ph:ready', role: 'chat' })
        bridge.send({ type: 'ph:lang', lang: lang.value })
        bridge.send({ type: 'ph:control', on: controlOn.value })
        sendLiveCaps()
        sendReview()
        bridge.send({ type: 'ph:live-sessions', sessions: JSON.parse(JSON.stringify(liveSessions.value)) })
        syncControl()
        break
      case 'ph:url':
        page.url = m.url
        page.title = m.title
        break
      case 'ph:visibility':
        page.visible = m.visible
        sock.send({ type: 'page_visibility', visible: m.visible })
        break
      case 'ph:caps':
        page.caps = m.caps
        syncControl()
        break
      case 'ph:pick':
        if (draft.picks.length < 20 && !draft.picks.some((p) => p.selector === m.pick.selector && p.url === m.pick.url)) draft.picks.push(m.pick)
        break
      case 'ph:probe-result':
        sock.send({ type: 'probe_result', id: m.id, result: m.result })
        break
      case 'ph:review-remove':
        sock.send({ type: 'review_remove', id: m.id })
        break
      case 'ph:review-add':
        sock.send({ type: 'review_add', draft: m.draft })
        break
      case 'ph:review-look':
        sock.send({ type: 'review_look', id: m.id, look: m.look })
        break
      case 'ph:review-reply':
        sock.send({ type: 'review_reply', id: m.id, text: m.text })
        break
      case 'ph:review-edit':
        sock.send({ type: 'review_edit', id: m.id, note: m.note })
        break
      case 'ph:review-status':
        sock.send({ type: 'review_status', id: m.id, status: m.status })
        break
      case 'ph:review-approve':
        sock.send({ type: 'review_approve', url: m.url, status: m.status })
        break
      case 'ph:review-clear':
        sock.send({ type: 'review_clear' })
        break
      case 'ph:review-export':
        sock.send({ type: 'review_export' })
        break
      case 'ph:cmd-result':
        sock.send({ type: 'page_result', id: m.id, result: m.result })
        break
      case 'ph:live':
        sock.send({ type: 'live_op', request: m.request })
        break
      case 'ph:live-view':
        liveViews[m.sid] = { current: m.current, display: m.display }
        break
      case 'ph:theme':
        theme.value = m.theme
        break
      case 'ph:control-stop':
        controlOn.value = false
        sock.send({ type: 'page_stop' })
        break
    }
  }

  watch(controlOn, (on) => {
    saveBool('ph:control', on)
    bridge.send({ type: 'ph:control', on })
    syncControl()
  })
  watch(liveOn, (on) => {
    saveBool('ph:live', on)
    sendLiveCaps()
  })
  function sendLiveCaps() {
    bridge.send({ type: 'ph:live-caps', on: liveOn.value && me.value?.access !== 'reviewer' })
  }
  function sendReview() {
    if (!me.value) return
    bridge.send({ type: 'ph:review-items', review: JSON.parse(JSON.stringify(review.value)), mode: mode.value, me: { ...me.value } })
  }
  watch(lang, (l) => bridge.send({ type: 'ph:lang', lang: l }))

  const controlOutdated = computed(() => controlOn.value && page.attached && page.caps.pageControl !== null && page.caps.pageControl !== PAGE_CONTROL_VERSION)

  // ---------- actions ----------
  const canSend = computed(() => !!(draft.text.trim() || draft.picks.length || draft.attachments.some((a) => !a.uploading && !a.error)) && !draft.attachments.some((a) => a.uploading))

  function sendPrompt() {
    if (!canSend.value) return false
    const ok = sock.send({
      type: 'prompt',
      message: {
        text: draft.text.trim(),
        picks: draft.picks.map((p) => ({ ...p })),
        marks: draft.marks.length ? draft.marks.map((m) => ({ ...m })) : undefined,
        attachments: draft.attachments.filter((a) => !a.error && !a.uploading).map(({ id, name, mime, size, kind }) => ({ id, name, mime, size, kind })),
        pageUrl: page.url || undefined,
      },
    })
    if (!ok) return false
    for (const a of draft.attachments) if (a.preview) URL.revokeObjectURL(a.preview)
    draft.text = ''
    draft.picks = []
    draft.marks = []
    draft.attachments = []
    return true
  }

  async function addFiles(files: Iterable<File>) {
    for (const f of files) {
      const local: DraftAttachment = reactive({ id: '', name: f.name || 'pasted.png', mime: f.type, size: f.size, kind: f.type.startsWith('image/') ? 'image' : 'file', uploading: true, preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined })
      draft.attachments.push(local)
      try {
        const a = await api.upload<Attachment>(f, local.name)
        Object.assign(local, a, { uploading: false })
      } catch (e) {
        local.uploading = false
        local.error = e instanceof Error ? e.message : String(e)
      }
    }
  }

  function editQueued(item: QueueItem) {
    sock.send({ type: 'dequeue', id: item.id })
    draft.text = item.text
    draft.picks = [...item.picks]
    draft.marks = [...(item.marks ?? [])]
    draft.attachments = item.attachments.map((a) => ({ ...a }))
  }

  async function loadOlder() {
    if (!chat.value || !hasMore.value || loadingOlder.value || !turns.value.length) return
    loadingOlder.value = true
    try {
      const r = await api.get<{ turns: TurnView[]; hasMore: boolean }>(`chats/${chat.value.id}/turns?before=${turns.value[0].id}&limit=20`)
      turns.value = [...r.turns.filter((x) => !turns.value.some((y) => y.id === x.id)), ...turns.value]
      hasMore.value = r.hasMore
    } finally {
      loadingOlder.value = false
    }
  }

  function switchChat(id: string) {
    sock.send({ type: 'subscribe', chat: id, role: 'chat' })
  }

  async function newChat() {
    const meta = await api.post<ChatMeta>('chats', { agent: chat.value?.agent, model: chat.value?.model })
    switchChat(meta.id)
  }

  async function updateChat(patch: { title?: string; agent?: string; model?: string | null; effort?: string | null; fast?: boolean }) {
    if (!chat.value) return
    chat.value = await api.patch<ChatMeta>(`chats/${chat.value.id}`, patch)
  }

  async function loadModels(agent: string) {
    if (models.value[agent]) return
    try {
      const raw = await api.get<Array<ModelInfo | string>>(`agents/${agent}/models`)
      const list = raw.map((m) => (typeof m === 'string' ? { id: m, label: m } : m)).filter((m) => m?.id)
      models.value = { ...models.value, [agent]: list }
    } catch {
      models.value = { ...models.value, [agent]: null }
    }
  }

  function answer(askId: string, a: AskAnswer) {
    sock.send({ type: 'answer', askId, answer: a })
  }

  function live(request: LiveRequest) {
    sock.send({ type: 'live_op', request })
  }

  function liveNav(sid: string, current?: number, display?: LiveDisplay) {
    const v = (liveViews[sid] ??= { current: current ?? 1, display: display ?? 'inplace' })
    if (current !== undefined) v.current = current
    if (display) v.display = display
    bridge.send({ type: 'ph:live-nav', sid, current, display })
  }

  const panelChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ph-panel') : null
  const followChat = (id?: string) => {
    if (id) switchChat(id)
  }
  if (panelChannel)
    panelChannel.onmessage = (e) => {
      const d = e.data as { type?: string; id?: string }
      if (d?.type === 'switch-chat') followChat(d.id)
    }
  window.addEventListener('storage', (e) => {
    if (e.key !== 'ph:chat-switch' || !e.newValue) return
    try {
      followChat((JSON.parse(e.newValue) as { id?: string }).id)
    } catch {}
  })
  function openArtifact(name: string, version?: number) {
    try {
      localStorage.setItem('ph:art-open', JSON.stringify({ name, version, ts: Date.now() }))
    } catch {}
    panelChannel?.postMessage({ type: 'open-artifact', name, version })
    bridge.send({ type: 'ph:open', what: 'artifacts' })
  }

  return {
    openArtifact,
    agents, defaultAgent, project, target, mode, review, me, share, chats, chat, turns, hasMore, loadingOlder, queue, running, pendingAsks,
    liveSessions, liveViews, pageStatus, pageBusy, error, notice, models, page, controlOn, liveOn, draft, canSend,
    controlOutdated, conn: sock.state, embedded: bridge.embedded,
    reconnect: sock.reconnect,
    send: sock.send,
    sendPrompt, addFiles, editQueued, loadOlder, switchChat, newChat, updateChat, loadModels, answer, live, liveNav,
    setName(name: string) {
      sock.send({ type: 'set_name', name })
    },
    setTheme(t: 'light' | 'dark') {
      theme.value = t
      bridge.send({ type: 'ph:theme', theme: t })
    },
  }
}

export type ChatStore = ReturnType<typeof createChatStore>
