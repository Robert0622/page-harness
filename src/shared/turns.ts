import type { ChatEvent, TurnItem, TurnView } from './protocol'

/** Folds one event into the turn list (mutates and returns it). Used by the server and the panel. */
export function applyEvent(turns: TurnView[], ev: ChatEvent): TurnView[] {
  if (ev.t === 'turn_begin') {
    if (turns.some((t) => t.id === ev.turnId)) return turns
    turns.push({
      id: ev.turnId,
      ts: ev.ts,
      user: ev.user,
      agent: ev.agent,
      model: ev.model,
      items: [],
      status: 'running',
      files: [],
      artifacts: [],
      lastSeq: ev.seq,
    })
    return turns
  }
  const turn = findTurn(turns, ev.turnId)
  if (!turn) return turns
  if (ev.seq <= turn.lastSeq && ev.seq !== 0) return turns
  turn.lastSeq = ev.seq
  const last = turn.items[turn.items.length - 1]
  switch (ev.t) {
    case 'text':
    case 'thinking': {
      const kind = ev.t
      if (last && last.kind === kind) last.text += ev.delta
      else turn.items.push({ kind, text: ev.delta })
      break
    }
    case 'tool': {
      const existing = turn.items.find((i): i is Extract<TurnItem, { kind: 'tool' }> => i.kind === 'tool' && i.id === ev.id)
      if (existing) {
        existing.status = ev.status
        if (ev.input !== undefined) existing.input = ev.input
        if (ev.output !== undefined) existing.output = ev.output
        if (ev.name && existing.name !== ev.name) existing.name = ev.name
      } else {
        turn.items.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: ev.status, output: ev.output })
      }
      for (const f of ev.files ?? []) if (!turn.files.includes(f)) turn.files.push(f)
      break
    }
    case 'ask':
      turn.items.push({ kind: 'ask', askId: ev.askId, spec: ev.spec })
      break
    case 'ask_answer': {
      const item = turn.items.find((i): i is Extract<TurnItem, { kind: 'ask' }> => i.kind === 'ask' && i.askId === ev.askId)
      if (item) item.answer = ev.answer
      break
    }
    case 'artifact':
      turn.artifacts.push({ name: ev.name, version: ev.version })
      break
    case 'notice':
      turn.items.push({ kind: 'notice', level: ev.level, message: ev.message })
      break
    case 'error':
      turn.items.push({ kind: 'error', message: ev.message })
      break
    case 'turn_end':
      turn.status = ev.status
      turn.endTs = ev.ts
      turn.usage = ev.usage
      turn.durationMs = ev.durationMs
      turn.message = ev.message
      break
  }
  return turns
}

function findTurn(turns: TurnView[], id: string): TurnView | undefined {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].id === id) return turns[i]
  return undefined
}

export function buildTurns(events: ChatEvent[]): TurnView[] {
  const turns: TurnView[] = []
  for (const ev of events) applyEvent(turns, ev)
  return turns
}

/** Plain assistant text of a turn (used for search, previews and exports). */
export function turnText(turn: TurnView): string {
  return turn.items.filter((i) => i.kind === 'text').map((i) => (i as { text: string }).text).join('')
}

/** A finished turn that produced nothing the user can read. */
export function isEmptyTurn(turn: TurnView): boolean {
  if (turn.status === 'running') return false
  return !turn.items.some((i) => (i.kind === 'text' && i.text.trim()) || i.kind === 'tool' || i.kind === 'ask' || i.kind === 'error')
}
