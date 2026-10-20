// Agent-first output: JSON on stdout by default, readable text with --human.
// A failure is JSON on stderr (text with --human) and exit code 1.

import { KebeleError } from './docker.ts'

export interface Globals {
  human?: boolean
  nopretty?: boolean
  socket?: string
}

export function result(value: unknown, globals: Globals, human: () => string): void {
  if (globals.human) process.stdout.write(human() + '\n')
  else process.stdout.write(JSON.stringify(value, null, globals.nopretty ? undefined : 2) + '\n')
}

/** One line per event, for commands that report as they go (`up`, `logs`). */
export function event(value: Record<string, unknown>, globals: Globals, human: () => string): void {
  process.stdout.write((globals.human ? human() : JSON.stringify(value)) + '\n')
}

export function failure(error: unknown, globals: Globals): string {
  const message = error instanceof Error ? error.message : String(error)
  const details = error instanceof KebeleError ? error.details : {}
  if (globals.human) {
    const extra = Object.entries(details)
      .map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join('\n    ') : String(value)}\n`)
      .join('')
    return `error: ${message}\n${extra}`
  }
  return JSON.stringify({ ok: false, error: { message, ...details } }) + '\n'
}
