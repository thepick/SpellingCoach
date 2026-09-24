# Spelling Coach — Design Spec

**Date:** 2026-09-25
**Status:** Draft for review
**Goal:** A standalone, offline app that runs a Grade-5 spelling review session the way Quizlet's *Learn → Spell* question type does: the word is read aloud, the child types it, misses are shown and retyped, and the session loops until every word is mastered.

---

## 1. Deliverable

| | |
|---|---|
| **Artifact** | One file: `Desktop/Web_Apps/SpellingCoach/Spelling Coach v0.1.0.html` |
| **Runs on** | Double-click → Edge/Chrome (`file://`). No build, no server, no install, no network |
| **State** | `localStorage` only |
| **Dependencies** | None. No framework, no CDN, no bundler |
| **Docs** | `docs/superpowers/specs/` (this file), `docs/superpowers/plans/` (implementation plan) |
| **Version rule** | `const VERSION = '0.1.0'` must match the `v0.1.0` in the filename; `?selftest=1` asserts it. Every change bumps both together (established round mechanic) |

Everything inline: one `<style>`, one `<body>`, one `<script>`. Estimated 900–1200 lines total.

---

## 2. Screens

Three screens, one DOM, toggled with the `hidden` attribute. No router.

```
                ┌──────────────┐
   ┌───────────▶│     SETUP    │  parent only (PIN to re-enter mid-session)
   │            └──────┬───────┘
   │ exit (PIN)        │ Start session
   │            ┌──────▼───────┐
   │            │   PRACTICE   │  child only
   │            └──────┬───────┘
   │                   │ all words mastered
   │            ┌──────▼───────┐
   └────────────│   SUMMARY    │
                └──────┬───────┘
                       │ Practice missed only  → new PRACTICE session
```

### 2.1 SETUP (the "closed" screen)

Shown at load. Contains everything the child must not see during practice.

- **List picker** — `<select>` of saved lists + `New` / `Rename` / `Delete`.
- **Word entry**
  - Textarea: one word per line. Blank lines and duplicates dropped on save. Case preserved.
  - `Import CSV` — Knowt/Quizlet export (`Term,Definition`). Header row detected and skipped. CRLF handled. Quoted fields with embedded commas handled. The `Definition` column is stored if non-empty (see §5.3) and ignored if empty (all of `knowt_spelling_words.csv`).
  - `Copy list` — writes the words back out as `word,definition` lines to the clipboard (`navigator.clipboard`, with a select-all textarea fallback — clipboard permissions on `file://` are inconsistent between Edge and Chrome).
  - `Export all lists (JSON)` / `Import JSON` — the escape hatch against clearing browser data.
- **Word selection** — after a list is chosen, its words render as checkable chips with `All` / `None` / `First 20`. **Only checked words enter the session.** This exists because the Knowt export is 209 words (a whole unit) while a week's assignment is ~20.
- **Settings**

  | Key | Default | Control |
  |---|---|---|
  | `roundSize` | `7` | number 1–20 |
  | `retypeOnMiss` | `true` | checkbox — *"Make him retype missed words"* |
  | `autoAdvanceMs` | `600` | number, ms after a correct answer |
  | `feedbackMs` | `1800` | number, ms a wrong answer is shown before advancing (**only used when `retypeOnMiss` is off**) |
  | `voiceURI` | `null` | `<select>` of `en-*` voices, with `Preview` button |
  | `rate` | `0.85` | range 0.5–1.2 |
  | `pin` | `''` (off) | 4-digit text field |

  `retypeOnMiss` is the one setting that changes the feel of the whole session — Quizlet's Spell just shows the answer and moves on, which is gentler but teaches less. Default on; a parent who watches a session stall can flip it off without touching code.

- **`Start session`** — disabled with 0 words checked, tooltip *"Add or select some words first."*

### 2.2 PRACTICE

```
┌──────────────────────────────────────────────┐
│  ▓▓▓▓▓▓░░░░░░░░░░░░░░░   6 / 20   Round 2    │  progress bar + counter + round
│  [◼][◼][◼][◻][◻][◻][◻][◻][◻]                 │  one tile per word, state-colored
│                                              │
│            ┌────────────────┐                │
│            │   🔊  Replay   │                │  auto-plays on prompt render
│            └────────────────┘                │
│            (definition here, if the list has one)
│                                              │
│         ┌────────────────────────┐           │
│         │ ty.pe                  │           │  text input, auto-focused
│         └────────────────────────┘           │
│                                              │
│              [ Don't know ]                  │
├──────────────────────────────────────────────┤
│  feedback region (§2.2.2)                    │
└──────────────────────────────────────────────┘
```

- **Tiles** — one per word in the session, in list order. Gray `new` → amber `familiar` (1 correct) → green `mastered` (2 in a row). A miss flips the tile back to gray. Tiles are the Quizlet Learn signature and double as the child's sense of progress.
- **Input** — `<input type="text">` with `spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off"`. **Non-negotiable:** browser spellcheck underlines the correct answer and autocorrect silently fixes the mistake, which would destroy the point of the app.
- **Hotkeys** — `R` replay, `S` slow replay (rate × 0.6), `Enter` submit, `Esc` pause. Hotkeys must not fire while the input has focus and a modifier is held.
- **Pause overlay** (`Esc`) — opaque, covers the practice screen so a paused word can't be studied off-screen. Offers `Resume` and `End session` (→ SUMMARY). `Back to setup` appears only after the PIN matches.

#### 2.2.1 Verdicts

| Outcome | Condition | Session effect |
|---|---|---|
| **Correct** | normalizes equal to expected | `streak++`; `streak >= 2` → mastered. Advance after `autoAdvanceMs` |
| **Wrong** | otherwise | `streak = 0`, `misses++`; word re-queued at the tail of the current round; show correction |
| **Don't know** | the button | same as wrong |

First attempt is the only thing that scores. The retype is a teaching step, recorded separately as `retypeMisses` so it never inflates accuracy but does surface in the summary if a word needed correcting twice.

#### 2.2.2 Feedback region

- **Correct:** the word in green, brief. Auto-advances.
- **Wrong, `retypeOnMiss` on:** the correct spelling with a **character-level diff** — the child's wrong letters in red, the right ones in green — then the input clears and relabels: *"Type it correctly to continue."* The word does not advance until the retype matches.
- **Wrong, `retypeOnMiss` off:** same diff, held for `feedbackMs`, then advance.
- A retype that is *still* wrong re-renders the diff and stays on the same word (no repeat re-queue — it is already queued from the first miss).

#### 2.2.3 The "closed screen", done properly

During practice the full word list is **not** in the DOM, not in a script variable, not in a `data-` attribute. Only the current word and its diff exist in memory. Ctrl+F on the practice screen finds nothing.

Ceiling, stated plainly: the session snapshot in `localStorage` contains the words, so a child who opens devtools → Application → Local Storage can read them. Defending that is not worth the code — see §9. Re-entering SETUP from a session requires the PIN.

### 2.3 SUMMARY

- Mastered `n / N`, first-try accuracy % (`first-attempt corrects ÷ words in session` — a retype never counts toward it), number of retypes.
- Missed words listed with their correct spellings, worst-first.
- `Practice missed only` → new PRACTICE session containing exactly those words (the engine already takes a word array, so this reuses everything).
- `Copy missed words` → clipboard (same fallback as §2.1), for the teacher or for flashcards.
- Session history: last 10 sessions for this list, one line each (`date · accuracy · mastered · worst word`).

---

## 3. Data model

All keys prefixed `spell.`. Every payload carries `v: 1`; a shape mismatch discards progress and keeps lists (§7, edge cases).

```js
// spell.lists
[{ id: "m3k9x2", name: "Chapter 7", words: ["disconnect", ...],
   defs: { disconnect: "" }, updatedAt: "2026-09-25T09:00:00.000Z" }]

// spell.settings
{ v:1, roundSize:7, retypeOnMiss:true, autoAdvanceMs:600, feedbackMs:1800,
  voiceURI:null, rate:0.85, pin:"", selected: { "<listId>": ["disconnect", ...] } }

// spell.progress.<listId>          — cumulative, survives sessions
{ v:1, words: { disconnect: { streak:0, misses:3, attempts:5, retypeMisses:1,
                              lastSeen: 1758790000000 } } }

// spell.history.<listId>           — last 10 kept
{ v:1, sessions: [{ at:"2026-09-25T09:12:00Z", total:20, mastered:20,
                    firstTry:17, retypes:3, missed:["nonremovable", ...] }] }

// spell.audio.<listId>             — RESERVED, unused in v0.1.0 (cloud-TTS mp3 cache, §5)

// spell.session                    — written on EVERY answer, for resume
{ v:1, listId:"…", words:[...], startedAt:…, round:1,
  queue:["disconnect", ...],       // remaining prompts this round
  idx:0, phase:"prompt"|"correct"|"retype"|"done",
  perWord: { disconnect: { streak:1, misses:0, attempts:1, retypeMisses:0,
                           lastSeen:…, mastered:false } },
  log: [{ word, typed, ok:true }]  // for the summary + diff replay
}
```

**Streak reset rule.** On session start, `streak` is seeded to `0` for every word and `misses` is carried over from `spell.progress`. So every session asks every selected word (correct for test prep), while a word missed in six previous sessions still ranks first and returns fastest. Cumulative `misses` is written back to progress on session end.

---

## 4. Review engine

Pure functions, no DOM, no TTS, no storage. Takes a session object, mutates it, returns it. This is the only part with real logic and the only part the self-test exercises.

```js
Engine.create(words, defs, progress, settings) -> Session
Engine.prompt(session)                         -> { word, def, remaining, round, tiles:[{word,state}] }
Engine.submit(session, typed)                  -> { status:'correct'|'wrong', expected, typed,
                                                    diff, streak, misses, advanced:bool }
Engine.submitRetype(session, typed)            -> { status:'retype-ok'|'retype-wrong', diff }
Engine.advance(session)                        -> void      // correct-answer → next prompt / next round
Engine.complete(session)                       -> bool      // every word mastered
Engine.summary(session)                        -> { total, mastered, firstTry, accuracy, retypes, missed }
WORDS.normalize(s)                     -> string    // §6; shared by submit + retype + dedupe
```

### 4.1 Word state machine

```
new ──correct──▶ familiar ──correct──▶ mastered
 ▲                  │                      │
 └────── miss ──────┴────── miss ──────────┘     (streak → 0)
```

Mastery = **two correct in a row**, reset by any miss. `mastered` words never return within the session (this matches Quizlet Learn; cross-session spacing is the deliberately skipped feature, §9).

### 4.2 Round assembly

- A round is a queue of up to `roundSize` words.
- **First round:** unmastered words sorted by `misses` desc, then `lastSeen` asc, then original list order. Never-asked words sort as `lastSeen = -Infinity`, so they lead.
- **In-round re-entry:** a miss pushes the word onto the tail of the current queue. On a 7-word round a missed word is therefore asked **twice** where a correct one is asked once — that is the frequency difference the smart review is built on.
- **Subsequent rounds:** the same comparator over remaining unmastered words. Words answered correctly last round have a fresh `lastSeen`, so they sort behind recently-missed ones: correct words come back later in the round, missed words come back first.
- **No duplicates within a round.** If fewer than `roundSize` words remain unmastered, the round is simply smaller. Late-session rounds of 1–3 words are expected and correct.
- Session ends when all words are `mastered`.

`ponytail:` plain comparator over misses/lastSeen. No SM-2, no interval math, no per-word difficulty rating. Upgrade path, if misses still leak between tests: add a decayed-spacing term to this one comparator, not a new module.

### 4.3 Normalization

`normalize()` = trim → collapse internal whitespace → fold curly `’` to `'` → compare. **Case:** case-insensitive *unless the expected word contains an uppercase letter*, in which case comparison is exact. So `America` must be capitalized but `disconnect` accepts `Disconnect`. One line, and it's the right call on the edge case.

No fuzzy matching, no "close enough", no distance threshold — it is a spelling test.

### 4.4 Diff

`lcsDiff(typed, correct)` → `{ typed: [{ch, ok}], correct: [{ch, ok}] }`, LCS dynamic-programming table with backtrack, inserting gap markers so the two rows align under each other. O(n·m) on strings under 20 characters — free.

---

## 5. Audio

```js
TTS = {
  ready()                      // resolves when the voice list is populated
  list()                       // SpeechSynthesisVoice[] filtered to en-*
  speak(text, { rate })        // resolves on 'end'; cancels any queued utterance first
}
```

- Voice pick: `settings.voiceURI` match → else first `en-US` → else first `en-` → else system default.
- `voiceschanged` listener **plus** a bounded poll, because Chromium on Windows often returns an empty list until something nudges it.
- `speechSynthesis.cancel()` before every utterance — otherwise a fast session desyncs from a queued backlog.
- The `Start session` click doubles as the browser's required user gesture for the first utterance.
- **Degraded mode:** if `speechSynthesis` is unavailable, hide replay controls and show the word itself as the prompt. The app stays fully usable.
- **Swap point (the "realistic AI voice" plan).** `speak()` checks an in-memory `SESSION_AUDIO[text]` map first and plays that URL through `new Audio()` if present. Filling that map is the entire cloud-TTS integration: pre-generate once per list (209 words ≈ 209 small mp3s), cache the URLs under `spell.audio.<listId>`, change nothing else. Left unimplemented on purpose — the browser voice is good enough to start, and this costs nothing to keep open.

Prompt render auto-plays the word. `Replay` and `R` re-speak at `rate`; `S` speaks at `rate × 0.6`.

---

## 6. File layout

```
Spelling Coach v0.1.0.html
├── <style>                       design tokens, 3 screens, tiles, diff colors, dark mode   ~250 lines
├── <body>                        setup-screen | practice-screen | summary-screen
└── <script>
    1  CONFIG      VERSION, DEFAULTS, storage keys                    ~20
    2  STORE       get/set JSON, try-catch, version guard              ~40
    3  WORDS       normalizeList, parseCSV, dedupe, chips              ~70
    4  DIFF        lcsDiff                                             ~35
    5  ENGINE      §4 — pure, DOM-free, no I/O                         ~180
    6  TTS         §5                                                  ~70
    7  PRACTICE    render loop, input, hotkeys, verdict UI             ~220
    8  SETUP       list CRUD, import/export/selection, settings, PIN   ~200
    9  SUMMARY     results, history, practice-missed                   ~90
   10  SELFTEST    assert suite, runs on ?selftest=1                   ~120
   11  BOOT        route: resume prompt vs setup                       ~30
</script>
```

Practice and setup never share DOM. `ENGINE`, `DIFF`, and `WORDS` touch no DOM, no TTS, no storage — that is what makes `?selftest=1` possible without a browser harness.

---

## 7. Edge cases

| Case | Behaviour |
|---|---|
| Empty list / nothing selected | `Start` disabled, tooltip explains |
| 1 word in the list | Round = that word; needs 2 correct → 2 rounds, then session ends |
| Duplicates in pasted text | Dropped on save (case-insensitive match), order of first appearance kept |
| Word containing spaces | Allowed (phrases). Internal whitespace collapsed on compare |
| Word with an apostrophe | Curly/straight folded. Other punctuation exact |
| Uppercase word (proper noun) | Case-sensitive compare (see §4.3) |
| Tab closed mid-session | Snapshot on every answer; on next load, *"Resume last session?"* |
| `localStorage` unavailable (private mode) | try-catch; banner *"Progress won't be saved"*; session still runs |
| Stored shape from an older version | Discard progress/history, keep lists, log to console |
| `speechSynthesis` missing | Visual prompt mode (§5) |
| Double `Enter` | Submits ignored while `phase` is not `prompt` |
| `R` while already speaking | `cancel()` then speak — no overlap, no dropped prompt |
| Child pastes the answer / inspects storage | Documented ceiling (§2.2.3). Not defended |
| Forgot PIN | `Reset PIN` button clears `settings.pin` only; lists and progress untouched |
| 209-word session | Supported, ~35 rounds. Selection UI (§2.1) is the intended path so this doesn't happen |

---

## 8. Acceptance criteria

Mapped to the original request, each independently checkable:

1. Parent enters a list on one screen; **that screen leaves the DOM** during practice and is PIN-gated to return.
2. Each word is read aloud by TTS, with replay and slow-replay.
3. The child types the answer on the keyboard and submits with `Enter`.
4. A wrong word shows the correct spelling with a letter-level diff, and (default setting on) the child must type it correctly before the session moves on.
5. Correct words return less often and less urgently than missed words, until mastery is shown, and progress persists across sessions.
6. Runs by double-click, offline, no build step, no dependencies.

## 9. Deliberately skipped

Each with the trigger that would justify building it:

| Skipped | Add when |
|---|---|
| Cross-session interval scheduling / test-date calibration | Words still miss on the test after several sessions — one comparator in §4.2 |
| Cloud AI voice now | The browser voice actually annoys the child — fill `SESSION_AUDIO`, §5 |
| Definitions as prompts | A list arrives whose `defs` are non-empty (already plumbed, §2.1) |
| Multiple children / profiles, accounts, sync | A second child needs it |
| List merge, tags, ordering UI | Two exports need combining by hand first |
| Anti-cheat beyond the PIN | Never. A child that determined has out-learned the word list |
| Sound effects, animations, install prompt, i18n | Never |

## 10. Self-test (`?selftest=1`)

Assert-based, no framework, results printed to the page. Must cover:

- `normalize` — trim, collapse spaces, curly apostrophe, case rule (both directions)
- `parseCSV` — CRLF, header skipped, quoted field with a comma, empty definition column, blank lines
- dedupe — case-insensitive, first-appearance order
- `create` — round 1 holds `min(roundSize, wordCount)` words; never-asked words lead
- `submit` correct → `streak 1` → second correct → `mastered`
- `submit` wrong → `streak 0`, `misses++`, word appended to tail of queue
- mastery resets on a miss after a correct
- round 2 exists only while unmastered words remain; `complete()` false until all mastered
- comparator: a 3-miss word precedes a 1-miss word; a just-seen word sorts behind an old one
- `summary` — accuracy counts first attempts only, retypes counted separately
- `lcsDiff` — inserted, deleted, and substituted characters each mark the right spans
- `VERSION` appears in `location.pathname`
- storage version guard — a `v:0` payload is discarded, not thrown on

## 11. Build phases

| Phase | Deliverable | Acceptance |
|---|---|---|
| 0 | Folder, `git init`, this spec committed | `git log` shows the spec |
| 1 | Shell + SETUP + STORE + WORDS (list CRUD, paste, CSV import, export) | Paste 20 words and the 209-word Knowt CSV; both survive reload; CRUD works |
| 2 | ENGINE + DIFF + `?selftest=1` | Every assert green; script runnable headless via a temporary debug flag that reveals the word |
| 3 | PRACTICE screen — tiles, input, verdicts, retype loop | Full session playable with keyboard only; both `retypeOnMiss` paths correct |
| 4 | TTS + replay/slow + voice picker + degraded mode | Word spoken on every prompt and on `R`; first-click unlock verified; missing-voice fallback verified |
| 5 | SUMMARY + history + practice-missed-only + persistence | Finish, reload, progress and history survive; "missed only" starts a correct sub-session |
| 6 | PIN gate, resume-mid-session, hotkeys, polish, a11y pass | Setup unreachable mid-session without the PIN; resume restores an interrupted session |

Each phase leaves the file double-clickable and working.

## 12. Manual verification checklist (before calling it done)

- [ ] Double-click the file from Explorer — no console errors
- [ ] Import `Desktop/knowt_spelling_words.csv` → 209 words, no header row, no blanks
- [ ] Select First 20 → Start → practice screen shows 20 tiles
- [ ] Word is audible before the input is focused
- [ ] Miss three words deliberately; confirm each is re-asked within the same round
- [ ] Confirm the retype gate blocks progress until typed correctly
- [ ] Toggle `retypeOnMiss` off; confirm the wrong answer shows then auto-advances
- [ ] Ctrl+F on the practice screen does not find a later word
- [ ] Finish the session; summary numbers match what actually happened
- [ ] Close the tab mid-session, reopen, resume restores the same word and tile states
- [ ] `?selftest=1` all green
- [ ] Open in Edge **and** Chrome (voice behaviour differs between them)
