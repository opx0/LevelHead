import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkLocalGeneration } from '../apps/cli/src/adapters/local-only.ts'

// One command for the local practice stack. Every long-running process gets its own labelled tmux
// window so a crash stays readable next to the processes that are still fine, and `stop` touches
// only the session this script created plus the services declared in infra/docker-compose.yml.
// Nothing here starts a hosted provider or claims anything about model quality.

const COMPOSE_FILE = 'infra/docker-compose.yml'
const DEFAULT_SESSION = 'levelhead'
const DB_CONTAINER = 'levelhead-db'
const STREAM_TOKEN = 'VOICE_STREAM_TOKEN'
const STREAM_ASSETS = [
  'VOICE_STREAM_TOKENS',
  'VOICE_STREAM_ENCODER',
  'VOICE_STREAM_DECODER',
  'VOICE_STREAM_JOINER',
] as const

export type Action = 'start' | 'stop' | 'status' | 'logs'

export interface Options {
  action: Action
  pane?: string
  attach: boolean
  model: boolean
}

export interface Pane {
  window: string
  label: string
  command: string
  env: Record<string, string>
}

export interface StackPlan {
  session: string
  composeFile: string
  modelDir: string
  services: string[]
  panes: Pane[]
  notes: string[]
}

export class StackConfigError extends Error {}

const usage = `usage: bun run scripts/local-stack.ts <start|stop|status|logs> [options]

  start              validate config, start db/model services, migrate, then create or attach
  stop               close the stack session and stop only the Levelhead Compose services
  status             show session windows and Compose service health
  logs [pane]        print the last 60 lines from one pane, or from every pane

options:
  --no-model         skip the llama.cpp service; text-only practice still runs
  --no-attach        set the session up and return instead of attaching (implies start)
  --attach           attach even when stdout is not a TTY

environment:
  LEVELHEAD_STACK_SESSION   tmux session name, default ${DEFAULT_SESSION}
  LEVELHEAD_MODEL_DIR       host path for llama.cpp downloads, default .levelhead/models/llama`

export function parseArgs(argv: readonly string[], tty = false): Options | string {
  const command = argv[0]
  if (command === undefined) return usage
  if (command !== 'start' && command !== 'stop' && command !== 'status' && command !== 'logs') {
    return `unknown command: ${command}\n\n${usage}`
  }
  const options: Options = { action: command, attach: tty && command === 'start', model: true }
  for (const arg of argv.slice(1)) {
    if (arg === '--no-model') options.model = false
    else if (arg === '--no-attach') options.attach = false
    else if (arg === '--attach') options.attach = true
    else if (!arg.startsWith('-') && command === 'logs' && options.pane === undefined) {
      options.pane = arg
    } else return `unknown argument: ${arg}\n\n${usage}`
  }
  return options
}

export function sessionName(env: Record<string, string | undefined>): string {
  const name = (env.LEVELHEAD_STACK_SESSION ?? DEFAULT_SESSION).trim()
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) {
    throw new StackConfigError(
      `LEVELHEAD_STACK_SESSION must be 1-40 letters, digits, "_" or "-", got "${name}"`,
    )
  }
  return name
}

export function modelDir(env: Record<string, string | undefined>, cwd = process.cwd()): string {
  const configured = env.LEVELHEAD_MODEL_DIR?.trim()
  return resolve(
    cwd,
    configured !== undefined && configured !== ''
      ? configured
      : join('.levelhead', 'models', 'llama'),
  )
}

export function servicesFor(model: boolean): string[] {
  return model ? ['db', 'llama'] : ['db']
}

export interface StreamPlan {
  enabled: boolean
  missing: string[]
}

// A half-configured streaming sidecar is refused rather than silently skipped: the gateway would
// otherwise advertise a microphone path that cannot decode. With nothing configured, the pane is
// simply omitted and the missing variables are named on stdout.
export function planStream(
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
): StreamPlan {
  const configured = [STREAM_TOKEN, ...STREAM_ASSETS].filter(
    (key) => (env[key] ?? '').trim() !== '',
  )
  if (configured.length === 0) {
    return { enabled: false, missing: [STREAM_TOKEN, ...STREAM_ASSETS] }
  }
  const missing = [STREAM_TOKEN, ...STREAM_ASSETS].filter((key) => (env[key] ?? '').trim() === '')
  if (missing.length > 0) {
    throw new StackConfigError(
      `streaming ASR is partly configured; set or unset every VOICE_STREAM_* value (missing ${missing.join(', ')})`,
    )
  }
  const token = (env[STREAM_TOKEN] ?? '').trim()
  if (token.length < 16 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new StackConfigError(
      `${STREAM_TOKEN} must be a private 16+ character URL-safe value (letters, digits, "_" or "-")`,
    )
  }
  for (const key of STREAM_ASSETS) {
    const value = (env[key] ?? '').trim()
    const path = resolve(cwd, value)
    if (!existsSync(path)) {
      throw new StackConfigError(
        `${key} points at ${value}, which does not exist; provision the streaming assets or unset every VOICE_STREAM_* value`,
      )
    }
  }
  return { enabled: true, missing: [] }
}

export function planStack(
  env: Record<string, string | undefined>,
  options: Pick<Options, 'model'>,
  cwd = process.cwd(),
): StackPlan {
  const databaseUrl = env.DATABASE_URL?.trim()
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new StackConfigError(
      'DATABASE_URL is required for the local stack; copy .env.example values into .env (file-backed practice can still use bun run serve)',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(databaseUrl)
  } catch {
    throw new StackConfigError('DATABASE_URL is not a valid URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new StackConfigError('DATABASE_URL must be a postgres:// URL for the local stack')
  }
  // Reuses the server's own local-only rule instead of keeping a second copy of it.
  checkLocalGeneration(env)
  const stream = planStream(env, cwd)
  const dir = modelDir(env, cwd)
  const notes = [
    `model downloads: ${dir} (host-owned, ignored by git)`,
    stream.enabled
      ? 'streaming ASR: configured; one pane will run the sidecar'
      : `streaming ASR: pane not started — missing ${stream.missing.join(', ')}`,
  ]
  const panes: Pane[] = [
    {
      window: 'app',
      label: 'app server',
      command: 'bun run serve',
      env: { LEVELHEAD_STORE: 'postgres', DATABASE_URL: databaseUrl },
    },
    {
      window: 'worker',
      label: 'worker',
      command: 'bun run worker',
      env: { LEVELHEAD_STORE: 'postgres', DATABASE_URL: databaseUrl },
    },
    { window: 'voice', label: 'batch voice', command: 'bun run voice:up', env: {} },
  ]
  if (stream.enabled) {
    panes.push({
      window: 'stream',
      label: 'streaming ASR',
      command: 'bun run voice:stream',
      env: {},
    })
  }
  return {
    session: sessionName(env),
    composeFile: COMPOSE_FILE,
    modelDir: dir,
    services: servicesFor(options.model),
    panes,
    notes,
  }
}

interface RunOptions {
  inherit?: boolean
  allowFailure?: boolean
}

function run(file: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: options.inherit === true ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    throw new Error(`${file} could not run: ${result.error.message}`)
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = (result.stderr ?? '').trim() || (result.stdout ?? '').trim()
    throw new Error(`${file} ${args.join(' ')} failed${detail === '' ? '' : `:\n${detail}`}`)
  }
  return result.stdout ?? ''
}

function compose(args: string[], options: RunOptions = {}): string {
  return run('docker', ['compose', '-f', COMPOSE_FILE, ...args], options)
}

function tmux(args: string[], options: RunOptions = {}): string {
  return run('tmux', args, options)
}

// Passed explicitly so a tmux server that started before an .env edit cannot leave the panes with
// a stale database URL while the stack validated a different one.
function envArgs(pane: Pane): string[] {
  return Object.entries(pane.env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
}

function sessionExists(session: string): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', session], { encoding: 'utf8' })
  return result.status === 0
}

function requireTool(file: string, versionArgs: string[], hint: string): void {
  const result = spawnSync(file, versionArgs, { encoding: 'utf8' })
  if (result.status !== 0) throw new StackConfigError(`${file} is required; ${hint}`)
}

async function waitForHealthy(container: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000
  const format = '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
  while (Date.now() < deadline) {
    const state = spawnSync('docker', ['inspect', '--format', format, container], {
      encoding: 'utf8',
    })
    const statusText = (state.stdout ?? '').trim()
    if (state.status === 0 && (statusText === 'healthy' || statusText === 'running')) return
    await new Promise((settle) => setTimeout(settle, 500))
  }
  throw new Error(`${container} did not become healthy within ${seconds}s; run bun run status`)
}

async function start(plan: StackPlan, options: Options): Promise<void> {
  requireTool('tmux', ['-V'], 'install tmux to run the stack in labelled panes')
  requireTool(
    'docker',
    ['--version'],
    'install Docker with the Compose plugin, or use bun run serve for text-only practice',
  )
  await mkdir(plan.modelDir, { recursive: true })
  // Hand Compose the same absolute path the plan validated, and this user's ids, so the mount and
  // the downloaded files cannot drift from the path the stack reported as owned by the caller.
  process.env.LEVELHEAD_MODEL_DIR = plan.modelDir
  if (typeof process.getuid === 'function') {
    process.env.LEVELHEAD_MODEL_UID = String(process.getuid())
    process.env.LEVELHEAD_MODEL_GID = String(process.getgid?.() ?? process.getuid())
  }

  console.log(`starting ${plan.services.join(' + ')}`)
  compose(['up', '-d', 'db'])
  if (options.model) compose(['--profile', 'models', 'up', '-d', 'llama'])
  await waitForHealthy(DB_CONTAINER, 60)
  console.log('applying migrations')
  try {
    run('bun', ['run', 'db:migrate'], { inherit: true })
  } catch {
    throw new Error(
      'migrations failed. If Postgres reported "password authentication failed", DATABASE_URL in .env does not match the local container ' +
        '(infra/docker-compose.yml uses postgres://levelhead:levelhead@localhost:5432/levelhead). Fix DATABASE_URL, or rebuild the ' +
        'local database with: bun run db:reset --yes',
    )
  }

  for (const note of plan.notes) console.log(`  ${note}`)

  if (sessionExists(plan.session)) {
    console.log(`tmux session "${plan.session}" already exists; reusing it`)
  } else {
    const [first, ...rest] = plan.panes
    if (first === undefined) throw new Error('no panes to start')
    tmux([
      'new-session',
      '-d',
      '-s',
      plan.session,
      '-n',
      first.window,
      '-c',
      process.cwd(),
      ...envArgs(first),
      first.command,
    ])
    // A process that exits keeps its output in the pane instead of closing the window, so a
    // failure cannot hide behind the panes that are still logging.
    tmux(['set-option', '-t', plan.session, 'remain-on-exit', 'on'])
    tmux(['set-window-option', '-t', `${plan.session}:${first.window}`, 'automatic-rename', 'off'])
    for (const pane of rest) {
      tmux([
        'new-window',
        '-t',
        plan.session,
        '-n',
        pane.window,
        '-c',
        process.cwd(),
        ...envArgs(pane),
        pane.command,
      ])
      tmux(['set-window-option', '-t', `${plan.session}:${pane.window}`, 'automatic-rename', 'off'])
    }
  }

  console.log('')
  for (const pane of plan.panes) {
    console.log(`  ${plan.session}:${pane.window.padEnd(7)} ${pane.label}`)
  }
  console.log('')
  console.log(`  attach: tmux attach -t ${plan.session}`)
  console.log(`  status: bun run status    logs: bun run logs    stop: bun run stop`)

  if (options.attach) tmux(['attach-session', '-t', plan.session], { inherit: true })
}

function stop(plan: StackPlan): void {
  if (sessionExists(plan.session)) {
    tmux(['kill-session', '-t', plan.session])
    console.log(`closed tmux session "${plan.session}"`)
  } else {
    console.log(`tmux session "${plan.session}" is not running`)
  }
  // Explicit service names: never `docker stop` and never another Compose project.
  const stopped = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'stop', ...plan.services], {
    encoding: 'utf8',
  })
  if (stopped.status === 0) {
    console.log(`stopped Compose services: ${plan.services.join(', ')}`)
  } else {
    const detail = (stopped.stderr ?? '').trim() || (stopped.stdout ?? '').trim()
    console.log(`Compose services were not stopped: ${detail || 'docker compose stop failed'}`)
  }
}

interface ServiceState {
  Name?: string
  Service?: string
  State?: string
  Health?: string
}

function status(plan: StackPlan): void {
  if (sessionExists(plan.session)) {
    console.log(`tmux session "${plan.session}":`)
    const windows = tmux([
      'list-windows',
      '-t',
      plan.session,
      '-F',
      '#{window_name}\t#{pane_dead}\t#{pane_current_command}',
    ])
    for (const line of windows.trim().split('\n')) {
      if (line === '') continue
      const [name, dead, command] = line.split('\t')
      const state = dead === '1' ? 'EXITED — read its pane' : `running ${command ?? ''}`
      console.log(`  ${(name ?? '').padEnd(7)} ${state}`)
    }
  } else {
    console.log(`tmux session "${plan.session}": not running`)
  }

  const raw = compose(['ps', '--format', 'json'], { allowFailure: true })
  const services: ServiceState[] = []
  for (const line of raw.trim().split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as ServiceState | ServiceState[]
      // Compose has emitted both NDJSON and a single JSON array depending on the version.
      if (Array.isArray(parsed)) services.push(...parsed)
      else services.push(parsed)
    } catch {
      // Compose can print a warning line; skip anything that is not a service record.
    }
  }
  console.log('compose services:')
  for (const service of services) {
    const health = service.Health === undefined ? '' : ` (${service.Health})`
    console.log(
      `  ${(service.Service ?? service.Name ?? 'unknown').padEnd(10)} ${service.State ?? 'unknown'}${health}`,
    )
  }
  if (services.length === 0) console.log('  none created yet')
  console.log(`model cache: ${plan.modelDir}`)
}

function logs(plan: StackPlan, pane: string | undefined): void {
  if (!sessionExists(plan.session)) {
    throw new Error(`tmux session "${plan.session}" is not running; start it with bun run start`)
  }
  const windows = tmux(['list-windows', '-t', plan.session, '-F', '#{window_name}'])
    .trim()
    .split('\n')
    .filter((name) => name !== '')
  const targets = pane === undefined ? windows : [pane]
  for (const target of targets) {
    if (!windows.includes(target)) {
      throw new Error(`no pane "${target}" in ${plan.session}; available: ${windows.join(', ')}`)
    }
    console.log(`\n== ${plan.session}:${target} ==`)
    console.log(tmux(['capture-pane', '-p', '-t', `${plan.session}:${target}`, '-S', '-60']))
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.stdout.isTTY === true)
  if (typeof options === 'string') {
    console.error(options)
    process.exit(2)
  }
  const env = process.env
  const base = {
    session: sessionName(env),
    composeFile: COMPOSE_FILE,
    modelDir: modelDir(env),
    services: servicesFor(options.model),
    panes: [],
    notes: [],
  }
  if (options.action === 'start') {
    await start(planStack(env, options), options)
  } else if (options.action === 'stop') {
    stop(base)
  } else if (options.action === 'status') {
    status(base)
  } else {
    logs(base, options.pane)
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`local stack: ${message}`)
    process.exit(1)
  })
}
