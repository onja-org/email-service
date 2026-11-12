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

This starts Postgres, ElasticMQ (SQS-compatible) and the service with `SES_DRY_RUN=true` (emails are logged, not sent). Open **http://localhost:3000/admin/login** and sign in with the admin token `local-admin-token-change-me`.

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
   The webhook only accepts events from that topic and returns 503 until `SNS_EVENTS_TOPIC_ARN` is set, so nobody can feed fake bounces into the suppression list from a topic of their own.
3. **Request SES production access** (AWS console → SES → Account dashboard). New accounts are sandboxed: they can only send to verified addresses. Describe it as transactional email for internal company applications; approval usually takes under a day.
4. **Deploy the container** (see §8) with the variables from `.env.example`. It runs migrations on start, then confirms the SNS subscription automatically when the first SNS request arrives.

### Testing while still in the SES sandbox

A new SES account is sandboxed: it sends only **to verified identities**, at most 200/day and 1/s. That is enough to test everything end to end.

1. In the SES console (your region) → **Identities → Create identity**: verify your sending **domain** (add the DKIM CNAMEs it shows), and verify each **email address** you will send test mail *to* (SES emails a confirmation link to it).
2. Run the preflight + one real send, with AWS credentials in your shell:
   ```bash
   AWS_REGION=eu-west-1 npm run ses:test -- --from no-reply@yourdomain.com --to you@yourdomain.com --dry
   ```
   It prints sandbox status, quota, and whether sender and recipients are verified. Drop `--dry` to send.
3. Then test the whole service: `docker compose up --build` with `SES_DRY_RUN=false`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` set in the `app` service's environment (SQS still runs on ElasticMQ locally), onboard a project (§3 or §4) and `POST /v1/emails` to a verified address. Watch `/dashboard` and `GET /v1/emails/:id` for `status: sent` and the `ses_message_id`.

Sending to an unverified address in the sandbox fails with `MessageRejected: Email address is not verified`; the message ends up `failed` with that error, which is the expected behaviour.

## 3. Admin UI

**`/admin/ui`** does everything the admin API does, from a browser: create projects, attach domains and see the DNS records and verification status, issue and revoke API keys, browse each project's emails with their SES events, and manage the shared suppression list. **`/dashboard`** is the performance dashboard (§6). Both require signing in at **`/admin/login`** with the `ADMIN_TOKEN`.

A successful login exchanges the token for a signed, HttpOnly, SameSite=Strict session cookie valid for 12 hours, so the token itself is never kept in the browser; sessions are stateless so any replica can verify them. The cookie is signed with `SESSION_SECRET`, or with a value derived from `ADMIN_TOKEN` when unset. Five failed logins from one IP pause that IP for a minute. Writes from the UI must carry an `x-requested-with: emailsvc-ui` header, which browsers never add cross-origin, so a foreign page cannot forge an admin action with the cookie. `ADMIN_TOKEN` keeps working as a bearer token for scripts.

## 4. Onboard a project

The same steps the UI performs, as API calls. All `/admin` calls use `Authorization: Bearer $ADMIN_TOKEN` (or the UI session cookie).

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

## 5. Sending (project API)

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
| `GET` | `/v1/suppressions/:email` | Check whether an address is suppressed |
| `POST` | `/v1/suppressions` | Add a manual suppression: `{"email": "...", "note": "..."}` |
| `DELETE` | `/v1/suppressions/:email` | Remove a manual suppression this project added (403 for bounces, complaints, or other projects' entries) |
| `GET/POST` | `/admin/projects` | List / create projects |
| `GET` | `/admin/projects/:slug` | Project with domains and keys |
| `POST/GET/DELETE` | `/admin/projects/:slug/domains[/:domain]` | Attach domain, poll DNS/verification, detach |
| `POST/DELETE` | `/admin/projects/:slug/keys[/:keyId]` | Issue / revoke API keys |
| `GET/POST` | `/admin/suppressions` | Global suppression list; add an admin manual entry |
| `GET/DELETE` | `/admin/suppressions/:email` | Look up an entry; admins can remove any entry |
| `GET` | `/admin/projects/:slug/emails`, `/admin/emails/:id`, `/admin/projects/:slug/templates` | Read-only views of a project's messages (with events) and templates |
| `POST` | `/admin/auth/login`, `/admin/auth/logout`; `GET /admin/auth/me` | Admin UI sessions (login body: `{"token": "<ADMIN_TOKEN>"}`) |
| `GET` | `/admin/login`, `/admin/ui`, `/dashboard` | Admin UI pages |
| `POST` | `/webhooks/ses` | SNS → SES events (signature-verified) |
| `GET` | `/health`, `/ready` | Liveness / readiness |

### Message statuses

`queued → sending → sent → delivered | bounced | complained`, or `suppressed` (every `to` recipient was on the suppression list) / `failed` (SES rejected it, or retries exhausted). `GET /v1/emails/:id` shows `attempts` and `last_error`.

## 6. Performance dashboard

Open **`/dashboard`** after signing in (§3). The page is static; every number comes from the read-only `/admin/stats/*` endpoints with the same `from`/`to`/`project` window, so all panels agree.

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

## 7. How it protects deliverability

- **Sender ownership.** A key can only send from its project's verified domains (and their subdomains). `From: anything@gmail.com` is refused with 403.
- **Per-project SES configuration sets.** Bounce and complaint rates are visible per project in SES/CloudWatch, so a misbehaving project is identifiable before it affects the account.
- **Global suppression list.** Permanent bounces and complaints from any project are suppressed for all projects, automatically, from SES events. Transient bounces are logged only. Projects can remove only manual suppressions they added themselves; lifting a bounce or complaint suppression requires the admin API.
- **DMARC alignment.** Domains are created with DKIM (2048-bit) and a custom MAIL FROM (`bounce.<domain>`) so both DKIM and SPF align. Start DMARC at `p=none`, move to `p=quarantine`/`p=reject` once reports look clean.
- **Header hygiene.** Callers cannot inject `From`, `Bcc`, `Return-Path` etc., and CR/LF in header values is rejected.
- **At-most-once sends.** A message is claimed with an atomic status update before SES is called; duplicate SQS deliveries are dropped. Transient SES errors retry with exponential backoff (30s → 15min) up to `MAX_SEND_ATTEMPTS`, then go to `failed` and the SQS DLQ.

Keep the account bounce rate under 5% and complaint rate under 0.1%; SES pauses accounts that exceed them.

## 8. Deployment

One image, three modes:

- `MODE=all` — API + worker in one process. Fine for most internal loads; scale by running more replicas (SQS and the DB claim make that safe).
- `MODE=api` / `MODE=worker` — split when you want to scale them independently.

The webhook endpoint must be reachable from AWS over HTTPS (public or via a load balancer that AWS can reach). Everything else can be private.

Run it on Railway, ECS/Fargate, Kubernetes, Fly.io, a VM with `docker run`, etc.

### Railway

`railway.json` in the repo tells Railway to build the Dockerfile and health-check `/health`.

1. **Create a project** from this GitHub repo (Railway → New Project → Deploy from GitHub repo). It detects the Dockerfile.
2. **Add Postgres** (→ Add → Database → PostgreSQL). On the service's Variables tab add a reference `DATABASE_URL = ${{Postgres.DATABASE_URL}}` (the private-network URL; no TLS needed). If you use the public proxy URL instead, set `DATABASE_SSL=true`.
3. **Set the other variables** on the service:
   ```
   MODE=all
   AWS_REGION=us-east-1
   AWS_ACCESS_KEY_ID=…            AWS_SECRET_ACCESS_KEY=…
   SQS_QUEUE_URL=…                SNS_EVENTS_TOPIC_ARN=…        (from `npm run setup:aws`)
   SES_DRY_RUN=false
   ADMIN_TOKEN=<long random>      SESSION_SECRET=<long random>
   ```
   Railway injects `PORT` itself; the service listens on it.
4. **Generate a domain** (Settings → Networking → Generate Domain, or attach your own). Deploy finishes when `/health` answers.
5. **Subscribe the webhook** to the SNS topic, once, from your machine:
   ```bash
   AWS_REGION=us-east-1 WEBHOOK_URL=https://<your-railway-domain>/webhooks/ses npm run setup:aws
   ```
   The running service confirms the subscription automatically (look for "confirmed SNS subscription" in the logs). The script lists every subscription on the topic; delete stale ones in the SNS console.
6. Sign in at `https://<domain>/admin/login` with `ADMIN_TOKEN` and onboard projects (§3).

Scale by adding replicas of the same service; the SQS queue and the database claim make that safe. To split API and worker, add a second service from the same repo with `MODE=worker` (no domain needed) and set the first to `MODE=api`.

Example with plain Docker:

```bash
docker build -t email-service .
```

```bash
docker run -d --name email-service -p 3000:3000 --env-file .env email-service
```

## 9. Operations

- **Logs** are JSON (pino). Every request has a `reqId`; worker lines carry `messageId`.
- **Stale queue sweep.** If a message was stored but the SQS enqueue failed, the worker re-enqueues it after 10 minutes.
- **DLQ.** Messages that fail 5 receives land in `emailsvc-send-dlq`; the DB row will be `failed` with `last_error`.
- **Worker crash mid-send.** A message left in `sending` is re-claimable after 5 minutes; redeliveries wait for that, and the sweep re-enqueues anything stuck for 10 minutes, so a dead worker never loses an email.
- **Rotate a key:** create a new one, switch the project, revoke the old (`DELETE /admin/projects/:slug/keys/:id`).
- **Remove a domain from SES too:** `DELETE /admin/projects/:slug/domains/:domain?delete_identity=true`.
- **Schema changes:** add `migrations/00N_name.sql`; applied automatically on container start (advisory-locked, so parallel replicas are safe).
