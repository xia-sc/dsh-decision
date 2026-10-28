/**
 * Layout smoke test: everything the plugin writes must live under
 * $DSH_HOME/dsh-decision/, and the pre-0.1.4 dotfiles must be migrated away.
 *
 * It runs the real index.js against throwaway DSH_HOME directories, so the
 * migration path is exercised on every publish without touching the real home
 * directory or the network.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('../index.js', import.meta.url))
const failures = []

function check(ok, message) {
  if (!ok) failures.push(message)
}

/** Load a fresh copy of the Host module (the data paths are module constants). */
async function load(ctx) {
  const url = `${pathToFileURL(here).href}?smoke=${Date.now()}-${Math.random().toString(36).slice(2)}`
  const mod = await import(url)
  const tools = []
  mod.apply({
    tools: { register: (tool) => tools.push(tool) },
    effect: (fn) => fn(),
    inject: () => {},
    get: () => undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...ctx,
  })
  const ask = tools.find((tool) => tool.name === 'decision_ask')
  if (!ask) {
    failures.push('decision_ask was not registered')
    return
  }
  // Any tool call reads the settings first, which is what triggers the migration.
  // Without a key it throws right after — that is expected here.
  try {
    await ask.execute({ state: 'ping', questions: [{ type: 'noul', instructions: 'ok?' }] }, { signal: undefined })
  } catch {
    // no API key in a throwaway home: the settings read already happened
  }
}

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'dsh-decision-home-'))
}

// --- case 1: a clean upgrade from 0.1.3 (dotfiles only) --------------------
{
  const home = tempHome()
  process.env.DSH_HOME = home
  delete process.env.DECISION_API_KEY

  writeFileSync(join(home, '.dsh-decision.json'), JSON.stringify({ model: 'vllm-sr/d3-turbo' }))
  writeFileSync(join(home, '.dsh-decision-results.json'), JSON.stringify({ version: 1, entries: [] }))

  await load()

  const configPath = join(home, 'dsh-decision', 'config.json')
  const resultsPath = join(home, 'dsh-decision', 'results.json')
  check(existsSync(configPath), 'config.json was not created under dsh-decision/')
  check(existsSync(resultsPath), 'results.json was not migrated under dsh-decision/')
  check(!existsSync(join(home, '.dsh-decision.json')), '.dsh-decision.json was left behind in $DSH_HOME')
  check(!existsSync(join(home, '.dsh-decision-results.json')), '.dsh-decision-results.json was left behind in $DSH_HOME')
  if (existsSync(configPath)) {
    let model = null
    try {
      model = JSON.parse(readFileSync(configPath, 'utf8')).model
    } catch {}
    check(model === 'vllm-sr/d3-turbo', `migrated config lost the model (got ${model})`)
  }

  rmSync(home, { recursive: true, force: true })
}

// --- case 2: both layouts present (newer data wins, old file backed up) ----
{
  const home = tempHome()
  process.env.DSH_HOME = home
  mkdirSync(join(home, 'dsh-decision'), { recursive: true })
  writeFileSync(join(home, 'dsh-decision', 'config.json'), JSON.stringify({ model: 'vllm-sr/d3-ultra' }))
  writeFileSync(join(home, '.dsh-decision.json'), JSON.stringify({ model: 'stale' }))

  await load()

  const configPath = join(home, 'dsh-decision', 'config.json')
  const backupPath = join(home, 'dsh-decision', 'legacy', '.dsh-decision.json.bak')
  check(existsSync(backupPath), 'a conflicting legacy dotfile was not backed up under dsh-decision/legacy/')
  check(!existsSync(join(home, '.dsh-decision.json')), 'a conflicting legacy dotfile was left behind in $DSH_HOME')
  if (existsSync(configPath)) {
    let model = null
    try {
      model = JSON.parse(readFileSync(configPath, 'utf8')).model
    } catch {}
    check(model === 'vllm-sr/d3-ultra', `existing data was overwritten by the legacy file (got ${model})`)
  }

  rmSync(home, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('data dir smoke failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('data dir smoke ok')
