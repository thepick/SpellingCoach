# SpellingCoach

Spelling and vocabulary practice for lists of up to 200 words. The app runs in the browser and keeps learning records on the device.

- **Spelling** reads a word aloud and checks the typed spelling.
- **Vocabulary** practices meanings and usage with six question types across the learning modes.
- **Mixed practice** covers both skills in one session.
- **Flashcards** support pronunciation, definition-first study, and a filter for unfamiliar words.

Choose **Test** for a fixed set of questions with results at the end. Only approved vocabulary can appear on a test. Dictation tests require speech synthesis. This is a classroom practice tool and students can access local browser data.

## Open the app

The live site is [spellingcoach.mtomlinson.ca](https://spellingcoach.mtomlinson.ca/). For the v0.2.0 offline build, open `Spelling Coach v0.2.0.html` in a current browser. Offline speech depends on the installed voice. The v0.1.0 file remains in the repository for rollback.

Use **Try the sample list** for a Grade 5 vocabulary draft. Its definitions use selected senses because the source passage was unavailable. Review them against the intended text before using the pack for a test.

Use **Tools → Export full backup** before clearing browser data or moving between the site and a downloaded copy. The app accepts older list-only JSON files, new vocabulary packs, and full backups. The first upgrade keeps a copy of the original spelling state in the browser under `spell.state.v1.backup`.

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
