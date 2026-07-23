# Upstream provenance

This package is an internal fork derived from
[`@jacobboykin/amazing-marvin-client` v1.1.1](https://github.com/jacobboykin/amazing-marvin-client-js/tree/1f04630374c5ec9c3ff08e847dad96e8ad62fae9),
used under its MIT license.

The fork retains the limited-token endpoint models and client patterns that
are relevant to this repository. It intentionally changes the transport,
packaging, retry, routing, cache, and error contracts so the same behavior is
available to the Obsidian plugin and the in-repository MCP server.

See
[`docs/evaluations/0053-amazing-marvin-client.md`](../../docs/evaluations/0053-amazing-marvin-client.md)
for the evidence and decision.
