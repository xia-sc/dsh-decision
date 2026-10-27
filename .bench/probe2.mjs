/**
 * Latency probe for more realistic payloads:
 *   A) text, 3 questions, ~1200-char state
 *   B) image box, d3-flash (grid scoring)
 *   C) image box, d3-turbo (native box output)
 *
 *   node .bench/probe2.mjs
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Key resolution mirrors the plugin: env first, then $DSH_HOME/.credentials.yaml. */
function loadKey() {
  if (process.env.DECISION_API_KEY) return process.env.DECISION_API_KEY.trim()
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
    const match = text.match(/DECISION_API_KEY:\s*(\S+)/)
    if (match) return match[1]
  } catch {
    // no stored key
  }
  return ''
}

const key = loadKey()
if (!key) {
  console.error('no DECISION_API_KEY: set the env var or save it from the plugin settings page')
  process.exit(1)
}

const BASE = 'https://decision.vllm-sr.ai'
const imageDataUrl = `data:image/png;base64,${readFileSync(new URL('./test.png', import.meta.url)).toString('base64')}`

const longState = [
  'Customer message: The order arrived damaged yesterday. The customer has a receipt and asks for a replacement today.',
  'Order history: three previous orders in the last year, one returned for a sizing issue, all delivered on time.',
  'Policy: replacements are shipped within two business days when the item arrived damaged and the receipt is present.',
  'The customer is on the premium plan and has contacted support twice before about delivery timing.',
  'Internal note: the warehouse flagged a damaged pallet on the same route on the same day.',
].join(' ')

const textQuestions = {
  route: {
    type: 'choice',
    instructions: 'Which team should handle this request?',
    criteria: { returns: 'Refunds, replacements and damaged deliveries', billing: 'Payments, invoices and charges', technical: 'Product setup and faults' },
  },
  receipt: { type: 'noul', instructions: 'Does the customer have a receipt?' },
  urgency: { type: 'score', instructions: 'How urgent is this request?', criteria: ['Routine', 'Soon', 'Today'] },
}

async function call(model, body) {
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify({ model, ...body }),
  })
  const text = await res.text()
  const ms = performance.now() - started
  let tokens = null
  let ok = res.ok
  try {
    const json = JSON.parse(text)
    tokens = json.usage ? json.usage.input_tokens : null
    if (json.error) ok = false
  } catch {
    ok = false
  }
  return { ms, ok, status: res.status, tokens }
}

function summary(label, samples) {
  if (samples.length === 0) return `${label}\tno samples`
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length)
  return `${label}\tN=${samples.length}\tavg=${avg}ms\tmin=${Math.round(sorted[0])}\tmedian=${Math.round(pick(0.5))}\tp90=${Math.round(pick(0.9))}\tmax=${Math.round(sorted[sorted.length - 1])}`
}

async function run(label, model, body, times) {
  await call(model, body).catch(() => {}) // warm-up
  const samples = []
  let tokens = null
  for (let i = 0; i < times; i += 1) {
    const r = await call(model, body)
    if (!r.ok) {
      console.error(`${label} #${i + 1}: HTTP ${r.status}`)
      continue
    }
    samples.push(r.ms)
    tokens = r.tokens
  }
  console.log(summary(label, samples), `\ttokens=${tokens ?? '-'}`)
}

await run('d3-flash  text/3q/1200ch', 'vllm-sr/d3-flash', { state: longState, questions: textQuestions }, 5)
await run('d3-flash  box(1 image)', 'vllm-sr/d3-flash', {
  state: 'Locate the red circle in the attached test image.',
  images: [imageDataUrl],
  questions: { where: { type: 'box', instructions: 'the red circle' } },
}, 3)
await run('d3-turbo  box(1 image)', 'vllm-sr/d3-turbo', {
  state: 'Locate the red circle in the attached test image.',
  images: [imageDataUrl],
  questions: { where: { type: 'box', instructions: 'the red circle' } },
}, 3)
