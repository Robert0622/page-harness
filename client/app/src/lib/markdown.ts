// Markdown → sanitized HTML, with Shiki highlighting loaded on demand.
import DOMPurify from 'dompurify'
import { Marked } from 'marked'
import type { HighlighterCore } from 'shiki/core'

const marked = new Marked({ gfm: true, breaks: true })

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const sanitize = (html: string) =>
  DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button'],
    FORBID_ATTR: ['style'],
    // Before/after shots in page-review.md are small data URLs. Other data: URLs stay blocked.
    ADD_DATA_URI_TAGS: ['img'],
  })

export function renderMarkdown(src: string): string {
  return sanitize(marked.parse(src, { async: false }) as string)
}

/**
 * Splits markdown into top-level blocks and renders each one. `cache` maps a block's raw source to
 * its HTML, so blocks that stopped changing keep the same string (and their DOM) while text streams.
 */
export function renderBlocks(src: string, cache: Map<string, string>): string[] {
  const tokens = marked.lexer(src)
  const out: string[] = []
  const used = new Set<string>()
  for (const tok of tokens) {
    if (tok.type === 'space') continue
    const key = `${tok.type}\u0000${tok.raw}`
    let html = cache.get(key)
    if (html === undefined) {
      const list = Object.assign([tok], { links: tokens.links }) as unknown as Parameters<typeof marked.parser>[0]
      html = sanitize(marked.parser(list) as string)
      cache.set(key, html)
    }
    used.add(key)
    out.push(html)
  }
  if (cache.size > used.size + 64) for (const k of cache.keys()) if (!used.has(k)) cache.delete(k)
  return out
}

const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', mts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', py: 'python', rb: 'ruby', htm: 'html', golang: 'go', rs: 'rust', 'c++': 'cpp', cs: 'csharp', kt: 'kotlin', ps1: 'powershell',
  docker: 'dockerfile', patch: 'diff', h: 'c', hpp: 'cpp', svg: 'xml', gql: 'graphql',
}

type LangLoader = () => Promise<unknown>
// A curated set keeps the package small; anything else renders as plain text.
const LANGS: Record<string, LangLoader> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
}

let hl: Promise<HighlighterCore> | null = null
async function highlighter(): Promise<HighlighterCore> {
  hl ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([import('shiki/core'), import('shiki/engine/javascript')])
    return createHighlighterCore({
      themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    })
  })()
  return hl
}

export async function highlight(code: string, langName: string): Promise<string | null> {
  const name = (ALIASES[langName.toLowerCase()] ?? langName.toLowerCase()).trim()
  if (!name || name === 'text' || name === 'plain' || code.length > 200_000) return null
  try {
    const loader = LANGS[name]
    if (!loader) return null
    const h = await highlighter()
    if (!h.getLoadedLanguages().includes(name)) {
      const mod = (await loader()) as { default: Parameters<HighlighterCore['loadLanguage']>[0] }
      await h.loadLanguage(mod.default)
    }
    return h.codeToHtml(code, { lang: name, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
  } catch {
    return null
  }
}

/** Upgrades <pre><code class="language-x"> blocks inside `root`. */
export async function highlightIn(root: HTMLElement): Promise<void> {
  const blocks = root.querySelectorAll<HTMLElement>('pre > code[class*="language-"]:not([data-hl])')
  for (const code of blocks) {
    code.dataset.hl = '1'
    const m = /language-([\w+#-]+)/.exec(code.className)
    if (!m) continue
    const html = await highlight(code.textContent ?? '', m[1])
    if (!html || !code.isConnected) continue
    const pre = code.parentElement!
    const wrap = document.createElement('div')
    wrap.className = 'code-block'
    wrap.innerHTML = DOMPurify.sanitize(html)
    const label = document.createElement('span')
    label.className = 'code-lang'
    label.textContent = m[1]
    wrap.prepend(label)
    pre.replaceWith(wrap)
  }
}
