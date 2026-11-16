# Credential revocation matrix (T#917)

**Question this answers:** when a credential is replaced, does the OLD value stop working?

For self-issued secrets, replacing the value in the server env is the revoke. For provider-issued credentials it is not: the old value stays valid at the provider until someone revokes it **there**. A copy of the old value in a pushed archive, a backup or a transcript is then a live credential that no hash-exchange sweep can find, because the sweep hashes what a seat still holds. See "Sweep reports" below.

Inventory source: the beat 2199 baseline, 2026-11-16 (`bertus/ψ/memory/oauth-inventory/2026-11-16_baseline.md`). Key names only, never values.

## Matrix

| Class | Where it lives (names only) | Local replace kills the old value? | Provider-side revoke step | Expires by itself? |
|---|---|---|---|---|
| Beast token | `beast_tokens`; seat `.env` `BEAST_TOKEN` | **Yes.** Rotation sets `rotated_at`; a late replay returns `chain_compromised` and never authenticates (`beast-tokens.ts` validateToken). | None needed. | Yes, 24h (auto-refresh up to max lifetime). |
| Server session secret | server env `ORACLE_SESSION_SECRET` | **Yes** for new checks: the server stops accepting cookies signed with the old key. ⚠️ It also keys the beast-token HMAC (`beast-tokens.ts:47`), so rotating it logs out every seat (T#919). | None (self-issued). | No. |
| Token HMAC secret | server env `ORACLE_TOKEN_SECRET` | Yes, but today it is only the fallback; the session secret wins when both are set. | None. | No. |
| OAuth encryption key | server env `OAUTH_ENCRYPTION_KEY` | **Partly.** New writes use the new key, but the old key still decrypts every `oauth_tokens` row in old DB snapshots (`~/.oracle/backups`, hourly) and archives. | Rotate the **wrapped** credentials too: revoke the Google and Withings refresh tokens at the provider. | No. |
| Meilisearch master key | server env `MEILI_MASTER_KEY` | **Yes**, once Meili restarts with the new key; derived API keys change with it. Meili binds loopback with no edge route, so an old value is only usable on-box. | None (self-hosted). | No. |
| Hevy webhook token | server env `HEVY_WEBHOOK_TOKEN` | **Yes** on our side: our endpoint compares against the env value. Hevy must be updated or webhooks stop. | Update the webhook config in Hevy. | No. |
| Telegram bot token | server env `TELEGRAM_BOTS` (9), `TELEGRAM_BOT_TOKEN`; seat `.env` | **No.** | BotFather: `/revoke` for that bot. One bot per revoke (see the BotFather memory note). | **Never.** |
| Discord bot token | server env, karo seat `.env` | **No.** | Developer portal → the app → Bot → Reset Token. | Never. |
| Google OAuth client secret | server env | **No.** | Cloud Console → Credentials → the client: add a new secret, then disable and delete the old one. | Never. |
| Google refresh token (gmail.readonly) | `oauth_tokens` (encrypted) | **No.** | Revoke the grant at the Google account's third-party access page, or POST it to the OAuth revoke endpoint. | Not while in use; Google drops grants unused for 6 months. |
| Withings client secret | server env | **No** (assumed; not verified). | Withings partner dashboard → the app. **Verify there whether regenerating invalidates the old one.** | Never. |
| Withings refresh token | `oauth_tokens` (encrypted) | **No.** | Revoke the app in the Withings account. | Unverified. |
| Hevy API key | server env `HEVY_API_TOKEN`, boro seat `.env` `HEVY_API_KEY` | **No** (assumed). | Regenerate in Hevy settings. **Verify that the old key is invalidated.** | Unverified. |
| GitHub PAT (fine-grained) | `gh` auth on the box | **No.** | github.com → Settings → Developer settings → tokens → Revoke. | Yes, its set expiry. |
| Cloudflare API token | bertus seat `.env` | n/a: **already invalid** (verify returns error 1000, 2026-11-16). | Delete the residue from the seat `.env`. | — |
| `NYX_TOKEN` | server env | **Unknown purpose:** no reference in `src/` (2026-11-16). Retired-seat residue. | Ask Gorn what issued it; revoke there, then remove it. | Unknown. |

**Rule that falls out of the table:** for every row marked **No**, a rotation is not finished until the provider-side step is done. A rotation runbook for those classes must list that step explicitly, after the new value is live and verified, because the order matters (revoke first and the service is down).

## Sweep reports

The hash-exchange sweep (hash your own live credentials, check them against every published list) **cannot see a credential the seat no longer holds.** For the "No" classes above, a superseded value is still live and is exactly what that sweep reports clean on.

Every sweep report must carry this line, verbatim, next to its result:

> Blind spot (T#917): this sweep checks only credentials the seat holds now. Superseded provider-issued credentials (Telegram, Discord, Google, Withings, Hevy, GitHub) are invisible to it and stay live until revoked at the provider. A clean result says nothing about them.

To actually cover the superseded set, use a shape scan (e.g. the Telegram token regex) across archives and decompressed sessions, and then check each hit's liveness at the provider without using it (BotFather `/mybots`, the provider's token list). Never "test" a found credential by calling the API with it.

-- Bertus, 2026-11-16
