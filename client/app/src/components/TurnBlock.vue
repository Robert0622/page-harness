<script setup lang="ts">
import { computed, ref } from 'vue'
import type { AskAnswer, LiveDisplay, LiveRequest, LiveSession, TurnItem, TurnView } from '@shared/protocol'
import { isEmptyTurn } from '@shared/turns'
import { uploadUrl } from '../lib/api'
import { duration, relTime, t } from '../lib/i18n'
import AskCard from './AskCard.vue'
import Icon from './Icon.vue'
import LiveCard from './LiveCard.vue'
import Markdown from './Markdown.vue'
import ThoughtStatus from './ThoughtStatus.vue'
import ToolGroup from './ToolGroup.vue'

type ToolItem = Extract<TurnItem, { kind: 'tool' }>
type Block = { kind: 'tools'; items: ToolItem[]; last: boolean; key: string } | { kind: 'item'; item: TurnItem; index: number; last: boolean; key: string }

const props = defineProps<{
  turn: TurnView
  interactive: boolean
  pendingAsks?: Set<string>
  liveSessions?: LiveSession[]
  liveViews?: Record<string, { current: number; display: LiveDisplay }>
  /** This turn is the newest request of its Live session; only that one carries controls. */
  liveLatest?: boolean
  now: number
}>()
const emit = defineEmits<{
  answer: [askId: string, a: AskAnswer]
  retry: [turnId: string]
  live: [req: LiveRequest]
  nav: [sid: string, current?: number, display?: LiveDisplay]
  image: [src: string]
  artifact: [name: string, version: number]
}>()

const running = computed(() => props.turn.status === 'running')
/** Older turns saved a stop as an error item saying "cancelled"; show them as cancelled, not failed. */
const isStopNote = (item: TurnItem) => item.kind === 'error' && item.message === 'cancelled'
const status = computed(() => {
  const errors = props.turn.items.filter((i) => i.kind === 'error')
  return props.turn.status === 'error' && errors.length > 0 && errors.every(isStopNote) ? 'cancelled' : props.turn.status
})
const empty = computed(() => isEmptyTurn(props.turn))
const live = computed(() => props.turn.user.live)
const session = computed(() => (live.value?.sid ? props.liveSessions?.find((s) => s.sid === live.value!.sid) : undefined))
/** The full card waits under the reply until the agent's turn ends. */
const showAgentLive = computed(
  () => !!live.value && !!session.value && !!props.liveLatest && !running.value && live.value.op !== 'accept' && live.value.op !== 'discard',
)
const filesOpen = ref(false)
const thinkingOpen = ref<Record<number, boolean>>({})
const rateLimited = (msg: string) => /rate.?limit|429|quota|too many requests|usage limit|overloaded/i.test(msg)

/** Consecutive tool calls collapse into one group line. */
const blocks = computed<Block[]>(() => {
  const out: Block[] = []
  const items = props.turn.items
  items.forEach((item, index) => {
    if (isStopNote(item)) return
    const prev = out[out.length - 1]
    if (item.kind === 'tool') {
      if (prev?.kind === 'tools') prev.items.push(item)
      else out.push({ kind: 'tools', items: [item], last: false, key: `g${index}` })
    } else out.push({ kind: 'item', item, index, last: false, key: `i${index}` })
  })
  if (out.length) out[out.length - 1].last = true
  return out
})
const lastItem = computed(() => props.turn.items[props.turn.items.length - 1])
const writing = computed(() => running.value && lastItem.value?.kind === 'text')
const thoughtState = computed(() => (running.value ? 'generating' : status.value === 'done' ? 'done' : 'interrupted'))

const statusText = computed(() => {
  switch (status.value) {
    case 'done': return t.value.done
    case 'cancelled': return t.value.cancelled
    case 'interrupted': return t.value.interrupted
    case 'error': return t.value.failed
    default: return ''
  }
})
const details = computed(() => {
  const u = props.turn.usage
  const n = u ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : 0
  return [props.turn.durationMs ? duration(props.turn.durationMs) : '', n ? `${n.toLocaleString()} ${t.value.tokens}` : '', props.turn.model ?? '', props.turn.agent ?? '']
    .filter(Boolean)
    .join(' · ')
})
const canRetry = computed(() => props.interactive && !live.value && !empty.value && ['error', 'cancelled', 'interrupted'].includes(status.value))

/** Remember only a manual toggle that differs from the automatic open state. Auto-expand while generating must not stick. */
function onThinkingClick(index: number, last: boolean, ev: MouseEvent) {
  ev.preventDefault()
  const details = (ev.currentTarget as HTMLElement).parentElement as HTMLDetailsElement
  const next = !details.open
  const auto = running.value && last
  if (next === auto) {
    if (index in thinkingOpen.value) {
      const rest = { ...thinkingOpen.value }
      delete rest[index]
      thinkingOpen.value = rest
    }
    return
  }
  thinkingOpen.value = { ...thinkingOpen.value, [index]: next }
}
</script>

<template>
  <div class="turn" :data-turn="turn.id">
    <div class="row user">
      <div class="av me">{{ t.me }}</div>
      <div class="col">
        <LiveCard v-if="live" compact :session="session" :title="turn.user.text" :interactive="false" />
        <div v-else class="bubble">
          <div v-if="turn.user.picks.length || turn.user.marks?.length" class="chips">
            <span v-for="p in turn.user.picks" :key="p.id" class="chip" :title="p.selector"><Icon name="target" />&lt;{{ p.tagName.toLowerCase() }}&gt; {{ p.text || p.selector }}</span>
            <span v-if="turn.user.marks?.length" class="chip"><Icon name="pen" />{{ t.marks }} × {{ turn.user.marks.length }}</span>
          </div>
          <div v-if="turn.user.text" class="text">{{ turn.user.text }}</div>
          <div v-if="turn.user.attachments.length" class="atts">
            <template v-for="a in turn.user.attachments" :key="a.id">
              <img v-if="a.kind === 'image'" :src="uploadUrl(a.id)" :alt="a.name" class="thumb" @click="emit('image', uploadUrl(a.id))" />
              <a v-else :href="uploadUrl(a.id)" target="_blank" rel="noopener" class="file"><Icon name="file" />{{ a.name }}</a>
            </template>
          </div>
        </div>
      </div>
    </div>

    <div class="row agent">
      <div class="av bot"><Icon name="robot" /></div>
      <div class="col">
        <div v-if="running && !turn.items.length" class="busy indicator">
          <span class="typing-dots"><i /><i /><i /></span>{{ t.thinking }}
        </div>
        <template v-for="b in blocks" :key="b.key">
          <ToolGroup v-if="b.kind === 'tools'" :items="b.items" />
          <template v-else>
            <details
              v-if="b.item.kind === 'thinking'"
              class="thinking"
              :open="thinkingOpen[b.index] ?? (running && b.last)"
            >
              <summary @click="onThinkingClick(b.index, b.last, $event)"><ThoughtStatus :state="running && !b.last ? 'done' : thoughtState" /><Icon name="chevron" class="chev" /></summary>
              <div class="think-body">{{ b.item.text }}</div>
            </details>
            <div v-else-if="b.item.kind === 'text'" class="msg">
              <Markdown :source="b.item.text" :streaming="running && b.last" @image="emit('image', $event)" />
            </div>
            <AskCard
              v-else-if="b.item.kind === 'ask'"
              :ask-id="b.item.askId"
              :spec="b.item.spec"
              :answer="b.item.answer"
              :pending="interactive && !!pendingAsks?.has(b.item.askId)"
              :turn-running="running"
              @answer="(id, a) => emit('answer', id, a)"
            />
            <div v-else-if="b.item.kind === 'notice'" class="notice" :class="b.item.level"><Icon name="alert" />{{ b.item.message }}</div>
            <div v-else-if="b.item.kind === 'error'" class="err-box" role="alert">
              <Icon name="alert" />
              <div class="err-body">
                <div class="err-title">{{ rateLimited(b.item.message) ? t.rateLimited : t.failed }}</div>
                <div class="err-msg mono">{{ b.item.message }}</div>
              </div>
            </div>
          </template>
        </template>
        <div v-if="running && turn.items.length" class="indicator" :class="{ writing }">
          <span v-if="writing" class="shimmer">{{ t.writing }}</span>
          <template v-else><span class="typing-dots"><i /><i /><i /></span>{{ lastItem?.kind === 'tool' ? t.running : t.thinking }}</template>
        </div>

        <div v-if="empty && status !== 'cancelled'" class="empty-reply" role="alert">
          <Icon name="alert" />
          <span>{{ t.emptyReply }}</span>
          <button v-if="interactive && !live" class="btn sm danger" @click="emit('retry', turn.id)"><Icon name="refresh" />{{ t.retry }}</button>
        </div>

        <div v-if="turn.artifacts.length" class="arts">
          <button v-for="a in turn.artifacts" :key="a.name + a.version" class="chip art" @click="emit('artifact', a.name, a.version)"><Icon name="file" />{{ a.name }} · v{{ a.version }}</button>
        </div>
        <div v-if="turn.files.length" class="files">
          <button class="files-head" @click="filesOpen = !filesOpen"><Icon name="edit" />{{ t.changedFiles }} ({{ turn.files.length }})<Icon name="chevron" :style="{ transform: filesOpen ? 'rotate(180deg)' : '' }" /></button>
          <ul v-if="filesOpen"><li v-for="f in turn.files" :key="f" class="mono">{{ f }}</li></ul>
        </div>

        <LiveCard
          v-if="showAgentLive"
          agent
          :session="session"
          :title="turn.user.text"
          :view="session ? liveViews?.[session.sid] : undefined"
          :interactive="interactive"
          @op="emit('live', $event)"
          @nav="(sid, c, d) => emit('nav', sid, c, d)"
        />

        <div v-if="!running" class="foot" :title="details">
          <span :class="['st', status]"><Icon v-if="status === 'done'" name="check" /><Icon v-else-if="status !== 'running'" name="alert" />{{ statusText }}</span>
          <span class="spacer" />
          <button v-if="canRetry" class="btn ghost sm" @click="emit('retry', turn.id)"><Icon name="refresh" />{{ t.retry }}</button>
          <span>{{ relTime(turn.endTs ?? turn.ts, now) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.turn { padding: 8px 14px; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; gap: 10px; align-items: flex-start; }
.row.user { flex-direction: row-reverse; }
.av { width: 28px; height: 28px; flex: none; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 600; user-select: none; }
.av.bot { background: var(--agent-soft); color: var(--agent); }
.av.bot svg { width: 15px; height: 15px; }
.av.me { background: var(--accent-soft); color: var(--accent-2); }
.col { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.user .col { max-width: 80%; align-items: flex-end; }
.agent .col { flex: 1; }
.bubble { padding: 8px 12px; border-radius: var(--r-lg); border: 1px solid var(--user-line); background: var(--user-bg); display: flex; flex-direction: column; gap: 6px; line-height: 1.6; }
.text { white-space: pre-wrap; word-break: break-word; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips .chip { background: var(--bg); border: 1px solid var(--line); max-width: 240px; }
.chip svg { width: 12px; height: 12px; flex: none; }
.atts { display: flex; flex-wrap: wrap; gap: 6px; }
.thumb { width: 72px; height: 72px; object-fit: cover; border-radius: var(--r); border: 1px solid var(--line); cursor: zoom-in; background: var(--bg); }
.file { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg); font-size: var(--fs-sm); text-decoration: none; color: var(--fg); }
.file svg { width: 14px; height: 14px; }
.msg { align-self: flex-start; max-width: 100%; padding: 8px 12px; border-radius: var(--r-lg); border: 1px solid var(--line); background: var(--bg2); }
.busy { align-self: flex-start; padding: 8px 12px; border-radius: var(--r-lg); border: 1px solid var(--line); background: var(--bg2); }
.thinking { border: 1px solid var(--line); border-radius: var(--r); background: color-mix(in srgb, var(--base) 60%, transparent); font-size: 11.5px; color: var(--fg3); }
.thinking summary { display: flex; align-items: center; gap: 6px; padding: 6px 10px; cursor: pointer; user-select: none; list-style: none; }
.thinking summary::-webkit-details-marker { display: none; }
.thinking summary:hover { color: var(--fg2); }
.thinking .chev { width: 13px; height: 13px; margin-left: auto; transition: transform var(--dur); }
.thinking[open] .chev { transform: rotate(180deg); }
.think-body { white-space: pre-wrap; overflow-wrap: anywhere; font: 11.5px/1.65 var(--mono); max-height: 260px; overflow: auto; padding: 6px 10px 8px; border-top: 1px dashed var(--line); }
.notice { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-sm); padding: 6px 10px; border-radius: var(--r); background: var(--bg2); color: var(--fg2); }
.notice svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
.notice.warn { background: var(--warn-bg); color: var(--warn); }
.err-box { display: flex; gap: 8px; padding: 8px 12px; border-radius: var(--r-lg); border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); background: var(--err-bg); }
.err-box > svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--err); }
.err-body { min-width: 0; }
.err-title { font-weight: 600; color: var(--err); }
.err-msg { margin-top: 2px; font-size: var(--fs-sm); color: var(--fg2); overflow-wrap: anywhere; white-space: pre-wrap; }
.indicator { display: flex; align-items: center; gap: 8px; color: var(--fg3); font-size: var(--fs-sm); min-height: 20px; }
.empty-reply { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: var(--r-lg); border: 1px solid color-mix(in srgb, var(--err) 35%, transparent); background: var(--err-bg); color: var(--err); font-size: var(--fs-sm); }
.empty-reply > svg { width: 16px; height: 16px; flex: none; }
.empty-reply span { flex: 1; }
.arts { display: flex; flex-wrap: wrap; gap: 4px; }
.chip.art { border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); cursor: pointer; color: var(--accent-2); background: var(--accent-soft); }
.chip.art:hover { border-color: var(--accent); }
.files-head { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; padding: 0; color: var(--fg2); font-size: var(--fs-sm); }
.files-head:hover { color: var(--fg); }
.files-head svg { width: 13px; height: 13px; }
.files ul { margin: 4px 0 0; padding-left: 18px; font-size: var(--fs-sm); color: var(--fg2); }
.foot { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg3); min-height: 20px; }
.st { display: inline-flex; align-items: center; gap: 3px; color: var(--fg2); }
.st svg { width: 12px; height: 12px; color: currentColor; }
.st.done svg { color: var(--ok); }
.st.error { color: var(--err); }
.st.cancelled, .st.interrupted { color: var(--warn); }
</style>
