// ask_question / ask_form: the MCP call blocks until the user answers in the panel.
import type { AskAnswer, AskSpec } from '../shared/protocol'
import { newId } from '../shared/util'

export const ASK_TIMEOUT_MS = 30 * 60 * 1000

interface PendingAsk {
  chatId: string
  turnId: string
  spec: AskSpec
  resolve(a: AskAnswer): void
  timer: NodeJS.Timeout
}

export class AskManager {
  private pending = new Map<string, PendingAsk>()

  constructor(private hooks: { onAsk(chatId: string, turnId: string, askId: string, spec: AskSpec): void; onAnswer(chatId: string, turnId: string, askId: string, answer: AskAnswer): void }) {}

  ask(chatId: string, turnId: string, spec: AskSpec, timeoutMs = ASK_TIMEOUT_MS): Promise<AskAnswer> {
    const askId = newId('ask_')
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.answer(askId, { timeout: true }), timeoutMs)
      this.pending.set(askId, { chatId, turnId, spec, resolve, timer })
      this.hooks.onAsk(chatId, turnId, askId, spec)
    })
  }

  answer(askId: string, answer: AskAnswer): boolean {
    const p = this.pending.get(askId)
    if (!p) return false
    this.pending.delete(askId)
    clearTimeout(p.timer)
    this.hooks.onAnswer(p.chatId, p.turnId, askId, answer)
    p.resolve(answer)
    return true
  }

  pendingFor(chatId: string): string[] {
    return [...this.pending.entries()].filter(([, p]) => p.chatId === chatId).map(([id]) => id)
  }

  cancelTurn(chatId: string, turnId: string): void {
    for (const [id, p] of this.pending) if (p.chatId === chatId && p.turnId === turnId) this.answer(id, { cancelled: true })
  }
}

/** Human-readable answer for the agent. */
export function formatAnswer(spec: AskSpec, a: AskAnswer): string {
  if ('skipped' in a) return 'The user skipped this question. Decide yourself and say what you assumed.'
  if ('cancelled' in a) return 'The question was cancelled because the turn was stopped.'
  if ('timeout' in a) return 'The user did not answer within 30 minutes. Decide yourself and say what you assumed.'
  if ('values' in a && spec.kind === 'form') {
    return spec.fields.map((f) => `${f.label} (${f.name}): ${a.values[f.name] ?? ''}`).join('\n')
  }
  if ('answers' in a && spec.kind === 'question') {
    return spec.questions
      .map((q) => {
        const ans = a.answers[q.id]
        if (!ans) return `${q.prompt}\n→ (no answer)`
        const labels = ans.selected.map((id) => q.options.find((o) => o.id === id)?.label ?? id)
        if (ans.other) labels.push(`Other: ${ans.other}`)
        return `${q.prompt}\n→ ${labels.join('; ') || '(no answer)'}`
      })
      .join('\n\n')
  }
  return JSON.stringify(a)
}
