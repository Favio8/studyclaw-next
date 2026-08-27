import { describe, expect, it } from 'vitest'
import { applySyllabusQualityGuard, checkSyllabusQuality, MAX_CONCEPT_NAME_LENGTH, normalizeName } from '../src/quality-guard.ts'
import type { Syllabus } from '../src/models.ts'

function makeSyllabus(overrides: Partial<Syllabus['chapters'][number]> = {}): Syllabus {
  return {
    courseId: 'course-1',
    title: 'K8s',
    version: '1.0',
    granularity: 'fine',
    chapters: [
      {
        id: 'chapter-1',
        title: '第一章',
        description: '',
        dependencies: [],
        concepts: [{ id: 'c1', name: '调度', type: 'mechanism', prerequisites: [], masteryScore: 0 }],
        ...overrides,
      },
    ],
  }
}

describe('normalizeName', () => {
  it('trims surrounding whitespace, collapses inner runs and drops control chars', () => {
    expect(normalizeName('  hello   world \n')).toBe('hello world')
    expect(normalizeName('a\u0000b\u007fc')).toBe('a b c')
    expect(normalizeName('  ')).toBe('')
  })
})

describe('checkSyllabusQuality', () => {
  it('flags whitespace and overlength concept names', () => {
    const long = 'x'.repeat(MAX_CONCEPT_NAME_LENGTH + 1)
    const syllabus = makeSyllabus({
      concepts: [{ id: 'c1', name: '  a   b ', type: 'mechanism', prerequisites: [], masteryScore: 0 }, { id: 'c2', name: long, type: 'practice', prerequisites: [], masteryScore: 0 }],
    })
    const codes = checkSyllabusQuality(syllabus).map((issue) => issue.code)
    expect(codes).toContain('name-whitespace')
    expect(codes).toContain('name-too-long')
  })

  it('flags duplicate concept names across chapters', () => {
    const syllabus = makeSyllabus()
    syllabus.chapters.push({
      id: 'chapter-2',
      title: '第二章',
      description: '',
      dependencies: [],
      concepts: [{ id: 'c9', name: '调度', type: 'scenario', prerequisites: [], masteryScore: 0 }],
    })
    const codes = checkSyllabusQuality(syllabus).map((issue) => issue.code)
    expect(codes).toContain('duplicate-name')
  })

  it('does not flag legitimate English concept names (label rejection needs fence context)', () => {
    const syllabus = makeSyllabus({
      concepts: [{ id: 'c1', name: 'Response', type: 'mechanism', prerequisites: [], masteryScore: 0 }],
    })
    const codes = checkSyllabusQuality(syllabus).map((issue) => issue.code)
    expect(codes).not.toContain('latin-label-name')
  })

  it('flags empty chapters and oversized syllabus shape', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `ch-${i}`, title: `章 ${i}`, description: '', dependencies: [] }))
    const syllabus: Syllabus = {
      courseId: 'course-1',
      title: 'T',
      version: '1.0',
      granularity: 'coarse',
      chapters: many,
    }
    const issues = checkSyllabusQuality(syllabus)
    expect(issues.some((issue) => issue.code === 'empty-chapter')).toBe(true)
    expect(issues.some((issue) => issue.code === 'too-many-chapters')).toBe(true)
  })

  it('does not mutate the input', () => {
    const syllabus = makeSyllabus({ concepts: [{ id: 'c1', name: ' a ', type: 'mechanism', prerequisites: [], masteryScore: 0 }] })
    const before = JSON.stringify(syllabus)
    checkSyllabusQuality(syllabus)
    applySyllabusQualityGuard(syllabus)
    expect(JSON.stringify(syllabus)).toBe(before)
  })
})

describe('applySyllabusQualityGuard', () => {
  it('normalizes concept names and returns the original reference when nothing changed', () => {
    const syllabus = makeSyllabus({ concepts: [{ id: 'c1', name: ' 调度 规划 ', type: 'mechanism', prerequisites: [], masteryScore: 0 }] })
    const result = applySyllabusQualityGuard(syllabus)
    expect(result.syllabus).not.toBe(syllabus)
    expect(result.syllabus.chapters[0]!.concepts[0]!.name).toBe('调度 规划')
    expect(result.issues.map((issue) => issue.code)).toContain('name-whitespace')

    const clean = makeSyllabus()
    const untouched = applySyllabusQualityGuard(clean)
    expect(untouched.syllabus).toBe(clean)
    expect(untouched.issues).toEqual([])
  })
})
