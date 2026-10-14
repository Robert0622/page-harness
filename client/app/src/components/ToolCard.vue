<script lang="ts">
export const toolName = (n: string) => n.replace(/^mcp__page-harness__/, '').replace(/^page-harness[_.]/, '')
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TurnItem } from '@shared/protocol'
import { t } from '../lib/i18n'
import CodeView from './CodeView.vue'
import Icon from './Icon.vue'

const props = defineProps<{ item: Extract<TurnItem, { kind: 'tool' }> }>()
const open = ref(false)

const name = computed(() => toolName(props.item.name))
const summary = computed(() => {
  const i = props.item.input as Record<string, unknown> | undefined
  if (!i || typeof i !== 'object') return ''
  const v = i.command ?? i.file_path ?? i.filePath ?? i.path ?? i.name ?? i.pattern ?? i.query ?? i.url ?? i.description ?? i.sid
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.join(' ')
  return ''
})
const inputText = computed(() => (props.item.input === undefined ? '' : JSON.stringify(props.item.input, null, 2)))
</script>

<template>
  <div class="tool" :class="item.status">
    <button class="head" @click="open = !open">
      <span v-if="item.status === 'start'" class="spin" />
      <Icon v-else :name="item.status === 'error' ? 'x' : 'tool'" class="ic" />
      <span class="name">{{ name }}</span>
      <span class="sum mono">{{ summary }}</span>
      <Icon name="chevron" class="chev" :class="{ open }" />
    </button>
    <div v-if="open" class="body">
      <div v-if="inputText" class="sec">
        <div class="lbl">{{ t.input }}</div>
        <CodeView :code="inputText" lang="json" />
      </div>
      <div v-if="item.output" class="sec">
        <div class="lbl">{{ t.output }}</div>
        <pre class="out">{{ item.output }}</pre>
      </div>
      <div v-if="!inputText && !item.output" class="sec faint">{{ t.running }}…</div>
    </div>
  </div>
</template>

<style scoped>
.tool + .tool { border-top: 1px solid var(--line2); }
.head { display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 10px; border: 0; background: transparent; text-align: left; font-size: var(--fs-sm); }
.head:hover { background: var(--bg2); }
.head .spin { width: 12px; height: 12px; border-width: 1.5px; }
.ic { width: 13px; height: 13px; color: var(--fg3); flex: none; }
.error .ic { color: var(--err); }
.name { font-weight: 600; flex: none; }
.sum { color: var(--fg3); font-size: var(--fs-xs); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { width: 13px; height: 13px; color: var(--fg3); transition: transform var(--dur); flex: none; }
.chev.open { transform: rotate(180deg); }
.body { border-top: 1px dashed var(--line); background: var(--base); }
.sec { padding: 6px 10px; }
.sec + .sec { border-top: 1px dashed var(--line); }
.lbl { font-size: var(--fs-xs); color: var(--fg3); text-transform: uppercase; letter-spacing: 0.04em; }
.sec :deep(.code-view pre) { padding: 4px 0; max-height: 240px; overflow: auto; }
.out { margin: 4px 0 0; font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 280px; overflow: auto; }
</style>
