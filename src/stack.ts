// Stacks: a named set of services, their volumes and one private network, kept in step with a
// typed description. `up` is idempotent: a container whose description hasn't changed is left
// running, and one whose description changed is replaced. Volumes outlive `down` unless asked.

import { createHash } from 'node:crypto'
import { createServer } from 'node:net'

import { Docker, DockerError, KebeleError, type ContainerSummary } from './docker.ts'

export interface Port {
  /** Port on this machine. */
  host: number
  /** Port inside the container. */
  container: number
  /** Address to bind on this machine; 127.0.0.1 unless you say otherwise. */
  ip?: string
}

export interface Mount {
  /** Volume name inside the stack; Docker names it `<stack>_<volume>`. */
  volume: string
  path: string
}

export interface Health {
  /** Run inside the container; exit code 0 means healthy. */
  command: string[]
  intervalMs?: number
  timeoutMs?: number
  retries?: number
}

export interface Service {
  image: string
  command?: string[]
  env?: Record<string, string>
  ports?: Port[]
  volumes?: Mount[]
  health?: Health
  /** Services that must be ready before this one starts. */
  dependsOn?: string[]
}

export interface Stack {
  name: string
  services: Record<string, Service>
}

export interface ServiceStatus {
  service: string
  container: string
  image: string
  /** Docker's state: running, exited, created, restarting, ... */
  state: string
  /** healthy, unhealthy or starting when the service has a health check. */
  health?: string
  ports: { host: number; container: number; ip: string }[]
}

export interface StackStatus {
  name: string
  services: ServiceStatus[]
}

export type UpEvent =
  | { event: 'pull'; image: string }
  | { event: 'create'; service: string }
  | { event: 'replace'; service: string }
  | { event: 'start'; service: string }
  | { event: 'ready'; service: string }

const LABEL = { stack: 'kebele.stack', service: 'kebele.service', spec: 'kebele.spec' }
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const STEADY_MS = 1000

export const containerName = (stack: string, service: string) => `${stack}-${service}`
export const volumeName = (stack: string, volume: string) => `${stack}_${volume}`
export const networkName = (stack: string) => stack

function validate(stack: Stack): string[] {
  if (!NAME.test(stack.name)) throw new KebeleError(`stack name "${stack.name}" must be lowercase letters, digits, - and _`)
  const names = Object.keys(stack.services)
  if (names.length === 0) throw new KebeleError(`stack ${stack.name} has no services`)
  for (const [name, service] of Object.entries(stack.services)) {
    if (!NAME.test(name)) throw new KebeleError(`service name "${name}" must be lowercase letters, digits, - and _`)
    for (const mount of service.volumes ?? []) {
      if (!NAME.test(mount.volume)) throw new KebeleError(`volume name "${mount.volume}" must be lowercase letters, digits, - and _`)
    }
    for (const dependency of service.dependsOn ?? []) {
      if (!stack.services[dependency]) throw new KebeleError(`service ${name} depends on ${dependency}, which isn't in stack ${stack.name}`)
    }
  }
  // Dependencies first.
  const order: string[] = []
  const visiting = new Set<string>()
  const visit = (name: string, path: string[]) => {
    if (order.includes(name)) return
    if (visiting.has(name)) throw new KebeleError(`services depend on each other in a loop: ${[...path, name].join(' → ')}`)
    visiting.add(name)
    for (const dependency of stack.services[name]?.dependsOn ?? []) visit(dependency, [...path, name])
    visiting.delete(name)
    order.push(name)
  }
  for (const name of names) visit(name, [])
  return order
}

/** A fingerprint of everything that shapes the container. Secrets in `env` go in hashed, never as text. */
function spec(stack: string, service: Service): string {
  return createHash('sha256').update(JSON.stringify([stack, service])).digest('hex').slice(0, 32)
}

const nanoseconds = (ms: number) => ms * 1_000_000

function containerConfig(stack: Stack, name: string, service: Service) {
  const network = networkName(stack.name)
  const exposed: Record<string, object> = {}
  const bindings: Record<string, { HostIp: string; HostPort: string }[]> = {}
  for (const port of service.ports ?? []) {
    const key = `${port.container}/tcp`
    exposed[key] = {}
    bindings[key] = [...(bindings[key] ?? []), { HostIp: port.ip ?? '127.0.0.1', HostPort: String(port.host) }]
  }
  return {
    Image: service.image,
    Cmd: service.command,
    Env: Object.entries(service.env ?? {}).map(([key, value]) => `${key}=${value}`),
    Labels: { [LABEL.stack]: stack.name, [LABEL.service]: name, [LABEL.spec]: spec(stack.name, service) },
    ExposedPorts: exposed,
    Healthcheck: service.health && {
      Test: ['CMD', ...service.health.command],
      Interval: nanoseconds(service.health.intervalMs ?? 1000),
      Timeout: nanoseconds(service.health.timeoutMs ?? 5000),
      Retries: service.health.retries ?? 30,
    },
    HostConfig: {
      PortBindings: bindings,
      Mounts: (service.volumes ?? []).map((mount) => ({ Type: 'volume', Source: volumeName(stack.name, mount.volume), Target: mount.path })),
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: network,
    },
    NetworkingConfig: { EndpointsConfig: { [network]: { Aliases: [name] } } },
  }
}

/** Who holds a port on this machine: a container (and its stack), something outside Docker, or nobody. */
export async function portOwner(
  docker: Docker,
  port: number,
): Promise<{ port: number; free: boolean; container?: string; stack?: string; service?: string }> {
  const running = await docker.containers([], false)
  const holder = running.find((container) => container.Ports.some((binding) => binding.PublicPort === port))
  if (holder) {
    return {
      port,
      free: false,
      container: holder.Names[0]?.replace(/^\//, '') ?? holder.Id,
      stack: holder.Labels[LABEL.stack] ?? holder.Labels['com.docker.compose.project'],
      service: holder.Labels[LABEL.service] ?? holder.Labels['com.docker.compose.service'],
    }
  }
  const free = await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
  return { port, free }
}

async function portClash(docker: Docker, service: string, ports: Port[]): Promise<KebeleError | undefined> {
  for (const { host } of ports) {
    const owner = await portOwner(docker, host)
    if (owner.free) continue
    const who = owner.container
      ? `container ${owner.container}${owner.stack ? ` (stack ${owner.stack})` : ''}`
      : 'a program outside Docker'
    return new KebeleError(`port ${host} for ${service} is already taken by ${who}`, owner)
  }
  return undefined
}

async function waitReady(docker: Docker, stack: string, name: string, service: Service, timeoutMs: number): Promise<void> {
  const container = containerName(stack, name)
  const deadline = Date.now() + timeoutMs
  // When this run of the container was first seen running, on our clock (Docker's may differ).
  let up: { startedAt: string; seen: number } | undefined
  for (;;) {
    const state = (await docker.inspect(container))?.State
    if (!state) throw new KebeleError(`container ${container} disappeared while starting`)
    // `restarting` is the restart policy bringing back a container that crashed.
    if (state.Status === 'exited' || state.Status === 'dead' || state.Status === 'restarting') {
      const tail: string[] = []
      for await (const line of docker.logs(container, { tail: 20 })) tail.push(line.text)
      throw new KebeleError(`${name} exited with code ${state.ExitCode} while starting`, { service: name, logs: tail })
    }
    // Without a health check, a service is ready once it has stayed up for a moment.
    const ready = service.health
      ? state.Health?.Status === 'healthy'
      : state.Running && up?.startedAt === state.StartedAt && Date.now() - up.seen >= STEADY_MS
    if (state.Running && up?.startedAt !== state.StartedAt) up = { startedAt: state.StartedAt, seen: Date.now() }
    if (ready) return
    if (Date.now() > deadline) {
      throw new KebeleError(`${name} wasn't ready after ${Math.round(timeoutMs / 1000)}s`, { service: name, health: state.Health?.Status ?? state.Status })
    }
    await Bun.sleep(250)
  }
}

/** Bring a stack to its description and wait until every service is ready. */
export async function up(
  docker: Docker,
  stack: Stack,
  options: { onEvent?: (event: UpEvent) => void; timeoutMs?: number } = {},
): Promise<StackStatus> {
  const order = validate(stack)
  const emit = options.onEvent ?? (() => {})
  const labels = { [LABEL.stack]: stack.name }

  if (!(await docker.network(networkName(stack.name)))) await docker.createNetwork(networkName(stack.name), labels)
  for (const service of Object.values(stack.services)) {
    for (const mount of service.volumes ?? []) {
      const name = volumeName(stack.name, mount.volume)
      if (!(await docker.volumeExists(name))) await docker.createVolume(name, labels)
    }
  }
  for (const image of new Set(Object.values(stack.services).map((service) => service.image))) {
    if (!(await docker.imageExists(image))) {
      emit({ event: 'pull', image })
      await docker.pull(image)
    }
  }

  for (const name of order) {
    const service = stack.services[name]!
    const container = containerName(stack.name, name)
    const existing = await docker.inspect(container)
    if (existing && existing.Config.Labels[LABEL.spec] === spec(stack.name, service)) {
      if (!existing.State.Running) {
        emit({ event: 'start', service: name })
        await start(docker, container, name, service)
      }
    } else {
      if (existing) {
        emit({ event: 'replace', service: name })
        await docker.remove(container)
      } else {
        emit({ event: 'create', service: name })
      }
      await docker.create(container, containerConfig(stack, name, service))
      await start(docker, container, name, service)
    }
    await waitReady(docker, stack.name, name, service, options.timeoutMs ?? 120_000)
    emit({ event: 'ready', service: name })
  }
  return status(docker, stack.name)
}

async function start(docker: Docker, container: string, name: string, service: Service): Promise<void> {
  try {
    await docker.start(container)
  } catch (error) {
    // Docker says "port is already allocated" or "address already in use"; say who has it.
    if (error instanceof DockerError && /already allocated|address already in use/i.test(error.message)) {
      throw (await portClash(docker, name, service.ports ?? [])) ?? error
    }
    throw error
  }
}

function serviceStatus(container: ContainerSummary, health?: string): ServiceStatus {
  return {
    service: container.Labels[LABEL.service] ?? '',
    container: container.Names[0]?.replace(/^\//, '') ?? container.Id,
    image: container.Image,
    state: container.State,
    ...(health ? { health } : {}),
    ports: container.Ports.filter((port) => port.PublicPort !== undefined)
      .map((port) => ({ host: port.PublicPort!, container: port.PrivatePort, ip: port.IP ?? '' }))
      .filter((port, index, all) => all.findIndex((other) => other.host === port.host) === index),
  }
}

/** Every service of one stack. An unknown stack has no services. */
export async function status(docker: Docker, name: string): Promise<StackStatus> {
  const containers = await docker.containers([`${LABEL.stack}=${name}`])
  const services = await Promise.all(
    containers.map(async (container) => serviceStatus(container, (await docker.inspect(container.Id))?.State.Health?.Status)),
  )
  services.sort((a, b) => a.service.localeCompare(b.service))
  return { name, services }
}

/** Every stack kebele manages on this machine. */
export async function list(docker: Docker): Promise<StackStatus[]> {
  const containers = await docker.containers([LABEL.stack])
  const stacks = new Map<string, ServiceStatus[]>()
  for (const container of containers) {
    const name = container.Labels[LABEL.stack]!
    stacks.set(name, [...(stacks.get(name) ?? []), serviceStatus(container)])
  }
  return [...stacks.entries()]
    .map(([name, services]) => ({ name, services: services.sort((a, b) => a.service.localeCompare(b.service)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Remove a stack's containers and network. Volumes, and the data in them, stay unless `volumes`
 * is set. Pass the stack description to also remove volumes kebele didn't create (adopted ones).
 */
export async function down(docker: Docker, stack: string | Stack, options: { volumes?: boolean } = {}): Promise<{ removed: string[]; volumes: string[] }> {
  const name = typeof stack === 'string' ? stack : stack.name
  const containers = await docker.containers([`${LABEL.stack}=${name}`])
  for (const container of containers) await docker.remove(container.Id)
  await docker.removeNetwork(networkName(name))
  const volumes: string[] = []
  if (options.volumes) {
    const named = new Set((await docker.volumes([`${LABEL.stack}=${name}`])).map((volume) => volume.Name))
    if (typeof stack !== 'string') {
      for (const service of Object.values(stack.services)) for (const mount of service.volumes ?? []) named.add(volumeName(name, mount.volume))
    }
    for (const volume of named) {
      await docker.removeVolume(volume)
      volumes.push(volume)
    }
  }
  return { removed: containers.map((container) => container.Names[0]?.replace(/^\//, '') ?? container.Id), volumes: volumes.sort() }
}

/** A service's output. Several services are read one after another; following needs a single service. */
export async function* logs(
  docker: Docker,
  stack: string,
  options: { service?: string; tail?: number; follow?: boolean } = {},
): AsyncGenerator<{ service: string; stream: 'stdout' | 'stderr'; text: string }> {
  const { services } = await status(docker, stack)
  if (services.length === 0) throw new KebeleError(`no stack named ${stack}`)
  const chosen = options.service ? services.filter((service) => service.service === options.service) : services
  if (chosen.length === 0) throw new KebeleError(`stack ${stack} has no service ${options.service}`, { services: services.map((s) => s.service) })
  if (options.follow && chosen.length > 1) throw new KebeleError('following logs needs one service', { services: chosen.map((s) => s.service) })
  for (const service of chosen) {
    for await (const line of docker.logs(service.container, { tail: options.tail, follow: options.follow })) {
      yield { service: service.service, ...line }
    }
  }
}
