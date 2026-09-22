# Fake WhatsApp Server on AWS — Deployment Guide (WS-340)

**Address:** https://testserver.stacx24.com  **Owner ticket:** WS-340 (parent WS-330)
**Code:** `comdove-fake-backend` → `infra/` (this folder). Short command list: [`README.md`](README.md).

---

## 1. What it is

ComDove sends and receives WhatsApp messages through **Meta's WhatsApp Cloud API**. For testing we
don't want real Meta, real phone numbers, or real costs, so the team built a **fake WhatsApp server**
that behaves like Meta:

| Repo | Branch | What it is |
|---|---|---|
| **comdove-fake-backend** | `develop` | The fake Meta API (`POST /v21.0/{phone-id}/messages` …), signed webhooks back to ComDove, a WebSocket for the live UI, and an SQLite store |
| **comdove-fake-ui** | `main` | Web pages: **/client**, phone "tiles" where testers act as customers; **/admin**, numbers, groups and a live log |

ComDove is switched to the fake server with **one setting**:
`META_GRAPH_API_BASE_URL=https://testserver.stacx24.com`. No ComDove code changes are needed.

**This deployment** puts both repos on a tiny AWS server that is **ON only while testing**:
- it turns off with one click or automatically when idle;
- it turns on in about 25 seconds with one command;
- the data survives restarts.

**What the fake server supports:**
- **Text messages** in both directions: ComDove → customer, and customer → ComDove.
- **Status updates**: sent, then delivered, then read.
- **Error injection**, e.g. header `X-Mock-Force-Error: 130429`.

**Not supported:** template messages and campaigns. Use the old local `fake-whatsapp-server` for those.

---

## 2. How it fits together

```
                       Internet
                          │   https://testserver.stacx24.com
                          ▼
 ┌──────────────── AWS account 891377106348 · region ap-south-1 (Mumbai) ────────────────┐
 │                                                                                        │
 │  Route 53  stacx24.com  ──  A record  testserver → <current public IP>  (TTL 60 s)      │
 │                                                                                        │
 │  EC2  t4g.nano  "comdove-fake-server"   (firewall: 80 + 443 in only, no SSH)            │
 │   ├─ Caddy  :80/:443   HTTPS certificate · login · routing · serves the UI files       │
 │   │    /v…/…  (Meta API, ComDove's Bearer token)   → Node :4020   (no login)            │
 │   │    /health                                      → Node :4020   (no login)           │
 │   │    /api  /ws  /reset  /docs                     → Node :4020   (login)              │
 │   │    /  /client  /admin   (UI files)              → disk          (login)             │
 │   │    /power  +  /_power/*  (ON/OFF page)          → Python :4021  (login)             │
 │   ├─ Node 22   comdove-fake-backend  → SQLite file /var/lib/comdove-fake/mock.sqlite     │
 │   ├─ Python    power endpoint (turn off)                                               │
 │   └─ timers    backup every 10 min · idle check every 1 min · DNS update each boot      │
 │                                                                                        │
 │  S3 bucket  comdove-fake-server-891377106348-ap-south-1                                │
 │     Terraform state · uploaded builds · backups (mock.sqlite + TLS certificate)        │
 │  Parameter Store  /comdove-fake/*   secrets + login                                    │
 └────────────────────────────────────────────────────────────────────────────────────────┘
          ▲  sends: POST /v21.0/…/messages                 │  webhooks: inbound + sent/delivered/read
          │                                                ▼  (to COMDOVE_WEBHOOK_URL)
                         ComDove backend (wat-backend) — runs elsewhere
```

---

## 3. What runs on the server — and why there is **no Redis / no Postgres**

| Program | Job | Memory |
|---|---|---|
| **Node.js 22** → comdove-fake-backend | Fake Meta API, WebSocket to the UI, webhooks to ComDove (with retries) | ~100–150 MB |
| **Caddy 2** | HTTPS certificate (Let's Encrypt, automatic), login, routing, serving the UI files | ~30–50 MB |
| **Python** power service | `/_power/status` and `/_power/off` (localhost only, behind the login) | ~15 MB |
| **SSM agent** | Lets admins open a shell through AWS (no SSH port) | ~20 MB |

The fake backend's only dependencies are `express`, `ws`, `better-sqlite3`, `swagger-ui-express`, `dotenv`.

| Job | ComDove (the real product) uses | The fake server uses |
|---|---|---|
| Store data | **Postgres** (a database server) | **SQLite**: one file, read and written by Node itself; no server |
| Background work / retries | **Redis + BullMQ** queues | Its own small queue **inside the same SQLite file** (tables `webhook_jobs`, `webhook_attempts`) plus timers in Node |
| Live updates to browsers | **Redis pub/sub** → SSE | **WebSocket** directly from the one Node process |
| Copies running | Many processes → they must share state via Redis/Postgres | **Exactly one** → nothing to share |

So: **nothing else has to be switched on.** Your local Postgres/Redis are only needed by **ComDove**
(if you run ComDove on your laptop), never by this server.

---

## 4. Storage — where everything lives

| Place | What's in it | Size | Lives |
|---|---|---|---|
| **EBS disk** (gp3, 4 GB, encrypted) | OS + Node + Caddy + app (`/opt/comdove-fake`) + SQLite data (`/var/lib/comdove-fake/mock.sqlite`) + TLS certificate (`/var/lib/caddy`) + 1 GB swap file + logs | ~3 GB used | While the server exists; kept when **stopped**, deleted by `down.sh` |
| **SQLite** `mock.sqlite` | Business numbers, groups, customers, conversations, messages, webhook jobs and attempts, rejected requests | ~100 KB | On the disk, backed up to S3 |
| **S3 bucket** `comdove-fake-server-891377106348-ap-south-1` | `comdove-fake/server.tfstate` (Terraform state) · `builds/…zip` (auto-deleted after 14 days) · `runtime/mock.sqlite` (data backup) · `runtime/caddy/…` (certificate backup) | < 1 MB | **Permanent** (private, encrypted, versioned) |
| **Parameter Store** `/comdove-fake/*` | `APP_SECRET`, `WEBHOOK_VERIFY_TOKEN` (encrypted), `COMDOVE_WEBHOOK_URL`, `UI_USER`, `UI_PASSWORD` (encrypted) | tiny | **Permanent** |

**Backups:** every 10 minutes and at every shutdown, the server copies `mock.sqlite` and the
certificate to S3. A brand-new server (`up.sh`) restores both before it starts. That's why data
and the certificate survive even a full delete and re-create.

---

## 5. The instance

| Setting | Value | Why |
|---|---|---|
| Type | **t4g.nano**: 2 vCPU (burstable), **0.5 GB RAM**, ARM Graviton | Smallest and cheapest; the server needs ~200 MB |
| Image | **Amazon Linux 2023 minimal** (arm64), latest at creation | The only image that allows a disk under 8 GB |
| Disk | **4 GB gp3**, encrypted, deleted with the instance | Smallest safe size (OS + tools + 1 GB swap) |
| Region / zone | ap-south-1 (Mumbai), default VPC, default subnet | Same region as the team |
| CPU credits | **standard** | Never charges for bursts. When credits are empty the CPU is capped at 5 %, so the **first boot is slow (~11 min)**; later starts take ~25 s |
| Shutdown behaviour | **stop** | Turning off keeps the disk and data; no instance or IP charge while off |
| Metadata | IMDSv2 only | Security best practice |
| Login to the box | **No SSH.** `aws ssm start-session --target <instance-id>` (needs the Session Manager plugin) | No open admin port |
| Current ID | `i-0cbf78df32d07640e` (changes after `down.sh` + `up.sh`) | |

---

## 6. Name and IP address

- **`stacx24.com`** is the company's domain. Its DNS is a Route 53 **hosted zone in this AWS account**, so
  sub-names can be created freely.
- Terraform created the **A record `testserver.stacx24.com`** (the subdomain is a variable, `subdomain = "testserver"`).
- The server gets an **automatic public IPv4 from Amazon's pool** at every start (it's not an Elastic IP,
  so there's no fixed-IP fee). Example history: 15.252.121.73 → 13.203.210.93 → 35.154.96.9.
- On **every boot** the server reads its new IP from the EC2 metadata service and **updates its own
  A record**. Its permission is limited to that single record. The TTL is 60 s, so everyone follows within a minute.
- When **stopped**, AWS takes the IP back, so a stopped server doesn't pay for the IP.

---

## 7. Security

- **Login required** (HTTP basic auth, enforced by Caddy) for `/client`, `/admin`, `/api`, `/ws`, `/docs`, `/power`.
  The fake backend has **no login of its own**, and its API even lists tokens, so Caddy's login is essential.
- **Open without login:** only `/v…/…` (the Meta API, which checks the business number's Bearer token like real Meta) and `/health`.
- **Firewall:** only ports 80 and 443. Node (4020) and the power service (4021) are **not reachable** from outside.
- **Secrets** are only in Parameter Store (encrypted). They're written to the server at boot (file mode 600).
  **Never in git, never in Terraform state.**
- **IAM (server role):** read `/comdove-fake/*`, read `builds/*`, read/write `runtime/*` in the bucket,
  UPSERT only the `testserver` A record, and SSM Session Manager. Nothing else.
- **Git:** `infra/.gitignore` blocks `*.tfstate`, `*.tfvars`, `seed.json` and `.build/`.

Current login: user **`comdove`**. To see the password:
`aws ssm get-parameter --name /comdove-fake/UI_PASSWORD --with-decryption --query Parameter.Value --output text`
(it is currently weak; change it with `secrets.sh` + stop/start).

---

## 8. Cost (AWS Price List API, ap-south-1 on-demand)

| Item | Price | While ON | While OFF (stopped) | After `down.sh` |
|---|---|---|---|---|
| t4g.nano | $0.0028 / hour | ✔ | — | — |
| Public IPv4 | $0.005 / hour | ✔ | — | — |
| 4 GB gp3 disk | $0.0912 per GB-month (≈ $0.0005 / hour) | ✔ | ✔ | — |
| S3 bucket (< 1 MB) | $0.025 per GB-month | ≈ $0 | ≈ $0 | ≈ $0 |
| Parameter Store (standard), IAM, security group | free | $0 | $0 | $0 |
| Route 53 queries | $0.40 per million | ≈ $0 | ≈ $0 | ≈ $0 |
| **Total** | | **≈ $0.0083 / hour** | **≈ $0.0005 / hour** | **≈ $0** |

| Scenario | Cost |
|---|---|
| 1 hour of testing | ≈ **$0.008** |
| A day with 8 h ON | ≈ **$0.07** |
| A day with 24 h ON | ≈ $0.20 |
| A month, typical (2 h/day × 22 days) | ≈ **$0.70** |
| A month fully OFF (stopped) | ≈ $0.36 (the disk) |
| A month never turned off (prevented by auto-off) | ≈ $6.06 |
| After `down.sh` | ≈ $0 |

No Elastic IP, no burst surcharge, and no NAT or load balancer.

---

## 9. How we deployed it (what was done, in order)

1. **Tools on the laptop:** Terraform 1.16 (official download, checksum verified) and AWS CLI v2
   (official package, signature verified), installed in `~/.local` with no admin rights.
2. **AWS sign-in:** `aws login` reuses the console session and gives temporary keys; no access keys are stored.
3. **Checked the account:** it owns the `stacx24.com` zone, there's a default VPC in Mumbai, and nothing named `testserver` existed.
4. **Wrote the infrastructure as code** (`infra/`): two Terraform stacks plus scripts, all validated offline
   (`terraform validate`, rendered boot script, real Caddy config check) before touching AWS.
5. **Bootstrap:** `bootstrap.sh` → the permanent S3 bucket (plan: 6 to add).
6. **Secrets:** stored in Parameter Store (`APP_SECRET` / `WEBHOOK_VERIFY_TOKEN` copied from ComDove's `.env`).
7. **Build:** `build.sh` compiles both repos **on the laptop** (the server is too small to compile)
   and zips the result (~170 KB).
8. **Up:** `up.sh` → `terraform apply` (plan: 8 to add). The first boot installs the packages (AWS CLI,
   SSM agent), Node 22 and Caddy, fetches the build and secrets, restores the backups, gets the HTTPS
   certificate, and starts everything.
9. **Verified live:**
   - HTTPS works, and the login blocks strangers.
   - A Meta-style send returns a `wamid`, and a wrong token gets error 190.
   - Backups land in S3, and data plus the certificate were restored onto a new server.
   - The power-off toggle → stopped in 19 s; `start.sh` → back in 24 s with DNS on the new IP.
   - Auto-off turned an idle server off by itself.

Design decisions: the smallest instance; **stop** (not delete) when off; **no fixed IP** (DNS
self-update instead); **Caddy** as the reverse proxy (WS-330 U4); **backups in S3** (they also avoid
Let's Encrypt's 5-certificates-per-week limit when re-creating).

---

## 10. Everyday use

Once per terminal session:
```bash
cd "/path/to/comdove-fake-backend"
aws login --region ap-south-1
```

| I want to… | Command |
|---|---|
| **Turn ON** (~25 s) | `infra/scripts/start.sh` |
| **Turn OFF now** | https://testserver.stacx24.com/power → switch → **Turn off**, or `infra/scripts/stop.sh` |
| Check ON/OFF | `infra/scripts/status.sh` |
| Deploy new code (after pulling fake-backend `develop` / fake-ui `main`) | `infra/scripts/down.sh -y && infra/scripts/up.sh -y` (~11 min, first boot) |
| Delete everything except the bucket (≈ $0) | `infra/scripts/down.sh` |
| Create it again | `infra/scripts/up.sh` |
| Change the login / secrets | `infra/scripts/secrets.sh`, then `stop.sh -y && start.sh` (login), or `down.sh -y && up.sh -y` (other secrets) |

| Page | Address |
|---|---|
| Phones | https://testserver.stacx24.com/client |
| Admin | https://testserver.stacx24.com/admin |
| Power switch | https://testserver.stacx24.com/power |
| API docs | https://testserver.stacx24.com/docs |

**Seeing it in the AWS Console:** region **Mumbai** → EC2 → Instances → `comdove-fake-server`.
Also: Route 53 → `stacx24.com` (the `testserver` record), S3 → the bucket, Systems Manager → Parameter Store → `/comdove-fake/`.

---

## 11. Automatic behaviour (timers)

| What | When | Effect |
|---|---|---|
| **Idle auto-off** | Checked every 1 min | Turns off (EC2 stop) after **5 min** with no requests and no open browser tab. Never in the first 10 min after a start. An open tab keeps it ON |
| **Power toggle** | On demand (`/power`) | Off ~20 s after confirming |
| **Data + certificate backup** | Every 10 min, and at every shutdown | Copies to S3 |
| **DNS update** | Every boot | `testserver.stacx24.com` → the new IP |
| **Login refresh** | Every boot | Re-reads `UI_USER` / `UI_PASSWORD` from Parameter Store |
| **Certificate renewal** | Automatic (Caddy) | Before expiry (valid 90 days) |
| **Old builds in S3** | After 14 days | Deleted by a bucket lifecycle rule |

**It cannot start itself when a message arrives.** While it's off, nothing answers at the address, so
start it (`start.sh`, ~25 s) before sending.

---

## 12. Connecting ComDove

In the ComDove backend that should use it (**never production**):
```env
META_GRAPH_API_BASE_URL=https://testserver.stacx24.com
META_APP_SECRET=<same value as /comdove-fake/APP_SECRET>
WHATSAPP_VERIFY_TOKEN=<same value as /comdove-fake/WEBHOOK_VERIFY_TOKEN>
```
- ComDove's database must know the fake business numbers: `WabaAccount.wabaId` = `waba_id`,
  `WabaPhoneNumber.phoneNumberId` = `phone_number_id`, and the decrypted token = `token`.
- The server currently has **+14155550123** (`DEMO_PH_1789982738929`, `DEMO_WABA_1789982738913`, token `demo`)
  and group **alpha** (919876543210, 919876543211).
- **Sends** (ComDove → fake server) work from anywhere, including a laptop.
- **Webhooks** (fake server → ComDove: customer replies, sent/delivered/read) need ComDove at a
  **public URL**. Set it as `COMDOVE_WEBHOOK_URL` (`secrets.sh`), then `down.sh -y && up.sh -y`.
  It is currently a placeholder.

---

## 13. Data after restarts

| Event | Data |
|---|---|
| App restart / server reboot | ✅ kept (same disk) |
| Turn OFF (power page, `stop.sh`, auto-off) → `start.sh` | ✅ kept (disk kept) |
| `down.sh` → later `up.sh` | ✅ restored from the S3 backup |
| Sudden crash of the instance | ⚠️ up to the last 10 minutes may be lost |
| Open browser sessions / group "locks" | ❌ not kept (in memory); just reopen the tab |

---

## 14. Troubleshooting

| Problem | What to do |
|---|---|
| `start.sh` / `up.sh` says the session expired | `aws login --region ap-south-1` |
| Site doesn't open right after start | Wait ~1 min (DNS TTL 60 s). `status.sh` shows ON/OFF and HTTP 200 |
| First `up.sh` takes ~10 min | Normal: package installs on a CPU-capped nano (standard credits) |
| ComDove calls fail with 401 / code 190 | The token in the fake server's number ≠ ComDove's WABA token |
| ComDove rejects webhooks (401) | `APP_SECRET` ≠ ComDove `META_APP_SECRET` |
| Webhooks never arrive | `COMDOVE_WEBHOOK_URL` is the placeholder, or not public |
| Template / campaign sends fail | Expected: text messages only |
| Need logs | `aws ssm start-session --target <id>`, then `sudo tail -100 /var/log/comdove-fake-setup.log` or `sudo journalctl -u comdove-fake -u caddy -n 100` |

---

## 15. Files in `infra/`

```
infra/
├─ README.md                 short runbook (commands)
├─ DEPLOYMENT-GUIDE.md       this document
├─ bootstrap/                Terraform: the permanent S3 bucket (run once)
├─ server/                   Terraform: instance, firewall, IAM, DNS
│  ├─ user_data.sh.tftpl     first-boot setup script (installs + services + timers)
│  └─ power/                 /power page (index.html) + power endpoint (Python)
├─ scripts/                  bootstrap · secrets · build · up · start · stop · status · down
├─ seed.example.json         starter numbers/groups (copy to seed.json, git-ignored)
└─ .gitignore                keeps state, secrets and builds out of git
```

## 16. Known limits

- Text messages only (no templates or campaigns) in comdove-fake-backend.
- It can't start itself when ComDove sends; start it first (~25 s).
- The first boot after `up.sh` is slow (~11 min) because of CPU-credit throttling. Switching CPU credits to
  "unlimited" would speed it up for about a cent per boot.
- The ON/OFF switch is its own page (`/power`), not inside the phones/admin UI (that would be a change to comdove-fake-ui).
- The current login password is weak; change it before sharing widely.
