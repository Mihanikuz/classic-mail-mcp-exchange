# Deployment

Deploy one instance per operator. Your mail credentials, OAuth keys and storage belong to your installation. Remote clients need a reachable HTTPS endpoint; localhost is not reachable from ChatGPT's servers.

## A persistent Docker host

1. Point a domain at your host and configure a reverse proxy with a trusted TLS certificate.
2. Forward HTTPS traffic to the Compose service on `127.0.0.1:8080`. Do not expose the internal port 8081.
3. Create a Google OAuth **Web application** client. Its exact authorized redirect URI is `https://YOUR-DOMAIN/oauth/callback`.
4. Run `python3 scripts/setup.py --mode oauth` on a fresh installation.
5. Set `AUTH_MODE=oauth` and `BASE_URL=https://YOUR-DOMAIN` in `.env`.
6. Run `docker compose up --build -d`. Keep `.data` on persistent local disk and back it up securely.
7. Connect to `https://YOUR-DOMAIN/mcp`, sign in and perform the verification checklist below.

Example Caddy configuration:

```caddyfile
mail-agent.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Do not cache OAuth/MCP responses or strip cookies, Authorization or WWW-Authenticate headers. Set proxy timeouts to at least 130 seconds. The server uses stateless Streamable HTTP JSON responses.

## Google Cloud Run

Requires a billed project, Google Cloud CLI, Node.js 24 and permission to create service accounts, assign IAM roles, enable APIs, deploy Cloud Run, manage secrets and create a Firestore database.

Source builds need their own build service account permissions. Follow Google's [source deployment prerequisites](https://docs.cloud.google.com/run/docs/deploying-source-code), including the Cloud Run Builder role for the actual build account. The script does not grant broad Owner/Editor roles. Organization policies may prohibit public ingress or resource creation; resolve these with your administrator.

### 1. Bootstrap the locked service

Run from the cloned repository:

```sh
npm ci
npm run build
export PROJECT_ID="your-project-id"
export REGION="europe-west1"
bash scripts/deploy-cloud-run.sh bootstrap
```

The script creates a dedicated runtime service account, a named Firestore database, TTL policies for expired OAuth/rate-limit documents and a Cloud Run service with mail access locked. It refuses to bootstrap over an existing service.

By default resources are named `classic-mail-mcp`. Set `SERVICE` and `DATABASE` consistently on every invocation if you need different names. Choose a supported Firestore/Cloud Run region deliberately; moving a database is not a simple config change.

The runtime gets Firestore access constrained to the selected database using an [IAM resource condition](https://cloud.google.com/firestore/docs/manage-databases). Firestore server libraries use IAM; Firebase client security rules do not protect this service.

### 2. Create your Google OAuth web client

In your own project's Google Auth Platform:

- Configure branding, audience and contact information. For a personal test, add your intended Google sign-in account as a test user when required.
- Create a **Web application** OAuth client.
- Add exactly `SERVICE_URL/oauth/callback` as an authorized redirect URI, using the HTTPS service origin printed by bootstrap.
- Keep the client secret private. Do not paste it into ChatGPT, GitHub issues or your MCP client's bearer field.
- The proxy requests `openid email` only. Provider review/testing policies may affect sign-in and refresh-token lifetime.

Run:

```sh
python3 scripts/setup.py --mode oauth
```

Enter one allowed Google sign-in email. This may differ from your IMAP mailbox addresses. It will control **all configured mailboxes**.

### 3. Configure and deploy

```sh
bash scripts/deploy-cloud-run.sh configure .secrets/config.json
```

This validates the configuration, uploads it directly from the file to Secret Manager, grants the runtime access to that one secret and pins the deployment to its new version. Cloud Run's public invoker is enabled so OAuth discovery and sign-in can work; the application still requires authentication for every mail tool.

To enable writes on a later deployment:

```sh
ACCESS_MODE=read-write bash scripts/deploy-cloud-run.sh configure .secrets/config.json
```

Each configure run creates a new secret version and source deployment. Firestore is mandatory because instances can scale and restart. Send history has no automatic TTL; removing it can permit duplicate submissions.

### 4. Verify the installation

- `GET /status` responds and reports the expected access mode.
- `POST /mcp` without credentials returns 401.
- Your MCP client completes OAuth with the allowlisted Google account.
- Tool discovery returns 6 read tools or 21 tools in read-write mode.
- `list_accounts` returns only your configured accounts.
- `check_connection` succeeds for each account without sending.
- `search_messages` and `read_message` retrieve a real message without marking it read.
- If you enable sending, explicitly send one test message to an address you control and verify recipient receipt. SMTP acceptance alone is not proof of delivery.

The repository tests cover local execution, synthetic OAuth and simulated mail protocols. They do not prove a fresh cloud project's IAM, billing, provider login or end-user OAuth session. Always perform these checks.

## Operations

Application logs intentionally omit mail bodies, passwords and tokens. Cloud HTTP access logs can still contain request URLs, including short-lived OAuth callback codes. Restrict log access and retention. The callback code also requires the bound browser transaction and PKCE verifier; do not publish those logs.

Monitor errors, latency, memory, Cloud Run/Firestore/Secret Manager costs and rate-limit behavior. OAuth registration is globally limited to 20/hour and authorization to 100/hour per instance storage. Owner MCP requests are limited to 120/minute; sends to 30/hour. These are fixed windows, not a full DDoS protection system.

A rollback uses an earlier Cloud Run revision and its pinned secret version. Keep secrets and database state compatible. Never roll back by restoring stale send history over newer accepted sends. Deleting a service does not automatically delete its secrets, database or build images; review and remove these separately when retiring an installation.
