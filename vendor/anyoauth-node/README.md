# @anyoauth/node

Google and GitHub login for your app. [Quickstart](https://anyoauth.com/docs/) · [Frontend integrations](https://anyoauth.com/docs/frontend-integrations/) · [Custom integration](https://anyoauth.com/docs/custom-integration/)

React, Vue, Astro, HTML, Svelte, Next.js and Nuxt examples are in [FRONTENDS.md](FRONTENDS.md), generated from the same source as the dashboard and docs.

## Install

Use Node.js 22+. Install the current checkout in your app: `npm install /absolute/path/to/anyoauth-node`. The complete source example needs no npm dependencies.

The new helpers are in the updated source; initial published `0.1.0` packages predate them. Registry publication and GitHub source distribution are separate steps.

## One backend mount

Create an AnyOAuth project, enable Google/GitHub, and register exactly `http://localhost:3000/auth/callback`. Configure your backend credentials, then mount this in your existing Express app:

```javascript
import { createAuth } from '@anyoauth/node/express';

const auth = createAuth({
  clientId: process.env.ANYOAUTH_CLIENT_ID,
  clientSecret: process.env.ANYOAUTH_CLIENT_SECRET,
  origin: 'http://localhost:3000',
});

app.use('/auth', auth.router());
```

The SDK handles login, callback validation, the authenticated session, profile retrieval and logout. No session-store setup is required. For Hono/Workers, import `createAuth` from `@anyoauth/node/auth` and mount `auth.handle(c.req.raw)`.

## Browser

```javascript
import * as anyoauth from '@anyoauth/client';

anyoauth.startLogin('google'); // Or 'github'.
const profile = await anyoauth.getProfile(); // null when signed out.
await anyoauth.logout();
```

## Run the complete example

Register the callback above. From this checkout:

```sh
export ANYOAUTH_CLIENT_ID='YOUR_PROJECT_ID'
export ANYOAUTH_CLIENT_SECRET='YOUR_BACKEND_CLIENT_SECRET'
node examples/web/server.mjs
```

Open http://localhost:3000. [Example source and setup](examples/web/README.md). The example bundles the actual browser SDK and needs no framework dependencies.

## More control

Optional `onLogin(profile, request)` connects your user database. Optional `session` adapters expose `read`, `create`, and `destroy` for existing sessions. Or retain manual `AnyOAuth.startLogin({provider, redirectUri})` and `completeLogin({loginAttempt})`. [Custom integration](https://anyoauth.com/docs/custom-integration/).

Default sessions are encrypted, expiring HttpOnly cookies, Secure on HTTPS, SameSite=Lax. Default expiry is one day; logout clears the browser cookie. Use the session adapter for immediate server-side revocation. Set a fixed HTTPS `origin` and matching callback for production. Browser-only OAuth is deferred.

## Reference and compatibility

[sdk.json](sdk.json) defines public methods, inputs, outputs and supported managed integrations. [schema.json](schema.json) contains HTTP and SDK models. Field names stay camelCase; methods use the language's normal casing. Existing SDK methods and HTTP payloads remain compatible.

- `startLogin`
- `completeLogin`
- `getProfile`
- `getProviders`
- `revokeProfileToken`
- `createLoginAttempt`
- `createLoginURL`
- `validateLoginCallback`

## Verify

Run `node verify.mjs` with the native toolchain installed. Tests use local fixtures, not production credentials.

License: MIT.

## Source and releases

Repository: https://github.com/AnyOAuth/anyoauth-node

Initial source prerelease: https://github.com/AnyOAuth/anyoauth-node/releases/tag/v0.2.0. See the installation section for availability of the new API. Source is generated in the AnyOAuth monorepo; propose changes there so every language stays aligned. Registry publication and GitHub distribution are separate release steps.
