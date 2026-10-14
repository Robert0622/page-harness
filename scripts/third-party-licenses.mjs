// Writes THIRD_PARTY_LICENSES.md for the packages bundled into dist/client (and their dependencies).
// Runtime dependencies from package.json are installed by npm and carry their own licenses.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOBE_ICONS_LICENSE = `MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`
const BUNDLED = ['vue', '@page-agent/page-controller', 'dompurify', 'marked', 'shiki', 'html2canvas', 'jspdf', '@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono']

function pkgDir(name, from) {
  let dir = from
  for (;;) {
    const p = path.join(dir, 'node_modules', name)
    if (existsSync(path.join(p, 'package.json'))) return p
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function licenseText(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.|$)/i.test(n))
  return f ? readFileSync(path.join(dir, f), 'utf8').trim() : null
}

const seen = new Map()
const visit = (name, from) => {
  const dir = pkgDir(name, from)
  if (!dir) return
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const key = `${pkg.name}@${pkg.version}`
  if (seen.has(key)) return
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ')
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  seen.set(key, { name: pkg.name, version: pkg.version, license: license || 'UNKNOWN', repo, text: licenseText(dir) })
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, dir)
}
for (const name of BUNDLED) visit(name, root)

const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
const unknown = list.filter((p) => p.license === 'UNKNOWN')
const out = [
  '# Third-party licenses',
  '',
  'The browser bundles in `dist/client` include the following packages.',
  '',
  '| Package | Version | License |',
  '| --- | --- | --- |',
  ...list.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  '',
  ...list.flatMap((p) => [`## ${p.name}@${p.version}`, '', `License: ${p.license}${p.repo ? `  \nRepository: ${p.repo.replace(/^git\+/, '')}` : ''}`, '', ...(p.text ? ['```text', p.text, '```', ''] : [])]),
]
// Agent logos are copied into client/app/src/lib/agents.ts as SVG paths rather than bundled as a package.
out.push(
  '## Agent logos (LobeHub Icons, @lobehub/icons-static-svg@1.95.1)',
  '',
  'License: MIT  \nRepository: https://github.com/lobehub/lobe-icons',
  '',
  'The Claude, Codex, Cursor, CodeBuddy and OpenCode marks are trademarks of their owners (Anthropic, OpenAI, Anysphere, Tencent, SST) and are shown only to name the agent CLI in use.',
  '',
  '```text',
  LOBE_ICONS_LICENSE,
  '```',
  '',
)
writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.md'), out.join('\n'))
console.log(`THIRD_PARTY_LICENSES.md: ${list.length} packages${unknown.length ? `, unknown license: ${unknown.map((p) => p.name).join(', ')}` : ''}`)
