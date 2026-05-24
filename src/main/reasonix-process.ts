import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  type AppSettingsV1
} from '../shared/app-settings'
import { findListeningProcessOnPort } from './deepseek-process'

let child: ChildProcess | null = null
let runtimeToken: string | null = null
let lastResolvedBinary: string | null = null
let activePort: number | null = null
let lastOutput = ''
let lastExit: { code: number | null; signal: NodeJS.Signals | null } | null = null

function expandHomePath(raw: string | null | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return ''
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(2))
  }
  return value
}

function redactReasonixOutput(value: string): string {
  return value
    .replace(/([?&]token=)[^\s"'&]+/gi, '$1<redacted>')
    .replace(/(REASONIX_DASHBOARD_TOKEN=)[^\s"']+/gi, '$1<redacted>')
}

function appendOutput(current: string, chunk: unknown): string {
  return `${current}${String(chunk)}`.slice(-8_000)
}

function rememberOutput(chunk: unknown): void {
  lastOutput = appendOutput(lastOutput, chunk)
}

function isReasonixCommand(command: string): boolean {
  return command.toLowerCase().includes('reasonix')
}

function configuredReasonixToken(settings: AppSettingsV1): string {
  const configured = settings.reasonix.dashboardToken.trim()
  if (configured) return configured
  if (!runtimeToken) {
    runtimeToken = randomBytes(32).toString('hex')
  }
  return runtimeToken
}

export function getReasonixBaseUrl(settings: AppSettingsV1): string {
  const host = settings.reasonix.host.trim() || '127.0.0.1'
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `http://${urlHost}:${activePort ?? settings.reasonix.port}`
}

export function getReasonixRuntimeToken(settings: AppSettingsV1): string {
  return configuredReasonixToken(settings)
}

export function getLastResolvedReasonixBinary(): string | null {
  return lastResolvedBinary
}

export function getReasonixProcessSnapshot(): {
  running: boolean
  activePort: number | null
  binary: string | null
  lastExit: { code: number | null; signal: NodeJS.Signals | null } | null
  output: string
} {
  return {
    running: isReasonixChildRunning(),
    activePort,
    binary: lastResolvedBinary,
    lastExit,
    output: redactReasonixOutput(lastOutput.trim())
  }
}

export function isReasonixChildRunning(): boolean {
  return child !== null && !child.killed
}

export function stopReasonixChild(): void {
  if (child && !child.killed) {
    child.kill('SIGTERM')
  }
  child = null
  activePort = null
}

export async function stopReasonixChildAndWait(timeoutMs = 5_000): Promise<void> {
  const proc = child
  if (!proc) return
  if (proc.killed) {
    if (child === proc) child = null
    return
  }

  await new Promise<void>((resolveDone) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.off('exit', finish)
      proc.off('error', finish)
      if (child === proc) child = null
      activePort = null
      resolveDone()
    }
    const timer = setTimeout(finish, timeoutMs)
    proc.once('exit', finish)
    proc.once('error', finish)
    proc.kill('SIGTERM')
  })
}

export async function inspectReasonixLaunchConfig(
  settings: AppSettingsV1,
  port = activePort ?? settings.reasonix.port
): Promise<
  | { state: 'absent' }
  | { state: 'non-reasonix'; pid: number; command: string }
  | { state: 'reasonix'; pid: number; command: string }
> {
  const owner = await findListeningProcessOnPort(port)
  if (!owner) return { state: 'absent' }
  const command = [owner.parentCommand, owner.command].filter(Boolean).join('\n')
  if (!isReasonixCommand(command)) {
    return { state: 'non-reasonix', pid: owner.pid, command: owner.command }
  }
  return { state: 'reasonix', pid: owner.pid, command }
}

async function findAvailablePort(host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolvePort(port)
        else reject(new Error('Could not allocate a Reasonix dashboard port.'))
      })
    })
  })
}

async function resolveLaunchPort(settings: AppSettingsV1): Promise<number> {
  if (settings.reasonix.portMode !== 'auto') return settings.reasonix.port
  return findAvailablePort(settings.reasonix.host.trim() || '127.0.0.1')
}

export async function waitForReasonixHealth(
  settings: AppSettingsV1,
  timeoutMs = 15_000
): Promise<boolean> {
  const base = getReasonixBaseUrl(settings)
  const token = getReasonixRuntimeToken(settings)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, {
        headers: {
          Accept: 'application/json',
          'X-Reasonix-Token': token
        },
        signal: AbortSignal.timeout(1500)
      })
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

export async function startReasonixChild(settings: AppSettingsV1): Promise<void> {
  if (isReasonixChildRunning()) return

  lastOutput = ''
  lastExit = null
  const launchPort = await resolveLaunchPort(settings)
  const launch = await inspectReasonixLaunchConfig(settings, launchPort)
  if (launch.state === 'non-reasonix') {
    throw new Error(
      `Port ${launchPort} is already in use by another process. Stop that process or change the Reasonix dashboard port in Settings.`
    )
  }
  if (launch.state === 'reasonix' && !isReasonixChildRunning()) {
    throw new Error(
      `A Reasonix dashboard is already listening on port ${launchPort}, but the GUI did not start it. Paste that dashboard token in Settings, stop that process, or choose another port.`
    )
  }

  const bin = settings.reasonix.binaryPath.trim() || 'reasonix'
  lastResolvedBinary = bin
  const workspaceRoot =
    expandHomePath(settings.reasonix.workspaceRoot) ||
    expandHomePath(settings.workspaceRoot) ||
    process.cwd()
  const cwd = resolve(workspaceRoot)
  const token = getReasonixRuntimeToken(settings)
  const host = settings.reasonix.host.trim() || '127.0.0.1'
  activePort = launchPort

  const args = [
    'code',
    cwd,
    '--dashboard-host',
    host,
    '--dashboard-port',
    String(launchPort),
    '--no-mouse'
  ]
  const model = settings.reasonix.model.trim()
  if (model) args.push('--model', model)

  const env: NodeJS.ProcessEnv = { ...process.env, REASONIX_DASHBOARD_TOKEN: token }
  const apiKey = settings.deepseek.apiKey.trim()
  if (apiKey) env.DEEPSEEK_API_KEY = apiKey
  const baseUrl = settings.deepseek.baseUrl.trim()
  if (baseUrl && baseUrl !== DEFAULT_DEEPSEEK_BASE_URL) {
    env.DEEPSEEK_BASE_URL = baseUrl
  }

  const proc = spawn(bin, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  child = proc
  let stdout = ''
  let stderr = ''
  proc.stdout?.on('data', (d) => {
    stdout = appendOutput(stdout, d)
    rememberOutput(d)
  })
  proc.stderr?.on('data', (d) => {
    stderr = appendOutput(stderr, d)
    rememberOutput(d)
  })
  proc.on('exit', (code, signal) => {
    lastExit = { code, signal }
    if (child === proc) child = null
    activePort = null
  })

  await new Promise<void>((resolveSpawn, reject) => {
    const cleanup = (): void => {
      proc.off('spawn', onSpawn)
      proc.off('error', onError)
      proc.off('exit', onEarlyExit)
    }
    const onSpawn = (): void => {
      cleanup()
      resolveSpawn()
    }
    const onError = (error: Error): void => {
      cleanup()
      if (child === proc) child = null
      activePort = null
      reject(error)
    }
    const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      if (child === proc) child = null
      activePort = null
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).map(redactReasonixOutput).join('\n')
      reject(
        new Error(
          `reasonix exited before startup (code ${code ?? 'null'}, signal ${signal ?? 'null'})${
            detail ? `:\n${detail}` : ''
          }`
        )
      )
    }
    proc.once('spawn', onSpawn)
    proc.once('error', onError)
    proc.once('exit', onEarlyExit)
  })
}
