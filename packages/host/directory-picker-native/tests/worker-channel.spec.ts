import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('keeps IPC connected after showing and flushes the result before disconnecting', async () => {
  const messages: Array<{ kind: string; path?: string }> = []
  const acknowledgements: Array<() => void> = []
  const disconnect = vi.fn()
  const processStub = {
    env: { STUDYCLAW_DIALOG_TITLE: 'fixture' }, connected: true, on: vi.fn(), disconnect,
    send: (message: { kind: string; path?: string }, callback: () => void) => { messages.push(message); acknowledgements.push(callback) },
  }
  const source = readFileSync(new URL('../src/win32-dialog-worker.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(compiled, {
    exports: {}, process: processStub,
    require: (name: string) => name.includes('bindings')
      ? { loadWin32DialogBindings: async () => ({}) }
      : { runFolderDialog: (_bindings: unknown, _title: string, showing: (id: number) => void) => {
        showing(7)
        acknowledgements.shift()!()
        expect(disconnect).not.toHaveBeenCalled()
        return 'C:\\fixture'
      } },
  })
  await new Promise(resolve => setImmediate(resolve))
  expect(messages).toEqual([{ kind: 'showing', threadId: 7 }, { kind: 'done', path: 'C:\\fixture' }])
  expect(disconnect).not.toHaveBeenCalled()
  acknowledgements.shift()!()
  expect(disconnect).toHaveBeenCalledOnce()
})
