import ts from 'typescript'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Process entries live outside the import graph and must also be shipped. */
export function assertHostArtifacts(directory) {
  assertStandaloneBundle(readFileSync(join(directory, 'bin.js'), 'utf8'))
  if (!existsSync(join(directory, 'worker.cjs'))) {
    throw new Error('Host is missing worker.cjs; the Windows directory picker cannot start')
  }
}

/** Fail before staging if a supposedly standalone bundle still needs local JS chunks. */
export function assertStandaloneBundle(text) {
  const source = ts.createSourceFile('bin.js', text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
  const dependencies = new Set()
  const record = (specifier) => {
    if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) dependencies.add(specifier.text)
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) record(node.moduleSpecifier)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (dependencies.size > 0) throw new Error(`CLI bundle is not standalone; local chunks would be missing: ${[...dependencies].join(', ')}`)
}
