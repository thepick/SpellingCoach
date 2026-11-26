# WordLab

Spelling and vocabulary practice for lists of up to 200 words. The app runs in the browser and keeps learning records on the device.

- **Spelling** reads a word aloud and checks the typed spelling.
- **Vocabulary** practices meanings and usage with six question types across the learning modes.
- **Mixed practice** covers both skills in one session.
- **Flashcards** support pronunciation, definition-first study, and a filter for unfamiliar words.

Choose **Test** for a fixed set of questions with results at the end. Only approved vocabulary can appear on a test. Dictation tests require speech synthesis. This is a classroom practice tool and students can access local browser data.

## Open the app

Open [WordLab](https://wordlab.mtomlinson.ca/). For the offline build, open `WordLab v0.2.0.html` in a current browser. Offline speech depends on the installed voice. The app version appears at the bottom of **Tools**.

The **Theme** menu defaults to **System** and follows device appearance changes. Choose **Light** or **Dark** to save a manual preference.

Use **Try the sample list** for a Grade 5 vocabulary draft. Its definitions use selected senses because the source passage was unavailable. Review them against the intended text before using the pack for a test.

Teacher access is invitation-only. The site owner creates a private, single-use invitation link. The invited teacher chooses a username and password, then opens **Tools → API keys**. The same **API keys** form is also available under **Teacher settings**. Groq supplies vocabulary text; OpenRouter is required for Paul audio and can also supply backup vocabulary text. Keys are encrypted on the server and excluded from backups and student links. The hosting operator is trusted to handle these keys. Teachers can replace or remove their keys and test authentication without generating text or audio. The owner can revoke invitations or teacher access. See the [Worker setup](worker/README.md) for the encryption secret and deployment requirements.

Open **Grade defaults** to customize reusable presets for grades 3 through 12. Each starts with its grade as the reading level, one example and one practice sentence per word, and plain-English definitions. These are starting settings, not a curriculum alignment. Preset changes apply to future selections; existing sets keep their own copies. Textbook context belongs to the individual set and is never copied into a reusable preset.

Create a set, choose its grade preset, paste the words, and save. WordLab saves a private server copy and automatically prepares a Paul WAV for each word. Paul (`en_paul_neutral`, Voxtral Mini TTS) through OpenRouter is the only voice used for new speech generation. Speech generation uses paid OpenRouter credits. **Prepared recordings** shows progress, recording previews, and errors; retry prepares only missing recordings. Matching Paul clips can reuse the same teacher's saved audio. Background preparation continues after the browser closes. Another teacher's generation never falls back to the owner's API keys. Older published recordings remain available; deployment does not bill a bulk replacement.

Optionally prepare vocabulary sentences and audio for the set. Check the set's own reading level, sentence counts and context before generating. Drafts save automatically and appear immediately as expandable word rows in Prepare & share, with Listen buttons for prepared Paul recordings and inline editing, saving, and approval. WordLab prepares complete example sentences for studying and separate recordings that say "blank" for practice questions. Review and approve vocabulary before sharing it. Editing settings alone does not rewrite approved content. Sentence edits prepare matching recordings while preserving unchanged Paul clips. Paid vocabulary text backup has a separate permission from audio generation.

Open **Prepare & share**, select the practice mode, and adjust **Practice options** only when needed. Review vocabulary as student content; choose **Edit wording** to change it. Approving advances to the next draft. Unsaved changes are protected when navigating away. Spelling-only sharing needs just the word recordings. Vocabulary and Mixed sharing need approved content and matching recordings. Choose **Create student link** and copy the link when the required recordings are ready. Students can open it without a class code and replay stored audio without a provider request. Vocabulary assignments also offer flashcard study. **Preview draft (device voice)** opens the unpublished draft with temporary progress; **Preview shared set** opens the current published link. Private edits reach students only after **Update student link**. Older published sets retain device speech when recordings were not prepared. Public links offer **Continue practice** for an unfinished session.

New and updated links save their teaching rules with the assignment. Student device preferences cannot override those explicit rules, including during missed-word follow-up practice. Correction retyping applies to spelling/dictation; vocabulary keeps its guided correction steps. The variant setting keeps its existing vocabulary/test scope and does not relax pure spelling answers. Older links still work; choose **Update student link** to attach explicit teaching rules.

Mixed practice runs through the whole set in three stages: spelling, vocabulary with a word bank, then vocabulary without choices. Each word needs one correct unhinted answer in each stage. Missed or hinted answers retry within that stage; completed spelling does not repeat. Vocabulary-only practice uses the two vocabulary stages. Older unfinished practice sessions keep their successful answers when they resume with the shorter sequence.

Use **Tools → Export full backup** before clearing browser data or moving to a different web address or offline file. Browser storage is tied to the address or file. Import the backup in WordLab to carry over your lists and progress. The app accepts older list-only JSON files, new vocabulary packs, and full backups. The first upgrade keeps a copy of the original spelling state in the browser under `spell.state.v1.backup`.

Tools keeps **Backup and restore** prominent, followed by a separate **API keys** section for Groq and OpenRouter. Student pages hide teacher controls. Teachers can open **Grade defaults** here; **Recover saved sets** is collapsed because it replaces browser copies with server copies. **Test saved keys** checks the keys already stored on the server; replacement and removal options are collapsed. Failed saves retain typed keys for retry. API keys require **Save keys**; local practice preferences save automatically.

The parent access PIN has been removed. Older saved PIN settings are ignored without deleting lists or progress. Offline Tools retains collapsed local teaching rules, round size and feedback delays. Device voice and local playback speed appear where they apply; shared recordings use their own slow-play control. New online recordings use Paul. Shared-set practice rules belong to each set under **Prepare & share → Practice options**.

Choose **Shuffle word order** or **Shuffle cards** to shuffle immediately on your device, including offline. **Undo shuffle** restores the previous order. Shuffling preserves the selected words, vocabulary, recordings and progress; saved teacher sets sync the new order privately. A randomized test can still import an optional completed RANDOM.ORG permutation receipt; tests otherwise use their prepared order.

Practice pages show how many words are fully mastered, with a progress bar that reaches 100% only when every word meets the session’s mastery requirements. Pausing and resuming preserves that progress. Published recordings download completely before playing; Replay reuses the most recent completed clip, and navigation cancels unfinished playback.

## Build and verify

Use Node.js 24 or later.

```sh
node scripts/build.cjs
node scripts/build.cjs --check
node --test
```

Open a built page with `?selftest` to run the isolated browser regression checks. The teacher, student and offline HTML files are generated from `src/`; edit the source files and then rebuild. Tools shows a build identifier; `release.json` records the exact generated assets.

The QR encoder is the MIT-licensed browser distribution from [qrcode-generator v2.0.4](https://github.com/kazuhikoarase/qrcode-generator/tree/83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8). It generates images locally.

## Optional online tools

Invited teachers can generate and review vocabulary and distribute their own approved packs once the [Cloudflare Worker](worker/README.md) is configured. The owner manages invitations, class codes, and service settings. Manual editing, imports, practice, tests, and reports work without the Worker.

Student generation ships disabled. Enable it only after the provider and school approve the intended use. Review generated content before sharing; paid audio and any enabled paid vocabulary models use the teacher's provider credits.

## Website cutover

The WordLab configuration hosts the teacher page, `/practice/`, and `/api/` on one Cloudflare Workers custom domain. Stage the static files from the repository root with `node scripts/build.cjs --stage`, then use `worker/wrangler.wordlab.jsonc` when deploying and configuring Worker secrets. The separate Spelling Coach site can keep its existing hosting. Saved browser data can move across domains through a full backup. [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

The current branch is `feature/vocabulary-engine`; `master` is the legacy app. Follow [AGENTS.md](AGENTS.md) for releases. Push and deploy the same tested tree, then run `node scripts/verify-live.cjs` to compare the live teacher, student and offline pages and check the API. Refresh an already-open tab after saving work to load the new build.

Phones and tablets use a dedicated practice layout that keeps Listen, the answer field, and Check answer together inside the visible screen, including when the on-screen keyboard changes the available height.
