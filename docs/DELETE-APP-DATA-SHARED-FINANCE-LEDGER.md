# Delete My App Data — `shared-finance-ledger`

**Status:** decided by Adam 2026-09-16. **Schema part BUILT 2026-09-19** (PROMPT-08): `shared_finance_ledger.erase_my_data()` exists live, tested in `silver-octo-invention/tools/schema-test` for both the only-member and others-remain cases, and every `auth.users` reference except `household_members.user_id` is `ON DELETE SET NULL` (verify query checks 9–10). **UI built 2026-09-19 (PROMPT-09) in the test app's `/sync/` only** (`AccountModal.tsx`: two confirmations → `disconnectAndClear` → the user's backup files → `erase_my_data()` → clear keys → reload), proven live by Adam (UAT step 12: reloads to an empty household, query shows 0 people / 35 categories). PROMPT-10 folds it into the full Account modal and brings it to `shared-finance-ledger`. The schema part was in PROMPT-08
(`BUILD-PLAN.md` Phase 2.3). The UI is built in the same session as auth (PROMPT-10, Phase 4.1a).
**No test account may be created before this exists.**

> **Replaces account closure for this app** (Adam, 2026-09-16: "completely overrides account
> closure"). This was `ACCOUNT-CLOSURE-SHARED-FINANCE-LEDGER.md`. The app deletes the signed-in
> user's **`shared-finance-ledger` data only**. The login (`auth.users`) stays, so the same test
> account can be reused later. When Adam wants a login gone, he deletes it himself in the Supabase
> dashboard (Authentication → Users). Cross-app closure is still unscoped:
> `Supabase Migration/SHARED-ACCOUNT-CLOSURE.md`.

## Why it's needed early

Sync features are tested in the test app's `/sync/` build against the **live** Supabase project and
PowerSync instance (`TEST-APP-DIVERGENCE.md`). A test account's rows are real rows. Adam needs to wipe
them from inside the app and reuse the account.

## Decisions (Adam, 2026-09-16)

| # | Question | Decision |
|---|---|---|
| 1 | How it runs | Adam was fine with an Edge Function if hosting the secret is safe. **It isn't needed now.** Deleting app data never deletes the login, so no `service_role` key is involved anywhere. It's a `security definer` + `plpgsql` RPC the signed-in user calls with their own session, like BLOC's `gdpr_erase_user_data()`. *(On the question itself: an Edge Function secret is a server-side environment variable, never sent to a browser. It's Supabase's standard pattern and safe when the function checks the caller's JWT. It's just unnecessary here.)* |
| 2 | Household with other members | **Agreed.** If this user is the **only member**: delete the household and every row in it. If **others remain**: remove this user's membership, null their attribution (`user_id`, `people.linked_user_id`), keep all household data (it's shared), and delete only their per-user rows (`scenarios`) |
| 3 | Closure vs data | **Delete app data, not the account.** Only `shared_finance_ledger` rows and this app's backup files go. `personal_finance`, `my_dream_clean` and `auth.users` are never touched, which also removes the cross-app risk account closure had |
| 4 | Who gets it | **Every account**, for its own data. In the live app and the test app |

## Requirements

1. **Copy `personal-f`'s Account button and `AccountModal` as they are.**
   - Source: `personal-f` `src/components/AccountModal.tsx` (398 lines, `main` `90794ea`), its
     profile-icon entry point on `src/pages/Salary.tsx`, and `ChangePasswordModal` in the same file.
   - Sections: identity + provider, Change password (email accounts only), Force Sync, Cloud Backup
     (Back Up Now / Restore), Sign Out.
   - Only the wiring changes (`useAppData` → `useLedgerData`, this app's backup lib and PowerSync
     database).
2. **Add "Delete my app data"** to that modal: last, destructive styling, and clearly worded as
   "your ledger data in this app", not "your account".
3. **Two confirmation modals** before anything runs. Use the app's portalled confirm modal
   (`createPortal(..., document.body)`, HARD RULE), never `window.confirm`. The second one says it
   can't be undone and names what goes: every bill, loan, card, pot and transaction in this
   household (or only their own share, if others remain).
4. **Instant.** No queue.
5. **Afterwards:** stay signed in. Clear the local PowerSync database and this app's `localStorage`
   keys, then reload into a fresh, empty app, as BLOC's "Delete my data" does. `ensure_household()`
   creates a new household on next load. The **first-sync gate** (Phase 3.3a) still applies, so
   nothing seeds client-side before sync completes.

## Design

Order matters; every step is safe to retry.

1. **Client:** list and remove this user's snapshot files in `shared-finance-ledger-backups` via
   the Storage API. SQL can't delete Storage objects (BLOC migration `0012`).
2. **RPC** `shared_finance_ledger.erase_my_data()`:
   - no parameters; the target is `auth.uid()`;
   - `security definer`, `plpgsql`, `PUBLIC` execute revoked, granted to `authenticated`;
   - applies decision 2 in one transaction, leaf → root;
   - returns a row-count summary as the audit record.
3. **Client:** clear local state, then reload.

**Schema implications, for PROMPT-08:**
- Every reference to `auth.users` (`user_id`, `created_by`, `last_redeemed_by`, `linked_user_id`) is
  `ON DELETE SET NULL`, never `CASCADE` or the implicit `RESTRICT`. It still matters: when Adam
  deletes a login in the dashboard, a `RESTRICT` makes that fail (the
  `personal_finance.household_link_codes` trap in `SHARED-ACCOUNT-CLOSURE.md`), and a `CASCADE`
  silently deletes household data.
- `scenarios` are per-user (Q4), so they're deleted outright.

## For Adam: deleting a test login afterwards
Run "Delete my app data" in the app **first**, then Supabase dashboard → Authentication → Users →
the test user → Delete user. Only do this for accounts that never used `personal-f` or
`my-dream-clean`: their tables still cascade on `user_id`.

## Reviewed

| Source | Takeaway |
|---|---|
| BLOC `handleDeleteMyData()` (`bloc-app/index.html` ~6366) | The model for this: two confirmations, delete Storage snapshots first, erasure RPC, clear local keys, reload, stay signed in |
| BLOC migrations `0005`/`0012`/`0006` | Erasure-function shape: auth check, leaf → root, row-count summary, `PUBLIC` revoked; Storage deleted client-side |
| BLOC `handleCloseAccount()` + migration `0014` | The queue-based closure. **Not used** |
| `Supabase Migration/SHARED-ACCOUNT-CLOSURE.md` | Cross-app closure design (Edge Function). Still open for `personal-f`/`my-dream-clean`; not needed by this app |
