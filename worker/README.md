# WordLab vocabulary service

The Worker serves the existing static site. One SQLite-backed Durable Object stores approved packs, privately scoped drafts, class access, quota counters and in-flight reservations. The frontend keeps the learner's lists, practice history, mastery and assessments on the learner's device. Provider requests contain the target words and generation settings. Teacher-only context should contain textbook material with personal information removed.

## Local checks

From the repository root, run the Node 24 test suite. It uses a temporary SQLite database per test, with simulated provider responses.

~~~sh
node --test worker/service.test.mjs
~~~

From this directory, use Wrangler 4 to bundle or start the Worker locally. These commands use the checked-in SQLite configuration.

~~~sh
npx wrangler deploy --dry-run --outdir .wrangler/bundle
npx wrangler dev --local --ip 127.0.0.1
~~~

For local login testing, define distinct dummy values of at least 32 characters in the ignored .dev.vars file. Add the exact local website origin to ALLOWED_ORIGINS when testing browser requests. To test teacher generation with a dedicated development key, set the same flags described below once the development account's free tier is confirmed. The checked-in settings leave provider calls and student generation disabled.

## Production setup

### Invited teachers and personal provider keys

The WordLab deployment enables teacher vocabulary drafting (`AI_ENABLED=true`) and leaves student generation disabled. An owner can pause drafting in the operator settings. To stop all future provider calls at deployment, set both `AI_ENABLED` and `AUDIO_ENABLED` to false. Calls already accepted by a provider cannot be recalled.

Before teachers save keys, configure `TEACHER_KEY_ENCRYPTION_SECRET` as a Cloudflare Worker secret with at least 32 securely generated characters. Keep it distinct from `SESSION_SIGNING_SECRET` and `ADMIN_AUTH_SECRET`. Use the already installed Wrangler command with `--config wrangler.wordlab.jsonc` to set it; do not put its value in a command, source file, or shared log. Back up the encryption secret securely. Changing or losing it makes saved keys unreadable: profiles report `reconnect` and teachers must enter their keys again. There is no automatic migration across encryption secrets.

The existing owner password and operator bearer secret retain administrator access and ownership of legacy packs. The owner creates invitations in the teacher account panel and copies each link manually. Invitations expire after seven days, can be revoked, and can be redeemed once. Teachers choose a unique case-insensitive username and a password of at least 12 characters. Passwords are stored with a random salt and PBKDF2-SHA-256 (100,000 iterations). Teacher sessions last seven days; revoking a teacher invalidates their sessions, cancels pending text jobs, and stops future audio calls. Published student links remain readable after teacher revocation.

Provider keys are encrypted with AES-GCM and authenticated against the stable teacher ID and provider name. Keys are never included in profile responses, packs, jobs, exports, or student links. Ordinary teachers only use their own keys. The host can decrypt those keys for requests and remains responsible for hosting and storage costs. Key replacement, deletion, settings changes, revocation, and set changes are checked again before accepting an in-flight result.

The owner can also replace, remove, and test keys in the account panel. Until a provider is explicitly configured there, the owner's legacy environment key remains its default. Explicitly deleting an owner provider key disables it and does not restore the environment key. Encrypted owner configuration uses the same encryption secret as invited teachers.

Saved/decryptable key status does not prove provider authentication. The connection test uses only Groq's unbilled `GET /openai/v1/models` and OpenRouter's `GET /api/v1/key`, returning `connected`, `missing`, `invalid`, or `unavailable` without provider response details. It generates no text or audio and makes no paid validation requests.

Private saves automatically queue missing word, full-example, and blank-question WAVs. Cache entries are scoped to teacher and exact spoken text, prompt kind, provider, model, and voice; reordering a set reuses matching clips. Save requests use `{pack, expectedVersion}`: send 0 for a new set and the last server version for an edit. Changed content also requires an increased `pack.version`; identical same-version saves are idempotent. A stale `expectedVersion` returns 409 even if the proposed version jumps ahead. Failed recordings remain visible and can be retried. Invalid or missing keys pause the remaining recordings; replacing a key resumes recoverable failures while preserving successful clips and daily charges. Deleting a private set removes its queue and cannot resurrect an in-flight result; it preserves already published links and recordings.

New publications backed by private sets require every recording for the selected mode and carry `preparedAudio:true`. A spelling share excludes unapproved vocabulary. Existing packs without this flag retain their previous playback behavior. Publishing copies only recordings matching the saved snapshot; student playback never generates a provider request.

Paul is the sole voice for new recordings: the OpenRouter speech endpoint with `mistralai/voxtral-mini-tts-2603` and `en_paul_neutral`. Every teacher, including the owner, needs an effective OpenRouter key. Groq keys remain available for vocabulary text only. Audio is paid OpenRouter usage; the old `allowAlternateAudio` boolean is accepted for older clients but has no effect and is omitted from profile settings. There is no alternate speech provider or voice dispatch. OpenRouter vocabulary fallback uses `openrouter/free` with zero-price ceilings and validates returned JSON locally; an explicitly enabled paid text fallback uses `openai/gpt-4.1-mini`. The separate `allowPaidText` setting does not control Paul audio.

`AUDIO_ENABLED=true` enables new audio requests independently of the vocabulary drafting pause. Set it false to stop new synthesis; existing recordings remain playable. The retired `TROY_AUDIO_ENABLED` binding has no effect. Successful PCM responses are checked and wrapped as 24 kHz mono 16-bit WAVs. Audio input over 200 characters fails with an editable error and is never truncated. New and resaved private sets reuse only matching Paul cache entries. Existing published WAVs are retained; this change does not bulk-regenerate or replace them.

Ordinary text generation retains per-teacher reservations, daily meters and model delays. WordLab imposes no per-minute or daily cap on Paul audio. Each dispatched speech request is still counted in daily usage, including historical owner usage. Missing keys fail before a provider call. Reading a private set wakes an existing daily-cap wait; the owner can retry legacy public queues to resume them early. Provider throttling still pauses and retries audio preparation; saved recordings are reused without another synthesis request. Provider availability, billing, key validity, production Worker CPU/storage limits, and live voice quality still require a deployment pilot. The local suite uses simulated providers and stored WAV fixtures.

Teacher preferences are private grade presets. `GET /teacher/preferences` returns `{presets:{"3":settings,...,"12":settings}}`; unsaved grades are computed with the grade as reading level, one practice sentence, one example sentence, original spelling dialect, ESL/distractors/explanations/reuse enabled, and empty context/sense. `PUT /teacher/preferences` accepts `{grade,settings}` for grades 3 through 12, merges supplied fields with the selected grade's latest preset or defaults, validates the result, and rejects nonempty context or sense. It writes only the selected preset into the current account record without changing credentials or their revision.

Private set saves optionally accept `generationSettings`, returned alongside the pack and audio status. Context and sense belong to this set metadata, not grade presets or the public pack format. Omitting metadata retains its previous value. Changing settings requires a higher pack version and matching `expectedVersion`; identical retries remain idempotent. These metadata edits preserve existing matching audio.

Provider references checked for this implementation: [OpenRouter free router](https://openrouter.ai/docs/guides/routing/model-variants/free), [OpenRouter speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts), and the [current speech model/voice catalog](https://openrouter.ai/api/v1/audio/speech/models). The catalog listed Voxtral with `en_paul_neutral` and PCM; it did not list the initially considered OpenAI TTS model, so that model is not used. PCM's pinned sample rate follows Mistral's [Voxtral TTS demo](https://huggingface.co/spaces/mistralai/voxtral-tts-demo/commit/478642e0819b005da9fce821e43745194dfa895a). Live paid synthesis was not exercised.

### Legacy operator setup

The `wrangler.wordlab.jsonc` configuration connects the WordLab website and API to the same custom domain. Use `node scripts/build.cjs --stage` from the repository root before deploying it. Run the deployment and secret commands below from `worker/` with `--config wrangler.wordlab.jsonc` for that combined deployment. The default Wrangler configuration runs the API separately.

1. Choose a Cloudflare Workers Free account and the approved Worker name. The SQLite migration in wrangler.jsonc creates the vocabulary coordinator. Keep its class name and singleton name stable to retain published packs and job data.
2. Create a dedicated Groq Free organization or project for WordLab. Use distinct development and production keys. Confirm the plan, keep it out of any organization with paid usage enabled, and enable Zero Data Retention where available. Groq uses the same inference endpoint across plans, so the operator's account confirmation is required before the project flag is enabled. [Groq rate limits](https://console.groq.com/docs/rate-limits), [Groq data controls](https://console.groq.com/docs/your-data), [Cloudflare Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
3. Deploy the baseline Worker with AI_ENABLED, STUDENT_AI_ENABLED and both provider confirmation flags set to false. Set ADMIN_AUTH_SECRET and SESSION_SIGNING_SECRET to separate securely generated values of at least 32 characters using Worker secrets. Upload the dedicated GROQ_API_KEY as a Worker secret when the free account is verified. For example, from this directory:

   ~~~sh
   npx wrangler deploy
   npx wrangler secret put ADMIN_AUTH_SECRET
   npx wrangler secret put SESSION_SIGNING_SECRET
   npx wrangler secret put GROQ_API_KEY
   ~~~

4. Add only the exact frontend origins you control to ALLOWED_ORIGINS. The checked-in origins are the planned WordLab site and the original Spelling Coach site. Use the workers.dev URL during testing. Set the frontend's service origin to the verified Worker URL, or configure the approved API custom domain when ready. Confirm /api/health, /api/config, teacher sign-in, private pack access and a public pack preview before enabling generation.
5. Set GROQ_FREE_TIER_CONFIRMED and AI_ENABLED to true after confirmation. The initial Groq model order is GPT-OSS 120B, GPT-OSS 20B and Qwen 3.8 27B. Override it with the GROQ_MODELS environment variable or teacher settings using the supported model IDs only. Keep STUDENT_AI_ENABLED false until the school and provider explicitly approve student-initiated generation. [Groq service agreement](https://console.groq.com/docs/legal/services-agreement), [Groq structured outputs](https://console.groq.com/docs/structured-outputs), [OpenRouter terms](https://openrouter.ai/terms/)
6. If you decide to enable teacher-only OpenRouter fallback, verify a zero-cost endpoint and approved provider first. Configure OPENROUTER_API_KEY as a Worker secret, OPENROUTER_FREE_TIER_CONFIRMED as true, OPENROUTER_FREE_MODEL as an approved GPT-OSS :free variant and OPENROUTER_APPROVED_PROVIDER as the provider slug. The request enforces the provider allowlist and a zero-price ceiling. [OpenRouter provider selection](https://learn.openrouter.ai/courses/control-routing/provider-selection)
7. Run a teacher-only pilot with the actual vocabulary samples. Record validity, instructional quality, latency, token consumption and 429 behavior across the candidate models and available batch sizes. Verify a 200-word job and a repeated approved-cache request against the deployed service, and record any free-plan limit reached. Teacher approval is required before classroom sharing.

Set AUDIO_ENABLED to true and connect an OpenRouter key to enable teacher-only Paul preparation while leaving AI_ENABLED and STUDENT_AI_ENABLED false. For deploy-time shutdown of all provider calls, set both AI_ENABLED and AUDIO_ENABLED to false. An inference already accepted by a provider can finish. Local practice and saved pack audio operate independently.

Changing ADMIN_AUTH_SECRET blocks the old credential from creating new teacher sessions. Changing SESSION_SIGNING_SECRET immediately invalidates signed sessions and existing class codes. Rotate each class code afterward. Store both secrets outside the repository and use a password manager for the teacher credential.

## API

Every path below starts with /api. Send a JSON body where specified. Signed teacher and classroom sessions use Authorization: Bearer <token>. CLI automation can authenticate with the teacher secret as its bearer; browser tools exchange it for a two-hour token. An optional Idempotency-Key on generation and regeneration requests safely returns the same job when the request is repeated.

| Method and path | Purpose |
| --- | --- |
| GET /health | Basic availability and API version |
| GET /config | Read public feature flags, input limits and defaults |
| POST /admin/access | Exchange a teacher secret for a signed session |
| POST /teacher/login | Sign in an invited teacher with username and password |
| POST /teacher/accept | Redeem a single-use invitation and choose teacher credentials |
| GET /teacher/profile | Read stable identity, effective key presence, settings and feature availability |
| PUT /teacher/keys | Replace or delete encrypted personal keys and set the paid text option |
| GET or PUT /teacher/preferences | Read or update private grade 3-12 generation presets |
| POST /teacher/testkeys | Check effective keys using unbilled provider authentication endpoints |
| GET or POST /teacher/sets | List full owned private sets or save a versioned pack and queue missing recordings |
| GET or DELETE /teacher/sets/{id} | Load or delete an owned private set; published links are preserved |
| POST /teacher/sets/{id}/retry | Retry only recordings that are not ready |
| GET /teacher/sets/{id}/audio/{prompt} | Authenticated playback of a current owned manifest recording |
| GET or POST /admin/invitations | Owner-only invitation listing and issuance |
| POST /admin/revokeinvite | Owner-only invitation revocation |
| GET /admin/teachers | Owner-only account listing without credentials |
| POST /admin/revoketeacher | Owner-only teacher revocation |
| POST /access | Exchange a classroom code for a signed session. Supply the previousToken from the same class to reopen the session's private jobs after expiry. |
| POST /generate | Create a job with words and settings |
| POST /regenerate | Regenerate a word or selected definition, examples, distractors or cloze question |
| GET /jobs/{id} | Read completed words, failures and pending counts |
| POST /jobs/{id}/{step,pause,resume,cancel} | Work on one batch or change job state |
| GET /packs/{id} | Read the current pack, its published practice settings and the saved audio manifest if authorized |
| GET /packs/{id}/audio/{version}/{prompt} | Play a saved WAV with the same access as the pack |
| POST /admin/publish | Publish an approved pack with public, class or private visibility |
| GET /admin/packs | List pack summaries |
| GET or POST /admin/classes | List, create, revoke or rotate classroom codes |
| POST /admin/dictation | Generate a Paul WAV from a teacher-provided sentence using the exact target word |
| POST /admin/packaudio | Prepare and save a Paul WAV for a prompt from the published pack |
| GET /admin/usage | Read UTC-day usage, cache counts and recent jobs |
| PUT /admin/settings | Set generationEnabled or the ordered groqModels allowlist |
| DELETE /admin/cache?word={word} | Remove cached versions of a word |

Generation jobs checkpoint each valid batch. Missing or invalid responses are retried in smaller batches. Use resume after a pause and regenerate for a failed item after a job completes. Jobs remain available for seven days. Reservations limit free provider calls to two concurrent requests, 200 calls per UTC day and a 150,000-token budget. An ambiguous provider failure retains the conservative reservation for that day.

An approved pack can contain spelling-only words alongside approved vocabulary. Publishing a changed pack requires a higher version. A public pack can be reused by generation when the publish request includes cacheSettings matching its content and the teacher confirms the content is generic. Context-specific jobs and unapproved drafts stay out of the shared cache. Approved content is reused per word and context; a fully cached list consumes no provider calls. When regenerating a single cloze question, the service sends only the information needed to replace that question and preserves the prior question ID.

The local test suite exercises simulated inference, retry delays and a 200-word job. Live Groq and OpenRouter output, physical devices, account billing settings and production Cloudflare CPU and storage usage require the deployment and pilot checks above.
## Image storage

The WordLab deployment uses a private R2 bucket named `wordlab-images`, bound as `WORDLAB_IMAGES` in `wrangler.wordlab.jsonc`. Provision the bucket in the existing Cloudflare account before deploying this configuration:

```sh
wrangler r2 bucket create wordlab-images
wrangler deploy --config worker/wrangler.wordlab.jsonc
```

Keep the bucket private. Browser requests pass through authenticated WordLab routes; no R2 browser keys or public bucket URL are needed. Public assignment images are shareable through their published pack; class images require the pack's class authorization. Responses use `no-store` and bearer tokens are never placed in image URLs.

`IMAGE_IMPORTS_ENABLED=false` prevents new image uploads while retaining access to existing images and compatible packs. `IMAGE_OWNER_QUOTA_MB` defaults to 250. The service exposes `packFormats: [1,2]` and `imagesEnabled` in `/api/config`. Version 1 packs stay readable; version 2 adds image references, entry IDs, prompt preferences, and image display settings. Image bytes are never put in pack JSON or localStorage.

Images use owner-scoped immutable objects. Upload sessions reserve quota, validate hashes, dimensions, format and decoded content, and expire after one day. Raw uploads are bounded separately from JSON requests. The existing Durable Object owns authorization, metadata and references; binary uploads are limited to 1 MB and processed one at a time by the client. A daily alarm cleans abandoned objects after seven days, with reference checks and a deletion state that prevents concurrent attachment. Cleanup rotates its scan so referenced older objects do not starve abandoned ones.

The decoder accepts the browser's normalized JPEG or noninterlaced 8-bit RGB/RGBA PNG output. PNG chunks/CRC, decompressed scanline bounds and filters are checked; JPEG pixels are decoded with explicit resolution/memory bounds. WebP originals are converted in the browser before upload. Neither SVG nor animated images are stored. Prepared speech supports the existing 300-character vocabulary text limit and bounded WAVs up to 2 MB; the manual dictation form retains its 200-character input limit.

Deploy the generated teacher, student and offline pages with the matching Worker. Do not roll back to a server that rejects v2 packs after image sets have been created. Disabling new imports is the safe first response to a media incident. No existing Durable Object binding, identity, migration or secret changes are needed.
