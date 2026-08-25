import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin, vitestExecArgv } from './vitest.shared.ts'

// Resolution facade: tsconfig.base.json has no include, which
// vite-tsconfig-paths treats as match-all, so its paths map applies to every
// test file. paths must win over package exports so a stale built lib/ never
// loads a second module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> =>
  tsconfigPaths({ projects: ['./tsconfig.base.json'] })

export default defineConfig({
  plugins: [pathsPlugin(), standardDecoratorPlugin()],
  test: {
    globals: true,
    pool: 'forks',
    // Integration suites exercise the real HTTP/SSE adapter and can wait for
    // Windows fork/process startup when the full monorepo runs in parallel.
    testTimeout: 15_000,
    execArgv: vitestExecArgv,
    include: [
      'packages/*/*/tests/**/*.spec.ts',
      'apps/*/tests/**/*.spec.ts',
      'scripts/**/*.spec.ts',
    ],
    // Copied dsh upstream suites that import packages outside the adopted
    // closure (credentials-local / settings-file / dsh-session / fast-check).
    // The adapter's HTTP/SSE behavior is pinned by the chat-service e2e suite
    // (mock OpenAI-compatible server against the real DeepSeekAdapter).
    exclude: [
      'packages/llm/llm-deepseek/tests/adapter.spec.ts',
      'packages/llm/llm-deepseek/tests/dynamic-config.spec.ts',
      'packages/llm/llm-deepseek/tests/loader-composition.spec.ts',
      'packages/llm/llm/tests/properties.spec.ts',
    ],
  },
})
