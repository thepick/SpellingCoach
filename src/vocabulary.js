const Vocabulary = (() => {
  const MAX_WORDS = 200;
  const MAX_WORD_LENGTH = 80;
  const MAX_PACK_BYTES = 4 * 1024 * 1024;
  const DB_NAME = 'SpellingCoach vocabulary';
  const STORE_NAME = 'content';
  const STORAGE_PREFIX = 'spell.vocabulary.v1.';
  const PARTS_OF_SPEECH = new Set([
    'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'preposition', 'conjunction',
    'interjection', 'determiner', 'article', 'numeral', 'phrase', 'unknown'
  ]);
  const STATUSES = new Set(['draft', 'review', 'approved']);

  const normalize = value => String(value ?? '').normalize('NFC')
    .trim().replace(/\s+/gu, ' ').replace(/[’‘]/gu, "'");
  const wordKey = word => normalize(word).toLowerCase();
  const choiceKey = choice => wordKey(choice).replace(/[.!?]+$/u, '');
  const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

  function plainText(value, limit, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be text.');
    const result = value.normalize('NFC').trim();
    if ([...result].length > limit) throw new Error(label + ' must be at most ' + limit + ' characters.');
    if (/[<>\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u202A-\u202E\u2066-\u2069]/u.test(result)) {
      throw new Error(label + ' must be plain text.');
    }
    return result;
  }

  function displayWord(value) {
    const word = plainText(value, MAX_WORD_LENGTH, 'Each word or phrase');
    if (/[\r\n\t_]/u.test(word) || !/[\p{L}\p{N}]/u.test(word)) {
      throw new Error('Each word or phrase must fit on one line and contain a letter or number.');
    }
    return word;
  }

  function normalizeWords(words) {
    if (!Array.isArray(words)) throw new Error('Expected a list of words.');
    const result = new Map();
    for (const value of words) {
      const word = displayWord(value);
      const key = wordKey(word);
      if (!result.has(key)) result.set(key, word);
      if (result.size > MAX_WORDS) throw new Error('A list can contain up to 200 unique words. Split the list to keep all words.');
    }
    return [...result.values()];
  }

  function keys(value, allowed, label) {
    if (!isObject(value)) throw new Error(label + ' must be an object.');
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) throw new Error(label + ' has an unexpected field.');
    }
  }

  function identifier(value, label) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/u.test(value)) {
      throw new Error(label + ' must be a stable ID of up to 96 characters.');
    }
    return value;
  }

  function boundedArray(value, max, label) {
    if (!Array.isArray(value) || value.length > max) {
      throw new Error(label + ' must be a list of up to ' + max + ' items.');
    }
    return value;
  }

  function unique(items, keyFor, label) {
    if (new Set(items.map(keyFor)).size !== items.length) throw new Error('Duplicate ' + label + '.');
    return items;
  }

  function revealsWord(text, spellings) {
    return spellings.some(spelling => {
      const escaped = wordKey(spelling).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return new RegExp('(^|[^\\p{L}\\p{M}\\p{N}])' + escaped + '($|[^\\p{L}\\p{M}\\p{N}])', 'u').test(wordKey(text));
    });
  }

  function validateRecord(word, value) {
    word = displayWord(word);
    keys(value, [
      'senseId', 'partOfSpeech', 'definition', 'examples', 'clozeQuestions',
      'meaningDistractors', 'acceptedSpellings', 'readingLevel', 'status'
    ], 'Vocabulary record');
    const senseId = identifier(value.senseId, 'Sense ID');
    const partOfSpeech = value.partOfSpeech;
    if (!PARTS_OF_SPEECH.has(partOfSpeech)) throw new Error('Select a valid part of speech.');
    const status = value.status;
    if (!STATUSES.has(status)) throw new Error('Select a valid review status.');
    if (status === 'approved' && partOfSpeech === 'unknown') throw new Error('Approved content needs a part of speech.');
    const readingLevel = value.readingLevel;
    if (!Number.isInteger(readingLevel) || readingLevel < 1 || readingLevel > 12) {
      throw new Error('Reading level must be a grade from 1 to 12.');
    }
    const definition = plainText(value.definition, 300, 'Definition');
    const acceptedSpellings = unique(boundedArray(value.acceptedSpellings, 10, 'Accepted spellings').map(displayWord), wordKey, 'accepted spelling');
    const spellings = unique([word, ...acceptedSpellings], wordKey, 'target spelling');
    if (revealsWord(definition, spellings)) throw new Error('The definition reveals the target word.');
    const examples = unique(
      boundedArray(value.examples, 2, 'Example sentences').map(item => plainText(item, 300, 'Example sentence')),
      choiceKey, 'example sentence'
    );
    const clozeQuestions = boundedArray(value.clozeQuestions, 5, 'Practice sentences').map(item => {
      keys(item, ['id', 'sentence', 'answer', 'explanation'], 'Practice question');
      const id = identifier(item.id, 'Question ID');
      const sentence = plainText(item.sentence, 300, 'Practice sentence');
      const blanks = sentence.match(/_+/gu);
      if (!blanks || blanks.length !== 1 || blanks[0].length !== 5) {
        throw new Error('Each practice sentence needs exactly one blank written as _____.');
      }
      if (revealsWord(sentence, spellings)) throw new Error('The practice sentence reveals the target word.');
      const answer = displayWord(item.answer);
      if (wordKey(answer) !== wordKey(word)) throw new Error('Each practice answer must match the target word.');
      const explanation = item.explanation === '' ? '' : plainText(item.explanation, 300, 'Explanation');
      return { id, sentence, answer, explanation };
    });
    unique(clozeQuestions, item => item.id, 'question ID');
    unique(clozeQuestions, item => choiceKey(item.sentence), 'practice sentence');
    const meaningDistractors = boundedArray(value.meaningDistractors, 3, 'Definition distractors')
      .map(item => plainText(item, 300, 'Definition distractor'));
    unique([...meaningDistractors, definition], choiceKey, 'definition choice');
    if (meaningDistractors.length && meaningDistractors.length < 3) {
      throw new Error('Supply at least three valid definition distractors, or leave the set empty.');
    }
    if (meaningDistractors.some(choice => revealsWord(choice, spellings))) {
      throw new Error('A definition distractor reveals the target word.');
    }
    return { senseId, partOfSpeech, definition, examples, clozeQuestions, meaningDistractors, acceptedSpellings, readingLevel, status };
  }

  function validatePack(payload) {
    let value = payload;
    if (typeof payload === 'string') {
      if (payload.length > MAX_PACK_BYTES || new TextEncoder().encode(payload).length > MAX_PACK_BYTES) {
        throw new Error('Vocabulary packs must be 4 MB or smaller.');
      }
      try {
        value = JSON.parse(payload.replace(/^\uFEFF/u, ''));
      } catch {
        throw new Error('This vocabulary pack contains invalid JSON.');
      }
    }
    keys(value, ['kind', 'v', 'id', 'version', 'name', 'words'], 'Vocabulary pack');
    if (value.kind !== 'spellingcoach-pack' || value.v !== 1) throw new Error('Unsupported vocabulary pack format.');
    const id = identifier(value.id, 'Pack ID');
    const version = value.version;
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('Pack version must be a positive integer.');
    const name = plainText(value.name, 120, 'Pack name');
    const rows = boundedArray(value.words, MAX_WORDS * 5, 'Vocabulary pack words');
    const words = new Map();
    for (const item of rows) {
      keys(item, ['word', 'vocabulary'], 'Pack word');
      const word = displayWord(item.word);
      const vocabulary = item.vocabulary == null ? null : validateRecord(word, item.vocabulary);
      const key = wordKey(word);
      const entry = { word, vocabulary };
      if (words.has(key)) {
        if (JSON.stringify(words.get(key).vocabulary) !== JSON.stringify(vocabulary)) {
          throw new Error('Conflicting vocabulary entries for ' + word + '.');
        }
      } else {
        words.set(key, entry);
      }
      if (words.size > MAX_WORDS) throw new Error('A pack can contain up to 200 unique words. Split the pack to keep all words.');
    }
    if (!words.size) throw new Error('A vocabulary pack needs at least one word.');
    return { kind: 'spellingcoach-pack', v: 1, id, version, name, words: [...words.values()] };
  }

  function legacyRecords(list) {
    if (!Array.isArray(list?.words) || !isObject(list.defs)) return [];
    const definitions = new Map(Object.entries(list.defs).map(([word, value]) => [wordKey(word), value]));
    const records = [];
    for (const word of list.words) {
      const definition = Object.hasOwn(list.defs, word) ? list.defs[word] : definitions.get(wordKey(word));
      if (typeof definition !== 'string' || !definition.trim()) continue;
      try {
        const vocabulary = validateRecord(word, {
          senseId: 'legacy-definition', partOfSpeech: 'unknown', definition,
          examples: [], clozeQuestions: [], meaningDistractors: [], acceptedSpellings: [], readingLevel: 5, status: 'draft'
        });
        records.push({ word, vocabulary });
      } catch {
        // The legacy list retains the original definition for manual revision.
      }
    }
    return records;
  }

  function sameSense(before, after) {
    if (!before || !after) return before === after;
    return before.senseId === after.senseId && before.partOfSpeech === after.partOfSpeech
      && normalize(before.definition) === normalize(after.definition);
  }

  function planPackUpdate(previous, payload) {
    const incoming = validatePack(payload);
    const result = { pack: incoming, action: 'insert', unchangedWords: [], changedWords: [], removedWords: [] };
    if (!previous) return result;
    const old = validatePack(previous);
    if (incoming.id !== old.id) throw new Error('Pack IDs must match to update an existing pack.');
    if (incoming.version <= old.version) {
      if (incoming.version === old.version && JSON.stringify(incoming) !== JSON.stringify(old)) {
        throw new Error('This pack version conflicts with the installed copy. Increment the pack version after editing.');
      }
      result.pack = old;
      result.action = incoming.version === old.version ? 'unchanged' : 'older';
      result.unchangedWords = old.words.map(item => wordKey(item.word));
      return result;
    }
    result.action = 'update';
    const oldWords = new Map(old.words.map(item => [wordKey(item.word), item.vocabulary]));
    for (const item of incoming.words) {
      const key = wordKey(item.word);
      if (oldWords.has(key)) {
        const group = sameSense(oldWords.get(key), item.vocabulary) ? result.unchangedWords : result.changedWords;
        group.push(key);
        oldWords.delete(key);
      }
    }
    result.removedWords = [...oldWords.keys()];
    return result;
  }

  function storageError(error) {
    if (error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return new Error('Vocabulary storage is full. Export a backup or free browser storage and retry.', { cause: error });
    }
    return new Error('Vocabulary storage could not complete this operation. Existing records may still be available. Please retry.', { cause: error });
  }

  function openIndexedDB(indexedDB) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      let abandoned = false;
      request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        abandoned = true;
        reject(new Error('Vocabulary storage is blocked by another tab.'));
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (abandoned) db.close();
        else resolve(db);
      };
    });
  }

  function indexedStore(db) {
    function run(mode, operation, getResult) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const requests = operation(tx.objectStore(STORE_NAME));
        tx.onabort = () => reject(tx.error);
        tx.oncomplete = () => resolve(getResult(requests));
      }).catch(error => { throw storageError(error); });
    }
    return {
      kind: 'indexedDB',
      get: key => run('readonly', store => store.get(key), request => request.result),
      put: (key, value) => run('readwrite', store => store.put(value, key), () => undefined),
      remove: key => run('readwrite', store => store.delete(key), () => undefined),
      entries: () => run('readonly', store => [store.getAllKeys(), store.getAll()], ([keys, values]) => (
        keys.result.map((key, index) => [key, values.result[index]])
      ))
    };
  }

  function localKeys(storage) {
    const keys = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    return keys;
  }

  function localStore(storage) {
    const read = key => {
      const serialized = storage.getItem(key);
      return serialized === null ? undefined : JSON.parse(serialized);
    };
    const run = async operation => {
      try {
        return operation();
      } catch (error) {
        throw storageError(error);
      }
    };
    return {
      kind: 'localStorage',
      get: key => run(() => read(STORAGE_PREFIX + key)),
      put: (key, value) => run(() => {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error('Vocabulary record must be serializable.');
        storage.setItem(STORAGE_PREFIX + key, serialized);
      }),
      remove: key => run(() => storage.removeItem(STORAGE_PREFIX + key)),
      entries: () => run(() => localKeys(storage).map(key => [key.slice(STORAGE_PREFIX.length), read(key)]))
    };
  }

  async function openStore(environment = globalThis, preferred) {
    let storage;
    try { storage = environment.localStorage; } catch {}
    if (preferred !== 'localStorage') {
      try {
        if (environment.indexedDB) return indexedStore(await openIndexedDB(environment.indexedDB));
      } catch (error) {
        if (preferred === 'indexedDB') throw storageError(error);
      }
    }
    if (storage && preferred !== 'indexedDB') return localStore(storage);
    throw new Error('Vocabulary storage is unavailable in this browser. Enable browser storage and reopen SpellingCoach.');
  }

  return { MAX_WORDS, MAX_WORD_LENGTH, MAX_PACK_BYTES, normalize, wordKey, normalizeWords, validateRecord, validatePack, legacyRecords, planPackUpdate, openStore };
})();

if (typeof module === 'object' && module.exports) module.exports = Vocabulary;
