# Contributing to woolgather

Thank you for taking the time to improve woolgather. The project welcomes focused bug fixes, accessibility improvements, tests, and carefully scoped implementation work.

## Before opening an issue

- Search existing issues and discussions.
- Do not include credentials, private project content, customer data, provider traces, or security-sensitive deployment details.
- Report suspected vulnerabilities privately through the process in [SECURITY.md](SECURITY.md).
- Keep product proposals grounded in a concrete user problem rather than a broad redesign.

## Development setup

Use Node.js 24, npm 11 or newer, and local PostgreSQL tools.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

The example configuration keeps paid and externally connected features disabled. Routine development and the automated suite must not require live provider calls.

## Pull requests

1. Create a focused branch from `main`.
2. Preserve existing behavior outside the change's stated scope.
3. Add or update tests for observable behavior.
4. Run the complete local checkpoint:

   ```bash
   npm run check:format
   npm run build
   npm test
   npm run deploy:check
   ```

5. Explain the problem, the chosen solution, recovery or security implications, and the checks performed.

Keep pull requests small enough to review. Avoid drive-by formatting, generated output, dependency folders, local databases, screenshots containing private data, or unrelated refactors.

## Code expectations

- TypeScript is strict; avoid weakening types to bypass a contract.
- Treat authenticated Worker-to-database boundaries and Row Level Security as security-critical.
- Preserve idempotency, optimistic concurrency, and explicit failure recovery.
- Keep authored user content distinct from generated suggestions and evidence.
- Honor keyboard operation, responsive layouts, contrast, and reduced motion.
- New externally connected capabilities must fail closed when incomplete or unconfigured.

## Commits

Use clear, imperative commit subjects that describe the outcome. Never commit secrets, `.dev.vars`, `.env` files, provider responses, account snapshots, databases, recordings, or internal research.

By contributing, you agree that your contribution is licensed under the repository's [AGPL-3.0-only license](LICENSE).
