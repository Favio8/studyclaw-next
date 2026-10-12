import { describe, expect, it } from 'vitest'
import { MarkdownIngestor } from '../src/ingestor.ts'

const paper = [
  'Example Survey', 'Abstract—A survey of memory mechanisms.',
  'I. INTRODUCTION', 'Memory supports learning and inference.',
  'II. A TAXONOMY OF MEMORY IN LARGE LANGUAGE', 'MODELS',
  'A. Representation: Implicit vs. Explicit Memory', 'Representation determines where memory is stored.',
  'B. Update Dynamics: Offline vs. Online Memory', 'Updates occur during training or inference.',
  'III. IMPLICIT MEMORY VIA COMPUTATION DYNAMICS',
  'A. Attention as Implicit Memory\tC. Recurrent Memory', 'Figure labels remain body text.',
  'A. Attention as Implicit Memory', 'Attention retrieves information from the context.',
  'REFERENCES', '[1] A. Author, Bibliographic entry without lesson content.',
].join('\n')

describe('numbered academic PDF outline', () => {
  it('preserves chapters and subsections instead of collapsing the entire survey into one concept', () => {
    const art = new MarkdownIngestor().parseText(paper, 'survey.pdf', 'course')
    expect(art.syllabus.chapters.map(c => c.title)).toContain('A TAXONOMY OF MEMORY IN LARGE LANGUAGE MODELS')
    const concepts = art.syllabus.chapters.flatMap(c => c.concepts.map(item => item.name))
    expect(concepts).toContain('Representation: Implicit vs. Explicit Memory')
    expect(concepts).toContain('Update Dynamics: Offline vs. Online Memory')
    expect(concepts).toContain('Attention as Implicit Memory')
    expect(concepts.some(name => name.includes('\t'))).toBe(false)
    expect(art.chunks.some(c => c.content.includes('Bibliographic entry'))).toBe(false)
    expect(art.chunks.some(c => c.content.includes('Figure labels remain body text'))).toBe(true)
  })

  it('keeps native Markdown and ordinary prose unchanged', () => {
    const art = new MarkdownIngestor().parseText(paper, 'survey.md', 'course')
    expect(art.syllabus.chapters).toHaveLength(1)
    expect(art.chunks.some(c => c.content.includes('Bibliographic entry'))).toBe(true)
    const prose = new MarkdownIngestor().parseText('A. This is a list item.\nText without numbered academic chapters.', 'notes.pdf')
    expect(prose.syllabus.chapters).toHaveLength(1)
  })
})
