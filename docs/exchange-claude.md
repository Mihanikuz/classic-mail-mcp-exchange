# Exchange (EWS) and claude.ai: deployment

[Русская версия](exchange-claude.ru.md)

This fork adds two things to [kapitelh/classic-mail-mcp](https://github.com/kapitelh/classic-mail-mcp):

1. **claude.ai custom connector support** (web, Desktop and mobile) through OAuth with Google sign-in.
2. **A read-only Microsoft Exchange (EWS) backend** for mailboxes where IMAP is disabled or blocked from outside but Outlook works (Exchange Web Services over HTTPS).

Everything else — security model, setup wizard, run modes — is as in the original project. General guides: [deployment.md](deployment.md), [security.md](security.md).

## Changes compared to the original

| File                | Change                                                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/auth.ts`       | `https://claude.ai/api/mcp/auth_callback` added to the allowed OAuth redirect URIs. The `resource` parameter is accepted both as `BASE_URL` and as `BASE_URL/mcp`, as MCP clients send it.                                         |
| `src/server.ts`     | `https://claude.ai` origin allowed. `https://accounts.google.com` added to the CSP `form-action`, otherwise Chrome blocks the redirect to Google after **Approve** on the consent page. Mail backend selected with `MAIL_BACKEND`. |
| `src/ews.ts`        | New EWS backend: folders, search, read, attachments, connection check. It contains no write operations.                                                                                                                            |
| `compose.yaml`      | `tmpfs` syntax fixed (recent Docker Compose failed with `invalid mount path: 'mode=1777'`); `MAIL_BACKEND` passed to the container.                                                                                                |
| `tests/ews.test.ts` | EWS tests on synthetic Exchange responses, including paging over mixed item types.                                                                                                                                                 |

## EWS backend

- Active only with `MAIL_BACKEND=ews` **and** `ACCESS_MODE=read-only`. In `read-write` mode the original IMAP/SMTP backend is always used, so writes through EWS are impossible.
- The EWS endpoint is derived from the account's `imapHost`: `https://<imapHost>/EWS/Exchange.asmx`. The server certificate is validated and redirects are refused.
- Basic authentication with the configured username and password. The setup wizard still asks for SMTP settings: enter the same host; they are not used.
- Reading does not mark messages as read (`GetItem` does not change `IsRead`). Text and attachments are extracted from the message MIME content with the same parser and limits as the IMAP backend: 8 MiB per message, 4 MiB per attachment.
- Folders are addressed by the path returned by `list_folders` (`Inbox/Project`) or as `INBOX`. In search results `nextBeforeUid` is the offset of the next page.
- Date, unread, subject and text filters are evaluated by Exchange. Sender and recipient filters are applied to the results (up to 1,000 messages scanned per call).
- Exchange Online / Microsoft 365 tenants that require modern authentication (OAuth) for EWS are not supported.

You can check that EWS is reachable before installing. A `401` response to an unauthenticated request means the service exists:

```sh
curl -s -o /dev/null -w "%{http_code}\n" https://mail.example.com/EWS/Exchange.asmx
```

## Installation

You need a Linux server with Docker, a domain with HTTPS on **port 443** (claude.ai does not connect to custom ports) and a Google account for sign-in.

### 1. Google OAuth client

In Google Cloud Console → Google Auth Platform:

- Create a **Web application** client.
- Redirect URI: `https://mcp.example.com/oauth/callback`.
- If the app is in testing mode, add your Google account as a test user.
- Never share the client secret: it is entered only into the setup wizard on the server.

### 2. Configuration

```sh
git clone https://github.com/Mihanikuz/classic-mail-mcp-exchange.git /opt/classic-mail-mcp
cd /opt/classic-mail-mcp
python3 scripts/setup.py --mode oauth
```

Wizard answers for Exchange: IMAP hostname — the Exchange mail host (the one serving `/EWS/Exchange.asmx`), port 993; SMTP — the same host, port 465.

Then `.env`:

```sh
cat >> .env <<'EOF'
BASE_URL=https://mcp.example.com
MAIL_BACKEND=ews
EOF
# Do not run the container as root
sed -i 's/^LOCAL_UID=0/LOCAL_UID=1000/; s/^LOCAL_GID=0/LOCAL_GID=1000/' .env
chown -R 1000:1000 .secrets .data
docker compose up --build -d
```

Check:

```sh
curl -s http://127.0.0.1:8080/status          # "accessMode":"read-only"
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8080/mcp   # 401
```

### 3. HTTPS on port 443

If port 443 is free, Caddy is the simplest option:

```caddyfile
mcp.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

#### If port 443 is taken by a Telegram proxy (MTProto with masking)

An MTProto proxy with masking (`mask = true`) forwards everything that does not look like Telegram to a "masking" nginx (usually `127.0.0.1:8443`). You can add a second site to that nginx, selected by domain name (SNI). The masking site stays the default, and the proxy keeps working.

1. Caddy obtains the certificate on a free port (HTTP-01 challenge on port 80; TLS-ALPN is disabled because 443 is taken):

   ```caddyfile
   mcp.example.com:9443 {
       tls {
           issuer acme {
               disable_tlsalpn_challenge
           }
       }
       reverse_proxy 127.0.0.1:8080
   }
   ```

2. The nginx site. The file name starts with `zz-` so that it does not become the default site:

   ```nginx
   # /etc/nginx/sites-available/zz-mail-mcp
   server {
       listen 127.0.0.1:8443 ssl;
       server_name mcp.example.com;
       ssl_certificate     /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mcp.example.com/mcp.example.com.crt;
       ssl_certificate_key /var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mcp.example.com/mcp.example.com.key;
       ssl_protocols TLSv1.2 TLSv1.3;
       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Forwarded-Proto https;
           proxy_buffering off;
           proxy_read_timeout 180s;
           proxy_send_timeout 180s;
       }
   }
   ```

   ```sh
   ln -s /etc/nginx/sites-available/zz-mail-mcp /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   # nginx reads the certificate only on reload; Caddy renews it automatically
   echo '0 4 * * 1 root systemctl reload nginx' > /etc/cron.d/reload-nginx-cert
   ```

3. Check that masking still works:

   ```sh
   curl -sk --resolve <mask-domain>:443:127.0.0.1 https://<mask-domain>/ | head -c 150
   ```

### 4. claude.ai connector

Settings → Connectors → **Add custom connector** → URL `https://mcp.example.com/mcp`. Leave client ID and secret empty: the server supports dynamic client registration. Then **Connect** → the server's consent page → **Approve** → sign in with the Google account configured in the wizard.

## Troubleshooting

| Symptom                                                                                    | Cause and fix                                                                       |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `invalid mount path: 'mode=1777'` on `docker compose up`                                   | Old `compose.yaml`; fixed in this fork.                                             |
| Caddy: `listen tcp :8443: bind: address already in use`                                    | The port is used by the MTProto proxy's masking nginx; pick another port for Caddy. |
| claude.ai: "Couldn't reach this address", no requests from `160.79.104.0/21` in the logs   | Custom port or a firewall. Port 443 is required.                                    |
| **Approve** on the consent page does nothing                                               | Old CSP `form-action 'self'`; fixed in this fork.                                   |
| Google: `redirect_uri_mismatch`                                                            | The redirect URI in Google must match `BASE_URL/oauth/callback` exactly.            |
| Every tool returns "Mail operation failed" and port 993 on the mail server does not answer | IMAP is closed and the mailbox is on Exchange. Set `MAIL_BACKEND=ews`.              |

## Security

- The mailbox password is stored on the server in `.secrets/config.json` (mode 600). Protect the server itself: SSH with keys only, password login disabled.
- Anyone who can sign in to the allowlisted Google account, or to a claude.ai account with this connector, can read the mail. Enable two-factor authentication on both.
- For a work mailbox, make sure your organization's security policy allows such a connection first.
- The EWS backend and claude.ai changes are covered by tests but have not had an independent security audit.
