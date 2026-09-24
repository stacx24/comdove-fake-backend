# Runbook — fake WhatsApp server on `testserver.stacx24.com` (WS-340)

Spin the fake WhatsApp / Meta Cloud API server (**comdove-fake-backend** + **comdove-fake-ui**)
up on AWS only while testing, and tear it down afterwards.

```
testserver.stacx24.com ─► EC2 t4g.nano, 4 GB disk (Amazon Linux 2023 minimal, ARM, ap-south-1)
   Caddy :443  HTTPS (auto certificate) + login + static UI + reverse proxy   ← WS-330 U4
     /v…/…                        → fake backend :4020   (open: ComDove uses its Bearer token)
     /health                      → fake backend :4020   (open)
     /api /ws /reset /docs        → fake backend :4020   (behind login)
     / /client /admin             → UI files (client/dist)   (behind login)
     /power  +  /_power/*         → ON/OFF toggle page + local power endpoint (behind login)
   Node 22  comdove-fake-backend  → SQLite file (no Redis, no Postgres needed)
```

## Quick reference

| Task | Command (from the comdove-fake-backend repo root) |
|---|---|
| Sign in to AWS (each session) | `aws login --region ap-south-1` |
| **One-time**: create the bucket | `infra/scripts/bootstrap.sh` |
| **One-time** (or to change): secrets | `infra/scripts/secrets.sh` |
| **Create** the server (first time, or after `down.sh`; also deploys new code) | `infra/scripts/up.sh` (add `-y` to skip the prompt) |
| **Turn ON** (a stopped server, ~25 s) | `infra/scripts/start.sh` |
| **Turn OFF now** | the toggle at `https://testserver.stacx24.com/power`, or `infra/scripts/stop.sh` |
| **Delete** everything except the bucket | `infra/scripts/down.sh` (add `-y` to skip the prompt) |
| Is it running? | `infra/scripts/status.sh` |

## Prerequisites (laptop)

- **AWS CLI v2** (≥ 2.32 for `aws login`) and **Terraform ≥ 1.10**
- **Node.js ≥ 22** + npm (to build), `zip`, `curl`, `python3`
- Both repos checked out: **comdove-fake-backend** (`develop`) and **comdove-fake-ui** (`main`).
  The UI is found next to this repo, or set `FAKE_UI_DIR=/path/to/comdove-fake-ui`.
- AWS access to the account that owns the `stacx24.com` Route 53 zone.

## One-time setup

1. `aws login --region ap-south-1`
2. `infra/scripts/bootstrap.sh`: creates the private, encrypted, versioned bucket
   `comdove-fake-server-<account>-ap-south-1` for Terraform state, builds, and runtime backups.
   It is **never** destroyed by `down.sh`.
3. `infra/scripts/secrets.sh`: stores the secrets in Parameter Store (next section).
4. Optional: `cp infra/seed.example.json infra/seed.json` and edit it. `up.sh` registers
   those business numbers and groups after every start.

## Secrets (Parameter Store `/comdove-fake/*`, never in git)

| Name | Type | Must match / meaning |
|---|---|---|
| `APP_SECRET` | SecureString | ComDove backend's **`META_APP_SECRET`** (HMAC of the webhooks) |
| `WEBHOOK_VERIFY_TOKEN` | SecureString | ComDove backend's **`WHATSAPP_VERIFY_TOKEN`** (hub.challenge handshake) |
| `COMDOVE_WEBHOOK_URL` | String | Public URL of that ComDove backend + `/webhooks/whatsapp` |
| `UI_USER` / `UI_PASSWORD` | String / SecureString | Login for the UI, `/api`, `/ws` and `/docs` (the backend itself has no auth) |

Change one at any time with `secrets.sh`, then `down.sh` + `up.sh` (settings are read at boot).
**DB:** there is no database server. Data lives in an SQLite file on the instance
(`/var/lib/comdove-fake/mock.sqlite`), backed up to the bucket every 10 minutes and at shutdown,
and restored on the next `up` (turn this off with `-var persist_data=false`).

## Start / stop

```bash
aws login --region ap-south-1
infra/scripts/up.sh      # ~3–5 min: build, apply, wait for HTTPS, seed
# … test …
infra/scripts/down.sh    # removes the instance, security group, IAM role, DNS record
```

`up.sh` prints the URLs:
- **Phones**: `https://testserver.stacx24.com/client`
- **Admin**: `https://testserver.stacx24.com/admin`
- **API docs**: `https://testserver.stacx24.com/docs`

## Point ComDove at it

In the ComDove backend that should use the fake server (never production):

```env
META_GRAPH_API_BASE_URL=https://testserver.stacx24.com
META_APP_SECRET=<same as APP_SECRET>
WHATSAPP_VERIFY_TOKEN=<same as WEBHOOK_VERIFY_TOKEN>
```

Restart that ComDove. Its database must contain the fake business numbers
(`WabaAccount.wabaId` = `waba_id`, `WabaPhoneNumber.phoneNumberId` = `phone_number_id`,
decrypted access token = `token`). Keep `seed.json` and ComDove in sync.

## On / off

- **Off = EC2 "stop"**: the instance and its public IP cost nothing while stopped. The 4 GB disk
  (with the data and certificate) is kept, for about $0.36/month.
- **Turn OFF now:** open **`/power`**, flip the switch, and confirm. It's off about 20 s later. A final backup to S3
  runs during shutdown. `infra/scripts/stop.sh` does the same from a terminal.
- **Auto-off:** it turns itself off after **`idle_minutes`** (default **5**) with no HTTPS requests
  and no open browser connection. It never turns off in the first `idle_minutes + 5` minutes after a start.
  Change it with `-var idle_minutes=…` on `up.sh` (at least 3; `0` = never).
- **Turn ON:** `infra/scripts/start.sh`. It's ready in about **25 s**. Each start gets a **new public IP**, and the
  server points `testserver.stacx24.com` at it by itself, only that one A record.
- **It cannot start itself when a message arrives.** While it's off nothing answers at the address,
  so start it before sending. An open browser tab keeps it on, so close the tabs when you're done.

## Cost (approx., ap-south-1; check the AWS price list)

AWS Price List API, ap-south-1 on-demand:

| Item | Price | Running | Stopped | After `down.sh` |
|---|---|---|---|---|
| t4g.nano | $0.0028 / h | ✔ | — | — |
| Public IPv4 | $0.005 / h | ✔ | — (released) | — |
| 4 GB gp3 disk | $0.0912 / GB-month | ✔ | ✔ $0.36/month | — |
| S3 bucket (~1 MB) | $0.025 / GB-month | ✔ | ✔ | ✔ (≈ $0) |
| **Total** | | **≈ $0.0083 / h** | **≈ $0.36 / month** | **≈ $0** |

- There's no Elastic IP.
- CPU credits are `standard`, so there's never a burst surcharge. The trade-off is that the CPU is throttled
  to its 5 % baseline when credits are empty. So the **very first boot** after `up.sh` (package
  installs) takes about 10 minutes; later `start.sh` boots take about 25 s.

## What Terraform creates (all tagged `Project=comdove-fake-server`)

**`infra/bootstrap`**: 1 S3 bucket (private, AES-256, versioned, lifecycle rules).

**`infra/server`**:
- 1 EC2 `t4g.nano`: Amazon Linux 2023 **minimal** image (the only one that allows a 4 GB disk; the AWS CLI and SSM agent are installed at first boot), a **4 GB** encrypted gp3 disk, IMDSv2, and shutdown behaviour set to **stop**
- 1 security group: 80/443 in, **no SSH**
- 1 IAM role + instance profile: read `/comdove-fake/*`, read builds, read/write `runtime/*`, UPSERT **only** the `testserver` A record, plus SSM Session Manager
- 1 Route 53 **A** record: `testserver.stacx24.com`, TTL 60

**Only read, never changed:** the `stacx24.com` hosted zone and the default VPC.

## Troubleshooting

| Symptom | Check |
|---|---|
| `up.sh` waits a long time | First boot installs Node + Caddy and gets a certificate, which takes 2–4 min. For a shell on the server: `aws ssm start-session --target <instance_id>` (needs the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)), then `sudo tail -f /var/log/comdove-fake-setup.log` |
| Service logs | `sudo journalctl -u comdove-fake -u caddy -n 100` |
| ComDove calls fail with 401/190 | The token in the fake server's business number ≠ ComDove's decrypted WABA token |
| Webhooks rejected by ComDove (401) | `APP_SECRET` ≠ ComDove `META_APP_SECRET` |
| Handshake fails | `WEBHOOK_VERIFY_TOKEN` ≠ ComDove `WHATSAPP_VERIFY_TOKEN`, or `COMDOVE_WEBHOOK_URL` isn't reachable from the internet |
| Template/campaign sends fail | Expected: the fake server supports **text** messages only |
| Certificate errors after many up/downs | The certificate is reused from the bucket (`runtime/caddy/`). Let's Encrypt allows 5 new ones per week per name |

## Security notes

- The fake backend's control API and WebSocket have no auth by design. **Caddy's login protects them.**
- The Meta routes (`/v…/`) are open, like real Meta. They check the Bearer token of a registered number.
- No SSH port and no key pair. Shell access is through SSM only.
- Secrets live in Parameter Store and are written to the instance's `.env` (mode 600) at boot.
- Terraform state is in the private bucket, and `infra/.gitignore` blocks `*.tfstate`, `*.tfvars`, `seed.json` and `.build/`.
