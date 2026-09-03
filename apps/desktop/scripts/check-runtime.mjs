#!/usr/bin/env node
// Fail fast unless the embedded Electron Node meets the host requirement (>=22.19).
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const electronPath = require('electron')
const out = execFileSync(electronPath, ['-e', 'process.stdout.write(process.versions.node)'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
})
const [maj, min] = out.trim().split('.').map(Number)
const ok = maj > 22 || (maj === 22 && min >= 19)
if (!ok) {
  console.error(`Embedded Node ${out} is below required ^22.19.0; upgrade electron.`)
  process.exit(1)
}
console.log(`[check-runtime] embedded Node ${out} OK`)
