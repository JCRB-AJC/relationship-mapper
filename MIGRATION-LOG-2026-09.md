# Migration log — September 2026

Record of moving Relationship Mapper from Ethan's personal Vercel/GitHub accounts to the JCRB-AJC organization.

**This file is disposable.** It exists so that if something breaks in the weeks after the move, whoever is debugging can tell "leftover from the migration" apart from "new bug." Once the app has run cleanly through a few real cycles — a couple of deploys, a Zeffy donation, a passkey login — **delete it.** Suggested expiry: **January 2027**.

---

## What moved, and when

| | Before | After | Date |
|---|---|---|---|
| Vercel team | `ethan-kaseffs-projects` | `jcrb-ajc` | 11 Sep 2026 |
| GitHub repo | `ethan-kaseff/relationship-mapper` | `JCRB-AJC/relationship-mapper` | 11 Sep 2026 |
| Neon database | old team's Neon install | `jcrb-ajc`'s Neon install | 14 Sep 2026 |

Stable identifiers, unchanged throughout:

- Vercel project `prj_p7Tl9pb6SBVYOKW0lBg0ypGl2N49`
- Neon resource `relationship-mapper-db` / `store_Kn6JfXpK3D5tjkc0` (Postgres 17.11)
- Neon install on `jcrb-ajc`: `icfg_jDziwAZmVF4RgmL63pzlsc1N`
- Production alias `jcrb-relationship-mapper.vercel.app`

Pre-migration backup: `~/relationship-mapper-migration/` on Ethan's machine — 35 tables, 9,711 rows, verified readable with `pg_restore --list`. **Contains live credentials.** Delete the folder once you're confident, or at minimum delete `production-clean.env` and keep the `.dump`.

---

## Things that will bite you later

### 1. The production URL is load-bearing for passkeys

Passkeys are bound to the hostname, derived per request from the request origin — see `deriveRpID` in `src/lib/webauthn.ts`. It is **not** a configurable setting.

`jcrb-relationship-mapper.vercel.app` survived the team transfer, which is the only reason the existing passkeys still work. **If that address ever changes — a custom domain, a project rename — every registered passkey stops working and every user must register a new one.** Password login is unaffected.

If a custom domain is ever added, plan it as a user-facing event, not a config change.

### 2. `vercel env add` creates variables you can never read

On Vercel CLI 54.x, adding a variable through the CLI marks it **sensitive**, which is write-only. It will show as `Encrypted` in the dashboard and pull as an *empty string*, silently.

This bit us on `DIRECT_URL` during the migration, and it also explains the old `ANTHROPIC_API_KEY`, which was unrecoverable.

To add a variable you can read back later, use the API with `"type": "encrypted"`:

```
POST https://api.vercel.com/v10/projects/<projectId>/env?slug=jcrb-ajc
{"key":"NAME","value":"...","type":"encrypted","target":["production"]}
```

If a variable mysteriously pulls as empty, this is why. The value may be fine — you just can't see it.

### 3. Zeffy webhooks started working during this migration

Four variables had a **trailing newline** baked into their stored values, pasted in when they were first created: `DIRECT_URL`, `CONSTANT_CONTACT_REDIRECT_URI`, and `ZEFFY_WEBHOOK_SECRET` (in all three environments). All were stripped on 14 Sep.

The Zeffy one matters. `src/app/api/webhooks/zeffy/route.ts` compares the token with strict `!==` and no trimming, so **every Zeffy webhook had been returning 401 since the secret was created.** No real Zeffy payment was ever recorded — the only three Zeffy rows in the database are $0 test fires from 2026-06-06.

After the fix, Zeffy webhooks pass the check and create donation records normally.

**Open question nobody has answered:** the database can't distinguish "nobody ever donated through Zeffy" from "people donated and every webhook was dropped." If Zeffy's own dashboard shows real payments collected before 14 Sep 2026, those are missing from this app and need reconciling by hand.

The newline also broke `pg_dump` outright (`invalid sslmode value: "require\n"`), so it wasn't cosmetic.

### 4. `seating-chart` depends on the Vercel GitHub App on Ethan's personal account

The `seating-chart` project stayed on the old team and is still linked to `ethan-kaseff/seating-chart`. The Vercel GitHub App installed on Ethan's **personal** GitHub account is what deploys it.

**Do not remove that app installation as "migration cleanup."** It looks like a leftover. It isn't. Removing it breaks seating-chart's deployments silently — no error, just no deploys.

### 5. A broken Vercel↔GitHub link fails silently

When the repo moved orgs, Vercel kept showing a green "Connect Git Repository ✓" and displayed the correct new repo name, while the underlying link record still pointed at the old owner. Pushes went to GitHub and produced **no deployment and no error**.

The fix was Disconnect then Connect on the project's Git settings, which rewrites the link record. The dashboard's display resolves the repo by ID, so it can look right while being wrong.

**If deploys ever stop happening for no visible reason, check the link record directly rather than trusting the UI:**

```
GET https://api.vercel.com/v9/projects/<projectId>?slug=jcrb-ajc
```

Look at `link.org` and `link.updatedAt`.

---

## What the migration did *not* change

- Database credentials — Neon did not rotate on transfer; `DATABASE_URL`, `PGHOST`, `PGPASSWORD` are byte-identical to before
- Env var counts: 23 production, 17 preview, 17 development
- Branch protection on `main` — survived the org transfer intact, all five required checks
- Per-office QuickBooks / Constant Contact / Anthropic connections — these live in the `integration_token` table, so they travelled with the database and never needed reconnecting

`ANTHROPIC_API_KEY` was deleted from production. Nothing read it: `src/lib/anthropic-keys.ts` deliberately has no env fallback, because keys are per-office and a global key would bill the wrong entity.

`NEXTAUTH_URL` was repointed from `relationship-mapper-nine.vercel.app` (which had been returning 404 for some time) to `https://jcrb-relationship-mapper.vercel.app`.

---

## Loose end

`src/lib/logout.ts` carries a workaround for the previously-broken `NEXTAUTH_URL`. That variable is now correct, so the workaround is redundant and can be removed in a normal PR whenever someone is nearby.
