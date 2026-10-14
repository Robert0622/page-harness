<script setup lang="ts">
import DOMPurify from 'dompurify'
import { ref, watchEffect } from 'vue'
import { highlight } from '../lib/markdown'

const props = defineProps<{ code: string; lang: string }>()
const html = ref<string | null>(null)
watchEffect(async () => {
  const code = props.code
  html.value = null
  const r = await highlight(code, props.lang)
  if (props.code === code) html.value = r ? DOMPurify.sanitize(r) : null
})
</script>

<template>
  <div class="code-view">
    <div v-if="html" class="hl" v-html="html" />
    <pre v-else>{{ code }}</pre>
  </div>
</template>

<style scoped>
.code-view { font: 12px/1.55 var(--mono); }
.code-view pre, .code-view :deep(pre) { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; background: transparent !important; }
</style>
