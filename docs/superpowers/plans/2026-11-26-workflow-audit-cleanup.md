# Teacher workflow audit cleanup

**Baseline:** `feature/vocabulary-engine` at `6097827`. All remote fix branches are ancestors of this baseline. Michael approved implementing the audit recommendations, pushing, and deploying for remote testing on November 26, 2026 (Asia/Bangkok).

**Goal:** Keep the normal create → review → share workflow clear, protect teacher edits, and move uncommon controls into contextual disclosures. Preserve saved sets, published links, recordings, teacher isolation, shuffle/undo, partial mastery, audio autoplay/mute, and the explicit update-to-publish boundary.

## Tasks

- [x] Remove the parent PIN completely; ignore legacy PIN settings without removing learning data. Guard against answer exposure when local spelling audio is unavailable.
- [x] Protect unsaved vocabulary edits during word/filter/page/close navigation. Add previous/next-word review, approval progression, honest bulk approval, visible study examples, and an empty unfamiliar-card recovery action.
- [x] Compact the set workspace; collapse existing word editing, optional practice rules and uncommon review actions. Keep generation context, audio readiness, and current/unshared-link state clear.
- [x] Simplify contextual Tools, grade defaults, API key management and owner administration. Preserve entered keys after failed saves; distinguish testing saved keys and server-copy recovery.
- [x] Clarify preview type, student progress storage, reports, and offline-only controls. Keep replay, slow playback, shuffle, mute, and correction actions easy to find.
- [x] Build all entry pages and run the regression suite, independent review, and representative browser checks.
- Release step after this commit: Push the tested tree, deploy the same staged tree through the existing WordLab Worker configuration, and compare live teacher/student/offline assets with it. Preserve all existing secrets, Durable Object bindings and migrations.

## Findings confirmed before implementation

- Vocabulary word switching discards an unsaved definition; reproduced with the existing editor harness.
- Bulk approval includes unopened draft words; reproduced with the editor harness.
- Failed API key save clears the entered value; reproduced with the teacher harness.
- Parent PIN persists in current source and production; latest source contains the API keys placement but production does not.
- Editor examples are hidden under advanced settings, while routine review is a large edit form; review navigation lacks a next-word action.
- Global local-practice settings and per-assignment rules have different scopes. Server-copy recovery is misplaced inside API keys.
- Draft preview can use device speech while the published preview uses saved recordings; the button should state which is opening.

## Scope decisions

- Keep existing product architecture and storage. No new student-account system, cloud gradebook, assessment-assignment feature, provider, or dependency.
- Keep sensible defaults; don't hide readiness failures, save errors, billing facts, or the distinction between private changes and the published assignment.
- Use source-level and built-app regression checks for known fixes. Treat live deployment verification as part of completion.

## Validation

The rebuilt teacher, student and offline pages pass the deterministic build check. All 243 tests pass; final independent review found no blocking issues. Representative teacher home, preparation and review screens were inspected in an isolated browser fixture. Real provider generation is reserved for live testing.

