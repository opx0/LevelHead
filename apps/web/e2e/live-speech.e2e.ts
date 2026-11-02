import { expect, test } from '@playwright/test'
import { WebSocketServer } from 'ws'

test('live microphone frames stay provisional until Done and a final answer is editable', async ({
  page,
}) => {
  const sidecar = new WebSocketServer({
    host: '127.0.0.1',
    port: 3098,
    handleProtocols: (protocols) =>
      protocols.has('lh-sidecar.e2e-private-sidecar-token')
        ? 'lh-sidecar.e2e-private-sidecar-token'
        : false,
  })
  await new Promise<void>((resolve) => sidecar.once('listening', resolve))
  let frames = 0
  let done = false
  sidecar.on('connection', (socket) => {
    socket.on('message', (bytes, binary) => {
      if (binary) {
        frames += 1
        socket.send(JSON.stringify({ kind: 'ack', seq: (bytes as Buffer).readUInt32LE(0) }))
        if (frames === 1)
          socket.send(
            JSON.stringify({
              kind: 'transcript',
              revision: 1,
              text: 'working words',
              final: false,
            }),
          )
      } else if (JSON.parse(String(bytes)).kind === 'done') {
        done = true
        socket.send(
          JSON.stringify({
            kind: 'transcript',
            revision: 2,
            text: 'final spoken answer',
            final: true,
          }),
        )
      }
    })
  })
  try {
    await page.goto('/app/')
    await page.getByRole('link', { name: 'Start an interview' }).click()
    await page.getByRole('button', { name: 'Start the interview' }).click()
    await page.getByRole('button', { name: 'Live captions' }).click()
    await page.getByRole('button', { name: 'Start live speech' }).click()
    await expect(page.getByText('Live text: working words')).toBeVisible()
    await expect(page.getByPlaceholder('Answer in your own words')).toBeEmpty()
    await page.getByRole('button', { name: 'Done speaking' }).click()
    await expect(page.getByPlaceholder('Answer in your own words')).toHaveValue(
      'final spoken answer',
    )
    expect(frames).toBeGreaterThan(0)
    expect(done).toBe(true)
    await expect(page.getByRole('button', { name: 'Send answer' })).toBeVisible()
  } finally {
    for (const client of sidecar.clients) client.terminate()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test('recognizer disconnect keeps the provisional words editable without submitting', async ({
  page,
}) => {
  const sidecar = new WebSocketServer({
    host: '127.0.0.1',
    port: 3098,
    handleProtocols: (protocols) =>
      protocols.has('lh-sidecar.e2e-private-sidecar-token')
        ? 'lh-sidecar.e2e-private-sidecar-token'
        : false,
  })
  await new Promise<void>((resolve) => sidecar.once('listening', resolve))
  sidecar.on('connection', (socket) => {
    socket.once('message', (bytes) => {
      socket.send(JSON.stringify({ kind: 'ack', seq: (bytes as Buffer).readUInt32LE(0) }))
      socket.send(
        JSON.stringify({
          kind: 'transcript',
          revision: 1,
          text: 'recover these words',
          final: false,
        }),
      )
      setTimeout(() => socket.close(1011, 'recognizer failed'), 100)
    })
  })
  try {
    await page.goto('/app/')
    await page.getByRole('link', { name: 'Start an interview' }).click()
    await page.getByRole('button', { name: 'Start the interview' }).click()
    await page.getByRole('button', { name: 'Live captions' }).click()
    await page.getByRole('button', { name: 'Start live speech' }).click()
    await expect(page.getByPlaceholder('Answer in your own words')).toHaveValue(
      'recover these words',
    )
    await expect(page.getByRole('alert')).toContainText('continue in text')
    await expect(page.getByRole('button', { name: 'Send answer' })).toBeVisible()
  } finally {
    for (const client of sidecar.clients) client.terminate()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})

test('a dropped browser socket reconnects to the same recognizer before finalizing', async ({
  page,
}) => {
  const sidecar = new WebSocketServer({
    host: '127.0.0.1',
    port: 3098,
    handleProtocols: (protocols) =>
      protocols.has('lh-sidecar.e2e-private-sidecar-token')
        ? 'lh-sidecar.e2e-private-sidecar-token'
        : false,
  })
  await new Promise<void>((resolve) => sidecar.once('listening', resolve))
  let connections = 0
  let frames = 0
  sidecar.on('connection', (peer) => {
    connections += 1
    peer.on('message', (data, binary) => {
      if (binary) {
        frames += 1
        peer.send(JSON.stringify({ kind: 'ack', seq: (data as Buffer).readUInt32LE(0) }))
        if (frames === 1)
          peer.send(
            JSON.stringify({
              kind: 'transcript',
              revision: 1,
              text: 'before disconnect',
              final: false,
            }),
          )
      } else if (JSON.parse(String(data)).kind === 'done') {
        peer.send(
          JSON.stringify({
            kind: 'transcript',
            revision: 2,
            text: 'reconnected final',
            final: true,
          }),
        )
      }
    })
  })
  try {
    await page.addInitScript(() => {
      const Native = window.WebSocket
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          if (String(url).endsWith('/voice'))
            (window as Window & { liveSocket?: WebSocket }).liveSocket = this
        }
      }
    })
    await page.goto('/app/')
    await page.getByRole('link', { name: 'Start an interview' }).click()
    await page.getByRole('button', { name: 'Start the interview' }).click()
    await page.getByRole('button', { name: 'Live captions' }).click()
    await page.getByRole('button', { name: 'Start live speech' }).click()
    await expect(page.getByText('Live text: before disconnect')).toBeVisible()
    await page.evaluate(() => (window as Window & { liveSocket?: WebSocket }).liveSocket?.close())
    await expect(page.getByRole('button', { name: 'Done speaking' })).toBeVisible()
    await page.getByRole('button', { name: 'Done speaking' }).click()
    await expect(page.getByPlaceholder('Answer in your own words')).toHaveValue('reconnected final')
    expect(connections).toBe(1)
  } finally {
    for (const client of sidecar.clients) client.terminate()
    await new Promise<void>((resolve) => sidecar.close(() => resolve()))
  }
})
