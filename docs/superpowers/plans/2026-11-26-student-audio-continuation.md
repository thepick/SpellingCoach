# Student audio and continuation plan

> For agentic workers: implement this bounded change in the existing browser modules; use independent review and the normal build/release checks.

Goal: Automatically play vocabulary sentence audio, remember a student's mute choice, and make local practice continuation clear.

Architecture: Reuse the existing buffered playback, question masking, browser settings, saved sessions, and parked activities. No new providers, libraries, AI generation, or account requirements.

- [x] Add `vocabularyAutoplay`, default on, to existing saved device preferences and backup validation. Mirror an accessible on/off toggle in vocabulary practice and study. Turning it off cancels pending/current audio immediately; manual Listen stays available. Turning it on applies to the next card.
- [x] At existing practice entry points, play question audio when `play && !feedback && !test && question.type !== 'dictation' && audioReplay && vocabularyAutoplay`. Keep the existing dictation branch unchanged. Use `Learning.audio` through `playQuestion` so blank questions never speak their hidden answer. Feedback, hints, correction renders, and tests do not start vocabulary autoplay.
- [x] In study, automatically play the first example only after Reveal, including definition-first cards. Track the revealed example key on the study session; clear it whenever a card is hidden or changed. Re-renders do not replay it. Every render reads the shared mute preference.
- [x] Preserve existing same-set Continue practice behavior and saved partial mastery. Add an upfront note that progress stays in this browser/profile, with a distinct message when storage has failed. Verify serialized spelling and phased vocabulary/mixed sessions, parked sets, completed sets, and different-set exclusions.
- [x] Verify cancellation, manual replay, mute persistence, reveal gating, actual same-link reload/resume, mobile layout, full tests/build, independent review, and live deployed bytes. Push and deploy the completed changes as requested before Michael tests from work.

DeepSeek reviewed the plan before execution (request 18e2e96a-5275-446b-8351-13f4038f594c). Its proposed coverage checks are included above. Actual source and browser checks remain required.

Verification: 226 tests passed, including actual device-speech cancellation, preview copy, saved mute preference, and serialized partial mastery for current and parked spelling/vocabulary/mixed sessions. Browser checks verified the same public link reopening at 8 percent progress, Continue practice, mute across study/practice cards and reload, manual Listen, visible local-progress copy, and mobile layout. Independent native and DeepSeek reviews completed; source evidence and tests resolved review findings. Release uses the existing verified deployment procedure and live-byte checks.
