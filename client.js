/**
 * @local/dsh-decision — Client half.
 *
 * Registers two slots:
 *   settings.section     — the Decision settings page (key, default model, quota)
 *   tool.call.toolview   — the decision_ask card (probability bars, box values)
 *
 * Data comes from the Host half's same-origin routes under /dsh-decision/*; the
 * API key never reaches the browser.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-decision',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

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
      'settings.usage': '今日用量',
      'settings.usageRequests': '请求',
      'settings.usageTokens': 'tokens',
      'settings.usageNone': '尚未配置 Key，无法查询用量。',
      'settings.models': '模型',
      'settings.modelName': '模型',
      'settings.modelSize': '规模',
      'settings.modelBox': '定位框',
      'settings.modelReady': '可用',
      'settings.refresh': '刷新',
      'settings.loading': '加载中...',
      'settings.errorPrefix': '请求失败：',
      'card.running': '正在询问决策模型...',
      'card.title': '决策',
      'card.noData': '详细结果不可用，请查看上方工具输出。',
      'card.lowConfidence': '低置信',
      'card.yes': '是',
      'card.no': '否',
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
      'settings.usage': 'Today',
      'settings.usageRequests': 'requests',
      'settings.usageTokens': 'tokens',
      'settings.usageNone': 'No key configured, so usage is unavailable.',
      'settings.models': 'Models',
      'settings.modelName': 'Model',
      'settings.modelSize': 'Size',
      'settings.modelBox': 'Box',
      'settings.modelReady': 'Ready',
      'settings.refresh': 'Refresh',
      'settings.loading': 'Loading...',
      'settings.errorPrefix': 'Request failed: ',
      'card.running': 'Asking decision model...',
      'card.title': 'Decision',
      'card.noData': 'Detailed result is unavailable; see the tool output above.',
      'card.lowConfidence': 'low confidence',
      'card.yes': 'yes',
      'card.no': 'no',
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

    function makeTranslator(ctx) {
      let bound = null
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register('dsh-decision', { zh: DICT_ZH, en: DICT_EN })
        }
      } catch (error) {
        // The dictionary below still renders.
      }
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') bound = ctx.locale.bind('dsh-decision')
      } catch (error) {
        bound = null
      }
      return (key) => {
        try {
          if (bound) {
            const value = bound(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) return value
          }
        } catch (error) {
          // fall through
        }
        return DICT_ZH[key] || DICT_EN[key] || key
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

    /** Keeps a crashing card renderable: the failure text stays on screen instead of blanking the row. */
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
          message: error && error.message ? error.message : String(error),
          phase: info && info.componentStack ? String(info.componentStack).slice(0, 200) : '',
        })
      }
      render() {
        if (this.state.error) {
          const message = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error)
          return h(React.Fragment, null, [
            h('style', { key: 'style' }, STYLES),
            h('div', { className: 'dsd', key: 'card' }, [
              h('div', { className: 'dsd-error', key: 'e' }, `决策卡片渲染失败：${message}`),
            ]),
          ])
        }
        return this.props.children
      }
    }

    const STATUS_CACHE_KEY = 'dsh-decision.status.v1'

    function readStatusCache() {
      try {
        const raw = localStorage.getItem(STATUS_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.at !== 'number' || !parsed.data || typeof parsed.data !== 'object') return null
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

    function formatClock(ts) {
      try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch (error) {
        return ''
      }
    }

    function statusFreshness(status) {
      if (!status || !status.data) return ''
      const at = status.data.cachedAt || status.staleAt
      if (status.loading) return at ? `正在刷新… 当前显示 ${formatClock(at)} 的数据` : '正在刷新…'
      if (status.data.cached) return `缓存数据（Host 端 20 秒内复用，${formatClock(at)}）`
      return at ? `已更新（${formatClock(at)}）` : ''
    }

    /** Stale-while-revalidate: paint the cached payload immediately, then replace it when the fetch lands. */
    function useJsonStatus() {
      const [state, setState] = useState(() => {
        const cached = readStatusCache()
        return { loading: true, error: null, data: cached ? cached.data : null, staleAt: cached ? cached.at : null }
      })

      const apply = useCallback((data) => {
        if (!data || typeof data !== 'object') return
        writeStatusCache(data)
        setState({ loading: false, error: null, data, staleAt: Date.now() })
      }, [])

      const load = useCallback(
        async (options) => {
          const refresh = Boolean(options && options.refresh)
          const controller = typeof AbortController === 'function' ? new AbortController() : null
          const timer = setTimeout(() => {
            if (controller) controller.abort()
          }, 15000)
          setState((current) => ({ ...current, loading: true, error: null }))
          try {
            const res = await fetch(`/dsh-decision/status${refresh ? '?refresh=1' : ''}`, {
              headers: { accept: 'application/json' },
              signal: controller ? controller.signal : undefined,
            })
            const json = await res.json().catch(() => null)
            if (!res.ok) throw httpError(res, json, '/dsh-decision/status')
            writeStatusCache(json)
            setState({ loading: false, error: null, data: json, staleAt: Date.now() })
          } catch (error) {
            // Never drop what is already on screen: show the error next to the cached value.
            const aborted = error && error.name === 'AbortError'
            const message = aborted
              ? '请求超时（15 秒）'
              : error && error.message
                ? error.message
                : String(error)
            setState((current) => ({ ...current, loading: false, error: message }))
          } finally {
            clearTimeout(timer)
          }
        },
        [],
      )

      useEffect(() => {
        load({ refresh: false })
      }, [load])

      return [state, load, apply]
    }

    const USAGE_CACHE_KEY = 'dsh-decision.usage.v1'

    function readUsageCache() {
      try {
        const raw = localStorage.getItem(USAGE_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed.at !== 'number' || !parsed.data) return null
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

    /** Usage lives on its own route and its own cache: slow endpoint, small payload, optional data. */
    function useUsage() {
      const [state, setState] = useState(() => {
        const cached = readUsageCache()
        return { loading: true, error: null, data: cached ? cached.data : null, staleAt: cached ? cached.at : null }
      })

      const apply = useCallback((data) => {
        if (!data || typeof data !== 'object') return
        writeUsageCache(data)
        setState({ loading: false, error: null, data, staleAt: Date.now() })
      }, [])

      const load = useCallback(async (options) => {
        const refresh = Boolean(options && options.refresh)
        const controller = typeof AbortController === 'function' ? new AbortController() : null
        const timer = setTimeout(() => {
          if (controller) controller.abort()
        }, 12000)
        setState((current) => ({ ...current, loading: true, error: null }))
        try {
          const res = await fetch(`/dsh-decision/usage${refresh ? '?refresh=1' : ''}`, {
            headers: { accept: 'application/json' },
            signal: controller ? controller.signal : undefined,
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw httpError(res, json, '/dsh-decision/usage')
          writeUsageCache(json)
          setState({ loading: false, error: null, data: json, staleAt: Date.now() })
        } catch (error) {
          const aborted = error && error.name === 'AbortError'
          const message = aborted ? '用量查询超时' : error && error.message ? error.message : String(error)
          // Keep the previous numbers on screen; just note that the refresh failed.
          setState((current) => ({ ...current, loading: false, error: message }))
        } finally {
          clearTimeout(timer)
        }
      }, [])

      useEffect(() => {
        load({ refresh: false })
      }, [load])

      return [state, load, apply]
    }

    function DecisionSettings(props) {
      const t = (props && props.dsdTranslate) || ((key) => DICT_ZH[key] || key)
      const [status, reload, applyStatus] = useJsonStatus()
      const [usage, reloadUsage, applyUsage] = useUsage()
      const [keyInput, setKeyInput] = useState('')
      const [model, setModel] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [failure, setFailure] = useState(null)

      const data = status.data
      useEffect(() => {
        if (data && typeof data.model === 'string' && data.model && model === '') setModel(data.model)
      }, [data, model])

      const save = useCallback(async () => {
        setBusy(true)
        setMessage(null)
        setFailure(null)
        try {
          const body = {}
          if (keyInput.trim()) body.apiKey = keyInput.trim()
          if (model) body.model = model
          const res = await fetch('/dsh-decision/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(body),
          })
          const json = await res.json().catch(() => null)
          if (!res.ok) throw httpError(res, json, '/dsh-decision/config')
          setKeyInput('')
          setMessage(t('settings.saved'))
          if (json) {
            applyStatus(json)
            // The config response carries the freshly fetched usage alongside the status.
            applyUsage({
              keyConfigured: json.keyConfigured,
              usage: json.usage || null,
              ...(json.usageError ? { usageError: json.usageError } : {}),
            })
          } else {
            await reload({ refresh: true })
            await reloadUsage({ refresh: true })
          }
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }, [keyInput, model, reload, reloadUsage, applyStatus, applyUsage, t])

      const requestSave = useCallback(() => {
        if (busy) return
        save()
      }, [busy, save])

      const models = data && Array.isArray(data.models) ? data.models : []
      const usageData = usage.data
      const usageToday =
        usageData && usageData.usage && usageData.usage.self && usageData.usage.self.usage_today
          ? usageData.usage.self.usage_today
          : null
      const quotaModels =
        usageData &&
        usageData.usage &&
        usageData.usage.daily &&
        usageData.usage.daily.quota &&
        Array.isArray(usageData.usage.daily.quota.models)
          ? usageData.usage.daily.quota.models
          : []
      const usageError = (usageData && usageData.usageError) || usage.error || null
      const configured = Boolean(data && data.keyConfigured)

      const children = [h('style', { key: 'style' }, STYLES)]
      children.push(
        h('div', { className: 'dsd', key: 'root' }, [
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
                data && data.keyPrefix ? data.keyPrefix : '',
              ),
            ]),
            h('div', { className: 'dsd-row', key: 'k2' }, [
              h('input', {
                className: 'dsd-input',
                type: 'password',
                spellCheck: false,
                autoComplete: 'off',
                placeholder: t('settings.apiKeyPlaceholder'),
                value: keyInput,
                onChange: (event) => setKeyInput(event.target.value),
                key: 'input',
              }),
              h(
                'button',
                {
                  className: 'dsd-button',
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
              h('span', { className: 'dsd-label', key: 'l' }, t('settings.model')),
              models.length > 0
                ? h(
                    'select',
                    {
                      className: 'dsd-select',
                      value: model,
                      onChange: (event) => setModel(event.target.value),
                      key: 'sel',
                    },
                    models.map((entry) =>
                      h('option', { value: entry.id, key: entry.id }, `${entry.id} · ${entry.size || ''}`.trim()),
                    ),
                  )
                : h('span', { className: 'dsd-hint', key: 'm' }, data ? data.model : t('settings.loading')),
              h(
                'button',
                {
                  className: 'dsd-button dsd-button-primary',
                  onClick: requestSave,
                  disabled: busy || (!keyInput.trim() && !model),
                  key: 'save',
                },
                busy ? t('settings.saving') : t('settings.save'),
              ),
            ]),
            message ? h('div', { className: 'dsd-hint', key: 'ok' }, message) : null,
            failure ? h('div', { className: 'dsd-error', key: 'err' }, `${t('settings.errorPrefix')}${failure}`) : null,
            status.error
              ? h('div', { className: 'dsd-error', key: 'serr' }, `${t('settings.errorPrefix')}${status.error}`)
              : null,
            h('div', { className: 'dsd-hint', key: 'fresh' }, statusFreshness(status)),
          ]),

          h('div', { className: 'dsd-card', key: 'usage' }, [
            h('div', { className: 'dsd-row', key: 'u1' }, [
              h('span', { className: 'dsd-label', key: 'l' }, t('settings.usage')),
              h(
                'span',
                { className: 'dsd-hint', key: 'v' },
                configured
                  ? `${usageToday ? usageToday.requests || 0 : 0} ${t('settings.usageRequests')} · ${
                      usageToday ? usageToday.input_tokens || 0 : 0
                    } ${t('settings.usageTokens')}`
                  : t('settings.usageNone'),
              ),
            ]),
            usageError ? h('div', { className: 'dsd-error', key: 'uerr' }, usageError) : null,
            quotaModels.length > 0
              ? h(
                  'div',
                  { className: 'dsd-wrap', key: 'q' },
                  quotaModels.map((entry) => {
                    const used = typeof entry.requests_today === 'number' ? entry.requests_today : 0
                    const left = typeof entry.requests_left === 'number' ? entry.requests_left : null
                    return h('div', { className: 'dsd-bar', key: entry.id }, [
                      h('span', { className: 'dsd-bar-label', key: 'l', title: entry.id }, entry.id),
                      h(
                        'span',
                        { className: 'dsd-bar-track', key: 't' },
                        h('span', {
                          className: 'dsd-bar-fill',
                          style: {
                            width: `${left !== null && used + left > 0 ? Math.min(100, (used / (used + left)) * 100) : 0}%`,
                          },
                        }),
                      ),
                      h('span', { className: 'dsd-bar-value', key: 'v' }, `${used}`),
                    ])
                  }),
                )
              : null,
          ]),

          h('div', { className: 'dsd-card', key: 'models' }, [
            h('div', { className: 'dsd-row', key: 'h' }, [
              h('span', { className: 'dsd-label', key: 'l' }, t('settings.models')),
              h('span', { className: 'dsd-hint', key: 'c' }, `${models.length}`),
            ]),
            models.length > 0
              ? h(
                  'table',
                  { className: 'dsd-table', key: 'table' },
                  h('thead', { key: 'thead' }, h('tr', null, [
                    h('th', { key: 'n' }, t('settings.modelName')),
                    h('th', { key: 's' }, t('settings.modelSize')),
                    h('th', { key: 'b' }, t('settings.modelBox')),
                    h('th', { key: 'r' }, t('settings.modelReady')),
                  ])),
                  h(
                    'tbody',
                    { key: 'tbody' },
                    models.map((entry) =>
                      h('tr', { key: entry.id }, [
                        h('td', { className: 'dsd-mono', key: 'n' }, entry.id),
                        h('td', { key: 's' }, entry.size || ''),
                        h('td', { key: 'b' }, entry.box ? '✓' : '—'),
                        h('td', { key: 'r' }, entry.ready ? '✓' : '—'),
                      ]),
                    ),
                  ),
                )
              : h('div', { className: 'dsd-hint', key: 'none' }, status.loading ? t('settings.loading') : '—'),
          ]),
        ]),
      )

      return h(React.Fragment, null, children)
    }

    function DecisionCard(props) {
      const t = props.dsdTranslate
      const callId = props && typeof props.callId === 'string' ? props.callId : ''
      const [state, setState] = useState({ loading: true, value: null, error: null })
      const cardRef = React.useRef(null)

      // The card reports only failures to the Host; a healthy render stays silent.
      useEffect(() => {
        if (!callId) return undefined
        let alive = true
        setState((current) => ({ ...current, loading: true }))
        ;(async () => {
          try {
            const res = await fetch(`/dsh-decision/result?callId=${encodeURIComponent(callId)}`, {
              headers: { accept: 'application/json' },
            })
            const json = await res.json().catch(() => null)
            if (!alive) return
            if (!res.ok || !json || !json.value) {
              report({
                kind: 'card-no-result',
                callId,
                status: res.status,
                message: (json && json.error) || '',
              })
              setState({ loading: false, value: null, error: (json && json.error) || null })
              return
            }
            setState({ loading: false, value: json.value, error: null })
          } catch (error) {
            if (!alive) return
            report({
              kind: 'card-fetch-error',
              callId,
              message: error && error.message ? error.message : String(error),
            })
            setState({ loading: false, value: null, error: error && error.message ? error.message : String(error) })
          }
        })()
        return () => {
          alive = false
        }
      }, [callId])

      if (state.loading) {
        return h(React.Fragment, null, [
          h('style', { key: 'style' }, STYLES),
          h('div', { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef }, h('div', { className: 'dsd-hint' }, t('card.running'))),
        ])
      }

      const value = state.value
      if (!value) {
        const tail = callId ? callId.slice(-8) : '—'
        return h(React.Fragment, null, [
          h('style', { key: 'style' }, STYLES),
          h('div', { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef }, [
            h('div', { className: 'dsd-hint', key: 'a' }, `${t('card.noData')} · call ${tail}`),
            state.error ? h('div', { className: 'dsd-error', key: 'b' }, state.error) : null,
          ]),
        ])
      }

      const answers = value.answers && typeof value.answers === 'object' ? value.answers : {}
      const questions = Object.entries(answers).map(([id, answer]) => {
        const blocks = [h('div', { className: 'dsd-q-title', key: 'title' }, id)]
        if (!answer || typeof answer !== 'object') {
          blocks.push(h('div', { className: 'dsd-hint', key: 'raw' }, JSON.stringify(answer)))
          return h('div', { className: 'dsd-q', key: id }, blocks)
        }
        if (answer.error) {
          blocks.push(
            h('div', { className: 'dsd-error', key: 'err' }, `${answer.error}${answer.message ? ` — ${answer.message}` : ''}`),
          )
          return h('div', { className: 'dsd-q', key: id }, blocks)
        }
        if (answer.type === 'choice') {
          const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
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
          const legend = answer.legend && typeof answer.legend === 'object' ? answer.legend : {}
          const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
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
          const box = answer.box && typeof answer.box === 'object' ? answer.box : {}
          const low = typeof answer.confidence === 'number' && answer.confidence < 0.5
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
          blocks.push(h('div', { className: 'dsd-hint', key: 'raw' }, JSON.stringify(answer)))
        }
        return h('div', { className: 'dsd-q', key: id }, blocks)
      })

      return h(React.Fragment, null, [
        h('style', { key: 'style' }, STYLES),
        h('div', { className: 'dsd dsd-toolcard', key: 'card', ref: cardRef }, [
          h('div', { className: 'dsd-row', key: 'head' }, [
            h('span', { className: 'dsd-q-title', key: 't' }, t('card.title')),
            h('span', { className: 'dsd-hint dsd-mono', key: 'm' }, value.model || ''),
            typeof value.usage === 'object' && value.usage && typeof value.usage.input_tokens === 'number'
              ? h('span', { className: 'dsd-hint', key: 'u' }, `${value.usage.input_tokens} tokens`)
              : null,
          ]),
          h('div', { className: 'dsd-card', key: 'body' }, questions.length > 0 ? questions : [h('div', { className: 'dsd-hint', key: 'none' }, t('card.noData'))]),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = makeTranslator(ctx)
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
            withTranslator(DecisionSettings),
          ),
        )

        ctx.slots.inject('tool.call.toolview', () =>
          ctx.slots.register(
            { name: 'tool.call.toolview', key: 'decision_ask' },
            // The boundary keeps a rendering failure visible and reported instead of blanking the row.
            (props) =>
              h(
                CardBoundary,
                { callId: props && props.callId },
                h(DecisionCard, Object.assign({}, props, { dsdTranslate: t })),
              ),
          ),
        )
      },
    }
  },
})
