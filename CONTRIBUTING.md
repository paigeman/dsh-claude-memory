# Contributing

Contributions can improve memory recall, compatibility, tests, or documentation. Installation and everyday use are covered in the [English README](README.md) and [Chinese README](README.zh-CN.md).

## Report a problem

Include the DSH version, operating system, steps to reproduce, and the expected and actual results. For path resolution problems, include the output of the `claude_code_memory` tool's `status` action after removing personal paths and other private information. Keep Memory contents and model credentials out of public reports.

## Set up a development checkout

Fork the repository and create a branch for your change. Use Node.js 24.16.0 to match CI, then install the locked development dependencies from the repository root.

```bash
npm ci --ignore-scripts
```

Runtime code supports Node.js 20 and later. Development tools have newer requirements, so use the CI version when running repository checks.

## Make and check a change

Keep the change focused. Format the files you edit with the repository's Prettier configuration. For example, after editing the English README, run the following command.

```bash
npx --no-install prettier --write README.md
```

For code changes, run the full check before opening a pull request.

```bash
npm run check
```

This checks formatting, JavaScript, and Markdown, runs the native DSH tests, and verifies the packed plugin. CI also runs native tests and package checks on Linux, macOS, and Windows.

For documentation-only changes, format the affected Markdown files and run `npm run lint:markdown`.

Individual checks are available while developing.

| Command                  | What it checks                                                               |
| ------------------------ | ---------------------------------------------------------------------------- |
| `npm run format:check`   | Formatting against the repository's Prettier configuration                   |
| `npm run lint`           | JavaScript and Markdown rules                                                |
| `npm test`               | A quick test run that can skip native DSH checks                             |
| `npm run test:native`    | The pinned DSH codec and request integration, with zero skipped tests        |
| `npm run verify:package` | The packed file list, bundle entry, and recall through the extracted package |

Native tests use the pinned DSH libraries and an offline model adapter. They run without an installed Desktop app or model credentials. Passing them verifies the tested integration paths; it does not measure recall quality in a real-model conversation.

When changing behavior, add a regression test that exercises the affected case. Use synthetic Memory fixtures. Preserve the plugin's read-only behavior, project isolation, and exclusion of Memory bodies from durable plugin messages and tool results. If a change affects installation or configuration, update both READMEs.

## Open a pull request

Target `main`. Describe the problem, the resulting behavior, and the checks you ran. Include reproduction steps for a bug fix and explain any compatibility limit the change introduces.

Write commit messages in English. Use `type(scope): short summary` for the subject and a bullet list for the body. For example, a project isolation fix could use this message.

```text
fix(claude-memory): scope recall to the active project

- resolve the session project before selecting memory files
- cover project isolation with a regression test
```

Use the module as the scope when possible. Supported types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, and `revert`.
