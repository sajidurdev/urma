---
name: RC bug report
about: Report an installation, MCP-host, or source/provider problem during RC testing
title: "[RC] "
labels: ""
assignees: ""
---

Fill in the fields that apply. Remove credentials, private URLs, and personal
paths from logs before posting.

## Environment

- OS version and architecture:
- Node.js version:
- MCP host and version:
- Installed Urma version (or package version requested if setup failed):
- Source type/provider (local file, YouTube, or another HTTP(S) source):

## Steps to reproduce

Include the setup command or MCP tool name and arguments that failed. For a
source-specific issue, include a public video URL or describe a small local
video that reproduces it.

1. <!-- First step -->
2. <!-- Next step -->
3. <!-- Step that triggers the problem -->

## Diagnostics

If installation completed, run `doctor` through the installed launcher as
shown in the [README](https://github.com/sajidurdev/urma#cli-and-maintenance).
Use the same data root and local-root settings as the MCP host. If setup or
the launcher fails, include that error below instead.

```text

```

## Behavior

- Expected:
- Actual:

## Error or log

Include the error code and relevant output as text. Note whether the failure
happens every time or intermittently.

```text

```
