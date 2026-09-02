# Security policy

Open Fitness stores sensitive fitness and nutrition records. Do not include a
real database, export, token, password hash, private certificate, or identifiable
screenshot in a public issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:

<https://github.com/EddieTYP/open-fitness/security/advisories/new>

Include the affected revision, deployment shape, reproduction steps using
disposable data, and the expected impact. If private reporting is unavailable,
open a public issue containing no vulnerability details or personal data and
ask the maintainer to establish a private channel.

Please allow reasonable time for triage and a coordinated fix before public
disclosure. This project does not offer a bug bounty.

## Supported versions

Until the first stable release, security fixes target the latest public-beta
revision on the default branch. Operators should keep a verified backup and
upgrade to the newest supported revision rather than relying on an older beta.

## Deployment boundary

The supported self-hosted runtime binds to loopback and is intended for one
owner behind private HTTPS or a trusted VPN. Direct Internet exposure,
multi-user tenancy, and third-party agent authorization are outside the current
security model.

## Owner login boundary

New owner password hashes require 12 to 1024 Unicode characters. Verification
continues to accept a pre-upgrade hash made from a shorter password solely to
avoid locking out an existing owner; operators should rotate such a password
and hash promptly. Password-hash rotation also invalidates existing sessions.

Failed-login throttling is deliberately in memory for the supported
single-process runtime. Five admitted failures in a rolling 15-minute window
block later attempts until the returned `Retry-After` interval expires, and a
successful login clears the client's state. At most 256 failure states are
retained; additional client addresses share an overflow bucket. Restarting the
process resets the limiter, and separate processes do not share it, so this is
not a control for direct Internet exposure or a multi-replica deployment.

An operator-supplied trusted proxy must remove client-supplied forwarding
headers before setting one `X-Forwarded-For` address, matching
`X-Forwarded-Host`/`Host`, and `X-Forwarded-Proto: https`. The app accepts a
per-client key only for that shape and collapses missing, chained, or malformed
forwarding data into one direct-client bucket. The login path hashes the
accepted address for its transient map key and does not log either addresses or
passwords.
