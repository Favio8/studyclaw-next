import { describe, expect, it } from 'vitest'
import { assertHostArtifacts, assertStandaloneBundle } from './bundle-contract.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('single-file CLI bundle contract', () => {
  it('rejects a Host missing its directory-picker process entry before staging', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sc-host-artifacts-'))
    try {
      writeFileSync(join(directory, 'bin.js'), "import fs from 'node:fs'")
      expect(() => assertHostArtifacts(directory)).toThrow('missing worker.cjs')
      writeFileSync(join(directory, 'worker.cjs'), '')
      expect(() => assertHostArtifacts(directory)).not.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it.each(["import { x } from './chunk.js';", "export { x } from './chunk.js';", "await import('./chunk.js');"])("rejects a local dependency: %s", source => {
    expect(() => assertStandaloneBundle(source)).toThrow(/local chunks would be missing/)
  })
  it('permits external runtime dependencies and relative text in comments/strings', () => {
    expect(() => assertStandaloneBundle("import fs from 'node:fs'; await import('pdf-parse'); const example = `import './example.js'`; // import('./ignored.js')")).not.toThrow()
  })
})
