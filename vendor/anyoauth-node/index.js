// Generated from sdks/spec/openapi.json. Docs: docs/sdk/contract.md
const contract = {"schemas":{"LoginSessionRequest":{"type":"object","additionalProperties":false,"required":["client_id","client_secret","session_key","provider","redirect_uri"],"properties":{"client_id":{"type":"string","minLength":1,"maxLength":100},"client_secret":{"type":"string","minLength":1,"maxLength":200},"session_key":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"provider":{"$ref":"#/components/schemas/Provider"},"redirect_uri":{"$ref":"#/components/schemas/RedirectUri"}}},"LoginSessionResponse":{"type":"object","required":["authorization_url","expires_in"],"properties":{"authorization_url":{"$ref":"#/components/schemas/RedirectUri"},"expires_in":{"type":"integer","const":600}},"additionalProperties":true},"LoginResultRequest":{"type":"object","additionalProperties":false,"required":["client_id","client_secret","session_key","redirect_uri"],"properties":{"client_id":{"type":"string","minLength":1,"maxLength":100},"client_secret":{"type":"string","minLength":1,"maxLength":200},"session_key":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"redirect_uri":{"$ref":"#/components/schemas/RedirectUri"}}},"LoginResult":{"type":"object","required":["status"],"properties":{"status":{"type":"string","enum":["pending","succeeded","failed"]},"profile":{"$ref":"#/components/schemas/Profile"},"error":{"type":"string","enum":["access_denied","invalid_provider_response","provider_unavailable"]}},"additionalProperties":true},"Provider":{"type":"string","enum":["google","github","email"]},"RedirectUri":{"type":"string","format":"uri","maxLength":2048,"x-validation":"redirect","description":"Exact registered HTTPS URL or HTTP loopback; no credentials, query or fragment."},"TokenRequest":{"type":"object","additionalProperties":false,"required":["grant_type","client_id","client_secret","code","redirect_uri","code_verifier"],"properties":{"grant_type":{"type":"string","const":"authorization_code"},"client_id":{"type":"string","maxLength":100},"client_secret":{"type":"string","minLength":1,"maxLength":200},"code":{"type":"string","minLength":1,"maxLength":200},"redirect_uri":{"$ref":"#/components/schemas/RedirectUri"},"code_verifier":{"type":"string","pattern":"^[A-Za-z0-9._~-]{43,128}$"}}},"TokenResponse":{"type":"object","required":["access_token","token_type","expires_in","scope"],"properties":{"access_token":{"type":"string","pattern":"^aop_[A-Za-z0-9_-]{43}$"},"token_type":{"type":"string","const":"Bearer"},"expires_in":{"type":"integer","const":900},"scope":{"type":"string","const":"profile"}},"additionalProperties":true},"Profile":{"type":"object","required":["subject","provider","providerSubject","name","username","email","emailVerified","avatarUrl"],"properties":{"subject":{"type":"string"},"provider":{"$ref":"#/components/schemas/Provider"},"providerSubject":{"type":"string"},"name":{"type":["string","null"]},"username":{"type":["string","null"]},"email":{"type":["string","null"]},"emailVerified":{"type":"boolean"},"avatarUrl":{"type":["string","null"]}},"additionalProperties":true},"ProviderStatus":{"type":"object","required":["id","configured","enabled","available"],"properties":{"id":{"$ref":"#/components/schemas/Provider"},"configured":{"type":"boolean"},"enabled":{"type":"boolean"},"available":{"type":"boolean"}},"additionalProperties":true},"ProviderStatuses":{"type":"array","items":{"$ref":"#/components/schemas/ProviderStatus"}},"ApiError":{"type":"object","required":["error"],"properties":{"error":{"type":"string"},"message":{"type":"string"}},"additionalProperties":true},"Transaction":{"type":"object","required":["state","codeVerifier","codeChallenge","createdAt","expiresAt"],"properties":{"state":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"codeVerifier":{"type":"string","pattern":"^[A-Za-z0-9._~-]{43,128}$"},"codeChallenge":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"createdAt":{"type":"integer"},"expiresAt":{"type":"integer"}},"additionalProperties":true},"BrowserStartLoginParameters":{"type":"object","additionalProperties":false,"required":["provider"],"properties":{"provider":{"$ref":"#/components/schemas/Provider"},"authUrl":{"type":"string","minLength":1,"maxLength":2048}}},"BrowserAuthParameters":{"type":"object","additionalProperties":false,"required":[],"properties":{"authUrl":{"type":"string","minLength":1,"maxLength":2048}}},"AppOrigin":{"type":"string","format":"uri","pattern":"^https?://[^/?#]+$","maxLength":2048,"x-validation":"redirect","description":"Exact application origin without a path or trailing slash. HTTPS or HTTP loopback only."},"ManagedAuthConfiguration":{"type":"object","additionalProperties":false,"required":["clientId","clientSecret","origin"],"properties":{"clientId":{"type":"string","minLength":1,"maxLength":100},"clientSecret":{"type":"string","minLength":1,"maxLength":200},"origin":{"$ref":"#/x-sdk-schemas/AppOrigin"},"authPath":{"type":"string","pattern":"^/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+$"},"returnTo":{"type":"string","minLength":1,"maxLength":2048},"sessionMaxAge":{"type":"integer"},"sessionSecret":{"type":"string","minLength":32,"maxLength":2000},"baseUrl":{"type":"string"}}},"ManagedLoginCookie":{"type":"object","additionalProperties":false,"required":["provider","loginAttempt"],"properties":{"provider":{"$ref":"#/components/schemas/Provider"},"loginAttempt":{"$ref":"#/x-sdk-schemas/LoginAttempt"}}},"ManagedSessionCookie":{"type":"object","additionalProperties":false,"required":["profile","expiresAt"],"properties":{"profile":{"$ref":"#/components/schemas/Profile"},"expiresAt":{"type":"integer"}}},"SDKConfiguration":{"type":"object","additionalProperties":false,"required":["clientId"],"properties":{"clientId":{"type":"string","minLength":1},"clientSecret":{"type":"string","minLength":1},"baseUrl":{"type":"string"},"timeoutMs":{"type":"integer"}}},"EmptyParameters":{"type":"object","additionalProperties":false,"required":[],"properties":{}},"StartLoginParameters":{"type":"object","additionalProperties":false,"required":["provider","redirectUri"],"properties":{"provider":{"$ref":"#/components/schemas/Provider"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"}}},"LoginAttempt":{"type":"object","additionalProperties":false,"required":["sessionKey","redirectUri","expiresAt"],"properties":{"sessionKey":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"},"expiresAt":{"type":"integer"}},"description":"Private backend login attempt. Store in the initiating browser's server session, never in a URL or frontend storage. expiresAt is Unix seconds."},"StartedLogin":{"type":"object","additionalProperties":false,"required":["url","loginAttempt"],"properties":{"url":{"$ref":"#/components/schemas/RedirectUri"},"loginAttempt":{"$ref":"#/x-sdk-schemas/LoginAttempt"}}},"CompleteLoginParameters":{"type":"object","additionalProperties":false,"required":["loginAttempt"],"properties":{"loginAttempt":{"$ref":"#/x-sdk-schemas/LoginAttempt"}}},"PendingLogin":{"type":"object","required":["status"],"properties":{"status":{"type":"string","const":"pending"}},"additionalProperties":true},"CompletedLogin":{"type":"object","required":["status","profile"],"properties":{"status":{"type":"string","const":"succeeded"},"profile":{"$ref":"#/components/schemas/Profile"}},"additionalProperties":true},"FailedLogin":{"type":"object","required":["status","error"],"properties":{"status":{"type":"string","const":"failed"},"error":{"type":"string","enum":["access_denied","invalid_provider_response","provider_unavailable"]}},"additionalProperties":true},"ProfileTokenParameters":{"type":"object","additionalProperties":false,"required":["accessToken"],"properties":{"accessToken":{"type":"string","minLength":1}}},"LoginURLParameters":{"type":"object","additionalProperties":false,"required":["provider","redirectUri","state","codeChallenge"],"properties":{"provider":{"$ref":"#/components/schemas/Provider"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"},"state":{"type":"string","minLength":16,"maxLength":512},"codeChallenge":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"}}},"LoginCallbackParameters":{"type":"object","additionalProperties":false,"required":["callbackUrl","redirectUri","state","expiresAt"],"properties":{"callbackUrl":{"type":"string"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"},"state":{"type":"string","minLength":1},"expiresAt":{"type":"integer"}}},"LoginCallbackCode":{"type":"object","additionalProperties":false,"required":["state","code"],"properties":{"state":{"type":"string"},"code":{"type":"string","minLength":1}}},"LoginCallbackError":{"type":"object","additionalProperties":false,"required":["state","error"],"properties":{"state":{"type":"string"},"error":{"type":"string","minLength":1}}}},"operations":{"createLoginSession":{"id":"createLoginSession","path":"/v1/login/session","method":"POST","auth":"client","requestSchema":"LoginSessionRequest","responseSchema":"LoginSessionResponse","successStatus":200},"loginResult":{"id":"loginResult","path":"/v1/login/result","method":"POST","auth":"client","requestSchema":"LoginResultRequest","responseSchema":"LoginResult","successStatus":200},"exchangeCode":{"id":"exchangeCode","path":"/v1/token","method":"POST","auth":"client","requestSchema":"TokenRequest","responseSchema":"TokenResponse","successStatus":200},"profile":{"id":"profile","path":"/v1/profile","method":"GET","auth":"bearer","requestSchema":null,"responseSchema":"Profile","successStatus":200},"revoke":{"id":"revoke","path":"/v1/revoke","method":"POST","auth":"bearer","requestSchema":null,"responseSchema":null,"successStatus":204},"providers":{"id":"providers","path":"/api/providers","method":"GET","auth":"none","requestSchema":null,"responseSchema":"ProviderStatuses","successStatus":200}},"authorization":{"operationId":"authorizationUrl","x-sdk-local":true,"description":"Construct this URL locally and navigate the browser. Persist state/verifier in the initiating application session; validate and consume the transaction on callback. Never include a client secret.","parameters":[{"name":"client_id","in":"query","required":true,"schema":{"type":"string","minLength":1}},{"name":"provider","in":"query","required":true,"schema":{"$ref":"#/components/schemas/Provider"}},{"name":"redirect_uri","in":"query","required":true,"schema":{"$ref":"#/components/schemas/RedirectUri"}},{"name":"state","in":"query","required":true,"schema":{"type":"string","minLength":16,"maxLength":512}},{"name":"code_challenge","in":"query","required":true,"schema":{"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"}},{"name":"code_challenge_method","in":"query","required":true,"schema":{"type":"string","const":"S256"}},{"name":"response_type","in":"query","required":true,"schema":{"type":"string","const":"code"}}],"responses":{"302":{"description":"Browser redirect to configured provider","headers":{"Location":{"schema":{"type":"string","format":"uri"}}}},"default":{"$ref":"#/components/responses/Error"}}},"helpers":{"createTransaction":{"lifetimeSeconds":600,"entropyBytes":32,"description":"Create random state and a PKCE verifier/challenge. Persist this transaction in the initiating browser or app session.","input":{"type":"object","properties":{},"additionalProperties":false}},"pkceChallenge":{"algorithm":"SHA-256","encoding":"base64url","description":"Compute the RFC 7636 S256 challenge for the original verifier.","input":{"type":"object","required":["codeVerifier"],"properties":{"codeVerifier":{"$ref":"#/components/schemas/TokenRequest/properties/code_verifier"}},"additionalProperties":false}},"authorizationUrl":{"operation":"authorizationUrl","description":"Construct the URL locally and navigate the initiating browser; never include a client secret."},"validateCallback":{"description":"Exact saved callback, state and expiry. Reject duplicate state/code/error and simultaneous code/error. Caller owns browser binding and atomic consumption.","input":{"type":"object","required":["callbackUrl","redirectUri","state","expiresAt"],"properties":{"callbackUrl":{"type":"string"},"redirectUri":{"$ref":"#/components/schemas/RedirectUri"},"state":{"type":"string","minLength":1},"expiresAt":{"type":"integer"}},"additionalProperties":false}}},"origin":"https://api.anyoauth.com"};

export class SDKError extends Error {
  constructor(status = 0, code = 'invalid_argument', message = 'Invalid argument') {
    super(message); this.name = 'SDKError'; this.status = status; this.code = code;
  }
}
const fail = () => { throw new SDKError(); };
function safeURL(value, origin = false, query = false) {
  if (typeof value !== 'string' || /[\s\\\x00-\x1f\x7f]/u.test(value) || /%(?![0-9a-f]{2})/i.test(value)) fail();
  let u; try { u = new URL(value); } catch { fail(); }
  const authority = value.split('://')[1]?.split(/[/?#]/)[0];
  if (!authority || /[%@]/.test(authority) || u.username || u.password || value.includes('#') || (!query && value.includes('?')) ||
      !(u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) ||
      u.port === '0' || (origin && !/^https?:\/\/[^/?#]+\/?$/.test(value))) fail();
  return u;
}
function validate(s, value) {
  if (s.$ref) return validate(contract.schemas[s.$ref.split('/').at(-1)], value);
  const types = [].concat(s.type);
  const matches = {null:value === null,string:typeof value === 'string',boolean:typeof value === 'boolean',integer:Number.isSafeInteger(value),number:typeof value === 'number' && Number.isFinite(value),object:value !== null && typeof value === 'object' && !Array.isArray(value),array:Array.isArray(value)};
  if (!types.some(t=>matches[t])) fail();
  if (Object.hasOwn(s,'const') && value !== s.const) fail();
  if (s.enum && !s.enum.includes(value)) fail();
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length < (s.minLength ?? 0) || length > (s.maxLength ?? Infinity)) fail();
    if (s.pattern) { const pattern = new RegExp(s.pattern); const match = pattern.exec(value); if (!match || (s.pattern.endsWith('$') && match.index + match[0].length !== value.length)) fail(); }
    if (s['x-validation'] === 'redirect') safeURL(value);
  }
  if (matches.object) {
    for (const k of s.required) if (!Object.hasOwn(value,k)) fail();
    for (const [k,v] of Object.entries(value)) { if (Object.hasOwn(s.properties,k)) validate(s.properties[k],v); else if (s.additionalProperties === false) fail(); }
  }
  if (matches.array) for (const v of value) validate(s.items,v);
  return value;
}
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export function validateSchema(name,value) {
  if (!Object.hasOwn(contract.schemas,name)) fail();
  return validate(contract.schemas[name],value);
}
export class AnyOAuth {
  #secret;
  constructor({clientId, clientSecret = '', baseUrl = contract.origin, timeoutMs = 10000, cryptoProvider = globalThis.crypto}) {
    safeURL(baseUrl,true);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail();
    this.baseUrl = baseUrl.replace(/\/$/,''); this.clientId = clientId; this.#secret = clientSecret; this.timeoutMs = timeoutMs; this.cryptoProvider = cryptoProvider;
  }
  async startLogin(params) {
    validateSchema('StartLoginParameters', params);
    const transaction = await this.createTransaction();
    const loginAttempt = {sessionKey:transaction.state, redirectUri:params.redirectUri, expiresAt:transaction.expiresAt};
    const response = await this.createLoginSession({...params, sessionKey:loginAttempt.sessionKey});
    return validateSchema('StartedLogin', {url:response.authorization_url, loginAttempt});
  }
  async completeLogin(params) {
    validateSchema('CompleteLoginParameters', params);
    const attempt = params.loginAttempt;
    if (attempt.expiresAt <= Math.floor(Date.now()/1000)) throw new SDKError(0,'invalid_argument','Login attempt expired. Start login again.');
    const result = await this.loginResult({sessionKey:attempt.sessionKey, redirectUri:attempt.redirectUri});
    try { return validateSchema({pending:'PendingLogin',succeeded:'CompletedLogin',failed:'FailedLogin'}[result.status], result); }
    catch { throw new SDKError(200,'protocol_error','Invalid login result'); }
  }
  getProfile(params = {}) { return this.profile(params); }
  getProviders(params = {}) { return this.providers(params); }
  revokeProfileToken(params = {}) { return this.revoke(params); }
  createLoginAttempt(params = {}) { return this.createTransaction(params); }
  createLoginURL(params = {}) { return this.authorizationUrl(params); }
  validateLoginCallback(params = {}) { return this.validateCallback(params); }
  async pkceChallenge({codeVerifier}) {
    // RFC7636 syntax is shared by the contract's transaction model.
    if (typeof codeVerifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier) || /\n$/.test(codeVerifier)) fail();
    return base64url(new Uint8Array(await this.cryptoProvider.subtle.digest('SHA-256',Uint8Array.from(codeVerifier,c=>c.charCodeAt(0)))));
  }
  async createTransaction() {
    const settings = contract.helpers.createTransaction;
    const random = () => base64url(this.cryptoProvider.getRandomValues(new Uint8Array(settings.entropyBytes)));
    const state = random(), codeVerifier = random(), createdAt = Math.floor(Date.now()/1000);
    return validate(contract.schemas.Transaction,{state,codeVerifier,codeChallenge:await this.pkceChallenge({codeVerifier}),createdAt,expiresAt:createdAt+settings.lifetimeSeconds});
  }
  authorizationUrl(params) {
    const values = {...params,clientId:this.clientId}; const query = new URLSearchParams();
    for (const p of contract.authorization.parameters) {
      const key = p.name.replace(/_([a-z])/g,(_,c)=>c.toUpperCase());
      query.set(p.name,validate(p.schema,Object.hasOwn(p.schema,'const') ? p.schema.const : values[key]));
    }
    return this.baseUrl + '/authorize?' + query;
  }
  validateCallback({callbackUrl,redirectUri,state,expiresAt}) {
    validate(contract.schemas.RedirectUri,redirectUri); const u = safeURL(callbackUrl,false,true);
    if (callbackUrl.split('?')[0] !== redirectUri) throw new SDKError(0,'invalid_argument','Callback does not match saved redirect');
    if (!Number.isSafeInteger(expiresAt)) fail();
    if (expiresAt <= Math.floor(Date.now()/1000)) throw new SDKError(0,'invalid_argument','Transaction expired');
    const q = u.searchParams;
    for (const k of q.keys()) if (q.getAll(k).length > 1) fail();
    if (typeof state !== 'string' || !state || q.get('state') !== state) throw new SDKError(0,'invalid_argument','Callback state mismatch');
    if (q.has('code') === q.has('error')) fail();
    const key = q.has('code') ? 'code' : 'error', value = q.get(key);
    if (!value || value.includes('\uFFFD')) fail();
    return {[key]:value,state};
  }
  async request(action, params) {
    const op = contract.operations[action]; if (!op) fail();
    const headers = {Accept:'application/json','User-Agent':"AnyOAuth-node/0.2.0"}; let body;
    if (op.auth === 'bearer') {
      if (typeof params.accessToken !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(params.accessToken) || /\n$/.test(params.accessToken)) fail();
      headers.Authorization = 'Bearer ' + params.accessToken;
    }
    if (op.requestSchema) {
      const values = {...params,clientId:this.clientId,clientSecret:this.#secret}; const data = {};
      for (const [wire,s] of Object.entries(contract.schemas[op.requestSchema].properties)) data[wire] = Object.hasOwn(s,'const') ? s.const : values[wire.replace(/_([a-z])/g,(_,c)=>c.toUpperCase())];
      validate(contract.schemas[op.requestSchema],data); body = JSON.stringify(data); headers['Content-Type'] = 'application/json';
    }
    let response, raw;
    try { response = await fetch(this.baseUrl + op.path,{method:op.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(this.timeoutMs)}); raw = await response.text(); }
    catch { throw new SDKError(0,'transport_error','Request failed or timed out'); }
    if (response.status !== op.successStatus) {
      if (response.status >= 200 && response.status < 300) throw new SDKError(response.status,'protocol_error','Unexpected response status');
      let error; try { error = validate(contract.schemas.ApiError,JSON.parse(raw)); } catch { throw new SDKError(response.status,'protocol_error','Invalid error response'); }
      throw new SDKError(response.status,error.error,error.message ?? 'HTTP request failed');
    }
    if (!op.responseSchema) return;
    try { return validate(contract.schemas[op.responseSchema],JSON.parse(raw)); } catch { throw new SDKError(response.status,'protocol_error','Invalid response'); }
  }
}
export { AnyOAuth as Client };

AnyOAuth.prototype.createLoginSession = function(params = {}) { return this.request("createLoginSession", params); };

AnyOAuth.prototype.loginResult = function(params = {}) { return this.request("loginResult", params); };

AnyOAuth.prototype.exchangeCode = function(params = {}) { return this.request("exchangeCode", params); };

AnyOAuth.prototype.profile = function(params = {}) { return this.request("profile", params); };

AnyOAuth.prototype.revoke = function(params = {}) { return this.request("revoke", params); };

AnyOAuth.prototype.providers = function(params = {}) { return this.request("providers", params); };
