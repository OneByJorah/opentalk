# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository.

Include steps to reproduce and the impact. You'll get a reply within 7 days. Once a fix ships, you'll be credited in the release notes (unless you'd rather not be).

## Supported versions

Only the latest release on `main` gets security fixes.

## Scope

In scope: XSS, bypassing rate limits, bans or room locks, guessing or leaking private room codes, server crashes or DoS from a single client, and container escape.

Out of scope: volumetric DDoS (use Cloudflare or similar), and content posted by users (that's moderation).
