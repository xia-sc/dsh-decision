/**
 * Pre-publish gate: the files a DSH bundle needs, a consistent package name, and
 * no API key or machine path in the shippable sources.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const required = ['index.js', 'client.js', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg']
const problems = []

for (const file of required) {
  if (!existsSync(file)) problems.push(`missing file: ${file}`)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.name !== '@xia-sc/dsh-decision') problems.push(`unexpected package name: ${pkg.name}`)
if (pkg.private === true) problems.push('package.json sets "private": true; npm cannot publish it')
if (!pkg.dsh || !pkg.dsh.bundle || !pkg.dsh.client) problems.push('package.json is missing dsh.bundle / dsh.client')
if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') problems.push('publishConfig.access must be "public" for a scoped package')

const patch = readFileSync('cordis.patch.yml', 'utf8')
if (!patch.includes('@xia-sc/dsh-decision')) problems.push('cordis.patch.yml does not name @xia-sc/dsh-decision')

const client = readFileSync('client.js', 'utf8')
if (!client.includes("id: '@xia-sc/dsh-decision'") && !client.includes('id: "@xia-sc/dsh-decision"')) {
  problems.push('client.js module id does not match the package name')
}

for (const file of ['index.js', 'client.js']) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    problems.push(`${file} has a syntax error: ${String(error.stderr || error.message).slice(0, 300)}`)
  }
}

for (const file of ['README.md', 'index.js', 'client.js']) {
  const text = readFileSync(file, 'utf8')
  if (/sk-vsr-[0-9A-Za-z]{20,}/.test(text)) problems.push(`${file} contains what looks like a real API key`)
  if (/C:\/Users\/|[A-Z]:\\\\dsh\\\\/i.test(text)) problems.push(`${file} contains a machine-specific path`)
}

if (problems.length > 0) {
  console.error('preflight failed:')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('preflight ok')
