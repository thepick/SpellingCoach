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

Teacher access is invitation-only. The site owner creates a private, single-use invitation link. The invited teacher chooses a username and password, then opens **AI setup**. Groq supplies vocabulary text; OpenRouter is required for Paul audio and can also supply backup vocabulary text. Keys are encrypted on the server and excluded from backups and student links. The hosting operator is trusted to handle these keys. Teachers can replace or remove their keys and test authentication without generating text or audio. The owner can revoke invitations or teacher access. See the [Worker setup](worker/README.md) for the encryption secret and deployment requirements.

Open **Grade defaults** to customize reusable presets for grades 3 through 12. Each starts with its grade as the reading level, one example and one practice sentence per word, and plain-English definitions. These are starting settings, not a curriculum alignment. Preset changes apply to future selections; existing sets keep their own copies. Textbook context belongs to the individual set and is never copied into a reusable preset.

Create a set, choose its grade preset, paste the words, and save. WordLab saves a private server copy and automatically prepares a Paul WAV for each word. Paul (`en_paul_neutral`, Voxtral Mini TTS) through OpenRouter is the only voice used for new speech generation. Speech generation uses paid OpenRouter credits. **Prepared recordings** shows progress, recording previews, and errors; retry prepares only missing recordings. Matching Paul clips can reuse the same teacher's saved audio. Background preparation continues after the browser closes. Another teacher's generation never falls back to the owner's API keys. Older published recordings remain available; deployment does not bill a bulk replacement.

Optionally prepare vocabulary sentences and audio for the set. Check the set's own reading level, sentence counts and context before generating. Drafts save automatically, and WordLab prepares complete example sentences for studying and separate recordings that say "blank" for practice questions. Review and approve vocabulary before sharing it. Editing settings alone does not rewrite approved content. Sentence edits prepare matching recordings while preserving unchanged Paul clips. Paid vocabulary text backup has a separate permission from audio generation.

Choose **Create student link**, select the practice mode and hint setting, and preview the set. Spelling-only sharing needs just the word recordings. Vocabulary and Mixed sharing need approved content and matching recordings. Copy the student link when the required recordings are ready. Students can open this link without a class code and replay stored audio without a provider request. Vocabulary assignments also offer flashcard study. **Preview as student** opens a local draft with temporary progress and an explicit device-voice notice; use recording previews to check generated voices. Older published sets retain device speech when recordings were not prepared. Public links use their published practice mode and hint setting and offer **Continue practice** for an unfinished session.

In Mixed practice, mastering a word requires two correct dictations, one correctly typed answer with a word bank, and two correctly typed answers without the bank. A missed or hinted answer resets the current phase's streak and brings the word back for another attempt.

Use **Tools → Export full backup** before clearing browser data or moving to a different web address or offline file. Browser storage is tied to the address or file. Import the backup in WordLab to carry over your lists and progress. The app accepts older list-only JSON files, new vocabulary packs, and full backups. The first upgrade keeps a copy of the original spelling state in the browser under `spell.state.v1.backup`.

To shuffle a saved word list, flashcards, or a test, use a completed RANDOM.ORG permutation receipt with each position from 1 through the number of items. A test can run in its prepared order without a receipt. The app maps the numbers to content on the device.

## Build and verify

Use Node.js 24 or later.

```sh
node scripts/build.cjs
node scripts/build.cjs --check
node --test
```

Open either built page with `?selftest` to run the isolated browser regression checks. The two HTML files are generated from `src/`; edit the source files and then rebuild.

The QR encoder is the MIT-licensed browser distribution from [qrcode-generator v2.0.4](https://github.com/kazuhikoarase/qrcode-generator/tree/83b7e8fe3fddd3b0368dbafd6ce56995bd25e3c8). It generates images locally.

## Optional online tools

Invited teachers can generate and review vocabulary and distribute their own approved packs once the [Cloudflare Worker](worker/README.md) is configured. The owner manages invitations, class codes, and service settings. Manual editing, imports, practice, tests, and reports work without the Worker.

Student generation ships disabled. Enable it only after the provider and school approve the intended use. Review generated content before sharing; paid audio and any enabled paid vocabulary models use the teacher's provider credits.

## Website cutover

The WordLab configuration hosts the teacher page, `/practice/`, and `/api/` on one Cloudflare Workers custom domain. Stage the static files from the repository root with `node scripts/build.cjs --stage`, then use `worker/wrangler.wordlab.jsonc` when deploying and configuring Worker secrets. The separate Spelling Coach site can keep its existing hosting. Saved browser data can move across domains through a full backup. [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
