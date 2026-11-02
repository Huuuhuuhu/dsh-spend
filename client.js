/**
 * Client half: one idempotent DOM decorator, used because DSH exposes no Slot
 * for these three sidebar cells. It appends the balance and per-Workspace
 * amounts, replaces each Session row's time with that Session's amount, and
 * lets native CSS and host behavior own the hover states.
 */
window.__ModuleLoader__.load({
  id: 'dsh-spend',
  factory() {
    const ROUTE = 'plugins/dsh-spend/state'
    const POLL_MS = 5000
    const TICK_MS = 1000
    const TIME = /^(刚刚|昨天|前天|\d+(秒|分钟|小时|天|周)|\d{1,2}\/\d{1,2})$/

    const CSS = `
.dshspend-row { position: relative; }
.dshspend-amount {
  position: absolute;
  top: 50%;
  right: 12px;
  transform: translateY(-50%);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
  font-variant-numeric: tabular-nums;
}
.dshspend-balance {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .1px;
}
.dshspend-workspace {
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
}
.dshspend-stale { opacity: .45; }
.dshspend-row:hover .dshspend-workspace { display: none; }
`

    let snapshot = null
    let timer = null
    let ticker = null
    let style = null
    let observer = null
    let abort = null
    let scheduled = false
    let active = false
    let stale = false
    let lastRight = 12
    const boundRows = new WeakSet()

    const money = (value) =>
      value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : '¥' + Number(value).toFixed(2)

    const basename = (path) =>
      String(path ?? '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() ?? ''

    const relative = (time) => {
      const seconds = Math.max(0, Math.floor((Date.now() - Number(time)) / 1000))
      if (seconds < 60) return '刚刚'
      if (seconds < 3600) return Math.floor(seconds / 60) + '分钟'
      if (seconds < 86400) return Math.floor(seconds / 3600) + '小时'
      if (seconds < 604800) return Math.floor(seconds / 86400) + '天'
      return new Date(Number(time)).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
    }

    const rowRect = (element) => {
      const rect = element.getBoundingClientRect()
      return rect.width >= 170 && rect.width <= 360 && rect.height >= 18 && rect.height <= 48 ? rect : null
    }

    const findAccountRow = () => {
      let found = null
      for (const element of document.querySelectorAll('button, [role="button"], a[href]')) {
        const rect = element.getBoundingClientRect()
        if (rect.width < 160 || rect.width > 360 || rect.height < 28 || rect.height > 72) continue
        if (rect.left > 48 || rect.bottom < window.innerHeight * 0.52 || rect.bottom > window.innerHeight + 1) continue
        if (!element.querySelector('img, svg')) continue
        if (found === null || rect.bottom > found.rect.bottom) found = { element, rect }
      }
      return found
    }

    const findWorkspaceRow = (title) => {
      for (const element of document.querySelectorAll('[data-dshspend-workspace]')) {
        if (element.dataset.dshspendWorkspace !== title) continue
        if (rowRect(element) !== null && element.getBoundingClientRect().left <= 64) return element
      }
      let best = null
      for (const element of document.querySelectorAll('div, a, button, [role="treeitem"], [role="listitem"]')) {
        const text = element.textContent.trim()
        if (text !== title && !text.startsWith(title + ' ')) continue
        const rect = rowRect(element)
        if (rect === null || rect.left > 64 || rect.top < 80) continue
        if (best === null || rect.width < best.rect.width) best = { element, rect }
      }
      return best?.element ?? null
    }

    const timeRow = (element) => {
      let row = element
      for (let depth = 0; depth < 6; depth += 1) {
        const parent = row.parentElement
        if (parent === null) return null
        if (parent.getBoundingClientRect().left < 32 && rowRect(parent) !== null) return parent
        row = parent
      }
      return null
    }

    const rowTitle = (row, time) => {
      let best = ''
      for (const element of row.querySelectorAll('span, div')) {
        if (element.children.length !== 0) continue
        const text = element.textContent.trim()
        if (!text || text === time || /^¥/.test(text) || TIME.test(text)) continue
        if (text.length > best.length) best = text
      }
      return best
    }

    const sessionRows = () => {
      const rows = []
      const seen = new Set()
      for (const element of document.querySelectorAll('span, div')) {
        if (element.children.length !== 0) continue
        if (element.closest('[data-dshspend-amount]')) continue
        const patched = element.dataset.dshspendSession === '1'
        const raw = patched ? element.dataset.dshspendOriginal ?? '' : element.textContent.trim()
        const unowned = !patched && /^¥\d+\.\d{2}$/.test(raw)
        if (!patched && !unowned && !TIME.test(raw)) continue
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.left > 300 || rect.top < 80) continue
        const row = timeRow(element)
        if (row === null || seen.has(row)) continue
        seen.add(row)
        rows.push({ row, element, text: unowned ? '' : raw, title: rowTitle(row, raw) })
      }
      return rows.sort((a, b) => a.row.getBoundingClientRect().top - b.row.getBoundingClientRect().top)
    }

    const sample = () => {
      let fallback = null
      for (const element of document.querySelectorAll('[data-dshspend-session="1"]')) {
        if (fallback === null) fallback = element
        if (element.getBoundingClientRect().width > 0) return element
      }
      return fallback
    }

    const align = (element, row, reference) => {
      const target = (reference ?? sample())?.getBoundingClientRect()
      const rect = row.getBoundingClientRect()
      if (target !== undefined && target.width > 0) lastRight = Math.round(rect.right - target.right)
      element.style.right = lastRight + 'px'
    }

    const copyFont = (element, reference) => {
      if (!reference) return
      const style = window.getComputedStyle(reference)
      for (const property of ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'color']) {
        if (element.style[property] !== style[property]) element.style[property] = style[property]
      }
    }

    const setText = (element, text) => {
      const node = element.firstChild
      if (node !== null && node.nodeType === Node.TEXT_NODE) {
        if (node.nodeValue !== text) node.nodeValue = text
      } else if (element.textContent !== text) {
        element.textContent = text
      }
    }

    const decorateSessions = () => {
      if (snapshot === null) return
      const sessions = Object.entries(snapshot.sessions ?? {})
        .map(([id, value]) => ({ id, ...value }))
        .filter((session) => session.visible !== false)
        .sort((a, b) => b.updatedAt - a.updatedAt)
      const byId = new Map(sessions.map((session) => [session.id, session]))
      const used = new Set()
      for (const row of sessionRows()) {
        let match = row.row.dataset.dshspendSessionId
          ? byId.get(row.row.dataset.dshspendSessionId)
          : undefined
        if (match === undefined && row.title !== '') {
          match = sessions.find((session) => !used.has(session.id) && session.title === row.title)
        }
        if (match === undefined && row.text !== '') {
          match = sessions.find((session) => !used.has(session.id) && relative(session.updatedAt) === row.text)
        }
        if (match === undefined) {
          match = sessions.find(
            (session) =>
              !used.has(session.id) &&
              (row.text === '' || Date.now() - session.updatedAt < 90_000),
          )
        }
        if (match === undefined) continue
        used.add(match.id)
        row.row.dataset.dshspendSessionId = match.id
        if (!boundRows.has(row.row)) {
          boundRows.add(row.row)
          row.row.addEventListener('mouseleave', schedule, { passive: true })
        }
        if (row.element.dataset.dshspendOriginal === undefined) {
          row.element.dataset.dshspendOriginal = row.text === '' ? relative(match.updatedAt) : row.element.textContent
        }
        row.element.dataset.dshspendSession = '1'
        const next = money(match.cost)
        if (row.element.textContent !== next) setText(row.element, next)
        row.element.style.opacity = stale ? '.45' : ''
      }
    }

    const decorateWorkspaces = () => {
      if (snapshot === null) return
      const reference = sample()
      const seen = new Set()
      for (const [cwd, workspace] of Object.entries(snapshot.workspaces ?? {})) {
        const row = findWorkspaceRow(workspace.title || basename(cwd))
        if (row === null) continue
        seen.add(row)
        row.classList.add('dshspend-row')
        row.dataset.dshspendWorkspace = workspace.title || basename(cwd)
        let amount = row.querySelector('[data-dshspend-amount="workspace"]')
        if (amount === null) {
          amount = document.createElement('span')
          amount.className = 'dshspend-amount dshspend-workspace'
          amount.dataset.dshspendAmount = 'workspace'
          amount.dataset.dshspendOwned = '1'
          amount.setAttribute('aria-hidden', 'true')
          row.appendChild(amount)
        }
        const next = money(workspace.cost)
        if (amount.textContent !== next) amount.textContent = next
        amount.classList.toggle('dshspend-stale', stale)
        amount.title = '工作区累计实际扣款：' + next
        copyFont(amount, reference)
        align(amount, row, reference)
      }
      for (const amount of document.querySelectorAll('[data-dshspend-amount="workspace"]')) {
        if (!seen.has(amount.parentElement)) amount.remove()
      }
    }

    const decorateBalance = () => {
      const row = snapshot === null ? null : findAccountRow()
      if (row === null) {
        for (const amount of document.querySelectorAll('[data-dshspend-amount="balance"]')) amount.remove()
        return
      }
      let amount = row.element.querySelector('[data-dshspend-amount="balance"]')
      if (snapshot.balance === null) {
        amount?.remove()
        return
      }
      row.element.classList.add('dshspend-row')
      if (amount === null) {
        amount = document.createElement('span')
        amount.className = 'dshspend-amount dshspend-balance'
        amount.dataset.dshspendAmount = 'balance'
        amount.dataset.dshspendOwned = '1'
        amount.setAttribute('aria-hidden', 'true')
        row.element.appendChild(amount)
      }
      const next = '¥' + snapshot.balance
      if (amount.textContent !== next) amount.textContent = next
      amount.classList.toggle('dshspend-stale', stale)
      amount.title = '账户总余额：' + next
      align(amount, row.element)
    }

    const decorate = () => {
      decorateSessions()
      decorateWorkspaces()
      decorateBalance()
    }

    const schedule = () => {
      if (scheduled || !active) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        decorate()
      })
    }

    const refresh = async () => {
      if (abort !== null) return
      abort = new AbortController()
      try {
        const response = await fetch(ROUTE, {
          headers: { accept: 'application/json' },
          signal: abort.signal,
        })
        const payload = await response.json()
        if (!response.ok || payload.ok !== true) throw new Error('state unavailable')
        snapshot = payload
        stale = false
        schedule()
      } catch {
        stale = true
        schedule()
      } finally {
        abort = null
      }
    }

    const start = () => {
      if (active) return
      active = true
      style = document.createElement('style')
      style.dataset.dshspend = 'style'
      style.textContent = CSS
      document.head.appendChild(style)
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          const target = mutation.target.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target
          if (!(target instanceof Element)) continue
          const rect = target.getBoundingClientRect()
          if (rect.left < 320 && rect.top > 80 && rect.height <= 72) {
            schedule()
            return
          }
        }
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      document.addEventListener('visibilitychange', onVisibility)
      window.addEventListener('resize', schedule)
      refresh()
      timer = window.setInterval(refresh, POLL_MS)
      ticker = window.setInterval(schedule, TICK_MS)
    }

    const stop = () => {
      if (!active) return
      active = false
      observer?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', schedule)
      window.clearInterval(timer)
      window.clearInterval(ticker)
      abort?.abort()
      abort = null
      for (const element of document.querySelectorAll('[data-dshspend-session="1"]')) {
        if (element.dataset.dshspendOriginal !== undefined) {
          setText(element, element.dataset.dshspendOriginal)
        }
        element.style.opacity = ''
        delete element.dataset.dshspendSession
        delete element.dataset.dshspendOriginal
      }
      for (const row of document.querySelectorAll('[data-dshspend-session-id]')) {
        delete row.dataset.dshspendSessionId
      }
      for (const element of document.querySelectorAll('[data-dshspend-owned="1"]')) element.remove()
      for (const row of document.querySelectorAll('.dshspend-row, [data-dshspend-workspace]')) {
        row.classList.remove('dshspend-row')
        delete row.dataset.dshspendWorkspace
      }
      style?.remove()
      style = null
      observer = null
      snapshot = null
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') refresh()
    }

    return {
      apply(ctx) {
        ctx.effect(() => {
          start()
          return stop
        }, 'dsh-spend: inline decoration')
      },
    }
  },
})
