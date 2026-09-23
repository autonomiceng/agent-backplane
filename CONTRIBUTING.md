# Contributing

Read [AGENTS.md](AGENTS.md), [CONTEXT.md](CONTEXT.md) and the [coding standards](docs/agents/coding-standards.md) before changing code. The [systems design](docs/DESIGN.md) and [ADRs](docs/adr/) explain the boundaries and decisions.

Tooling is pinned in `mise.toml`; run `mise install`, then install dependencies with `mise exec -- bun install --frozen-lockfile`. Follow the [shared stack conventions](docs/conventions.md), vendored from platform-edge; change them there, not here. Keep changes focused, use Conventional Commits, and explain the problem and resulting behavior in your pull request. Never edit generated files by hand.

Run the existing gates from the repository root:

```sh
mise exec -- bun run check
mise exec -- bun run test
```

With Bun installed directly, omit `mise exec --`. The check gate runs type checking, linting, generated-contract drift checks and the dashboard build. Tests use embedded PostgreSQL without a service container. Docker acceptance scenarios run separately against prepared deployments; CI runs the two gates above.

Report bugs and proposals through the issue templates. Report vulnerabilities through the [security policy](.github/SECURITY.md).
