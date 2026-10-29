/**
 * Client smoke test: execute every component the Client half registers, using a
 * minimal React stub. `node --check` validates syntax only, so a runtime
 * ReferenceError (a variable missing from a dependency array, a typo in a hook
 * call) would otherwise surface only in the UI. Here it fails the build.
 *
 * It also pins two contracts that used to rot silently:
 *   - `locale/zh.json` / `locale/en.json` are flat and carry exactly the same key
 *     set as the dictionaries inside client.js (`cardRunning` vs `card.running`);
 *     the single exception is `meta`, which dsh-app-boot's readPluginMeta reads for
 *     the Plugins page title and description,
 *   - untrusted upstream shapes (null models, string quotas, array answers, huge or
 *     circular JSON) go through the normalizers without throwing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const React = (() => {
  class Component {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
    }
  }
  Component.prototype.isReactComponent = true

  function createElement(type, props, ...children) {
    const merged = { ...(props || {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  }

  return {
    Component,
    Fragment: 'Fragment',
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value === undefined ? null : value }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
})()

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fail(prefix, detail) {
  throw new Error(`${prefix}: ${detail}`)
}

// ---------------------------------------------------------------------------
// fake host context: effect() + a locale runtime that hands back a disposer
// ---------------------------------------------------------------------------

const registrations = []
const disposers = []
const localeRegistrations = []
const localeState = { disposed: false }

const ctx = {
  effect(callback) {
    const dispose = callback()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries })
      return () => {
        localeState.disposed = true
      }
    },
    bind: () => (key) => key,
  },
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
}

globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      globalThis.__clientDefinition = definition
    },
  },
}
globalThis.fetch = () => Promise.reject(new Error('network disabled in smoke test'))

await import('../client.js')

const definition = globalThis.__clientDefinition
if (!definition) throw new Error('client.js did not call window.__ModuleLoader__.load')
if (typeof definition.factory !== 'function') throw new Error('client.js definition has no factory')

const module = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
})
if (typeof module.apply !== 'function') throw new Error('client.js module has no apply()')

module.apply(ctx)

// ---------------------------------------------------------------------------
// locale contract: DICT_ZH === DICT_EN === locale/*.json, all flat, all strings
// ---------------------------------------------------------------------------

const dictionaries = module.locales
assert(dictionaries && dictionaries.zh && dictionaries.en, 'client.js module must expose locales: { zh, en }')

const zhKeys = Object.keys(dictionaries.zh).sort()
const enKeys = Object.keys(dictionaries.en).sort()
assert(zhKeys.length > 0, 'DICT_ZH is empty')
assert(
  zhKeys.join('\n') === enKeys.join('\n'),
  `DICT_ZH and DICT_EN key sets differ: only-zh=${zhKeys.filter((k) => !enKeys.includes(k))} only-en=${enKeys.filter((k) => !zhKeys.includes(k))}`,
)
for (const key of zhKeys) {
  assert(typeof dictionaries.zh[key] === 'string' && dictionaries.zh[key].length > 0, `DICT_ZH[${key}] is not a non-empty string`)
  assert(typeof dictionaries.en[key] === 'string' && dictionaries.en[key].length > 0, `DICT_EN[${key}] is not a non-empty string`)
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

for (const file of ['zh.json', 'en.json']) {
  const parsed = JSON.parse(readFileSync(join(root, 'locale', file), 'utf8'))
  assert(isPlainObject(parsed), `locale/${file} must be a JSON object`)
  // `meta.title` / `meta.description` are read by dsh-app-boot's readPluginMeta for the
  // Plugins page; that block is the only key allowed to differ from the flat DICT.
  const meta = parsed.meta
  assert(
    isPlainObject(meta) && typeof meta.title === 'string' && meta.title.trim() !== '' && typeof meta.description === 'string' && meta.description.trim() !== '',
    `locale/${file} must carry non-empty meta.title and meta.description (Plugins page display text)`,
  )
  const entries = Object.entries(parsed).filter(([key]) => key !== 'meta')
  for (const [key, value] of entries) {
    assert(typeof value === 'string' && value.length > 0, `locale/${file}["${key}"] is not a non-empty string`)
  }
  const fileKeys = entries.map(([key]) => key).sort()
  assert(
    fileKeys.join('\n') === zhKeys.join('\n'),
    `locale/${file} key set drifted from the DICT: only-file=${fileKeys.filter((k) => !zhKeys.includes(k))} only-dict=${zhKeys.filter((k) => !fileKeys.includes(k))}`,
  )
}

assert(localeRegistrations.length === 1, `expected one locale registration, got ${localeRegistrations.length}`)
assert(localeRegistrations[0].namespace === 'dsh-decision', 'locale namespace must be dsh-decision')
assert(
  Object.keys(localeRegistrations[0].dictionaries.zh).sort().join('\n') === zhKeys.join('\n'),
  'registered zh dictionary is not DICT_ZH',
)

// ---------------------------------------------------------------------------
// shape robustness: malformed upstream payloads must be survivable
// ---------------------------------------------------------------------------

const internals = module.__internals
assert(internals, 'client.js exposes no __internals test seam')

const models = internals.normalizeModels([
  null,
  'd3-turbo',
  {},
  { id: 42 },
  { id: '' },
  { id: 'd3-flash', size: 7, box: 'yes', ready: 1 },
  { id: 'd3-ultra', size: '131k', box: true, ready: true },
])
assert(models.length === 2, `normalizeModels kept ${models.length} of 7 malformed entries (expected 2)`)
assert(models[0].id === 'd3-flash' && models[0].size === '7' && models[0].box === false && models[0].ready === false, 'normalizeModels type fallbacks failed')
assert(models[1].id === 'd3-ultra' && models[1].box === true && models[1].ready === true, 'normalizeModels dropped a valid entry')
assert(Array.isArray(internals.normalizeModels(null)) && internals.normalizeModels({}).length === 0, 'normalizeModels must accept non-arrays')

const quota = internals.normalizeQuotaModels({
  usage: { daily: { quota: { models: [null, 'x', { requests_today: '7' }, { id: 'm', requests_today: 7, requests_left: 3 }] } } },
})
assert(quota.length === 2, `normalizeQuotaModels kept ${quota.length} of 4 malformed entries (expected 2)`)
assert(quota[0].id === '#1' && quota[0].used === null && quota[0].left === null, 'quota entry without id/numbers must fall back')
assert(quota[1].used === 7 && quota[1].left === 3, 'quota numbers were not read')
assert(internals.normalizeQuotaModels(null).length === 0, 'normalizeQuotaModels must accept null')

const orderedAnswers = internals.normalizeAnswers([{ type: 'noul' }, { type: 'box' }])
assert(orderedAnswers.ordered === true && Object.keys(orderedAnswers.answers).join(',') === '#1,#2', 'array answers must be keyed by order')
const keyedAnswers = internals.normalizeAnswers({ technical: { type: 'choice' } })
assert(keyedAnswers.ordered === false && Object.keys(keyedAnswers.answers).join(',') === 'technical', 'object answers must keep their ids')
assert(Object.keys(internals.normalizeAnswers(null).answers).length === 0, 'normalizeAnswers(null) must be empty')

assert(internals.normalizeUsageToday({ usage: { self: { usage_today: { requests: 7, input_tokens: 1234 } } } }).requests === 7, 'usage numbers were not read')
assert(internals.normalizeUsageToday({ usage: { self: { usage_today: { requests: '7' } } } }) === null, 'string usage numbers must not be trusted')
assert(internals.normalizeUsageToday(null) === null, 'normalizeUsageToday must accept null')

const longJson = internals.truncateJson({ blob: 'x'.repeat(2000) }, 500)
assert(longJson.endsWith('…') && longJson.length === 501, `truncateJson did not clamp to 500 chars (len=${longJson.length})`)
const circular = {}
circular.self = circular
assert(typeof internals.truncateJson(circular, 100) === 'string', 'truncateJson must survive a circular value')
assert(internals.safePercent('0.5') === 0 && internals.safePercent(NaN) === 0, 'safePercent must reject non-numbers')
assert(internals.safePercent(1.5) === 100 && internals.safePercent(-1) === 0, 'safePercent must clamp to 0..100')

// ---------------------------------------------------------------------------
// render every registered slot: with and without the translator prop (C7)
// ---------------------------------------------------------------------------

/** Depth-first render: class components through render(), function components by call. */
function render(node) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) render(child)
    return
  }
  const { type, props } = node
  const children = props ? props.children : undefined
  if (type === React.Fragment) {
    if (children !== undefined) for (const child of [].concat(children)) render(child)
    return
  }
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      render(new type(props).render())
    } else {
      render(type(props))
    }
    return
  }
  if (children !== undefined) for (const child of [].concat(children)) render(child)
}

const sampleProps = {
  callId: 'call_smoke',
  phase: 'result',
  dsdTranslate: (key) => key,
  close() {},
}

if (registrations.length === 0) throw new Error('client.js registered no slots')
for (const { options, component } of registrations) {
  const label = `${options.name} (${options.key || options.id || '?'})`
  for (const [variant, props] of [
    ['with translator', sampleProps],
    ['without translator', { callId: 'call_smoke', phase: 'start' }],
  ]) {
    try {
      render(component(props))
    } catch (error) {
      fail(`client smoke failed for ${label} ${variant}`, error.message)
    }
  }
}

// Disposing must not throw, and the locale registration must actually be released
// (P2-13: register() returns its own disposer, handed to ctx.effect).
for (const dispose of disposers) {
  try {
    dispose()
  } catch (error) {
    fail('client smoke failed while disposing', error.message)
  }
}
assert(localeState.disposed, 'locale.register disposer was never called: ctx.effect must own it')

console.log(
  `client smoke ok (${registrations.length} registrations, ${zhKeys.length} locale keys, ${disposers.length} disposers)`,
)
