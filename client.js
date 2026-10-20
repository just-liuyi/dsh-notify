/**
 * dsh-notify — Client half.
 *
 * Polls the Host half for attention records and turns the ones that arrive
 * while the window is not in front into an OS notification, one short beep,
 * and a title badge that clears when the window regains focus.
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory() {
    const ZH = String((typeof navigator !== 'undefined' && navigator.language) || 'en').toLowerCase().startsWith('zh')
    const TEXT = {
      done: ZH ? '任务已完成' : 'Turn finished',
      question: ZH ? '正在等你选择或输入' : 'Waiting for your input',
      error: ZH ? '任务出错' : 'Turn failed',
      approval: ZH ? '需要你审批' : 'Approval needed',
      session: ZH ? '会话' : 'Session',
    }

    const POLL_MS = 2000
    const FETCH_TIMEOUT_MS = 1500
    const BADGE_RE = /^\(\d+\)\s*/

    /** Client plugin context, captured in apply; used for optional session opening. */
    let ctx

    function labelOf(kind) {
      return TEXT[kind] ?? TEXT.done
    }

    function shortId(sessionId) {
      const value = String(sessionId || '')
      return value ? `${TEXT.session} ${value.slice(0, 8)}` : 'DSH'
    }

    function bodyOf(item) {
      const name = item.title || shortId(item.sessionId)
      return item.detail ? `${name} · ${item.detail}` : name
    }

    /** The window counts as watched only when it is visible and focused. */
    function isWatched() {
      if (typeof document === 'undefined') return true
      if (document.visibilityState !== 'visible') return false
      return typeof document.hasFocus === 'function' ? document.hasFocus() : true
    }

    function withTimeout(ms) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), ms)
      return { signal: controller.signal, done: () => clearTimeout(timer) }
    }

    async function readState() {
      const timeout = withTimeout(FETCH_TIMEOUT_MS)
      try {
        const response = await fetch('/dsh-notify/api/state', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: timeout.signal,
        })
        const payload = await response.json()
        return payload && payload.ok ? payload.data : undefined
      } finally {
        timeout.done()
      }
    }

    /** Keep one small AudioContext and synthesize the attention beep. */
    let audioContext
    function beep() {
      try {
        const Ctor = window.AudioContext || window.webkitAudioContext
        if (!Ctor) return 'no-audio'
        audioContext ||= new Ctor()
        if (audioContext.state === 'suspended') audioContext.resume().catch(() => {})
        const oscillator = audioContext.createOscillator()
        const gain = audioContext.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.value = 880
        const now = audioContext.currentTime
        gain.gain.setValueAtTime(0.0001, now)
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
        oscillator.connect(gain)
        gain.connect(audioContext.destination)
        oscillator.start(now)
        oscillator.stop(now + 0.34)
        return `ok:${audioContext.state}`
      } catch (error) {
        return `threw:${String((error && error.message) || error).slice(0, 60)}`
      }
    }

    /** Tell the Host what the notification attempt actually did. */
    function report(detail) {
      try {
        const payload = {
          ...detail,
          at: Date.now(),
          permission: typeof Notification === 'undefined' ? 'missing' : Notification.permission,
          visibility: typeof document === 'undefined' ? '' : document.visibilityState,
          hasFocus: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
          audio: audioContext ? audioContext.state : 'none',
        }
        void fetch('/dsh-notify/api/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* reporting is diagnostic only */
      }
    }

    function openSession(sessionId) {
      try {
        const workspace = ctx.get('uiWorkspace')
        if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
      } catch {
        /* opening is a convenience, not a requirement */
      }
    }

    /** Resolve the live DSH theme tokens into hex colours for the native card. */
    function themeColors() {
      const read = (name, fallback) => {
        try {
          const probe = document.createElement('span')
          probe.style.color = `var(${name})`
          probe.style.display = 'none'
          document.body.appendChild(probe)
          const value = getComputedStyle(probe).color
          probe.remove()
          const match = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(value)
          if (!match) return fallback
          const hex = `#${[match[1], match[2], match[3]]
            .map((part) => Number(part).toString(16).padStart(2, '0'))
            .join('')}`
          const alpha = match[4] === undefined ? 1 : Number(match[4])
          if (alpha >= 1) return hex
          // Keep the alpha so the native card can flatten it over its surface.
          return `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`
        } catch {
          return fallback
        }
      }
      return {
        bg: read('--dsw-alias-bg-layer-1', '#ffffff'),
        fg: read('--dsw-alias-label-primary', '#0f1115'),
        fg2: read('--dsw-alias-label-secondary', '#61666b'),
        hint: read('--dsw-alias-label-tertiary', '#9aa0a6'),
        border: read('--dsw-alias-border-l2', '#0000001f'),
      }
    }

    /** Ask the Host for a self-drawn card (the in-page notification is dropped). */
    function requestToast(item) {
      try {
        void fetch('/dsh-notify/api/toast', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
          body: JSON.stringify({
            title: `DSH · ${labelOf(item.kind)}`,
            body: bodyOf(item),
            colors: themeColors(),
          }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* the card is an extra channel */
      }
    }

    function notify(item, onClick) {
      try {
        if (typeof Notification === 'undefined') return 'no-api'
        if (Notification.permission === 'granted') {
          const notification = new Notification(labelOf(item.kind), {
            body: bodyOf(item),
            tag: `dsh-notify:${item.sessionId}`,
            silent: true,
          })
          notification.onclick = () => {
            try {
              window.focus()
            } catch {
              /* focus is best-effort */
            }
            onClick()
            notification.close()
          }
          return 'shown'
        }
        if (Notification.permission === 'denied') return 'denied'
        Notification.requestPermission().catch(() => {})
        return `asked:${Notification.permission}`
      } catch (error) {
        return `threw:${String((error && error.message) || error).slice(0, 60)}`
      }
    }

    /** Prefix the document title while anything is unattended. */
    function refreshTitle(pending) {
      try {
        const base = String(document.title || '').replace(BADGE_RE, '')
        document.title = pending > 0 ? `(${pending}) ${base}` : base
      } catch {
        /* the title is advisory */
      }
    }

    return {
      inject: [],
      apply(context) {
        ctx = context
        let cursor = null
        let pending = 0
        let inFlight = false

        const reset = () => {
          pending = 0
          refreshTitle(0)
        }

        const tick = async () => {
          if (inFlight) return
          inFlight = true
          try {
            const state = await readState()
            if (!state) return
            if (cursor === null) {
              // First successful poll: adopt the current head instead of
              // replaying history recorded before this page loaded.
              cursor = Number(state.seq) || 0
              return
            }
            const fresh = (state.items || []).filter((item) => Number(item.seq) > cursor)
            if (fresh.length === 0) {
              refreshTitle(pending)
              return
            }
            cursor = Math.max(cursor, ...fresh.map((item) => Number(item.seq) || 0))
            if (isWatched()) {
              reset()
              report({ seq: fresh[0].seq, outcome: 'skipped:watched' })
              return
            }
            pending += fresh.length
            const newest = fresh[0]
            const notification = notify(newest, () => openSession(newest.sessionId))
            requestToast(newest)
            const sound = beep()
            refreshTitle(pending)
            report({ seq: newest.seq, kind: newest.kind, outcome: notification, sound })
          } catch {
            /* a missed poll is not worth surfacing */
          } finally {
            inFlight = false
          }
        }

        context.effect(() => {
          const onFocus = () => reset()
          const onVisibility = () => {
            if (document.visibilityState === 'visible') reset()
          }
          window.addEventListener('focus', onFocus)
          document.addEventListener('visibilitychange', onVisibility)
          report({ outcome: 'started' })
          void tick()
          const timer = setInterval(() => void tick(), POLL_MS)
          return () => {
            window.removeEventListener('focus', onFocus)
            document.removeEventListener('visibilitychange', onVisibility)
            clearInterval(timer)
            refreshTitle(0)
          }
        }, 'dsh-notify: attention polling')
      },
    }
  },
})
