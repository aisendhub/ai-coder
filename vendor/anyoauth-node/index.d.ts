export type LoginSessionRequest = { "client_id": string; "client_secret": string; "session_key": string; "provider": Provider; "redirect_uri": RedirectUri };
export type LoginSessionResponse = { "authorization_url": RedirectUri; "expires_in": 600 };
export type LoginResultRequest = { "client_id": string; "client_secret": string; "session_key": string; "redirect_uri": RedirectUri };
export type LoginResult = { "status": "pending" | "succeeded" | "failed"; "profile"?: Profile; "error"?: "access_denied" | "invalid_provider_response" | "provider_unavailable" };
export type Provider = "google" | "github" | "email";
export type RedirectUri = string;
export type TokenRequest = { "grant_type": "authorization_code"; "client_id": string; "client_secret": string; "code": string; "redirect_uri": RedirectUri; "code_verifier": string };
export type TokenResponse = { "access_token": string; "token_type": "Bearer"; "expires_in": 900; "scope": "profile" };
export type Profile = { "subject": string; "provider": Provider; "providerSubject": string; "name": string | null; "username": string | null; "email": string | null; "emailVerified": boolean; "avatarUrl": string | null };
export type ProviderStatus = { "id": Provider; "configured": boolean; "enabled": boolean; "available": boolean };
export type ProviderStatuses = Array<ProviderStatus>;
export type ApiError = { "error": string; "message"?: string };
export type Transaction = { "state": string; "codeVerifier": string; "codeChallenge": string; "createdAt": number; "expiresAt": number };
export type BrowserStartLoginParameters = { "provider": Provider; "authUrl"?: string };
export type BrowserAuthParameters = { "authUrl"?: string };
export type AppOrigin = string;
export type ManagedAuthConfiguration = { "clientId": string; "clientSecret": string; "origin": AppOrigin; "authPath"?: string; "returnTo"?: string; "sessionMaxAge"?: number; "sessionSecret"?: string; "baseUrl"?: string };
export type ManagedLoginCookie = { "provider": Provider; "loginAttempt": LoginAttempt };
export type ManagedSessionCookie = { "profile": Profile; "expiresAt": number };
export type SDKConfiguration = { "clientId": string; "clientSecret"?: string; "baseUrl"?: string; "timeoutMs"?: number };
export type EmptyParameters = {  };
export type StartLoginParameters = { "provider": Provider; "redirectUri": RedirectUri };
export type LoginAttempt = { "sessionKey": string; "redirectUri": RedirectUri; "expiresAt": number };
export type StartedLogin = { "url": RedirectUri; "loginAttempt": LoginAttempt };
export type CompleteLoginParameters = { "loginAttempt": LoginAttempt };
export type PendingLogin = { "status": "pending" };
export type CompletedLogin = { "status": "succeeded"; "profile": Profile };
export type FailedLogin = { "status": "failed"; "error": "access_denied" | "invalid_provider_response" | "provider_unavailable" };
export type ProfileTokenParameters = { "accessToken": string };
export type LoginURLParameters = { "provider": Provider; "redirectUri": RedirectUri; "state": string; "codeChallenge": string };
export type LoginCallbackParameters = { "callbackUrl": string; "redirectUri": RedirectUri; "state": string; "expiresAt": number };
export type LoginCallbackCode = { "state": string; "code": string };
export type LoginCallbackError = { "state": string; "error": string };
export interface ModelMap { LoginSessionRequest: LoginSessionRequest; LoginSessionResponse: LoginSessionResponse; LoginResultRequest: LoginResultRequest; LoginResult: LoginResult; Provider: Provider; RedirectUri: RedirectUri; TokenRequest: TokenRequest; TokenResponse: TokenResponse; Profile: Profile; ProviderStatus: ProviderStatus; ProviderStatuses: ProviderStatuses; ApiError: ApiError; Transaction: Transaction; BrowserStartLoginParameters: BrowserStartLoginParameters; BrowserAuthParameters: BrowserAuthParameters; AppOrigin: AppOrigin; ManagedAuthConfiguration: ManagedAuthConfiguration; ManagedLoginCookie: ManagedLoginCookie; ManagedSessionCookie: ManagedSessionCookie; SDKConfiguration: SDKConfiguration; EmptyParameters: EmptyParameters; StartLoginParameters: StartLoginParameters; LoginAttempt: LoginAttempt; StartedLogin: StartedLogin; CompleteLoginParameters: CompleteLoginParameters; PendingLogin: PendingLogin; CompletedLogin: CompletedLogin; FailedLogin: FailedLogin; ProfileTokenParameters: ProfileTokenParameters; LoginURLParameters: LoginURLParameters; LoginCallbackParameters: LoginCallbackParameters; LoginCallbackCode: LoginCallbackCode; LoginCallbackError: LoginCallbackError }
export function validateSchema<N extends keyof ModelMap>(name: N, value: unknown): ModelMap[N];
export interface ExchangeParameters { code: string; codeVerifier: string; redirectUri: string }
export interface AuthorizationParameters { provider: Provider; redirectUri: string; state: string; codeChallenge: string }
export interface CallbackParameters { callbackUrl: string; redirectUri: string; state: string; expiresAt: number }
export class SDKError extends Error { readonly status: number; readonly code: string; constructor(status?: number, code?: string, message?: string) }
export class AnyOAuth {
  constructor(options: {clientId: string; clientSecret?: string; baseUrl?: string; timeoutMs?: number});
  startLogin(params: StartLoginParameters): Promise<StartedLogin>;
  completeLogin(params: CompleteLoginParameters): Promise<PendingLogin | CompletedLogin | FailedLogin>;
  getProfile(params: ProfileTokenParameters): Promise<Profile>;
  getProviders(): Promise<ProviderStatuses>;
  revokeProfileToken(params: ProfileTokenParameters): Promise<void>;
  createLoginAttempt(): Promise<Transaction>;
  createLoginURL(params: LoginURLParameters): string;
  validateLoginCallback(params: LoginCallbackParameters): {state: string; code: string} | {state: string; error: string};
  pkceChallenge(params: {codeVerifier: string}): Promise<string>;
  createTransaction(): Promise<Transaction>;
  authorizationUrl(params: AuthorizationParameters): string;
  validateCallback(params: CallbackParameters): {state: string; code: string} | {state: string; error: string};
  createLoginSession(params: { sessionKey: string; provider: Provider; redirectUri: RedirectUri }): Promise<LoginSessionResponse>;
  loginResult(params: { sessionKey: string; redirectUri: RedirectUri }): Promise<LoginResult>;
  exchangeCode(params: { code: string; redirectUri: RedirectUri; codeVerifier: string }): Promise<TokenResponse>;
  profile(params: { accessToken: string }): Promise<Profile>;
  revoke(params: { accessToken: string }): Promise<void>;
  providers(): Promise<ProviderStatuses>;
}
export { AnyOAuth as Client };
