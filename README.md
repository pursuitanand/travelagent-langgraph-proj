# LangGraph Travel Agent

A production-shaped reference implementation: a browser chat UI talking to a
**LangGraph** agent that searches flight inventory and the live web in parallel,
then writes the answer with an LLM.

Two Node.js + TypeScript microservices, containerised, deployed to Kubernetes,
built by GitHub Actions.

**It runs with zero credentials.** With no API keys at all, the agent still
parses your request, searches the bundled flight dataset and answers — it just
uses a deterministic template writer instead of the LLM, and skips web search.
Every external provider is an opt-in upgrade, not a prerequisite.

---

## Contents

- [Architecture](#architecture)
- [Quick start](#quick-start)
- [How the agent works](#how-the-agent-works)
- [API reference](#api-reference)
- [Configuration reference](#configuration-reference)
- [Connecting real providers](#connecting-real-providers)
  - [LLM — Anthropic Claude](#llm--anthropic-claude)
  - [Web search — Serper](#web-search--serper)
  - [Flights — Duffel](#flights--duffel)
- [Connecting a real database](#connecting-a-real-database)
- [Deploying to a cloud cluster](#deploying-to-a-cloud-cluster)
  - [What is Docker-Desktop-specific](#what-is-docker-desktop-specific)
  - [Amazon EKS](#amazon-eks)
  - [Azure AKS](#azure-aks)
  - [Google GKE](#google-gke)
  - [Scaling and resilience](#scaling-and-resilience)
- [CI/CD](#cicd)
- [Security model](#security-model)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Architecture

```text
Browser
   |
   |  POST /api/chat          same origin — the browser never holds a key
   v
chat-assistant                              :3000    LoadBalancer / Ingress
   |                                                 (stateless, no secrets)
   |  REST, server-side, via Kubernetes service DNS
   |  http://langgraph-travel-agent.travel-agent.svc.cluster.local:8080
   v
langgraph-travel-agent                      :8080    ClusterIP (internal only)
   |
   +-- LangGraph
   |     parseRequest
   |        |-------> flightSearch ----> FlightRepository
   |        |                              JSON (default) | PostgreSQL | Duffel
   |        |-------> webSearch ------> SerperSearchService      -> serper.dev
   |                     |
   |                     v
   |               combineResults ----> generateResponse -> Claude / template
   |
   +-- GET /health  (readiness + liveness)
```

The key structural decision: `flightSearch` and `webSearch` have **no edge
between them**, so LangGraph runs them concurrently in a single superstep.
`combineResults` has an incoming edge from each, so it executes exactly once,
after both finish. `diagnostics.trace` in every API response shows the real
execution order, so you can see this from outside the process.

### Repository layout

```text
.
├── .github/workflows/build.yml        lint → test → build → docker build → smoke test
├── docker-compose.yml                 two-container local topology
├── k8s/                               namespace, config, deployments, services
│   ├── 00-namespace.yaml
│   ├── 10-backend-config.yaml         non-secret backend configuration
│   ├── 11-backend-secret.example.yaml TEMPLATE — never holds real values
│   ├── 12-backend-deployment.yaml
│   ├── 13-backend-service.yaml        ClusterIP
│   ├── 20-frontend-config.yaml
│   ├── 21-frontend-deployment.yaml
│   ├── 22-frontend-service.yaml       LoadBalancer
│   └── kustomization.yaml
└── services/
    ├── chat-assistant/                frontend  (no SDKs, no keys)
    │   ├── public/                    index.html, styles.css, app.js, render.js
    │   └── src/                       config.ts, logger.ts, server.ts, index.ts
    └── langgraph-travel-agent/        backend
        ├── data/flights.json          generated + committed demo inventory
        ├── db/schema.sql              Postgres tables + read-model view
        ├── scripts/
        │   ├── generate-flights.ts    deterministic dataset generator
        │   └── load-postgres.ts       loads the dataset into Postgres
        └── src/
            ├── config/env.ts          validated, typed configuration
            ├── domain/                types, airports, intentParser
            ├── graph/                 state.ts, buildGraph.ts, nodes/
            ├── http/app.ts            routes, validation, error handling
            ├── repositories/          FlightRepository + JSON / Postgres / Duffel
            └── services/              Serper, Claude, template responder
```

---

## Quick start

### 1. Local, with npm

```bash
# terminal 1 — the agent
cd services/langgraph-travel-agent
npm install
npm run dev                 # http://localhost:8080

# terminal 2 — the chat UI
cd services/chat-assistant
npm install
npm run dev                 # http://localhost:3000
```

Open <http://localhost:3000>. Try *"London to Tokyo on 20 October for 2 people
in business class"*, then follow up with *"what about economy instead?"*.

### 2. Docker Compose

```bash
docker compose up --build   # http://localhost:3000
```

Keys, if you have them, come from your shell or a local `.env`:

```bash
SERPER_API_KEY=... ANTHROPIC_API_KEY=... docker compose up --build
```

### 3. Docker Desktop Kubernetes

Enable Kubernetes in Docker Desktop (Settings → Kubernetes → Enable), then:

```bash
docker build -t langgraph-travel-agent:local ./services/langgraph-travel-agent
docker build -t chat-assistant:local         ./services/chat-assistant

kubectl apply -k k8s/

# Optional — the pods run fine without this.
kubectl -n travel-agent create secret generic langgraph-travel-agent-secrets \
  --from-literal=SERPER_API_KEY="$SERPER_API_KEY" \
  --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  --from-literal=DATABASE_URL=""
kubectl -n travel-agent rollout restart deployment/langgraph-travel-agent

kubectl -n travel-agent rollout status deployment/chat-assistant
kubectl -n travel-agent get pods,svc
```

Docker Desktop publishes the `chat-assistant` LoadBalancer on **<http://localhost>**.

Tear down: `kubectl delete -k k8s/`.

---

## How the agent works

| Node | Responsibility |
| --- | --- |
| `parseRequest` | Free text → typed `TravelIntent` (route, dates, passengers, cabin, budget, research topics). **Rule-based and deterministic — no LLM call**, so flight search needs no API key, adds no latency and is fully unit-testable. Follow-ups such as *"what about business class?"* inherit the route from the previous turn. |
| `flightSearch` | Queries `FlightRepository` for the outbound leg, plus the reverse route when a return date was parsed. Falls back to nearby dates and says so in the reply. |
| `webSearch` | Builds a destination-focused query from the parsed topics and calls Serper. |
| `combineResults` | The join point. Computes cheapest / fastest / price range and assembles the `TravelBrief`. |
| `generateResponse` | Hands the brief to the LLM to write the traveller-facing reply. |

**Every branch degrades independently.** A repository error, a Serper timeout,
a missing key, an LLM refusal or an API outage is recorded in
`diagnostics.errors`, and the agent still answers with whatever else it
gathered. State channels written by both parallel nodes (`notes`, `errors`,
`trace`) use append reducers so neither branch clobbers the other.

---

## API reference

### `langgraph-travel-agent`

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | Run one pass of the agent |
| `GET /health` | Readiness + liveness. Returns **503** when the flight repository is unhealthy |

<details>
<summary><code>POST /api/chat</code> request and response</summary>

```jsonc
// request
{
  "message": "London to Tokyo on 20 October for 2 people in business class",
  "conversationId": "optional-client-supplied-id",
  "history": [{ "role": "user", "content": "an earlier turn" }]
}
```

```jsonc
// response
{
  "conversationId": "…",
  "reply": "markdown, rendered by the UI",
  "intent": {
    "origin": { "iata": "LHR", "city": "London", … },
    "destination": { "iata": "NRT", "city": "Tokyo", … },
    "departureDate": "2026-10-20",
    "returnDate": null,
    "passengers": 2,
    "cabinClass": "business",
    "maxPrice": null,
    "topics": [],
    "searchable": true
  },
  "flights": { "outbound": [ /* Duffel-shaped offers */ ], "inbound": [] },
  "sources": [{ "title": "…", "link": "https://…", "source": "example.com" }],
  "diagnostics": {
    "trace": ["parseRequest", "flightSearch", "webSearch", "combineResults", "generateResponse"],
    "responder": "anthropic:claude-opus-5",
    "notes": [],
    "errors": [],
    "durationMs": 412
  }
}
```

</details>

### `chat-assistant`

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | Pass-through to `BACKEND_URL`; 504 on timeout, 502 when the agent is unreachable |
| `GET /health` | Deliberately **local** — the UI stays live and can explain itself while the agent restarts |
| `GET /` | The chat page |

---

## Configuration reference

Nothing is hardcoded. Both services validate their environment at start-up, so
a misconfigured container fails fast at boot instead of on the first request.
See each service's `.env.example`.

### `langgraph-travel-agent`

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `8080` | |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `SERVICE_VERSION` | `1.0.0` | Reported by `/health`; set it to the image tag in CD |
| `CORS_ALLOWED_ORIGINS` | `*` | Comma-separated origin list. **Tighten this in production** |
| `FLIGHT_REPOSITORY` | `json` | `json` \| `postgres` \| `duffel` — see [flights](#flights--duffel) |
| `FLIGHTS_DATA_FILE` | `data/flights.json` | Only used by the JSON driver |
| `FLIGHTS_ROLL_DATES` | `true` | Shifts the committed dataset so day 0 is today |
| `DATABASE_URL` | *(empty)* | **Required** when `FLIGHT_REPOSITORY=postgres` |
| `DATABASE_POOL_MAX` | `10` | Per-pod pool size — see [pooling](#connection-pooling-matters) |
| `DATABASE_SSL` | `false` | ⚠️ see the [TLS warning](#tls-to-a-managed-database) |
| `DUFFEL_*` | — | Eight variables, documented under [Duffel configuration](#duffel-configuration) |
| `SERPER_API_KEY` | *(empty)* | Empty ⇒ web search skipped (a note, not an error) |
| `SERPER_ENDPOINT` | `https://google.serper.dev/search` | |
| `SERPER_TIMEOUT_MS` | `6000` | Exceeded ⇒ that branch degrades only |
| `SERPER_MAX_RESULTS` | `5` | 1–20 |
| `ANTHROPIC_API_KEY` | *(empty)* | Empty ⇒ deterministic template responder |
| `ANTHROPIC_MODEL` | `claude-opus-5` | |
| `ANTHROPIC_MAX_TOKENS` | `8000` | |
| `ANTHROPIC_EFFORT` | `low` | `low` \| `medium` \| `high` \| `xhigh` \| `max` |
| `ANTHROPIC_TIMEOUT_MS` | `45000` | |

### `chat-assistant`

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `LOG_LEVEL` | `info` | |
| `BACKEND_URL` | `http://localhost:8080` | Must be an absolute `http(s)` URL. **In Kubernetes: the service DNS name, never `localhost`** |
| `BACKEND_TIMEOUT_MS` | `60000` | Exceeded ⇒ 504 to the browser |

### Where each value lives

| Kind | Local | Kubernetes |
| --- | --- | --- |
| Non-secret backend config | `services/langgraph-travel-agent/.env` | `k8s/10-backend-config.yaml` (ConfigMap) |
| Backend secrets | `.env` (git-ignored) | Secret `langgraph-travel-agent-secrets` |
| Frontend config | `services/chat-assistant/.env` | `k8s/20-frontend-config.yaml` (ConfigMap) |

The backend Deployment references the Secret with `optional: true`, so the pod
starts and degrades gracefully when it does not exist yet.

---

## Connecting real providers

### LLM — Anthropic Claude

**What it does here:** only the final `generateResponse` node. Parsing and
searching never call the LLM, so an outage or a missing key costs you writing
quality, not functionality.

**1. Get a key** — <https://console.anthropic.com> → API Keys. Keys look like
`sk-ant-…`.

**2. Set it.**

```bash
# local
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> services/langgraph-travel-agent/.env

# kubernetes
kubectl -n travel-agent create secret generic langgraph-travel-agent-secrets \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..." \
  --from-literal=SERPER_API_KEY="$SERPER_API_KEY" \
  --from-literal=DATABASE_URL="" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n travel-agent rollout restart deployment/langgraph-travel-agent
```

**3. Verify.** `/health` reports which writer is active, and every chat
response names it:

```bash
curl -s localhost:8080/health | jq .features.llm
# "claude-opus-5"        → live model
# "template-fallback"    → no key detected

curl -s localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"message":"London to Tokyo on 20 October"}' | jq -r .diagnostics.responder
# "anthropic:claude-opus-5"
```

**Tuning.** `ANTHROPIC_EFFORT` trades quality against cost and latency; `low`
is the default because this is a short summarisation task. Raise it to `high`
if you extend the agent into multi-step reasoning. `ANTHROPIC_MODEL` accepts
any current model id.

**Resilience already built in.** The call uses adaptive thinking, a 2-retry
client, and the server-side refusal fallback. Rate limits, auth failures,
timeouts, refusals and empty responses are all caught in
`AnthropicResponseGenerator` and fall back to the template writer, with the
reason logged.

**Using a different LLM vendor.** Implement the `ResponseGenerator` interface
(`src/services/ResponseGenerator.ts` — one method, `generate({brief, history})
→ {text, generator, model?}`) and swap the constructor in `src/index.ts`. The
graph knows nothing about the provider. Reuse `renderBrief()` to format the
prompt and keep `TemplateResponseGenerator` as your fallback.

> **On a cloud platform?** Claude on Amazon Bedrock, Google Vertex AI and
> Microsoft Foundry use dedicated client classes rather than an API key — see
> the Anthropic SDK docs. That is a change inside
> `AnthropicResponseGenerator`'s constructor only.

---

### Web search — Serper

**What it does here:** the `webSearch` branch. It turns the parsed destination
and topics into one query (*"Tokyo, Japan visa requirements October 2026"*) and
returns organic results plus the answer box, which become the `sources` array
and inline citations in the reply.

**1. Get a key** — <https://serper.dev> → sign up → Dashboard → API Key. The
free tier includes a one-off credit allowance, which is plenty for a demo.

**2. Set it** — `SERPER_API_KEY`, exactly as for Anthropic above.

**3. Verify.**

```bash
curl -s localhost:8080/health | jq .features.webSearch      # true
curl -s localhost:8080/api/chat -H 'content-type: application/json' \
  -d '{"message":"Tokyo from London on 20 October, what about visas?"}' | jq '.sources'
```

With no key, replies carry the note *"Web search is disabled (no
SERPER_API_KEY configured)"* and `sources` is `[]`.

**Tuning.**

| Variable | Effect |
| --- | --- |
| `SERPER_MAX_RESULTS` | Results per query (1–20). More results = a longer LLM prompt = higher cost |
| `SERPER_TIMEOUT_MS` | Keep it well under `BACKEND_TIMEOUT_MS`; on timeout the branch degrades alone |
| `SERPER_ENDPOINT` | Point at `/news`, `/places` etc., or at a mock server in tests |

**Cost control.** Every chat turn with a resolvable destination issues exactly
one Serper request. There is no caching layer — if you expect repeated
queries, add one in `SerperSearchService` (the class already takes an
injectable `fetch`, so a caching wrapper is a drop-in).

---

### Flights — Duffel

**What ships today.** [Duffel](https://duffel.com) is the *reference* provider:
the domain model deliberately mirrors its vocabulary — offers with an owning
airline, a total amount, slices and segments — but **the demo does not call the
Duffel API**. It reads `data/flights.json`, a generated, committed, deterministic
dataset (~5 000 offers, 86 directed routes, 16 airports, real timezone offsets,
plausible aircraft per sector length, cabin-based pricing).

```bash
cd services/langgraph-travel-agent
npm run seed:flights                        # regenerate (30 days, seeded RNG)
npm run seed:flights -- --days 60 --seed 7
```

Because the file is committed, its dates would go stale. `FLIGHTS_ROLL_DATES=true`
(the default) shifts the dataset at load time so day 0 becomes today, preserving
local wall-clock departure times.

**Going live with Duffel.** `DuffelFlightRepository` is **implemented** — it
satisfies the same `FlightRepository` contract as the JSON and Postgres
drivers, so switching is configuration, not a code change.

**1. Get a token** — <https://app.duffel.com> → Developers → Access tokens.
Test tokens are prefixed `duffel_test_` and return simulated inventory from
Duffel's test airlines; live tokens (`duffel_live_`) need an approved account.
**Start with a test token.**

**2. Turn it on.**

```bash
FLIGHT_REPOSITORY=duffel DUFFEL_ACCESS_TOKEN=duffel_test_... npm start
```

In Kubernetes: set `FLIGHT_REPOSITORY: "duffel"` in `k8s/10-backend-config.yaml`
and put `DUFFEL_ACCESS_TOKEN` in the **Secret** — never in the ConfigMap.

```bash
kubectl -n travel-agent create secret generic langgraph-travel-agent-secrets   --from-literal=DUFFEL_ACCESS_TOKEN="$DUFFEL_ACCESS_TOKEN"   --from-literal=ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"   --from-literal=SERPER_API_KEY="$SERPER_API_KEY"   --from-literal=DATABASE_URL=""   --dry-run=client -o yaml | kubectl apply -f -
kubectl -n travel-agent rollout restart deployment/langgraph-travel-agent
```

**3. Verify.** The token is validated at boot — a bad one fails the pod rather
than the first traveller.

```bash
curl -s localhost:8080/health | jq .checks.flights
# { "driver": "duffel", "healthy": true, "detail": "token accepted" }
```

### How the driver works

| Concern | Behaviour |
| --- | --- |
| Search | One `POST /air/offer_requests?return_offers=true`, so offers come back inline in a single round trip |
| Headers | `Authorization: Bearer …`, `Duffel-Version: v2`, `Accept: application/json` |
| Ordering | Duffel does not guarantee an order; offers are sorted cheapest-first after mapping, matching the other drivers |
| Price ceiling / result limit | Applied client-side — Duffel has no server-side parameter for either |
| Expired quotes | Offers past `expires_at` are dropped before they can be shown as bookable |
| Cabin | Read per segment from `passengers[].cabin_class`, falling back to the requested cabin |
| Baggage | Checked-bag count for the first passenger on the first segment |
| Seats | Duffel does not publish remaining inventory, so `seatsAvailable` is the party size the offer was quoted for |
| Timestamps | Duffel returns airline-local times with **no UTC offset** (`2026-10-20T09:00:00`). They flow through unchanged and render identically to the seeded dataset's offset-bearing times |
| Durations | ISO-8601 (`PT11H50M`) parsed to minutes, falling back to the timestamp delta |
| Health probes | `/health` is polled every few seconds, so the API probe behind it is cached for `DUFFEL_HEALTH_CACHE_MS` instead of burning rate limit |
| Errors | Duffel's own `errors[].title/message` and `meta.request_id` are surfaced as a typed `DuffelRequestError`; aborts become `DuffelTimeoutError`. The token never appears in an error message (there is a test for this) |

### Duffel configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `DUFFEL_ACCESS_TOKEN` | *(empty)* | **Required** when `FLIGHT_REPOSITORY=duffel`. Secret, not ConfigMap |
| `DUFFEL_ENDPOINT` | `https://api.duffel.com` | |
| `DUFFEL_API_VERSION` | `v2` | Sent as the `Duffel-Version` header |
| `DUFFEL_TIMEOUT_MS` | `25000` | Our abort deadline. **Must exceed** the supplier timeout — validated at startup |
| `DUFFEL_SUPPLIER_TIMEOUT_MS` | `20000` | How long Duffel waits on each airline (Duffel accepts 2000–60000) |
| `DUFFEL_MAX_CONNECTIONS` | `1` | `0` = non-stop only; lower means smaller, faster responses |
| `DUFFEL_MAX_FLEXIBILITY_REQUESTS` | `2` | Extra offer requests spent on adjacent dates when the requested date is empty. `0` disables |
| `DUFFEL_HEALTH_CACHE_MS` | `60000` | How long a successful health probe is reused |

### Cost, latency and the things a live integration must respect

- **Every search is a paid, multi-second call.** The JSON driver answers in
  ~15 ms; a real offer request takes seconds. Keep
  `DUFFEL_TIMEOUT_MS` < `BACKEND_TIMEOUT_MS`, and remember the LLM call happens
  *after* the search in the same request.
- **Date flexibility multiplies cost.** `JsonFlightRepository` widens the date
  window for free; against Duffel each extra day is another billable request,
  which is why `DUFFEL_MAX_FLEXIBILITY_REQUESTS` caps it at 2 by default. Set
  it to `0` for the cheapest behaviour.
- **Offers expire in minutes.** The driver filters lapsed quotes, but do not
  add a cache across turns without re-validating `expiresAt`.
- **No "any date" search.** Duffel requires a concrete `departure_date`, so an
  undated request is quoted for today. Prompt the traveller for a date instead
  of relying on that.
- **Rate limits.** There is no request cache; one chat turn with a resolvable
  route is one offer request. Add caching or debouncing before exposing this
  publicly.
- **Booking is out of scope.** This is search only — orders, payments and
  ancillaries are a much larger surface with real money attached.

### Extending it

The class lives in `src/repositories/DuffelFlightRepository.ts`; the pure
wire-format translation is separate in `src/repositories/duffelMapper.ts` and
unit-tested without a token. Round trips currently issue one offer request per
direction (outbound, then inbound); Duffel also accepts multiple slices in a
single request, which would halve the calls for return journeys.


---

## Connecting a real database

PostgreSQL support is implemented, not stubbed: `PostgresFlightRepository`
reads a `flight_offer_json` read-model view that emits the API-shaped payload,
so the repository does no row-to-object assembly, and the filter/parameter
construction lives in a pure, unit-tested `buildFlightSearchSql()`.

### 1. Create the schema and load data

```bash
psql "$DATABASE_URL" -f services/langgraph-travel-agent/db/schema.sql

cd services/langgraph-travel-agent
DATABASE_URL=postgresql://user:pass@host:5432/travel_agent npm run load:postgres
```

`load:postgres` is idempotent — every insert is an upsert, so re-running it is
safe.

### 2. Switch the driver

```bash
FLIGHT_REPOSITORY=postgres \
DATABASE_URL=postgresql://user:pass@host:5432/travel_agent \
npm start
```

In Kubernetes: set `FLIGHT_REPOSITORY: "postgres"` in
`k8s/10-backend-config.yaml` and put `DATABASE_URL` in the **Secret** (it
contains a password). `FLIGHT_REPOSITORY=postgres` with an empty `DATABASE_URL`
fails at startup rather than at the first request, and `init()` runs a probe
query so a bad connection string is caught at boot, not by a user.

Confirm with `curl -s localhost:8080/health | jq .checks.flights` →
`{"driver": "postgres", "healthy": true, "detail": "… offers"}`.

### TLS to a managed database

> ⚠️ **This needs a code change before production.** `DATABASE_SSL=true`
> currently sets `ssl: { rejectUnauthorized: false }` in
> `src/repositories/PostgresFlightRepository.ts`. That encrypts the connection
> but **does not verify the server certificate**, so it does not protect against
> an active man-in-the-middle. It is fine for a local container and not fine for
> RDS, Azure Database or Cloud SQL.

To fix it, mount your provider's CA bundle and pass it through:

```ts
ssl: options.ssl
  ? { ca: readFileSync(options.sslCaPath, "utf8"), rejectUnauthorized: true }
  : undefined,
```

Then mount the CA into the pod (ConfigMap → volume) and add an env var for the
path. Each provider publishes its bundle: AWS `rds-ca-*`, Azure uses the
DigiCert/Microsoft roots, Google Cloud SQL issues a per-instance certificate.

### Connection pooling matters

`DATABASE_POOL_MAX` is **per pod**. With `replicas: 2` and `DATABASE_POOL_MAX:
10` you open up to 20 backend connections. Managed instances have modest
limits (a small RDS instance may allow only ~100 total), so size it as
`replicas × poolMax + headroom`, or put PgBouncer / RDS Proxy in front and
point `DATABASE_URL` at that.

### Managed database checklist

| | AWS | Azure | Google Cloud |
| --- | --- | --- | --- |
| Service | RDS / Aurora PostgreSQL | Azure Database for PostgreSQL Flexible Server | Cloud SQL for PostgreSQL |
| Networking | Same VPC as the cluster; security group allows the node/pod CIDR | VNet integration or a firewall rule | Private IP, or the Cloud SQL Auth Proxy sidecar |
| Credentials | Secrets Manager (rotation) or IAM auth | Key Vault or Entra ID auth | Secret Manager or IAM auth |
| Pooling | RDS Proxy | PgBouncer (built in on Flexible Server) | PgBouncer sidecar |

### Migrations

`db/schema.sql` is a create-if-not-exists bootstrap script, not a migration
tool. For a real deployment adopt a migration runner (node-pg-migrate,
Flyway, Atlas) and run it as a Kubernetes `Job` or an init container **before**
the rollout, so schema changes are ordered against deploys.

---

## Deploying to a cloud cluster

The manifests in `k8s/` target Docker Desktop. They are valid Kubernetes and
deploy to EKS/AKS/GKE unchanged *structurally*, but four things are
local-development choices you must revisit.

### What is Docker-Desktop-specific

| # | Setting | Where | Change it to |
| --- | --- | --- | --- |
| 1 | `image: langgraph-travel-agent:local` | `12-backend-deployment.yaml`, `21-frontend-deployment.yaml` | A fully-qualified registry reference pinned to an immutable tag or digest |
| 2 | `imagePullPolicy: IfNotPresent` | both Deployments | `IfNotPresent` is correct **only** because Docker Desktop shares its image store with the cluster. In the cloud use `Always` with mutable tags, or keep `IfNotPresent` with immutable digests |
| 3 | `type: LoadBalancer` | `22-frontend-service.yaml` | Works everywhere, but gives you a raw L4 IP with no TLS. Prefer `ClusterIP` + an Ingress with a managed certificate |
| 4 | `CORS_ALLOWED_ORIGINS: "*"` | `10-backend-config.yaml` | Your real frontend origin. (Low risk, since the backend is `ClusterIP` and the browser never reaches it directly — but tighten it anyway) |

Also worth adding before calling it production: an HPA, a PodDisruptionBudget,
a NetworkPolicy, and a real secrets integration (below) instead of a manually
created Secret.

### Amazon EKS

**1. Registry (ECR).**

```bash
aws ecr create-repository --repository-name langgraph-travel-agent
aws ecr create-repository --repository-name chat-assistant
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build -t "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/langgraph-travel-agent:$GIT_SHA" \
  ./services/langgraph-travel-agent
docker push "$ACCOUNT.dkr.ecr.$AWS_REGION.amazonaws.com/langgraph-travel-agent:$GIT_SHA"
# …same for chat-assistant
```

Nodes with the `AmazonEC2ContainerRegistryReadOnly` policy pull from ECR
without an `imagePullSecret`.

**2. Point the manifests at it** — a kustomize overlay keeps `k8s/` clean:

```yaml
# k8s/overlays/eks/kustomization.yaml
resources:
  - ../../
images:
  - name: langgraph-travel-agent
    newName: 123456789012.dkr.ecr.eu-west-1.amazonaws.com/langgraph-travel-agent
    newTag: "abc1234"
  - name: chat-assistant
    newName: 123456789012.dkr.ecr.eu-west-1.amazonaws.com/chat-assistant
    newTag: "abc1234"
```

`kubectl apply -k k8s/overlays/eks`.

**3. Secrets — stop creating them by hand.** Use the AWS Secrets Manager CSI
driver, or External Secrets Operator:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: langgraph-travel-agent-secrets
  namespace: travel-agent
spec:
  refreshInterval: 1h
  secretStoreRef: { name: aws-secretsmanager, kind: ClusterSecretStore }
  target: { name: langgraph-travel-agent-secrets }
  dataFrom:
    - extract: { key: travel-agent/backend }
```

Give the pod an **IRSA** role (ServiceAccount annotated with
`eks.amazonaws.com/role-arn`) rather than static AWS credentials. Note the
Deployment currently uses the `default` ServiceAccount — create a dedicated one
and set `serviceAccountName`.

**4. Ingress instead of a raw LoadBalancer** (AWS Load Balancer Controller):

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: chat-assistant
  namespace: travel-agent
  annotations:
    kubernetes.io/ingress.class: alb
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
    alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:…
    alb.ingress.kubernetes.io/listen-ports: '[{"HTTPS":443}]'
    alb.ingress.kubernetes.io/ssl-redirect: "443"
spec:
  rules:
    - host: travel.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: chat-assistant, port: { number: 80 } } }
```

Then change `22-frontend-service.yaml` to `type: ClusterIP`.

**5. Database** — RDS PostgreSQL in the cluster VPC; put `DATABASE_URL` in
Secrets Manager; read [the TLS warning](#tls-to-a-managed-database) first.

### Azure AKS

**1. Registry (ACR).**

```bash
az acr create -n myregistry -g my-rg --sku Standard
az acr login -n myregistry
docker build -t myregistry.azurecr.io/langgraph-travel-agent:$GIT_SHA ./services/langgraph-travel-agent
docker push myregistry.azurecr.io/langgraph-travel-agent:$GIT_SHA

# let the cluster pull without an imagePullSecret
az aks update -n my-aks -g my-rg --attach-acr myregistry
```

**2. Images** — same kustomize overlay pattern, with
`newName: myregistry.azurecr.io/…`.

**3. Secrets** — the Azure Key Vault Provider for Secrets Store CSI Driver,
authenticated with **Workload Identity** (a federated ServiceAccount), not a
service-principal secret:

```yaml
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: travel-agent-kv
  namespace: travel-agent
spec:
  provider: azure
  secretObjects:
    - secretName: langgraph-travel-agent-secrets
      type: Opaque
      data:
        - { objectName: anthropic-api-key, key: ANTHROPIC_API_KEY }
        - { objectName: serper-api-key,    key: SERPER_API_KEY }
        - { objectName: database-url,      key: DATABASE_URL }
  parameters:
    usePodIdentity: "false"
    clientID: <workload-identity-client-id>
    keyvaultName: my-keyvault
    tenantId: <tenant-id>
    objects: |
      array:
        - |
          objectName: anthropic-api-key
          objectType: secret
```

**4. Ingress** — ingress-nginx or Application Gateway Ingress Controller, with
cert-manager for TLS; switch the frontend Service to `ClusterIP`.

**5. Database** — Azure Database for PostgreSQL Flexible Server with VNet
integration.

### Google GKE

Same shape: Artifact Registry for images
(`europe-west1-docker.pkg.dev/PROJECT/repo/chat-assistant:$GIT_SHA`), Workload
Identity for pod credentials, Secret Manager via the CSI driver, GKE Ingress or
Gateway API with a Google-managed certificate, and Cloud SQL reached over
private IP or the Auth Proxy sidecar.

### Scaling and resilience

Add these before taking real traffic:

```yaml
# HPA — the agent is I/O-bound on the LLM and Serper, so CPU alone is a weak
# signal; consider a custom/external metric for real workloads.
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: langgraph-travel-agent, namespace: travel-agent }
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: langgraph-travel-agent }
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: langgraph-travel-agent, namespace: travel-agent }
spec:
  minAvailable: 1
  selector: { matchLabels: { app.kubernetes.io/name: langgraph-travel-agent } }
```

**Memory sizing depends on the driver.** The JSON repository parses the whole
dataset into memory at boot, which is why the backend requests 192Mi and caps
at 512Mi. On Postgres or Duffel that footprint largely disappears and you can
lower both. If you grow `data/flights.json`, raise the limit or you will get
OOMKilled pods.

**Timeouts must nest.** `SERPER_TIMEOUT_MS` and `ANTHROPIC_TIMEOUT_MS` should
both sit comfortably inside `BACKEND_TIMEOUT_MS`, which should sit inside your
Ingress/ALB idle timeout (60s by default on an ALB — with
`ANTHROPIC_TIMEOUT_MS=45000` you are close to it).

Both services log one JSON object per line to stdout, propagate an
`x-request-id` end to end, and handle `SIGTERM` by draining in-flight requests,
so they work with any standard log collector.

---

## CI/CD

`.github/workflows/build.yml` runs on every push:

1. **`service`** (matrix over both services) — checkout → `npm ci` → lint →
   typecheck → test → build → Docker build (Buildx, GHA layer cache) → boot the
   image with **no secrets present** and poll `/health`.
2. **`manifests`** — render `k8s/` with kustomize, validate with `kubeconform`,
   and fail the build if a credential-looking value was committed under `k8s/`.

**It does not push images or deploy** — that is deliberate, and it is the part
you extend. To publish to a registry, replace `push: false` in the
`docker/build-push-action` step and authenticate with OIDC rather than
long-lived keys:

```yaml
permissions:
  contents: read
  id-token: write          # required for OIDC

- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: arn:aws:iam::123456789012:role/github-actions-ecr
    aws-region: eu-west-1
- uses: aws-actions/amazon-ecr-login@v2
- uses: docker/build-push-action@v6
  with:
    context: services/${{ matrix.service }}
    tags: ${{ steps.login-ecr.outputs.registry }}/${{ matrix.service }}:${{ github.sha }}
    push: true
```

Azure equivalents: `azure/login@v2` with OIDC, then `az acr login`.

For deployment, add a separate job gated on the default branch that updates the
kustomize image tag and applies it — and keep production behind a GitHub
Environment with required reviewers.

---

## Security model

- **No credential ever reaches the browser.** The frontend holds no keys, mounts
  no Secret and ships no SDK; the browser talks only to `chat-assistant`, which
  talks only to `BACKEND_URL`. A test asserts the served page and scripts
  contain no key material.
- **No secret is baked into an image.** `.env` and `k8s/secret.yaml` are
  git-ignored; `k8s/11-backend-secret.example.yaml` is a template with empty
  values; CI fails if a credential-looking value appears under `k8s/`.
- **Keys are never logged** — only *whether* one is set — and never returned by
  an endpoint.
- **Upstream errors are not echoed to the browser**; the frontend returns a
  generic 502/504 with a correlation id.
- **Model output is never trusted HTML.** The UI escapes first, then formats a
  small markdown subset, and drops non-`http(s)` link targets. This is
  unit-tested.
- **Containers run as non-root**, with a read-only root filesystem, all
  capabilities dropped, `allowPrivilegeEscalation: false` and the
  `RuntimeDefault` seccomp profile.
- **Input is validated** with zod at the HTTP boundary, with a 32 kB body cap.

Still to do for a real deployment: authentication and per-user rate limiting on
`/api/chat` (there is none — the endpoint is open, and it spends money on LLM
and search calls), a NetworkPolicy restricting backend ingress to the frontend
pods, and the [TLS fix](#tls-to-a-managed-database) if you use Postgres.

---

## Testing

```bash
cd services/langgraph-travel-agent && npm test    # 109 tests
cd services/chat-assistant        && npm test    # 31 tests
```

| Suite | Covers |
| --- | --- |
| `intentParser.test.ts` | Routes, IATA codes, absolute/relative/rolled-over dates, trip length, passengers, cabin, budget, topic extraction, follow-up inheritance |
| `jsonFlightRepository.test.ts` | Date matching and flexibility fallback, seat/cabin/price filters, ordering, limits, date rolling, use-before-init |
| `config.test.ts` | Driver selection, required-credential rules, timeout ordering, CORS list parsing |
| `postgresQuery.test.ts` | SQL shape, parameter binding, injection safety |
| `duffelMapper.test.ts` | ISO-8601 duration parsing, offer/slice/segment mapping, connections, baggage, refund conditions, expiry, sparse payloads |
| `duffelFlightRepository.test.ts` | Request headers and body, cheapest-first ordering, price/limit filters, expired-offer removal, capped date flexibility, typed errors, token redaction, health-probe caching, airport paging |
| `serperSearchService.test.ts` | Request shape, response mapping, HTTP errors, timeouts, disabled mode |
| `travelGraph.test.ts` | Node execution order, parallel branches, single join, per-branch failure isolation, multi-turn state, cheapest/fastest selection |
| `api.test.ts` | `/health` 200/503, `/api/chat` happy path, validation errors, correlation ids, degraded behaviour |
| `server.test.ts` (frontend) | Config validation, proxy target and headers, 502/504 handling, static assets, no-key-leak assertion |
| `render.test.ts` (frontend) | Markdown rendering, flight cards, source chips, and the escape-then-format rule |

Every external collaborator (repository, Serper, Claude, `fetch`) is injected,
so the suites are fast, deterministic and need no network or API keys.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| UI shows "offline" | `chat-assistant` cannot be reached; check the pod and the Service |
| Replies work but are plainly templated | No `ANTHROPIC_API_KEY`. Check `curl /health \| jq .features.llm` |
| `sources` is always empty | No `SERPER_API_KEY`, or the call timed out — look at `diagnostics.errors` |
| 502 from `/api/chat` | Frontend cannot reach `BACKEND_URL`. In Kubernetes, confirm it is the service DNS name, not `localhost` |
| 504 from `/api/chat` | The agent exceeded `BACKEND_TIMEOUT_MS` — usually a slow LLM call |
| Backend `/health` returns 503 | The flight repository is unhealthy; `checks.flights.detail` says why |
| Pod `CrashLoopBackOff` at boot | Config validation failed. `kubectl logs` prints the exact invalid variable |
| `FLIGHT_REPOSITORY=postgres requires DATABASE_URL` | The Secret is missing or the key is empty |
| "No seats on *date*; showing the closest dates" | Working as designed — the repository widened the date window |
| `FLIGHT_REPOSITORY=duffel requires DUFFEL_ACCESS_TOKEN` | The token is missing from the Secret |
| Duffel pod fails at boot with a 401 | The token is wrong, or a test token is being used against a live-only feature |
| Duffel searches time out | Raise `DUFFEL_TIMEOUT_MS` *and* `BACKEND_TIMEOUT_MS`, or lower `DUFFEL_SUPPLIER_TIMEOUT_MS` |
| Duffel bill higher than expected | Lower `DUFFEL_MAX_FLEXIBILITY_REQUESTS` to `0` — every retry is a billable offer request |
| Pods OOMKilled | The JSON dataset grew past the 512Mi limit — raise it or move to Postgres |

---

## Limitations

- **The default flight data is synthetic.** `FLIGHT_REPOSITORY=json` serves a
  generated, Duffel-*shaped* dataset. Nothing in it is bookable.
- **The Duffel driver has never run against the live API.** It is written to
  the published v2 contract and covered by 41 unit tests with an injected
  `fetch`, but no request has been made with a real token — expect to iterate
  on the mapping the first time you point it at `api.duffel.com`.
- **`/api/chat` is unauthenticated and unthrottled.** Fine for a local demo,
  not for anything public.
- **Conversation state lives in the browser** and is echoed back on each
  request. There is no server-side session store, so history is capped and
  lost on refresh.
- **`parseRequest` understands the 16 airports** in `src/domain/airports.ts`.
  Add a city there and regenerate the dataset to widen coverage. It is
  English-only and rule-based — robust and free, but it will not handle phrasing
  it was not written for.
- **Both probes use the same `/health`.** A separate deep-dependency readiness
  check would be the next refinement.
- **Never deployed to a real cloud cluster.** The manifests are valid and
  `kubeconform`-checked in CI, and the EKS/AKS guidance above is the standard
  path — but it has not been exercised end to end against a live EKS or AKS
  cluster.
