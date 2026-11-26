# Prepare & share implementation plan

> For agentic workers: use the existing bounded workers for disjoint source files and independent review. Follow the existing test and build workflow.

Goal: Give each selected set one workspace from editable words through optional vocabulary to an explicitly published student link.

Architecture: Reuse the existing vocabulary editor, private saves, audio queues, and publication checks. Add a full-page workspace, mount existing sections in it, and keep global settings in the teacher dialog. No new dependencies or backend schema changes.

Tech stack: Existing browser JavaScript, HTML/CSS, Node tests, Cloudflare Worker.

- [x] Add Words, practice mode, progressive Vocabulary, inline review, and Share sections. Keep existing colors, spacing, accessible names, mobile layout, and keyboard operation. Move AI setup, grade defaults, and administration into Teacher settings.
- [x] Reuse validated words and private autosaves with debounce, save serialization, account/list/revision guards, visible validation failures, and pending/invalid action blocking. Open the workspace after set creation.
- [x] Mount the existing vocabulary editor inline, preserve validation and approval, refresh the workspace after saves, and retain the standalone editor for older/offline flows.
- [x] Show compact grade/count summary with settings disclosure. Keep generation explicit and missing-only; preserve approved drafts and limit retries to failed current-set work.
- [x] Derive a single readiness state from content, audio, saves, and existing publication. Primary action is Create, Copy, or Update. Keep an existing published link available while private edits remain unshared; preview private edits. Attempt copying after publication, with a visible link and Copy fallback.
- [x] Test real handlers, races, validation, changed modes/rules, inline approval, copy failure, and old workflows. Run full tests/build, browser spelling and vocabulary workflows, mobile/dark checks, independent review, and deployment byte verification.

DeepSeek reviewed the plan before implementation (request b95eb830-3f9d-4200-a1d2-e6b89fc54f27). It reported no concrete findings; code and rendered checks remain required.

Verification: 221 tests passed; build and whitespace checks passed. Browser checks covered creation, private word edits, spelling publication, mixed generation, inline approval, explicit link update, invalid input, global settings, and mobile dark layout. Independent native review reproduced and verified fixes for stale vocabulary writes and learning-history preservation. DeepSeek completed bounded root UI and editor reviews. Deployment verification follows the release procedure.
