/**
 * Client smoke test: execute every component the Client half registers, using a
 * minimal React stub. `node --check` validates syntax only, so a runtime
 * ReferenceError (a variable missing from a dependency array, a typo in a hook
 * call) would otherwise surface only in the UI. Here it fails the build.
 */
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

const registrations = []
const ctx = {
  locale: {
    register() {},
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
  try {
    render(component(sampleProps))
  } catch (error) {
    throw new Error(`client smoke failed for ${options.name} (${options.key || options.id}): ${error.message}`)
  }
}

console.log(`client smoke ok (${registrations.length} registrations)`)
