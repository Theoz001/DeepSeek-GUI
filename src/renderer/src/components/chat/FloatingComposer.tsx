import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  Activity,
  Bot,
  Brain,
  Briefcase,
  ChevronDown,
  Clock3,
  Cpu,
  Database,
  FileClock,
  Gauge,
  GitCommit,
  HelpCircle,
  History,
  Languages,
  Layers,
  ListTodo,
  MonitorDot,
  Palette,
  RotateCcw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Stethoscope,
  Terminal,
  WalletCards,
  Wrench,
  X
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chat-store'
import { normalizeWorkspaceRoot } from '../../lib/workspace-path'
import { GitBranchPicker } from './GitBranchPicker'

type QueuedComposerMessage = {
  id: string
  text: string
}

type Props = {
  input: string
  setInput: (v: string) => void
  mode: 'plan' | 'agent'
  setMode: (m: 'plan' | 'agent') => void
  busy: boolean
  runtimeReady: boolean
  hasActiveThread: boolean
  composerModel: string
  composerPickList: string[]
  onComposerModelChange: (modelId: string) => void
  queuedMessages: QueuedComposerMessage[]
  onRemoveQueuedMessage: (id: string) => void
  onSend: () => void
  onInterrupt: () => void
}

type SlashCommand = {
  id: string
  slashText: string
  insertText?: string
  kind: 'local' | 'runtime'
  modeTarget?: 'plan' | 'agent'
  title: string
  description: string
  keywords: string[]
  icon: ReactElement
}

const REASONIX_SLASH_COMMANDS: Array<Omit<SlashCommand, 'title' | 'description' | 'icon'> & {
  titleKey: string
  descriptionKey: string
  iconName:
    | 'activity'
    | 'brain'
    | 'briefcase'
    | 'cpu'
    | 'database'
    | 'fileClock'
    | 'gauge'
    | 'gitCommit'
    | 'help'
    | 'history'
    | 'languages'
    | 'layers'
    | 'listTodo'
    | 'monitor'
    | 'palette'
    | 'rotate'
    | 'shield'
    | 'sliders'
    | 'stethoscope'
    | 'terminal'
    | 'wallet'
    | 'wrench'
}> = [
  {
    id: 'reasonix-help',
    slashText: '/help',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixHelpTitle',
    descriptionKey: 'slashCommandReasonixHelpDescription',
    keywords: ['help', '?', '帮助', '命令'],
    iconName: 'help'
  },
  {
    id: 'reasonix-status',
    slashText: '/status',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixStatusTitle',
    descriptionKey: 'slashCommandReasonixStatusDescription',
    keywords: ['status', '状态', 'session', 'context'],
    iconName: 'activity'
  },
  {
    id: 'reasonix-models',
    slashText: '/models',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixModelsTitle',
    descriptionKey: 'slashCommandReasonixModelsDescription',
    keywords: ['models', 'model', '模型', '列表'],
    iconName: 'cpu'
  },
  {
    id: 'reasonix-model',
    slashText: '/model <id>',
    insertText: '/model ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixModelTitle',
    descriptionKey: 'slashCommandReasonixModelDescription',
    keywords: ['model', '模型', 'switch', 'pro', 'flash'],
    iconName: 'sliders'
  },
  {
    id: 'reasonix-effort',
    slashText: '/effort <level>',
    insertText: '/effort ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixEffortTitle',
    descriptionKey: 'slashCommandReasonixEffortDescription',
    keywords: ['effort', 'reasoning', '推理', '强度'],
    iconName: 'gauge'
  },
  {
    id: 'reasonix-budget',
    slashText: '/budget',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixBudgetTitle',
    descriptionKey: 'slashCommandReasonixBudgetDescription',
    keywords: ['budget', 'cost', '预算', '费用'],
    iconName: 'wallet'
  },
  {
    id: 'reasonix-permissions',
    slashText: '/permissions',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixPermissionsTitle',
    descriptionKey: 'slashCommandReasonixPermissionsDescription',
    keywords: ['permissions', 'allowlist', '权限', '白名单'],
    iconName: 'shield'
  },
  {
    id: 'reasonix-mcp',
    slashText: '/mcp',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixMcpTitle',
    descriptionKey: 'slashCommandReasonixMcpDescription',
    keywords: ['mcp', 'tools', '工具'],
    iconName: 'database'
  },
  {
    id: 'reasonix-memory',
    slashText: '/memory',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixMemoryTitle',
    descriptionKey: 'slashCommandReasonixMemoryDescription',
    keywords: ['memory', '记忆', 'REASONIX'],
    iconName: 'brain'
  },
  {
    id: 'reasonix-skill',
    slashText: '/skill',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixSkillTitle',
    descriptionKey: 'slashCommandReasonixSkillDescription',
    keywords: ['skill', 'skills', '技能'],
    iconName: 'wrench'
  },
  {
    id: 'reasonix-hooks',
    slashText: '/hooks',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixHooksTitle',
    descriptionKey: 'slashCommandReasonixHooksDescription',
    keywords: ['hooks', 'hook', '钩子'],
    iconName: 'terminal'
  },
  {
    id: 'reasonix-doctor',
    slashText: '/doctor',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixDoctorTitle',
    descriptionKey: 'slashCommandReasonixDoctorDescription',
    keywords: ['doctor', 'health', '诊断', '检查'],
    iconName: 'stethoscope'
  },
  {
    id: 'reasonix-context',
    slashText: '/context',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixContextTitle',
    descriptionKey: 'slashCommandReasonixContextDescription',
    keywords: ['context', 'tokens', '上下文'],
    iconName: 'layers'
  },
  {
    id: 'reasonix-stats',
    slashText: '/stats',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixStatsTitle',
    descriptionKey: 'slashCommandReasonixStatsDescription',
    keywords: ['stats', 'cost', 'statistics', '统计'],
    iconName: 'monitor'
  },
  {
    id: 'reasonix-sessions',
    slashText: '/sessions',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixSessionsTitle',
    descriptionKey: 'slashCommandReasonixSessionsDescription',
    keywords: ['sessions', 'session', '会话'],
    iconName: 'history'
  },
  {
    id: 'reasonix-plans',
    slashText: '/plans',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixPlansTitle',
    descriptionKey: 'slashCommandReasonixPlansDescription',
    keywords: ['plans', 'plan', '计划', '规划'],
    iconName: 'listTodo'
  },
  {
    id: 'reasonix-plan',
    slashText: '/plan on',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixPlanTitle',
    descriptionKey: 'slashCommandReasonixPlanDescription',
    keywords: ['plan', 'planning', 'readonly', '规划'],
    iconName: 'listTodo'
  },
  {
    id: 'reasonix-mode',
    slashText: '/mode <review|auto|yolo>',
    insertText: '/mode ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixModeTitle',
    descriptionKey: 'slashCommandReasonixModeDescription',
    keywords: ['mode', 'review', 'auto', 'yolo', '模式'],
    iconName: 'palette'
  },
  {
    id: 'reasonix-checkpoint',
    slashText: '/checkpoint',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixCheckpointTitle',
    descriptionKey: 'slashCommandReasonixCheckpointDescription',
    keywords: ['checkpoint', 'snapshot', '快照'],
    iconName: 'fileClock'
  },
  {
    id: 'reasonix-restore',
    slashText: '/restore <name|id>',
    insertText: '/restore ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixRestoreTitle',
    descriptionKey: 'slashCommandReasonixRestoreDescription',
    keywords: ['restore', 'rollback', '恢复', '回滚'],
    iconName: 'rotate'
  },
  {
    id: 'reasonix-undo',
    slashText: '/undo',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixUndoTitle',
    descriptionKey: 'slashCommandReasonixUndoDescription',
    keywords: ['undo', 'rollback', '撤销'],
    iconName: 'rotate'
  },
  {
    id: 'reasonix-apply',
    slashText: '/apply',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixApplyTitle',
    descriptionKey: 'slashCommandReasonixApplyDescription',
    keywords: ['apply', 'edit', '应用', '修改'],
    iconName: 'gitCommit'
  },
  {
    id: 'reasonix-history',
    slashText: '/history',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixHistoryTitle',
    descriptionKey: 'slashCommandReasonixHistoryDescription',
    keywords: ['history', 'diff', '历史'],
    iconName: 'history'
  },
  {
    id: 'reasonix-jobs',
    slashText: '/jobs',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixJobsTitle',
    descriptionKey: 'slashCommandReasonixJobsDescription',
    keywords: ['jobs', 'background', '后台', '任务'],
    iconName: 'briefcase'
  },
  {
    id: 'reasonix-logs',
    slashText: '/logs <id>',
    insertText: '/logs ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixLogsTitle',
    descriptionKey: 'slashCommandReasonixLogsDescription',
    keywords: ['logs', 'job', '日志'],
    iconName: 'terminal'
  },
  {
    id: 'reasonix-language',
    slashText: '/language <EN|zh-CN>',
    insertText: '/language ',
    kind: 'runtime',
    titleKey: 'slashCommandReasonixLanguageTitle',
    descriptionKey: 'slashCommandReasonixLanguageDescription',
    keywords: ['language', 'lang', '语言'],
    iconName: 'languages'
  }
]

function slashIcon(name: (typeof REASONIX_SLASH_COMMANDS)[number]['iconName']): ReactElement {
  const className = 'h-4 w-4'
  const strokeWidth = 1.9
  switch (name) {
    case 'activity':
      return <Activity className={className} strokeWidth={strokeWidth} />
    case 'brain':
      return <Brain className={className} strokeWidth={strokeWidth} />
    case 'briefcase':
      return <Briefcase className={className} strokeWidth={strokeWidth} />
    case 'cpu':
      return <Cpu className={className} strokeWidth={strokeWidth} />
    case 'database':
      return <Database className={className} strokeWidth={strokeWidth} />
    case 'fileClock':
      return <FileClock className={className} strokeWidth={strokeWidth} />
    case 'gauge':
      return <Gauge className={className} strokeWidth={strokeWidth} />
    case 'gitCommit':
      return <GitCommit className={className} strokeWidth={strokeWidth} />
    case 'history':
      return <History className={className} strokeWidth={strokeWidth} />
    case 'languages':
      return <Languages className={className} strokeWidth={strokeWidth} />
    case 'layers':
      return <Layers className={className} strokeWidth={strokeWidth} />
    case 'listTodo':
      return <ListTodo className={className} strokeWidth={strokeWidth} />
    case 'monitor':
      return <MonitorDot className={className} strokeWidth={strokeWidth} />
    case 'palette':
      return <Palette className={className} strokeWidth={strokeWidth} />
    case 'rotate':
      return <RotateCcw className={className} strokeWidth={strokeWidth} />
    case 'shield':
      return <ShieldCheck className={className} strokeWidth={strokeWidth} />
    case 'sliders':
      return <SlidersHorizontal className={className} strokeWidth={strokeWidth} />
    case 'stethoscope':
      return <Stethoscope className={className} strokeWidth={strokeWidth} />
    case 'terminal':
      return <Terminal className={className} strokeWidth={strokeWidth} />
    case 'wallet':
      return <WalletCards className={className} strokeWidth={strokeWidth} />
    case 'wrench':
      return <Wrench className={className} strokeWidth={strokeWidth} />
    default:
      return <HelpCircle className={className} strokeWidth={strokeWidth} />
  }
}

function getSlashQuery(input: string): string | null {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return null
  if (/\s/.test(trimmed)) return null
  return trimmed.slice(1).toLowerCase()
}

function normalizeSlashCommandText(value: string): string {
  return value.trim().toLowerCase()
}

export function FloatingComposer({
  input,
  setInput,
  mode,
  setMode,
  busy,
  runtimeReady,
  hasActiveThread,
  composerModel,
  composerPickList,
  onComposerModelChange,
  queuedMessages,
  onRemoveQueuedMessage,
  onSend,
  onInterrupt
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const route = useChatStore((s) => s.route)
  const providerId = useChatStore((s) => s.providerId)
  const workspaceRoot = useChatStore((s) => s.workspaceRoot)
  const activeThreadId = useChatStore((s) => s.activeThreadId)
  const threads = useChatStore((s) => s.threads)
  const clawChannels = useChatStore((s) => s.clawChannels)
  const activeClawChannelId = useChatStore((s) => s.activeClawChannelId)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const composingRef = useRef(false)
  const [focused, setFocused] = useState(false)
  const activeClawChannel = useMemo(
    () => clawChannels.find((channel) => channel.id === activeClawChannelId) ?? null,
    [activeClawChannelId, clawChannels]
  )
  const activeThreadWorkspace = activeThreadId
    ? threads.find((thread) => thread.id === activeThreadId)?.workspace
    : ''
  const effectiveWorkspaceRoot = normalizeWorkspaceRoot(activeThreadWorkspace || workspaceRoot)
  const clawAgentName =
    activeClawChannel?.agentProfile.name.trim()
    || activeClawChannel?.label.trim()
    || t('clawEmptyHeroFallbackName')
  const clawHasInboundConversation = Boolean(
    activeClawChannel?.conversations.length || activeClawChannel?.remoteSession?.chatId?.trim()
  )

  const canCompose = runtimeReady && (
    route === 'claw'
      ? clawHasInboundConversation
      : (hasActiveThread || !!effectiveWorkspaceRoot)
  )
  const canChangeModel = canCompose && !busy
  const canSend = canCompose && input.trim().length > 0
  const slashQuery = getSlashQuery(input)
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0)
  const placeholder = !runtimeReady
    ? t('runtimeActionNeedsConnection')
    : !hasActiveThread && !effectiveWorkspaceRoot
      ? t('workspaceRequiredToCreateThread')
      : busy
        ? t('composerQueuePlaceholder')
        : mode === 'plan'
        ? t('composerPlanPlaceholder')
        : route === 'claw'
            ? clawHasInboundConversation
              ? t('clawPlaceholder', { name: clawAgentName })
              : t('clawPlaceholderNeedsInbound')
            : hasActiveThread
            ? t('placeholder')
            : t('composerStartsThread')
  const footerHint = !runtimeReady
    ? t('composerOfflineHint')
    : !hasActiveThread && !effectiveWorkspaceRoot
      ? t('composerWorkspaceHint')
      : mode === 'plan'
        ? t('planModeActiveHint')
        : route === 'claw'
          ? clawHasInboundConversation
            ? t('clawComposerHint')
            : t('clawComposerHintNeedsInbound')
          : t('composerSlashHint')
  const primaryActionDisabled = !canSend

  const slashCommands = useMemo<SlashCommand[]>(() => {
    const commands: SlashCommand[] = [
      {
        id: 'plan',
        slashText: '/plan',
        kind: 'local',
        modeTarget: 'plan',
        title: t('slashCommandPlanTitle'),
        description:
          mode === 'plan'
            ? t('slashCommandPlanActiveDescription')
            : t('slashCommandPlanDescription'),
        keywords: ['plan', 'planner', 'planning', '规划', '计划'],
        icon: <ListTodo className="h-4 w-4" strokeWidth={1.9} />
      }
    ]

    if (mode === 'plan') {
      commands.splice(1, 0, {
        id: 'agent',
        slashText: '/agent',
        kind: 'local',
        modeTarget: 'agent',
        title: t('slashCommandAgentTitle'),
        description: t('slashCommandAgentDescription'),
        keywords: ['agent', 'default', 'normal', '代理', '默认'],
        icon: <Bot className="h-4 w-4" strokeWidth={1.9} />
      })
    }

    if (providerId === 'reasonix-runtime' && route !== 'claw') {
      commands.push(
        ...REASONIX_SLASH_COMMANDS.map((command) => ({
          id: command.id,
          slashText: command.slashText,
          insertText: command.insertText,
          kind: command.kind,
          title: t(command.titleKey),
          description: t(command.descriptionKey),
          keywords: command.keywords,
          icon: slashIcon(command.iconName)
        }))
      )
    }

    return commands
  }, [mode, providerId, route, t])

  const filteredSlashCommands = useMemo(() => {
    if (slashQuery == null) return []
    if (!slashQuery) return slashCommands
    return slashCommands.filter((command) => {
      const haystack = [command.id, command.slashText, command.title, command.description, ...command.keywords]
      return haystack.some((part) => part.toLowerCase().includes(slashQuery))
    })
  }, [slashCommands, slashQuery])

  const highlightedSlashCommand =
    filteredSlashCommands.length > 0
      ? filteredSlashCommands[Math.min(selectedCommandIndex, filteredSlashCommands.length - 1)]
      : null
  const canSendHighlightedRuntimeCommand =
    highlightedSlashCommand?.kind === 'runtime' &&
    !highlightedSlashCommand.slashText.includes('<') &&
    normalizeSlashCommandText(input) === normalizeSlashCommandText(highlightedSlashCommand.slashText)
  const primaryActionLabel = highlightedSlashCommand && !canSendHighlightedRuntimeCommand
    ? t('slashCommandApply')
    : busy
      ? t('queueMessage')
      : t('send')

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    el.style.height = '0px'
    const nextHeight = Math.min(el.scrollHeight, 176)
    const minHeight = 44
    el.style.height = `${Math.max(nextHeight, minHeight)}px`
    el.style.overflowY = el.scrollHeight > 176 ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resizeTextarea()
  }, [canCompose, input, resizeTextarea])

  useEffect(() => {
    const el = textareaRef.current
    if (!el || typeof ResizeObserver === 'undefined') return

    let frame = 0
    let previousWidth = el.getBoundingClientRect().width
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? el.getBoundingClientRect().width
      if (Math.abs(nextWidth - previousWidth) < 0.5) return
      previousWidth = nextWidth
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(resizeTextarea)
    })

    observer.observe(el)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [resizeTextarea])

  useEffect(() => {
    setSelectedCommandIndex(0)
  }, [slashQuery])

  const focusComposer = (): void => {
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const applySlashCommand = (command: SlashCommand): void => {
    if (command.kind === 'local' && command.modeTarget) {
      setMode(command.modeTarget)
      setInput('')
      focusComposer()
      return
    }
    setInput(command.insertText ?? command.slashText)
    focusComposer()
  }

  const handlePrimaryAction = (): void => {
    if (highlightedSlashCommand && !canSendHighlightedRuntimeCommand) {
      applySlashCommand(highlightedSlashCommand)
      return
    }
    onSend()
  }

  return (
    <div className="pointer-events-auto w-full max-w-4xl px-4 pb-5 pt-1 sm:px-6 md:px-8">
      {queuedMessages.length > 0 ? (
        <div className="mb-2 rounded-[22px] border border-ds-border bg-ds-card/88 px-4 py-3 shadow-sm backdrop-blur-xl">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 text-[13px] font-medium text-ds-ink">
              <Clock3 className="h-3.5 w-3.5 text-ds-muted" strokeWidth={1.9} />
              <span>{t('queuedMessagesTitle', { count: queuedMessages.length })}</span>
            </div>
            <div className="text-[12px] text-ds-muted">{t('queuedMessagesHint')}</div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {queuedMessages.map((message, index) => (
              <div
                key={message.id}
                className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-ds-border-muted bg-ds-main/80 px-3 py-1.5 text-[13px] text-ds-ink"
              >
                <span className="shrink-0 text-ds-faint">{index + 1}.</span>
                <span className="max-w-[360px] truncate">{message.text}</span>
                <button
                  type="button"
                  onClick={() => onRemoveQueuedMessage(message.id)}
                  className="shrink-0 rounded-full p-0.5 text-ds-faint transition hover:bg-ds-hover hover:text-ds-ink"
                  aria-label={t('queuedMessageRemove')}
                  title={t('queuedMessageRemove')}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="relative">
        {slashQuery != null ? (
          <div className="ds-card-strong absolute inset-x-2 bottom-full z-30 mb-3 max-h-[min(560px,calc(100vh-220px))] overflow-hidden rounded-[26px] p-2 shadow-[0_26px_70px_rgba(15,23,42,0.16)]">
            <div className="px-3 pb-2 pt-1 text-[12px] font-medium uppercase tracking-[0.14em] text-ds-faint">
              {t('slashCommandMenuTitle')}
            </div>
            {filteredSlashCommands.length > 0 ? (
              <div className="flex max-h-[min(492px,calc(100vh-288px))] flex-col gap-1 overflow-y-auto pr-1">
                {filteredSlashCommands.map((command) => {
                  const active = highlightedSlashCommand?.id === command.id
                  return (
                    <button
                      key={command.id}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applySlashCommand(command)}
                      className={`flex w-full items-center gap-3 rounded-[20px] px-3 py-3 text-left transition ${
                        active
                          ? 'bg-accent/10 text-ds-ink shadow-[inset_0_0_0_1px_rgba(0,136,255,0.14)]'
                          : 'text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl ${
                          active ? 'bg-accent/12 text-accent' : 'bg-ds-hover text-ds-muted'
                        }`}
                      >
                        {command.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold text-inherit">
                          {command.title}
                        </span>
                        <span className="mt-0.5 block text-[13px] leading-5 text-ds-faint">
                          {command.description}
                        </span>
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-1">
                        <span className="rounded-full border border-ds-border-muted px-2.5 py-1 text-[11px] font-semibold text-ds-faint">
                          {command.slashText}
                        </span>
                        {command.kind === 'local' && command.id === 'plan' && mode === 'plan' ? (
                          <span className="rounded-full bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
                            {t('slashCommandCurrent')}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="rounded-[20px] border border-dashed border-ds-border-muted px-4 py-5 text-[13px] text-ds-faint">
                {t('slashCommandEmpty')}
              </div>
            )}
          </div>
        ) : null}

        <div
          className={`ds-composer-shell ds-chat-composer ds-frosted flex flex-col gap-2 px-4 py-2.5 transition ${
            focused ? 'ds-chat-composer-focus' : ''
          }`}
        >
          {mode === 'plan' ? (
            <div className="flex items-center gap-2 px-1 pt-1">
              <button
                type="button"
                onClick={() => setMode('agent')}
                className="ds-chip-active ds-no-drag inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold text-ds-ink transition hover:brightness-105"
                title={t('removePlan')}
                aria-label={t('removePlan')}
              >
                <ListTodo className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
                <span>{t('planMode')}</span>
              </button>
            </div>
          ) : null}

          <div className="flex items-end gap-3">
            <textarea
              ref={textareaRef}
              rows={1}
              className={`ds-no-drag block min-w-0 flex-1 resize-none break-words bg-transparent px-2 py-2 text-[15px] leading-[1.55] text-ds-ink placeholder:text-ds-faint focus:outline-none [overflow-wrap:anywhere] ${
                canCompose ? '' : 'opacity-80'
              }`}
              placeholder={placeholder}
              value={input}
              disabled={!canCompose}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onCompositionStart={() => {
                composingRef.current = true
              }}
              onCompositionEnd={() => {
                composingRef.current = false
              }}
              onKeyDown={(e) => {
                const sendByEnter =
                  e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey
                const composing =
                  e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229

                if (!composing && slashQuery != null) {
                  if (e.key === 'ArrowDown' && filteredSlashCommands.length > 0) {
                    e.preventDefault()
                    setSelectedCommandIndex((current) => (current + 1) % filteredSlashCommands.length)
                    return
                  }
                  if (e.key === 'ArrowUp' && filteredSlashCommands.length > 0) {
                    e.preventDefault()
                    setSelectedCommandIndex((current) =>
                      current === 0 ? filteredSlashCommands.length - 1 : current - 1
                    )
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setInput('')
                    return
                  }
                }

                if (!sendByEnter || composing) return

                e.preventDefault()
                handlePrimaryAction()
              }}
            />

            <label className="ds-no-drag relative hidden max-w-[220px] shrink-0 items-center sm:inline-flex">
              <span className="sr-only">{t('composerModel')}</span>
              <select
                value={composerModel}
                disabled={!canChangeModel}
                onChange={(e) => onComposerModelChange(e.target.value)}
                title={t('composerModel')}
                className={`max-w-full cursor-pointer appearance-none truncate rounded-full bg-transparent py-2 pl-3 pr-7 text-[15px] font-medium transition ${
                  canChangeModel
                    ? 'text-ds-muted hover:text-ds-ink'
                    : 'cursor-not-allowed text-ds-faint'
                }`}
              >
                <option value="">{t('composerModelDefault')}</option>
                {composerPickList.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-ds-faint" strokeWidth={1.8} />
            </label>

            {busy ? (
              <button
                type="button"
                onClick={onInterrupt}
                className="ds-no-drag flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-ds-border bg-ds-card text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink"
                aria-label={t('interrupt')}
                title={t('interrupt')}
              >
                <Square className="h-3.5 w-3.5" strokeWidth={2.4} />
              </button>
            ) : null}

            <button
              type="button"
              disabled={primaryActionDisabled}
              onClick={handlePrimaryAction}
              className="ds-no-drag flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-accent/15 bg-accent text-white shadow-[0_10px_24px_rgba(79,124,255,0.28)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:border-ds-border disabled:bg-ds-card disabled:text-ds-faint disabled:shadow-none"
              aria-label={primaryActionLabel}
              title={primaryActionLabel}
            >
              <Send className="h-4 w-4" strokeWidth={2.2} />
            </button>
          </div>
        </div>
      </div>
      <div className="mt-2 flex min-h-8 items-center justify-between gap-3 px-4">
        <GitBranchPicker workspaceRoot={effectiveWorkspaceRoot} />
        {footerHint ? (
          <div className="min-w-0 flex-1 text-right text-[13.5px] font-medium text-ds-faint">
            <span className="truncate">{footerHint}</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
