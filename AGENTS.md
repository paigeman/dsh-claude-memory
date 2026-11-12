# Agent Rules

These rules apply to compatibility work, development, installation, and testing in this repository.

## Protect the production installation

- Use `dsh-claude-memory-reader` for the production plugin published on npm and `dsh-claude-memory-reader-dev` for development and acceptance testing.
- Scope compatibility implementation and test installations to the development package. Install unpublished code, local tarballs, and source links under the development package name with the separate `claude-memory-dev` component ID.
- Verify `package.json.name` inside the actual installation artifact before installing it. Package identity determines which installed plugin the package manager updates.
- Require explicit user authorization to change the installed production plugin's version, installation source, files, or compatibility metadata. A request for compatibility work, development testing, or a DSH application upgrade scopes plugin installation to the development package. Apply production authorization already provided by the user without asking again.
- Use published npm releases for authorized production updates and rollbacks. Keep the production dependency recorded as a registry package version.
- Record the production version and installation source before test setup and verify them again after testing. If the production release's declared compatibility excludes the target DSH version, use a compatible development build for validation and report the production compatibility limit.

## Keep production and development activation mutually exclusive

- Enable at most one of the production and development readers.
- Enforce this at both levels of DSH activation, the package/bundle switch shown in the plugin manager and the runtime component state.
- Before enabling either reader, turn off the other reader's bundle and confirm its component has stopped. Verify the selected bundle and its active component directly through DSH after switching or running acceptance scripts.
- Record the previously selected reader before testing. After success or failure, restore a single compatible reader and verify both bundle switches and runtime component states.
- If a DSH upgrade makes the previous production release incompatible, keep the production bundle disabled and use the compatible development reader. Report this selection explicitly.
- Normalize an existing state with both bundle switches enabled before testing. When completing installation, switching, or acceptance work, report the production version and source together with the final bundle and component states.
