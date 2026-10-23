// The Docker Engine API over its unix socket. Nothing here runs the docker CLI.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

/** Docker Engine 25 and later speak this version. */
const API = '/v1.44'

export class KebeleError extends Error {
  readonly details: Record<string, unknown>

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.details = details
  }
}

export class DockerError extends KebeleError {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message, status === undefined ? {} : { status })
    this.status = status
  }
}

/** The unix socket of the docker CLI's current context, as `docker context use` set it. */
function contextSocket(home: string): string | undefined {
  try {
    const config = JSON.parse(readFileSync(join(home, '.docker', 'config.json'), 'utf8'))
    const name: unknown = config.currentContext
    if (typeof name !== 'string' || name === '' || name === 'default') return undefined
    const id = createHash('sha256').update(name).digest('hex')
    const meta = JSON.parse(readFileSync(join(home, '.docker', 'contexts', 'meta', id, 'meta.json'), 'utf8'))
    const host: unknown = meta?.Endpoints?.docker?.Host
    return typeof host === 'string' && host.startsWith('unix://') ? host.slice('unix://'.length) : undefined
  } catch {
    return undefined
  }
}

/** The socket the docker CLI would use, then the places Docker Desktop, OrbStack, Colima and Rancher put theirs. */
export function findSocket(): string {
  const home = homedir()
  const candidates = [
    contextSocket(home),
    '/var/run/docker.sock',
    join(home, '.docker', 'run', 'docker.sock'),
    join(home, '.orbstack', 'run', 'docker.sock'),
    join(home, '.colima', 'default', 'docker.sock'),
    join(home, '.rd', 'docker.sock'),
  ].filter((path): path is string => path !== undefined)
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    throw new KebeleError('no Docker socket found. Start Docker Desktop, OrbStack or Colima, or pass --socket <path>', { looked: candidates })
  }
  return found
}

export interface ContainerSummary {
  Id: string
  Names: string[]
  Image: string
  State: string
  Status: string
  Labels: Record<string, string>
  Ports: { IP?: string; PrivatePort: number; PublicPort?: number; Type: string }[]
}

export interface ContainerInspect {
  Id: string
  Name: string
  /** The id of the image bytes the container runs. */
  Image: string
  Config: { Image: string; Labels: Record<string, string> }
  State: { Status: string; Running: boolean; ExitCode: number; Error: string; StartedAt: string; Health?: { Status: string } }
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> }
}

export interface VolumeSummary {
  Name: string
  Labels: Record<string, string> | null
}

export interface NetworkSummary {
  Id: string
  Name: string
}

type Query = Record<string, string | number | boolean | undefined>

/** `{ label: ["a=b"] }` as Docker's `filters` query parameter. */
const filters = (value: Record<string, string[]>) => JSON.stringify(value)

/**
 * One HTTP request over the unix socket, with node:http (Node, Bun and
 * Simien all have it), as a web Response so callers read it the same way.
 */
function overSocket(socket: string, method: string, url: URL, body: unknown): Promise<Response> {
  return new Promise((resolve, reject) => {
    const sent = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        socketPath: socket,
        method,
        path: `${url.pathname}${url.search}`,
        headers: sent === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(sent) },
      },
      (res) => {
        const status = res.statusCode ?? 500
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        // A 204 or 304 has no body; a Response refuses one.
        if (status === 204 || status === 304) {
          res.resume()
          resolve(new Response(null, { status, headers }))
          return
        }
        // node:stream/web's ReadableStream is the web one at run time; their
        // TypeScript declarations just don't line up.
        resolve(new Response(Readable.toWeb(res) as unknown as ReadableStream, { status, headers }))
      },
    )
    req.on('error', reject)
    req.end(sent)
  })
}

export class Docker {
  readonly socket: string

  constructor(socket?: string) {
    this.socket = socket ?? findSocket()
  }

  async request(method: string, path: string, options: { query?: Query; body?: unknown; ok?: number[] } = {}): Promise<Response> {
    const url = new URL(`http://docker${API}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    let response: Response
    try {
      response = await overSocket(this.socket, method, url, options.body)
    } catch (error) {
      throw new DockerError(`can't reach Docker at ${this.socket}: ${error instanceof Error ? error.message : error}`)
    }
    if (!(options.ok ?? [200, 201, 204]).includes(response.status)) {
      const text = await response.text()
      let message = text.trim()
      try {
        message = JSON.parse(text).message ?? message
      } catch {}
      throw new DockerError(message || `${method} ${path} answered ${response.status}`, response.status)
    }
    return response
  }

  private async json<T>(method: string, path: string, options: { query?: Query; body?: unknown; ok?: number[] } = {}): Promise<T> {
    return (await (await this.request(method, path, options)).json()) as T
  }

  version() {
    return this.json<{ Version: string; ApiVersion: string; Os: string; Arch: string }>('GET', '/version')
  }

  async imageExists(ref: string): Promise<boolean> {
    const response = await this.request('GET', `/images/${encodeURIComponent(ref)}/json`, { ok: [200, 404] })
    await response.body?.cancel()
    return response.status === 200
  }

  /** The id of the image `ref` names on this machine, if it is here. */
  async imageId(ref: string): Promise<string | undefined> {
    const response = await this.request('GET', `/images/${encodeURIComponent(ref)}/json`, { ok: [200, 404] })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return ((await response.json()) as { Id: string }).Id
  }

  /** Pull an image. Docker reports a failed pull inside a 200 stream, so every line is checked. */
  async pull(ref: string, onLine: (line: { status?: string; id?: string }) => void = () => {}): Promise<void> {
    const response = await this.request('POST', '/images/create', { query: { fromImage: ref } })
    for await (const line of lines(response)) {
      const value = JSON.parse(line) as { status?: string; id?: string; error?: string }
      if (value.error) throw new DockerError(`pull ${ref}: ${value.error}`)
      onLine(value)
    }
  }

  containers(label: string[], all = true) {
    return this.json<ContainerSummary[]>('GET', '/containers/json', { query: { all, filters: filters({ label }) } })
  }

  async inspect(id: string): Promise<ContainerInspect | undefined> {
    const response = await this.request('GET', `/containers/${encodeURIComponent(id)}/json`, { ok: [200, 404] })
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    return (await response.json()) as ContainerInspect
  }

  async create(name: string, config: unknown): Promise<string> {
    return (await this.json<{ Id: string }>('POST', '/containers/create', { query: { name }, body: config })).Id
  }

  async start(id: string): Promise<void> {
    await this.request('POST', `/containers/${encodeURIComponent(id)}/start`, { ok: [204, 304] })
  }

  async remove(id: string): Promise<void> {
    await this.request('DELETE', `/containers/${encodeURIComponent(id)}`, { query: { force: true }, ok: [204, 404] })
  }

  volumes(label: string[]) {
    return this.json<{ Volumes: VolumeSummary[] | null }>('GET', '/volumes', { query: { filters: filters({ label }) } }).then((r) => r.Volumes ?? [])
  }

  async volumeExists(name: string): Promise<boolean> {
    const response = await this.request('GET', `/volumes/${encodeURIComponent(name)}`, { ok: [200, 404] })
    await response.body?.cancel()
    return response.status === 200
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.request('POST', '/volumes/create', { body: { Name: name, Labels: labels } })
  }

  async removeVolume(name: string): Promise<void> {
    await this.request('DELETE', `/volumes/${encodeURIComponent(name)}`, { ok: [204, 404] })
  }

  /** The network with exactly this name; Docker's name filter also matches substrings. */
  async network(name: string): Promise<NetworkSummary | undefined> {
    const found = await this.json<NetworkSummary[]>('GET', '/networks', { query: { filters: filters({ name: [name] }) } })
    return found.find((network) => network.Name === name)
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<void> {
    await this.request('POST', '/networks/create', { body: { Name: name, Labels: labels } })
  }

  async removeNetwork(name: string): Promise<void> {
    await this.request('DELETE', `/networks/${encodeURIComponent(name)}`, { ok: [204, 404] })
  }

  /** A container's output, line by line. Containers without a TTY send 8-byte framed stdout/stderr. */
  async *logs(id: string, options: { tail?: number; follow?: boolean } = {}): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
    const response = await this.request('GET', `/containers/${encodeURIComponent(id)}/logs`, {
      query: { stdout: true, stderr: true, follow: options.follow ?? false, tail: options.tail ?? 'all' },
    })
    const pending = { stdout: '', stderr: '' }
    let buffer: Uint8Array = new Uint8Array(0)
    const decoder = new TextDecoder()
    for await (const chunk of response.body ?? []) {
      buffer = concat(buffer, chunk)
      while (buffer.length >= 8) {
        const size = new DataView(buffer.buffer, buffer.byteOffset).getUint32(4)
        if (buffer.length < 8 + size) break
        const stream = buffer[0] === 2 ? 'stderr' : 'stdout'
        pending[stream] += decoder.decode(buffer.subarray(8, 8 + size))
        buffer = buffer.subarray(8 + size)
        const parts = pending[stream].split('\n')
        pending[stream] = parts.pop() ?? ''
        for (const text of parts) yield { stream, text }
      }
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      if (pending[stream]) yield { stream, text: pending[stream] }
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

async function* lines(response: Response): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of response.body ?? []) {
    pending += decoder.decode(chunk, { stream: true })
    const parts = pending.split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) if (line.trim()) yield line
  }
  if (pending.trim()) yield pending
}
