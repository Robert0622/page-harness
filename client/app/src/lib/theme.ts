import { ref, watchEffect } from 'vue'
import type { Theme } from '@shared/protocol'
import { tokensCss } from '../../../shared/tokens'

export function installTokens() {
  const style = document.createElement('style')
  style.textContent = tokensCss(':root', ":root[data-theme='dark']")
  document.head.prepend(style)
}

function initial(): Theme {
  try {
    const v = localStorage.getItem('ph:theme')
    if (v === 'dark' || v === 'light') return v
  } catch {}
  return 'light'
}

export const theme = ref<Theme>(initial())

watchEffect(() => {
  document.documentElement.dataset.theme = theme.value
  try {
    localStorage.setItem('ph:theme', theme.value)
  } catch {}
})
