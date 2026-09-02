# Third-party notices

Open Fitness source code is licensed separately under AGPL-3.0-or-later. The
runtime dependencies below retain their own licenses. Exact resolved versions
and transitive packages are recorded in `package-lock.json`; `npm ci` installs
each package together with its package metadata and license files.

| Direct runtime dependency | Version | License |
| --- | ---: | --- |
| `@libsql/client` | 0.17.4 | MIT |
| `@phosphor-icons/react` | 2.1.10 | MIT |
| `drizzle-orm` | 0.45.2 | Apache-2.0 |
| `next` | 16.3.0 | MIT |
| `react` | 19.2.6 | MIT |
| `react-dom` | 19.2.6 | MIT |

The Web UI embeds Geist Sans and Geist Mono font files shipped with the pinned
Next.js runtime. Geist is copyright (c) 2023 Vercel, in collaboration with
basement.studio, and is licensed under the SIL Open Font License 1.1. The full
font notice and license are preserved in
[`LICENSES/Geist-OFL-1.1.txt`](LICENSES/Geist-OFL-1.1.txt).

The `public/` Open Fitness marks and icons are first-party assets unless a file
says otherwise.

The public beta supports source installation from the Git repository. It does
not publish an npm package or a prebuilt standalone binary. Any future binary or
container distribution must preserve the corresponding dependency licenses and
produce a notice or SBOM for the exact shipped artifact.
