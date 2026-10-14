<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { highlightIn, renderBlocks } from '../lib/markdown'
import { useSmoothText } from '../lib/smooth'

const props = defineProps<{ source: string; streaming?: boolean }>()
const emit = defineEmits<{ image: [src: string] }>()
const el = ref<HTMLElement>()
const shown = useSmoothText(
  () => props.source,
  () => !!props.streaming,
)
const active = computed(() => !!props.streaming || shown.value.length < props.source.length)
const cache = new Map<string, string>()
const blocks = computed(() => renderBlocks(shown.value, cache))

// The block still being written is re-rendered on every frame; highlight only the settled ones.
const upgrade = () => {
  const root = el.value
  if (!root) return
  const kids = Array.from(root.children) as HTMLElement[]
  const settled = active.value ? kids.slice(0, -1) : kids
  for (const k of settled) if (k.querySelector('pre > code[class*="language-"]:not([data-hl])')) void highlightIn(k)
}
onMounted(upgrade)
watch([() => blocks.value.length, active], () => nextTick(upgrade))

function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  if (target.tagName === 'IMG') emit('image', (target as HTMLImageElement).src)
}
</script>

<template>
  <div ref="el" class="md" :class="{ streaming: active }" @click="onClick">
    <div v-for="(b, i) in blocks" :key="i" class="mb" v-html="b" />
  </div>
</template>

<style scoped>
.mb {
  display: contents;
}
.streaming > .mb:last-child > :deep(:last-child)::after,
.streaming:empty::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--accent);
  animation: ph-caret 0.9s step-end infinite;
}
</style>
