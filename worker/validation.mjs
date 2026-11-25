export const MAX_WORDS = 200;
export const MAX_WORD_LENGTH = 80;
export const DIALECTS = ['original', 'american', 'british', 'canadian'];
export const DEFAULT_SETTINGS = Object.freeze({
  readingLevel: 5, dialect: 'original', practiceSentences: 5, exampleSentences: 2,
  reuseApproved: true, esl: true, distractors: true, explanations: true, context: '', sense: ''
});
export const PARTS_OF_SPEECH = [
  'noun', 'verb', 'adjective', 'adverb', 'pronoun', 'determiner',
  'preposition', 'conjunction', 'interjection', 'phrase', 'numeral', 'article'
];

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function requireInput(condition, message) {
  if (!condition) throw new ApiError(400, 'invalid_input', message);
}

export function shape(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

export const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export const shortId = (value) => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value);
const plain = (value, max, min = 1) => typeof value === 'string' && value.trim().length >= min
  && [...value].length <= max && !/[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(value);
export const normalize = (word) => word.normalize('NFC').trim().replace(/\s+/g, ' ').replace(/[’‘]/g, "'");
export const wordKey = (word) => normalize(word).toLowerCase();
const wordPattern = /^[\p{L}\p{M}\p{N}]+(?:[ '.\p{Pd}][\p{L}\p{M}\p{N}]+)*\.?$/u;
const contentFlag = /\b(?:pornograph\w*|sexual intercourse|suicide|kill yourself|make a bomb|racial slur)\b/iu;
const safeContent = (value, max, min = 1) => plain(value, max, min) && !contentFlag.test(value);
const list = (value, max) => Array.isArray(value) && value.length <= max;
const unique = (values, key = wordKey) => new Set(values.map(key)).size === values.length;
const choiceKey = (value) => wordKey(value).replace(/[.!?]+$/u, '');
const displayWord = (value) => plain(value, MAX_WORD_LENGTH) && !/[\r\n\t_]/u.test(value) && /[\p{L}\p{N}]/u.test(value);

export function vocabularyWord(value) {
  const canonical = typeof value === 'string' ? normalize(value) : '';
  requireInput(displayWord(canonical) && wordPattern.test(canonical), 'Enter a word or a short phrase of up to 80 characters.');
  return canonical;
}

export function normalizedWords(values) {
  requireInput(Array.isArray(values) && values.length >= 1 && values.length <= 2000, 'Provide a list of up to 200 unique words.');
  const words = new Map();
  for (const value of values) {
    const word = vocabularyWord(value);
    const key = wordKey(word);
    if (!words.has(key)) words.set(key, word);
    requireInput(words.size <= MAX_WORDS, 'A list can contain up to 200 unique words. Split this list into smaller lists.');
  }
  return [...words.values()];
}

export function parseSettings(input, teacher) {
  requireInput(shape(input, Object.keys(DEFAULT_SETTINGS)), 'Unrecognized settings.');
  const settings = { ...DEFAULT_SETTINGS, ...input };
  requireInput(integer(settings.readingLevel, 1, 12) && DIALECTS.includes(settings.dialect)
    && integer(settings.practiceSentences, 1, 5) && integer(settings.exampleSentences, 1, 2), 'Choose a valid grade, spelling dialect, and sentence count.');
  for (const key of ['reuseApproved', 'esl', 'distractors', 'explanations']) {
    requireInput(typeof settings[key] === 'boolean', 'Generation switches must be true or false.');
  }
  requireInput(plain(settings.context, 1000, 0) && plain(settings.sense, 160, 0), 'Textbook context or intended meaning is invalid.');
  settings.context = settings.context.trim();
  settings.sense = settings.sense.trim();
  requireInput(teacher || (!settings.context && !settings.sense), 'Textbook context and intended meaning are for teachers.');
  return settings;
}

export function cacheKey(word, settings) {
  const { reuseApproved, ...contentSettings } = settings;
  return JSON.stringify(['prompt-1', 'schema-1', word, contentSettings]);
}

const explicitWord = (word) => new RegExp('(?:^|[^\\p{L}\\p{M}\\p{N}])'
  + wordKey(word).replace(/[.*+?^$\x7B\x7D()|[\]\\]/g, '\\$&')
  + '(?:$|[^\\p{L}\\p{M}\\p{N}])', 'u');

const fields = ['senseId', 'partOfSpeech', 'definition', 'examples', 'clozeQuestions',
  'meaningDistractors', 'acceptedSpellings', 'readingLevel', 'status'];
const providerFields = ['word', 'partOfSpeech', 'definition', 'examples', 'clozeQuestions', 'meaningDistractors', 'acceptedSpellings'];

function recordIsValid(entry, approvedOnly) {
  if (!shape(entry, ['id', 'word', 'vocabulary']) || (entry.id !== undefined && !shortId(entry.id))
    || !displayWord(entry.word)) return false;
  const { vocabulary: v, word } = entry;
  if (!shape(v, fields) || !shortId(v.senseId)
    || !(PARTS_OF_SPEECH.includes(v.partOfSpeech) || (v.status !== 'approved' && v.partOfSpeech === 'unknown'))
    || !safeContent(v.definition, 300)
    || !integer(v.readingLevel, 1, 12) || !(approvedOnly ? v.status === 'approved' : ['draft', 'approved', 'review'].includes(v.status))
    || !list(v.examples, 2) || !v.examples.every((example) => safeContent(example, 300))
    || !unique(v.examples, choiceKey) || !list(v.meaningDistractors, 3) || v.meaningDistractors.length === 1 || v.meaningDistractors.length === 2
    || !v.meaningDistractors.every((item) => safeContent(item, 300))
    || !unique([v.definition, ...v.meaningDistractors], choiceKey)
    || !list(v.acceptedSpellings, 10) || !v.acceptedSpellings.every(displayWord)
    || !unique([word, ...v.acceptedSpellings]) || !list(v.clozeQuestions, 5)) return false;
  const spellings = [word, ...v.acceptedSpellings].map(explicitWord);
  const revealsAnswer = (text) => spellings.some((spelling) => spelling.test(wordKey(text)));
  if ([v.definition, ...v.meaningDistractors].some(revealsAnswer)) return false;
  return v.clozeQuestions.every((q) => shape(q, ['id', 'sentence', 'answer', 'explanation'])
    && shortId(q.id) && safeContent(q.sentence, 300) && q.sentence.match(/_+/g)?.length === 1
    && q.sentence.includes('_____') && !revealsAnswer(q.sentence)
    && displayWord(q.answer) && wordKey(q.answer) === wordKey(word) && safeContent(q.explanation, 300, 0))
    && unique(v.clozeQuestions.map((q) => q.id)) && unique(v.clozeQuestions.map((q) => q.sentence), choiceKey);
}

export function dictationText(input) {
  requireInput(shape(input, ['word', 'sentence']), 'Provide a word and its example sentence.');
  const word = vocabularyWord(input.word);
  requireInput(safeContent(input.sentence, 200) && !/[\[\]\r\n]/u.test(input.sentence),
    'Enter one example sentence of up to 200 characters.');
  requireInput(explicitWord(wordKey(word)).test(wordKey(input.sentence)),
    'Use the exact target word in the sentence, including its ending.');
  return input.sentence.trim();
}

export function validatedRecord(entry, approvedOnly = false) {
  requireInput(recordIsValid(entry, approvedOnly), 'Vocabulary content is incomplete or invalid. Check definitions, sentences, and answer choices.');
  return entry;
}

export function generatedRecords(records, words, settings, regeneration) {
  const result = new Map();
  if (!Array.isArray(records) || records.length > words.length * 2) return result;
  const expected = new Set(words);
  const duplicates = new Set();
  const seen = new Set();
  for (const record of records) {
    if (!record || !expected.has(record.word)) continue;
    if (seen.has(record.word)) duplicates.add(record.word);
    seen.add(record.word);
    const { word, ...vocabulary } = record;
    try {
      if (regeneration?.previous && regeneration.item !== 'all') {
        const revised = mergeRegenerated(record, settings, regeneration);
        if (revised) result.set(word, revised);
        continue;
      }
      if (!shape(record, providerFields)) continue;
      const cloze = vocabulary.clozeQuestions;
      if (!list(cloze, settings.practiceSentences) || cloze.length !== settings.practiceSentences
        || !cloze.every((q) => shape(q, ['sentence', 'answer', 'explanation'])
          && q.answer === word && typeof q.explanation === 'string' && Boolean(q.explanation.trim()) === settings.explanations)
        || !list(vocabulary.examples, settings.exampleSentences) || vocabulary.examples.length !== settings.exampleSentences
        || !vocabulary.examples.every((example) => typeof example === 'string' && explicitWord(word).test(wordKey(example)))
        || !list(vocabulary.meaningDistractors, settings.distractors ? 3 : 0)
        || vocabulary.meaningDistractors.length !== (settings.distractors ? 3 : 0)) continue;
      const entry = validatedRecord({
        word,
        vocabulary: {
          ...vocabulary, status: 'draft', readingLevel: settings.readingLevel, senseId: 'primary',
          clozeQuestions: cloze.map((q, i) => ({ ...q, id: 'q' + (i + 1) }))
        }
      });
      result.set(word, entry);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  for (const word of duplicates) result.delete(word);
  return result;
}

export function regenerationField(item) {
  return { definition: 'definition', examples: 'examples', distractors: 'meaningDistractors', cloze: 'clozeQuestions' }[item];
}

function mergeRegenerated(record, settings, { item, questionId, previous }) {
  const field = regenerationField(item);
  if (!shape(record, ['word', field])) return null;
  const generated = record[field];
  const vocabulary = { ...previous.vocabulary, status: 'draft' };
  if (item === 'definition') {
    if (typeof generated !== 'string' || wordKey(generated) === wordKey(vocabulary.definition)) return null;
    vocabulary.definition = generated;
  } else if (item === 'cloze') {
    if (!list(generated, 1) || generated.length !== 1) return null;
    const [replacement] = generated;
    if (!shape(replacement, ['sentence', 'answer', 'explanation']) || replacement.answer !== record.word || typeof replacement.sentence !== 'string'
      || typeof replacement.explanation !== 'string' || Boolean(replacement.explanation.trim()) !== settings.explanations) return null;
    const remaining = new Set(vocabulary.clozeQuestions.map((q) => wordKey(q.sentence)));
    if (remaining.has(wordKey(replacement.sentence))) return null;
    vocabulary.clozeQuestions = vocabulary.clozeQuestions.map((q) => q.id === questionId ? { ...replacement, id: q.id } : q);
  } else {
    const count = item === 'examples' ? settings.exampleSentences : 3;
    if (!Array.isArray(generated) || generated.length !== count) return null;
    vocabulary[field] = generated;
  }
  return validatedRecord({ ...previous, vocabulary });
}

export function validatePack(pack, { allowSpellingOnly = false } = {}) {
  requireInput(shape(pack, ['kind', 'v', 'id', 'name', 'version', 'words'])
    && pack.kind === 'spellingcoach-pack' && pack.v === 1 && shortId(pack.id) && safeContent(pack.name, 120)
    && integer(pack.version, 1, Number.MAX_SAFE_INTEGER) && list(pack.words, MAX_WORDS) && pack.words.length > 0, 'Invalid vocabulary pack.');
  for (const entry of pack.words) {
    requireInput(shape(entry, ['word', 'vocabulary']) && displayWord(entry.word) && Object.hasOwn(entry, 'vocabulary'), 'Invalid vocabulary pack word.');
    if (entry.vocabulary !== null) validatedRecord(entry, true);
  }
  requireInput(allowSpellingOnly || pack.words.some((entry) => entry.vocabulary !== null), 'Add approved vocabulary before publishing this pack.');
  requireInput(unique(pack.words.map(({ word }) => word)), 'Vocabulary packs cannot contain duplicate words.');
  return pack;
}

export function cacheEligible(record, settings) {
  const v = record.vocabulary;
  return v.status === 'approved' && v.readingLevel === settings.readingLevel
    && v.clozeQuestions.length === settings.practiceSentences && v.examples.length === settings.exampleSentences
    && v.meaningDistractors.length === (settings.distractors ? 3 : 0)
    && v.clozeQuestions.every((q) => Boolean(q.explanation.trim()) === settings.explanations);
}
