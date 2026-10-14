<script setup lang="ts">
import { ref } from 'vue'
import Icon from '../components/Icon.vue'
import { t } from '../lib/i18n'
import type { ChatStore } from './store'

const props = defineProps<{ store: ChatStore }>()
const s = props.store
const dragId = ref<string | null>(null)
const overId = ref<string | null>(null)

function drop(targetId: string) {
  const from = dragId.value
  dragId.value = null
  overId.value = null
  if (!from || from === targetId) return
  const ids = s.queue.value.map((q) => q.id)
  ids.splice(ids.indexOf(from), 1)
  ids.splice(ids.indexOf(targetId), 0, from)
  s.send({ type: 'queue_reorder', ids })
}
function move(id: string, d: number) {
  const ids = s.queue.value.map((q) => q.id)
  const i = ids.indexOf(id)
  const j = i + d
  if (j < 0 || j >= ids.length) return
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  s.send({ type: 'queue_reorder', ids })
}
</script>

<template>
  <div v-if="s.queue.value.length" class="queue">
    <div class="qh muted">{{ t.queue }} · {{ s.queue.value.length }}</div>
    <div
      v-for="(q, i) in s.queue.value"
      :key="q.id"
      class="qi"
      :class="{ over: overId === q.id, dragging: dragId === q.id }"
      draggable="true"
      @dragstart="dragId = q.id"
      @dragend="dragId = null; overId = null"
      @dragover.prevent="overId = q.id"
      @drop.prevent="drop(q.id)"
    >
      <span class="grip" :title="t.dragToReorder" tabindex="0" @keydown.up.prevent="move(q.id, -1)" @keydown.down.prevent="move(q.id, 1)"><Icon name="grip" /></span>
      <span class="n faint">{{ i + 1 }}</span>
      <span class="txt">{{ q.text || (q.live ? 'Live' : '…') }}</span>
      <span v-if="q.attachments.length" class="chip">📎 {{ q.attachments.length }}</span>
      <span v-if="q.picks.length || q.marks?.length" class="chip">◎ {{ q.picks.length + (q.marks?.length ?? 0) }}</span>
      <button v-if="!q.live" class="btn ghost icon sm" :title="t.edit" @click="s.editQueued(q)"><Icon name="edit" /></button>
      <button class="btn ghost icon sm" :title="t.withdraw" @click="s.send({ type: 'dequeue', id: q.id })"><Icon name="undo" /></button>
    </div>
  </div>
</template>

<style scoped>
.queue { border-top: 1px solid var(--line); padding: 8px 12px; display: flex; flex-direction: column; gap: 6px; background: var(--bg); max-height: 30vh; overflow: auto; }
.qh { font-size: var(--fs-xs); font-weight: 600; color: var(--fg3); text-transform: uppercase; letter-spacing: .04em; }
.qi { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px 0 6px; border: 1px solid var(--line); border-radius: var(--r); background: var(--base); transition: border-color var(--dur); }
.qi:hover { border-color: var(--line-strong); }
.qi.over { border-color: var(--accent); }
.qi.dragging { opacity: 0.5; }
.grip { cursor: grab; color: var(--fg3); display: inline-grid; border-radius: 4px; }
.grip:focus-visible { outline: none; box-shadow: var(--focus); }
.grip svg { width: 14px; height: 14px; }
.n { font-size: var(--fs-xs); min-width: 10px; }
.txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip { height: 20px; font-size: var(--fs-xs); }
</style>
