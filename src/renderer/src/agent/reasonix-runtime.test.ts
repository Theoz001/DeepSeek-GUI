import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReasonixRuntimeProvider } from './reasonix-runtime'
import type {
  ThreadDeltaEvent,
  ThreadEventSink,
  ToolEventPayload,
  UserInputRequestPayload,
  UserMessageEventPayload
} from './types'

function noopSink(overrides: Partial<ThreadEventSink> = {}): ThreadEventSink {
  return {
    onSeq: vi.fn(),
    onDeltas: vi.fn(),
    onUserMessage: vi.fn(),
    onTool: vi.fn(),
    onApproval: vi.fn(),
    onUserInput: vi.fn(),
    onUserInputStatus: vi.fn(),
    onTurnComplete: vi.fn(),
    onError: vi.fn(),
    ...overrides
  }
}

describe('ReasonixRuntimeProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('maps Reasonix SSE events to GUI stream events', async () => {
    const provider = new ReasonixRuntimeProvider()
    const ac = new AbortController()
    const dataHandlers: Array<(payload: { streamId: string; data: unknown }) => void> = []
    const endHandlers: Array<(payload: { streamId: string }) => void> = []
    const deltas: ThreadDeltaEvent[][] = []
    const users: UserMessageEventPayload[] = []
    const tools: ToolEventPayload[] = []
    const errors: Error[] = []
    const sink = noopSink({
      onDeltas: (items) => deltas.push(items),
      onUserMessage: (item) => users.push(item),
      onTool: (item) => tools.push(item),
      onError: (err) => errors.push(err)
    })

    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      dsGui: {
        runtimeRequest: vi.fn(async (path: string) => {
          if (path === '/api/modal') {
            return { ok: true, status: 200, body: JSON.stringify({ modal: null }) }
          }
          return { ok: true, status: 200, body: '{}' }
        }),
        onSseEvent: vi.fn((handler) => {
          dataHandlers.push(handler)
          return vi.fn()
        }),
        onSseError: vi.fn(() => vi.fn()),
        onSseEnd: vi.fn((handler) => {
          endHandlers.push(handler)
          return vi.fn()
        }),
        startSse: vi.fn(async (_threadId: string, _sinceSeq: number, streamId: string) => {
          const emit = (data: unknown): void => {
            for (const handler of dataHandlers) handler({ streamId, data })
          }
          emit({ kind: 'user', id: 'user-1', text: 'hello' })
          emit({
            kind: 'assistant_delta',
            id: 'assistant-1',
            reasoningDelta: 'thinking ',
            contentDelta: 'hi'
          })
          emit({
            kind: 'assistant_final',
            id: 'assistant-1',
            reasoning: 'thinking full',
            text: 'hi full'
          })
          emit({
            kind: 'assistant_final',
            id: 'assistant-2',
            reasoning: 'done reasoning',
            text: 'done'
          })
          emit({ kind: 'tool_start', id: 'tool-1', toolName: 'shell', args: 'pwd' })
          emit({ kind: 'tool', id: 'tool-1', toolName: 'shell', args: 'pwd', content: '/tmp' })
          emit({ kind: 'warning', id: 'warn-low', text: 'skip me', severity: 'low' })
          emit({ kind: 'warning', id: 'warn-high', text: 'check this', severity: 'high' })
          emit({ kind: 'status', text: 'working' })
          emit({ kind: 'error', id: 'error-1', text: 'failed' })
          emit({ kind: 'busy-change', busy: false })
          for (const handler of endHandlers) handler({ streamId })
          ac.abort()
        }),
        stopSse: vi.fn(async () => undefined)
      }
    })

    await provider.subscribeThreadEvents('reasonix-current', 0, sink, ac.signal)

    expect(users).toEqual([
      { itemId: 'user-1', turnId: 'reasonix-turn-user-1', text: 'hello' }
    ])
    expect(deltas).toEqual([
      [
        { text: 'thinking ', kind: 'agent_reasoning', seq: 2 },
        { text: 'hi', kind: 'agent_message', seq: 2 }
      ],
      [
        { text: 'done reasoning', kind: 'agent_reasoning', seq: 4 },
        { text: 'done', kind: 'agent_message', seq: 4 }
      ]
    ])
    expect(tools).toEqual([
      {
        itemId: 'tool-1',
        summary: 'shell',
        status: 'running',
        detail: 'pwd',
        meta: { args: 'pwd' }
      },
      {
        itemId: 'tool-1',
        summary: 'shell',
        status: 'success',
        detail: '/tmp',
        meta: { args: 'pwd' }
      },
      {
        itemId: 'warn-high',
        summary: 'warning',
        status: 'success',
        detail: 'check this'
      },
      {
        itemId: 'reasonix-status-9',
        summary: 'status',
        status: 'success',
        detail: 'working'
      }
    ])
    expect(errors.map((err) => err.message)).toEqual(['failed'])
    expect(sink.onTurnComplete).toHaveBeenCalledTimes(1)
  })

  it('maps an active Reasonix choice modal to GUI user input and resolves by option id', async () => {
    const provider = new ReasonixRuntimeProvider()
    const ac = new AbortController()
    let resolveBody = ''
    const inputs: UserInputRequestPayload[] = []
    const sink = noopSink({
      onUserInput: (input) => inputs.push(input)
    })

    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      dsGui: {
        runtimeRequest: vi.fn(async (path: string, _method: string, body?: string) => {
          if (path === '/api/modal') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({
                modal: {
                  kind: 'choice',
                  question: 'Pick a session',
                  options: [
                    { id: 'alpha-session', title: 'Alpha', summary: 'Use alpha' },
                    { id: 'beta-session', title: 'Beta', summary: 'Use beta' }
                  ]
                }
              })
            }
          }
          if (path === '/api/modal/resolve') {
            resolveBody = body ?? ''
            return { ok: true, status: 200, body: '{}' }
          }
          return { ok: true, status: 200, body: '{}' }
        }),
        onSseEvent: vi.fn(() => vi.fn()),
        onSseError: vi.fn(() => vi.fn()),
        onSseEnd: vi.fn(() => vi.fn()),
        startSse: vi.fn(async () => {
          ac.abort()
        }),
        stopSse: vi.fn(async () => undefined)
      }
    })

    await provider.subscribeThreadEvents('reasonix-current', 0, sink, ac.signal)

    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.questions[0]?.question).toBe('Pick a session')
    expect(inputs[0]?.questions[0]?.options.map((option) => option.label)).toEqual(['Alpha', 'Beta'])

    await provider.submitUserInputResponse(inputs[0]!.requestId, [
      { id: 'choice', label: 'Alpha', value: 'Alpha' }
    ])

    expect(JSON.parse(resolveBody)).toEqual({
      kind: 'choice',
      choice: { kind: 'pick', optionId: 'alpha-session' }
    })
  })

  it('submits prompts, switches sessions, and aborts through Reasonix dashboard APIs', async () => {
    const provider = new ReasonixRuntimeProvider()
    const calls: Array<{ path: string; method: string; body?: string }> = []

    vi.stubGlobal('window', {
      dsGui: {
        runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
          calls.push({ path, method, body })
          if (path === '/api/sessions') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ currentSession: 'current-session', sessions: [] })
            }
          }
          return { ok: true, status: 200, body: '{}' }
        })
      }
    })

    await provider.sendUserMessage('other-session', 'hello reasonix')
    await provider.interruptTurn('other-session', 'turn-1')

    expect(calls).toEqual([
      { path: '/api/sessions', method: 'GET', body: undefined },
      { path: '/api/sessions/other-session/switch', method: 'POST', body: '{}' },
      { path: '/api/submit', method: 'POST', body: JSON.stringify({ prompt: 'hello reasonix' }) },
      { path: '/api/abort', method: 'POST', body: '{}' }
    ])
  })

  it('applies the selected Reasonix model before submitting a prompt', async () => {
    const provider = new ReasonixRuntimeProvider()
    const calls: Array<{ path: string; method: string; body?: string }> = []

    vi.stubGlobal('window', {
      dsGui: {
        runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
          calls.push({ path, method, body })
          if (path === '/api/sessions') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ currentSession: 'current-session', sessions: [] })
            }
          }
          return { ok: true, status: 200, body: '{}' }
        })
      }
    })

    await provider.sendUserMessage('current-session', 'use pro', { model: 'deepseek-v4-pro' })

    expect(calls).toEqual([
      { path: '/api/sessions', method: 'GET', body: undefined },
      { path: '/api/settings', method: 'POST', body: JSON.stringify({ model: 'deepseek-v4-pro' }) },
      { path: '/api/models', method: 'GET', body: undefined },
      { path: '/api/submit', method: 'POST', body: JSON.stringify({ prompt: 'use pro' }) }
    ])
  })

  it('falls back to the native Reasonix model command when settings do not update the live model', async () => {
    const provider = new ReasonixRuntimeProvider()
    const calls: Array<{ path: string; method: string; body?: string }> = []

    vi.stubGlobal('window', {
      dsGui: {
        runtimeRequest: vi.fn(async (path: string, method: string, body?: string) => {
          calls.push({ path, method, body })
          if (path === '/api/sessions') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ currentSession: 'current-session', sessions: [] })
            }
          }
          if (path === '/api/models') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ current: 'deepseek-v4-flash', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
            }
          }
          return { ok: true, status: 200, body: '{}' }
        })
      }
    })

    await provider.sendUserMessage('current-session', 'use pro', { model: 'deepseek-v4-pro' })

    expect(calls).toEqual([
      { path: '/api/sessions', method: 'GET', body: undefined },
      { path: '/api/settings', method: 'POST', body: JSON.stringify({ model: 'deepseek-v4-pro' }) },
      { path: '/api/models', method: 'GET', body: undefined },
      { path: '/api/submit', method: 'POST', body: JSON.stringify({ prompt: '/model deepseek-v4-pro' }) },
      { path: '/api/submit', method: 'POST', body: JSON.stringify({ prompt: 'use pro' }) }
    ])
  })

  it('completes immediate slash commands that do not emit Reasonix busy events', async () => {
    const provider = new ReasonixRuntimeProvider()
    const ac = new AbortController()
    const tools: ToolEventPayload[] = []
    const sink = noopSink({
      onTool: (tool) => tools.push(tool)
    })

    vi.stubGlobal('window', {
      setTimeout,
      clearTimeout,
      dsGui: {
        runtimeRequest: vi.fn(async (path: string) => {
          if (path === '/api/sessions') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ currentSession: 'current-session', sessions: [] })
            }
          }
          if (path === '/api/models') {
            return {
              ok: true,
              status: 200,
              body: JSON.stringify({ current: 'deepseek-v4-pro', models: ['deepseek-v4-flash', 'deepseek-v4-pro'] })
            }
          }
          if (path === '/api/modal') {
            return { ok: true, status: 200, body: JSON.stringify({ modal: null }) }
          }
          return { ok: true, status: 200, body: '{}' }
        }),
        onSseEvent: vi.fn(() => vi.fn()),
        onSseError: vi.fn(() => vi.fn()),
        onSseEnd: vi.fn(() => vi.fn()),
        startSse: vi.fn(async () => {
          ac.abort()
        }),
        stopSse: vi.fn(async () => undefined)
      }
    })

    await provider.sendUserMessage('current-session', '/models')
    await provider.subscribeThreadEvents('current-session', 0, sink, ac.signal)

    expect(tools).toEqual([
      expect.objectContaining({
        summary: 'Reasonix command',
        status: 'success',
        detail: [
          'Current model: deepseek-v4-pro',
          '',
          'Available models:',
          '- deepseek-v4-flash',
          '- deepseek-v4-pro'
        ].join('\n')
      })
    ])
    expect(sink.onTurnComplete).toHaveBeenCalledTimes(1)
  })
})
