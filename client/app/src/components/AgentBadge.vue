<script setup lang="ts">
import { computed } from 'vue'
import { brand } from '../lib/agents'

const props = defineProps<{ id: string; size?: 'xs' | 'sm' | 'md'; off?: boolean }>()
const b = computed(() => brand(props.id))
</script>

<template>
  <span class="ab" :class="[size ?? 'sm', { off }]" :style="{ '--ab': b.color }" :data-agent-badge="id" aria-hidden="true">
    <svg v-if="b.logo" class="logo" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"><path :d="b.logo" /></svg>
    <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path :d="b.glyph" /></svg>
  </span>
</template>

<style scoped>
.ab { flex: none; display: inline-grid; place-items: center; border-radius: 5px; color: var(--ab); background: color-mix(in srgb, var(--ab) 15%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ab) 22%, transparent); }
.ab.xs { width: 14px; height: 14px; border-radius: 4px; }
.ab.xs svg { width: 10px; height: 10px; }
.ab.sm { width: 18px; height: 18px; }
.ab.sm svg { width: 12px; height: 12px; }
.ab.md { width: 22px; height: 22px; border-radius: 6px; }
.ab.md svg { width: 14px; height: 14px; }
.ab.off { color: var(--fg3); background: var(--bg3); box-shadow: none; }
/* Logos fill their box edge to edge, so they get a little more room than the stroked glyphs. */
.ab.xs svg.logo { width: 11px; height: 11px; }
.ab.sm svg.logo { width: 13px; height: 13px; }
.ab.md svg.logo { width: 16px; height: 16px; }
</style>
