# email-service

A shared transactional email service for internal projects. Each project gets an API key scoped to its own verified domain(s); the service validates, queues, renders and sends through **Amazon SES**, tracks delivery/bounce/complaint events, and keeps a global suppression list so one project's bad addresses never hurt another's reputation.

```
project A ──┐                                   ┌─► SES (config set per project) ─► inbox
project B ──┼─► POST /v1/emails ─► Postgres ─► SQS ─► worker ─┤
project C ──┘        (Fastify)        ▲                       └─► SNS events ─► POST /webhooks/ses ─┐
                                      └──────────── status / suppression updates ◄─────────────────┘
```

**Stack:** Node.js 22 · TypeScript · Fastify 5 · Postgres · SQS · SES v2 · one container (`MODE=api|worker|all`).

---

## 1. Local development (no AWS account needed)

```bash
docker compose up --build
```

This starts Postgres, ElasticMQ (SQS-compatible) and the service with `SES_DRY_RUN=true` (emails are logged, not sent). Admin token is `local-admin-token-change-me`.

Without Docker: start Postgres + ElasticMQ yourself, `cp .env.example .env`, then `npm install && npm run migrate && npm run dev`.

```bash
npm test        # unit tests
npm run build   # tsc → dist/
```

## 2. Production setup (once)

1. **AWS credentials.** Run the service with an IAM role allowed `ses:SendEmail`, `ses:*EmailIdentity*`, `ses:*ConfigurationSet*`, `sqs:ReceiveMessage/SendMessage/DeleteMessage/ChangeMessageVisibility`, `sns:Subscribe/CreateTopic`.
2. **Create the queue and topic:**
   ```bash
   AWS_REGION=eu-west-1 WEBHOOK_URL=https://email.internal.example.com/webhooks/ses npm run setup:aws
   ```
   Copy the printed `SQS_QUEUE_URL` and `SNS_EVENTS_TOPIC_ARN` into the environment.
3. **Request SES production access** (AWS console → SES → Account dashboard). New accounts are sandboxed: they can only send to verified addresses. Describe it as transactional email for internal company applications; approval usually takes under a day.
4. **Deploy the container** (see §7) with the variables from `.env.example`. It runs migrations on start, then confirms the SNS subscription automatically when the first SNS request arrives.

## 3. Onboard a project

All `/admin` calls use `Authorization: Bearer $ADMIN_TOKEN`.

```bash
BASE=https://email.internal.example.com
A="Authorization: Bearer $ADMIN_TOKEN"

# 1. Create the project (also creates its SES configuration set)
curl -s -X POST $BASE/admin/projects -H "$A" -H 'content-type: application/json' \
  -d '{"slug":"billing","name":"Billing app"}'
```

```bash
# 2. Attach its domain. Response lists the DNS records to add (DKIM CNAMEs, MAIL FROM MX/TXT, DMARC TXT).
curl -s -X POST $BASE/admin/projects/billing/domains -H "$A" -H 'content-type: application/json' \
  -d '{"domain":"billing.example.com"}'
```

```bash
# 3. Poll until "verified": true (DNS propagation: minutes to a few hours)
curl -s $BASE/admin/projects/billing/domains/billing.example.com -H "$A"
```

```bash
# 4. Issue an API key. The "key" field is shown exactly once.
curl -s -X POST $BASE/admin/projects/billing/keys -H "$A" -H 'content-type: application/json' \
  -d '{"name":"production"}'
```

A project may have several domains; it may send from any of them or their subdomains, and from nothing else.

## 4. Sending (project API)

Projects call `/v1/*` with `Authorization: Bearer es_live_...`.

```bash
curl -s -X POST $BASE/v1/emails -H "Authorization: Bearer es_live_..." -H 'content-type: application/json' -d '{
  "from": "Billing <no-reply@billing.example.com>",
  "to": ["ada@customer.com"],
  "reply_to": ["support@example.com"],
  "subject": "Your invoice #42",
  "html": "<p>Hi Ada, your invoice is attached…</p>",
  "text": "Hi Ada, your invoice is attached…",
  "tags": {"invoice": "42"},
  "idempotency_key": "invoice-42-sent"
}'
```

Response `202` with `{"id": "...", "status": "queued", ...}`. Repeating the same `idempotency_key` returns `200` with the original message instead of sending twice.

With a template:

```bash
curl -s -X PUT $BASE/v1/templates/invoice -H "Authorization: Bearer es_live_..." -H 'content-type: application/json' -d '{
  "subject": "Your invoice #{{number}}",
  "html": "<p>Hi {{name}}, invoice {{number}} for {{amount}} is ready.</p>",
  "text": "Hi {{name}}, invoice {{number}} for {{amount}} is ready."
}'
```

```bash
curl -s -X POST $BASE/v1/emails -H "Authorization: Bearer es_live_..." -H 'content-type: application/json' -d '{
  "from": "no-reply@billing.example.com",
  "to": ["ada@customer.com"],
  "template": "invoice",
  "template_data": {"name": "Ada", "number": 42, "amount": "€120"}
}'
```

Templates are Handlebars. `{{var}}` is HTML-escaped in the html body; use `{{{var}}}` for trusted HTML.

### Node.js client (any project)

```ts
const res = await fetch(`${process.env.EMAIL_SERVICE_URL}/v1/emails`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.EMAIL_SERVICE_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'no-reply@billing.example.com', to: [user.email], template: 'invoice', template_data }),
});
if (!res.ok) throw new Error(`email-service ${res.status}: ${await res.text()}`);
const { id } = await res.json();
```

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/emails` | Queue an email (202) |
| `GET` | `/v1/emails?limit&before&status&to` | List this project's messages |
| `GET` | `/v1/emails/:id` | Message incl. body, headers, attempts, last error |
| `GET` | `/v1/emails/:id/events` | Raw SES events (delivery, bounce, complaint…) |
| `GET/PUT/DELETE` | `/v1/templates/:name` | Manage templates |
| `POST` | `/v1/templates/:name/render` | Preview with `{"data": {...}}` |
| `GET/POST/DELETE` | `/v1/suppressions/:email` | Check / add / remove an address |
| `GET/POST` | `/admin/projects` | List / create projects |
| `GET` | `/admin/projects/:slug` | Project with domains and keys |
| `POST/GET/DELETE` | `/admin/projects/:slug/domains[/:domain]` | Attach domain, poll DNS/verification, detach |
| `POST/DELETE` | `/admin/projects/:slug/keys[/:keyId]` | Issue / revoke API keys |
| `GET/DELETE` | `/admin/suppressions[/:email]` | Global suppression list |
| `POST` | `/webhooks/ses` | SNS → SES events (signature-verified) |
| `GET` | `/health`, `/ready` | Liveness / readiness |

### Message statuses

`queued → sending → sent → delivered | bounced | complained`, or `suppressed` (every recipient was on the suppression list) / `failed` (SES rejected it, or retries exhausted). `GET /v1/emails/:id` shows `attempts` and `last_error`.

## 5. Performance dashboard

Open **`/dashboard`** (the root `/` redirects there) and enter the `ADMIN_TOKEN`. The page is static; every number comes from the read-only `/admin/stats/*` endpoints with the same `from`/`to`/`project` window, so all panels agree.

- **KPI row:** accepted by SES (hero figure, delta vs the previous period), delivery rate, bounce and complaint rates with their status against SES's limits (5% / 0.1%), failures, queue depth and age, time-to-send p50/p95.
- **Emails accepted by SES:** stacked columns per hour (≤3 days) or per day, one color per project (fixed per project, up to 7, the rest folded into "Other").
- **Bounce rate / complaint rate over time**, each with the SES limit drawn as a reference line.
- **By project:** volume, rates, queue, last send, per project.
- **Recent failures, bounces and complaints** with the error SES returned.

Every chart has a **Table** toggle, hover tooltips, light/dark theme, and auto-refresh each minute. Delivery rate stays at 0 until the SNS webhook is subscribed (delivery is an SES event, not a send result).

Endpoints, all `Authorization: Bearer $ADMIN_TOKEN`, all accepting `?from=<ISO>&to=<ISO>&project=<slug>`:

| Path | Returns |
|---|---|
| `GET /admin/stats/summary` | counts for the window and the previous window, rates, latency percentiles, queue state |
| `GET /admin/stats/timeseries?bucket=hour\|day` | counts per bucket per project |
| `GET /admin/stats/projects` | per-project counts, rates, domains, last send |
| `GET /admin/stats/problems?limit=50` | latest failed / bounced / complained messages |

## 6. How it protects deliverability

- **Sender ownership.** A key can only send from its project's verified domains (and their subdomains). `From: anything@gmail.com` is refused with 403.
- **Per-project SES configuration sets.** Bounce and complaint rates are visible per project in SES/CloudWatch, so a misbehaving project is identifiable before it affects the account.
- **Global suppression list.** Permanent bounces and complaints from any project are suppressed for all projects, automatically, from SES events. Transient bounces are logged only.
- **DMARC alignment.** Domains are created with DKIM (2048-bit) and a custom MAIL FROM (`bounce.<domain>`) so both DKIM and SPF align. Start DMARC at `p=none`, move to `p=quarantine`/`p=reject` once reports look clean.
- **Header hygiene.** Callers cannot inject `From`, `Bcc`, `Return-Path` etc., and CR/LF in header values is rejected.
- **At-most-once sends.** A message is claimed with an atomic status update before SES is called; duplicate SQS deliveries are dropped. Transient SES errors retry with exponential backoff (30s → 15min) up to `MAX_SEND_ATTEMPTS`, then go to `failed` and the SQS DLQ.

Keep the account bounce rate under 5% and complaint rate under 0.1%; SES pauses accounts that exceed them.

## 7. Deployment

One image, three modes:

- `MODE=all` — API + worker in one process. Fine for most internal loads; scale by running more replicas (SQS and the DB claim make that safe).
- `MODE=api` / `MODE=worker` — split when you want to scale them independently.

The webhook endpoint must be reachable from AWS over HTTPS (public or via a load balancer that AWS can reach). Everything else can be private.

Run it on ECS/Fargate, Kubernetes, Fly.io, a VM with `docker run`, etc. Example:

```bash
docker build -t email-service .
```

```bash
docker run -d --name email-service -p 3000:3000 --env-file .env email-service
```

## 8. Operations

- **Logs** are JSON (pino). Every request has a `reqId`; worker lines carry `messageId`.
- **Stale queue sweep.** If a message was stored but the SQS enqueue failed, the worker re-enqueues it after 10 minutes.
- **DLQ.** Messages that fail 5 receives land in `emailsvc-send-dlq`; the DB row will be `failed` with `last_error`.
- **Rotate a key:** create a new one, switch the project, revoke the old (`DELETE /admin/projects/:slug/keys/:id`).
- **Remove a domain from SES too:** `DELETE /admin/projects/:slug/domains/:domain?delete_identity=true`.
- **Schema changes:** add `migrations/00N_name.sql`; applied automatically on container start (advisory-locked, so parallel replicas are safe).
