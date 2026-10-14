<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../lib/i18n'
import Icon from './Icon.vue'

/** generating: the turn is still running; done: it finished; interrupted: it failed or was stopped. */
const props = defineProps<{ state: 'generating' | 'done' | 'interrupted' }>()
const label = computed(() => (props.state === 'generating' ? t.value.thinking : props.state === 'done' ? t.value.thoughts : t.value.thoughtInterrupted))
</script>

<template>
  <span class="ts" :data-state="state" data-testid="thought-status">
    <Icon :name="state === 'interrupted' ? 'alert' : 'sparkle'" class="ic" />
    <span>{{ label }}</span>
    <Icon v-if="state === 'done'" name="check" class="ok" />
  </span>
</template>

<style scoped>
.ts { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.ic { width: 13px; height: 13px; flex: none; color: var(--accent-2); }
[data-state='generating'] .ic { animation: ph-pulse 1.4s ease-in-out infinite; }
[data-state='interrupted'] .ic { color: var(--warn); }
.ok { width: 12px; height: 12px; color: var(--ok); }
</style>
