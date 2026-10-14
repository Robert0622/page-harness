<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TurnItem } from '@shared/protocol'
import { fmt, t } from '../lib/i18n'
import Icon from './Icon.vue'
import ToolCard, { toolName } from './ToolCard.vue'

const props = defineProps<{ items: Array<Extract<TurnItem, { kind: 'tool' }>> }>()
const open = ref(false)
const running = computed(() => props.items.some((i) => i.status === 'start'))
const failed = computed(() => props.items.filter((i) => i.status === 'error').length)
const names = computed(() => [...new Set(props.items.map((i) => toolName(i.name)))].join(', '))
</script>

<template>
  <div class="tools" :class="{ open, failed: failed > 0 }" data-testid="tool-group">
    <button class="head" :aria-expanded="open" @click="open = !open">
      <span v-if="running" class="spin" />
      <Icon v-else-if="failed" name="alert" class="ic err" />
      <Icon v-else name="check" class="ic ok" />
      <span class="count">{{ fmt(t.toolsUsed, { n: items.length }) }}</span>
      <span class="names mono">{{ names }}</span>
      <Icon name="chevron" class="chev" />
    </button>
    <div v-if="open" class="list">
      <ToolCard v-for="it in items" :key="it.id" :item="it" />
    </div>
  </div>
</template>

<style scoped>
.tools { align-self: stretch; border: 1px solid var(--line); border-radius: var(--r); background: var(--bg); overflow: hidden; }
.tools.failed { border-color: color-mix(in srgb, var(--err) 35%, var(--line)); }
.head { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; padding: 0 10px; border: 0; background: none; text-align: left; color: var(--fg2); font-size: var(--fs-sm); }
.head:hover { color: var(--fg); background: var(--bg2); }
.head .spin { width: 12px; height: 12px; border-width: 1.5px; }
.ic { width: 13px; height: 13px; flex: none; }
.ic.ok { color: var(--ok); }
.ic.err { color: var(--err); }
.count { flex: none; font-weight: 500; }
.names { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg3); font-size: var(--fs-xs); }
.chev { width: 13px; height: 13px; flex: none; color: var(--fg3); transition: transform var(--dur); }
.open .chev { transform: rotate(180deg); }
.list { border-top: 1px solid var(--line); }
</style>
