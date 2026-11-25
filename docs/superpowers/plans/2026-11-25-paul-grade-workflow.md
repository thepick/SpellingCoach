# Paul audio and grade presets implementation plan

> **For agentic workers:** Use the existing isolated worktree and bounded backend/frontend assignments. Complete independent review and rendered verification before release.

**Goal:** Use Paul for all new speech and make grade defaults independent of each set, with presets for grades 3 through 12 and a clear route to a student link.

**Architecture:** Retain the Worker, encrypted personal provider keys, SQLite Durable Object, existing native dialogs and public pack format. Add teacher-owned grade preferences and private per-set generation settings. Reuse the tested OpenRouter PCM-to-WAV implementation as the only speech transport.

**Tech stack:** Existing JavaScript, Web Crypto, SQLite, native HTML/CSS, Node tests; no new dependencies.

**Scope:** Michael explicitly requested Paul only, a review of the confusing AI and sharing workflow, separate defaults for different sets, and presets for every grade 3–12. Grade presets vary the reading level; the existing one-example/one-practice/plain-English defaults remain editable. These are starting settings, not curriculum-alignment claims.

## Constraints and decisions

- Groq remains available for vocabulary text; new speech uses OpenRouter, model `mistralai/voxtral-mini-tts-2603`, voice `en_paul_neutral` only.
- Existing published WAVs stay available. Do not bill a bulk regeneration of old recordings.
- An operational audio kill switch disables synthesis; it never selects another voice.
- Ordinary teachers use only their own keys. Keep quota, cooldown, ownership, revocation and key-revision guards.
- Save one grade preset at a time on the authenticated teacher record. Do not store textbook context or intended senses in reusable presets.
- Copy selected preset settings before creating/autosaving a new list. Preset edits never mutate existing sets.
- Keep per-set `generationSettings` outside public packs; persist through private server saves and local backups. Explicit setting edits increment the set version for existing optimistic concurrency checks.
- Show the Grade 5 fallback for older sets without writing or generating on view-only open.
- Discard stale asynchronous loads and saves after account/state changes. Do not expose provider keys or raw provider errors.
- Keep basic student links independent of class access codes.

## Task 1: Backend

Files: Worker audio/account/service code, focused Worker tests, deployment config, Worker README.

- [ ] Add failing tests for Paul-only dispatch, missing personal OpenRouter keys, old Troy cache exclusion, quota/error/race preservation, grade preference isolation and settings round-trip.
- [ ] Replace Groq/alternate speech paths with one Paul transport; remove unused legacy speech logic.
- [ ] Add authenticated GET/PUT `/teacher/preferences`; generate defaults for grade keys 3–12 and atomically update one selected preset.
- [ ] Extend private set save/detail with validated `generationSettings`; preserve public packs and credentials.
- [ ] Run Worker tests and inspect all speech call sites.

## Task 2: Frontend

Files: Existing source UI/state/teacher files, relevant UI tests and generated assets.

- [ ] Add failing tests for all grade choices, independent snapshots, context isolation, creation timing, metadata round-trip and stale account responses.
- [ ] Separate AI setup, grade defaults, set preparation, sharing and administration views using existing dialogs.
- [ ] Add editable grade defaults and a preset choice at creation; hydrate set fields from the selected set.
- [ ] Make the work sequence and recording progress visible; label publishing as creating/updating a student link.
- [ ] Remove Troy/fallback copy; identify OpenRouter as the paid Paul speech connection.
- [ ] Run focused tests and rebuild/check outputs.

## Task 3: Integration and release

- [ ] Inspect final diff against requirements, run full tests and build checks.
- [ ] Independent native reviewer inspects final source and test evidence; primary verifies material findings. DeepSeek reviewed the bounded implementation plans.
- [ ] Exercise local teacher setup, grade defaults, set creation/switching, optional vocabulary, review and student links with synthetic providers; verify desktop and narrow layouts.
- [ ] Preserve live Worker source/version/bindings and deploy only reviewed HEAD. Never print secret values or rotate the encryption key.
- [ ] Verify live HTML/API/auth and the signed-in workflow where available. Record remaining provider/billing gaps accurately.

## Review rulings

DeepSeek flagged correct risks around cache identity, legacy owner speech, preset snapshot timing, stale account responses and context leakage; these are covered above. Its suggestion to invent grade-specific traps or curriculum criteria was rejected as extra scope. Its claim that an audio kill switch conflicts with a sole voice was rejected: shutdown is operational control, not a voice alternative.
