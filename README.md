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

To use Troy for dictation, sign in as a teacher through **Tools → Online generation and sharing**. Then open **Vocabulary content**, choose a word, enter a sentence that uses its exact form, and choose **Generate and attach Troy audio**. Listen to the result before the lesson. You can also attach your own PCM WAV file. Recordings are tied to the word and its saved meaning in that list. WordLab uses the recording for dictation and falls back to browser speech. Recordings stay on this device, so keep the WAV files for transfer or reuse.

Sign in at the WordLab home page to create and edit sets. Open **Share set** to choose a practice mode and whether to allow hints. If vocabulary needs review, open the entries directly and use **Back to sharing** when ready. **Preview as student** opens the assignment before publishing with temporary practice progress. After publishing, select **Prepare Troy audio** to save recordings to the set, then copy the student link. Students replay those recordings without a provider request. Public links use the published practice mode and hint setting, open the Ready screen directly, and show **Continue practice** when that browser has an unfinished session.

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

Teachers can generate and review vocabulary, distribute approved packs, and manage class codes once the [Cloudflare Worker](worker/README.md) is configured. Manual editing, imports, practice, tests, and reports work without the Worker.

Student generation ships disabled. Enable it only after the provider and school approve the intended use. Keep the deployment on free plans and review generated content before publishing.

## Website cutover

The WordLab configuration hosts the teacher page, `/practice/`, and `/api/` on one Cloudflare Workers custom domain. Stage the static files from the repository root with `node scripts/build.cjs --stage`, then use `worker/wrangler.wordlab.jsonc` when deploying and configuring Worker secrets. The separate Spelling Coach site can keep its existing hosting. Saved browser data can move across domains through a full backup. [Cloudflare Workers custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
