# Contributing

Bug reports, provider compatibility reports, accessibility improvements and focused pull requests are welcome.

1. Use Node.js 24, Python 3, OpenSSL and Docker.
2. Run `npm ci` and `npm run check`.
3. For transport/storage changes, run `docker build -t classic-mail-mcp:local .` and `node scripts/docker-smoke.mjs`.
4. Keep fixtures synthetic, using example.com addresses. Never include live account data, OAuth clients, cloud project IDs, generated credentials or private deployment history.
5. Explain the trigger, resulting behavior and verification in the PR. Add tests for security boundaries and regressions rather than implementation trivia.

Do not weaken TLS verification, PKCE, callback validation, read-only restrictions, send deduplication or error redaction to make a provider work. Discuss incompatible provider requirements in an issue.

For a new provider report, include only hostnames, ports, authentication type, SPECIAL-USE/MOVE/UIDPLUS support and sanitized behavior. Do not claim compatibility solely because connection verification succeeds: read, draft, send and folder behavior may differ.

By submitting a contribution, you agree that it can be distributed under the project's MIT license. Please be respectful and keep discussion focused on helping users.
