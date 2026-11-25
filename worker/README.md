# SpellingCoach vocabulary service

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

1. Choose a Cloudflare Workers Free account and the approved Worker name. The SQLite migration in wrangler.jsonc creates the vocabulary coordinator. Keep its class name and singleton name stable to retain published packs and job data.
2. Create a dedicated Groq Free organization or project for SpellingCoach. Use distinct development and production keys. Confirm the plan, keep it out of any organization with paid usage enabled, and enable Zero Data Retention where available. Groq uses the same inference endpoint across plans, so the operator's account confirmation is required before the project flag is enabled. [Groq rate limits](https://console.groq.com/docs/rate-limits), [Groq data controls](https://console.groq.com/docs/your-data), [Cloudflare Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
3. Deploy the baseline Worker with AI_ENABLED, STUDENT_AI_ENABLED and both provider confirmation flags set to false. Set ADMIN_AUTH_SECRET and SESSION_SIGNING_SECRET to separate securely generated values of at least 32 characters using Worker secrets. Upload the dedicated GROQ_API_KEY as a Worker secret when the free account is verified. For example, from this directory:

   ~~~sh
   npx wrangler deploy
   npx wrangler secret put ADMIN_AUTH_SECRET
   npx wrangler secret put SESSION_SIGNING_SECRET
   npx wrangler secret put GROQ_API_KEY
   ~~~

4. Add only the exact frontend origins you control to ALLOWED_ORIGINS. The checked-in origin is https://spellingcoach.mtomlinson.ca. Use the workers.dev URL during testing. Set the frontend's service origin to the verified Worker URL, or configure the approved API custom domain when ready. Confirm /api/health, /api/config, teacher sign-in, private pack access and a public pack preview before enabling generation.
5. Set GROQ_FREE_TIER_CONFIRMED and AI_ENABLED to true after confirmation. The initial Groq model order is GPT-OSS 120B, GPT-OSS 20B and Qwen 3.8 27B. Override it with the GROQ_MODELS environment variable or teacher settings using the supported model IDs only. Keep STUDENT_AI_ENABLED false until the school and provider explicitly approve student-initiated generation. [Groq service agreement](https://console.groq.com/docs/legal/services-agreement), [Groq structured outputs](https://console.groq.com/docs/structured-outputs), [OpenRouter terms](https://openrouter.ai/terms/)
6. If you decide to enable teacher-only OpenRouter fallback, verify a zero-cost endpoint and approved provider first. Configure OPENROUTER_API_KEY as a Worker secret, OPENROUTER_FREE_TIER_CONFIRMED as true, OPENROUTER_FREE_MODEL as an approved GPT-OSS :free variant and OPENROUTER_APPROVED_PROVIDER as the provider slug. The request enforces the provider allowlist and a zero-price ceiling. [OpenRouter provider selection](https://learn.openrouter.ai/courses/control-routing/provider-selection)
7. Run a teacher-only pilot with the actual vocabulary samples. Record validity, instructional quality, latency, token consumption and 429 behavior across the candidate models and available batch sizes. Verify a 200-word job and a repeated approved-cache request against the deployed service, and record any free-plan limit reached. Teacher approval is required before classroom sharing.

Emergency shutdown is available from the teacher controls. Setting AI_ENABLED to false at deploy time also blocks provider calls. An inference already accepted by a provider can finish. Local practice and approved-pack import operate independently.

Changing ADMIN_AUTH_SECRET blocks the old credential from creating new teacher sessions. Changing SESSION_SIGNING_SECRET immediately invalidates signed sessions and existing class codes. Rotate each class code afterward. Store both secrets outside the repository and use a password manager for the teacher credential.

## API

Every path below starts with /api. Send a JSON body where specified. Signed teacher and classroom sessions use Authorization: Bearer <token>. CLI automation can authenticate with the teacher secret as its bearer; browser tools exchange it for a two-hour token. An optional Idempotency-Key on generation and regeneration requests safely returns the same job when the request is repeated.

| Method and path | Purpose |
| --- | --- |
| GET /health | Basic availability and API version |
| GET /config | Read public feature flags, input limits and defaults |
| POST /admin/access | Exchange a teacher secret for a signed session |
| POST /access | Exchange a classroom code for a signed session. Supply the previousToken from the same class to reopen the session's private jobs after expiry. |
| POST /generate | Create a job with words and settings |
| POST /regenerate | Regenerate a word or selected definition, examples, distractors or cloze question |
| GET /jobs/{id} | Read completed words, failures and pending counts |
| POST /jobs/{id}/{step,pause,resume,cancel} | Work on one batch or change job state |
| GET /packs/{id} | Read the current pack version if authorized |
| POST /admin/publish | Publish an approved pack with public, class or private visibility |
| GET /admin/packs | List pack summaries |
| GET or POST /admin/classes | List, create, revoke or rotate classroom codes |
| GET /admin/usage | Read UTC-day usage, cache counts and recent jobs |
| PUT /admin/settings | Set generationEnabled or the ordered groqModels allowlist |
| DELETE /admin/cache?word={word} | Remove cached versions of a word |

Generation jobs checkpoint each valid batch. Missing or invalid responses are retried in smaller batches. Use resume after a pause and regenerate for a failed item after a job completes. Jobs remain available for seven days. Reservations limit free provider calls to two concurrent requests, 200 calls per UTC day and a 150,000-token budget. An ambiguous provider failure retains the conservative reservation for that day.

An approved pack can contain spelling-only words alongside approved vocabulary. Publishing a changed pack requires a higher version. A public pack can be reused by generation when the publish request includes cacheSettings matching its content and the teacher confirms the content is generic. Context-specific jobs and unapproved drafts stay out of the shared cache. Approved content is reused per word and context; a fully cached list consumes no provider calls. When regenerating a single cloze question, the service sends only the information needed to replace that question and preserves the prior question ID.

The local test suite exercises simulated inference, retry delays and a 200-word job. Live Groq and OpenRouter output, physical devices, account billing settings and production Cloudflare CPU and storage usage require the deployment and pilot checks above.
