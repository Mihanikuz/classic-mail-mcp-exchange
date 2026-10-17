# Configuration reference

Secrets are read from **one** source: `APP_CONFIG_FILE` (recommended for Docker) or `APP_CONFIG_JSON` (Secret Manager injection on Cloud Run). Never put actual credentials into examples, shell command arguments, Git or an image.

## Runtime environment

| Variable             | Default                          | Purpose                                                                |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| TRANSPORT            | http                             | `http` or `stdio`                                                      |
| AUTH_MODE            | bearer for HTTP; stdio for stdio | `bearer`, `oauth`, `stdio`; HTTP never permits anonymous tools         |
| ACCESS_MODE          | read-only                        | `read-only` = 6 tools; `read-write` = 21                               |
| BASE_URL             | http://127.0.0.1:8080            | Exact origin, no trailing slash/path. OAuth requires HTTPS.            |
| HOST                 | 127.0.0.1                        | Direct Node binding; Docker sets 0.0.0.0 internally                    |
| PORT                 | 8080                             | Public HTTP port; the internal loopback gateway uses PORT+1            |
| STORAGE              | sqlite                           | `sqlite` or `firestore`                                                |
| SQLITE_PATH          | data/classic-mail.sqlite         | Persist this file and its WAL/SHM files; Docker uses /data/mail.sqlite |
| GOOGLE_CLOUD_PROJECT | unset                            | Required for your Firestore deployment                                 |
| FIRESTORE_DATABASE   | classic-mail-mcp                 | Named Firestore database                                               |

Cloud Run rejects SQLite configuration because its filesystem is ephemeral.

## Local secret JSON

The wizard generates this structure with random values:

```json
{
  "encryptionKey": "GENERATE_AN_INDEPENDENT_RANDOM_KEY_AT_LEAST_43_CHARACTERS",
  "bearerToken": "GENERATE_A_DIFFERENT_RANDOM_TOKEN_AT_LEAST_43_CHARACTERS",
  "accounts": [
    {
      "id": "personal",
      "email": "you@example.com",
      "username": "you@example.com",
      "password": "YOUR_MAILBOX_OR_APP_PASSWORD",
      "imapHost": "imap.example.com",
      "imapPort": 993,
      "smtpHost": "smtp.example.com",
      "smtpPort": 465,
      "appendSent": true
    }
  ]
}
```

Placeholders are documentation, not credentials. Use the wizard to generate real random keys. `bearerToken` is required only in bearer mode.

## OAuth secret JSON

Instead of `bearerToken`, add `googleClientId`, `googleClientSecret`, `allowedEmails` (exactly one Google sign-in address), `jwtSigningKey` and `consentSigningKey`. Keep `accounts` and `encryptionKey`. Generate all three keys independently. The wizard's `--mode oauth` produces this form.

Google scopes `openid email` identify the owner; they do not restrict mail tool permissions. `ACCESS_MODE` controls tool registration.

## Account fields

Required: `id`, `email`, `username`, `password`, `imapHost`, `smtpHost`.

Optional:

- `name`: display name.
- `imapPort`: 993 (implicit TLS, default) or 143 (mandatory STARTTLS).
- `smtpPort`: 465 (implicit TLS, default) or 587 (mandatory STARTTLS).
- `smtpUsername` and `smtpPassword`: both together, to override SMTP credentials.
- `allowedFolders`: nonempty exact-match list, such as `["INBOX", "Sent"]`. Omit for all folders. Folder creation also respects this allowlist.
- `sentFolder`, `draftsFolder`, `trashFolder`, `archiveFolder`: explicit names when the provider does not advertise the corresponding SPECIAL-USE folders.
- `appendSent`: true by default. Disable if the SMTP provider already stores sent messages, to avoid duplicate Sent copies.

One to ten accounts, unique IDs. Login username need not equal the From email, but your provider must permit that sender address. Hosts must be operator-configured DNS hostnames, with valid certificates. Arbitrary tool-provided URLs, insecure TLS bypasses, plaintext connections and custom ports are not supported.

## Backups and rotation

Stop the local server before copying the entire data directory, including WAL files, or use a proper SQLite backup tool. Back up the private config separately with encryption and restricted access. Never discard the send ledger casually: lost history makes old idempotency keys unsafe to reuse.

For OAuth, rotate signing/encryption/consent keys together and clear only the `oauth` state collection/table to force fresh connections. Preserve `sends`. Encryption-key changes also change payload hashes: use new keys only for new messages; treat historical uncertain sends manually. Update mailbox/app passwords or the bearer token in the private config and restart. On Cloud Run, publish a new secret version and pin a new revision to it.
