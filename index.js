/**
 * @local/dsh-decision — Host half.
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
 * fallback; the default model lives in $DSH_HOME/.dsh-decision.json.
 */

import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-decision'

const DEFAULT_BASE_URL = 'https://decision.vllm-sr.ai'
const DEFAULT_MODEL = 'vllm-sr/d3-flash'
const KEY_REF = 'DECISION_API_KEY'
const ROUTE_PREFIX = '/dsh-decision'
const SETTINGS_BASENAME = '.dsh-decision.json'
const INFO_TTL_MS = 600_000
const CACHE_LIMIT = 200
const CACHE_TTL_MS = 60 * 60_000
const REQUEST_TIMEOUT_MS = 35_000
const TOOL_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 64 * 1024
const MAX_QUESTIONS = 64
const MAX_STATE_CHARS = 32_000
const MAX_IMAGES = 4
const MAX_VIDEOS = 1

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SETTINGS_PATH = join(DSH_HOME, SETTINGS_BASENAME)

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
const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const VIDEO_MAX_BYTES = 32 * 1024 * 1024

const QUESTION_TYPES = ['choice', 'noul', 'score', 'box']

// ---------------------------------------------------------------------------
// settings file (default model only; the key normally lives in credentials)
// ---------------------------------------------------------------------------

let settingsCache = null

async function readSettings() {
  if (settingsCache) return settingsCache
  let raw = null
  try {
    raw = await readFile(SETTINGS_PATH, 'utf8')
  } catch {
    raw = null
  }
  let parsed = {}
  if (raw) {
    try {
      const value = JSON.parse(raw)
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value
    } catch {
      parsed = {}
    }
  }
  settingsCache = {
    model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL,
    baseUrl:
      typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim().replace(/\/+$/, '')
        : DEFAULT_BASE_URL,
  }
  return settingsCache
}

async function writeSettings(patch) {
  const current = await readSettings()
  const next = {
    model: typeof patch.model === 'string' && patch.model.trim() ? patch.model.trim() : current.model,
    baseUrl:
      typeof patch.baseUrl === 'string' && patch.baseUrl.trim()
        ? patch.baseUrl.trim().replace(/\/+$/, '')
        : current.baseUrl,
  }
  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  const tmp = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, SETTINGS_PATH)
  try {
    await chmod(SETTINGS_PATH, 0o600)
  } catch {
    // Windows has no POSIX mode; the ACL governs access there.
  }
  settingsCache = next
  return next
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
  try {
    const raw = await readFile(SETTINGS_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.trim()) return parsed.apiKey.trim()
  } catch {
    // no file fallback
  }
  return ''
}

async function saveApiKey(ctx, apiKey) {
  const credentials = ctx.get ? ctx.get('credentials') : undefined
  if (credentials && typeof credentials.set === 'function') {
    await credentials.set(KEY_REF, apiKey)
    return 'credentials'
  }
  // Fallback: keep it beside the default model, owner-readable only.
  let raw = {}
  try {
    const value = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) raw = value
  } catch {
    raw = {}
  }
  raw.apiKey = apiKey
  await mkdir(dirname(SETTINGS_PATH), { recursive: true })
  const tmp = `${SETTINGS_PATH}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, SETTINGS_PATH)
  settingsCache = null
  return 'file'
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
    const res = await fetch(joinUrl(baseUrl, options.path), {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
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

async function fetchInfo(ctx, { force = false } = {}) {
  const now = Date.now()
  if (!force && infoCache && now - infoCache.at < INFO_TTL_MS) return infoCache.value
  try {
    const { json } = await apiRequest(ctx, { path: '/api/info' })
    infoCache = { at: now, value: json }
    return json
  } catch (error) {
    // The models list changes slowly: an expired snapshot beats an empty table.
    if (infoCache) return infoCache.value
    throw error
  }
}
let infoCache = null

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
// media handling
// ---------------------------------------------------------------------------

function normalizeMediaEntry(entry) {
  return typeof entry === 'string' ? entry.trim() : ''
}

function extensionOf(path) {
  const match = /(\.[A-Za-z0-9]+)$/.exec(path)
  return match ? match[1].toLowerCase() : ''
}

async function loadMediaDataUrl(path, kind) {
  if (path.startsWith('data:')) return path
  const mimeMap = kind === 'image' ? IMAGE_MIME : VIDEO_MIME
  const ext = extensionOf(path)
  const mime = mimeMap[ext]
  if (!mime) {
    const allowed = Object.keys(mimeMap).join(', ')
    throw new Error(`unsupported ${kind} extension "${ext || '(none)'}": use one of ${allowed} or a data: URL`)
  }
  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    throw new Error(`cannot read ${kind} file "${path}": ${error && error.message ? error.message : String(error)}`)
  }
  const limit = kind === 'image' ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES
  if (bytes.length > limit) {
    throw new Error(
      `${kind} file "${path}" is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, over the ${(limit / 1024 / 1024).toFixed(0)} MB limit`,
    )
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}

async function buildMedia(list, kind) {
  if (!Array.isArray(list) || list.length === 0) return []
  const entries = list.map(normalizeMediaEntry).filter(Boolean)
  const limit = kind === 'image' ? MAX_IMAGES : MAX_VIDEOS
  if (entries.length > limit) {
    throw new Error(`at most ${limit} ${kind}(s) per request; got ${entries.length}`)
  }
  const out = []
  for (const entry of entries) out.push(await loadMediaDataUrl(entry, kind))
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

function buildQuestions(raw) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    throw new Error('questions must be a non-empty object mapping question ids to question definitions')
  }
  const ids = Object.keys(raw)
  if (ids.length > MAX_QUESTIONS) {
    throw new Error(`at most ${MAX_QUESTIONS} questions per request; got ${ids.length}`)
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
// result formatting
// ---------------------------------------------------------------------------

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a'
}

function fixed(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function formatAnswers(value) {
  const lines = [`Decision 3.0 · ${value.model || DEFAULT_MODEL}`]
  if (value.usage && typeof value.usage.input_tokens === 'number') {
    lines.push(`input tokens: ${value.usage.input_tokens}`)
  }
  if (value.requestId) lines.push(`request: ${value.requestId}`)
  const answers = isPlainObject(value.answers) ? value.answers : {}
  for (const [id, answer] of Object.entries(answers)) {
    lines.push('', `### ${id}`)
    if (!isPlainObject(answer)) {
      lines.push(JSON.stringify(answer))
      continue
    }
    if (answer.error) {
      lines.push(`error: ${answer.error}${answer.reason ? ` (${answer.reason})` : ''} — ${answer.message || ''}`)
      continue
    }
    switch (answer.type) {
      case 'choice': {
        lines.push(`choice: **${answer.choice}** · confidence ${fixed(answer.confidence, 3)}`)
        const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : {}
        for (const [option, probability] of Object.entries(probabilities).sort((a, b) => b[1] - a[1])) {
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
        const probabilities = isPlainObject(answer.probabilities) ? answer.probabilities : {}
        for (const [level, probability] of Object.entries(probabilities)) {
          lines.push(`- ${legend[level] ?? `level ${level}`}: ${percent(probability)}`)
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
        lines.push(JSON.stringify(answer))
    }
  }
  if (Array.isArray(value.warnings) && value.warnings.length > 0) {
    lines.push('', `notes: ${value.warnings.join('; ')}`)
  }
  return lines.join('\n')
}

function formatInfo(value) {
  const lines = []
  const info = isPlainObject(value.data) ? value.data : {}
  if (value.action === 'models') {
    const models = Array.isArray(info.models) ? info.models : []
    lines.push(`Decision 3.0 models (${models.length}):`)
    for (const model of models) {
      const flags = [model.ready ? 'ready' : 'unavailable', model.box ? 'box' : null].filter(Boolean).join(', ')
      lines.push(`- \`${model.id}\` (${model.size}) — ${flags}`)
    }
    const limits = isPlainObject(info.limits) ? info.limits : {}
    const summary = Object.entries(limits)
      .map(([key, entry]) => `${key}=${entry}`)
      .join(', ')
    if (summary) lines.push('', `limits: ${summary}`)
  } else if (value.action === 'usage') {
    if (value.keyConfigured === false) {
      lines.push('No API key configured; open Settings → Decision to add one.')
    } else {
      const self = isPlainObject(info.self) ? info.self : {}
      const usage = isPlainObject(self.usage_today) ? self.usage_today : {}
      lines.push(`key ${self.prefix || '(unknown)'} · status ${self.status || 'unknown'}`)
      lines.push(`today: ${usage.requests ?? 0} requests, ${usage.input_tokens ?? 0} input tokens`)
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
const RESULTS_PATH = join(DSH_HOME, '.dsh-decision-results.json')
let resultsLoaded = false
let persistTimer = null
let persistRunning = false

/** Load the persisted cards once; a missing or unreadable store simply starts empty. */
async function loadResults() {
  if (resultsLoaded) return
  resultsLoaded = true
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
  } catch {
    // no store yet, or an unreadable one: keep the empty cache
  }
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

/** Persist the card values so cards stay rendered after a Host restart. */
async function persistResults() {
  if (persistRunning) return
  persistRunning = true
  try {
    const now = Date.now()
    pruneResults(now)
    const entries = [...resultCache]
      .map(([callId, entry]) => ({ callId, at: entry.at, value: entry.value }))
      .sort((a, b) => a.at - b.at)
    await mkdir(dirname(RESULTS_PATH), { recursive: true })
    const tmp = `${RESULTS_PATH}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify({ version: 1, entries })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, RESULTS_PATH)
  } catch {
    // best-effort: the tool text in the session log always remains authoritative
  } finally {
    persistRunning = false
  }
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
  const entry = resultCache.get(callId)
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
        'The input the questions are about: plain text, or JSON written as text. Up to 32000 characters.',
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
      description: `Decision model id, for example ${DEFAULT_MODEL}. Omit to use the configured default.`,
    },
    images: {
      type: 'array',
      items: { type: 'string' },
      description: `Up to ${MAX_IMAGES} images: absolute local file paths (png/jpeg/webp) or data: URLs. A box question needs exactly one image.`,
    },
    videos: {
      type: 'array',
      items: { type: 'string' },
      description: `Up to ${MAX_VIDEOS} video: absolute local file path (mp4/webm/mov/mkv) or data: URL.`,
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
      'the models generate no text, so treat the numbers as the answer.',
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
      if (state.length > MAX_STATE_CHARS) {
        throw new Error(`state is ${state.length} characters, over the ${MAX_STATE_CHARS} character limit`)
      }
      const { questions, boxCount } = buildQuestions(args.questions)
      const model = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : settings.model
      const images = await buildMedia(args.images, 'image')
      const videos = await buildMedia(args.videos, 'video')
      if (boxCount > 0 && images.length !== 1) {
        throw new Error(
          `box questions need exactly one image in "images" (got ${images.length}); send one box question per request`,
        )
      }
      if (images.length === 0 && videos.length === 0 && boxCount > 0) {
        throw new Error('box questions need an image')
      }

      const body = { model, state, questions }
      if (images.length > 0) body.images = images
      if (videos.length > 0) body.videos = videos

      const result = await apiRequest(ctx, {
        path: '/v1/systemone',
        method: 'POST',
        key,
        body,
        signal: exec.signal,
      })
      const json = isPlainObject(result.json) ? result.json : {}
      const value = {
        model: typeof json.model === 'string' ? json.model : model,
        answers: isPlainObject(json.answers) ? json.answers : {},
        ...(isPlainObject(json.usage) ? { usage: json.usage } : {}),
        ...(result.requestId ? { requestId: result.requestId } : {}),
      }
      await loadResults()
      rememberResult(exec.callId, value)
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
      const action = args && typeof args.action === 'string' ? args.action : 'models'
      const warnings = []
      if (action === 'models') {
        const info = await fetchInfo(ctx)
        return { action, data: isPlainObject(info) ? info : {}, ...(warnings.length ? { warnings } : {}) }
      }
      if (action === 'status') {
        const { json } = await apiRequest(ctx, { path: '/api/status', signal: exec.signal })
        return { action, data: isPlainObject(json) ? json : {}, ...(warnings.length ? { warnings } : {}) }
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
      const self = await fetchSelf(ctx, key).catch((error) => {
        warnings.push(error && error.message ? error.message : String(error))
        return null
      })
      const usage = await fetchUsage(ctx, key).catch((error) => {
        warnings.push(error && error.message ? error.message : String(error))
        return null
      })
      return {
        action: 'usage',
        keyConfigured: true,
        data: { self, usage },
        ...(warnings.length ? { warnings } : {}),
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
  if (typeof origin === 'string' && origin && origin !== 'null') {
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

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  const parsed = JSON.parse(text)
  if (!isPlainObject(parsed)) throw new Error('body must be a JSON object')
  return parsed
}

function maskKey(key) {
  if (!key) return null
  return key.length <= 11 ? `${key.slice(0, 4)}…` : `${key.slice(0, 10)}…${key.slice(-2)}`
}

const STATUS_TTL_MS = 20_000
/** Usage is a nice-to-have on the settings page: never let it hold the whole panel. */
const USAGE_TIMEOUT_MS = 4_000
let statusCache = null
let usageCache = null

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
    models: info && Array.isArray(info.models) ? info.models : [],
    limits: info && info.limits ? info.limits : null,
    ...(infoError ? { infoError } : {}),
    // Diagnostics for the settings page: the Host's own origin and the last
    // requests that actually arrived, which distinguishes "Client never
    // reached the route" from "route answered with an error".
    diagnostics: {
      serverOrigin: currentServerOrigin(ctx),
      recentRequests: recentRequests.slice(-6),
      clientReports: clientReports.slice(-12),
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
  const key = await resolveApiKey(ctx)
  if (!key) {
    const value = { keyConfigured: false, usage: null }
    usageCache = { at: Date.now(), value }
    return { ...value, cached: false, cachedAt: usageCache.at }
  }
  try {
    const [self, daily] = await Promise.all([
      fetchSelf(ctx, key, USAGE_TIMEOUT_MS),
      fetchUsage(ctx, key, USAGE_TIMEOUT_MS),
    ])
    const value = { keyConfigured: true, usage: { self, daily } }
    usageCache = { at: Date.now(), value }
    return { ...value, cached: false, cachedAt: usageCache.at }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    return { keyConfigured: true, usage: null, usageError: message }
  }
}

function invalidateUsage() {
  usageCache = null
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
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
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
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
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
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let body
        try {
          body = await readJsonBody(req, MAX_BODY_BYTES)
        } catch (error) {
          return sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
        }
        const patch = {}
        if (typeof body.apiKey === 'string') {
          const apiKey = body.apiKey.trim()
          if (apiKey) {
            if (!/^sk-vsr-[0-9A-Za-z]{40,60}$/.test(apiKey)) {
              return sendJson(res, 400, { error: 'API key should look like sk-vsr- followed by letters and digits' })
            }
            try {
              await fetchSelf(ctx, apiKey)
            } catch (error) {
              const message = error && error.message ? error.message : String(error)
              return sendJson(res, 400, { error: `key rejected: ${message}` })
            }
            patch.apiKey = apiKey
          }
        }
        if (typeof body.model === 'string' && body.model.trim()) {
          const model = body.model.trim()
          try {
            const info = await fetchInfo(ctx, { force: true })
            const known = Array.isArray(info && info.models) ? info.models.some((entry) => entry.id === model) : false
            if (!known) return sendJson(res, 400, { error: `unknown model "${model}"` })
          } catch {
            // Keep the previous model if the list cannot be fetched.
          }
          patch.model = model
        }
        if (Object.keys(patch).length === 0) {
          return sendJson(res, 400, { error: 'nothing to update' })
        }
        try {
          if (patch.apiKey) await saveApiKey(ctx, patch.apiKey)
          if (patch.model) await writeSettings({ model: patch.model })
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
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        let callId = ''
        try {
          callId = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('callId') || ''
        } catch {
          callId = ''
        }
        if (!callId) return sendJson(res, 400, { error: 'callId is required' })
        const value = await recallResult(callId)
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
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        try {
          const body = await readJsonBody(req, MAX_BODY_BYTES)
          rememberClientReport(body)
          return sendJson(res, 200, { ok: true })
        } catch (error) {
          return sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
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
    if (webServer) registerRoutes(ctx, webServer)
  })
}
