# Security policy

Urma is intended for **one trusted local user**. It assumes a trusted operating
system, Node.js, FFmpeg, ffprobe, and yt-dlp. It provides application-level file,
network, and execution controls, not an operating-system sandbox or multi-user
isolation. Your MCP client controls where returned evidence is processed,
including whether it is sent to a model service.

## Report a vulnerability

Report suspected vulnerabilities through GitHub's private
[Report a vulnerability form](https://github.com/sajidurdev/urma/security/advisories/new).
Do not include exploit details, private media, credentials, or sensitive logs in
a public issue. If the private form is unavailable, open an issue asking for a
private contact method without disclosing the vulnerability.

Include affected Urma, Node.js, OS, and MCP client versions; reproduction steps
or a minimal proof of concept; expected and actual behavior; and the likely
impact. Remove secrets and personal paths. Coordinate public disclosure with
the maintainers. For ordinary installation or provider failures, use the
[bug-report template](https://github.com/sajidurdev/urma/issues/new?template=bug-report.md).

Use [GitHub Releases](https://github.com/sajidurdev/urma/releases) to identify
published versions and available fixes. A development checkout is not a
published or qualified release; this policy does not promise a response time
or backports to older versions.

## Trust boundaries

### Local files and storage

Local input is disabled until `URMA_LOCAL_ROOTS` is configured. Videos and caption
sidecars must be regular files within allowed roots. Urma resolves symlinks and
junctions and checks their final locations. Selected local video and caption
bytes are pinned to the snapshot. Public source references omit canonical paths.

UNC source inputs additionally require `URMA_ALLOW_UNC=1` or `true`. Installation
and persistent storage must remain on a user-owned local filesystem. On macOS
and Linux, setup checks ownership of the directory or nearest existing parent.
Mapped drives and mount points can hide network storage; Urma does not detect
all such arrangements. See [configuration](../README.md#configuration).

### Remote requests

Remote sources and subresources must use HTTP or HTTPS on the default port,
without embedded credentials. Urma rejects non-public hosts and addresses,
including private, loopback, link-local, metadata, multicast, and reserved ranges.
It validates every DNS result and connects directly to a selected validated
address through a loopback proxy. HTTPS uses CONNECT without terminating TLS.

Redirects, media URLs, manifests, fragments, captions, and storyboards use the
same checks. A previously accepted hostname does not authorize a later address.
Provider delivery URLs are temporary acquisition data and are omitted from
public source and artifact records. Only [supported finite sources](../README.md#supported-sources-and-limitations)
are admitted.

These are application-level server-side request forgery controls. A compromised
trusted executable can bypass the proxy or make independent connections.
Stronger isolation requires operating-system or infrastructure controls.

### Installation and native tools

Setup checks archive hashes and rejects traversal paths, unsafe or duplicate
names, case collisions, and symlink escapes during extraction. It stages each
installation separately, validates a receipt and native tools, and runs an MCP
smoke test before activation. An installation lock and atomic selector replacement
protect selection; updates do not overwrite running generations.

The launcher validates the selected generation, receipt, platform, Node runtime,
and state compatibility. Native tools are checked against receipt hashes before
first use in a process; failures do not fall back to executables on `PATH`.
Rollback and recovery retain integrity and compatibility checks.

Native tools use argument arrays without a shell, hidden Windows child windows,
and an allowlisted environment. yt-dlp disables ambient configuration, plugins,
cookies, external execution, remote components, updates, playlist expansion,
and uncontrolled retries or concurrency. Children do not inherit arbitrary
credentials, browser profiles, proxy settings, or runtime hooks.

Remote FFmpeg/ffprobe inputs use the validated proxy and a restricted protocol
list. Local inputs use a read-only file descriptor with an `fd`-only protocol
list, preventing nested local-manifest file or network references through those
wrappers. Embedded subtitle extraction reads only the selected supported text
stream from pinned video bytes; it does not decode audio or video.

### Limits and cached evidence

Acquisition bounds downloads, output, time, and subprocess work. Analysis also
bounds jobs, input pixels, native allocations, and result payloads. Exceeding
limits fails the operation and requests process-tree cleanup; cleanup errors
distinguish confirmed termination from an unconfirmed fallback. These limits
are not a total process-memory quota or a sandbox for a compromised tool.

Cached media is validated before use. Artifact writes use temporary files and
atomic promotion; reads check paths, sizes, and hashes. Invalid resources fail
to read instead of triggering reacquisition. Artifacts can be read only after
being returned to that investigation; a guessed hash or another investigation's
cache access grants no authorization. This tracks evidence, not user identities.

### MCP content and diagnostics

Captions, metadata, and images are **untrusted source content**. Integrations
must keep them separate from instructions passed to a model. Network checks
do not establish truthfulness or make content appropriate to display. Sparse
samples, caption misses, and image similarity have the [evidence limitations](../docs/TOOLS.md#resources-and-evidence-semantics)
described in the tool reference.

Model-facing errors contain normalized codes and redacted details. Raw resolver
metadata and transport fields are omitted from public projections. Diagnostics
can still contain sensitive operational data: protect debug files, review logs
before sharing, and remove credentials, private URLs, and personal paths.
