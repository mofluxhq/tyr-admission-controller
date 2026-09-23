# Contributing

Thanks for helping improve Tyr.

## Development setup

Use Node.js 20 or newer. CI runs Node 20, 22 and 24.

```bash
npm ci
npm run release:check
```

`release:check` runs the vendored-artifact check, lint, type-check, the unit
tests, the behavior verification scripts, a smoke import and an `npm pack` dry
run. Run it before opening a pull request.

The runtime dependencies `async-bulkhead-llm`, `async-bulkhead-ts` and `yaml`
are vendored in `vendor/` as the exact tarballs npm published, and the lockfile
points at those files. When you update one, replace its tarball, update
`package-lock.json`, and run `npm run verify:vendor` and
`npm run verify:vendor-provenance`.

## Pull requests

- Keep changes narrowly scoped, and add a regression test for any behavior
  change.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md`. Call out wire,
  configuration or metric changes under a `### Compatibility` heading.
- Do not commit `.env` files, credentials, provider keys, or absolute local
  paths.

Tyr's Latchflo managed mode talks to a separately licensed control plane.
Latchflo's source is not part of this repository.

## License

Tyr is licensed under the Apache License, Version 2.0. Unless you state
otherwise, any contribution you submit is licensed under the same terms, as
described in section 5 of [`LICENSE.txt`](LICENSE.txt).
