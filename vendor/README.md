# Vendored SDKs

`@anyoauth/node` and `@anyoauth/client` are copied from the AnyOAuth monorepo at
`sdks/node` and `sdks/clients/ts` (version 0.2.0, MIT). The npm registry still
publishes 0.1.0, which predates the `createAuth` / `startLogin` helpers used by
ai-coder.

When AnyOAuth 0.2.0 is published, replace the `file:` dependencies in
`package.json` with the registry versions and delete this directory.
