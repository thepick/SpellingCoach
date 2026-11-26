# WordLab release workflow

The current app lives on `feature/vocabulary-engine`. The legacy `master` branch is an archived September version. Fetch remote refs and verify the canonical branch contains the relevant fix branches before starting a release. Never deploy an older branch over newer work.

Michael expects changes to be available on the live website when finished. A GitHub push alone is not a completed website update. User instructions to audit without implementation still mean read-only work.

For authorized website changes:

1. Preserve existing sets, public links, saved recordings, account isolation, Worker secrets, Durable Object binding/class and migration identity.
2. Include regressions for removed controls and corrected behavior. Preserve existing shuffle/undo, partial mastery, autoplay/mute and explicit publish/update rules.
3. Run `node scripts/build.cjs`, `node scripts/build.cjs --check` and `node --test`. Generated teacher, student and offline pages and `release.json` must travel together.
4. Commit and push the tested files to the canonical branch. If a connected GitHub tool creates the remote commit, confirm its tree exactly matches the tested local tree and align the local checkout with that commit.
5. Stage from that same clean checkout using `node scripts/build.cjs --stage`. Deploy using the existing Wrangler installation and `worker/wrangler.wordlab.jsonc`. Do not deploy with the unrelated default Worker config.
6. Run `node scripts/verify-live.cjs`. It must confirm the actual teacher, student and offline HTML match the local release manifest and the live API is healthy. Inspect the changed live workflow where browser access is available.
7. Report the live URL and verification, or state the concrete blocker. Do not call the change live when only GitHub was updated. Do not replace or regenerate credentials as a shortcut.

The build identifier in Tools and `/release.json` identifies the generated app content. A previously open tab keeps its loaded code until refreshed; never force-reload a teacher's unsaved work.
