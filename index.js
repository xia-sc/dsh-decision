/**
 * @xia-sc/dsh-decision — Host half.
 *
 * Registers two agent tools and a small same-origin HTTP surface for the
 * Client half (Settings page + decision card):
 *
 *   decision_ask   POST /v1/systemone   — calibrated probabilities / boxes
 *   decision_info  /api/info, /api/keys/self, /api/status
 *
 *   GET  /dsh-decision/status           — settings page data
 *   POST /dsh-decision/config           — save API key / default model
 *   GET  /dsh-decision/result?callId=…  — structured result for the card
 *
 * No npm dependencies: only node: builtins and cordis ctx services. The API
 * key lives in `ctx.credentials` (ref DECISION_API_KEY) with a $DSH_HOME file
 * fallback; every file the plugin owns sits in $DSH_HOME/dsh-decision/.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, chmod, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'dsh-decision'

const DEFAULT_BASE_URL = 'https://decision.vllm-sr.ai'
const DEFAULT_MODEL = 'vllm-sr/d3-flash'
const KEY_REF = 'DECISION_API_KEY'
const ROUTE_PREFIX = '/dsh-decision'
const INFO_TTL_MS = 600_000
const CACHE_LIMIT = 200
const CACHE_TTL_MS = 60 * 60_000
const REQUEST_TIMEOUT_MS = 35_000
const TOOL_TIMEOUT_MS = 60_000
const KEY_VERIFY_TIMEOUT_MS = 8_000
const USAGE_TOOL_TIMEOUT_MS = 15_000
const MAX_BODY_BYTES = 64 * 1024
/**
 * Limits used when /api/info is not cached yet. A model entry's own limits always
 * win: d3-ultra accepts 131072 state characters and 16 images, the rest 32000 and 4.
 */
const FALLBACK_LIMITS = {
  max_state_chars: 32_000,
  max_questions: 64,
  max_images: 4,
  max_image_bytes: 8_000_000,
  max_videos: 1,
  max_video_bytes: 32_000_000,
}
/** Aggregate base64 payload per call: 16 x 16MB would otherwise sit in memory at once. */
const MAX_MEDIA_B64_BYTES = 40 * 1024 * 1024

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

// Every file this plugin owns lives in one directory, so $DSH_HOME itself stays
// clean: $DSH_HOME/dsh-decision/{config.json,results.json}. 0.1.0-0.1.3 wrote
// two dotfiles straight into $DSH_HOME; the first use migrates and removes them.
const DATA_DIR = join(DSH_HOME, 'dsh-decision')
const SETTINGS_PATH = join(DATA_DIR, 'config.json')
const RESULTS_PATH = join(DATA_DIR, 'results.json')
const LEGACY_SETTINGS_PATH = join(DSH_HOME, '.dsh-decision.json')
const LEGACY_RESULTS_PATH = join(DSH_HOME, '.dsh-decision-results.json')

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
const VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.qt': 'video/quicktime',
  '.mkv': 'video/x-matroska',
}
const IMAGE_MIMES = new Set(Object.values(IMAGE_MIME))
const VIDEO_MIMES = new Set(Object.values(VIDEO_MIME))

const QUESTION_TYPES = ['choice', 'noul', 'score', 'box']

// ---------------------------------------------------------------------------
// data directory (created on demand; legacy dotfiles migrated once)
// ---------------------------------------------------------------------------

let dataDirReady = null

/** Idempotent, cheap after the first call. */
function ensureDataDir() {
  if (!dataDirReady) {
    dataDirReady = migrateLegacyData().catch(() => {
      dataDirReady = null // let the next call retry (e.g. transient EPERM)
    })
  }
  return dataDirReady
}

async function migrateLegacyData() {
  await mkdir(DATA_DIR, { recursive: true })
  await migrateLegacyFile(LEGACY_SETTINGS_PATH, SETTINGS_PATH)
  await migrateLegacyFile(LEGACY_RESULTS_PATH, RESULTS_PATH)
}

/**
 * Move one pre-0.1.4 dotfile into the data directory. If the destination already
 * exists we keep the old file as a backup under dsh-decision/legacy/ rather than
 * dropping data; either way the dotfile leaves $DSH_HOME.
 */
async function migrateLegacyFile(from, to) {
  let raw
  try {
    raw = await readFile(from, 'utf8')
  } catch {
    return // nothing to migrate
  }
  let targetExists = true
  try {
    await readFile(to, 'utf8')
  } catch {
    targetExists = false
  }
  if (targetExists) {
    const backupBase = join(DATA_DIR, 'legacy', `${basename(from)}.bak`)
    await mkdir(dirname(backupBase), { recursive: true })
    // Never overwrite an older backup: a second migration round gets its own file.
    let backup = backupBase
    try {
      await readFile(backupBase)
      backup = `${backupBase}.${Date.now()}`
    } catch {
      backup = backupBase
    }
    await writeFile(backup, raw, { encoding: 'utf8', mode: 0o600 })
  } else {
    await writeFile(to, raw, { encoding: 'utf8', mode: 0o600 })
  }
  await rm(from, { force: true })
}

// ---------------------------------------------------------------------------
// settings file (default model only; the key normally lives in credentials)
// ---------------------------------------------------------------------------

/**
 * Raw settings file content. The file is shared by two writers — model/baseUrl
 * saves and the API-key fallback used when no `credentials` service exists — so
 * it is always read and written as a whole object: a writer that only knows its
 * own fields must not drop the other's (0.1.4 did, and lost the stored key).
 */
async function readSettingsFile() {
  await ensureDataDir()
  try {
    const value = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
    return isPlainObject(value) ? value : {}
  } catch {
    return {}
  }
}

function normalizeBaseUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''
}

/** The view the rest of the plugin consumes; unknown fields stay untouched on disk. */
function deriveSettings(file) {
  return {
    model: typeof file.model === 'string' && file.model.trim() ? file.model.trim() : DEFAULT_MODEL,
    baseUrl: normalizeBaseUrl(file.baseUrl) || DEFAULT_BASE_URL,
  }
}

async function readSettings() {
  return deriveSettings(await readSettingsFile())
}

/** Atomic JSON write; a failed write removes its temp file instead of littering the data dir. */
async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  try {
    await chmod(path, 0o600)
  } catch {
    // Windows has no POSIX mode; the ACL governs access there.
  }
}

async function writeSettings(patch) {
  const file = await readSettingsFile()
  const next = { ...file }
  if (patch.model !== undefined) {
    const model = typeof patch.model === 'string' ? patch.model.trim() : ''
    next.model = model || (typeof file.model === 'string' ? file.model : '') || DEFAULT_MODEL
  }
  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl) || DEFAULT_BASE_URL
  await writeJsonAtomic(SETTINGS_PATH, next)
  return deriveSettings(next)
}

async function resolveApiKey(ctx) {
  const envKey = typeof process.env.DECISION_API_KEY === 'string' ? process.env.DECISION_API_KEY.trim() : ''
  if (envKey) return envKey
  const credentials = ctx.get ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(KEY_REF)
      // LocalCredentialProvider resolves to { value, source }; tolerate a bare string too.
      const value =
        typeof resolved === 'string'
          ? resolved
          : resolved && typeof resolved.value === 'string'
            ? resolved.value
            : ''
      if (value.trim()) return value.trim()
    } catch {
      // fall through to the file
    }
  }
  const file = await readSettingsFile()
  if (typeof file.apiKey === 'string' && file.apiKey.trim()) return file.apiKey.trim()
  return ''
}

async function saveApiKey(ctx, apiKey) {
  const credentials = ctx.get ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.set === 'function') {
    await credentials.set(KEY_REF, apiKey)
    return 'credentials'
  }
  // Fallback: keep it beside the default model, owner-readable only. Read-modify-write
  // so a concurrent model save cannot drop the key (and vice versa).
  const file = await readSettingsFile()
  file.apiKey = apiKey
  await writeJsonAtomic(SETTINGS_PATH, file)
  return 'file'
}

/** POST /config {"apiKey":""}: remove the stored key from whichever store holds it. */
async function clearApiKey(ctx) {
  const credentials = ctx.get ? ctx.get('credentials') : undefined
  if (credentials) {
    const remove = typeof credentials.delete === 'function' ? credentials.delete : credentials.remove
    if (typeof remove === 'function') {
      try {
        await remove.call(credentials, KEY_REF)
      } catch {
        // the file fallback below may still hold a copy
      }
    }
  }
  const file = await readSettingsFile()
  if (Object.prototype.hasOwnProperty.call(file, 'apiKey')) {
    delete file.apiKey
    await writeJsonAtomic(SETTINGS_PATH, file)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}${path}`
}

async function apiRequest(ctx, options) {
  const settings = await readSettings()
  const baseUrl = options.baseUrl || settings.baseUrl
  const headers = {}
  if (options.key) headers['X-API-Key'] = options.key
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('request timeout')),
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS,
  )
  const outer = options.signal
  const onOuterAbort = () => controller.abort(outer.reason)
  if (outer) {
    if (outer.aborted) onOuterAbort()
    else outer.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    let response
    try {
      response = await fetch(joinUrl(baseUrl, options.path), {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
    } catch (error) {
      if (controller.signal.aborted) throw error
      // undici reports a bare "fetch failed"; the interesting part is error.cause
      // (ECONNRESET / ENOTFOUND / TLS), so surface it instead of losing it.
      const cause = error && error.cause
      const detail = cause && (cause.code || cause.message) ? `: ${cause.code || cause.message}` : ''
      const wrapped = new Error(
        `Decision API request failed: ${error && error.message ? error.message : String(error)}${detail}`,
      )
      wrapped.code = 'network_error'
      throw wrapped
    }
    const res = response
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    const requestId = res.headers.get('x-request-id') || undefined
    if (!res.ok) {
      const apiError = json && typeof json === 'object' ? json.error : undefined
      const code = (apiError && (apiError.code || apiError.type)) || `http_${res.status}`
      const message = (apiError && apiError.message) || text.slice(0, 300) || res.statusText
      const retryAfter = res.headers.get('retry-after') || undefined
      const error = new Error(`Decision API ${res.status} ${code}: ${message}`)
      error.code = code
      error.status = res.status
      error.retryAfter = retryAfter
      throw error
    }
    return { json, text, status: res.status, requestId }
  } finally {
    clearTimeout(timer)
    if (outer) outer.removeEventListener('abort', onOuterAbort)
  }
}

async function fetchInfo(ctx, { force = false, timeoutMs } = {}) {
  const now = Date.now()
  if (!force && infoCache && now - infoCache.at < INFO_TTL_MS) return infoCache.value
  try {
    const { json } = await apiRequest(ctx, { path: '/api/info', timeoutMs })
    infoCache = { at: now, value: json }
    return json
  } catch (error) {
    // The models list changes slowly: an expired snapshot beats an empty table.
    if (infoCache) return infoCache.value
    throw error
  }
}
let infoCache = null

/** Cached /api/info only: local validation must not spend a network round trip. */
function cachedInfo() {
  return infoCache && Date.now() - infoCache.at < INFO_TTL_MS ? infoCache.value : null
}

async function fetchSelf(ctx, key, timeoutMs) {
  if (!key) return null
  const { json } = await apiRequest(ctx, { path: '/api/keys/self', key, timeoutMs })
  return json
}

async function fetchUsage(ctx, key, timeoutMs) {
  if (!key) return null
  const { json } = await apiRequest(ctx, { path: '/api/keys/self/usage', key, timeoutMs })
  return json
}

// ---------------------------------------------------------------------------
// box request serialization
// ---------------------------------------------------------------------------
// The service serves one box request at a time per API key + model and answers a
// concurrent second one with 429 concurrency_limit. decision_ask is registered as
// concurrency safe, so parallel agents would otherwise fail; serialize those
// requests inside this process (keyed by a hash of the key + the model) and retry
// a cross-process collision once below. Non-box requests keep running in parallel.
const boxChains = new Map()
const BOX_RETRY_DELAY_MS = 1_500

function boxLockKey(key, model) {
  const digest = createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
  return `${digest}:${model}`
}

/** Queue `task` behind the previous box request for the same key + model. */
function serializeBox(lockKey, task) {
  const previous = boxChains.get(lockKey) || Promise.resolve()
  const run = previous.then(task, task)
  // The chain itself must never reject, or every later request inherits the failure.
  const tail = run.then(
    () => {},
    () => {},
  )
  boxChains.set(lockKey, tail)
  tail.then(() => {
    if (boxChains.get(lockKey) === tail) boxChains.delete(lockKey)
  })
  return run
}

function isBoxConcurrencyError(error) {
  if (!error || error.status !== 429) return false
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : ''
  if (code.includes('concurrency')) return true
  const message = typeof error.message === 'string' ? error.message.toLowerCase() : ''
  return message.includes('concurrency_limit') || message.includes('one box request at a time')
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new Error('aborted'))
      return
    }
    let timer = null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      reject(signal.reason || new Error('aborted'))
    }
    timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw signal.reason || new Error('aborted')
}

/** Settle with `promise`, but fail immediately when the caller aborts while queued. */
function abortRace(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason || new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * POST to the decision API and retry once when another process (or another key
 * holder) still owns the box slot; any other error is surfaced unchanged.
 */
async function requestDecision(ctx, options) {
  try {
    return await apiRequest(ctx, options)
  } catch (error) {
    if (!isBoxConcurrencyError(error)) throw error
    await delay(BOX_RETRY_DELAY_MS, options.signal)
    return apiRequest(ctx, options)
  }
}

// ---------------------------------------------------------------------------
// media handling
// ---------------------------------------------------------------------------

function normalizeMediaEntry(entry) {
  return typeof entry === 'string' ? entry.trim() : ''
}

function extensionOf(path) {
  const match = /(\.[A-Za-z0-9]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

/** `data:<mime>[;...];base64,<payload>` — the same whitelist and byte limits as a file. */
function parseDataUrl(entry, kind) {
  const comma = entry.indexOf(',')
  if (comma < 0) throw new Error(`${kind} data: URL is missing the "," separator`)
  const header = entry.slice('data:'.length, comma)
  const payload = entry.slice(comma + 1)
  const parts = header.split(';').map((part) => part.trim()).filter(Boolean)
  const mime = (parts[0] || '').toLowerCase()
  const allowed = kind === 'image' ? IMAGE_MIMES : VIDEO_MIMES
  if (!allowed.has(mime)) {
    throw new Error(`unsupported ${kind} data: MIME "${mime || '(none)'}": use one of ${[...allowed].join(', ')}`)
  }
  if (!parts.slice(1).some((part) => part.toLowerCase() === 'base64')) {
    throw new Error(`${kind} data: URL must be base64 encoded (data:${mime};base64,...)`)
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error(`${kind} data: URL payload is not valid base64`)
  }
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return { mime, bytes: Math.floor((payload.length * 3) / 4) - padding }
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)
}

async function loadMediaDataUrl(entry, kind, limits) {
  const limit = kind === 'image' ? limits.max_image_bytes : limits.max_video_bytes
  if (entry.startsWith('data:')) {
    const { bytes } = parseDataUrl(entry, kind)
    if (bytes > limit) {
      throw new Error(
        `${kind} data: URL is ${megabytes(bytes)} MB, over the ${megabytes(limit)} MB limit of the selected model`,
      )
    }
    return entry
  }
  const mimeMap = kind === 'image' ? IMAGE_MIME : VIDEO_MIME
  const ext = extensionOf(entry)
  const mime = mimeMap[ext]
  if (!mime) {
    const allowed = Object.keys(mimeMap).join(', ')
    throw new Error(`unsupported ${kind} extension "${ext || '(none)'}": use one of ${allowed} or a data: URL`)
  }
  let bytes
  try {
    bytes = await readFile(entry)
  } catch (error) {
    // Only the basename goes into the error: it may end up in a session log.
    throw new Error(
      `cannot read ${kind} file "${basename(entry)}": ${error && error.message ? error.message : String(error)}`,
    )
  }
  if (bytes.length > limit) {
    throw new Error(
      `${kind} file "${basename(entry)}" is ${megabytes(bytes.length)} MB, over the ${megabytes(limit)} MB limit of the selected model`,
    )
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function buildMedia(list, kind, limits) {
  if (!Array.isArray(list) || list.length === 0) return []
  const entries = list.map(normalizeMediaEntry).filter(Boolean)
  const maxCount = kind === 'image' ? limits.max_images : limits.max_videos
  if (entries.length > maxCount) {
    throw new Error(`at most ${maxCount} ${kind}(s) per request for the selected model; got ${entries.length}`)
  }
  const out = []
  let total = 0
  for (const entry of entries) {
    const dataUrl = await loadMediaDataUrl(entry, kind, limits)
    total += dataUrl.length
    if (total > MAX_MEDIA_B64_BYTES) {
      throw new Error(
        `media payload is over the ${megabytes(MAX_MEDIA_B64_BYTES)} MB aggregate limit for one request; split it into several calls`,
      )
    }
    out.push(dataUrl)
  }
  return out
}

// ---------------------------------------------------------------------------
// question validation
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateQuestion(id, question) {
  const where = `question "${id}"`
  if (!isPlainObject(question)) throw new Error(`${where} must be an object`)
  const { type, instructions, criteria } = question
  if (typeof type !== 'string' || !QUESTION_TYPES.includes(type)) {
    throw new Error(`${where}: type must be one of ${QUESTION_TYPES.join(', ')}`)
  }
  if (typeof instructions !== 'string' || instructions.trim().length === 0) {
    throw new Error(`${where}: instructions must be a non-empty string`)
  }
  if (type === 'choice') {
    if (!isPlainObject(criteria)) throw new Error(`${where}: choice needs criteria { optionId: description }`)
    const options = Object.keys(criteria)
    if (options.length < 2) throw new Error(`${where}: choice needs at least 2 criteria options`)
    for (const option of options) {
      const description = criteria[option]
      if (description !== null && typeof description !== 'string') {
        throw new Error(`${where}: criteria "${option}" must be a string or null`)
      }
    }
    return { type, instructions, criteria }
  }
  if (type === 'noul') {
    if (criteria !== undefined) {
      if (!isPlainObject(criteria)) throw new Error(`${where}: noul criteria must be {"false": ..., "true": ...}`)
      for (const key of Object.keys(criteria)) {
        if (key !== 'false' && key !== 'true') throw new Error(`${where}: noul criteria only accepts "false"/"true"`)
      }
    }
    return criteria === undefined ? { type, instructions } : { type, instructions, criteria }
  }
  if (type === 'score') {
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
      throw new Error(`${where}: score needs criteria as an ordered array of 2 to 10 level descriptions`)
    }
    for (const level of criteria) {
      if (typeof level !== 'string' || level.trim().length === 0) {
        throw new Error(`${where}: every score level must be a non-empty string`)
      }
    }
    return { type, instructions, criteria }
  }
  // box
  return { type, instructions }
}

function buildQuestions(raw, maxQuestions = FALLBACK_LIMITS.max_questions) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new Error('questions must be a non-empty object mapping question ids to question definitions')
  }
  const ids = Object.keys(raw)
  if (ids.length > maxQuestions) {
    throw new Error(`at most ${maxQuestions} questions per request; got ${ids.length}`)
  }
  const questions = {}
  let boxCount = 0
  for (const id of ids) {
    const validated = validateQuestion(id, raw[id])
    if (validated.type === 'box') boxCount += 1
    questions[id] = validated
  }
  return { questions, boxCount }
}

// ---------------------------------------------------------------------------
// model resolution (published ids plus their aliases) and per-model limits
// ---------------------------------------------------------------------------

/** Find a published model by canonical id or one of its aliases. */
function findModelEntry(info, model) {
  if (!info || !Array.isArray(info.models)) return null
  const wanted = typeof model === 'string' ? model.trim() : ''
  if (!wanted) return null
  for (const entry of info.models) {
    if (!isPlainObject(entry)) continue
    if (entry.id === wanted) return entry
    if (Array.isArray(entry.aliases) && entry.aliases.includes(wanted)) return entry
  }
  return null
}

function modelIds(info) {
  if (!info || !Array.isArray(info.models)) return ''
  return info.models
    .filter(isPlainObject)
    .map((entry) => entry.id)
    .filter((id) => typeof id === 'string')
    .join(', ')
}

/**
 * Per-model limits, falling back to the published global limits and then to the
 * conservative defaults. /api/info publishes both, with the model entry winning.
 */
function limitsFor(info, model) {
  const globalLimits = info && isPlainObject(info.limits) ? info.limits : {}
  const entry = findModelEntry(info, model)
  const modelLimits = entry && isPlainObject(entry.limits) ? entry.limits : {}
  const merged = { ...FALLBACK_LIMITS, ...globalLimits, ...modelLimits }
  const limits = {}
  for (const [key, fallback] of Object.entries(FALLBACK_LIMITS)) {
    const value = merged[key]
    limits[key] = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  }
  return limits
}

/**
 * Canonical model id plus the limits that apply to it. Validation uses the cached
 * model list only: a malformed request must be rejected without touching the
 * network. An explicit model on a cold cache asks for the list once, so an alias
 * or an unknown id still gets a precise answer instead of a server 403.
 */
async function resolveAskTarget(ctx, requested, settings) {
  let info = cachedInfo()
  const wanted = typeof requested === 'string' && requested.trim() ? requested.trim() : settings.model
  if (!info && typeof requested === 'string' && requested.trim()) {
    try {
      info = await fetchInfo(ctx, { timeoutMs: 5_000 })
    } catch {
      info = null
    }
  }
  const entry = findModelEntry(info, wanted)
  if (info && !entry) {
    const known = modelIds(info)
    throw new Error(
      `unknown model "${wanted}"${known ? `; available: ${known}` : ''}. Use decision_info action "models" for the current list.`,
    )
  }
  return {
    model: entry && typeof entry.id === 'string' ? entry.id : wanted,
    limits: limitsFor(info, wanted),
  }
}

// ---------------------------------------------------------------------------
// result formatting
// ---------------------------------------------------------------------------

function percent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  // Clamp for display: a probability or box coordinate outside [0,1] is bad data,
  // and printing 150% / -50% in a tool result only confuses the reader.
  const bounded = Math.max(0, Math.min(1, value))
  return `${(bounded * 100).toFixed(1)}%`
}

function fixed(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

/** A distribution at least this flat is not a usable answer; report it as uncertain instead. */
const LOW_TOP_PROBABILITY = 0.6
const LOW_CONFIDENCE = 0.5

function confidenceCheck(answer) {
  if (answer.type === 'choice') {
    const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : null
    const values = probabilities
      ? Object.values(probabilities).filter((value) => typeof value === 'number' && Number.isFinite(value))
      : []
    if (!probabilities || values.length === 0) {
      return { low: true, reason: 'no usable probability distribution was returned' }
    }
    const top = Math.max(...values)
    if (top < LOW_TOP_PROBABILITY) return { low: true, reason: `the top probability is only ${percent(top)}` }
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
      return { low: true, reason: 'the answer carries no confidence score' }
    }
    if (answer.confidence < LOW_CONFIDENCE) {
      return { low: true, reason: `confidence ${fixed(answer.confidence, 3)} is below 0.5` }
    }
    return { low: false }
  }
  if (answer.type === 'score' || answer.type === 'box') {
    if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)) {
      return { low: true, reason: 'the answer carries no confidence score' }
    }
    if (answer.confidence < LOW_CONFIDENCE) {
      return { low: true, reason: `confidence ${fixed(answer.confidence, 3)} is below 0.5` }
    }
    return { low: false }
  }
  if (answer.type === 'noul') {
    if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) {
      return { low: true, reason: 'the answer carries no p(yes) value' }
    }
    if (Math.abs(answer.noul - 0.5) < 0.1) {
      return { low: true, reason: `p(yes) is ${percent(answer.noul)}, too close to 50%` }
    }
    return { low: false }
  }
  return { low: false }
}

/**
 * Flag every answer whose distribution is too flat to present as settled, and say
 * whether any question is in that state. Consumers (the model and the card) then
 * share one definition of "low confidence" instead of each re-deriving thresholds.
 * The reason is kept per answer so the rendered warning says what actually tripped it.
 */
function annotateConfidence(answers) {
  if (!isPlainObject(answers)) return { answers: {}, lowConfidence: false }
  let lowConfidence = false
  const annotated = {}
  for (const [id, answer] of Object.entries(answers)) {
    if (!isPlainObject(answer) || answer.error) {
      annotated[id] = answer
      continue
    }
    const check = confidenceCheck(answer)
    if (check.low) {
      lowConfidence = true
      annotated[id] = { ...answer, lowConfidence: true, lowConfidenceReason: check.reason }
    } else {
      annotated[id] = answer
    }
  }
  return { answers: annotated, lowConfidence }
}

/** Sorted probability entries; non-numeric probabilities sort last and render as n/a. */
function probabilityEntries(probabilities) {
  return Object.entries(probabilities)
    .map(([key, value]) => [key, typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN])
    .sort((a, b) => (Number.isNaN(b[1]) ? -Infinity : b[1]) - (Number.isNaN(a[1]) ? -Infinity : a[1]))
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > 500 ? `${text.slice(0, 500)}…` : text
  } catch {
    return String(value)
  }
}

function formatAnswers(value) {
  const lines = [`Decision 3.0 · ${value.model || DEFAULT_MODEL}`]
  if (value.usage && typeof value.usage.input_tokens === 'number') {
    lines.push(`input tokens: ${value.usage.input_tokens}`)
  }
  if (value.requestId) lines.push(`request: ${value.requestId}`)
  let answers = value.answers
  if (Array.isArray(answers)) {
    lines.push('', 'note: the service returned answers as an array; showing them by index.')
    answers = Object.fromEntries(answers.map((answer, index) => [String(index), answer]))
  }
  if (!isPlainObject(answers)) answers = {}
  for (const [id, answer] of Object.entries(answers)) {
    lines.push('', `### ${id}`)
    if (!isPlainObject(answer)) {
      lines.push(safeJson(answer))
      continue
    }
    if (answer.error) {
      lines.push(`error: ${answer.error}${answer.reason ? ` (${answer.reason})` : ''} — ${answer.message || ''}`)
      continue
    }
    if (answer.lowConfidence) {
      lines.push(
        `⚠ low confidence: ${answer.lowConfidenceReason || 'the answer is not concentrated'}; do not report the top answer as settled.`,
      )
    }
    switch (answer.type) {
      case 'choice': {
        lines.push(`choice: **${answer.choice ?? 'unknown'}** · confidence ${fixed(answer.confidence, 3)}`)
        const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : null
        if (!probabilities) {
          lines.push(`- probabilities: ${safeJson(answer.probabilities)} (unexpected shape)`)
          break
        }
        for (const [option, probability] of probabilityEntries(probabilities)) {
          lines.push(`- ${option}: ${percent(probability)}${option === answer.choice ? ' ← chosen' : ''}`)
        }
        break
      }
      case 'noul':
        lines.push(`p(yes) = ${percent(answer.noul)}`)
        break
      case 'score': {
        lines.push(`score: ${fixed(answer.score)} · confidence ${fixed(answer.confidence, 3)}`)
        const legend = isPlainObject(answer.legend) ? answer.legend : {}
        const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : null
        if (!probabilities) {
          lines.push(`- probabilities: ${safeJson(answer.probabilities)} (unexpected shape)`)
          break
        }
        const entries = probabilityEntries(probabilities)
        const topLevel = entries.length > 0 && !Number.isNaN(entries[0][1]) ? entries[0][0] : null
        for (const [level, probability] of entries) {
          lines.push(
            `- ${legend[level] ?? `level ${level}`}: ${percent(probability)}${level === topLevel ? ' ← most likely' : ''}`,
          )
        }
        break
      }
      case 'box': {
        const box = isPlainObject(answer.box) ? answer.box : {}
        lines.push(
          `box: top ${percent(box.top)} · left ${percent(box.left)} · bottom ${percent(box.bottom)} · right ${percent(box.right)} · confidence ${fixed(answer.confidence, 3)}`,
        )
        break
      }
      default:
        lines.push(safeJson(answer))
    }
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `notes: ${value.warnings.join('; ')}`)
  }
  if (value.hint === 'low-confidence') {
    lines.push(
      '',
      'hint: low-confidence — state the uncertainty, or retry with sharper instructions/options or a stronger model.',
    )
  } else if (typeof value.hint === 'string' && value.hint) {
    lines.push('', `hint: ${value.hint}`)
  }
  return lines.join('\n')
}

function formatInfo(value) {
  const lines = []
  const info = isPlainObject(value.data) ? value.data : {}
  if (value.action === 'models') {
    const models = Array.isArray(info.models) ? info.models.filter(isPlainObject) : []
    lines.push(`Decision 3.0 models (${models.length}):`)
    for (const model of models) {
      const flags = [model.ready ? 'ready' : 'unavailable', model.box ? 'box' : null].filter(Boolean).join(', ')
      const aliases = Array.isArray(model.aliases) && model.aliases.length > 0 ? ` · aliases ${model.aliases.join(', ')}` : ''
      lines.push(`- \`${model.id}\` (${model.size || '?'}) — ${flags}${aliases}`)
    }
    const limits = isPlainObject(info.limits) ? info.limits : {}
    const summary = Object.entries(limits)
      .map(([key, entry]) => `${key}=${entry}`)
      .join(', ')
    if (summary) lines.push('', `limits: ${summary}`)
  } else if (value.action === 'usage') {
    if (value.keyConfigured === false) {
      lines.push('No API key configured; open Settings → Decision to add one.')
    } else if (!isPlainObject(info.self)) {
      // A failed lookup must not read as "no usage today".
      lines.push('usage unavailable: the key/usage endpoint could not be reached.')
    } else {
      const self = info.self
      const usage = isPlainObject(self.usage_today) ? self.usage_today : {}
      lines.push(`key ${self.prefix || '(unknown)'} · status ${self.status || 'unknown'}`)
      if (typeof usage.requests === 'number' || typeof usage.input_tokens === 'number') {
        lines.push(`today: ${usage.requests ?? 0} requests, ${usage.input_tokens ?? 0} input tokens`)
      } else {
        lines.push('today: no usage reported yet')
      }
      const quota = isPlainObject(info.usage) ? info.usage.quota : undefined
      if (quota && Array.isArray(quota.models)) {
        for (const model of quota.models) {
          if (typeof model.requests_today !== 'number') continue
          lines.push(`- \`${model.id}\`: ${model.requests_today} requests today (${model.requests_left ?? '?'} left)`)
        }
      }
      const recent = isPlainObject(info.usage) ? info.usage.recent : undefined
      if (recent && recent.latency_ms) {
        lines.push(`latency p50/p90: ${recent.latency_ms.p50 ?? '?'} / ${recent.latency_ms.p90 ?? '?'} ms`)
      }
    }
  } else {
    const models = info.models
    if (Array.isArray(models)) {
      for (const model of models) {
        const latency = model.latency_ms ? ` · ${model.latency_ms.p50 ?? '?'} ms p50` : ''
        lines.push(`- \`${model.id}\`: ${model.state || (model.ready ? 'ready' : 'unavailable')}${latency}`)
      }
    } else {
      lines.push(JSON.stringify(info).slice(0, 2000))
    }
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `notes: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// result cache (card enrichment; the session log stays the source of truth)
// ---------------------------------------------------------------------------

const resultCache = new Map()
let resultsLoaded = false
let persistTimer = null

/** Load the persisted cards once; a missing or unreadable store simply starts empty. */
async function loadResults() {
  if (resultsLoaded) return
  resultsLoaded = true
  await ensureDataDir()
  try {
    const raw = await readFile(RESULTS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : []
    const now = Date.now()
    for (const entry of entries) {
      if (!entry || typeof entry.callId !== 'string') continue
      if (typeof entry.at !== 'number' || now - entry.at > CACHE_TTL_MS) continue
      if (!entry.value || typeof entry.value !== 'object') continue
      resultCache.set(entry.callId, { at: entry.at, value: entry.value })
    }
    // Keep the in-memory store bounded even when the file was written elsewhere.
    pruneResults(now)
  } catch {
    // no store yet, or an unreadable one: keep the empty cache
  }
}

/**
 * Re-read the store. Another Host process — or this one before its last reload —
 * may have written entries since the first load, and a cache hit must not depend
 * on which process executed the tool.
 */
async function reloadResults() {
  resultsLoaded = false
  await loadResults()
}

function pruneResults(now) {
  for (const [key, entry] of resultCache) {
    if (now - entry.at > CACHE_TTL_MS) resultCache.delete(key)
  }
  while (resultCache.size > CACHE_LIMIT) {
    const oldest = resultCache.keys().next()
    if (oldest.done) break
    resultCache.delete(oldest.value)
  }
}

function schedulePersist() {
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    persistResults().catch(() => {})
  }, 800)
  if (typeof persistTimer.unref === 'function') persistTimer.unref()
}

/**
 * Persist the card values so cards stay rendered after a Host restart. Writes are
 * serialized on a chain: a caller that arrives mid-write waits for the next write
 * instead of being dropped (the old "already running" branch lost results).
 */
let persistChain = Promise.resolve()

function persistResults() {
  persistChain = persistChain.then(writeSnapshot, writeSnapshot)
  return persistChain
}

async function writeSnapshot() {
  const now = Date.now()
  pruneResults(now)
  // Another Host process may have written entries since this process last read
  // the file. Merge by callId (newest wins) instead of overwriting its entries.
  const merged = new Map(resultCache)
  try {
    const parsed = JSON.parse(await readFile(RESULTS_PATH, 'utf8'))
    const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : []
    for (const entry of entries) {
      if (!entry || typeof entry.callId !== 'string') continue
      if (typeof entry.at !== 'number' || now - entry.at > CACHE_TTL_MS) continue
      if (!entry.value || typeof entry.value !== 'object') continue
      const existing = merged.get(entry.callId)
      if (!existing || entry.at > existing.at) merged.set(entry.callId, { at: entry.at, value: entry.value })
    }
  } catch {
    // no store on disk yet
  }
  // Seed the in-memory cache with what the merge recovered, so a card lookup in
  // this process can replay entries another process wrote.
  for (const [callId, entry] of merged) resultCache.set(callId, entry)
  pruneResults(now)
  const entries = [...merged]
    .map(([callId, entry]) => ({ callId, at: entry.at, value: entry.value }))
    .sort((a, b) => a.at - b.at)
    .slice(-CACHE_LIMIT)
  await writeJsonAtomic(RESULTS_PATH, { version: 1, entries })
}

function rememberResult(callId, value) {
  if (!callId) return
  const now = Date.now()
  resultCache.set(callId, { at: now, value })
  pruneResults(now)
  schedulePersist()
}

async function recallResult(callId) {
  await loadResults()
  let entry = resultCache.get(callId)
  if (!entry) {
    // A different Host process may have executed the tool; re-read once before giving up.
    await reloadResults()
    entry = resultCache.get(callId)
  }
  if (!entry) return null
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    resultCache.delete(callId)
    return null
  }
  return entry.value
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

const ASK_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['state', 'questions'],
  properties: {
    state: {
      type: 'string',
      description:
        "The input the questions are about: plain text, or JSON written as text. Up to the selected model's " +
        'max_state_chars: 131072 for d3-ultra, 32000 for the other models.',
    },
    questions: {
      type: 'object',
      description:
        'Question id → question. Types: choice (criteria = {optionId: short description}, at least 2), ' +
        'noul (yes/no; criteria optional {"false":...,"true":...}), score (criteria = ordered level descriptions, 2-10), ' +
        'box (locate something in the single attached image; no criteria). Ask everything about one input in one call.',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'instructions'],
        properties: {
          type: { type: 'string', enum: QUESTION_TYPES },
          instructions: { type: 'string', description: 'The question in plain language.' },
          criteria: {
            description:
              'choice: object of option id → description; noul: optional {"false","true"} descriptions; score: array of levels lowest first.',
          },
        },
      },
    },
    model: {
      type: 'string',
      description:
        `Decision model id or alias, for example ${DEFAULT_MODEL} or vllm-sr/d3-ultra (d3-turbo is an alias of d3-ultra). ` +
        'Omit to use the configured default.',
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description:
        "Up to the selected model's image limit (16 for d3-ultra, 4 for the others): absolute local file paths " +
        '(png/jpeg/webp) or data: URLs (data:<mime>;base64,...). A box question needs exactly one image.',
    },
    videos: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 1 video: absolute local file path (mp4/webm/mov/mkv) or a data: URL.',
    },
  },
}

const ASK_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'answers'],
  properties: {
    model: { type: 'string' },
    answers: { type: 'object', additionalProperties: true },
    usage: { type: 'object', additionalProperties: true },
    requestId: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    hint: { type: 'string', description: 'low-confidence when at least one answer is too flat to report as settled.' },
  },
}

const INFO_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['models', 'usage', 'status'],
      description: 'models: published models and limits; usage: today\'s quota for the configured key; status: live model state.',
    },
  },
}

const INFO_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: { type: 'string' },
    keyConfigured: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true },
    warnings: { type: 'array', items: { type: 'string' } },
  },
}

function registerTools(ctx) {
  ctx.tools.register({
    name: 'decision_ask',
    description:
      'Ask the Decision 3.0 multimodal decision models for calibrated probabilities: choice, yes/no (noul), ' +
      'ordered score and image box questions in one call. Returns per-question probabilities and confidence; ' +
      'the models generate no text, so treat the numbers as the answer. If the top probability is below 0.6, a ' +
      'question is flagged lowConfidence, or the result carries hint "low-confidence", do not present the top ' +
      'answer as settled: tell the user the evidence is inconclusive, or retry with sharper instructions, more ' +
      'options, or a stronger model (d3-ultra, also published as d3-turbo/d3). ' +
      'Box questions are serialized per API key and model: the service handles one box request at a time, so ' +
      'concurrent box calls queue (and a cross-process collision is retried once) instead of failing; other ' +
      'question types still run in parallel.',
    parameters: ASK_PARAMETERS,
    output: {
      schema: ASK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatAnswers(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const settings = await readSettings()
      const key = await resolveApiKey(ctx)
      if (!key) {
        throw new Error(
          'No Decision API key configured. Open Settings → Decision in the DSH UI, or set DECISION_API_KEY, then retry.',
        )
      }
      const state = typeof args.state === 'string' ? args.state : ''
      if (state.trim().length === 0) throw new Error('state must be a non-empty string')
      const { questions, boxCount } = buildQuestions(args.questions)
      const target = await resolveAskTarget(ctx, args.model, settings)
      const limits = target.limits
      if (Object.keys(questions).length > limits.max_questions) {
        throw new Error(
          `at most ${limits.max_questions} questions per request for ${target.model}; got ${Object.keys(questions).length}`,
        )
      }
      if (state.length > limits.max_state_chars) {
        throw new Error(
          `state is ${state.length} characters, over the ${limits.max_state_chars} character limit for ${target.model}`,
        )
      }
      // Count the media before reading it: an invalid combination must not pay for
      // reading and base64-encoding megabytes first.
      const rawImages = Array.isArray(args.images) ? args.images : []
      const rawVideos = Array.isArray(args.videos) ? args.videos : []
      const imageCount = rawImages.map(normalizeMediaEntry).filter(Boolean).length
      const videoCount = rawVideos.map(normalizeMediaEntry).filter(Boolean).length
      if (imageCount > limits.max_images) {
        throw new Error(`at most ${limits.max_images} image(s) per request for ${target.model}; got ${imageCount}`)
      }
      if (videoCount > limits.max_videos) {
        throw new Error(`at most ${limits.max_videos} video(s) per request; got ${videoCount}`)
      }
      if (boxCount > 0 && imageCount !== 1) {
        // Multiple box questions may share the same image; the count must be exactly one.
        throw new Error(`box questions need exactly one image in "images" (got ${imageCount})`)
      }
      const images = await buildMedia(rawImages, 'image', limits)
      const videos = await buildMedia(rawVideos, 'video', limits)

      const body = { model: target.model, state, questions }
      if (images.length > 0) body.images = images
      if (videos.length > 0) body.videos = videos

      const send = () =>
        requestDecision(ctx, {
          path: '/v1/systemone',
          method: 'POST',
          key,
          body,
          signal: exec.signal,
        })
      // The service runs one box request at a time per key + model, so box calls
      // queue behind each other here instead of failing with 429; everything else
      // stays parallel. A queued call that was aborted fails immediately.
      const result =
        boxCount > 0
          ? await abortRace(
              serializeBox(boxLockKey(key, target.model), async () => {
                throwIfAborted(exec.signal)
                return send()
              }),
              exec.signal,
            )
          : await send()
      const json = isPlainObject(result.json) ? result.json : {}
      // The service returns an object, but an array would otherwise be dropped
      // silently; keep it addressable by index instead.
      const rawAnswers = Array.isArray(json.answers)
        ? Object.fromEntries(json.answers.map((answer, index) => [String(index), answer]))
        : json.answers
      const annotated = annotateConfidence(rawAnswers)
      // Pass the service's own warnings/hint through: both formatAnswers and the card
      // have render branches for them, and dropping them hid diagnostics.
      const serverWarnings = Array.isArray(json.warnings)
        ? json.warnings.filter((warning) => typeof warning === 'string' && warning.trim())
        : []
      const hint = annotated.lowConfidence
        ? 'low-confidence'
        : typeof json.hint === 'string' && json.hint.trim()
          ? json.hint.trim()
          : ''
      const value = {
        model: typeof json.model === 'string' ? json.model : target.model,
        answers: annotated.answers,
        ...(hint ? { hint } : {}),
        ...(serverWarnings.length > 0 ? { warnings: serverWarnings } : {}),
        ...(isPlainObject(json.usage) ? { usage: json.usage } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
      }
      await loadResults()
      rememberResult(exec.callId, value)
      // Persist before returning: a restart inside the debounce window used to lose
      // the card payload for good.
      await persistResults().catch(() => {})
      return value
    },
  })

  ctx.tools.register({
    name: 'decision_info',
    description:
      'Inspect the Decision 3.0 service: available models and request limits (models), the configured key\'s ' +
      'quota and recent usage (usage), or the live model state (status). No key is needed for models/status.',
    parameters: INFO_PARAMETERS,
    output: {
      schema: INFO_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: formatInfo(value) }],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = args && typeof args.action === 'string' ? args.action.trim().toLowerCase() : 'models'
      const allowed = ['models', 'usage', 'status']
      if (!allowed.includes(requested)) {
        // The framework does not enforce the JSON-Schema enum, so reject here
        // instead of silently answering a different question.
        throw new Error(`unknown action "${args && args.action}"; use one of ${allowed.join(', ')}`)
      }
      const action = requested
      const warnings = []
      if (action === 'models') {
        const info = await fetchInfo(ctx)
        return { action, data: isPlainObject(info) ? info : {} }
      }
      if (action === 'status') {
        const { json } = await apiRequest(ctx, { path: '/api/status', signal: exec.signal })
        return { action, data: isPlainObject(json) ? json : {} }
      }
      const key = await resolveApiKey(ctx)
      if (!key) {
        return {
          action: 'usage',
          keyConfigured: false,
          data: {},
          warnings: ['No API key configured. Open Settings → Decision in the DSH UI to add one.'],
        }
      }
      const self = await fetchSelf(ctx, key, USAGE_TOOL_TIMEOUT_MS).catch((error) => {
        warnings.push(error && error.message ? error.message : String(error))
        return null
      })
      const usage = await fetchUsage(ctx, key, USAGE_TOOL_TIMEOUT_MS).catch((error) => {
        warnings.push(error && error.message ? error.message : String(error))
        return null
      })
      return {
        action: 'usage',
        keyConfigured: true,
        data: { self, usage },
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    },
  })
}

// ---------------------------------------------------------------------------
// same-origin HTTP surface for the Client half
// ---------------------------------------------------------------------------

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!match) return false
  if (Number(match[1]) !== 127) return false
  return [match[2], match[3], match[4]].every((part) => Number(part) <= 255)
}

function guardRequest(req) {
  const headers = req.headers || {}
  const target = String(req.url || '')
  // Only origin-form targets are legitimate here; absolute-form would let a proxy
  // rewrite the authority the route sees.
  if (target && target[0] !== '/') return 'invalid request target'
  let hostUrl
  try {
    hostUrl = new URL(`http://${String(headers.host || '')}`)
  } catch {
    return 'invalid host'
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 'host not allowed'
  const site = String(headers['sec-fetch-site'] || '').toLowerCase()
  if (site === 'cross-site') return 'cross-site request'
  const origin = headers.origin
  if (typeof origin === 'string' && origin) {
    // A sandboxed iframe / file:// page sends Origin: null. It is not our own UI.
    if (origin === 'null') return 'null origin not allowed'
    let originUrl
    try {
      originUrl = new URL(origin)
    } catch {
      return 'invalid origin'
    }
    if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 'origin mismatch'
  }
  return null
}

function sendJson(res, status, payload, extraHeaders) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  })
  res.end(body)
}

function methodNotAllowed(res, allow) {
  return sendJson(res, 405, { error: 'method not allowed' }, allow ? { allow } : undefined)
}

async function readJsonBody(req, limit) {
  const contentType = String((req.headers || {})['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    // Reject cross-origin "simple requests" (text/plain etc.) before parsing.
    const error = new Error('content-type must be application/json')
    error.status = 415
    throw error
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body too large')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text)
  if (!isPlainObject(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

/** Shape check only: the real verdict comes from fetchSelf (providers may change the format). */
const KEY_PATTERN = /^[A-Za-z0-9._-]{12,200}$/

function maskKey(key) {
  if (!key) return null
  // 4 + 4 is the common convention; a short/custom token is not echoed at all.
  return key.length <= 12 ? '…' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

const STATUS_TTL_MS = 20_000
/** Usage is a nice-to-have on the settings page: never let it hold the whole panel. */
const USAGE_TIMEOUT_MS = 4_000
/** A failed usage lookup is cached briefly too, or every panel open waits 4s again. */
const USAGE_ERROR_TTL_MS = 5_000
let statusCache = null
let usageCache = null
let usageErrorCache = null

/**
 * Settings-page payload. The slow part is the outbound calls (/api/info, the
 * key's usage), so callers may reuse a recent payload instead of paying for it
 * on every panel open; `cached`/`cachedAt` tell the Client what it is showing.
 */
async function buildStatus(ctx, options = {}) {
  const now = Date.now()
  if (!options.refresh && statusCache && now - statusCache.at < STATUS_TTL_MS) {
    return { ...statusCache.value, cached: true, cachedAt: statusCache.at }
  }
  const settings = await readSettings()
  const key = await resolveApiKey(ctx)
  let info = null
  let infoError = null
  try {
    info = await fetchInfo(ctx)
  } catch (error) {
    infoError = error && error.message ? error.message : String(error)
  }
  const value = {
    keyConfigured: Boolean(key),
    keyPrefix: maskKey(key),
    model: settings.model,
    baseUrl: settings.baseUrl,
    models: info && Array.isArray(info.models) ? info.models.filter(isPlainObject) : [],
    limits: info && info.limits ? info.limits : null,
    ...(infoError ? { infoError } : {}),
    // Diagnostics for the settings page: the Host's own origin and the last
    // requests that actually arrived, which distinguishes "Client never
    // reached the route" from "route answered with an error".
    diagnostics: {
      serverOrigin: currentServerOrigin(ctx),
      recentRequests: recentRequests.slice(-6),
      clientReports: clientReports.slice(-12),
      recentResultLookups: resultLookups.slice(-10),
    },
  }
  statusCache = { at: Date.now(), value }
  return { ...value, cached: false, cachedAt: statusCache.at }
}

function invalidateStatus() {
  statusCache = null
}

/**
 * Quota + usage, kept on its own route because the key's usage endpoints are an
 * order of magnitude slower than the rest of the panel. The Client paints the
 * settings page first and fills this in when it lands.
 */
async function buildUsage(ctx, options = {}) {
  const now = Date.now()
  if (!options.refresh && usageCache && now - usageCache.at < STATUS_TTL_MS) {
    return { ...usageCache.value, cached: true, cachedAt: usageCache.at }
  }
  if (!options.refresh && usageErrorCache && now - usageErrorCache.at < USAGE_ERROR_TTL_MS) {
    return { ...usageErrorCache.value, cached: true, cachedAt: usageErrorCache.at }
  }
  const key = await resolveApiKey(ctx)
  if (!key) {
    const value = { keyConfigured: false, usage: null }
    usageCache = { at: Date.now(), value }
    usageErrorCache = null
    return { ...value, cached: false, cachedAt: usageCache.at }
  }
  try {
    const [self, daily] = await Promise.all([
      fetchSelf(ctx, key, USAGE_TIMEOUT_MS),
      fetchUsage(ctx, key, USAGE_TIMEOUT_MS),
    ])
    const value = { keyConfigured: true, usage: { self, daily } }
    usageCache = { at: Date.now(), value }
    usageErrorCache = null
    return { ...value, cached: false, cachedAt: usageCache.at }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    const value = { keyConfigured: true, usage: null, usageError: message }
    usageErrorCache = { at: Date.now(), value }
    return { ...value, cached: false, cachedAt: usageErrorCache.at }
  }
}

function invalidateUsage() {
  usageCache = null
  usageErrorCache = null
}

function currentServerOrigin(ctx) {
  try {
    const server = ctx.get ? ctx.get('webServer') : undefined
    return server && typeof server.getOrigin === 'function' ? server.getOrigin() : ''
  } catch {
    return ''
  }
}

const recentRequests = []
/** Client-side render/fetch reports, so a broken card is diagnosable from the Host. */
const clientReports = []
/** Card lookups by callId, hit or miss — "result is no longer cached" must be explainable. */
const resultLookups = []

function noteResultLookup(callId, found) {
  try {
    resultLookups.push({ at: new Date().toISOString(), callId: String(callId).slice(0, 80), found: Boolean(found) })
    if (resultLookups.length > 20) resultLookups.shift()
  } catch {
    // diagnostics only
  }
}

function rememberClientReport(payload) {
  try {
    const entry = {
      at: new Date().toISOString(),
      kind: typeof payload.kind === 'string' ? payload.kind.slice(0, 40) : 'unknown',
      callId: typeof payload.callId === 'string' ? payload.callId.slice(0, 80) : '',
      message: typeof payload.message === 'string' ? payload.message.slice(0, 400) : '',
      status: typeof payload.status === 'number' ? payload.status : undefined,
      hasValue: payload.hasValue === true,
      phase: typeof payload.phase === 'string' ? payload.phase.slice(0, 20) : '',
    }
    clientReports.push(entry)
    if (clientReports.length > 40) clientReports.shift()
  } catch {
    // ignore malformed reports
  }
}

function logRequest(ctx, name, req) {
  try {
    const headers = req.headers || {}
    // Recent requests stay in memory so the settings page can report exactly
    // which headers reached the Host (diagnosing a Client that never arrives).
    recentRequests.push({
      at: new Date().toISOString(),
      name,
      method: req.method,
      url: req.url,
      host: headers.host || '',
      origin: headers.origin || '',
      secFetchSite: headers['sec-fetch-site'] || '',
    })
    if (recentRequests.length > 10) recentRequests.shift()
    if (ctx.logger && typeof ctx.logger.info === 'function') {
      ctx.logger.info(
        'dsh-decision route %s %s host=%s origin=%s sec-fetch-site=%s',
        name,
        req.method,
        headers.host || '',
        headers.origin || '',
        headers['sec-fetch-site'] || '',
      )
    }
  } catch {
    // diagnostics must never break a request
  }
}

function registerRoutes(ctx, webServer) {
  if (!webServer || typeof webServer.register !== 'function') return

  const disposers = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      async handler(req, res) {
        logRequest(ctx, 'status', req)
        const reason = guardRequest(req)
        if (reason) return sendJson(res, 403, { error: reason })
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        let refresh = false
        try {
          refresh = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'
        } catch {
          refresh = false
        }
        try {
          return sendJson(res, 200, await buildStatus(ctx, { refresh }))
        } catch (error) {
          return sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/usage`,
      async handler(req, res) {
        logRequest(ctx, 'usage', req)
        const reason = guardRequest(req)
        if (reason) return sendJson(res, 403, { error: reason })
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        let refresh = false
        try {
          refresh = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('refresh') === '1'
        } catch {
          refresh = false
        }
        try {
          return sendJson(res, 200, await buildUsage(ctx, { refresh }))
        } catch (error) {
          return sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/config`,
      async handler(req, res) {
        logRequest(ctx, 'config', req)
        const reason = guardRequest(req)
        if (reason) return sendJson(res, 403, { error: reason })
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        let body
        try {
          body = await readJsonBody(req, MAX_BODY_BYTES)
        } catch (error) {
          try {
            req.resume()
          } catch {
            // body already consumed
          }
          return sendJson(res, error && error.status ? error.status : 400, {
            error: error && error.message ? error.message : String(error),
          })
        }
        const patch = {}
        let clearKey = false
        if (typeof body.apiKey === 'string') {
          const apiKey = body.apiKey.trim()
          if (!apiKey) {
            // POST /config {"apiKey":""} removes the stored key.
            clearKey = true
          } else {
            if (!KEY_PATTERN.test(apiKey)) {
              return sendJson(res, 400, {
                error: 'API key looks malformed: expected 12-200 letters, digits, dots, dashes or underscores',
              })
            }
            try {
              await fetchSelf(ctx, apiKey, KEY_VERIFY_TIMEOUT_MS)
            } catch (error) {
              const message = error && error.message ? error.message : String(error)
              return sendJson(res, 400, { error: `key rejected: ${message}` })
            }
            patch.apiKey = apiKey
          }
        }
        if (typeof body.model === 'string' && body.model.trim()) {
          const requested = body.model.trim()
          let info
          try {
            info = await fetchInfo(ctx, { force: true })
          } catch (error) {
            // Fail closed: a model that cannot be verified must not be written to disk.
            const message = error && error.message ? error.message : String(error)
            return sendJson(res, 400, {
              error: `cannot verify model "${requested}" right now (${message}); retry when the model list is reachable`,
            })
          }
          const entry = findModelEntry(info, requested)
          if (!entry) {
            const known = modelIds(info)
            return sendJson(res, 400, {
              error: `unknown model "${requested}"${known ? `; available: ${known}` : ''}`,
            })
          }
          // Aliases (vllm-sr/d3-turbo, vllm-sr/d3) are stored as their canonical id.
          patch.model = typeof entry.id === 'string' ? entry.id : requested
        }
        if (Object.keys(patch).length === 0 && !clearKey) {
          return sendJson(res, 400, { error: 'nothing to update' })
        }
        try {
          // Settings first, then the key: both writes are read-modify-write now, so
          // neither can drop the fields the other just persisted.
          if (patch.model) await writeSettings({ model: patch.model })
          if (patch.apiKey) await saveApiKey(ctx, patch.apiKey)
          if (clearKey) await clearApiKey(ctx)
          invalidateStatus()
          invalidateUsage()
          const [nextStatus, nextUsage] = await Promise.all([
            buildStatus(ctx, { refresh: true }),
            buildUsage(ctx, { refresh: true }),
          ])
          return sendJson(res, 200, {
            ...nextStatus,
            usage: nextUsage.usage,
            ...(nextUsage.usageError ? { usageError: nextUsage.usageError } : {}),
          })
        } catch (error) {
          return sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/result`,
      async handler(req, res) {
        logRequest(ctx, 'result', req)
        const reason = guardRequest(req)
        if (reason) return sendJson(res, 403, { error: reason })
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
        let callId = ''
        try {
          callId = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('callId') || ''
        } catch {
          callId = ''
        }
        if (!callId) return sendJson(res, 400, { error: 'callId is required' })
        const value = await recallResult(callId)
        noteResultLookup(callId, value)
        if (!value) return sendJson(res, 404, { error: 'result is no longer cached' })
        return sendJson(res, 200, { callId, value })
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/client-report`,
      async handler(req, res) {
        logRequest(ctx, 'client-report', req)
        const reason = guardRequest(req)
        if (reason) return sendJson(res, 403, { error: reason })
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
        try {
          const body = await readJsonBody(req, MAX_BODY_BYTES)
          if (Object.keys(body).length === 0) return sendJson(res, 400, { error: 'empty report' })
          rememberClientReport(body)
          return sendJson(res, 200, { ok: true })
        } catch (error) {
          try {
            req.resume()
          } catch {
            // body already consumed
          }
          return sendJson(res, error && error.status ? error.status : 400, {
            error: error && error.message ? error.message : String(error),
          })
        }
      },
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already disposed
      }
    }
    // The diagnostics buffers are module-level: clear them with the routes so a
    // plugin reload starts clean instead of carrying stale entries forward.
    recentRequests.length = 0
    clientReports.length = 0
    resultLookups.length = 0
  })
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export const inject = ['tools']

export function apply(ctx) {
  registerTools(ctx)
  // /api/info takes seconds on a cold cache, so warm it in the background: the
  // first Settings open then usually hits the cache instead of waiting.
  const warmTimer = setTimeout(() => {
    fetchInfo(ctx).catch(() => {})
  }, 1500)
  if (typeof warmTimer.unref === 'function') warmTimer.unref()
  ctx.effect(() => () => clearTimeout(warmTimer))
  // The browser HTTP carrier can activate after this plugin. Reading
  // ctx.get('webServer') once at activation loses that race on a cold start and
  // silently leaves no routes, so wait for the service instead.
  ctx.inject(['webServer'], (scoped) => {
    let webServer
    try {
      webServer = scoped.get ? scoped.get('webServer') : scoped.webServer
    } catch {
      webServer = undefined
    }
    if (!webServer) return
    // Register on the scoped fiber: when the webServer service is replaced, its
    // routes go with it instead of lingering on the plugin fiber.
    registerRoutes(scoped && typeof scoped.effect === 'function' ? scoped : ctx, webServer)
  })
}
