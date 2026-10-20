#!/usr/bin/env bun
// kebele: containers for Addis tools. Agent-first: JSON out by default, --human for people.

import { readFileSync } from 'node:fs'

import { Command } from 'commander'

import pkg from '../package.json' with { type: 'json' }
import { Docker, KebeleError } from './docker.ts'
import { event, failure, result, type Globals } from './output.ts'
import { down, list, logs, portOwner, status, up, type Stack, type StackStatus } from './stack.ts'

const program = new Command()
  .name('kebele')
  .description('Run and manage Docker container stacks. JSON output by default; --human for people.')
  .version(pkg.version)
  .option('--human', 'readable text instead of JSON')
  .option('--nopretty', 'single-line JSON')
  .option('--socket <path>', 'Docker socket (default: the docker CLI context, then the usual places)')

const globals = (): Globals => program.opts<Globals>()
const docker = () => new Docker(globals().socket)

function action<A extends unknown[]>(run: (...args: A) => Promise<void>) {
  return async (...args: A) => {
    try {
      await run(...args)
    } catch (error) {
      process.stderr.write(failure(error, globals()))
      process.exit(1)
    }
  }
}

function readStack(file: string): Stack {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new KebeleError(`can't read ${file}`, { file })
  }
  try {
    return JSON.parse(text) as Stack
  } catch (error) {
    throw new KebeleError(`${file} isn't valid JSON: ${error instanceof Error ? error.message : error}`, { file })
  }
}

function describe(stack: StackStatus): string {
  if (stack.services.length === 0) return `${stack.name}: not running`
  const rows = stack.services.map((service) => {
    const ports = service.ports.map((port) => `${port.host}→${port.container}`).join(' ')
    return `  ${service.service.padEnd(12)} ${(service.health ?? service.state).padEnd(10)} ${ports}`
  })
  return `${stack.name}\n${rows.join('\n')}`
}

program
  .command('doctor')
  .description('find Docker and report its version')
  .action(
    action(async () => {
      const client = docker()
      const version = await client.version()
      const value = { ok: true, socket: client.socket, version: version.Version, api: version.ApiVersion, os: version.Os, arch: version.Arch }
      result(value, globals(), () => `Docker ${version.Version} (API ${version.ApiVersion}) at ${client.socket}`)
    }),
  )

program
  .command('up')
  .description('start a stack from its JSON description and wait until every service is ready')
  .argument('[file]', 'stack description', 'kebele.json')
  .option('--timeout <seconds>', 'how long each service may take to become ready', '120')
  .action(
    action(async (file: string, options: { timeout: string }) => {
      const stack = readStack(file)
      const done = await up(docker(), stack, {
        timeoutMs: Number(options.timeout) * 1000,
        onEvent: (e) => event(e, globals(), () => ('image' in e ? `pulling ${e.image}` : `${e.event} ${e.service}`)),
      })
      event({ event: 'up', ...done }, globals(), () => describe(done))
    }),
  )

program
  .command('down')
  .description("stop and remove a stack's containers; its volumes and data stay unless --volumes")
  .argument('<stack>', 'stack name, or a stack description file (also removes the volumes it declares)')
  .option('--volumes', 'also delete the volumes, and the data in them')
  .action(
    action(async (target: string, options: { volumes?: boolean }) => {
      const stack = target.endsWith('.json') ? readStack(target) : target
      const removed = await down(docker(), stack, { volumes: options.volumes })
      result({ ok: true, ...removed }, globals(), () =>
        [`removed ${removed.removed.length} container(s)`, ...removed.volumes.map((volume) => `deleted volume ${volume}`)].join('\n'),
      )
    }),
  )

program
  .command('ls')
  .description('list every stack kebele manages on this machine')
  .action(
    action(async () => {
      const stacks = await list(docker())
      result({ stacks }, globals(), () => (stacks.length ? stacks.map(describe).join('\n') : 'no stacks'))
    }),
  )

program
  .command('status')
  .description("one stack's services, their state, health and ports")
  .argument('<stack>')
  .action(
    action(async (name: string) => {
      const value = await status(docker(), name)
      result(value, globals(), () => describe(value))
    }),
  )

program
  .command('logs')
  .description("a stack's output; --follow needs one service")
  .argument('<stack>')
  .argument('[service]')
  .option('--tail <lines>', 'only the last N lines of each service')
  .option('-f, --follow', 'keep printing new output')
  .action(
    action(async (stack: string, service: string | undefined, options: { tail?: string; follow?: boolean }) => {
      const tail = options.tail === undefined ? undefined : Number(options.tail)
      for await (const line of logs(docker(), stack, { service, tail, follow: options.follow })) {
        event(line, globals(), () => `${line.service} | ${line.text}`)
      }
    }),
  )

program
  .command('port')
  .description('who holds a port on this machine: a container, a program outside Docker, or nobody')
  .argument('<port>')
  .action(
    action(async (port: string) => {
      const owner = await portOwner(docker(), Number(port))
      result(owner, globals(), () =>
        owner.free
          ? `${port} is free`
          : owner.container
            ? `${port} is held by ${owner.container}${owner.stack ? ` (stack ${owner.stack})` : ''}`
            : `${port} is held by a program outside Docker`,
      )
    }),
  )

await program.parseAsync()
