/**
 * @xia-sc/dsh-decision — Client half.
 *
 * Registers two slots:
 *   settings.section     — the Decision settings page (key, default model, quota)
 *   tool.call.toolview   — the decision_ask card (probability bars, box values)
 *
 * Data comes from the Host half's same-origin routes under /dsh-decision/*; the
 * API key never reaches the browser.
 */

window.__ModuleLoader__.load({
  id: '@xia-sc/dsh-decision',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    /**
     * Single source of truth for UI copy. `locale/zh.json` and `locale/en.json` carry
     * exactly the same flat keys (plus the `meta` block dsh-app-boot's readPluginMeta
     * uses for the Plugins page), and `scripts/smoke-client.mjs` fails when the key
     * sets drift apart (they used to: `cardRunning` vs `card.running`).
     * `{name}` placeholders are filled by the translator.
     */
    const DICT_ZH = {
      'settings.title': '决策模型',
      'settings.subtitle': 'Decision 3.0 · 多模态决策模型',
      'settings.apiKey': 'API Key',
      'settings.apiKeyPlaceholder': 'sk-vsr-...',
      'settings.apiKeyConfigured': '已配置',
      'settings.apiKeyMissing': '未配置',
      'settings.save': '保存并验证',
      'settings.saving': '正在验证...',
      'settings.saved': '已保存',
      'settings.model': '默认模型',
      'settings.modelCurrent': '当前，不在模型列表中',
      'settings.usage': '今日用量',
      'settings.usageRequests': '请求',
      'settings.usageTokens': 'tokens',
      'settings.usageFormat': '{requests} 请求 · {tokens} tokens',
      'settings.usageNone': '尚未配置 Key，无法查询用量。',
      'settings.usageLoading': '加载中…',
      'settings.usageUnavailable': '—',
      'settings.quotaUsage': '{used} / {total}',
      'settings.quotaUsedLeft': '已用 {used} · 剩余 {left}',
      'settings.quotaUsedOnly': '已用 {used}',
      'settings.models': '模型',
      'settings.modelName': '模型',
      'settings.modelSize': '规模',
      'settings.modelBox': '定位框',
      'settings.modelReady': '可用',
      'settings.refresh': '刷新',
      'settings.loading': '加载中...',
      'settings.errorPrefix': '请求失败：',
      'settings.crash': '设置页面渲染失败：',
      'status.refreshing': '正在刷新…',
      'status.refreshingAt': '正在刷新… 当前显示 {time} 的数据',
      'status.cached': '缓存数据（Host 端 20 秒内复用，{time}）',
      'status.updated': '已更新（{time}）',
      'error.timeout15': '请求超时（15 秒）',
      'error.usageTimeout': '用量查询超时',
      'error.saveTimeout': '保存超时（30 秒），上游未在时限内响应，请稍后重试。',
      'card.running': '正在询问决策模型...',
      'card.title': '决策',
      'card.noData': '详细结果不可用，请查看上方工具输出。',
      'card.lowConfidence': '低置信',
      'card.yes': '是',
      'card.no': '否',
      'card.crash': '决策卡片渲染失败：',
      'card.resultExpired': '结果已过期（超过 1 小时或已被淘汰），工具输出仍保留在会话中。',
      'card.call': 'call {tail}',
      'card.tokens': '{count} tokens',
      'card.answersArrayHint': '结果未按问题 ID 返回，以下按顺序显示。',
    }

    const DICT_EN = {
      'settings.title': 'Decision',
      'settings.subtitle': 'Decision 3.0 · multimodal decision models',
      'settings.apiKey': 'API key',
      'settings.apiKeyPlaceholder': 'sk-vsr-...',
      'settings.apiKeyConfigured': 'Configured',
      'settings.apiKeyMissing': 'Not configured',
      'settings.save': 'Save and verify',
      'settings.saving': 'Verifying...',
      'settings.saved': 'Saved',
      'settings.model': 'Default model',
      'settings.modelCurrent': 'current, not in the model list',
      'settings.usage': 'Today',
      'settings.usageRequests': 'requests',
      'settings.usageTokens': 'tokens',
      'settings.usageFormat': '{requests} requests · {tokens} tokens',
      'settings.usageNone': 'No key configured, so usage is unavailable.',
      'settings.usageLoading': 'Loading…',
      'settings.usageUnavailable': '—',
      'settings.quotaUsage': '{used} / {total}',
      'settings.quotaUsedLeft': '{used} used · {left} left',
      'settings.quotaUsedOnly': '{used} used',
      'settings.models': 'Models',
      'settings.modelName': 'Model',
      'settings.modelSize': 'Size',
      'settings.modelBox': 'Box',
      'settings.modelReady': 'Ready',
      'settings.refresh': 'Refresh',
      'settings.loading': 'Loading...',
      'settings.errorPrefix': 'Request failed: ',
      'settings.crash': 'Decision settings failed to render: ',
      'status.refreshing': 'Refreshing…',
      'status.refreshingAt': 'Refreshing… showing data from {time}',
      'status.cached': 'Cached data (the Host reuses it for 20 s, {time})',
      'status.updated': 'Updated ({time})',
      'error.timeout15': 'Request timed out (15 s)',
      'error.usageTimeout': 'Usage query timed out',
      'error.saveTimeout': 'Saving timed out (30 s); the upstream did not answer in time. Try again.',
      'card.running': 'Asking decision model...',
      'card.title': 'Decision',
      'card.noData': 'Detailed result is unavailable; see the tool output above.',
      'card.lowConfidence': 'low confidence',
      'card.yes': 'yes',
      'card.no': 'no',
      'card.crash': 'Decision card failed to render: ',
      'card.resultExpired': 'The result has expired (older than 1 hour or evicted); the tool output is still in the conversation.',
      'card.call': 'call {tail}',
      'card.tokens': '{count} tokens',
      'card.answersArrayHint': 'The result did not include question ids; entries are shown in order.',
    }

    const STYLES = [
      '.dsd{display:flex;flex-direction:column;gap:12px;padding:16px;color:var(--dsw-alias-label-primary);font-size:13px}',
      '.dsd-toolcard{padding:10px 12px;min-height:36px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}',
      '.dsd-title{margin:0;font-size:16px;font-weight:600}',
      '.dsd-sub{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dsd-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.dsd-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dsd-label{font-size:12px;color:var(--dsw-alias-label-secondary);min-width:88px}',
      '.dsd-badge{border-radius:999px;padding:1px 8px;font-size:11px;border:1px solid var(--dsw-alias-border-l1)}',
      '.dsd-badge-ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.dsd-badge-warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.dsd-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit}',
      '.dsd-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit}',
      '.dsd-button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.dsd-button:disabled{opacity:.55;cursor:default}',
      '.dsd-button-primary{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-weight:500}',
      '.dsd-button-primary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}',
      '.dsd-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsd-error{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}',
      '.dsd-hint{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.dsd-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dsd-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsd-table td{padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.dsd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.dsd-q{display:flex;flex-direction:column;gap:4px;margin-top:2px}',
      '.dsd-q-title{font-size:12px;font-weight:600}',
      '.dsd-bar{display:flex;align-items:center;gap:8px;font-size:12px}',
      '.dsd-bar-label{min-width:60px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dsd-bar-track{flex:1;height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.dsd-bar-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-state-idle-primary)}',
      '.dsd-bar-fill-chosen{background:var(--dsw-alias-brand-primary)}',
      '.dsd-bar-value{min-width:48px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}',
      '.dsd-wrap{display:flex;flex-direction:column;gap:6px}',
    ].join('\n')

    // -------------------------------------------------------------------------
    // shared stylesheet: one <style> node per document instead of one per card
    // -------------------------------------------------------------------------

    const STYLE_ID = 'dsh-decision-styles'
    let stylesInserted = false

    /**
     * Inject STYLES into document.head exactly once (C10). Returns false when there is
     * no DOM (the Node smoke test): components then render an inline <style> node, so
     * the same code path keeps working there.
     */
    function ensureStyles() {
      if (typeof document === 'undefined' || !document || !document.head) return false
      if (stylesInserted) return true
      try {
        const existing = typeof document.getElementById === 'function' ? document.getElementById(STYLE_ID) : null
        if (existing) {
          stylesInserted = true
          return true
        }
        const node = document.createElement('style')
        node.id = STYLE_ID
        node.setAttribute('data-plugin-css', 'dsh-decision')
        // rc.5's bundle loader removes a package's own <style> nodes on unload by
        // data-plugin; declaring it here is a second cleanup path beside our effect.
        node.dataset.plugin = '@xia-sc/dsh-decision'
        node.textContent = STYLES
        document.head.appendChild(node)
        stylesInserted = true
        return true
      } catch (error) {
        return false
      }
    }

    /** Removes the shared node on plugin unload; the next apply()/render recreates it. */
    function removeStyles() {
      stylesInserted = false
      if (typeof document === 'undefined' || !document) return
      try {
        const node = typeof document.getElementById === 'function' ? document.getElementById(STYLE_ID) : null
        if (node && node.parentNode) node.parentNode.removeChild(node)
      } catch (error) {
        // best effort only
      }
    }

    function styleElement() {
      if (ensureStyles()) return null
      return h('style', { key: 'style' }, STYLES)
    }

    /** Prepend the shared stylesheet reference to a children array. */
    function withStyles(children) {
      const styles = styleElement()
      return styles ? [styles].concat(children) : children
    }

    // -------------------------------------------------------------------------
    // small, shape-safe helpers: upstream payloads are untrusted input
    // -------------------------------------------------------------------------

    function isPlainObject(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    }

    /** Walks a path of object keys, returning null as soon as the shape breaks. */
    function nested(root, keys) {
      let current = root
      for (const key of keys) {
        if (!isPlainObject(current)) return null
        current = current[key]
      }
      return isPlainObject(current) ? current : null
    }

    function asNumber(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    function interpolate(template, vars) {
      if (!vars) return template
      return String(template).replace(/\{(\w+)\}/g, (match, name) => {
        const value = vars[name]
        return value === undefined || value === null ? match : String(value)
      })
    }

    /** Dictionary lookup used when a component is rendered without a translator prop. */
    function fallbackTranslate(key, vars) {
      return interpolate(DICT_ZH[key] || DICT_EN[key] || key, vars)
    }

    function translatorOf(props) {
      const translate = props && props.dsdTranslate
      return typeof translate === 'function' ? translate : fallbackTranslate
    }

    function requestUrl(path) {
      try {
        return new URL(path, typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1').href
      } catch (error) {
        return path
      }
    }

    /** Error text that names the resolved URL and page origin, so a failed route is diagnosable on screen. */
    function httpError(res, json, path) {
      const detail = (json && json.error) || `HTTP ${res.status}`
      const origin = typeof location !== 'undefined' ? location.origin : 'unknown'
      return new Error(`${detail} · ${requestUrl(path)} · origin=${origin}`)
    }

    function safePercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0
      return Math.max(0, Math.min(100, value * 100))
    }

    function formatPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
      return `${(value * 100).toFixed(1)}%`
    }

    function formatNumber(value, digits) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
      return value.toFixed(digits === undefined ? 2 : digits)
    }

    function formatClock(ts) {
      if (typeof ts !== 'number' || !Number.isFinite(ts)) return ''
      try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch (error) {
        return ''
      }
    }

    function truncateText(value, limit) {
      let text
      if (typeof value === 'string') text = value
      else if (value === undefined || value === null) text = ''
      else text = String(value)
      const max = typeof limit === 'number' && limit > 0 ? limit : 500
      return text.length > max ? `${text.slice(0, max)}…` : text
    }

    /** Never put an unbounded JSON blob into the DOM (C9); a circular value must not throw. */
    function truncateJson(value, limit) {
      let text
      try {
        text = typeof value === 'string' ? value : JSON.stringify(value)
      } catch (error) {
        text = String(value)
      }
      if (typeof text !== 'string') text = String(text)
      return truncateText(text, limit === undefined ? 500 : limit)
    }

    function callTail(callId) {
      return callId ? callId.slice(-8) : '—'
    }

    /** Host/route error strings with a user-facing translation (the card must not show raw English). */
    const CARD_ERROR_KEYS = { 'result is no longer cached': 'card.resultExpired' }

    function localizedCardError(message, t) {
      const text = typeof message === 'string' ? message : String(message)
      const key = CARD_ERROR_KEYS[text.trim()]
      return key ? t(key) : text
    }

    function statusFreshness(status, t) {
      if (!status || !isPlainObject(status.data)) return ''
      const at = status.data.cachedAt || status.staleAt
      const clock = formatClock(at) || '—'
      if (status.loading) return at ? t('status.refreshingAt', { time: clock }) : t('status.refreshing')
      if (status.data.cached) return t('status.cached', { time: clock })
      return at ? t('status.updated', { time: clock }) : ''
    }

    /** Models arrive from `/api/info` verbatim: drop anything unusable, coerce the rest. */
    function normalizeModels(raw) {
      const list = Array.isArray(raw) ? raw : []
      const models = []
      for (const entry of list) {
        if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) continue
        models.push({
          id: entry.id,
          size:
            typeof entry.size === 'string' ? entry.size : typeof entry.size === 'number' ? String(entry.size) : '',
          box: entry.box === true,
          ready: entry.ready === true,
        })
      }
      return models
    }

    /** Quota rows are display-only, so an entry without an id still gets a readable label. */
    function normalizeQuotaModels(usageData) {
      const quota = nested(usageData, ['usage', 'daily', 'quota'])
      const list = quota && Array.isArray(quota.models) ? quota.models : []
      const models = []
      let index = 0
      for (const entry of list) {
        if (!isPlainObject(entry)) continue
        index += 1
        models.push({
          id: typeof entry.id === 'string' && entry.id ? entry.id : `#${index}`,
          used: asNumber(entry.requests_today, null),
          left: asNumber(entry.requests_left, null),
        })
      }
      return models
    }

    /** `/usage` self payload: only report numbers that actually exist (C3/P2-12). */
    function normalizeUsageToday(usageData) {
      const today = nested(usageData, ['usage', 'self', 'usage_today'])
      if (!today) return null
      const requests = asNumber(today.requests, null)
      const inputTokens = asNumber(today.input_tokens, null)
      if (requests === null && inputTokens === null) return null
      return { requests: requests === null ? 0 : requests, inputTokens: inputTokens === null ? 0 : inputTokens }
    }

    /** `answers` is an object keyed by question id; an array is shown as ordered entries (C8). */
    function normalizeAnswers(raw) {
      if (Array.isArray(raw)) {
        const answers = {}
        raw.forEach((answer, index) => {
          answers[`#${index + 1}`] = answer
        })
        return { answers, ordered: true }
      }
      if (isPlainObject(raw)) return { answers: raw, ordered: false }
      return { answers: {}, ordered: false }
    }

    function modelOptionLabel(entry, t) {
      const parts = [entry.id]
      if (entry.size) parts.push(entry.size)
      if (entry.current) parts.push(t('settings.modelCurrent'))
      return parts.join(' · ')
    }

    // -------------------------------------------------------------------------
    // locale + diagnostics
    // -------------------------------------------------------------------------

    function makeTranslator(ctx) {
      let bound = null
      try {
        const dispose =
          ctx && ctx.locale && typeof ctx.locale.register === 'function'
            ? ctx.locale.register('dsh-decision', { zh: DICT_ZH, en: DICT_EN })
            : undefined
        // `register` returns its own disposer: without handing it to ctx.effect the
        // namespace outlives the plugin and the next apply()/HMR register() throws.
        if (typeof dispose === 'function' && ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose)
      } catch (error) {
        // Already registered (a second apply before unload); the local dictionary still renders.
      }
      try {
        if (ctx && ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind('dsh-decision')
      } catch (error) {
        bound = null
      }
      return (key, vars) => {
        let text
        try {
          if (bound) {
            const value = bound(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) text = value
          }
        } catch (error) {
          // fall through to the local dictionary
        }
        if (text === undefined) text = DICT_ZH[key] || DICT_EN[key] || key
        return interpolate(text, vars)
      }
    }

    /** Fire-and-forget diagnostics to the Host; the settings page can surface them. */
    function report(payload) {
      try {
        fetch('/dsh-decision/client-report', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(payload || {}),
        }).catch(function () {})
      } catch (error) {
        // diagnostics are optional
      }
    }

    // -------------------------------------------------------------------------
    // error boundaries: a failed render must stay visible, never blank the row
    // -------------------------------------------------------------------------

    /** Keeps a crashing card renderable and reports it once, instead of losing the card. */
    class CardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error, info) {
        report({
          kind: 'card-crash',
          callId: this.props && this.props.callId,
          message: truncateText(error && error.message ? error.message : String(error), 400),
          phase: info && info.componentStack ? String(info.componentStack).slice(0, 200) : '',
        })
      }
      render() {
        if (this.state.error) {
          const t = translatorOf(this.props)
          const message = truncateText(
            this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error),
            500,
          )
          return h(React.Fragment, null, withStyles([
            h('div', { className: 'dsd', key: 'card' }, [
              h('div', { className: 'dsd-error', key: 'e', role: 'alert' }, `${t('card.crash')}${message}`),
            ]),
          ]))
        }
        return this.props.children
      }
    }

    /**
     * Same idea for settings.section: the renderer would otherwise remove the whole
     * "decision models" section when one malformed field throws (P2-11).
     */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error, info) {
        report({
          kind: 'settings-crash',
          message: truncateText(error && error.message ? error.message : String(error), 400),
          phase: info && info.componentStack ? String(info.componentStack).slice(0, 200) : '',
        })
      }
      render() {
        if (this.state.error) {
          const t = translatorOf(this.props)
          const message = truncateText(
            this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error),
            500,
          )
          return h(React.Fragment, null, withStyles([
            h('div', { className: 'dsd', key: 'root' }, [
              h('h2', { className: 'dsd-title', key: 'title' }, t('settings.title')),
              h('div', { className: 'dsd-card', key: 'card' }, [
                h('div', { className: 'dsd-error', key: 'e', role: 'alert' }, `${t('settings.crash')}${message}`),
              ]),
            ]),
          ]))
        }
        return this.props.children
      }
    }

    // -------------------------------------------------------------------------
    // cached JSON resources (status, usage)
    // -------------------------------------------------------------------------

    const STATUS_CACHE_KEY = 'dsh-decision.status.v1'
    const STATUS_TIMEOUT_MS = 15000
    const USAGE_CACHE_KEY = 'dsh-decision.usage.v1'
    const USAGE_TIMEOUT_MS = 12000

    function readStatusCache() {
      try {
        const raw = localStorage.getItem(STATUS_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!isPlainObject(parsed) || typeof parsed.at !== 'number' || !isPlainObject(parsed.data)) return null
        // A day-old snapshot is worse than a fresh spinner.
        if (Date.now() - parsed.at > 24 * 60 * 60 * 1000) return null
        return parsed
      } catch (error) {
        return null
      }
    }

    function writeStatusCache(data) {
      try {
        localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
      } catch (error) {
        // Storage may be unavailable; the page still works without it.
      }
    }

    function readUsageCache() {
      try {
        const raw = localStorage.getItem(USAGE_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!isPlainObject(parsed) || typeof parsed.at !== 'number' || !isPlainObject(parsed.data)) return null
        if (Date.now() - parsed.at > 24 * 60 * 60 * 1000) return null
        return parsed
      } catch (error) {
        return null
      }
    }

    function writeUsageCache(data) {
      try {
        localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify({ at: Date.now(), data }))
      } catch (error) {
        // ignore
      }
    }

    /**
     * Stale-while-revalidate: paint the cached payload immediately, then replace it when
     * the fetch lands. Concurrent callers share one in-flight request, a monotonically
     * increasing sequence keeps an older answer from overwriting a newer one, and no
     * state is written after unmount (C15).
     */
    function useJsonStatus(t) {
      const [state, setState] = useState(() => {
        const cached = readStatusCache()
        return { loading: true, error: null, data: cached ? cached.data : null, staleAt: cached ? cached.at : null }
      })
      const track = React.useRef({ alive: true, seq: 0, url: '', promise: null })

      const apply = useCallback((data) => {
        if (!isPlainObject(data)) return
        writeStatusCache(data)
        setState({ loading: false, error: null, data, staleAt: Date.now() })
      }, [])

      const load = useCallback(
        (options) => {
          const refresh = Boolean(options && options.refresh)
          const url = `/dsh-decision/status${refresh ? '?refresh=1' : ''}`
          const control = track.current
          if (control.promise && control.url === url) return control.promise
          control.seq += 1
          const seq = control.seq
          setState((current) => ({ ...current, loading: true, error: null }))
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const timer = setTimeout(() => {
            if (controller) controller.abort()
          }, STATUS_TIMEOUT_MS)
          let request
          request = (async () => {
            try {
              const res = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: controller ? controller.signal : undefined,
              })
              const json = await res.json().catch(() => null)
              if (!res.ok) throw httpError(res, json, '/dsh-decision/status')
              if (seq !== track.current.seq || !track.current.alive) return
              writeStatusCache(json)
              setState({ loading: false, error: null, data: json, staleAt: Date.now() })
            } catch (error) {
              // Never drop what is already on screen: show the error next to the cached value.
              if (seq !== track.current.seq || !track.current.alive) return
              const aborted = error && error.name === 'AbortError'
              const message = aborted ? t('error.timeout15') : error && error.message ? error.message : String(error)
              setState((current) => ({ ...current, loading: false, error: message }))
            } finally {
              clearTimeout(timer)
              if (control.promise === request) {
                control.promise = null
                control.url = ''
              }
            }
          })()
          control.promise = request
          control.url = url
          return request
        },
        [t],
      )

      useEffect(() => {
        const control = track.current
        control.alive = true
        load({ refresh: false })
        return () => {
          control.alive = false
          // A response that lands after unmount belongs to nobody.
          control.seq += 1
          control.promise = null
          control.url = ''
        }
      }, [load])

      return [state, load, apply]
    }

    /** Usage lives on its own route and its own cache: slow endpoint, small payload, optional data. */
    function useUsage(t) {
      const [state, setState] = useState(() => {
        const cached = readUsageCache()
        return { loading: true, error: null, data: cached ? cached.data : null, staleAt: cached ? cached.at : null }
      })
      const track = React.useRef({ alive: true, seq: 0, url: '', promise: null })

      const apply = useCallback((data) => {
        if (!isPlainObject(data)) return
        writeUsageCache(data)
        setState({ loading: false, error: null, data, staleAt: Date.now() })
      }, [])

      const load = useCallback(
        (options) => {
          const refresh = Boolean(options && options.refresh)
          const url = `/dsh-decision/usage${refresh ? '?refresh=1' : ''}`
          const control = track.current
          if (control.promise && control.url === url) return control.promise
          control.seq += 1
          const seq = control.seq
          setState((current) => ({ ...current, loading: true, error: null }))
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const timer = setTimeout(() => {
            if (controller) controller.abort()
          }, USAGE_TIMEOUT_MS)
          let request
          request = (async () => {
            try {
              const res = await fetch(url, {
                headers: { accept: 'application/json' },
                signal: controller ? controller.signal : undefined,
              })
              const json = await res.json().catch(() => null)
              if (!res.ok) throw httpError(res, json, '/dsh-decision/usage')
              if (seq !== track.current.seq || !track.current.alive) return
              writeUsageCache(json)
              setState({ loading: false, error: null, data: json, staleAt: Date.now() })
            } catch (error) {
              if (seq !== track.current.seq || !track.current.alive) return
              const aborted = error && error.name === 'AbortError'
              const message = aborted ? t('error.usageTimeout') : error && error.message ? error.message : String(error)
              // Keep the previous numbers on screen; just note that the refresh failed.
              setState((current) => ({ ...current, loading: false, error: message }))
            } finally {
              clearTimeout(timer)
              if (control.promise === request) {
                control.promise = null
                control.url = ''
              }
            }
          })()
          control.promise = request
          control.url = url
          return request
        },
        [t],
      )

      useEffect(() => {
        const control = track.current
        control.alive = true
        load({ refresh: false })
        return () => {
          control.alive = false
          control.seq += 1
          control.promise = null
          control.url = ''
        }
      }, [load])

      return [state, load, apply]
    }

    // -------------------------------------------------------------------------
    // settings.section
    // -------------------------------------------------------------------------

    const SETTINGS_INPUT_ID = 'dsd-decision-api-key'
    const SETTINGS_SELECT_ID = 'dsd-decision-model'
    /** Key validation (8 s) + /api/info + usage on the Host, with a safety margin. */
    const SAVE_TIMEOUT_MS = 30000

    function DecisionSettings(props) {
      const t = translatorOf(props)
      const [status, reload, applyStatus] = useJsonStatus(t)
      const [usage, reloadUsage, applyUsage] = useUsage(t)
      const [keyInput, setKeyInput] = useState('')
      const [model, setModel] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [failure, setFailure] = useState(null)
      const aliveRef = React.useRef(true)

      const data = isPlainObject(status.data) ? status.data : null
      const savedModel = data && typeof data.model === 'string' ? data.model : ''
      const configured = Boolean(data && data.keyConfigured === true)

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      // Seed the select once; a later /status refresh must not overwrite the user's choice.
      useEffect(() => {
        if (savedModel && model === '') setModel(savedModel)
      }, [savedModel, model])

      const keyValue = (keyInput || '').trim()
      const modelDirty = model !== '' && model !== savedModel
      const dirty = keyValue.length > 0 || modelDirty

      const save = useCallback(async () => {
        // Submit only what changed: always sending `model` made a key-only save pay for
        // the Host's forced /api/info round trip (C12) and risked a stale model id (C11).
        const body = {}
        if (keyValue) body.apiKey = keyValue
        if (modelDirty) body.model = model
        if (Object.keys(body).length === 0) return
        setBusy(true)
        setMessage(null)
        setFailure(null)
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          if (controller) controller.abort()
        }, SAVE_TIMEOUT_MS)
        try {
          const res = await fetch('/dsh-decision/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
            signal: controller ? controller.signal : undefined,
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw httpError(res, json, '/dsh-decision/config')
          if (!aliveRef.current) return
          setKeyInput('')
          setMessage(t('settings.saved'))
          if (isPlainObject(json)) {
            applyStatus(json)
            // The config response carries the freshly fetched usage alongside the status.
            applyUsage({
              keyConfigured: json.keyConfigured === true,
              usage: isPlainObject(json.usage) ? json.usage : null,
              ...(typeof json.usageError === 'string' && json.usageError ? { usageError: json.usageError } : {}),
            })
          } else {
            reload({ refresh: true })
            reloadUsage({ refresh: true })
          }
        } catch (error) {
          if (!aliveRef.current) return
          const aborted = error && error.name === 'AbortError'
          setFailure(aborted ? t('error.saveTimeout') : error && error.message ? error.message : String(error))
        } finally {
          clearTimeout(timer)
          if (aliveRef.current) setBusy(false)
        }
      }, [keyValue, modelDirty, model, t, applyStatus, applyUsage, reload, reloadUsage])

      const requestSave = useCallback(() => {
        if (busy || !dirty) return
        save()
      }, [busy, dirty, save])

      const modelList = data ? normalizeModels(data.models) : []
      const knownModels = modelList.map((entry) => entry.id)
      // A saved model that upstream no longer lists still needs a selected option,
      // otherwise `select.value` and its options disagree (C11).
      const modelOptions =
        model && knownModels.indexOf(model) === -1
          ? modelList.concat([{ id: model, size: '', box: false, ready: false, current: true }])
          : modelList

      const usageData = isPlainObject(usage.data) ? usage.data : null
      const usageToday = normalizeUsageToday(usageData)
      const quotaModels = normalizeQuotaModels(usageData)
      const usageError =
        (usageData && typeof usageData.usageError === 'string' && usageData.usageError) ||
        (typeof usage.error === 'string' && usage.error) ||
        null

      // Three distinct states: only the data state ever shows numbers (P2-12).
      let usageText
      if (!data) usageText = status.loading ? t('settings.usageLoading') : t('settings.usageUnavailable')
      else if (!configured) usageText = t('settings.usageNone')
      else if (usageToday) usageText = t('settings.usageFormat', { requests: usageToday.requests, tokens: usageToday.inputTokens })
      else if (usage.loading) usageText = t('settings.usageLoading')
      else usageText = t('settings.usageUnavailable')

      const children = [
        h('h2', { className: 'dsd-title', key: 'title' }, t('settings.title')),
        h('p', { className: 'dsd-sub', key: 'sub' }, t('settings.subtitle')),

        h('div', { className: 'dsd-card', key: 'key' }, [
          h('div', { className: 'dsd-row', key: 'k1' }, [
            h('span', { className: 'dsd-label', key: 'l' }, t('settings.apiKey')),
            h(
              'span',
              {
                className: `dsd-badge ${configured ? 'dsd-badge-ok' : 'dsd-badge-warn'}`,
                key: 'b',
              },
              configured ? t('settings.apiKeyConfigured') : t('settings.apiKeyMissing'),
            ),
            h(
              'span',
              { className: 'dsd-mono dsd-hint', key: 'p' },
              data && typeof data.keyPrefix === 'string' ? data.keyPrefix : '',
            ),
          ]),
          h('div', { className: 'dsd-row', key: 'k2' }, [
            h('input', {
              className: 'dsd-input',
              id: SETTINGS_INPUT_ID,
              name: 'dsh-decision-api-key',
              type: 'password',
              spellCheck: false,
              autoComplete: 'off',
              'aria-label': t('settings.apiKey'),
              placeholder: t('settings.apiKeyPlaceholder'),
              value: keyInput,
              onChange: (event) => setKeyInput(event.target.value),
              key: 'input',
            }),
            h(
              'button',
              {
                className: 'dsd-button',
                type: 'button',
                onClick: () => {
                  reload({ refresh: true })
                  reloadUsage({ refresh: true })
                },
                disabled: busy,
                key: 'refresh',
              },
              t('settings.refresh'),
            ),
          ]),
          h('div', { className: 'dsd-row', key: 'k3' }, [
            h(
              'label',
              {
                className: 'dsd-label',
                htmlFor: modelOptions.length > 0 ? SETTINGS_SELECT_ID : undefined,
                key: 'l',
              },
              t('settings.model'),
            ),
            modelOptions.length > 0
              ? h(
                  'select',
                  {
                    className: 'dsd-select',
                    id: SETTINGS_SELECT_ID,
                    'aria-label': t('settings.model'),
                    value: model,
                    onChange: (event) => setModel(event.target.value),
                    key: 'sel',
                  },
                  modelOptions.map((entry, index) =>
                    h('option', { value: entry.id, key: `${entry.id}:${index}` }, modelOptionLabel(entry, t)),
                  ),
                )
              : h(
                  'span',
                  { className: 'dsd-hint', key: 'm' },
                  savedModel || (status.loading ? t('settings.loading') : '—'),
                ),
            h(
              'button',
              {
                className: 'dsd-button dsd-button-primary',
                type: 'button',
                onClick: requestSave,
                disabled: busy || !dirty,
                key: 'save',
              },
              busy ? t('settings.saving') : t('settings.save'),
            ),
          ]),
          message ? h('div', { className: 'dsd-hint', key: 'ok' }, message) : null,
          failure
            ? h('div', { className: 'dsd-error', key: 'err', role: 'alert' }, `${t('settings.errorPrefix')}${failure}`)
            : null,
          status.error
            ? h(
                'div',
                { className: 'dsd-error', key: 'serr', role: 'alert' },
                `${t('settings.errorPrefix')}${status.error}`,
              )
            : null,
          h('div', { className: 'dsd-hint', key: 'fresh' }, statusFreshness(status, t)),
        ]),

        h('div', { className: 'dsd-card', key: 'usage' }, [
          h('div', { className: 'dsd-row', key: 'u1' }, [
            h('span', { className: 'dsd-label', key: 'l' }, t('settings.usage')),
            h('span', { className: 'dsd-hint', key: 'v' }, usageText),
          ]),
          usageError ? h('div', { className: 'dsd-error', key: 'uerr', role: 'alert' }, usageError) : null,
          quotaModels.length > 0
            ? h(
                'div',
                { className: 'dsd-wrap', key: 'q' },
                quotaModels.map((entry, index) => {
                  const total = entry.used !== null && entry.left !== null ? entry.used + entry.left : null
                  const percent =
                    total !== null && total > 0 ? Math.max(0, Math.min(100, (entry.used / total) * 100)) : 0
                  const valueText =
                    total !== null
                      ? t('settings.quotaUsage', { used: entry.used, total })
                      : entry.used !== null
                        ? t('settings.quotaUsedOnly', { used: entry.used })
                        : '—'
                  // The bar is a share of the limit; the text always names both numbers (C14).
                  const titleText =
                    total !== null ? t('settings.quotaUsedLeft', { used: entry.used, left: entry.left }) : entry.id
                  return h('div', { className: 'dsd-bar', key: `${entry.id}:${index}` }, [
                    h('span', { className: 'dsd-bar-label', key: 'l', title: entry.id }, entry.id),
                    total !== null
                      ? h(
                          'span',
                          { className: 'dsd-bar-track', key: 't' },
                          h('span', { className: 'dsd-bar-fill', style: { width: `${percent}%` } }),
                        )
                      : null,
                    h('span', { className: 'dsd-bar-value', key: 'v', title: titleText }, valueText),
                  ])
                }),
              )
            : null,
        ]),

        h('div', { className: 'dsd-card', key: 'models' }, [
          h('div', { className: 'dsd-row', key: 'h' }, [
            h('span', { className: 'dsd-label', key: 'l' }, t('settings.models')),
            h('span', { className: 'dsd-hint', key: 'c' }, `${modelList.length}`),
          ]),
          modelList.length > 0
            ? h(
                'table',
                { className: 'dsd-table', key: 'table', 'aria-label': t('settings.models') },
                h('thead', { key: 'thead' }, h('tr', null, [
                  h('th', { key: 'n', scope: 'col' }, t('settings.modelName')),
                  h('th', { key: 's', scope: 'col' }, t('settings.modelSize')),
                  h('th', { key: 'b', scope: 'col' }, t('settings.modelBox')),
                  h('th', { key: 'r', scope: 'col' }, t('settings.modelReady')),
                ])),
                h(
                  'tbody',
                  { key: 'tbody' },
                  modelList.map((entry, index) =>
                    h('tr', { key: `${entry.id}:${index}` }, [
                      h('td', { className: 'dsd-mono', key: 'n' }, entry.id),
                      h('td', { key: 's' }, entry.size),
                      h('td', { key: 'b' }, entry.box ? '✓' : '—'),
                      h('td', { key: 'r' }, entry.ready ? '✓' : '—'),
                    ]),
                  ),
                ),
              )
            : h('div', { className: 'dsd-hint', key: 'none' }, status.loading ? t('settings.loading') : '—'),
        ]),
      ]

      return h(React.Fragment, null, withStyles([h('div', { className: 'dsd', key: 'root' }, children)]))
    }

    // -------------------------------------------------------------------------
    // tool.call.toolview (the decision card)
    // -------------------------------------------------------------------------

    /** Host keeps results for an hour; mirror that in the page so each callId is fetched once. */
    const RESULT_CACHE_MAX = 100
    const resultCache = new Map()
    const resultInflight = new Map()

    function rememberResult(callId, value) {
      try {
        if (resultCache.has(callId)) resultCache.delete(callId)
        resultCache.set(callId, value)
        while (resultCache.size > RESULT_CACHE_MAX) {
          const oldest = resultCache.keys().next()
          if (oldest.done) break
          resultCache.delete(oldest.value)
        }
      } catch (error) {
        // cache is best effort
      }
    }

    /**
     * One `/result` request per callId: the card used to fetch twice (phase advance
     * plus a 1.5 s retry) and every card fetched its own copy — 13 historical cards
     * meant 26 requests. Same-shape results are cached and concurrent loads share
     * the in-flight promise.
     */
    function loadResult(callId) {
      if (resultCache.has(callId)) {
        return Promise.resolve({ value: resultCache.get(callId), error: null, status: 200 })
      }
      const pending = resultInflight.get(callId)
      if (pending) return pending
      let request
      request = (async () => {
        try {
          const res = await fetch(`/dsh-decision/result?callId=${encodeURIComponent(callId)}`, {
            headers: { accept: 'application/json' },
          })
          const json = await res.json().catch(() => null)
          const value = isPlainObject(json) && json.value ? json.value : null
          if (res.ok && value !== null) {
            rememberResult(callId, value)
            return { value, error: null, status: res.status }
          }
          return {
            value: null,
            error: isPlainObject(json) && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`,
            status: res.status,
          }
        } catch (error) {
          return { value: null, error: error && error.message ? error.message : String(error), status: 0 }
        } finally {
          resultInflight.delete(callId)
        }
      })()
      resultInflight.set(callId, request)
      return request
    }

    function DecisionCard(props) {
      const t = translatorOf(props)
      const callId = props && typeof props.callId === 'string' ? props.callId : ''
      const phase = props && typeof props.phase === 'string' ? props.phase : 'start'
      const [state, setState] = useState({ loading: true, value: null, error: null })
      const cardRef = React.useRef(null)
      // At most one diagnostic per mounted card, across phase advances and retries (C6).
      const reportState = React.useRef({ callId: '', reported: false })

      useEffect(() => {
        if (!callId) return undefined
        if (!reportState.current || reportState.current.callId !== callId) {
          reportState.current = { callId, reported: false }
        }
        let alive = true
        let retryTimer = null
        let retried = false

        const note = (kind, payload) => {
          if (reportState.current.reported) return
          reportState.current.reported = true
          report(Object.assign({ kind, callId, phase }, payload || {}))
        }

        const load = async () => {
          setState((current) => ({ ...current, loading: current.value === null }))
          const result = await loadResult(callId)
          if (!alive) return
          if (result.value !== null && result.value !== undefined) {
            setState({ loading: false, value: result.value, error: null })
            return
          }
          // A 404 (`result is no longer cached`) is the normal TTL/eviction path, so it is
          // reported as expired rather than as a card error, and only once per mount.
          if (result.status === 404) {
            note('card-result-expired', { status: 404, message: truncateText(result.error, 400) })
          } else {
            note('card-fetch-error', {
              status: typeof result.status === 'number' ? result.status : 0,
              message: truncateText(result.error, 400),
            })
          }
          setState((current) => ({
            ...current,
            loading: false,
            error: result.error ? truncateText(result.error, 500) : null,
          }))
          if (!retried) {
            retried = true
            retryTimer = setTimeout(() => {
              if (alive) load()
            }, 1500)
          }
        }

        load()
        return () => {
          alive = false
          if (retryTimer) clearTimeout(retryTimer)
        }
      }, [callId, phase])

      if (state.loading) {
        return h(React.Fragment, null, withStyles([
          h(
            'div',
            { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef },
            h('div', { className: 'dsd-hint' }, t('card.running')),
          ),
        ]))
      }

      const value = state.value
      if (!value || !isPlainObject(value)) {
        const tail = callTail(callId)
        return h(React.Fragment, null, withStyles([
          h('div', { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef }, [
            h('div', { className: 'dsd-hint', key: 'a' }, `${t('card.noData')} · ${t('card.call', { tail })}`),
            state.error
              ? h(
                  'div',
                  { className: 'dsd-error', key: 'b', role: 'alert' },
                  truncateText(localizedCardError(state.error, t), 500),
                )
              : null,
            !state.error && value ? h('div', { className: 'dsd-hint', key: 'c' }, truncateJson(value)) : null,
          ]),
        ]))
      }

      const normalized = normalizeAnswers(value.answers)
      const answers = normalized.answers
      const questions = Object.entries(answers).map(([id, answer]) => {
        const blocks = [h('div', { className: 'dsd-q-title', key: 'title' }, id)]
        if (!isPlainObject(answer)) {
          blocks.push(h('div', { className: 'dsd-hint', key: 'raw' }, truncateJson(answer)))
          return h('div', { className: 'dsd-q', key: id }, blocks)
        }
        if (answer.error) {
          blocks.push(
            h(
              'div',
              { className: 'dsd-error', key: 'err', role: 'alert' },
              `${truncateText(answer.error, 300)}${answer.message ? ` — ${truncateText(answer.message, 300)}` : ''}`,
            ),
          )
          return h('div', { className: 'dsd-q', key: id }, blocks)
        }
        if (answer.type === 'choice') {
          const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : {}
          const entries = Object.entries(probabilities).sort((a, b) => (b[1] || 0) - (a[1] || 0))
          blocks.push(
            h(
              'div',
              { className: 'dsd-wrap', key: 'bars' },
              entries.map(([option, probability]) =>
                h('div', { className: 'dsd-bar', key: option }, [
                  h('span', { className: 'dsd-bar-label', key: 'l', title: option }, option),
                  h(
                    'span',
                    { className: 'dsd-bar-track', key: 't' },
                    h('span', {
                      className: `dsd-bar-fill${option === answer.choice ? ' dsd-bar-fill-chosen' : ''}`,
                      style: { width: `${safePercent(probability)}%` },
                    }),
                  ),
                  h('span', { className: 'dsd-bar-value', key: 'v' }, formatPercent(probability)),
                ]),
              ),
            ),
          )
          blocks.push(
            h('div', { className: 'dsd-hint', key: 'conf' }, `confidence ${formatNumber(answer.confidence, 3)}`),
          )
        } else if (answer.type === 'noul') {
          blocks.push(
            h('div', { className: 'dsd-bar', key: 'bar' }, [
              h('span', { className: 'dsd-bar-label', key: 'l' }, t('card.yes')),
              h(
                'span',
                { className: 'dsd-bar-track', key: 't' },
                h('span', {
                  className: 'dsd-bar-fill dsd-bar-fill-chosen',
                  style: { width: `${safePercent(answer.noul)}%` },
                }),
              ),
              h('span', { className: 'dsd-bar-value', key: 'v' }, formatPercent(answer.noul)),
            ]),
          )
        } else if (answer.type === 'score') {
          const legend = isPlainObject(answer.legend) ? answer.legend : {}
          const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : {}
          blocks.push(
            h(
              'div',
              { className: 'dsd-wrap', key: 'bars' },
              Object.entries(probabilities).map(([level, probability]) =>
                h('div', { className: 'dsd-bar', key: level }, [
                  h('span', { className: 'dsd-bar-label', key: 'l' }, legend[level] || `level ${level}`),
                  h(
                    'span',
                    { className: 'dsd-bar-track', key: 't' },
                    h('span', {
                      className: 'dsd-bar-fill',
                      style: { width: `${safePercent(probability)}%` },
                    }),
                  ),
                  h('span', { className: 'dsd-bar-value', key: 'v' }, formatPercent(probability)),
                ]),
              ),
            ),
          )
          blocks.push(
            h(
              'div',
              { className: 'dsd-hint', key: 'conf' },
              `score ${formatNumber(answer.score)} · confidence ${formatNumber(answer.confidence, 3)}`,
            ),
          )
        } else if (answer.type === 'box') {
          const box = isPlainObject(answer.box) ? answer.box : {}
          const low = answer.lowConfidence === true || (typeof answer.confidence === 'number' && answer.confidence < 0.5)
          blocks.push(
            h(
              'div',
              { className: low ? 'dsd-error' : 'dsd-hint', key: 'box' },
              `top ${formatPercent(box.top)} · left ${formatPercent(box.left)} · bottom ${formatPercent(
                box.bottom,
              )} · right ${formatPercent(box.right)} · confidence ${formatNumber(answer.confidence, 3)}${
                low ? ` (${t('card.lowConfidence')})` : ''
              }`,
            ),
          )
        } else {
          blocks.push(h('div', { className: 'dsd-hint', key: 'raw' }, truncateJson(answer)))
        }
        // Host flags a flat distribution; surface it for every question type, not just box.
        if (answer.lowConfidence === true && answer.type !== 'box') {
          blocks.push(h('div', { className: 'dsd-error', key: 'low' }, `⚠ ${t('card.lowConfidence')}`))
        }
        return h('div', { className: 'dsd-q', key: id }, blocks)
      })

      const body =
        normalized.ordered && questions.length > 0
          ? [h('div', { className: 'dsd-hint', key: 'ordered' }, t('card.answersArrayHint'))].concat(questions)
          : questions
      if (questions.length === 0) body.push(h('div', { className: 'dsd-hint', key: 'none' }, t('card.noData')))

      return h(React.Fragment, null, withStyles([
        h('div', { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef }, [
          h('div', { className: 'dsd-row', key: 'head' }, [
            h('span', { className: 'dsd-q-title', key: 't' }, t('card.title')),
            h('span', { className: 'dsd-hint dsd-mono', key: 'm' }, typeof value.model === 'string' ? value.model : ''),
            typeof value.usage === 'object' && value.usage && typeof value.usage.input_tokens === 'number'
              ? h('span', { className: 'dsd-hint', key: 'u' }, t('card.tokens', { count: value.usage.input_tokens }))
              : null,
          ]),
          h('div', { className: 'dsd-card', key: 'body' }, body),
        ]),
      ]))
    }

    function SettingsSection(props) {
      const t = translatorOf(props)
      return h(
        SettingsBoundary,
        { dsdTranslate: t },
        h(DecisionSettings, Object.assign({}, props, { dsdTranslate: t })),
      )
    }

    return {
      inject: ['slots', 'locale'],
      // The DSH loader ignores unknown fields; the smoke test reads these to keep the
      // packaged locale/*.json in lockstep with the dictionaries above.
      locales: { zh: DICT_ZH, en: DICT_EN },
      // Test seam for scripts/smoke-client.mjs only.
      __internals: {
        isPlainObject,
        normalizeModels,
        normalizeQuotaModels,
        normalizeAnswers,
        normalizeUsageToday,
        truncateJson,
        safePercent,
      },
      apply(ctx) {
        const t = makeTranslator(ctx)

        // One <style> node for the whole plugin, cleaned up when the plugin unloads (C10).
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(() => {
            ensureStyles()
            return () => removeStyles()
          })
        }

        const withTranslator = (Component) => (props) =>
          h(Component, Object.assign({}, props, { dsdTranslate: t }))

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-decision',
              order: 60,
              label: () => t('settings.title'),
            },
            withTranslator(SettingsSection),
          ),
        )

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'decision_ask' },
            // The boundary keeps a rendering failure visible and reported instead of blanking the row.
            (props) =>
              h(
                CardBoundary,
                { callId: props && props.callId, dsdTranslate: t },
                h(DecisionCard, Object.assign({}, props, { dsdTranslate: t })),
              ),
          ),
        )
      },
    }
  },
})
