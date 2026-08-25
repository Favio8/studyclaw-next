/**
 * `studyclaw review` — due-only review rounds: thin wrapper over `runQuiz`
 * with mode=review (the `courses.quiz` review mode returns SM-2 due cards
 * only, no new-card fill), defaulting to 50 cards like the Python CLI.
 * @module @studyclaw/cli/commands/review
 */

import { parseArgs, UsageError } from '../lib/args.ts'
import { makeQuizDeps, runQuiz } from './quiz.ts'

/** `studyclaw review [count] [--course <id>] [--concept <id>]` */
export async function reviewCommand(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv)
  const positionalCount = parsed.positionals[0]
  const count = positionalCount !== undefined ? parseInt(positionalCount, 10) : parseInt(String(parsed.options.count ?? '50'), 10)
  if (!Number.isInteger(count) || count < 1 || count > 100) throw new UsageError('题数必须是 1..100 的整数')
  await runQuiz(makeQuizDeps(), {
    courseId: parsed.options.course === undefined ? null : String(parsed.options.course),
    conceptId: parsed.options.concept === undefined ? null : String(parsed.options.concept),
    mode: 'review',
    count,
    headline: 'REVIEW',
    dueOnly: true,
  })
}
