/**
 * scripts/smoke-regressions.mjs — Host 回归 harness（修复契约验收）
 *
 * 用法：
 *   node scripts/smoke-regressions.mjs            # 跑全部用例，输出 PASS/FAIL 与汇总
 *   node scripts/smoke-regressions.mjs --only=P1-1 # 只跑 id 含该子串的用例（调试用）
 *   node scripts/smoke-regressions.mjs --keep     # 保留临时 DSH_HOME（默认跑完删除）
 *
 * 设计：
 *   - 不联网、不消耗 Decision 额度：全局替换 globalThis.fetch 为可编程 stub，并逐个记录调用；
 *   - 不碰用户目录：每个用例一个独立临时 DSH_HOME（默认 $TMP/dsh-decision-smoke-<pid>/<case>），
 *     在 import index.js 之前设置 process.env.DSH_HOME（模块顶层会把它解析成常量）；
 *   - 每个用例重新 import（带 query 破坏 ESM 缓存），避免 infoCache / settingsCache /
 *     resultCache / statusCache 等模块级状态在用例间互相污染；
 *   - 伪造 ctx.tools.register 捕获 ToolDefinition、伪造 ctx.get('webServer') + ctx.inject
 *     捕获 webServer.register 的路由 handler、伪造 req/res 驱动 HTTP；
 *   - 断言目标 = REPORT.md §4 P1/P2 与 05-static-docs.md H1–H10 的**修复后契约**，
 *     不依赖内部函数名（只通过 apply / 工具 execute / 路由 handler / 磁盘文件观察）；
 *   - Node 18+，零第三方依赖。
 *
 * 退出码：全部断言 PASS → 0；有 FAIL（含 index.js 当前无法 import）→ 1。
 *
 * 覆盖清单（断言 id 以用例 id 开头）：
 *   P1-1a/P1-1b  文件兜底 Key 保留（分两步 / 单请求同时提交；含未知字段 customField）
 *   cfg-model    /config 模型校验：id 与 aliases 接受并归一化、未知 400、/api/info 失败 fail-closed 400
 *   limits       per-model limits：flash 32000/4 图、ultra 131072/16 图，本地拒绝零网络
 *   dataurl      data: URL：非图片 MIME、SVG、解码后超 8MB 本地拒绝；合法 1×1 PNG 与
 *                "base64 更长但解码后未超限" 的图片放行（大小必须按解码后计算）
 *   info-action  decision_info 非法 action 抛错（错误文本含可用 action）；返回 action 与实际一致
 *   render       score 降序 + 最可能档标注；choice probabilities 数组不再静默；
 *                低置信文案区分 top<0.6 / confidence<0.5；box 多题文案不再误导
 *   passthrough  服务端 warnings/hint 透传到工具 value 与 formatAnswers 渲染
 *   mask         maskKey 4+4；短 key（≤12）只返回 "…"、不泄漏完整 key
 *   results-merge  results.json 跨进程合并（磁盘已有他人条目在下次写盘后仍在）
 *   results-cap    预置 250 条后触发落盘，文件条目 ≤200 且新条目保留
 *   http         Origin:null → 403；POST /config 非 application/json → 4xx；405 带 Allow；
 *                所有 JSON 响应带 x-content-type-options: nosniff；POST /client-report 空 body → 400
 *   ttl          TTL：2 小时前条目 GET /result → 404（对照：1 分钟前 → 200）
 *   settings-cache config.json 外部变更后进程内立即可见（P3 settingsCache 失效）
 *   box-serial / box-parallel-nonbox / box-multimodel / box-retry-429 /
 *   box-retry-exhausted / box-queue-abort
 *                box 并发契约（VERIFY-2026-10-29.md §6.1）：同一 key+model 的 box 请求在 Host 内串行
 *                （任一时刻在途 /v1/systemone ≤1），非 box 保持并行，不同 model 可重叠；
 *                命中 429 concurrency_limit 等待约 1500ms 重试一次，两次都 429 原样抛错
 *                （保留 error.status=429 / error.code='concurrency_limit'）；排队中 abort 立即失败且不卡队列。
 *
 * 环境变量（仅自测/调试用，正常验收不需要）：
 *   SMOKE_INDEX  覆盖被测 index.js 路径（默认 <repo>/index.js）
 *   SMOKE_TMP    覆盖临时 DSH_HOME 根目录
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)
const INDEX_PATH = process.env.SMOKE_INDEX ? resolve(process.env.SMOKE_INDEX) : join(ROOT, 'index.js')
const INDEX_URL = pathToFileURL(INDEX_PATH).href
const TMP_ROOT = process.env.SMOKE_TMP || join(tmpdir(), `dsh-decision-smoke-${process.pid}`)
const KEEP = process.argv.includes('--keep')
const ONLY = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice('--only='.length)

const ORIGINAL_HOME = process.env.DSH_HOME
const ORIGINAL_KEY = process.env.DECISION_API_KEY
const REAL_FETCH = globalThis.fetch

// ---------------------------------------------------------------------------
// 常量 / stub 数据
// ---------------------------------------------------------------------------

const ULTRA = 'vllm-sr/d3-ultra'
const FLASH = 'vllm-sr/d3-flash'
const TURBO_ALIAS = 'vllm-sr/d3-turbo'
const UNKNOWN_MODEL = 'vllm-sr/nonexistent'

/** 合法形态的假 Key（形状匹配 /^sk-vsr-[0-9A-Za-z]{40,60}$/，不打印明文、不联网验证真实 Key）。 */
const FAKE_KEY = `sk-vsr-${'F'.repeat(44)}`
/** 正常长度 key（47 字符），用于掩码断言：4+4 → "sk-v…wxyz"。 */
const MASK_KEY = `sk-vsr-abcd${'X'.repeat(32)}wxyz`
/** 短 key（12 字符），修复后必须只回显 "…"。 */
const SHORT_KEY = 'sk-vsr-SHORT'

/** 真正的 1×1 PNG（70 字节，PNG 签名 + IHDR 宽高 = 1）。 */
const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_1X1_BYTES = Buffer.from(PNG_1X1_B64, 'base64')
const PNG_1X1_DATA_URL = `data:image/png;base64,${PNG_1X1_B64}`

/** 与真实 /api/info 形状一致：per-model limits 嵌在 models[i].limits 里，另有一份全局 limits。 */
function infoStub() {
  const ultraLimits = {
    max_state_chars: 131_072,
    max_questions: 64,
    max_images: 16,
    max_image_bytes: 16_777_216,
    max_videos: 1,
    max_video_bytes: 32_000_000,
    max_request_tokens: 131_072,
  }
  const flashLimits = {
    max_state_chars: 32_000,
    max_questions: 64,
    max_images: 4,
    max_image_bytes: 8_000_000,
    max_videos: 1,
    max_video_bytes: 32_000_000,
  }
  return {
    models: [
      { id: ULTRA, aliases: [TURBO_ALIAS, 'vllm-sr/d3'], size: '27B', ready: true, box: true, limits: ultraLimits },
      { id: FLASH, size: '9B', ready: true, box: true, limits: flashLimits },
      { id: 'vllm-sr/d3-mini', size: '4B', ready: true, box: false, limits: flashLimits },
      { id: 'vllm-sr/d3-nano', size: '2B', ready: true, box: false, limits: flashLimits },
      { id: 'vllm-sr/d3-lite', size: '0.8B', ready: true, box: false, limits: flashLimits },
      { id: 'vllm-sr/d3-edge', size: '0.6B', ready: true, box: false, limits: flashLimits },
    ],
    limits: {
      max_body_bytes: 50_331_648,
      max_questions: 64,
      max_state_chars: 32_000,
      max_images: 4,
      max_image_bytes: 8_000_000,
      max_videos: 1,
      max_video_bytes: 32_000_000,
      timeout_seconds: 35,
    },
  }
}

const NOW_QUESTION = { type: 'noul', instructions: '是否同意？' }
const STATE_OK = '这个方案我同意。'

// ---------------------------------------------------------------------------
// 断言记录
// ---------------------------------------------------------------------------

const results = []
let caseIndex = 0

function clip(value, limit = 460) {
  let text
  if (typeof value === 'string') {
    text = value
  } else if (value === undefined) {
    text = 'undefined'
  } else if (value === null) {
    text = 'null'
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
    if (typeof text !== 'string') text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}…(+${text.length - limit})` : text
}

/** HTTP 断言的紧凑详情：不把整个 /status 响应体（含 6 个模型的 limits）刷进日志。 */
function httpDetail(response, extra = '') {
  const parts = [`status=${response.status}`]
  if (response.error) parts.push(`error=${response.error}`)
  const body = response.json
  if (body && typeof body === 'object') {
    if (body.error) parts.push(`body.error=${clip(body.error, 160)}`)
    if (body.model) parts.push(`body.model=${body.model}`)
    if (typeof body.keyConfigured === 'boolean') parts.push(`keyConfigured=${body.keyConfigured}`)
    if (typeof body.keyPrefix === 'string') parts.push(`keyPrefix=${body.keyPrefix}`)
  } else if (response.raw) {
    parts.push(`body=${clip(response.raw, 160)}`)
  }
  if (extra) parts.push(extra)
  return parts.join(' ')
}

function messageOf(error) {
  if (!error) return 'unknown error'
  return error && error.message ? error.message : String(error)
}

class Recorder {
  constructor(id, title) {
    this.id = id
    this.title = title
  }

  assert(name, ok, detail) {
    const pass = ok === true
    results.push({ caseId: this.id, name, ok: pass, detail: detail === undefined ? '' : String(detail) })
    const tail = detail === undefined || detail === '' ? '' : ` — ${clip(detail)}`
    console.log(`[${pass ? 'PASS' : 'FAIL'}] ${this.id} · ${name}${tail}`)
    return pass
  }

  /** 软断言：只打印，不参与 pass/fail（用于记录环境事实）。 */
  info(name, detail) {
    console.log(`[INFO] ${this.id} · ${name}${detail ? ` — ${clip(detail)}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 假 ctx / 假 webServer / 假 req-res
// ---------------------------------------------------------------------------

let modSeq = 0

function makeCtx({ noCreds = true, withRoutes = true } = {}) {
  const tools = []
  const routes = []
  const disposers = []

  const webServer = withRoutes
    ? {
        register(def) {
          const index = routes.findIndex((route) => route.path === def.path && route.kind === def.kind)
          if (index >= 0) routes[index] = def
          else routes.push(def)
          return () => {
            const at = routes.indexOf(def)
            if (at >= 0) routes.splice(at, 1)
          }
        },
        getOrigin: () => 'http://127.0.0.1:60252',
      }
    : undefined

  const scoped = {
    get: (name) => (name === 'webServer' ? webServer : name === 'credentials' ? credentials : undefined),
    webServer,
  }

  const credentials = noCreds
    ? undefined
    : {
        resolve: async () => ({ value: FAKE_KEY }),
        set: async () => {},
        delete: async () => {},
      }

  const ctx = {
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get(name) {
      if (name === 'webServer') return webServer
      if (name === 'credentials') return credentials
      return undefined
    },
    effect(setup) {
      if (typeof setup === 'function') disposers.push(setup)
      return () => {}
    },
    inject(_deps, callback) {
      if (typeof callback === 'function') callback(scoped)
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }

  return { ctx, tools, routes, disposers }
}

function disposeAll(disposers) {
  for (const setup of disposers.splice(0)) {
    try {
      const cleanup = setup()
      if (typeof cleanup === 'function') cleanup()
    } catch {
      // 清理失败不影响判定
    }
  }
}

function lowerHeaders(headers = {}) {
  const out = {}
  for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = value
  return out
}

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = []
  if (body !== undefined) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
    chunks.push(buffer)
  }
  return {
    method,
    url,
    headers: lowerHeaders({ host: '127.0.0.1:60252', ...headers }),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      for (const [key, value] of Object.entries(headers || {})) this.headers[String(key).toLowerCase()] = value
    },
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value
    },
    getHeader(key) {
      return this.headers[String(key).toLowerCase()]
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// 假 fetch：按 path 分派、逐次记录，绝不联网
// ---------------------------------------------------------------------------

const fetchState = { handler: null, calls: [] }

function pathOf(url) {
  try {
    return new URL(String(url)).pathname
  } catch {
    return String(url)
  }
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(payload)
  const merged = lowerHeaders({ 'content-type': 'application/json', ...headers })
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => merged[String(name).toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

function defaultFetchHandler(record) {
  switch (record.path) {
    case '/api/info':
      return jsonResponse(infoStub())
    case '/api/keys/self/usage':
      return jsonResponse({
        quota: { models: [{ id: FLASH, requests_today: 2, requests_left: 62 }] },
        recent: { latency_ms: { p50: 11, p90: 22 } },
      })
    case '/api/keys/self':
      return jsonResponse({ prefix: 'sk-vsr-FAKE', status: 'active', usage_today: { requests: 2, input_tokens: 40 } })
    case '/api/status':
      return jsonResponse({ models: [{ id: FLASH, state: 'operational', latency_ms: { p50: 12, p90: 30 } }] })
    case '/v1/systemone':
      return jsonResponse(
        { model: FLASH, answers: { q: { type: 'noul', noul: 0.92 } }, usage: { input_tokens: 7 } },
        { headers: { 'x-request-id': 'req_smoke_1' } },
      )
    default:
      return jsonResponse({})
  }
}

const fetchImpl = async (url, init = {}) => {
  const record = {
    url: String(url),
    path: pathOf(url),
    method: init.method || 'GET',
    headers: lowerHeaders(init.headers || {}),
    body: init.body,
    at: Date.now(),
  }
  fetchState.calls.push(record)
  const handler = fetchState.handler || defaultFetchHandler
  const response = await handler(record)
  return response || jsonResponse({})
}
globalThis.fetch = fetchImpl

// ---------------------------------------------------------------------------
// 磁盘 / 临时 home
// ---------------------------------------------------------------------------

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 加载被测插件（每个用例一个全新模块实例 + 全新 DSH_HOME）
// ---------------------------------------------------------------------------

async function openPlugin(name, options = {}) {
  const home = join(TMP_ROOT, name)
  await rm(home, { recursive: true, force: true })
  const dataDir = join(home, 'dsh-decision')
  await mkdir(dataDir, { recursive: true })
  if (options.seedConfig !== undefined) await writeJson(join(dataDir, 'config.json'), options.seedConfig)
  if (options.seedEntries !== undefined) {
    await writeJson(join(dataDir, 'results.json'), { version: 1, entries: options.seedEntries })
  }

  process.env.DSH_HOME = home
  if (options.envKey === undefined) delete process.env.DECISION_API_KEY
  else process.env.DECISION_API_KEY = options.envKey

  fetchState.calls.length = 0
  fetchState.handler = options.fetchHandler || defaultFetchHandler

  let mod
  try {
    mod = await import(`${INDEX_URL}?smoke=${++modSeq}`)
  } catch (error) {
    const failure = new Error(`index.js import 失败（可能正处于编辑中间态）: ${messageOf(error)}`)
    failure.cause = error
    failure.moduleLoad = true
    throw failure
  }

  const made = makeCtx({ noCreds: options.noCreds !== false, withRoutes: options.withRoutes !== false })
  mod.apply(made.ctx)

  const askTool = made.tools.find((tool) => tool.name === 'decision_ask')
  const infoTool = made.tools.find((tool) => tool.name === 'decision_info')
  const routes = made.routes
  let callSeq = 0

  const findRoute = (suffix) =>
    routes.find((route) => typeof route.path === 'string' && (route.path === suffix || route.path.endsWith(suffix)))

  async function hit(suffix, { method = 'GET', url, headers = {}, body } = {}) {
    const route = findRoute(suffix)
    if (!route) {
      return {
        status: 0,
        headers: {},
        json: null,
        raw: '',
        error: `路由 ${suffix} 未注册（已注册: ${routes.map((item) => item.path).join(', ') || '无'}）`,
      }
    }
    const requestHeaders = { host: '127.0.0.1:60252' }
    if (body !== undefined && headers['content-type'] === undefined) {
      requestHeaders['content-type'] = 'application/json; charset=utf-8'
    }
    Object.assign(requestHeaders, lowerHeaders(headers))
    const req = makeReq({ method, url: url || `/dsh-decision${suffix}`, headers: requestHeaders, body })
    const res = makeRes()
    try {
      await route.handler(req, res)
    } catch (error) {
      return { status: 0, headers: res.headers, json: null, raw: '', error: `handler 抛错: ${messageOf(error)}` }
    }
    let json = null
    try {
      json = res.body ? JSON.parse(res.body) : null
    } catch {
      json = null
    }
    return { status: res.status, headers: res.headers, json, raw: res.body, error: null }
  }

  async function ask(args, callId, { signal } = {}) {
    const id = callId || `call_smoke_${String(++callSeq).padStart(3, '0')}`
    if (!askTool) return { ok: false, error: 'decision_ask 工具未注册', value: undefined, errorObject: null, callId: id }
    try {
      const value = await askTool.execute(args, { callId: id, signal })
      return { ok: true, value, error: null, errorObject: null, callId: id }
    } catch (error) {
      return { ok: false, value: undefined, error: messageOf(error), errorObject: error, callId: id }
    }
  }

  async function infoExecute(action) {
    if (!infoTool) return { ok: false, error: 'decision_info 工具未注册', value: undefined }
    try {
      return { ok: true, value: await infoTool.execute({ action }, { callId: `call_info_${++callSeq}`, signal: undefined }), error: null }
    } catch (error) {
      return { ok: false, value: undefined, error: messageOf(error) }
    }
  }

  return {
    name,
    home,
    dataDir,
    mod,
    ctx: made.ctx,
    routes,
    tools: made.tools,
    askTool,
    infoTool,
    ask,
    infoExecute,
    hit,
    findRoute,
    renderAsk(value) {
      if (!askTool || !askTool.output || typeof askTool.output.render !== 'function') {
        throw new Error('decision_ask 缺少 output.render')
      }
      const rendered = askTool.output.render({}, value)
      return Array.isArray(rendered) && rendered[0] ? String(rendered[0].text) : String(rendered)
    },
    renderInfo(value) {
      if (!infoTool || !infoTool.output || typeof infoTool.output.render !== 'function') {
        throw new Error('decision_info 缺少 output.render')
      }
      const rendered = infoTool.output.render({}, value)
      return Array.isArray(rendered) && rendered[0] ? String(rendered[0].text) : String(rendered)
    },
    readConfig: () => readJson(join(dataDir, 'config.json')),
    readResults: () => readJson(join(dataDir, 'results.json')),
    calls: () => fetchState.calls,
    paths: () => fetchState.calls.map((call) => call.path),
    systemones: () => fetchState.calls.filter((call) => call.path === '/v1/systemone'),
    infos: () => fetchState.calls.filter((call) => call.path === '/api/info'),
    resetCalls: () => {
      fetchState.calls.length = 0
    },
    /** 预热 /api/info（per-model limits 的缓存来源），随后归零调用计数。 */
    async warmInfo() {
      await infoExecute('models').catch(() => {})
      fetchState.calls.length = 0
    },
    async dispose() {
      disposeAll(made.disposers)
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
  }
}

function lastSystemoneBody(plugin) {
  const calls = plugin.systemones()
  if (calls.length === 0) return null
  try {
    return JSON.parse(calls[calls.length - 1].body)
  } catch {
    return null
  }
}

function normalizeMask(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\.\.\./g, '…')
}

// ---------------------------------------------------------------------------
// box 并发用例的辅助（VERIFY-2026-10-29.md §6.1）
// ---------------------------------------------------------------------------

/** 成功响应的通用答案（box / 非 box 用例都只关心工具是否成功，不关心答案语义）。 */
function successAnswer() {
  return { model: FLASH, answers: { q: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2 } }
}

/** box 题参数：box 题要求 images 恰好 1 张。 */
function boxArgs(model) {
  const args = {
    state: STATE_OK,
    questions: { q: { type: 'box', instructions: '定位登录按钮' } },
    images: [PNG_1X1_DATA_URL],
  }
  if (model) args.model = model
  return args
}

function noulArgs() {
  return { state: STATE_OK, questions: { q: { ...NOW_QUESTION } } }
}

/**
 * 统计 /v1/systemone 的在途并发（延迟 delayMs 后返回响应）。
 * 其它路径交给 defaultFetchHandler，避免 /api/info 预热干扰 systemone 计数。
 */
function makeTrackingFetch({ delayMs = 0, respond } = {}) {
  const state = { total: 0, inFlight: 0, peak: 0 }
  async function handler(record) {
    if (record.path !== '/v1/systemone') return defaultFetchHandler(record)
    state.total += 1
    const n = state.total
    state.inFlight += 1
    state.peak = Math.max(state.peak, state.inFlight)
    try {
      const wait = typeof delayMs === 'function' ? delayMs(n) : delayMs
      if (wait > 0) await sleep(wait)
      return respond ? respond(n, record) : jsonResponse(successAnswer())
    } finally {
      state.inFlight -= 1
    }
  }
  return { handler, state }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const CASES = []
function testCase(id, title, fn) {
  CASES.push({ id, title, fn })
}

// --- P1-1：文件兜底 Key 被下一次 writeSettings 覆盖丢失 ----------------------

testCase('P1-1a', '文件兜底 Key：先存 Key、再改 model，Key 不丢（含未知字段）', async (t) => {
  const p = await openPlugin('p1-1a', { seedConfig: { customField: 'keep-me', baseUrl: 'https://decision.vllm-sr.ai' } })
  try {
    const saved = await p.hit('/config', { method: 'POST', body: { apiKey: FAKE_KEY } })
    t.assert('POST /config {apiKey} → 200', saved.status === 200, httpDetail(saved))
    t.assert('保存 Key 后响应 keyConfigured=true', Boolean(saved.json && saved.json.keyConfigured === true), httpDetail(saved))

    const afterKey = await p.readConfig()
    t.assert('config.json 落盘 apiKey', Boolean(afterKey && afterKey.apiKey === FAKE_KEY), `keys=${afterKey ? Object.keys(afterKey).join(',') : '(无文件)'}`)

    const changed = await p.hit('/config', { method: 'POST', body: { model: ULTRA } })
    t.assert('随后 POST /config {model} → 200', changed.status === 200, httpDetail(changed))
    t.assert('改 model 后响应 keyConfigured=true（Key 未被覆盖）', Boolean(changed.json && changed.json.keyConfigured === true), httpDetail(changed))

    const afterModel = await p.readConfig()
    t.assert(
      'config.json 同时含 apiKey 与 model',
      Boolean(afterModel && afterModel.apiKey === FAKE_KEY && afterModel.model === ULTRA),
      `apiKey=${afterModel && afterModel.apiKey ? `len=${afterModel.apiKey.length}` : '(缺失)'} model=${afterModel && afterModel.model}`,
    )
    t.assert('config.json 中手工未知字段 customField 仍保留', Boolean(afterModel && afterModel.customField === 'keep-me'), `keys=${afterModel ? Object.keys(afterModel).join(',') : '(无文件)'}`)

    const status = await p.hit('/status')
    t.assert('GET /status 显示 model=ultra 且 keyConfigured=true', Boolean(status.status === 200 && status.json && status.json.model === ULTRA && status.json.keyConfigured === true), `status=${status.status} model=${status.json && status.json.model} keyConfigured=${status.json && status.json.keyConfigured}`)
  } finally {
    await p.dispose()
  }
})

testCase('P1-1b', '文件兜底 Key：单请求同时提交 apiKey+model，两者都落盘', async (t) => {
  const p = await openPlugin('p1-1b')
  try {
    const saved = await p.hit('/config', { method: 'POST', body: { apiKey: FAKE_KEY, model: ULTRA } })
    t.assert('POST /config {apiKey, model} → 200', saved.status === 200, httpDetail(saved))
    t.assert('单请求保存后响应 keyConfigured=true', Boolean(saved.json && saved.json.keyConfigured === true), httpDetail(saved))
    const cfg = await p.readConfig()
    t.assert(
      '单请求保存后 config.json 同时含 apiKey 与 model',
      Boolean(cfg && cfg.apiKey === FAKE_KEY && cfg.model === ULTRA),
      `keys=${cfg ? Object.keys(cfg).join(',') : '(无文件)'} model=${cfg && cfg.model}`,
    )

    // Key 要真的可用：后续 decision_ask 不应抛 "No Decision API key configured"
    const asked = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION } }, 'call_p1_1b_after_save')
    t.assert('保存后 decision_ask 不再报 "No Decision API key configured"', asked.ok && !/No Decision API key/i.test(asked.error || ''), asked.ok ? '调用成功' : `error=${asked.error}`)
  } finally {
    await p.dispose()
  }
})

// --- /config 模型校验（P1-3 / H2）------------------------------------------

testCase('cfg-model', '/config 模型校验：aliases 接受并归一化、未知 400、上游失败 fail-closed', async (t) => {
  const p = await openPlugin('cfg-model')
  try {
    const alias = await p.hit('/config', { method: 'POST', body: { model: TURBO_ALIAS } })
    t.assert('接受别名 vllm-sr/d3-turbo → 200', alias.status === 200, httpDetail(alias))
    const afterAlias = await p.readConfig()
    t.assert('别名落盘归一化为 vllm-sr/d3-ultra', Boolean(afterAlias && afterAlias.model === ULTRA), `config.model=${afterAlias && afterAlias.model}`)
    t.assert('别名请求的响应 model 也是归一化后的 id', Boolean(alias.json && alias.json.model === ULTRA), `body.model=${alias.json && alias.json.model}`)

    const known = await p.hit('/config', { method: 'POST', body: { model: ULTRA } })
    t.assert('接受已知 id vllm-sr/d3-ultra → 200', known.status === 200, httpDetail(known))

    const unknown = await p.hit('/config', { method: 'POST', body: { model: UNKNOWN_MODEL } })
    t.assert('未知模型 → 400', unknown.status === 400, httpDetail(unknown))
    const afterUnknown = await p.readConfig()
    t.assert('未知模型不落盘（仍是 vllm-sr/d3-ultra）', Boolean(afterUnknown && afterUnknown.model === ULTRA), `config.model=${afterUnknown && afterUnknown.model}`)
  } finally {
    await p.dispose()
  }

  // fail-closed：/api/info 请求抛错时不得写入任意 model
  const broken = await openPlugin('cfg-model-failclosed', {
    seedConfig: { model: FLASH, baseUrl: 'https://decision.vllm-sr.ai' },
    fetchHandler: (record) =>
      record.path === '/api/info'
        ? jsonResponse({ error: { code: 'upstream_unavailable', message: 'stub: /api/info down' } }, { status: 500 })
        : defaultFetchHandler(record),
  })
  try {
    const rejected = await broken.hit('/config', { method: 'POST', body: { model: ULTRA } })
    t.assert('/api/info 请求抛错时 POST /config → 400（fail-closed，不得静默落盘）', rejected.status === 400, httpDetail(rejected))
    const cfg = await broken.readConfig()
    t.assert('fail-closed 时 model 保持原值（vllm-sr/d3-flash）', Boolean(cfg && cfg.model === FLASH), `config.model=${cfg && cfg.model}`)
  } finally {
    await broken.dispose()
  }
})

// --- per-model limits（P2-1 / H4）------------------------------------------

testCase('limits', 'per-model limits：flash 32000/4 图，ultra 131072/16 图，本地拒绝零网络', async (t) => {
  const p = await openPlugin('limits', { envKey: FAKE_KEY })
  try {
    await p.warmInfo()

    // flash（默认模型）下 32001 字符 → 本地拒绝
    const tooLong = await p.ask({ state: 'A'.repeat(32_001), questions: { q: NOW_QUESTION } }, 'call_limit_flash_32001')
    t.assert('默认模型 flash 下 state 32001 字符 → 本地拒绝', !tooLong.ok, tooLong.ok ? '未被拒绝（进入了网络层）' : tooLong.error)
    t.assert('flash 32001 字符：零网络请求（本地拒绝）', p.calls().length === 0, `fetches=${p.calls().length} paths=[${p.paths().join(',')}]`)

    // flash 下 32000 字符 → 放行到网络层
    p.resetCalls()
    const boundary = await p.ask({ state: 'A'.repeat(32_000), questions: { q: NOW_QUESTION } }, 'call_limit_flash_32000')
    t.assert('flash 下 state 32000 字符 → 放行到网络层', boundary.ok, boundary.ok ? '已到网络层' : `本地拒绝: ${boundary.error}`)
    t.assert('32000 字符请求发往 /v1/systemone', p.systemones().length === 1, `systemone=${p.systemones().length} paths=[${p.paths().join(',')}]`)

    // ultra 40000 字符 → 本地放行
    p.resetCalls()
    const ultraState = await p.ask({ model: ULTRA, state: 'A'.repeat(40_000), questions: { q: NOW_QUESTION } }, 'call_limit_ultra_40000')
    t.assert('model=vllm-sr/d3-ultra 时 state 40000 字符 → 本地放行', ultraState.ok, ultraState.ok ? '已到网络层' : `本地拒绝: ${ultraState.error}`)
    t.assert('ultra 40000 字符请求发往 /v1/systemone', p.systemones().length === 1, `systemone=${p.systemones().length} paths=[${p.paths().join(',')}]`)
    const ultraBody = lastSystemoneBody(p)
    t.assert(
      '请求体携带 40000 字符 state 与 model=vllm-sr/d3-ultra',
      Boolean(ultraBody && ultraBody.model === ULTRA && typeof ultraBody.state === 'string' && ultraBody.state.length === 40_000),
      `model=${ultraBody && ultraBody.model} stateLen=${ultraBody && ultraBody.state && ultraBody.state.length}`,
    )

    // ultra 16 张 1×1 png → 放行
    p.resetCalls()
    const sixteen = await p.ask(
      { model: ULTRA, state: STATE_OK, questions: { q: NOW_QUESTION }, images: Array.from({ length: 16 }, () => PNG_1X1_DATA_URL) },
      'call_limit_ultra_16_images',
    )
    t.assert('ultra 允许 16 张 1×1 png', sixteen.ok, sixteen.ok ? '已到网络层' : `本地拒绝: ${sixteen.error}`)
    const imagesBody = lastSystemoneBody(p)
    t.assert('ultra 请求体携带 16 张图', Boolean(imagesBody && Array.isArray(imagesBody.images) && imagesBody.images.length === 16), `images=${imagesBody && imagesBody.images && imagesBody.images.length}`)

    // flash 下第 5 张图 → 本地拒绝
    p.resetCalls()
    const five = await p.ask(
      { model: FLASH, state: STATE_OK, questions: { q: NOW_QUESTION }, images: Array.from({ length: 5 }, () => PNG_1X1_DATA_URL) },
      'call_limit_flash_5_images',
    )
    t.assert('flash 下第 5 张图 → 本地拒绝', !five.ok, five.ok ? '未被拒绝（进入了网络层）' : five.error)
    t.assert('flash 5 图：零网络请求（本地拒绝）', p.calls().length === 0, `fetches=${p.calls().length} paths=[${p.paths().join(',')}]`)
    t.assert('拒绝文案点明图片数量上限（4）', !five.ok && /at most 4|max_images[^0-9]*4|4 image/i.test(five.error || ''), `error=${five.error}`)
  } finally {
    await p.dispose()
  }
})

// --- data: URL 校验（P2-2）---------------------------------------------------

testCase('dataurl', 'data: URL 校验：MIME 白名单 + 按解码后字节判大小', async (t) => {
  const p = await openPlugin('dataurl', { envKey: FAKE_KEY })
  try {
    await p.warmInfo()

    const bigPayload = Buffer.concat([PNG_1X1_BYTES, Buffer.alloc(9 * 1024 * 1024, 0)])
    const fitsPayload = Buffer.concat([PNG_1X1_BYTES, Buffer.alloc(7 * 1024 * 1024, 0)])

    const rejects = [
      ['非图片 MIME（data:text/plain）', 'data:text/plain;base64,aGVsbG8=', /data:|mime|media type|text\/plain|unsupported|image/i],
      ['SVG（data:image/svg+xml）', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', /svg|mime|media type|unsupported/i],
      [
        '解码后 9MB 图片（超 flash 8MB）',
        `data:image/png;base64,${bigPayload.toString('base64')}`,
        /MB|bytes|limit|too (large|big)|size/i,
      ],
    ]
    for (const [label, dataUrl, pattern] of rejects) {
      p.resetCalls()
      const out = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION }, images: [dataUrl] }, `call_dataurl_reject_${rejects.findIndex((item) => item[0] === label)}`)
      t.assert(`${label} → 本地拒绝`, !out.ok, out.ok ? '未被本地拦截（进入网络层）' : out.error)
      t.assert(`${label}：零网络请求`, p.calls().length === 0, `fetches=${p.calls().length} paths=[${p.paths().join(',')}]`)
      t.assert(`${label}：错误文案可读（点明 MIME/大小）`, !out.ok && pattern.test(out.error || ''), `error=${out.error}`)
    }

    // 合法 1×1 PNG → 放行
    p.resetCalls()
    const png = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION }, images: [PNG_1X1_DATA_URL] }, 'call_dataurl_png_ok')
    t.assert('合法 1×1 PNG data URL → 放行', png.ok, png.ok ? '已到网络层' : `本地拒绝: ${png.error}`)
    t.assert('合法 PNG data URL 请求发往 /v1/systemone', p.systemones().length === 1, `systemone=${p.systemones().length} paths=[${p.paths().join(',')}]`)

    // base64 字符数超过 8MB、但解码后约 7MB → 必须放行（大小按解码后计算）
    p.resetCalls()
    const sevenMb = await p.ask(
      { state: STATE_OK, questions: { q: NOW_QUESTION }, images: [`data:image/png;base64,${fitsPayload.toString('base64')}`] },
      'call_dataurl_7mb_ok',
    )
    t.assert(
      'base64 长度 >8MB 但解码后约 7MB 的图片 → 放行（大小按解码后计算）',
      sevenMb.ok,
      sevenMb.ok ? '已到网络层' : `本地拒绝: ${sevenMb.error}（若按 base64 字符数判大小会误拒）`,
    )
  } finally {
    await p.dispose()
  }
})

// --- decision_info action（P2-4 / H3）--------------------------------------

testCase('info-action', 'decision_info：非法 action 抛错、返回 action 与实际一致', async (t) => {
  const p = await openPlugin('info-action', { envKey: FAKE_KEY })
  try {
    p.resetCalls()
    const bogus = await p.infoExecute('bogus')
    t.assert('action:"bogus" 必须抛错（不得静默走 usage）', !bogus.ok, bogus.ok ? `未抛错，返回 action=${bogus.value && bogus.value.action}` : bogus.error)
    t.assert(
      '非法 action 的错误文本列出可用 action（models/usage/status）',
      !bogus.ok && ['models', 'usage', 'status'].every((word) => String(bogus.error || '').includes(word)),
      `error=${bogus.error}`,
    )
    t.assert('非法 action 在本地校验阶段被拒（零网络请求）', p.calls().length === 0, `fetches=${p.calls().length} paths=[${p.paths().join(',')}]`)

    const models = await p.infoExecute('models')
    t.assert('action:"models" → 返回 action="models"', Boolean(models.ok && models.value && models.value.action === 'models'), `action=${models.value && models.value.action} error=${models.error || ''}`)

    const status = await p.infoExecute('status')
    t.assert('action:"status" → 返回 action="status"', Boolean(status.ok && status.value && status.value.action === 'status'), `action=${status.value && status.value.action} error=${status.error || ''}`)

    const usage = await p.infoExecute('usage')
    t.assert('action:"usage" → 返回 action="usage"', Boolean(usage.ok && usage.value && usage.value.action === 'usage'), `action=${usage.value && usage.value.action} error=${usage.error || ''}`)
    t.assert('action:"usage" 正常返回（keyConfigured 为布尔）', Boolean(usage.ok && usage.value && typeof usage.value.keyConfigured === 'boolean'), `keyConfigured=${usage.value && usage.value.keyConfigured}`)

    const fallback = await p.infoExecute(undefined)
    t.assert('不传 action → 默认 action="models"', Boolean(fallback.ok && fallback.value && fallback.value.action === 'models'), `action=${fallback.value && fallback.value.action}`)
  } finally {
    await p.dispose()
  }
})

// --- 结果渲染（P3 渲染一致性）---------------------------------------------

testCase('render', '结果渲染：score 降序/最可能档、choice 数组不静默、低置信文案区分、box 多题文案', async (t) => {
  let nextAnswers = { q: { type: 'noul', noul: 0.91 } }
  const p = await openPlugin('render', {
    envKey: FAKE_KEY,
    fetchHandler: (record) => {
      if (record.path === '/v1/systemone') return jsonResponse({ model: FLASH, answers: nextAnswers, usage: { input_tokens: 3 } })
      return defaultFetchHandler(record)
    },
  })
  try {
    // 1) score 按概率降序并标注最可能档
    const scoreText = p.renderAsk({
      model: FLASH,
      answers: {
        q: { type: 'score', score: 0.5, confidence: 0.4, probabilities: { 0: 0.1, 1: 0.9 }, legend: { 0: '低', 1: '高' } },
      },
    })
    const highAt = scoreText.indexOf('90.0%')
    const lowAt = scoreText.indexOf('10.0%')
    t.assert('score 概率按降序输出（90% 在 10% 之前）', highAt >= 0 && lowAt >= 0 && highAt < lowAt, clip(scoreText))
    const highLine = scoreText.split('\n').find((line) => line.includes('90.0%')) || ''
    t.assert('score 标注最可能档（最高概率行带标记）', /←|chosen|most likely|most-likely|top|highest|最可能/i.test(highLine), `最高概率行=${JSON.stringify(highLine)}`)

    // 2) choice probabilities 为数组时不再静默
    const arrayText = p.renderAsk({
      model: FLASH,
      answers: { q: { type: 'choice', choice: 'a', confidence: 0.7, probabilities: [0.7, 0.3] } },
    })
    t.assert(
      'choice probabilities 为数组时给出可读提示（不再静默省略）',
      /probabilit|invalid|malformed|unexpected|not (a|an) object|array|n\/a|ignored|无法/i.test(arrayText),
      clip(arrayText),
    )

    // 3) 低置信文案区分 top<0.6 与 confidence<0.5
    //    走真实链路（服务端回答 → annotateConfidence → formatAnswers），而不是手写 lowConfidence，
    //    因为“原因”由 annotateConfidence 生成、由 formatAnswers 渲染，只测渲染会漏掉前半段。
    nextAnswers = { q: { type: 'choice', choice: 'a', confidence: 0.8, probabilities: { a: 0.4, b: 0.34, c: 0.26 } } }
    const flatAsk = await p.ask(
      { state: STATE_OK, questions: { q: { type: 'choice', instructions: '选？', criteria: { a: 'A', b: 'B' } } } },
      'call_render_flat_top',
    )
    nextAnswers = { q: { type: 'choice', choice: 'a', confidence: 0.3, probabilities: { a: 0.95, b: 0.05 } } }
    const lowConfAsk = await p.ask(
      { state: STATE_OK, questions: { q: { type: 'choice', instructions: '选？', criteria: { a: 'A', b: 'B' } } } },
      'call_render_low_confidence',
    )
    t.assert(
      '两种低置信场景都被标注（top<0.6 与 confidence<0.5）',
      Boolean(
        flatAsk.ok &&
          lowConfAsk.ok &&
          flatAsk.value.answers.q &&
          flatAsk.value.answers.q.lowConfidence === true &&
          lowConfAsk.value.answers.q &&
          lowConfAsk.value.answers.q.lowConfidence === true,
      ),
      `flat=${clip(flatAsk.value && flatAsk.value.answers && flatAsk.value.answers.q)} lowConfidence=${clip(lowConfAsk.value && lowConfAsk.value.answers && lowConfAsk.value.answers.q)}`,
    )
    const flatText = flatAsk.ok ? p.renderAsk(flatAsk.value) : ''
    const lowConfText = lowConfAsk.ok ? p.renderAsk(lowConfAsk.value) : ''
    const flatLine = flatText.split('\n').find((line) => /low confidence|低置信/i.test(line)) || ''
    const lowConfLine = lowConfText.split('\n').find((line) => /low confidence|低置信/i.test(line)) || ''
    t.assert('两种低置信原因都渲染出低置信提示', Boolean(flatLine && lowConfLine), `flat=${JSON.stringify(flatLine)} lowConfidence=${JSON.stringify(lowConfLine)}`)
    t.assert('低置信文案区分原因（top<0.6 与 confidence<0.5 两段文字不同）', Boolean(flatLine && lowConfLine && flatLine !== lowConfLine), `flat=${JSON.stringify(flatLine)} vs confidence=${JSON.stringify(lowConfLine)}`)
    t.assert('top<0.6 的文案点明分布/最高概率（top、0.6 或 distribution）', /top|0\.6|60%|distribution|flat|concentrat|spread/i.test(flatLine), `flat=${JSON.stringify(flatLine)}`)
    t.assert('confidence<0.5 的文案点明模型置信度（confidence、0.5 或 50%）', /confidence|0\.5|50%/i.test(lowConfLine), `lowConfidence=${JSON.stringify(lowConfLine)}`)

    // 4) box 多题文案：错误文案不得再出现 "send one box question per request"
    p.resetCalls()
    const boxNoImage = await p.ask({ state: STATE_OK, questions: { q: { type: 'box', instructions: '定位登录按钮' } } }, 'call_render_box_no_image')
    t.assert('box 题无图 → 本地拒绝', !boxNoImage.ok, boxNoImage.ok ? '未被拒绝（进入网络层）' : boxNoImage.error)
    t.assert(
      'box 无图错误文案不再出现 "send one box question per request"',
      !boxNoImage.ok && !/send one box question per request/i.test(boxNoImage.error || ''),
      `error=${boxNoImage.error}`,
    )

    p.resetCalls()
    const boxTwoQuestions = await p.ask(
      {
        state: STATE_OK,
        questions: {
          q1: { type: 'box', instructions: '定位登录按钮' },
          q2: { type: 'box', instructions: '定位注册链接' },
        },
        images: [PNG_1X1_DATA_URL],
      },
      'call_render_box_two_questions',
    )
    t.assert('同一张图支持多个 box 题（2 题 + 1 图 → 放行）', boxTwoQuestions.ok, boxTwoQuestions.ok ? '已到网络层' : `本地拒绝: ${boxTwoQuestions.error}`)
  } finally {
    await p.dispose()
  }
})

// --- warnings / hint 透传（P2-10）------------------------------------------

testCase('passthrough', '服务端 warnings/hint 透传到工具 value 与 formatAnswers', async (t) => {
  const p = await openPlugin('passthrough', {
    envKey: FAKE_KEY,
    fetchHandler: (record) => {
      if (record.path === '/v1/systemone') {
        // 第一次：带服务端 warnings/hint；第二次（choice 题）：返回 flat 分布，验证本地低置信 hint。
        let questions = {}
        try {
          const body = record.body ? JSON.parse(record.body) : {}
          questions = body.questions || {}
        } catch {
          questions = {}
        }
        if (questions.q && questions.q.type === 'choice') {
          return jsonResponse({
            model: FLASH,
            answers: { q: { type: 'choice', choice: 'b', probabilities: { a: 0.45, b: 0.55 }, confidence: 0.55 } },
            usage: { input_tokens: 3 },
          })
        }
        return jsonResponse(
          {
            model: ULTRA,
            answers: { q: { type: 'noul', noul: 0.91 } },
            warnings: ['w1'],
            hint: 'check-input',
            usage: { input_tokens: 7 },
          },
          { headers: { 'x-request-id': 'req_smoke_passthrough' } },
        )
      }
      return defaultFetchHandler(record)
    },
  })
  try {
    const out = await p.ask({ model: ULTRA, state: STATE_OK, questions: { q: NOW_QUESTION } }, 'call_passthrough_1')
    t.assert('含 warnings/hint 的响应仍正常返回', out.ok, out.ok ? '调用成功' : `error=${out.error}`)
    const value = out.value || {}
    t.assert('工具 value 保留服务端 warnings（含 "w1"）', Boolean(Array.isArray(value.warnings) && value.warnings.includes('w1')), `value.keys=${Object.keys(value).join(',')} warnings=${clip(value.warnings)}`)
    t.assert('工具 value 保留服务端 hint（"check-input"）', String(value.hint || '').includes('check-input'), `hint=${JSON.stringify(value.hint)}`)

    const text = p.renderAsk(value)
    t.assert('formatAnswers 渲染 warnings（notes: w1）', /notes:.*w1/i.test(text), clip(text))
    t.assert('formatAnswers 渲染非 low-confidence 的 hint（含 check-input）', /hint:/i.test(text) && text.includes('check-input'), clip(text))

    // 本地低置信仍应生成 hint=low-confidence（回归保护）
    const flat = await p.ask({ state: STATE_OK, questions: { q: { type: 'choice', instructions: '选？', criteria: { a: 'A', b: 'B' } } } }, 'call_passthrough_flat')
    t.assert('本地低置信时 hint=low-confidence 仍然生效', flat.ok && flat.value && flat.value.hint === 'low-confidence', flat.ok ? `hint=${JSON.stringify(flat.value && flat.value.hint)}` : `error=${flat.error}`)
  } finally {
    await p.dispose()
  }
})

// --- maskKey（P2-7 / H5）---------------------------------------------------

testCase('mask', 'maskKey：正常 key 4+4 掩码；短 key（≤12）只返回 "…"', async (t) => {
  const p = await openPlugin('mask', { envKey: MASK_KEY })
  try {
    const status = await p.hit('/status')
    t.assert('GET /status → 200（正常长度 key）', status.status === 200, `status=${status.status} error=${status.error || ''}`)
    const mask = normalizeMask(status.json && status.json.keyPrefix)
    const expected = `${MASK_KEY.slice(0, 4)}…${MASK_KEY.slice(-4)}`
    t.assert('正常长度 key 掩码为 4+4（sk-v…wxyz）', mask === expected, `keyPrefix=${JSON.stringify(status.json && status.json.keyPrefix)} 期望=${JSON.stringify(expected)}`)
    t.assert('掩码不含 Key 中段（不泄漏）', !mask.includes(MASK_KEY.slice(8, 16)), `keyPrefix=${JSON.stringify(mask)}`)
    t.assert('响应体不含完整 Key', !status.raw.includes(MASK_KEY), '扫描 /status 响应体')
  } finally {
    await p.dispose()
  }

  const short = await openPlugin('mask-short', { envKey: SHORT_KEY })
  try {
    const status = await short.hit('/status')
    t.assert('GET /status → 200（短 key）', status.status === 200, `status=${status.status}`)
    const mask = normalizeMask(status.json && status.json.keyPrefix)
    t.assert('短 key（12 字符）掩码只返回 "…"', mask === '…', `keyPrefix=${JSON.stringify(status.json && status.json.keyPrefix)}`)
    t.assert('短 key 不泄漏完整内容', !status.raw.includes(SHORT_KEY) && !mask.includes('SHORT'), `keyPrefix=${JSON.stringify(mask)}`)
  } finally {
    await short.dispose()
  }
})

// --- results.json 跨进程合并（P2-5 / H9）----------------------------------

testCase('results-merge', 'results.json 合并：磁盘上其他进程写入的条目在下次落盘后仍在', async (t) => {
  const p = await openPlugin('results-merge', { envKey: FAKE_KEY })
  try {
    const first = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION } }, 'call_smoke_A')
    t.assert('第一次成功调用返回', first.ok, first.ok ? '调用成功' : `error=${first.error}`)
    const afterFirst = await p.readResults()
    t.assert('第一次落盘包含 call_smoke_A', Boolean(afterFirst && Array.isArray(afterFirst.entries) && afterFirst.entries.some((entry) => entry.callId === 'call_smoke_A')), `entries=${afterFirst && afterFirst.entries && afterFirst.entries.map((entry) => entry.callId).join(',')}`)

    // 模拟另一个 Host 进程往磁盘追加条目（本进程内存里没有它）
    const store = (await p.readResults()) || { version: 1, entries: [] }
    store.entries = Array.isArray(store.entries) ? store.entries : []
    store.entries.push({
      callId: 'call_smoke_B',
      at: Date.now(),
      value: { model: FLASH, answers: { q: { type: 'noul', noul: 0.55 } } },
    })
    await writeJson(join(p.dataDir, 'results.json'), store)

    const second = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION } }, 'call_smoke_C')
    t.assert('第二次成功调用返回', second.ok, second.ok ? '调用成功' : `error=${second.error}`)

    const final = await p.readResults()
    const ids = final && Array.isArray(final.entries) ? final.entries.map((entry) => entry.callId) : []
    t.assert('最终文件包含本进程两次写盘的 call_smoke_A', ids.includes('call_smoke_A'), `entries=[${ids.join(',')}]`)
    t.assert('最终文件包含本次写盘的 call_smoke_C', ids.includes('call_smoke_C'), `entries=[${ids.join(',')}]`)
    t.assert('最终文件仍包含磁盘注入的另一进程条目 call_smoke_B', ids.includes('call_smoke_B'), `entries=[${ids.join(',')}]`)

    const replay = await p.hit('/result', { url: '/dsh-decision/result?callId=call_smoke_B' })
    t.assert('另一进程条目可从 /result 回放（200）', replay.status === 200, `status=${replay.status} body=${clip(replay.raw)}`)
  } finally {
    await p.dispose()
  }
})

// --- results.json 200 条上限 ----------------------------------------------

testCase('results-cap', 'results.json 上限：预置 250 条后落盘，文件条目 ≤200 且新条目保留', async (t) => {
  const now = Date.now()
  const entries = Array.from({ length: 250 }, (_, index) => ({
    callId: `call_seed_${String(index).padStart(3, '0')}`,
    at: now - (250 - index) * 1000,
    value: { model: FLASH, answers: { q: { type: 'noul', noul: 0.5 } } },
  }))
  const p = await openPlugin('results-cap', { envKey: FAKE_KEY, seedEntries: entries })
  try {
    const out = await p.ask({ state: STATE_OK, questions: { q: NOW_QUESTION } }, 'call_cap_new')
    t.assert('预置 250 条后仍能成功调用', out.ok, out.ok ? '调用成功' : `error=${out.error}`)
    const store = await p.readResults()
    const ids = store && Array.isArray(store.entries) ? store.entries.map((entry) => entry.callId) : []
    t.assert('落盘文件条目 ≤200', ids.length > 0 && ids.length <= 200, `entries=${ids.length}`)
    t.assert('新条目 call_cap_new 未被裁剪', ids.includes('call_cap_new'), `first=${ids[0]} last=${ids[ids.length - 1]} entries=${ids.length}`)
    t.assert('按“最新保留”淘汰最旧条目（call_seed_000 已淘汰）', !ids.includes('call_seed_000'), `entries=${ids.length}`)
  } finally {
    await p.dispose()
  }
})

// --- HTTP 守卫（P2-6 + P3 nosniff/Allow/Content-Type/client-report）---------

testCase('http', 'HTTP 守卫：Origin:null 403、Content-Type 校验、405 Allow、nosniff、client-report 空 body', async (t) => {
  const p = await openPlugin('http', { envKey: FAKE_KEY })
  try {
    const ok = await p.hit('/status')
    t.assert('GET /status → 200', ok.status === 200, httpDetail(ok))
    t.assert('JSON 响应带 x-content-type-options: nosniff', String(ok.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff', `headers.x-content-type-options=${JSON.stringify(ok.headers['x-content-type-options'])}`)

    const nullOrigin = await p.hit('/status', { headers: { origin: 'null' } })
    t.assert('GET /status 带 Origin: null → 403', nullOrigin.status === 403, httpDetail(nullOrigin))
    t.assert('403 响应也带 nosniff', String(nullOrigin.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff', `headers=${clip(Object.keys(nullOrigin.headers))}`)

    const badType = await p.hit('/config', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: { model: ULTRA },
    })
    t.assert('POST /config 带 content-type: text/plain 的 JSON body → 4xx', badType.status >= 400 && badType.status < 500, httpDetail(badType))

    const wrongMethod = await p.hit('/status', { method: 'POST' })
    t.assert('POST /status（方法不符）→ 405', wrongMethod.status === 405, httpDetail(wrongMethod))
    t.assert('405 响应头含 Allow 且包含 GET', Boolean(wrongMethod.headers.allow) && /GET/i.test(String(wrongMethod.headers.allow)), `headers.allow=${JSON.stringify(wrongMethod.headers.allow)}`)

    const emptyReport = await p.hit('/client-report', { method: 'POST', body: '' })
    t.assert('POST /client-report 空 body → 400', emptyReport.status === 400, httpDetail(emptyReport))

    const missing = await p.hit('/result', { url: '/dsh-decision/result?callId=call_missing_smoke' })
    t.assert('GET /result 未知 callId → 404', missing.status === 404, httpDetail(missing))
    t.assert('404 响应也带 nosniff', String(missing.headers['x-content-type-options'] || '').toLowerCase() === 'nosniff', `headers.x-content-type-options=${JSON.stringify(missing.headers['x-content-type-options'])}`)
  } finally {
    await p.dispose()
  }
})

// --- TTL -------------------------------------------------------------------

testCase('ttl', '结果缓存 TTL：2 小时前条目 /result → 404，1 分钟前 → 200', async (t) => {
  const now = Date.now()
  const p = await openPlugin('ttl', {
    envKey: FAKE_KEY,
    seedEntries: [
      { callId: 'call_ttl_expired', at: now - 2 * 60 * 60_000, value: { model: FLASH, answers: { q: { type: 'noul', noul: 0.9 } } } },
      { callId: 'call_ttl_fresh', at: now - 60_000, value: { model: FLASH, answers: { q: { type: 'noul', noul: 0.9 } } } },
    ],
  })
  try {
    const expired = await p.hit('/result', { url: '/dsh-decision/result?callId=call_ttl_expired' })
    t.assert('2 小时前条目（超过 1h TTL）→ 404', expired.status === 404, `status=${expired.status} body=${clip(expired.raw)}`)
    const fresh = await p.hit('/result', { url: '/dsh-decision/result?callId=call_ttl_fresh' })
    t.assert('1 分钟前条目（TTL 内）→ 200', fresh.status === 200, `status=${fresh.status} body=${clip(fresh.raw)}`)
    t.assert('TTL 内条目返回结构化 value', Boolean(fresh.json && fresh.json.callId === 'call_ttl_fresh' && fresh.json.value && fresh.json.value.answers), `body=${clip(fresh.raw)}`)
  } finally {
    await p.dispose()
  }
})

// --- settingsCache 外部失效（P3）------------------------------------------

testCase('settings-cache', 'config.json 被外部修改后 /status 立即可见（settingsCache 失效）', async (t) => {
  const p = await openPlugin('settings-cache', { seedConfig: { model: FLASH, baseUrl: 'https://decision.vllm-sr.ai' } })
  try {
    const first = await p.hit('/status')
    t.assert('初次 GET /status 读到 vllm-sr/d3-flash', Boolean(first.status === 200 && first.json && first.json.model === FLASH), `model=${first.json && first.json.model}`)

    await writeJson(join(p.dataDir, 'config.json'), { model: ULTRA, baseUrl: 'https://decision.vllm-sr.ai' })
    const second = await p.hit('/status', { url: '/dsh-decision/status?refresh=1' })
    t.assert('外部改写 config.json 后 /status 读到 vllm-sr/d3-ultra', Boolean(second.status === 200 && second.json && second.json.model === ULTRA), `model=${second.json && second.json.model}（若仍为 flash 说明进程内 settings 缓存未失效）`)
  } finally {
    await p.dispose()
  }
})

// ---------------------------------------------------------------------------
// box 并发（VERIFY-2026-10-29.md §6.1：上游同一 key+model 同时只允许 1 个 box 请求）
// ---------------------------------------------------------------------------

testCase('box-serial', 'box 并发：同一 key+model 的 3 个并发 box 调用串行（在途 ≤1）且全部成功', async (t) => {
  const tracked = makeTrackingFetch({ delayMs: 120 })
  const p = await openPlugin('box-serial', { envKey: FAKE_KEY, fetchHandler: tracked.handler })
  try {
    await p.warmInfo()
    const started = Date.now()
    const outcomes = await Promise.all([
      p.ask(boxArgs(), 'call_box_serial_1'),
      p.ask(boxArgs(), 'call_box_serial_2'),
      p.ask(boxArgs(), 'call_box_serial_3'),
    ])
    const elapsed = Date.now() - started
    t.assert(
      '3 个并发 box 调用全部成功',
      outcomes.every((outcome) => outcome.ok),
      outcomes.map((outcome, index) => `#${index + 1}=${outcome.ok ? 'ok' : outcome.error}`).join(' | '),
    )
    t.assert(
      '同一 key+model 的 box 请求在途数量 ≤1（Host 内串行）',
      tracked.state.peak <= 1,
      `在途峰值=${tracked.state.peak} 请求总数=${tracked.state.total}`,
    )
    t.assert('3 个 box 请求都实际发出（未丢请求）', tracked.state.total === 3, `total=${tracked.state.total}`)
    t.assert(
      '串行执行耗时 ≥300ms（3 个 120ms 请求排队；并发执行应约 120ms）',
      elapsed >= 300,
      `elapsed=${elapsed}ms`,
    )
  } finally {
    await p.dispose()
  }
})

testCase('box-parallel-nonbox', '非 box 并发：3 个并发 decision_ask 可重叠（在途 >1，未被误串行）', async (t) => {
  const tracked = makeTrackingFetch({ delayMs: 120 })
  const p = await openPlugin('box-parallel-nonbox', { envKey: FAKE_KEY, fetchHandler: tracked.handler })
  try {
    await p.warmInfo()
    const outcomes = await Promise.all([
      p.ask(noulArgs(), 'call_nonbox_parallel_1'),
      p.ask(noulArgs(), 'call_nonbox_parallel_2'),
      p.ask(noulArgs(), 'call_nonbox_parallel_3'),
    ])
    t.assert(
      '3 个并发非 box 调用全部成功',
      outcomes.every((outcome) => outcome.ok),
      outcomes.map((outcome, index) => `#${index + 1}=${outcome.ok ? 'ok' : outcome.error}`).join(' | '),
    )
    t.assert(
      '非 box 请求在途峰值 > 1（保持并行，未被 box 队列误串行）',
      tracked.state.peak > 1,
      `在途峰值=${tracked.state.peak} 请求总数=${tracked.state.total}`,
    )
    t.assert('3 个非 box 请求都实际发出', tracked.state.total === 3, `total=${tracked.state.total}`)
  } finally {
    await p.dispose()
  }
})

testCase('box-multimodel', 'box 并发：同一 key 不同 model 的 2 个 box 调用可重叠（串行键含 model）', async (t) => {
  const tracked = makeTrackingFetch({ delayMs: 120 })
  const p = await openPlugin('box-multimodel', { envKey: FAKE_KEY, fetchHandler: tracked.handler })
  try {
    await p.warmInfo()
    const outcomes = await Promise.all([
      p.ask(boxArgs(FLASH), 'call_box_model_flash'),
      p.ask(boxArgs(ULTRA), 'call_box_model_ultra'),
    ])
    t.assert(
      '不同 model 的 2 个并发 box 调用全部成功',
      outcomes.every((outcome) => outcome.ok),
      outcomes.map((outcome, index) => `#${index + 1}=${outcome.ok ? 'ok' : outcome.error}`).join(' | '),
    )
    t.assert(
      '同 key 不同 model 的 box 请求可重叠（在途峰值 =2）',
      tracked.state.peak === 2,
      `在途峰值=${tracked.state.peak} 请求总数=${tracked.state.total}`,
    )
  } finally {
    await p.dispose()
  }
})

/** 上游 429 concurrency_limit 的响应体（与真实服务文案一致）。 */
function concurrencyLimitResponse() {
  return jsonResponse(
    {
      error: {
        code: 'concurrency_limit',
        message: 'one Box request at a time per API key and model; send the next one when it finishes',
      },
    },
    { status: 429 },
  )
}

testCase('box-retry-429', 'box 并发：429 concurrency_limit 等待约 1500ms 重试一次后成功', async (t) => {
  const state = { total: 0 }
  const p = await openPlugin('box-retry-429', {
    envKey: FAKE_KEY,
    fetchHandler: (record) => {
      if (record.path !== '/v1/systemone') return defaultFetchHandler(record)
      state.total += 1
      return state.total === 1 ? concurrencyLimitResponse() : jsonResponse(successAnswer())
    },
  })
  try {
    await p.warmInfo()
    const started = Date.now()
    const outcome = await p.ask(boxArgs(), 'call_box_retry_ok')
    const elapsed = Date.now() - started
    t.assert('第一次 429 后自动重试成功', outcome.ok, outcome.ok ? '调用成功' : `error=${outcome.error}`)
    t.assert(
      '只重试一次（/v1/systemone 共 2 次）',
      p.systemones().length === 2 && state.total === 2,
      `systemone=${p.systemones().length} total=${state.total}`,
    )
    t.assert('重试前等待约 1500ms（实测 ≥1300ms）', elapsed >= 1300, `elapsed=${elapsed}ms`)
  } finally {
    await p.dispose()
  }
})

testCase('box-retry-exhausted', 'box 并发：两次 429 后原样抛错（保留 status=429 / code=concurrency_limit）', async (t) => {
  const p = await openPlugin('box-retry-exhausted', {
    envKey: FAKE_KEY,
    fetchHandler: (record) => (record.path === '/v1/systemone' ? concurrencyLimitResponse() : defaultFetchHandler(record)),
  })
  try {
    await p.warmInfo()
    const started = Date.now()
    const outcome = await p.ask(boxArgs(), 'call_box_retry_fail')
    const elapsed = Date.now() - started
    t.assert('两次 429 后调用失败（不无限重试）', !outcome.ok, outcome.ok ? '意外成功' : outcome.error)
    t.assert('只重试一次（/v1/systemone 共 2 次）', p.systemones().length === 2, `systemone=${p.systemones().length}`)
    t.assert(
      '错误保留 status=429',
      Boolean(outcome.errorObject && outcome.errorObject.status === 429),
      `status=${outcome.errorObject && outcome.errorObject.status}`,
    )
    t.assert(
      "错误保留 code='concurrency_limit'",
      Boolean(outcome.errorObject && outcome.errorObject.code === 'concurrency_limit'),
      `code=${outcome.errorObject && outcome.errorObject.code}`,
    )
    t.assert(
      '错误文案可读（含 concurrency_limit / one Box request at a time）',
      /concurrency_limit|one Box request at a time/i.test(outcome.error || ''),
      `error=${outcome.error}`,
    )
    t.assert('两次尝试之间仍等待约 1500ms（实测 ≥1300ms）', elapsed >= 1300, `elapsed=${elapsed}ms`)
  } finally {
    await p.dispose()
  }
})

testCase('box-queue-abort', 'box 并发：排队中被 abort 立即失败、不占队列，后续请求正常', async (t) => {
  const tracked = makeTrackingFetch({ delayMs: 300 })
  const p = await openPlugin('box-queue-abort', { envKey: FAKE_KEY, fetchHandler: tracked.handler })
  try {
    await p.warmInfo()
    const controller = new AbortController()
    const first = p.ask(boxArgs(), 'call_box_abort_1')
    await sleep(40)
    const queuedStarted = Date.now()
    const second = p.ask(boxArgs(), 'call_box_abort_2', { signal: controller.signal })
    await sleep(50)
    controller.abort()
    const secondOutcome = await second
    const secondElapsed = Date.now() - queuedStarted
    const firstOutcome = await first
    const thirdOutcome = await p.ask(boxArgs(), 'call_box_abort_3')

    t.assert('第一个（在途）box 请求照常成功', firstOutcome.ok, firstOutcome.ok ? '调用成功' : `error=${firstOutcome.error}`)
    t.assert('排队中的第二个 box 请求被 abort 后失败', !secondOutcome.ok, secondOutcome.ok ? '意外成功（abort 未生效）' : secondOutcome.error)
    t.assert(
      'abort 立即生效（排队即失败 <200ms，不必等前一个网络请求结束）',
      secondElapsed < 200,
      `排队后 ${secondElapsed}ms 才失败（在途请求延迟 300ms；若约 300ms 说明 abort 只在出队时检查）`,
    )
    t.assert(
      '被 abort 的排队请求没有发出 /v1/systemone（总数=2：第一个 + 第三个）',
      tracked.state.total === 2,
      `systemone 总数=${tracked.state.total}`,
    )
    t.assert('队列未被 abort 卡死：后续第三个 box 请求正常完成', thirdOutcome.ok, thirdOutcome.ok ? '调用成功' : `error=${thirdOutcome.error}`)
  } finally {
    await p.dispose()
  }
})

// ---------------------------------------------------------------------------
// 运行器
// ---------------------------------------------------------------------------

function printSummary(moduleFailure) {
  const pass = results.filter((item) => item.ok === true).length
  const fail = results.filter((item) => item.ok === false).length
  console.log('\n=== SUMMARY ===')
  console.log(`total=${results.length} pass=${pass} fail=${fail}`)
  if (fail > 0) {
    console.log('FAILED:')
    for (const item of results.filter((entry) => entry.ok === false)) {
      console.log(`  - ${item.caseId} · ${item.name}${item.detail ? ` — ${clip(item.detail, 300)}` : ''}`)
    }
  }
  if (moduleFailure) {
    console.log('\nFATAL: index.js 当前无法被 import（很可能正处于编辑中间态）。后续用例已跳过，等修复完成后再跑。')
    console.log(`原因: ${messageOf(moduleFailure)}`)
    const stack = moduleFailure.cause && moduleFailure.cause.stack ? moduleFailure.cause.stack : ''
    if (stack) console.log(`位置:\n${stack.split('\n').slice(0, 6).join('\n')}`)
  }
  return { pass, fail, total: results.length }
}

async function main() {
  console.log(`dsh-decision Host 回归 harness`)
  console.log(`  index.js   : ${INDEX_PATH}`)
  console.log(`  临时 DSH_HOME 根目录: ${TMP_ROOT}${KEEP ? '（保留）' : ''}`)
  if (ONLY) console.log(`  过滤: 只跑 id 含 "${ONLY}" 的用例`)

  await mkdir(TMP_ROOT, { recursive: true })

  const started = Date.now()
  let moduleFailure = null
  let skipped = 0

  for (const item of CASES) {
    if (ONLY && !item.id.includes(ONLY)) continue
    if (moduleFailure) {
      skipped += 1
      continue
    }
    caseIndex += 1
    console.log(`\n--- ${item.id} · ${item.title}`)
    const recorder = new Recorder(item.id, item.title)
    try {
      await item.fn(recorder)
    } catch (error) {
      if (error && error.moduleLoad) {
        moduleFailure = error
        recorder.assert('index.js 可被 import（模块可加载）', false, `${messageOf(error)}${error.cause && error.cause.stack ? ` | ${error.cause.stack.split('\n').slice(0, 3).join(' | ')}` : ''}`)
      } else {
        recorder.assert('用例执行未抛错', false, `${error && error.name ? error.name : 'Error'}: ${messageOf(error)}${error && error.stack ? ` | ${error.stack.split('\n').slice(1, 3).map((line) => line.trim()).join(' | ')}` : ''}`)
      }
    }
  }

  const summary = printSummary(moduleFailure)
  if (skipped > 0) console.log(`skipped=${skipped}（因 index.js 不可加载）`)
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n耗时 ${elapsed}s；命令: node scripts/smoke-regressions.mjs${ONLY ? ` --only=${ONLY}` : ''}`)
  if (summary.fail === 0) console.log('结果: 全部断言通过 ✅')
  else console.log(`结果: ${summary.fail} 条断言失败 ❌（详见上方 FAIL 行）`)

  globalThis.fetch = REAL_FETCH
  process.env.DSH_HOME = ORIGINAL_HOME
  if (ORIGINAL_KEY === undefined) delete process.env.DECISION_API_KEY
  else process.env.DECISION_API_KEY = ORIGINAL_KEY
  if (!KEEP) {
    try {
      await rm(TMP_ROOT, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响结果
    }
  }
  process.exitCode = summary.fail === 0 && !moduleFailure ? 0 : 1
}

main().catch((error) => {
  globalThis.fetch = REAL_FETCH
  console.error(`\nharness 自身异常: ${messageOf(error)}`)
  if (error && error.stack) console.error(error.stack)
  process.exitCode = 1
})
