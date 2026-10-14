export const LIVE_CSS = `
.lv-card { position: fixed; z-index: 2147483646; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--shadow); font-size: var(--fs); }
.lv-card button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; border: 1px solid var(--line); background: var(--bg); border-radius: var(--r); padding: 0 10px; height: var(--h); white-space: nowrap; transition: background .12s, border-color .12s; }
.lv-card button:hover:not(:disabled) { background: var(--bg2); }
.lv-card button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
.lv-card button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
.lv-card button.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
.lv-card button.ghost { border-color: transparent; background: transparent; color: var(--fg2); }
.lv-card button.ghost:hover:not(:disabled) { background: var(--bg3); color: var(--fg); }
.lv-card button.icon { width: var(--h); padding: 0; }
.lv-card input, .lv-card textarea { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: var(--r); padding: 0 8px; height: var(--h); outline: none; width: 100%; }
.lv-card input:focus, .lv-card textarea:focus { border-color: var(--accent); box-shadow: var(--focus); }
.lv-card textarea { resize: vertical; min-height: 64px; height: auto; padding: 6px 8px; line-height: 1.45; }
.lv-card h4 { margin: 0; font-size: var(--fs); font-weight: 600; display: flex; align-items: center; gap: 8px; }
.lv-card h4 .sp { flex: 1; }

.lv-pickbar { left: 50%; bottom: 72px; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; padding: 6px; width: min(560px, calc(100vw - 32px)); }
.lv-seg { display: inline-flex; padding: 2px; gap: 2px; background: var(--bg2); border: 1px solid var(--line); border-radius: var(--r); flex: none; }
.lv-seg button { height: calc(var(--h) - 6px) !important; border: 0 !important; border-radius: var(--r-sm) !important; background: transparent !important; color: var(--fg2) !important; }
.lv-seg button:hover:not(:disabled) { color: var(--fg) !important; }
.lv-seg button.on { background: var(--bg) !important; color: var(--fg) !important; font-weight: 600; box-shadow: var(--shadow-sm); }
.lv-pickbar input { flex: 1; min-width: 0; }

.lv-pop { display: flex; gap: 4px; padding: 4px; }
.lv-design { width: min(380px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.lv-target { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-sm); line-height: 1.4; color: var(--fg2); background: var(--bg2); border: 1px solid var(--line2); border-radius: var(--r-sm); padding: 6px 8px; }
.lv-target .tag { flex: none; padding: 0 5px; border-radius: 4px; background: var(--bg3); color: var(--fg2); font: 10.5px/16px var(--mono); }
.lv-target .pos { flex: none; color: var(--accent); font-weight: 600; }
.lv-target .txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-actions { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; }
.lv-actions button { padding: 0 4px; }
.lv-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lv-row label { color: var(--fg2); font-size: var(--fs-sm); min-width: 40px; }
.lv-row .sp { flex: 1; }
.lv-foot { display: flex; justify-content: flex-end; gap: 6px; padding-top: 2px; }

.lv-ctrl { display: flex; align-items: center; gap: 4px; padding: 4px; max-width: calc(100vw - 16px); flex-wrap: wrap; }
.lv-ctrl .lbl { padding: 0 6px; font-weight: 600; white-space: nowrap; max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
.lv-ctrl .idx { font-variant-numeric: tabular-nums; color: var(--fg2); padding: 0 2px; min-width: 28px; text-align: center; }
.lv-ctrl .st { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; font-size: var(--fs-sm); background: var(--bg2); color: var(--fg2); white-space: nowrap; }
.lv-ctrl .st.busy { color: var(--accent); background: var(--accent-soft); }
.lv-ctrl .st.err { color: var(--err); background: var(--err-bg); }
.lv-ctrl .msg { color: var(--fg2); font-size: var(--fs-sm); max-width: 260px; }
.lv-ctrl input { width: 180px; }

.lv-shimmer { position: fixed; pointer-events: none !important; border-radius: var(--r-sm); background: linear-gradient(110deg, transparent 30%, color-mix(in srgb, var(--accent) 30%, transparent) 50%, transparent 70%); background-size: 200% 100%; animation: lv-sh 1.4s linear infinite; outline: 2px dashed color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 2px; }
@keyframes lv-sh { from { background-position: 150% 0; } to { background-position: -50% 0; } }
.lv-outline { position: fixed; pointer-events: none !important; border: 2px solid var(--accent); border-radius: 4px; }
.lv-badge { position: fixed; pointer-events: auto; height: 20px; line-height: 20px; padding: 0 8px; border-radius: 999px; background: var(--accent); color: var(--accent-fg); font-size: var(--fs-sm); font-weight: 600; cursor: pointer; box-shadow: var(--shadow-sm); }
.lv-pickable { position: fixed; border: 2px dashed var(--accent); border-radius: 4px; cursor: pointer; background: color-mix(in srgb, var(--accent) 6%, transparent); }
.lv-pickable:hover { background: color-mix(in srgb, var(--accent) 16%, transparent); }

.lv-draw { position: fixed; inset: 0; cursor: crosshair; }
.lv-draw svg { width: 100%; height: 100%; }
.lv-marks { position: fixed; inset: 0; pointer-events: none !important; }
.lv-marks svg { width: 100%; height: 100%; }
.lv-pin { position: fixed; width: 22px; height: 22px; margin: -11px 0 0 -11px; border-radius: 50%; background: var(--err); color: #fff; display: grid; place-items: center; font-size: var(--fs-sm); font-weight: 700; pointer-events: none !important; box-shadow: var(--shadow-sm); }
.lv-note { position: fixed; width: 240px; padding: 6px; display: flex; gap: 4px; }

.lv-params { padding: 12px; width: 260px; display: flex; flex-direction: column; gap: 10px; }
.lv-params .p { display: flex; flex-direction: column; gap: 4px; }
.lv-params .p .h { display: flex; justify-content: space-between; color: var(--fg2); font-size: var(--fs-sm); }
.lv-params input[type=range] { padding: 0; height: auto; background: none; border: 0; box-shadow: none; accent-color: var(--accent); }
`
