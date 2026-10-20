/**
 * dsh-notify — Host half.
 *
 * Watches the durable Session log for the two moments worth interrupting a
 * person for — a turn ended, or the agent asked a question and is now blocked
 * on the answer — and serves them to the Client half, which raises the actual
 * notification. The Host runs in its own process, so it cannot show an OS toast.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-notify'

/** The Host half needs the HTTP carrier and the ability to raise a native toast. */
export const inject = ['webServer', 'subprocess']

/** Self-drawn card helper shipped beside this module. */
const CARD_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'card.ps1')

/** Route prefix the Client polls. */
const API = '/dsh-notify/api'

/** Attention records kept for the Client; older ones are dropped. */
const MAX_ITEMS = 20

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** Tools that block the turn on a human answer. */
const QUESTION_TOOLS = new Set(['ask_user_question'])

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** Accept only loopback callers; the page and the Host are same-origin. */
function hostnameOf(header) {
  const value = String(header || '').trim().toLowerCase()
  if (!value) return ''
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end > 0 ? value.slice(1, end) : value
  }
  return value.split(':')[0]
}

export function apply(ctx, config) {
  /** Newest-first attention records. */
  const items = []
  let seq = 0
  /** Diagnostics: how many polls the Client made, and how many events matched. */
  let polls = 0
  const counters = { done: 0, question: 0, error: 0, cards: 0 }

  const push = (kind, sessionId, detail) => {
    const id = String(sessionId ?? '')
    if (!id) return
    seq += 1
    if (kind === 'done') counters.done += 1
    else if (kind === 'question') counters.question += 1
    else counters.error += 1
    items.unshift({ seq, kind, sessionId: id, detail, at: Date.now() })
    if (items.length > MAX_ITEMS) items.length = MAX_ITEMS
  }

  /**
   * One listener covers every trigger: the durable Session log is the surface a
   * profile-level plugin observes reliably. `global` bypasses the scope filter
   * that hides agent-scoped dispatches from a sibling plugin context.
   */
  ctx.effect(
    () =>
      ctx.on(
        'session/event',
        (session, event) => {
          try {
            if (!event || !session) return
            // A delegated child reports through its parent's turn.
            if (session.header?.origin === 'subagent') return
            const id = String(session.id ?? '')
            if (!id) return

            if (event.type === 'turn/end') {
              const reason = event.data?.reason ?? {}
              if (reason.kind === 'completed') {
                push('done', id, '')
                return
              }
              if (reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'max-tokens') {
                const message = typeof reason.error?.message === 'string' ? reason.error.message.slice(0, 200) : reason.kind
                push('error', id, message)
              }
              return
            }

            if (event.type === 'tool/call' && QUESTION_TOOLS.has(String(event.data?.name ?? ''))) {
              push('question', id, '')
            }
          } catch {
            /* observation must never disturb the session append */
          }
        },
        { global: true },
      ),
    'dsh-notify: session attention',
  )

  /** Newest-first client reports: what the notification attempt actually did. */
  const clientReports = []

  const readJson = (req) =>
    new Promise((resolve) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 8192) {
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        } catch {
          resolve(undefined)
        }
      })
      req.on('error', () => resolve(undefined))
    })

  /** Optional row config: process to restore, and how long the card stays. */
  const card = config && typeof config === 'object' ? config : {}
  const processName =
    typeof card.processName === 'string' && card.processName.trim() ? card.processName.trim() : 'DeepSeek Harness'
  const cardSeconds = Number.isInteger(card.seconds) && card.seconds >= 3 ? card.seconds : 20

  /**
   * Raise a self-drawn card through the shipped PowerShell helper. The desktop
   * app registers no AppUserModelID, so a toast created in the renderer is
   * dropped silently; this card is our own topmost window, and clicking it
   * restores the app.
   */
  const showCard = (title, body, colors) => {
    // The card is a Windows-only substitute; elsewhere the in-page notification
    // remains the only channel.
    if (process.platform !== 'win32') return
    try {
      const palette = colors && typeof colors === 'object' ? colors : {}
      const argv = [
        'powershell.exe',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        CARD_SCRIPT,
        '-Title',
        String(title ?? '').slice(0, 120),
        '-Body',
        String(body ?? '').slice(0, 300),
        '-ProcessName',
        processName,
        '-Seconds',
        String(cardSeconds),
      ]
      // Only pass colours the Client actually measured; the helper falls back to
      // the Windows app theme when a value is missing.
      for (const [flag, key] of [
        ['-Bg', 'bg'],
        ['-Fg', 'fg'],
        ['-Fg2', 'fg2'],
        ['-Hint', 'hint'],
        ['-Border', 'border'],
      ]) {
        const value = typeof palette[key] === 'string' ? palette[key].trim() : ''
        if (/^#[0-9a-f]{6,8}$/i.test(value)) argv.push(flag, value)
      }
      const handle = ctx.subprocess.spawn({
        argv,
        cwd: dirname(CARD_SCRIPT),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 8192 }, stderr: { maxBytes: 8192 } },
        graceMs: 30000,
      })
      counters.cards += 1
      handle.done.catch(() => {})
    } catch (error) {
      counters.lastCardError = String((error && error.message) || error).slice(0, 120)
    }
  }

  const handler = async (req, res) => {
    try {
      if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) return sendJson(res, 403, { ok: false })
      if (String(req.headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') {
        return sendJson(res, 403, { ok: false })
      }
      const url = new URL(req.url || '/', 'http://localhost')

      if (url.pathname === `${API}/toast`) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        const body = await readJson(req)
        if (body && typeof body === 'object') showCard(body.title, body.body, body.colors)
        return sendJson(res, 200, { ok: true })
      }

      if (url.pathname === `${API}/report`) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false })
        const body = await readJson(req)
        if (body && typeof body === 'object') {
          clientReports.unshift(body)
          if (clientReports.length > 5) clientReports.length = 5
        }
        return sendJson(res, 200, { ok: true })
      }

      if (url.pathname === `${API}/state`) {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false })
        polls += 1
        return sendJson(res, 200, { ok: true, data: { seq, items, polls, counters, clientReports } })
      }

      return sendJson(res, 404, { ok: false })
    } catch {
      return sendJson(res, 500, { ok: false })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API, handler }), 'dsh-notify: state route')
}
