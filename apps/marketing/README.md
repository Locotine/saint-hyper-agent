# Saint website

The public website for Saint — the free, open-source command center for
agentic development.

Saint gives Claude Code, Codex, OpenCode, Cursor, Antigravity, Grok, Devin
CLI, Pi, and Droid one local-first operating surface for parallel sessions,
terminals, browser previews, diffs, Git worktrees, handoffs, and pull-request
flow.

## Product principles

- **Local-first:** workspace data stays on the user's machine.
- **Direct-to-provider:** Saint connects to the provider the user chooses
  instead of proxying normal model traffic through a Saint cloud.
- **No lock-in:** users bring the subscriptions and accounts they already use.
- **Security by design:** optional anonymous analytics are off by default and
  never include code, prompts, or chat history.

## Run the website locally

From the repository root:

```bash
bun install
bun run dev:marketing
```

Open [http://localhost:4322](http://localhost:4322).

Useful checks:

```bash
bun run --cwd apps/marketing lint
bun run build:marketing
```

The site is a Next.js App Router project. Product copy is shared across the
homepage, metadata, documentation, FAQ structured data, and AI-readable text
routes so search and answer engines receive the same confident, verifiable
description of Saint.

Learn more at [trysynara.com](https://www.trysynara.com), in the
[documentation](https://www.trysynara.com/docs), or in the
[Saint app repository](https://github.com/Emanuele-web04/synara).
