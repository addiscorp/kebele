# kebele

Run and manage Docker container stacks. kebele talks to Docker over its unix socket; it doesn't need the `docker` CLI or `docker compose`.

It's the container layer for Addis tools: [simien](https://github.com/simienapp/cli) calls it to run each project's Postgres and Zega. Its siblings are [woreda](https://github.com/addiscorp/woreda) (GitHub Actions runners) and mirab (virtual machines and agents).

Built for agents first: every command prints JSON, and `--human` prints text for people. A failure is JSON on stderr and exit code 1.

## Install

```sh
bun add -g kebele        # or: npm install -g kebele (needs Bun on PATH)
kebele doctor
```

kebele finds Docker the way the `docker` CLI does: first the current `docker context`, then the usual sockets for Docker Desktop, OrbStack, Colima and Rancher Desktop. Pass `--socket <path>` to choose one.

## A stack

```json
{
  "name": "shop",
  "services": {
    "db": {
      "image": "postgres:17",
      "env": { "POSTGRES_PASSWORD": "..." },
      "ports": [{ "host": 5433, "container": 5432 }],
      "volumes": [{ "volume": "pgdata", "path": "/var/lib/postgresql/data" }],
      "health": { "command": ["pg_isready", "-U", "postgres"] }
    },
    "api": {
      "image": "shop-api:1.2",
      "dependsOn": ["db"]
    }
  }
}
```

- Services start in dependency order. Each one must be ready before the next starts: healthy if it has a health check, otherwise running steadily.
- Services reach each other by name (`db`) on the stack's own network.
- Ports bind to `127.0.0.1` unless you give an `ip`.
- Volumes are named `<stack>_<volume>` and survive `down`.
- `up` is idempotent. An unchanged service is left alone. A changed service (image, command, env, ports, volumes or health) is replaced.

## Commands

| command | does |
|---|---|
| `kebele up [file]` | start or update the stack in `file` (default `kebele.json`), with one JSON event per step |
| `kebele pull [file]` | pull the stack's images and remove containers still running older ones (data stays); `up` then starts them on the new images |
| `kebele down <stack \| file> [--volumes]` | remove the containers and network; `--volumes` also deletes the data |
| `kebele ls` | every stack kebele manages on this machine |
| `kebele status <stack>` | each service's state, health and ports |
| `kebele logs <stack> [service] [--tail N] [-f]` | output, as `{service, stream, text}` lines |
| `kebele port <port>` | who holds a port: a container (and its stack), a program outside Docker, or nobody |
| `kebele doctor` | which socket, which Docker |

When a port is taken, `up` says by whom, e.g. `port 5433 for db is already taken by container shop-db (stack shop)`. A service that exits while starting reports its exit code and its last 20 lines of output.

## As a library

```ts
import { Docker, up, down, status } from 'kebele'

const docker = new Docker()
await up(docker, stack, { onEvent: (e) => console.log(e) })
```

## Develop

```sh
bun install
bun run typecheck
bun test        # runs against your local Docker
```

Releases publish from a `vX.Y.Z` tag through npm trusted publishing (`.github/workflows/publish.yml`, environment `release`).

## License

Apache-2.0
