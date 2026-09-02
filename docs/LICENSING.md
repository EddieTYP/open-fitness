# Licensing model

This page is a practical project summary. The full [LICENSE](../LICENSE) text
controls, and legal advice should come from a qualified professional.

## Core application

Unless a file says otherwise, original code, documentation, scripts, workflows,
integrations, tests, and first-party UI assets in this repository are offered
under `AGPL-3.0-or-later`. The copyright notice is in [NOTICE](../NOTICE).

The AGPL permits use, study, modification, and redistribution under its terms.
It is intentionally suitable for a web application where modified network
deployments should keep corresponding source available to their users.

## Commercial licensing

The copyright holder may separately make a commercial license available to an
organization that needs proprietary modification, distribution, or hosted-use
terms outside the AGPL. A commercial license is an alternative grant; it does
not remove the AGPL option already offered for the open-source code.

## What is not relicensed

The application license does not claim ownership of an owner's health records,
imports, photos, or agent-authored content. Material expressly identified as
third-party or separately licensed retains its own license and attribution.
Releases must preserve those notices where their terms require it.

## External contributions

Dual licensing is straightforward while one copyright holder owns all core
code. Accepting an outside contribution under AGPL alone does not automatically
give the maintainer permission to offer that contribution under a separate
commercial license.

Before accepting substantive external code contributions, choose and publish a
contribution policy:

1. use AGPL-only inbound contributions and accept that commercial relicensing
   will need each relevant contributor's permission; or
2. use a clear contributor agreement that grants the rights needed for the
   stated dual-license model.

Until that policy is published, substantive external code contributions are
closed. Issues and design discussion remain welcome under
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Public-release checklist

- Keep unmodified `LICENSE` and `NOTICE` files at the repository root.
- Keep the SPDX identifier in package metadata.
- Keep the visible Source and license entry in the interactive application.
- Publish from a reviewed, immutable release tag with a clean source tree and
  green CI; do not direct owners to a floating branch.
- Make corresponding source and build/install instructions available alongside
  distributed releases.
- Verify the origin and license of migrated code, icons, fonts, fixture data,
  and other bundled assets.
- Review the contribution policy before enabling routine external pull requests.
- Enable and verify GitHub private vulnerability reporting before publication.

The public beta is distributed as Git source, not as an npm package, container,
or prebuilt standalone binary. Direct runtime and embedded-font attributions are
recorded in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). A future binary
distribution must generate an exact-artifact notice or SBOM and preserve every
required license before publication.
