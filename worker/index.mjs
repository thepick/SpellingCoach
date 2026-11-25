import { DurableObject } from 'cloudflare:workers';
import { VocabularyService } from './service.mjs';

export class VocabularyCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new VocabularyService(ctx.storage, env);
  }

  fetch(request) {
    return this.service.fetch(request);
  }

  alarm() {
    return this.service.processAudioQueue();
  }
}

export default {
  fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) {
      return Response.json({ error: { code: 'not_found', message: 'This resource is unavailable.' } }, { status: 404 });
    }
    return env.VOCABULARY.getByName('spellingcoach-v1').fetch(request);
  }
};
