# Canton Infrastructure

Canton 3.4.11 multi-node setup with Docker Compose: 2 participants + sequencer + mediator on PostgreSQL 16.

## Quick Start

```bash
# Start everything
docker compose -f infra/docker-compose.yml up -d

# Verify both participants are running
curl -s http://localhost:5013/v2/version | jq .version
curl -s http://localhost:5023/v2/version | jq .version

# Stop and clean up
docker compose -f infra/docker-compose.yml down -v
```

## Architecture

Single-process Canton with 4 logical nodes:

| Node | Role | Ports |
|------|------|-------|
| sequencer1 | Orders transactions | 5001 (public), 5002 (admin) |
| mediator1 | Confirms transactions | 5202 (admin) |
| participant1 (Banco Rojo) | Ledger node | 5011 (gRPC), 5012 (admin), 5013 (HTTP JSON) |
| participant2 (Banco Azul) | Ledger node | 5021 (gRPC), 5022 (admin), 5023 (HTTP JSON) |

PostgreSQL hosts 5 databases: `sequencer`, `sequencer_driver`, `mediator`, `participant1`, `participant2`.

## Startup Sequence

1. PostgreSQL starts and creates databases via `init-db.sql`
2. Canton waits for PostgreSQL healthcheck (`pg_isready`)
3. Canton loads `topology.conf` (node definitions + storage)
4. Bootstrap script `init.canton` executes:
   - `nodes.local.start()` — starts all 4 nodes
   - `bootstrap.synchronizer(...)` — creates "mysynchronizer" sync domain
   - `participant1/2.synchronizers.connect_local(...)` — connects both participants
   - `participant1.health.ping(participant2)` — verifies connectivity

## File Structure

```
infra/
├── docker-compose.yml          # PostgreSQL + Canton services
├── init-db.sql                 # Database initialization (5 DBs)
├── canton/
│   ├── Dockerfile              # Canton 3.4.11 from open-source binaries
│   ├── topology.conf           # HOCON config: 4 nodes, ports, storage
│   └── bootstrap/
│       └── init.canton         # Bootstrap: sync domain + participant connections
└── README.md
```

## Verification

```bash
# Check participant1 version
curl -s http://localhost:5013/v2/version

# Check participant2 version
curl -s http://localhost:5023/v2/version

# List parties on participant1
curl -s http://localhost:5013/v2/parties

# List databases
docker compose -f infra/docker-compose.yml exec postgres psql -U canton -c '\l'
```

## Troubleshooting

### Port already in use
Stop conflicting containers: `docker ps` to identify, then `docker stop <container>`.

### Canton takes long to start on first run
First startup compiles Scala scripts (~3-5 minutes). Subsequent starts use cache and are faster.

### PostgreSQL not ready
The compose uses `depends_on` with `service_healthy`. If Canton still fails to connect, increase the healthcheck retries in `docker-compose.yml`.

### Memory warning
Canton warns if `-Xmx` exceeds half container memory. This is non-blocking. To suppress, increase Docker memory limit to 8GB+ or reduce `JAVA_OPTS` in compose.

### Cannot see bootstrap output
Bootstrap script output goes to the Canton interactive console (tty), not docker logs. Use HTTP API verification instead of log grep.
