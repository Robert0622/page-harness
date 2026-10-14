<script setup lang="ts">
import { computed, ref } from 'vue'

defineOptions({ name: 'JsonTree' })
const props = defineProps<{ value: unknown; name?: string; depth?: number }>()
const depth = computed(() => props.depth ?? 0)
const open = ref(depth.value < 2)
const isObj = computed(() => props.value !== null && typeof props.value === 'object')
const entries = computed(() => (isObj.value ? Object.entries(props.value as Record<string, unknown>) : []))
const isArr = computed(() => Array.isArray(props.value))
const preview = computed(() => (isArr.value ? `[${entries.value.length}]` : `{${entries.value.length}}`))
const kind = computed(() => (props.value === null ? 'null' : typeof props.value))
const show = computed(() => (typeof props.value === 'string' ? JSON.stringify(props.value) : String(props.value)))
</script>

<template>
  <div class="jt">
    <template v-if="isObj">
      <button class="tog" @click="open = !open">
        <span class="car" :class="{ open }">▸</span>
        <span v-if="name !== undefined" class="key">{{ name }}:</span>
        <span class="pv">{{ preview }}</span>
      </button>
      <div v-if="open" class="kids">
        <JsonTree v-for="[k, v] in entries" :key="k" :name="isArr ? Number(k) + '' : k" :value="v" :depth="depth + 1" />
      </div>
    </template>
    <div v-else class="leaf">
      <span v-if="name !== undefined" class="key">{{ name }}:</span>
      <span :class="['v', kind]">{{ show }}</span>
    </div>
  </div>
</template>

<style scoped>
.jt { font: 12px/1.6 var(--mono); }
.tog { border: 0; background: none; padding: 0; font: inherit; display: inline-flex; gap: 4px; align-items: baseline; }
.car { display: inline-block; width: 10px; color: var(--fg3); transition: transform 0.1s; }
.car.open { transform: rotate(90deg); }
.kids { padding-left: 16px; border-left: 1px dashed var(--line); margin-left: 4px; }
.leaf { padding-left: 14px; word-break: break-word; }
.key { color: var(--accent); margin-right: 4px; }
.pv { color: var(--fg3); }
.v.string { color: #0a7f45; }
.v.number { color: #b35900; }
.v.boolean, .v.null { color: #8250df; }
:root[data-theme='dark'] .v.string { color: #7ee2a8; }
:root[data-theme='dark'] .v.number { color: #ffa657; }
:root[data-theme='dark'] .v.boolean, :root[data-theme='dark'] .v.null { color: #d2a8ff; }
</style>
