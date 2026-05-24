import type {
  AgentProvider,
  AgentProviderId,
  ChatBlock,
  NormalizedThread,
  ThreadDeltaEvent,
  ThreadEventSink,
  ToolBlock,
  UserInputAnswer,
  UserInputQuestion
} from './types'

type RuntimeErrorJson = {
  error?: string | { message?: string; status?: number }
  message?: string
}

type ReasonixMessage = {
  id: string
  role: 'user' | 'assistant' | 'info' | 'warning' | 'tool'
  text: string
  toolName?: string
  toolArgs?: string
  reasoning?: string
  severity?: 'low' | 'high'
}

type ReasonixMessagesResponse = {
  messages?: ReasonixMessage[]
  busy?: boolean
}

type PendingCommandCompletion = {
  threadId: string
  itemId: string
  detail: string
}

type ReasonixSessionRow = {
  name: string
  mtime?: number
  summary?: string
  messageCount?: number
}

type ReasonixSessionsResponse = {
  sessions?: ReasonixSessionRow[]
  currentSession?: string | null
  canSwitch?: boolean
}

type ReasonixSessionDetailResponse = {
  name: string
  messages?: Array<{
    role: string
    content?: string
    reasoning?: string
    toolCalls?: Array<{ id?: string; name?: string; arguments?: string }>
    toolCallId?: string
    toolName?: string
  }>
}

type ReasonixDashboardEvent =
  | { kind: 'assistant_delta'; id: string; contentDelta?: string; reasoningDelta?: string }
  | { kind: 'assistant_final'; id: string; text: string; reasoning?: string }
  | { kind: 'tool_start'; id: string; toolName: string; args?: string }
  | { kind: 'tool'; id: string; toolName: string; content: string; args?: string }
  | { kind: 'warning'; id: string; text: string; severity?: 'low' | 'high' }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'info'; id: string; text: string }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'busy-change'; busy: boolean }
  | { kind: 'status'; text: string }
  | { kind: 'modal-up'; modal: ReasonixModal }
  | { kind: 'modal-down'; modalKind: string }
  | { kind: 'ping' }

type ReasonixModal = {
  kind: string
  command?: string
  shellKind?: string
  path?: string
  intent?: string
  toolName?: string
  body?: string
  stepId?: string
  title?: string
  reason?: string
  total?: number
  remaining?: number
  question?: string
  options?: Array<{ id?: string; title?: string; summary?: string }>
  allowCustom?: boolean
  [key: string]: unknown
}

const CURRENT_THREAD_ID = 'reasonix-current'
const choiceOptionIdByRequestId = new Map<string, Map<string, string>>()
const IMMEDIATE_SLASH_COMMANDS = new Set([
  'about',
  'apply',
  'budget',
  'checkpoint',
  'context',
  'cost',
  'cwd',
  'dashboard',
  'discard',
  'doctor',
  'effort',
  'exit',
  'feedback',
  'help',
  'history',
  'hooks',
  'jobs',
  'keys',
  'kill',
  'language',
  'logs',
  'mcp',
  'memory',
  'mode',
  'model',
  'models',
  'permissions',
  'plan',
  'plans',
  'prompt',
  'qq',
  'resource',
  'restore',
  'search-engine',
  'sessions',
  'show',
  'skill',
  'stats',
  'status',
  'stop',
  'theme',
  'undo',
  'update',
  'walk'
])
const SLASH_ALIASES: Record<string, string> = {
  '?': 'help',
  as: 'permissions',
  clear: 'new',
  lang: 'language',
  q: 'exit',
  quit: 'exit',
  reset: 'new',
  retitle: 'title',
  sandbox: 'cwd',
  se: 'search-engine'
}

function readRuntimeError(body: string, fallback: string): RuntimeErrorJson & { message: string } {
  if (!body) return { message: fallback }
  try {
    const parsed = JSON.parse(body) as RuntimeErrorJson
    const nestedError =
      parsed.error && typeof parsed.error === 'object' ? parsed.error.message?.trim() ?? '' : ''
    const topLevelError =
      typeof parsed.error === 'string' && parsed.error.trim() ? parsed.error.trim() : ''
    const message =
      typeof parsed.message === 'string' && parsed.message.trim()
        ? parsed.message.trim()
        : topLevelError || nestedError || fallback
    return {
      ...(topLevelError ? { error: topLevelError } : {}),
      message
    }
  } catch {
    /* use raw body */
  }
  return { message: body.trim() || fallback }
}

function toRuntimeError(info: RuntimeErrorJson & { message: string }): Error {
  return new Error(
    info.error
      ? JSON.stringify({ error: info.error, message: info.message })
      : info.message
  )
}

function parseJson<T>(body: string, fallback: T): T {
  try {
    return JSON.parse(body) as T
  } catch {
    return fallback
  }
}

function selectedReasonixModel(model: string | undefined): string | null {
  const value = model?.trim()
  if (!value || value === 'auto') return null
  return value
}

function parseSlashCommand(text: string): string | null {
  const match = /^\/(\S+)/.exec(text.trim())
  if (!match) return null
  const raw = match[1]?.toLowerCase() ?? ''
  return SLASH_ALIASES[raw] ?? raw
}

function shouldCompleteSlashImmediately(text: string): boolean {
  const command = parseSlashCommand(text)
  return command ? IMMEDIATE_SLASH_COMMANDS.has(command) : false
}

function createdAtFromMtime(value: number | undefined): string {
  const timestamp = typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
  return new Date(timestamp).toISOString()
}

function threadFromSession(
  session: ReasonixSessionRow,
  workspace: string,
  currentSession: string | null | undefined
): NormalizedThread {
  const name = session.name || CURRENT_THREAD_ID
  return {
    id: name,
    title: session.summary?.trim() || name,
    updatedAt: createdAtFromMtime(session.mtime),
    model: 'Reasonix',
    mode: 'agent',
    workspace,
    status: currentSession === name ? 'current' : undefined
  }
}

function toolBlock(id: string, summary: string, status: ToolBlock['status'], detail?: string, args?: string): ToolBlock {
  return {
    kind: 'tool',
    id,
    summary,
    status,
    detail,
    meta: args ? { args } : undefined
  }
}

function blocksFromDashboardMessages(messages: ReasonixMessage[]): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const message of messages) {
    const id = message.id || `reasonix-message-${blocks.length}`
    if (message.role === 'user') {
      blocks.push({ kind: 'user', id, text: message.text })
      continue
    }
    if (message.role === 'assistant') {
      if (message.reasoning?.trim()) {
        blocks.push({ kind: 'reasoning', id: `${id}-reasoning`, text: message.reasoning })
      }
      if (message.text.trim()) {
        blocks.push({ kind: 'assistant', id, text: message.text })
      }
      continue
    }
    if (message.role === 'tool') {
      blocks.push(toolBlock(id, message.toolName || 'tool', 'success', message.text, message.toolArgs))
      continue
    }
    if (message.role === 'warning' && message.severity === 'low') continue
    blocks.push({
      kind: 'system',
      id,
      text: message.role === 'warning' ? `Warning: ${message.text}` : message.text
    })
  }
  return blocks
}

function blocksFromSessionDetail(detail: ReasonixSessionDetailResponse): ChatBlock[] {
  const blocks: ChatBlock[] = []
  const rows = Array.isArray(detail.messages) ? detail.messages : []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const id = `${detail.name || 'reasonix'}-${index}`
    if (row.role === 'user') {
      blocks.push({ kind: 'user', id, text: row.content ?? '' })
      continue
    }
    if (row.role === 'assistant') {
      if (row.reasoning?.trim()) {
        blocks.push({ kind: 'reasoning', id: `${id}-reasoning`, text: row.reasoning })
      }
      if (row.content?.trim()) {
        blocks.push({ kind: 'assistant', id, text: row.content })
      }
      for (const call of row.toolCalls ?? []) {
        blocks.push(toolBlock(call.id || `${id}-tool`, call.name || 'tool', 'running', undefined, call.arguments))
      }
      continue
    }
    if (row.role === 'tool') {
      blocks.push(toolBlock(row.toolCallId || id, row.toolName || 'tool', 'success', row.content ?? ''))
    }
  }
  return blocks
}

function createSseStreamId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `reasonix-sse-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function modalApproval(
  modal: ReasonixModal,
  nonce: number
): { approvalId: string; summary: string; toolName?: string } | null {
  if (modal.kind === 'shell') {
    return {
      approvalId: `reasonix-modal:shell:${nonce}`,
      summary: modal.command || 'Run shell command',
      toolName: modal.shellKind
    }
  }
  if (modal.kind === 'path') {
    return {
      approvalId: `reasonix-modal:path:${nonce}`,
      summary: `${modal.intent || 'access'} ${modal.path || ''}`.trim(),
      toolName: modal.toolName
    }
  }
  if (modal.kind === 'plan') {
    return {
      approvalId: `reasonix-modal:plan:${nonce}`,
      summary: modal.body?.trim() || 'Review proposed plan',
      toolName: 'submit_plan'
    }
  }
  if (modal.kind === 'edit-review') {
    const remaining = typeof modal.remaining === 'number' ? modal.remaining : undefined
    const total = typeof modal.total === 'number' ? modal.total : undefined
    const suffix = remaining !== undefined && total !== undefined ? ` (${remaining}/${total})` : ''
    return {
      approvalId: `reasonix-modal:edit-review:${nonce}`,
      summary: `${modal.path || 'Review edit'}${suffix}`,
      toolName: 'edit-review'
    }
  }
  if (modal.kind === 'checkpoint') {
    return {
      approvalId: `reasonix-modal:checkpoint:${nonce}`,
      summary: modal.title || modal.stepId || 'Continue from checkpoint',
      toolName: 'checkpoint'
    }
  }
  if (modal.kind === 'revision') {
    return {
      approvalId: `reasonix-modal:revision:${nonce}`,
      summary: modal.reason || 'Review plan revision',
      toolName: 'revise_plan'
    }
  }
  return null
}

function modalFingerprint(modal: ReasonixModal): string {
  if (modal.kind === 'shell') return `shell:${modal.command ?? ''}`
  if (modal.kind === 'path') return `path:${modal.intent ?? ''}:${modal.path ?? ''}:${modal.toolName ?? ''}`
  if (modal.kind === 'choice') {
    const optionIds = (modal.options ?? [])
      .map((option) => option.id || option.title || '')
      .join('|')
    return `choice:${modal.question ?? ''}:${optionIds}`
  }
  if (modal.kind === 'plan') return `plan:${modal.body ?? ''}`
  if (modal.kind === 'edit-review') {
    return `edit-review:${modal.path ?? ''}:${String(modal.remaining ?? '')}:${String(modal.total ?? '')}`
  }
  if (modal.kind === 'checkpoint') return `checkpoint:${modal.stepId ?? ''}:${modal.title ?? ''}`
  if (modal.kind === 'revision') return `revision:${modal.reason ?? ''}`
  return `${modal.kind}:${JSON.stringify(modal)}`
}

function modalUserInput(
  modal: ReasonixModal,
  nonce: number
): { itemId: string; requestId: string; questions: UserInputQuestion[] } | null {
  if (modal.kind !== 'choice') return null
  const rawOptions = Array.isArray(modal.options) ? modal.options : []
  const optionMap = new Map<string, string>()
  const usedLabels = new Set<string>()
  const options = rawOptions
    .map((option) => {
      const optionId = option.id?.trim()
      const baseLabel = option.title?.trim() || optionId || ''
      if (!baseLabel || !optionId) return null
      const label = usedLabels.has(baseLabel) ? `${baseLabel} (${optionId})` : baseLabel
      usedLabels.add(label)
      optionMap.set(label, optionId)
      return {
        label,
        description: option.summary?.trim() || optionId
      }
    })
    .filter((option): option is { label: string; description: string } => option != null)

  if (options.length === 0) return null
  const requestId = `reasonix-choice:${nonce}`
  choiceOptionIdByRequestId.set(requestId, optionMap)
  return {
    itemId: requestId,
    requestId,
    questions: [{
      header: 'Reasonix',
      id: 'choice',
      question: modal.question?.trim() || 'Choose an option',
      options
    }]
  }
}

function trimChoiceCache(): void {
  const maxEntries = 50
  while (choiceOptionIdByRequestId.size > maxEntries) {
    const first = choiceOptionIdByRequestId.keys().next().value
    if (!first) break
    choiceOptionIdByRequestId.delete(first)
  }
}

export class ReasonixRuntimeProvider implements AgentProvider {
  readonly id: AgentProviderId = 'reasonix-runtime'
  readonly displayName = 'Reasonix'
  private readonly pendingCommandCompletions: PendingCommandCompletion[] = []

  getCapabilities(): {
    interrupt: boolean
    stream: boolean
    approvals: boolean
    attachFiles: boolean
  } {
    return { interrupt: true, stream: true, approvals: true, attachFiles: false }
  }

  async connect(): Promise<void> {
    const health = await window.dsGui.runtimeRequest('/api/health', 'GET')
    if (!health.ok) {
      throw toRuntimeError(readRuntimeError(health.body, `Reasonix unhealthy (${health.status || 'offline'})`))
    }
    const messages = await window.dsGui.runtimeRequest('/api/messages', 'GET')
    if (!messages.ok) {
      throw toRuntimeError(readRuntimeError(messages.body, `Reasonix messages unavailable (${messages.status || 0})`))
    }
  }

  private async listSessions(): Promise<ReasonixSessionsResponse> {
    const r = await window.dsGui.runtimeRequest('/api/sessions', 'GET')
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to list Reasonix sessions'))
    return parseJson<ReasonixSessionsResponse>(r.body, {})
  }

  async listThreads(): Promise<NormalizedThread[]> {
    const settings = await window.dsGui.getSettings()
    const workspace = settings.reasonix.workspaceRoot.trim() || settings.workspaceRoot
    const body = await this.listSessions()
    const sessions = Array.isArray(body.sessions) ? body.sessions : []
    if (sessions.length === 0) {
      return [{
        id: body.currentSession || CURRENT_THREAD_ID,
        title: body.currentSession || 'Reasonix',
        updatedAt: new Date().toISOString(),
        model: 'Reasonix',
        mode: 'agent',
        workspace,
        status: 'current'
      }]
    }
    return sessions.map((session) => threadFromSession(session, workspace, body.currentSession))
  }

  async createThread(input: { workspace?: string; title?: string; mode?: string }): Promise<NormalizedThread> {
    void input
    const r = await window.dsGui.runtimeRequest('/api/sessions/new', 'POST', JSON.stringify({}))
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to create Reasonix session'))
    const body = parseJson<{ name?: string | null }>(r.body, {})
    const threads = await this.listThreads().catch(() => [])
    const id = body.name?.trim() || threads.find((thread) => thread.status === 'current')?.id || CURRENT_THREAD_ID
    return threads.find((thread) => thread.id === id) ?? {
      id,
      title: id === CURRENT_THREAD_ID ? 'Reasonix' : id,
      updatedAt: new Date().toISOString(),
      model: 'Reasonix',
      mode: 'agent',
      workspace: input.workspace,
      status: 'current'
    }
  }

  async getThreadDetail(threadId: string): Promise<{
    blocks: ChatBlock[]
    latestSeq: number
    threadStatus?: string
    latestTurnId?: string
    latestUserMessageId?: string
  }> {
    const sessions = await this.listSessions().catch(() => ({} as ReasonixSessionsResponse))
    const currentSession = sessions.currentSession || CURRENT_THREAD_ID
    if (threadId === CURRENT_THREAD_ID || threadId === currentSession) {
      const r = await window.dsGui.runtimeRequest('/api/messages', 'GET')
      if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to load Reasonix messages'))
      const body = parseJson<ReasonixMessagesResponse>(r.body, {})
      const blocks = blocksFromDashboardMessages(Array.isArray(body.messages) ? body.messages : [])
      const latestUser = [...blocks].reverse().find((block) => block.kind === 'user')
      return {
        blocks,
        latestSeq: 0,
        threadStatus: body.busy ? 'running' : 'completed',
        latestTurnId: body.busy ? `reasonix-turn-${currentSession}` : undefined,
        latestUserMessageId: latestUser?.id
      }
    }

    const r = await window.dsGui.runtimeRequest(`/api/sessions/${encodeURIComponent(threadId)}`, 'GET')
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to load Reasonix session'))
    return {
      blocks: blocksFromSessionDetail(parseJson<ReasonixSessionDetailResponse>(r.body, { name: threadId })),
      latestSeq: 0,
      threadStatus: 'completed'
    }
  }

  private async applyModel(model: string): Promise<void> {
    const r = await window.dsGui.runtimeRequest('/api/settings', 'POST', JSON.stringify({ model }))
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, `failed to switch Reasonix model to ${model}`))
  }

  private enqueueCommandCompletion(threadId: string, text: string): void {
    this.pendingCommandCompletions.push({
      threadId,
      itemId: `reasonix-command-${Date.now()}-${this.pendingCommandCompletions.length}`,
      detail: `Reasonix command accepted: ${text.trim()}`
    })
  }

  private takeCommandCompletions(threadId: string): PendingCommandCompletion[] {
    const matches: PendingCommandCompletion[] = []
    for (let index = this.pendingCommandCompletions.length - 1; index >= 0; index -= 1) {
      const item = this.pendingCommandCompletions[index]
      if (item?.threadId !== threadId) continue
      matches.unshift(item)
      this.pendingCommandCompletions.splice(index, 1)
    }
    return matches
  }

  async sendUserMessage(
    threadId: string,
    text: string,
    options?: { mode?: string; model?: string }
  ): Promise<{ turnId: string; threadId: string; userMessageItemId?: string }> {
    const sessions = await this.listSessions().catch(() => ({} as ReasonixSessionsResponse))
    const currentSession = sessions.currentSession || CURRENT_THREAD_ID
    if (threadId !== CURRENT_THREAD_ID && threadId !== currentSession) {
      const switched = await window.dsGui.runtimeRequest(
        `/api/sessions/${encodeURIComponent(threadId)}/switch`,
        'POST',
        JSON.stringify({})
      )
      if (!switched.ok) throw toRuntimeError(readRuntimeError(switched.body, 'failed to switch Reasonix session'))
    }

    const model = selectedReasonixModel(options?.model)
    if (model) await this.applyModel(model)

    const r = await window.dsGui.runtimeRequest('/api/submit', 'POST', JSON.stringify({ prompt: text }))
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to submit prompt to Reasonix'))
    if (shouldCompleteSlashImmediately(text)) this.enqueueCommandCompletion(threadId, text)
    const turnId = `reasonix-turn-${Date.now()}`
    return { turnId, threadId }
  }

  async steerUserMessage(threadId: string, _turnId: string, text: string): Promise<void> {
    await this.sendUserMessage(threadId, text)
  }

  async submitApprovalDecision(
    approvalId: string,
    decision: 'allow' | 'deny',
    remember = false
  ): Promise<void> {
    const kind = approvalId.match(/^reasonix-modal:([^:]+)(?::|$)/)?.[1]
    const choice = (() => {
      if (kind === 'shell' || kind === 'path') {
        return decision === 'allow' ? (remember ? 'always_allow' : 'run_once') : 'deny'
      }
      if (kind === 'plan') return decision === 'allow' ? 'approve' : 'cancel'
      if (kind === 'edit-review') return decision === 'allow' ? 'apply' : 'reject'
      if (kind === 'checkpoint') return decision === 'allow' ? 'continue' : 'stop'
      if (kind === 'revision') return decision === 'allow' ? 'accept' : 'reject'
      return null
    })()
    if (!kind || !choice) return
    const r = await window.dsGui.runtimeRequest(
      '/api/modal/resolve',
      'POST',
      JSON.stringify({ kind, choice })
    )
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'Reasonix modal resolution failed'))
  }

  async submitUserInputResponse(requestId: string, answers: UserInputAnswer[]): Promise<void> {
    if (!requestId.startsWith('reasonix-choice:')) return
    const answer = answers[0]
    if (!answer) return
    const optionMap = choiceOptionIdByRequestId.get(requestId)
    const optionId = optionMap?.get(answer.label) ?? optionMap?.get(answer.value)
    const choice = optionId
      ? { kind: 'pick', optionId }
      : { kind: 'custom', text: answer.value.trim() || answer.label }
    const r = await window.dsGui.runtimeRequest(
      '/api/modal/resolve',
      'POST',
      JSON.stringify({ kind: 'choice', choice })
    )
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'Reasonix choice resolution failed'))
    choiceOptionIdByRequestId.delete(requestId)
  }

  async cancelUserInput(requestId: string): Promise<void> {
    if (!requestId.startsWith('reasonix-choice:')) return
    const r = await window.dsGui.runtimeRequest(
      '/api/modal/resolve',
      'POST',
      JSON.stringify({ kind: 'choice', choice: { kind: 'cancel' } })
    )
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'Reasonix choice cancellation failed'))
    choiceOptionIdByRequestId.delete(requestId)
  }

  async interruptTurn(_threadId: string, _turnId: string): Promise<void> {
    const r = await window.dsGui.runtimeRequest('/api/abort', 'POST', JSON.stringify({}))
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to abort Reasonix turn'))
  }

  async renameThread(_threadId: string, _title: string): Promise<void> {
    // Reasonix dashboard does not expose session rename over /api yet.
  }

  async deleteThread(threadId: string): Promise<void> {
    if (threadId === CURRENT_THREAD_ID) return
    const r = await window.dsGui.runtimeRequest(`/api/sessions/${encodeURIComponent(threadId)}`, 'DELETE')
    if (!r.ok) throw toRuntimeError(readRuntimeError(r.body, 'failed to delete Reasonix session'))
  }

  async subscribeThreadEvents(
    threadId: string,
    sinceSeq: number,
    sink: ThreadEventSink,
    signal: AbortSignal
  ): Promise<void> {
    void threadId
    let nextSeq = sinceSeq
    let reconnectDelayMs = 750
    let turnActive = false
    const seenContentDeltaIds = new Set<string>()
    const seenReasoningDeltaIds = new Set<string>()
    let activeModalKey: string | null = null

    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        if (signal.aborted) {
          resolve()
          return
        }
        const timer = window.setTimeout(() => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        const onAbort = (): void => {
          window.clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })

    while (!signal.aborted) {
      const streamId = createSseStreamId()
      try {
        const outcome = await new Promise<{ type: 'end' } | { type: 'error'; error: Error; status?: number }>(
          async (resolve) => {
            let settled = false
            const cleanup = (): void => {
              offData()
              offEnd()
              offErr()
              signal.removeEventListener('abort', onAbort)
            }
            const finish = (result: { type: 'end' } | { type: 'error'; error: Error; status?: number }): void => {
              if (settled) return
              settled = true
              cleanup()
              resolve(result)
            }
            const markSeq = (): number => {
              nextSeq += 1
              sink.onSeq(nextSeq)
              return nextSeq
            }
            const emitDeltas = (deltas: ThreadDeltaEvent[]): void => {
              if (deltas.length) {
                turnActive = true
                sink.onDeltas(deltas)
              }
            }
            const emitModal = (modal: ReasonixModal, seq: number): void => {
              const key = modalFingerprint(modal)
              if (activeModalKey === key) return
              const approval = modalApproval(modal, seq)
              const userInput = modalUserInput(modal, seq)
              if (!approval && !userInput) return
              activeModalKey = key
              trimChoiceCache()
              if (approval) sink.onApproval(approval)
              if (userInput) sink.onUserInput(userInput)
            }
            const emitActiveModalSnapshot = async (): Promise<void> => {
              try {
                const r = await window.dsGui.runtimeRequest('/api/modal', 'GET')
                if (!r.ok) return
                const body = parseJson<{ modal?: ReasonixModal | null }>(r.body, {})
                if (body.modal) emitModal(body.modal, markSeq())
              } catch {
                /* Older Reasonix builds may not expose /api/modal. */
              }
            }
            const emitQueuedCommandCompletions = (): void => {
              for (const completion of this.takeCommandCompletions(threadId)) {
                markSeq()
                sink.onTool({
                  itemId: completion.itemId,
                  summary: 'Reasonix command',
                  status: 'success',
                  detail: completion.detail
                })
                sink.onTurnComplete()
              }
            }

            const offData = window.dsGui.onSseEvent(({ streamId: sid, data }) => {
              if (sid !== streamId) return
              reconnectDelayMs = 750
              const ev = data as ReasonixDashboardEvent
              if (!ev || typeof ev.kind !== 'string' || ev.kind === 'ping') return

              if (ev.kind === 'busy-change') {
                if (ev.busy) {
                  turnActive = true
                  return
                }
                if (turnActive) {
                  turnActive = false
                  sink.onTurnComplete()
                }
                return
              }

              const seq = markSeq()
              if (ev.kind === 'user') {
                turnActive = true
                sink.onUserMessage({ itemId: ev.id, turnId: `reasonix-turn-${ev.id}`, text: ev.text })
                return
              }
              if (ev.kind === 'assistant_delta') {
                const deltas: ThreadDeltaEvent[] = []
                if (ev.reasoningDelta) {
                  seenReasoningDeltaIds.add(ev.id)
                  deltas.push({ text: ev.reasoningDelta, kind: 'agent_reasoning', seq })
                }
                if (ev.contentDelta) {
                  seenContentDeltaIds.add(ev.id)
                  deltas.push({ text: ev.contentDelta, kind: 'agent_message', seq })
                }
                emitDeltas(deltas)
                return
              }
              if (ev.kind === 'assistant_final') {
                const deltas: ThreadDeltaEvent[] = []
                if (ev.reasoning && !seenReasoningDeltaIds.has(ev.id)) {
                  deltas.push({ text: ev.reasoning, kind: 'agent_reasoning', seq })
                }
                if (ev.text && !seenContentDeltaIds.has(ev.id)) {
                  deltas.push({ text: ev.text, kind: 'agent_message', seq })
                }
                emitDeltas(deltas)
                return
              }
              if (ev.kind === 'tool_start') {
                turnActive = true
                sink.onTool({
                  itemId: ev.id,
                  summary: ev.toolName,
                  status: 'running',
                  detail: ev.args,
                  meta: ev.args ? { args: ev.args } : undefined
                })
                return
              }
              if (ev.kind === 'tool') {
                turnActive = true
                sink.onTool({
                  itemId: ev.id,
                  summary: ev.toolName,
                  status: 'success',
                  detail: ev.content,
                  meta: ev.args ? { args: ev.args } : undefined
                })
                return
              }
              if (ev.kind === 'modal-up') {
                emitModal(ev.modal, seq)
                return
              }
              if (ev.kind === 'modal-down') {
                activeModalKey = null
                return
              }
              if (ev.kind === 'warning' || ev.kind === 'info' || ev.kind === 'status') {
                const text = ev.kind === 'status' ? ev.text : ev.text
                if (ev.kind !== 'warning' || ev.severity !== 'low') {
                  sink.onTool({
                    itemId: ev.kind === 'status' ? `reasonix-status-${seq}` : ev.id,
                    summary: ev.kind,
                    status: 'success',
                    detail: text
                  })
                }
                return
              }
              if (ev.kind === 'error') {
                sink.onError(new Error(ev.text))
              }
            })

            const offErr = window.dsGui.onSseError(({ streamId: sid, message, status }) => {
              if (sid !== streamId) return
              finish({
                type: 'error',
                error: new Error(message ?? `Reasonix SSE error ${status ?? ''}`),
                status
              })
            })

            const offEnd = window.dsGui.onSseEnd(({ streamId: sid }) => {
              if (sid !== streamId) return
              finish({ type: 'end' })
            })

            const onAbort = (): void => {
              cleanup()
              void window.dsGui.stopSse(streamId)
              resolve({ type: 'end' })
            }

            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
            try {
              await emitActiveModalSnapshot()
              emitQueuedCommandCompletions()
              await window.dsGui.startSse(threadId, nextSeq, streamId)
            } catch (e) {
              finish({
                type: 'error',
                error: e instanceof Error ? e : new Error(String(e))
              })
            }
          }
        )

        if (signal.aborted) return
        if (outcome.type === 'error' && outcome.status && outcome.status >= 400 && outcome.status < 500) {
          sink.onError(outcome.error)
          return
        }
      } catch (e) {
        if (signal.aborted) return
        if (e instanceof Error && /aborted/i.test(e.message)) return
      } finally {
        void window.dsGui.stopSse(streamId)
      }

      await wait(reconnectDelayMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000)
    }
  }
}
