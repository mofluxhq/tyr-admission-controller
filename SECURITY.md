# Security policy

## Reporting a vulnerability

Please report vulnerabilities through this repository's private GitHub
security-advisory workflow (**Security → Report a vulnerability**) instead of
opening a public issue. Include the affected component, reproduction steps,
impact, and any suggested mitigation. Do not include live provider keys, agent
tokens, or other credentials in the report.

## Scope

This repository covers the Tyr data plane: request admission, forwarding to
model providers, telemetry, replica routing, and the Latchflo managed-mode
agent. Issues that exist only in a Latchflo control-plane deployment should be
reported through the same workflow and will be routed accordingly.

Tyr forwards requests to the provider endpoints in its configuration using the
credentials callers supply. Treat its configuration, persisted agent
credentials, and routing secret as sensitive.

## Supported versions

Security fixes are applied to the latest released version. Tyr is pre-1.0, so
upgrading may include documented breaking changes.
