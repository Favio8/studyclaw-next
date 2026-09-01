/**
 * Minimal CLI argv parser: `--flag value` / `--flag` / positionals.
 * Kept dependency-free to match the existing hand-rolled dispatch.
 * @module @studyclaw/cli/lib/args
 */

export interface ParsedArgs {
  positionals: string[]
  options: Record<string, string | true>
}

/** 用法错误（参数/取值非法）：bin 入口按 exit 2 处理。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('--')) {
        options[name] = next
        index += 1
      } else {
        options[name] = true
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, options }
}

/** 取选项值；`--flag` 无值时报用法错误（要求显式值）。 */
export function optionValue(parsed: ParsedArgs, name: string, fallback?: string): string | null {
  const value = parsed.options[name]
  if (value === undefined) return fallback ?? null
  if (value === true) throw new Error(`用法错误：--${name} 需要一个值`)
  return value
}
