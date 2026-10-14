// Design tokens shared by the page overlay (Shadow DOM) and the panel / history apps,
// so every surface uses the same colors, radii, shadows, motion and type scale.

const base = {
  '--font': '"Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  '--mono': '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  '--fs': '13px',
  '--fs-lg': '14px',
  '--fs-sm': '12px',
  '--fs-xs': '11px',
  '--r-sm': '6px',
  '--r': '8px',
  '--r-lg': '12px',
  '--r-xl': '16px',
  '--h': '28px',
  '--h-sm': '24px',
  '--h-lg': '32px',
  '--dur': '160ms',
  '--ease': 'cubic-bezier(0.16, 1, 0.3, 1)',
  '--grad-size': '200% 100%',
}

const light = {
  '--base': '#fafafb',
  '--bg': '#ffffff',
  '--bg2': '#f4f4f5',
  '--bg3': '#e9e9ec',
  '--fg': '#18181b',
  '--fg2': '#52525b',
  '--fg3': '#a1a1aa',
  '--line': '#e5e5e8',
  '--line2': '#eeeef0',
  '--line-strong': '#d4d4d8',
  '--accent': '#7b61ff',
  '--accent-hover': '#6a4ff0',
  '--accent-2': '#4f46e5',
  '--accent-fg': '#ffffff',
  '--accent-soft': '#eef0ff',
  '--agent': '#0ea5c6',
  '--agent-soft': 'rgba(14, 165, 198, 0.12)',
  '--ok': '#16a34a',
  '--ok-bg': '#dcfce7',
  '--warn': '#d97706',
  '--warn-bg': '#fef3c7',
  '--err': '#dc2626',
  '--err-bg': '#fef2f2',
  '--info': '#2563eb',
  '--user-bg': '#f3f1ff',
  '--user-line': 'rgba(123, 97, 255, 0.3)',
  '--code-bg': '#f4f4f5',
  '--mask': 'rgba(15, 15, 20, 0.35)',
  '--shadow': '0 8px 28px rgba(16, 24, 40, 0.14)',
  '--shadow-sm': '0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 2px rgba(16, 24, 40, 0.04)',
  '--shadow-pop': '0 2px 10px rgba(26, 35, 50, 0.12)',
  '--focus': '0 0 0 3px rgba(123, 97, 255, 0.2)',
  '--grad': 'linear-gradient(90deg, #6d28d9 0%, #7b61ff 30%, #6366f1 55%, #4f46e5 75%, #7b61ff 100%)',
}

const dark: typeof light = {
  '--base': '#0a0a0b',
  '--bg': '#141417',
  '--bg2': '#1c1c21',
  '--bg3': '#26262c',
  '--fg': '#ededf0',
  '--fg2': '#a1a1aa',
  '--fg3': '#6e6e78',
  '--line': '#26262b',
  '--line2': '#202025',
  '--line-strong': '#36363e',
  '--accent': '#7b61ff',
  '--accent-hover': '#8f78ff',
  '--accent-2': '#818cf8',
  '--accent-fg': '#ffffff',
  '--accent-soft': '#1f1f36',
  '--agent': '#22d3ee',
  '--agent-soft': 'rgba(34, 211, 238, 0.14)',
  '--ok': '#34d399',
  '--ok-bg': 'rgba(52, 211, 153, 0.12)',
  '--warn': '#fbbf24',
  '--warn-bg': 'rgba(251, 191, 36, 0.12)',
  '--err': '#f87171',
  '--err-bg': 'rgba(220, 38, 38, 0.12)',
  '--info': '#60a5fa',
  '--user-bg': '#1f1f36',
  '--user-line': 'rgba(123, 97, 255, 0.35)',
  '--code-bg': '#0a0a0b',
  '--mask': 'rgba(0, 0, 0, 0.55)',
  '--shadow': '0 8px 28px rgba(0, 0, 0, 0.55)',
  '--shadow-sm': '0 1px 2px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.25)',
  '--shadow-pop': '0 4px 16px rgba(0, 0, 0, 0.5)',
  '--focus': '0 0 0 3px rgba(123, 97, 255, 0.3)',
  '--grad': 'linear-gradient(90deg, #7b61ff 0%, #818cf8 35%, #6366f1 55%, #7b61ff 75%, #a78bfa 100%)',
}

const decl = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')

/** CSS that defines the tokens on `light` and `dark` selectors. */
export function tokensCss(lightSel: string, darkSel: string): string {
  return `${lightSel} { ${decl(base)} ${decl(light)} color-scheme: light; }\n${darkSel} { ${decl(dark)} color-scheme: dark; }\n`
}
