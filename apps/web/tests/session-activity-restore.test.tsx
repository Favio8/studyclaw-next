import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../src/lib/api', () => ({ api: {
  sessions: vi.fn(async () => ({ sessions: [{ sessionId: 'existing', title: 'Existing', turns: 1, lastActiveAt: null }] })),
  restoreSession: vi.fn(async () => ({ title: 'Existing', turns: [], suggestedEntry: null })),
  resumeAgent: vi.fn(async () => ({})),
} }))
import { useAppStore } from '../src/store/useAppStore'
import { useSessionActions } from '../src/hooks/useSessionActions'

describe('automatic session restoration preserves the learning activity', () => {
  it('keeps Today as the landing page even when an old conversation exists', async () => {
    useAppStore.getState().setWorkspacePath('/test/course')
    useAppStore.getState().setActiveCourse('course')
    renderHook(() => useSessionActions())
    await waitFor(() => expect(useAppStore.getState().activeSessionId).toBe('existing'))
    expect(useAppStore.getState().centerView).toBe('today')
  })
})
