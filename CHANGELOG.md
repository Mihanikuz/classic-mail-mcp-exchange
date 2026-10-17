# Changelog

## 2.0.0 — public preview

- General operator-configured IMAP and SMTP hosts, including mandatory STARTTLS.
- Local Docker/stdio and bearer HTTP modes, without a Google Cloud dependency at runtime.
- SQLite persistence for OAuth state, rate limits and send idempotency; Firestore for Cloud Run.
- Read-only default with six tools; explicit opt-in to all 21 mail tools.
- Google OAuth with browser/redirect/PKCE binding and separate access/refresh token-purpose records.
- Hidden-input configuration wizard, hardened Compose service, service landing page and English/German documentation.
- CI tests, Docker smoke checks and public-source checks.

This release begins a clean public source history. Private configurations and deployment artifacts are not included.
