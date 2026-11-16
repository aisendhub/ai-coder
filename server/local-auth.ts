import crypto from "node:crypto"
import { Pool } from "pg"
import { jwtVerify } from "jose"
import type { Profile } from "@anyoauth/node"

// ─── Local auth ──────────────────────────────────────────────────────────────
// AnyOAuth owns the login. This module turns a verified AnyOAuth profile into
// a local `auth.users` row and a short-lived PostgREST JWT, so the existing
// Supabase-style clients and RLS policies keep working against local Postgres.
//
// PostgREST verifies the same JWT with POSTGREST_JWT_SECRET and switches to
// the `role` claim (`authenticated` for users, `service_role` for sbSystem).

const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? ""
const JWT_KEY = new TextEncoder().encode(JWT_SECRET)
const USER_TTL_SECONDS = 60 * 60

if (!JWT_SECRET) {
  console.warn("[warn] POSTGREST_JWT_SECRET not set; local auth will reject tokens")
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
  : null

export function getPool(): Pool | null {
  return pool
}

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url")

function signJwt(payload: Record<string, unknown>): string {
  if (!JWT_SECRET) throw new Error("POSTGREST_JWT_SECRET is not configured")
  const header = b64({ alg: "HS256", typ: "JWT" })
  const body = b64(payload)
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url")
  return `${header}.${body}.${signature}`
}

export type LocalUser = {
  id: string
  email: string | null
  meta: Record<string, unknown>
}

export function signUserToken(user: LocalUser): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: user.id,
    role: "authenticated",
    aud: "authenticated",
    email: user.email,
    user_metadata: user.meta,
    iat: now,
    exp: now + USER_TTL_SECONDS,
  })
}

/** Long-lived service token for sbSystem. PostgREST maps it to `service_role`
 *  (BYPASSRLS). Prefer the token provisioned in env so restarts keep working
 *  even if the secret rotates. */
export function serviceToken(): string {
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY
  }
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    role: "service_role",
    aud: "authenticated",
    iat: now,
    exp: now + 60 * 60 * 24 * 365 * 10,
  })
}

/** Anon token for the browser client's `apikey` header. Data requests still
 *  carry the user JWT via the `accessToken` callback. */
export function anonToken(): string {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    role: "anon",
    aud: "authenticated",
    iat: now,
    exp: now + 60 * 60 * 24 * 365 * 10,
  })
}

export async function verifyUserToken(token: string): Promise<LocalUser> {
  if (!JWT_SECRET) throw new Error("local auth is not configured")
  const { payload } = await jwtVerify(token, JWT_KEY, {
    audience: "authenticated",
  })
  if (payload.role !== "authenticated" || typeof payload.sub !== "string") {
    throw new Error("not a user token")
  }
  return {
    id: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    meta:
      payload.user_metadata && typeof payload.user_metadata === "object"
        ? (payload.user_metadata as Record<string, unknown>)
        : {},
  }
}

/** Idempotent upsert keyed by the stable AnyOAuth subject. */
export async function ensureAnyOAuthUser(profile: Profile): Promise<LocalUser> {
  if (!pool) throw new Error("DATABASE_URL is not configured")
  if (!profile.subject) throw new Error("AnyOAuth profile has no subject")

  const meta = {
    full_name: profile.name,
    name: profile.name,
    user_name: profile.username,
    avatar_url: profile.avatarUrl,
    provider: profile.provider,
  }

  const { rows } = await pool.query<{
    id: string
    email: string | null
    raw_user_meta_data: Record<string, unknown>
  }>(
    `insert into auth.users
       (email, raw_user_meta_data, anyoauth_subject, anyoauth_provider,
        anyoauth_username, avatar_url, email_verified, last_sign_in_at)
     values ($1, $2::jsonb, $3, $4, $5, $6, $7, now())
     on conflict (anyoauth_subject) do update set
       email = excluded.email,
       raw_user_meta_data = excluded.raw_user_meta_data,
       anyoauth_provider = excluded.anyoauth_provider,
       anyoauth_username = excluded.anyoauth_username,
       avatar_url = excluded.avatar_url,
       email_verified = excluded.email_verified,
       last_sign_in_at = now()
     returning id, email, raw_user_meta_data`,
    [
      profile.email,
      JSON.stringify(meta),
      profile.subject,
      profile.provider,
      profile.username,
      profile.avatarUrl,
      profile.emailVerified,
    ]
  )

  const row = rows[0]
  if (!row) throw new Error("failed to upsert AnyOAuth user")
  return {
    id: row.id,
    email: row.email,
    meta: row.raw_user_meta_data ?? meta,
  }
}

// ─── Desktop session ─────────────────────────────────────────────────────────
// The desktop shell opens the system browser for OAuth, then hands the verified
// profile back to the webview. The webview stores this signed session cookie;
// it is independent of the AnyOAuth cookie in the system browser.

export type DesktopSession = {
  user: LocalUser
  profile: Profile
}

const DESKTOP_TTL_SECONDS = 60 * 60 * 24 * 30

export function signDesktopSession(user: LocalUser, profile: Profile): string {
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: user.id,
    role: "desktop",
    aud: "ai-coder-desktop",
    email: user.email,
    user_metadata: user.meta,
    profile,
    iat: now,
    exp: now + DESKTOP_TTL_SECONDS,
  })
}

export async function verifyDesktopSession(
  token: string
): Promise<DesktopSession | null> {
  if (!JWT_SECRET) return null
  try {
    const { payload } = await jwtVerify(token, JWT_KEY, {
      audience: "ai-coder-desktop",
    })
    if (payload.role !== "desktop" || typeof payload.sub !== "string") {
      return null
    }
    const profile = payload.profile
    if (!profile || typeof profile !== "object") return null
    return {
      user: {
        id: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
        meta:
          payload.user_metadata && typeof payload.user_metadata === "object"
            ? (payload.user_metadata as Record<string, unknown>)
            : {},
      },
      profile: profile as Profile,
    }
  } catch {
    return null
  }
}
