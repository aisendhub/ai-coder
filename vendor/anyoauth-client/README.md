# @anyoauth/client

Google and GitHub login for your app. [Quickstart](https://anyoauth.com/docs/) · [Frontend integrations](https://anyoauth.com/docs/frontend-integrations/) · [Custom integration](https://anyoauth.com/docs/custom-integration/)

React, Vue, Astro, HTML, Svelte, Next.js and Nuxt examples are in [FRONTENDS.md](FRONTENDS.md), generated from the same source as the dashboard and docs.

## Install

Install the current checkout in your browser app: `npm install /absolute/path/to/anyoauth-js`. The package name is `@anyoauth/client`.

The new helpers are in the updated source; initial published `0.1.0` packages predate them. Registry publication and GitHub source distribution are separate steps.

## Three browser helpers

Mount the [Node backend router](https://github.com/AnyOAuth/anyoauth-node) at `/auth`, then:

```javascript
import * as anyoauth from '@anyoauth/client';

document.querySelector('#google').onclick = () => anyoauth.startLogin('google');
document.querySelector('#github').onclick = () => anyoauth.startLogin('github');

const profile = await anyoauth.getProfile(); // null when signed out.
// On your sign-out button: await anyoauth.logout();
```

Use `startLogin(provider, '/api/auth')`, `getProfile('/api/auth')` and `logout('/api/auth')` if your backend uses a different mount. These helpers use your same-origin backend's HttpOnly session cookie. They do not store login secrets in localStorage and do not implement browser-only OAuth.

Advanced `AnyOAuth` helpers remain available for existing authorization-code integrations. [Custom integration](https://anyoauth.com/docs/custom-integration/).

## Reference and compatibility

[sdk.json](sdk.json) defines public methods, inputs, outputs and supported managed integrations. [schema.json](schema.json) contains HTTP and SDK models. Field names stay camelCase; methods use the language's normal casing. Existing SDK methods and HTTP payloads remain compatible.

- `createLoginAttempt`
- `createLoginURL`
- `validateLoginCallback`

## Verify

Run `node verify.mjs` with the native toolchain installed. Tests use local fixtures, not production credentials.

License: MIT.

## Source and releases

Repository: https://github.com/AnyOAuth/anyoauth-js

Initial source prerelease: https://github.com/AnyOAuth/anyoauth-js/releases/tag/v0.2.0. See the installation section for availability of the new API. Source is generated in the AnyOAuth monorepo; propose changes there so every language stays aligned. Registry publication and GitHub distribution are separate release steps.
