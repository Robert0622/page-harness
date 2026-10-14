<script setup lang="ts">
import { computed } from 'vue'
import type { LiveDisplay, LiveRequest, LiveSession } from '@shared/protocol'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

/**
 * `compact`: the request headline on the user side, no candidates or controls.
 * `agent`: the full card under the agent's reply, without repeating the prompt.
 */
const props = defineProps<{ session?: LiveSession; title: string; view?: { current: number; display: LiveDisplay }; interactive: boolean; compact?: boolean; agent?: boolean }>()
const emit = defineEmits<{ op: [req: LiveRequest]; nav: [sid: string, current?: number, display?: LiveDisplay] }>()

const s = computed(() => props.session)
const current = computed(() => props.view?.current ?? s.value?.variants[0]?.index ?? 1)
const display = computed(() => props.view?.display ?? s.value?.display ?? 'inplace')
const busy = computed(() => !!s.value && ['generating', 'refining', 'accepting', 'discarding'].includes(s.value.status))
const statusText = computed(() => (s.value ? (t.value as unknown as Record<string, string>)[`live_${s.value.status}`] ?? s.value.status : ''))

function step(d: number) {
  if (!s.value) return
  const list = s.value.variants.map((v) => v.index)
  const i = list.indexOf(current.value)
  emit('nav', s.value.sid, list[(i + d + list.length) % list.length], 'inplace')
}
</script>

<template>
  <div class="live card" :class="[s?.status, { compact, agent }]" :data-side="agent ? 'agent' : 'user'">
    <div class="top">
      <Icon name="sparkle" class="ic" />
      <span class="title" :title="title">{{ title }}</span>
      <span v-if="s" class="st" :class="{ busy }"><span v-if="busy" class="spin" />{{ statusText }}</span>
    </div>
    <div v-if="s?.prompt && !agent" class="prompt muted">{{ s.prompt }}</div>
    <div v-if="s?.error && s.status === 'failed' && !compact" class="err">{{ s.error }}</div>
    <template v-if="s && interactive && !compact">
      <div v-if="s.variants.length && s.status === 'ready'" class="vars">
        <button class="btn icon sm" @click="step(-1)"><Icon name="left" /></button>
        <button v-for="v in s.variants" :key="v.index" class="btn sm" :class="{ on: v.index === current }" @click="emit('nav', s.sid, v.index, 'inplace')">{{ v.index }} · {{ v.label }}</button>
        <button class="btn icon sm" @click="step(1)"><Icon name="right" /></button>
      </div>
      <div v-else-if="s.variants.length" class="vars">
        <span v-for="v in s.variants" :key="v.index" class="chip" :class="{ acc: s.accepted === v.index && s.status === 'accepted' }">{{ v.index }} · {{ v.label }}</span>
      </div>
      <div class="acts">
        <template v-if="s.status === 'ready'">
          <button class="btn sm" @click="emit('nav', s.sid, undefined, display === 'compare' ? 'inplace' : 'compare')">{{ display === 'compare' ? t.inplace : t.compare }}</button>
          <span class="spacer" />
          <button class="btn sm" @click="emit('op', { op: 'discard', sid: s.sid })">{{ t.discard }}</button>
          <button class="btn sm primary" @click="emit('op', { op: 'accept', sid: s.sid, variant: current })">{{ t.accept }}</button>
        </template>
        <template v-else-if="s.status === 'failed'">
          <span class="spacer" />
          <button class="btn sm" @click="emit('op', { op: 'discard', sid: s.sid })">{{ t.discard }}</button>
          <button v-if="s.accepted !== undefined" class="btn sm" @click="emit('op', { op: 'retry', sid: s.sid, andAccept: true })">{{ t.retryAccept }}</button>
          <button class="btn sm primary" @click="emit('op', { op: 'retry', sid: s.sid })">{{ t.retry }}</button>
        </template>
        <template v-else-if="s.status === 'generating' || s.status === 'refining'">
          <span class="spacer" />
          <button class="btn sm" @click="emit('op', { op: 'discard', sid: s.sid })">{{ t.discard }}</button>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.live { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; border-radius: var(--r-xl); border-color: color-mix(in srgb, var(--accent) 30%, var(--line)); background: color-mix(in srgb, var(--accent-soft) 55%, var(--bg)); }
.live.compact { padding: 7px 12px; gap: 4px; max-width: 360px; }
.live.agent { animation: live-in 180ms cubic-bezier(0.22, 1, 0.36, 1); }
@keyframes live-in { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .live.agent { animation: none; } }
.top { display: flex; align-items: center; gap: 6px; }
.ic { width: 15px; height: 15px; color: var(--accent-2); flex: none; }
.title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st { display: inline-flex; align-items: center; gap: 4px; height: 20px; font-size: var(--fs-xs); padding: 0 8px; border-radius: 999px; background: var(--bg2); color: var(--fg2); font-weight: 500; }
.st .spin { width: 10px; height: 10px; border-width: 1.5px; }
.st.busy { color: var(--accent-2); }
.ready .st { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent-2); }
.failed .st { background: var(--err-bg); color: var(--err); }
.accepted .st { background: var(--ok-bg); color: var(--ok); }
.prompt { font-size: var(--fs-sm); }
.err { font-size: var(--fs-sm); color: var(--err); }
.vars { display: flex; flex-wrap: wrap; gap: 4px; }
.chip.acc { background: var(--accent); color: var(--accent-fg); }
.acts { display: flex; gap: 6px; align-items: center; }
.acts:empty { display: none; }
</style>
