import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  modelDir,
  parseArgs,
  planStack,
  planStream,
  servicesFor,
  sessionName,
  StackConfigError,
} from './local-stack.ts'

const baseEnv = (): Record<string, string | undefined> => ({
  DATABASE_URL: 'postgres://levelhead:levelhead@localhost:5432/levelhead',
})

async function streamingAssets(root: string): Promise<Record<string, string>> {
  const dir = join(root, 'stream')
  await mkdir(dir, { recursive: true })
  const files: Record<string, string> = {}
  for (const name of ['tokens.txt', 'encoder.onnx', 'decoder.onnx', 'joiner.onnx']) {
    const path = join(dir, name)
    await writeFile(path, '')
    files[name] = path
  }
  return {
    VOICE_STREAM_TOKEN: 'private-e2e-token-0001',
    VOICE_STREAM_TOKENS: files['tokens.txt'] ?? '',
    VOICE_STREAM_ENCODER: files['encoder.onnx'] ?? '',
    VOICE_STREAM_DECODER: files['decoder.onnx'] ?? '',
    VOICE_STREAM_JOINER: files['joiner.onnx'] ?? '',
  }
}

test('unknown commands and arguments are refused instead of guessed at', () => {
  expect(typeof parseArgs([])).toBe('string')
  expect(typeof parseArgs(['deploy'])).toBe('string')
  expect(typeof parseArgs(['start', '--force'])).toBe('string')
  expect(typeof parseArgs(['logs', 'app', 'worker'])).toBe('string')

  const start = parseArgs(['start', '--no-model'], false)
  expect(start).toEqual({ action: 'start', attach: false, model: false })
  expect(parseArgs(['start'], true)).toEqual({ action: 'start', attach: true, model: true })
  expect(parseArgs(['logs', 'voice'], false)).toEqual({
    action: 'logs',
    attach: false,
    model: true,
    pane: 'voice',
  })
})

test('the session name stays a plain tmux target rather than shell input', () => {
  expect(sessionName({})).toBe('levelhead')
  expect(sessionName({ LEVELHEAD_STACK_SESSION: 'practice-2' })).toBe('practice-2')
  expect(() => sessionName({ LEVELHEAD_STACK_SESSION: 'a;rm -rf /' })).toThrow(StackConfigError)
  expect(() => sessionName({ LEVELHEAD_STACK_SESSION: '' })).toThrow(StackConfigError)
})

test('model downloads default to the ignored .levelhead directory and stay overridable', () => {
  expect(modelDir({}, '/repo')).toBe('/repo/.levelhead/models/llama')
  expect(modelDir({ LEVELHEAD_MODEL_DIR: '/models/llama' }, '/repo')).toBe('/models/llama')
  expect(modelDir({ LEVELHEAD_MODEL_DIR: 'cache/llama' }, '/repo')).toBe('/repo/cache/llama')
})

test('the stack starts db plus model by default, and stops only those compose services', () => {
  expect(servicesFor(true)).toEqual(['db', 'llama'])
  expect(servicesFor(false)).toEqual(['db'])
})

test('a complete plan labels one pane per process and names the missing stream assets', () => {
  const plan = planStack(baseEnv(), { model: true }, '/repo')
  expect(plan.session).toBe('levelhead')
  expect(plan.composeFile).toBe('infra/docker-compose.yml')
  expect(plan.services).toEqual(['db', 'llama'])
  expect(plan.panes.map((pane) => pane.window)).toEqual(['app', 'worker', 'voice'])
  expect(plan.panes[0]?.env).toEqual({
    LEVELHEAD_STORE: 'postgres',
    DATABASE_URL: 'postgres://levelhead:levelhead@localhost:5432/levelhead',
  })
  expect(plan.notes.join('\n')).toContain('pane not started — missing VOICE_STREAM_TOKEN')
  expect(plan.notes.join('\n')).toContain('/repo/.levelhead/models/llama')

  const textOnly = planStack(baseEnv(), { model: false }, '/repo')
  expect(textOnly.services).toEqual(['db'])

  expect(() =>
    planStack(
      { ...baseEnv(), LEVELHEAD_LOCAL_ONLY: 'true', MODEL_PROVIDER_API_KEY: 'sk-test' },
      { model: true },
    ),
  ).toThrow(/Local-only generation rejects MODEL_PROVIDER_API_KEY/)
  expect(() => planStack({ ...baseEnv(), LEVELHEAD_LOCAL_ONLY: 'yes' }, { model: true })).toThrow(
    /LEVELHEAD_LOCAL_ONLY must be true or false/,
  )
})

test('a partly configured streaming sidecar is refused, never half-started', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'levelhead-stream-'))
  try {
    const assets = await streamingAssets(dir)
    expect(planStream(assets, dir)).toEqual({ enabled: true, missing: [] })

    const partially = { ...assets }
    delete partially.VOICE_STREAM_DECODER
    expect(() => planStream(partially, dir)).toThrow(/missing VOICE_STREAM_DECODER/)

    expect(() => planStream({ ...assets, VOICE_STREAM_TOKEN: 'short' }, dir)).toThrow(
      /16\+ character URL-safe/,
    )
    expect(() =>
      planStream({ ...assets, VOICE_STREAM_ENCODER: join(dir, 'absent.onnx') }, dir),
    ).toThrow(/VOICE_STREAM_ENCODER points at .*absent\.onnx, which does not exist/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a running stack adds the streaming pane only when all four assets exist', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'levelhead-stream-'))
  try {
    const plan = planStack({ ...baseEnv(), ...(await streamingAssets(dir)) }, { model: true }, dir)
    expect(plan.panes.map((pane) => pane.window)).toEqual(['app', 'worker', 'voice', 'stream'])
    expect(plan.panes.at(-1)?.command).toBe('bun run voice:stream')
    expect(plan.notes.join('\n')).toContain('streaming ASR: configured')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('postgres configuration is required and validated before any container starts', () => {
  expect(() => planStack({}, { model: true })).toThrow(/DATABASE_URL is required/)
  expect(() => planStack({ DATABASE_URL: 'not a url' }, { model: true })).toThrow(/not a valid URL/)
  expect(() => planStack({ DATABASE_URL: 'sqlite://local' }, { model: true })).toThrow(
    /must be a postgres:\/\/ URL/,
  )
})
