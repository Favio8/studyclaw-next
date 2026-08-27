import tsconfigPaths from 'vite-tsconfig-paths'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Resolution facade: tsconfig.base.json has no include, which
// vite-tsconfig-paths treats as match-all, so its paths map applies to every
// test file. paths must win over package exports so a stale built lib/ never
// loads a second module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> =>
  tsconfigPaths({ projects: ['./tsconfig.base.json'] })

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'apps/web')

export default defineConfig({
  test: {
    // ENG-2：两个 project——(1) 既有 packages/apps 的 .spec 集群；(2) apps/web
    // 的 jsdom 组件/时序测试集群（此前必须手动 cd apps/web 才能跑到，
    // `pnpm test` 对 21 个 web 用例永久不可见）。一条命令覆盖全仓。
    projects: [
      {
        extends: true,
        plugins: [pathsPlugin(), standardDecoratorPlugin()],
        test: {
          name: 'node',
          globals: true,
          pool: 'forks',
          // Integration suites exercise the real HTTP/SSE adapter and can wait
          // for Windows fork/process startup when the monorepo runs in parallel.
          testTimeout: 15_000,
          execArgv: vitestExecArgv,
          include: [
            'packages/*/*/tests/**/*.spec.ts',
            'apps/cli/tests/**/*.spec.ts',
            'scripts/**/*.spec.ts',
          ],
          exclude: [
            // Copied dsh upstream integration suites that exercise real
            // HTTP/SSE against external endpoints; their behavior is pinned by
            // the chat-service e2e suite (mock OpenAI-compatible server).
            'packages/llm/llm-deepseek/tests/adapter.spec.ts',
            'packages/llm/llm-deepseek/tests/dynamic-config.spec.ts',
            'packages/llm/llm-deepseek/tests/loader-composition.spec.ts',
            '**/node_modules/**',
          ],
        },
      },
      {
        resolve: {
          // jsdom 集群独立解析：apps/web 组件用 "@/" 别名指向仓库内 apps/web。
          alias: { '@': webRoot },
        },
        test: {
          name: 'web',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['apps/web/tests/setup.ts'],
          include: ['apps/web/tests/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
})
