# page-harness

[中文](./README.zh-CN.md)

Point it at any running frontend and the page gets a **Pick / Artifacts / Chat** dock, driven by the coding agent CLI already on your machine (Claude Code, Codex, Cursor Agent, CodeBuddy Code or OpenCode). No sandbox, no accounts, no changes to your app.

```bash
npx page-harness http://localhost:5173 --project ./my-app --agent claude
# open http://127.0.0.1:17990 — it is your app, plus the dock in the bottom-right corner
```

## What you get

- **Pick** — click an element on the page and choose what to do with it: **Quote in chat** (selector, text and outer HTML go with your next message; Shift+click quotes directly), **Comment**, **Edit** (no-source sites) or **Live candidates**. Live: choose an element, describe the change and the agent writes 2–4 candidates straight into your source; you flip between them on the page, compare side by side, tune parameters, refine one, then accept or discard.
- **Chat** — a draggable, resizable chat window. Streaming replies with Markdown and syntax highlighting, collapsible thinking, tool cards, changed-file lists, image/file attachments (paste, drop or pick), a per-chat queue you can reorder, edit or withdraw, Stop / Retry, multiple chats, per-chat agent and model.
- **Page control** (off by default) — let the agent read the page and click, type, select and scroll on it. A banner shows when it is on; Stop takes it back at any time.
- **Artifacts** — the agent writes reports, mockups, JSON, images and other files through MCP. Preview them in tabs with version history: Markdown, sandboxed HTML (desktop / mobile widths), structured JSON, code, images; copy, download, export to PNG or PDF.
- **Notes** — comment on or edit elements in place, threaded replies, resolve and per-page approval; teammates on your network can join as reviewers with `--share`. Works on sites you have no source for.
- **Questions** — the agent can ask you multiple-choice questions or a short form and wait for the answer.
- **History** — every chat is an append-only event log on disk. Browse, search and export it at `http://127.0.0.1:17991/__ph/history`, or from the chat switcher.

## Requirements

- Node.js 20.11 or newer.
- At least one agent CLI on `PATH`, signed in:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex](https://github.com/openai/codex) (`codex`)
  - [Cursor Agent](https://docs.cursor.com/en/cli/overview) (`cursor-agent`)
  - [CodeBuddy Code](https://www.codebuddy.ai/cli) (`codebuddy`, `npm i -g @tencent-ai/codebuddy-code`)
  - [OpenCode](https://opencode.ai) (`opencode`, `npm i -g opencode-ai`)

page-harness detects which ones are installed and shows them in the banner. Use `--claude-path`, `--codex-path`, `--cursor-path`, `--codebuddy-path` or `--opencode-path` for non-standard locations. Agents that are not installed stay in the chat's agent picker, greyed out, with the install command.

What each agent supports:

| | Claude Code | Codex | Cursor Agent | CodeBuddy Code | OpenCode |
|---|---|---|---|---|---|
| Streaming text / thinking | ✓ | ✓ | ✓ | ✓ | per block¹ |
| Tool cards, changed files | ✓ | ✓ | ✓ | ✓ | ✓¹ |
| Resume a chat | ✓ | ✓ | ✓ | ✓ | ✓ |
| Model list | ✓ | ✓ | ✓ | ✓ (from `--help`) | ✓ (`opencode models`) |
| Reasoning effort | – | ✓ | – | ✓ (`--effort`) | ✓ (`--variant`) |
| Image attachments | ✓ | ✓ | file path in prompt | ✓ | ✓ (`--file`) |

¹ `opencode run --format json` reports text, reasoning and tool calls once each part has finished, so replies arrive a block at a time and a tool card opens and closes together.

## Usage

```text
page-harness <frontend-url> [options]

  --project <dir>        Project the agent works in (default: current directory)
  --agent <id>           claude | codex | cursor | codebuddy | opencode (default: first one installed)
  --model <name>         Default model for new chats
  --port <n>             App port: the proxied frontend (default 17990)
  --control-port <n>     Panel / API port (default: app port + 1)
  --host <addr>          Listen address (default 127.0.0.1)
  --allow-host <name>    Extra Host header to accept (repeatable), e.g. a LAN name
  --keep-host            Forward the browser's Host header to the target
  --public-scheme <s>    http | https: scheme browsers use to reach both ports (default http);
                         https behind a load balancer that terminates TLS on the same ports
  --open                 Open the browser
  --live-guard-hook      Install a git pre-commit hook that rejects Live candidate markers
  --review / --source    Force review mode (no source) or source mode; default is by host
  --share                Let teammates on your network join as reviewers (listens on 0.0.0.0)
  --verbose / --quiet
```

`<frontend-url>` can be a bare port (`3000`), `host:port` or a full URL. Dev-server HMR (Vite, webpack, Next.js…) keeps working through the proxy, including WebSockets.

## How it works

```text
browser ──► :17990  app port      reverse proxy to your dev server; injects /__ph/overlay.js into HTML
        └─► :17991  control port  panel UI, history page, JSON API, WebSocket, MCP endpoint
                       │
                       └─ spawns the agent CLI per turn (claude -p / codex app-server / cursor-agent -p /
                          codebuddy -p / opencode run --format json)
                          with a local MCP server for page_*, artifacts, questions and Live
```

- The overlay lives in a Shadow DOM so its styles and your app's styles do not leak into each other. The chat and artifacts windows are iframes from the control port and talk to the page over a `MessagePort` handshake.
- Each chat keeps the agent's session id, so follow-up messages resume the same agent session. Messages sent while a turn runs are queued per chat.
- Agents get a short system prompt describing the page context, the MCP tools and the Live protocol. Nothing is written to your project except `.page-harness/` (ignored by git through its own `.gitignore`) and, during Live, temporary candidate markup.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `page_state`, `page_click`, `page_input`, `page_select`, `page_scroll` | Read and operate the page (only while the user allows page control) |
| `write_artifact`, `read_artifact`, `list_artifacts`, `set_artifact_preview` | Versioned artifacts in `.page-harness/artifacts` |
| `ask_question`, `ask_form` | Ask the user and block until they answer (30 minutes) |
| `live_update` | Report Live candidates as ready / done / failed |
| `live_patch_variants` | Review mode only: Live candidates as sets of page changes |
| `page_note`, `list_review`, `reply_review`, `resolve_review`, `remove_review` | Pin notes on the page, read people's feedback, answer and resolve it |
| `page_patch` | Review mode only: temporary text, CSS or image change on an element |

### Live candidates

For a Live request the agent edits your source so that the element is wrapped like this:

```html
<div data-ph-live="L1a2b3c4" style="display:contents">
  <h1 data-ph-variant="0" hidden>original</h1>
  <h1 data-ph-variant="1" data-ph-variant-label="Bold">…</h1>
  <h1 data-ph-variant="2" data-ph-variant-label="Soft" hidden
      data-ph-params='[{"name":"gap","type":"range","min":0,"max":40,"unit":"px"}]'>…</h1>
</div>
```

Your dev server reloads, the overlay finds the wrapper and takes over showing and hiding variants (parameters are applied as `--ph-<name>` CSS variables on the wrapper). Accepting asks the agent to keep the chosen variant and remove the wrapper; discarding restores the original. After every Live or file-editing turn page-harness scans the working tree (`git grep`) and warns if markers were left behind; `--live-guard-hook` also blocks commits that contain them.

### Review mode (no source)

When the target is a public site (anything that is not localhost, a private IP or a LAN name) there is no source to edit, so page-harness starts in review mode. Force it either way with `--review` / `--source`.

- The agent is told not to touch files or build mockups. `write_artifact` only accepts reports (`.md`, `.txt`, `.json`, `.csv`, images); HTML/SVG mockups are refused.
- Findings go on the page instead: `page_note` pins a numbered comment (issue / suggestion / info) to an element, and `page_patch` changes its text, CSS or image (`src` / `alt`) so you see the suggestion in place. There is no HTML patching.
- Both tools check the selector against your open page first (no page-control permission needed), so a wrong selector comes back to the agent instead of silently pinning nothing.
- People can do the same by hand: **Pick** an element, then **Comment** to leave a note, or **Edit** to change its text, color, background, font size and weight, padding, radius or image with a live preview and saves it as a change.
- **Live** works here too, as page changes: the agent renders 2–4 candidates with `live_patch_variants`, each a set of text / CSS / image changes on up to 12 elements. Switch, peek at the original and refine them on the page; accepting keeps the chosen candidate as change items in Notes, discarding puts the page back. There is no side-by-side view, no parameters and no Insert, since those need the source.

### Notes, threads and approvals

Notes work in both modes; hand edits and `page_patch` only without source.

- Notes belong to the page they were made on (path without hash, trailing slash or tracking parameters). **This page** shows the current page; **All** groups every page, and clicking a note on another page goes there and opens it. The dock badge counts open notes on the current page and shows a dot when other pages have some.
- Each pin opens a thread: author, replies, Resolve / Reopen, compare a change with the original, quote the element into the chat (owner) and delete (author or owner).
- **Approve** / **Request changes** records a verdict per page and person.
- Pins are re-attached with a fingerprint (tag, id, stable classes, key attributes, text and its context) when the selector breaks after a re-render or a redesign. If nothing fits well enough the note is shown as *not found on the page* instead of being pinned to the wrong element. Changes are re-applied after reloads and re-renders; nothing is sent to the site.
- The agent sees people's notes with `list_review`, answers with `reply_review` and closes them with `resolve_review` plus a summary. It can only remove its own notes.
- **Export** writes `page-review.md` (notes, before → after text, CSS, replies, approvals) to Artifacts.

### Team review (`--share`)

```bash
npx page-harness https://example.com --share
#   Share  http://192.168.1.20:17991/__ph/join?t=…
```

Send the Share link (also in Settings → Team) to teammates on the same network. Opening it gives them a reviewer session for that browser; they enter a display name once and then see the page with everyone's notes and changes in real time. Reviewers can comment, edit (review mode), reply, resolve and approve. They cannot run or see the agent, chats, history, uploads or page control. Other machines without the link get `403`.

## Security model

There is no login: it is a local developer tool and binds to `127.0.0.1` by default. Internally every surface is locked down:

- **Two origins.** Your app (and any script on it) runs on the app port; the panel, API and agent endpoints are on the control port, so page scripts cannot read them.
- **Owner and reviewers.** Without `--share` only this machine can connect and everything behaves as one user. With `--share`, the owner session is only issued to loopback requests; other machines need the invite link, which sets signed (HMAC) reviewer cookies for the panel and the app port; without them both ports answer `403`. Reviewers are limited to the review actions on the WebSocket and to reading artifacts; everything else returns `403`. Name the owner in Settings → Team.
- **Session cookie.** The panel gets an `HttpOnly`, `SameSite=Strict` cookie scoped to `/__ph`; the cookie is stripped before requests are forwarded to your dev server.
- **API.** Reads require a same-origin `Sec-Fetch-Site`; writes require a matching `Origin` plus a custom `X-PH` header. The WebSocket checks the cookie and `Origin`.
- **MCP.** Every agent turn gets its own bearer token (passed through an environment variable or a private temp file, never on the command line) that is revoked when the turn ends. Browser requests to the MCP endpoint are rejected.
- **Host allow-list.** Requests with unexpected `Host` headers get `421` (DNS rebinding). Add names with `--allow-host` if you expose it on a LAN.
- **Framing.** The panel may only be framed by the app origin; the history page cannot be framed at all.
- **Artifacts.** HTML and SVG artifacts are served with a `sandbox` CSP and shown in iframes without `allow-same-origin`.
- **Page control** is opt-in per browser, shown with a banner, and password values are never sent to the agent.

Agents run with their CLI's non-interactive permissions (e.g. Claude Code `--permission-mode bypassPermissions`, Codex with approvals off, Cursor Agent `--force`, CodeBuddy Code `--permission-mode bypassPermissions`, OpenCode `run --auto`) inside `--project`. Only point page-harness at projects you would let the agent edit.

## Data

Everything lives in `<project>/.page-harness/`:

```text
chats/<id>/meta.json        title, agent, model, session id
chats/<id>/events.jsonl     append-only event log (prompts, deltas, tools, results)
artifacts/<name>/v<n>       artifact versions + index.json
uploads/                    attachments
live.json                   Live sessions
review.json                 notes, page changes, replies and approvals
team.json                   invite token, signing key and reviewer names (mode 600)
```

Delete the folder to start over.

## Development

```bash
npm install
npm run dev            # rebuild client bundles and the CLI on change
node dist/cli.js http://localhost:5173 --project ../some-app

npm run lint
npm run typecheck
npm test               # unit + server integration tests (scripted agent)
npx playwright install chromium
npm run build && npm run test:e2e   # browser tests against a fixture app
```

`PH_FAKE_AGENT=1` adds a scripted `fake` agent used by the tests; it drives the real MCP endpoint, so the whole pipeline is exercised without an LLM.

## License

[MIT](./LICENSE). Bundled third-party code is listed in [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md).
