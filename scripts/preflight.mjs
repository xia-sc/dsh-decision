/**
 * Pre-publish gate for the bundle: the files it ships, the manifest every
 * install path reads, no API key or machine-specific path in the shipped
 * sources, and the smoke scripts that exercise the Client half, the data
 * directory and the Host tool/route regressions.
 *
 * Static by design: it never starts the Host, so it also runs in CI before
 * publish. Both smoke scripts use stubs / a temporary data directory and touch
 * no user data. Run it from the repository root (all paths are relative).
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/**
 * Run a Node child process. Normal environments capture its output so a failure
 * can be reported. A confined sandbox forbids opening pipes for child processes
 * (spawnSync EPERM), so fall back to inherited stdio there instead of failing a
 * gate that would otherwise pass.
 */
function runNode(args) {
  try {
    return { ok: true, stdout: execFileSync(process.execPath, args, { stdio: 'pipe' }) }
  } catch (error) {
    if (error && (error.code === 'EPERM' || /EPERM/.test(String(error.message)))) {
      try {
        execFileSync(process.execPath, args, { stdio: 'inherit' })
        return { ok: true }
      } catch (retryError) {
        return { ok: false, error: retryError }
      }
    }
    return { ok: false, error }
  }
}

function runDetail(result, lines) {
  const error = result.error
  const text = String((error && (error.stderr || error.message)) || 'unknown error')
  const parts = text.trim().split('\n')
  return (lines ? parts.slice(-lines) : parts).join(' ').slice(0, 300)
}

const required = [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'locale/en.json',
  'locale/zh.json',
  'icon.svg',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
]
const problems = []

for (const file of required) {
  if (!existsSync(file)) problems.push(`missing file: ${file}`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== '@xia-sc/dsh-decision') problems.push(`unexpected package name: ${pkg.name}`)
if (pkg.private === true) problems.push('package.json sets "private": true; npm cannot publish it')
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.client) problems.push('package.json is missing dsh.bundle / dsh.client')
if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
  problems.push('publishConfig.access must be "public" for a scoped package')
}
if (!pkg.engines || typeof pkg.engines.node !== 'string') {
  problems.push('package.json must declare engines.node (the Node version this bundle needs)')
}
// DSH's installer refuses a runtime outside engines.dsh (it wins over dsh peers),
// so a missing range means an incompatible Harness is never rejected up front.
if (!pkg.engines || typeof pkg.engines.dsh !== 'string' || pkg.engines.dsh.trim() === '') {
  problems.push('package.json must declare engines.dsh so an incompatible DSH runtime is refused')
}

// Every published subpath must resolve, and everything the bundle loads at
// runtime must be in "files" (a missing entry is only discovered after publish).
const exported = { '.': 'index.js', './client': 'client.js', './icon': 'icon.svg' }
for (const [subpath, file] of Object.entries(exported)) {
  if (!existsSync(file)) problems.push(`exports["${subpath}"] points at a missing file: ${file}`)
}
const listed = Array.isArray(pkg.files) ? pkg.files : []
for (const file of ['index.js', 'client.js', 'cordis.patch.yml', 'locale/*.json', 'icon.svg', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!listed.includes(file)) problems.push(`package.json "files" does not include ${file}`)
}

// DSH reads these for the Plugins page title/description, so a broken file hides
// the plugin there even when the JS half loads fine.
for (const file of ['locale/en.json', 'locale/zh.json']) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
  } catch (error) {
    problems.push(`${file} is not a valid JSON object: ${String(error.message || error).slice(0, 200)}`)
  }
}

const patch = readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes('@xia-sc/dsh-decision')) problems.push('cordis.patch.yml does not name @xia-sc/dsh-decision')

const client = readFileSync('client.js', 'utf8')
if (!client.includes("id: '@xia-sc/dsh-decision'") && !client.includes('id: "@xia-sc/dsh-decision"')) {
  problems.push('client.js module id does not match the package name')
}

for (const file of ['index.js', 'client.js']) {
  const result = runNode(['--check', file])
  if (!result.ok) problems.push(`${file} has a syntax error: ${runDetail(result, 3)}`)
}

// A machine-specific path or a real key must never reach npm. The patterns are
// assembled from string parts so this file does not trip its own scan (and the
// scan list below stays limited to shipped files for the same reason).
const MACHINE_PATH = new RegExp(
  [
    // C:\Users\…, E:\dsh\…, E:/dsh/…, D:\\dsh\\… (JSON-escaped), and the bare forms.
    String.raw`[A-Za-z]:[\\/]{1,2}(?:Users|dsh)(?:[\\/]|$)`,
    // \\server\Users\… / \\server\dsh\…
    String.raw`\\\\[^\\/\s]+[\\/](?:Users|dsh)[\\/]`,
    // /Users/… and /home/… (macOS / Linux home directories), not URL path segments.
    String.raw`(?<![\w.\-/])\/(?:Users|home)\/[A-Za-z0-9._-]`,
  ].join('|'),
  'i',
)
const API_KEY_SHAPE = new RegExp('sk-vsr-' + '[0-9A-Za-z]{20,}')
for (const file of ['README.md', 'CHANGELOG.md', 'index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json']) {
  const text = readFileSync(file, 'utf8')
  if (API_KEY_SHAPE.test(text)) problems.push(`${file} contains what looks like a real API key`)
  const match = MACHINE_PATH.exec(text)
  if (match) problems.push(`${file} contains a machine-specific path: ${match[0]}`)
}

// Render every registered component with a React stub: catches runtime
// ReferenceErrors that `node --check` cannot see (e.g. a missing variable in a
// hook dependency array), which would otherwise only appear as a crashed card.
// The data-dir smoke covers the on-disk layout and the legacy dotfile migration;
// the Host regression suite covers keys, limits, routes and the result store.
for (const [label, script] of [
  ['client', 'scripts/smoke-client.mjs'],
  ['data dir', 'scripts/smoke-data-dir.mjs'],
  ['host regressions', 'scripts/smoke-regressions.mjs'],
]) {
  const result = runNode([script])
  if (!result.ok) problems.push(`${label} smoke failed: ${runDetail(result, 3)}`)
}

if (problems.length > 0) {
  console.error('preflight failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('preflight ok')
