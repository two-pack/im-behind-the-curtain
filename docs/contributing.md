# Contributing

Thank you for helping. Issues and pull requests are welcome. For what the program does and how to use it, see the [README](https://github.com/two-pack/im-behind-the-curtain#readme) and [specification.md](specification.md). This page is about changing the code.

## Get the code and build it

You need Node.js 24 or later, npm (it comes with Node.js) and git.

```sh
git clone https://github.com/two-pack/im-behind-the-curtain.git
cd im-behind-the-curtain
npm ci
npm run build
```

`npm ci` installs the exact dependencies from `package-lock.json`. The `.npmrc` of the repository turns off the install scripts of dependencies and asks npm not to take a release that is younger than 7 days. `npm run build` compiles `src/` into `dist/`. Run the built program with `node dist/bin.js serve` and `node dist/bin.js answer`.

## Check your change

Run these before you open a pull request:

```sh
npm run check    # type check, lint and format check, tests with coverage, knip, dependency rules
npm test         # the tests only, with the coverage thresholds
```

They need no network. To fix formatting problems, run `npx biome check --write .`. Two more checks are not part of `npm run check`:

```sh
npm run audit        # npm audit: known problems in the dependencies (needs the network)
npm run round-trip   # start the built program, send one request, answer it, check the reply (run npm run build first)
```

### Tests

- All tests are automated. A test never needs a manual step to pass.
- Write the test first, watch it fail, then write the code that makes it pass.
- New code needs at least 80% line coverage. The thresholds are in `vitest.config.ts`. Do not lower them to make a change pass.
- Tests cover the program through plain HTTP and through the official OpenAI SDK. Tests that start the real program use `dist/`, and the test run builds it for you.

### Git hook (optional)

If you want `npm run check` to run before each commit, install the hook yourself:

```sh
npm run hooks:install    # sets core.hooksPath to .githooks for this clone
```

This stops the hooks under `.git/hooks/` from running in this clone. If you already use hooks there, move them to `.githooks/` or skip this step.

## Pull requests

- Create a short-lived branch from `main` and open the pull request against `main`. Keep it to one change, and say in the description what changed and why.
- GitHub Actions runs the checks on every pull request, and a pull request with a failing check is not merged. `.github/workflows/ci.yml` runs `npm run check` on Linux, macOS and Windows, and a round trip on Linux. `.github/workflows/audit.yml` runs `npm run audit`. `.github/workflows/codeql.yml` runs the CodeQL analysis. Actions are pinned to a commit: when you change one, pin the new commit and write the release in the comment after it.
- Add or change tests, and update the README or `docs/` when the behavior changes.

## Writing rules

- Commit messages, code comments, and everything else in the repository are in English. The only exception is `README.ja.md`, the Japanese version of the README.
- The documents in `docs/` are in English only.
- Follow the usual style of TypeScript: `camelCase` for variables and functions, `PascalCase` for types and classes. Biome decides the formatting.
- Do not print what a request or a reply says in the output of `imbehind serve`. It belongs only in the files of the storage directory.

## Report a problem

Open an issue at <https://github.com/two-pack/im-behind-the-curtain/issues>. Say what you ran, what you expected, and what happened, with the version of Node.js and your operating system.
