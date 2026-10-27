/**
 * Latency probe for the Decision API: one noul question per model, N timed calls
 * after one untimed warm-up. Sequential on purpose (the service queues requests).
 *
 *   node .bench/latency.mjs [model ...]
 *   N=5 by default.
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
const N = Number(process.env.N || 5)
const models = process.argv.slice(2)
if (models.length === 0) {
  console.error('usage: node .bench/latency.mjs <model> [model ...]')
  process.exit(1)
}

async function once(model) {
  const body = {
    model,
    state: 'Write a Python function that merges two sorted lists.',
    questions: {
      reasoning: { type: 'noul', instructions: 'Does answering this need multi-step reasoning?' },
    },
  }
  const started = performance.now()
  const res = await fetch(`${BASE}/v1/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { ms: performance.now() - started, status: res.status, text }
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
  return {
    n: sorted.length,
    avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    min: Math.round(sorted[0]),
    median: Math.round(pick(0.5)),
    p90: Math.round(pick(0.9)),
    max: Math.round(sorted[sorted.length - 1]),
  }
}

const rows = []
for (const model of models) {
  try {
    await once(model) // warm-up: TLS + cold routing, not counted
  } catch (error) {
    // ignore warm-up failure; the timed calls report it
  }
  const samples = []
  let tokens = null
  let failures = 0
  for (let i = 0; i < N; i += 1) {
    try {
      const result = await once(model)
      if (result.status !== 200) {
        failures += 1
        console.error(`${model} #${i + 1}: HTTP ${result.status} ${result.text.slice(0, 100)}`)
        continue
      }
      samples.push(result.ms)
      try {
        tokens = JSON.parse(result.text).usage.input_tokens
      } catch {
        // ignore
      }
    } catch (error) {
      failures += 1
      console.error(`${model} #${i + 1}: ${error && error.message ? error.message : String(error)}`)
    }
  }
  if (samples.length === 0) {
    rows.push({ model, n: 0, failures, tokens })
    continue
  }
  rows.push({ model, ...stats(samples), failures, tokens })
}

console.log('model\tN\tavg_ms\tmin\tmedian\tp90\tmax\tfail\ttokens')
for (const r of rows) {
  if (r.n === 0) {
    console.log(`${r.model}\t0\t-\t-\t-\t-\t-\t${r.failures}\t-`)
    continue
  }
  console.log(`${r.model}\t${r.n}\t${r.avg}\t${r.min}\t${r.median}\t${r.p90}\t${r.max}\t${r.failures}\t${r.tokens ?? '-'}`)
}
