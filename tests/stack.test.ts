// Against the real Docker on this machine. Each test checks what Docker did, not what kebele printed.

import { afterAll, expect, test } from 'bun:test'

import { Docker, down, list, logs, portOwner, status, up, volumeName, type Stack, type UpEvent } from '../src/index.ts'

const docker = new Docker()
const name = `kebele-test-${process.pid}`
const other = `${name}-b`
const PORT = 54381
const IMAGE = 'busybox:1.37'

const stack = (workerEnv: Record<string, string> = {}): Stack => ({
  name,
  services: {
    web: {
      image: IMAGE,
      command: ['sh', '-c', 'echo hello > /data/index.html; echo web started; exec httpd -f -p 8080 -h /data'],
      ports: [{ host: PORT, container: 8080 }],
      volumes: [{ volume: 'data', path: '/data' }],
      health: { command: ['wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/'], intervalMs: 300 },
    },
    worker: {
      image: IMAGE,
      command: ['sh', '-c', 'echo worker sees $(wget -q -O- http://web:8080/); exec sleep 3600'],
      env: workerEnv,
      dependsOn: ['web'],
    },
  },
})

const id = async (service: string) => (await docker.inspect(`${name}-${service}`))?.Id

async function collect<T>(lines: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const line of lines) out.push(line)
  return out
}

afterAll(async () => {
  await down(docker, stack(), { volumes: true })
  await down(docker, other, { volumes: true })
}, 60_000)

test('up starts services in dependency order, healthy, reachable, and on one network', async () => {
  const events: UpEvent[] = []
  const done = await up(docker, stack(), { onEvent: (e) => events.push(e) })
  expect(events.filter((e) => e.event !== 'pull')).toEqual([
    { event: 'create', service: 'web' },
    { event: 'ready', service: 'web' },
    { event: 'create', service: 'worker' },
    { event: 'ready', service: 'worker' },
  ])
  expect(done.services.find((s) => s.service === 'web')).toMatchObject({ state: 'running', health: 'healthy', ports: [{ host: PORT, container: 8080 }] })
  expect(await (await fetch(`http://127.0.0.1:${PORT}/`)).text()).toBe('hello\n')
  // The worker reached web by its service name, over the stack's network.
  let seen: string[] = []
  for (let i = 0; i < 20 && !seen.some((t) => t.includes('worker sees hello')); i++) {
    seen = (await collect(logs(docker, name, { service: 'worker' }))).map((l) => l.text)
    await Bun.sleep(200)
  }
  expect(seen).toContain('worker sees hello')
}, 120_000)

test('up again changes nothing; a changed service is replaced and the rest kept', async () => {
  const [web, worker] = [await id('web'), await id('worker')]
  const events: UpEvent[] = []
  await up(docker, stack(), { onEvent: (e) => events.push(e) })
  expect(events.map((e) => e.event)).toEqual(['ready', 'ready'])
  expect([await id('web'), await id('worker')]).toEqual([web, worker])

  events.length = 0
  await up(docker, stack({ MODE: 'b' }), { onEvent: (e) => events.push(e) })
  expect(events).toContainEqual({ event: 'replace', service: 'worker' })
  expect(await id('web')).toBe(web)
  expect(await id('worker')).not.toBe(worker)
}, 60_000)

test('logs and status read one stack; ls lists it', async () => {
  const lines = await collect(logs(docker, name, { service: 'web' }))
  expect(lines).toContainEqual({ service: 'web', stream: 'stdout', text: 'web started' })
  expect((await status(docker, name)).services.map((s) => s.service)).toEqual(['web', 'worker'])
  expect((await list(docker)).map((s) => s.name)).toContain(name)
  expect((await status(docker, `${name}-none`)).services).toEqual([])
})

test('a taken port names its holder', async () => {
  expect(await portOwner(docker, PORT)).toEqual({ port: PORT, free: false, container: `${name}-web`, stack: name, service: 'web' })
  const clash: Stack = { name: other, services: { web: { image: IMAGE, command: ['sleep', '3600'], ports: [{ host: PORT, container: 80 }] } } }
  const error = await up(docker, clash).catch((e: Error) => e)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe(`port ${PORT} for web is already taken by container ${name}-web (stack ${name})`)
}, 60_000)

test('a service that exits while starting reports its code and last output', async () => {
  const crash: Stack = { name: other, services: { boom: { image: IMAGE, command: ['sh', '-c', 'echo going down; exit 3'] } } }
  await down(docker, other)
  const error = (await up(docker, crash).catch((e) => e)) as Error & { details: { logs: string[] } }
  expect(error.message).toBe('boom exited with code 3 while starting')
  expect(error.details.logs).toContain('going down')
}, 60_000)

test('down keeps volumes; down --volumes deletes them', async () => {
  const volume = volumeName(name, 'data')
  const first = await down(docker, name)
  expect(first.removed.sort()).toEqual([`${name}-web`, `${name}-worker`])
  expect(first.volumes).toEqual([])
  expect(await docker.volumeExists(volume)).toBe(true)
  expect(await docker.network(name)).toBeUndefined()
  expect((await portOwner(docker, PORT)).free).toBe(true)

  expect((await down(docker, name, { volumes: true })).volumes).toEqual([volume])
  expect(await docker.volumeExists(volume)).toBe(false)
}, 60_000)

test('bad descriptions are refused before Docker is touched', async () => {
  await expect(up(docker, { name: 'Bad Name', services: { a: { image: IMAGE } } })).rejects.toThrow('stack name "Bad Name"')
  await expect(up(docker, { name: other, services: {} })).rejects.toThrow('has no services')
  await expect(up(docker, { name: other, services: { a: { image: IMAGE, dependsOn: ['b'] }, b: { image: IMAGE, dependsOn: ['a'] } } })).rejects.toThrow(
    'loop: a → b → a',
  )
})
