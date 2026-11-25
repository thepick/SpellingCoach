const Learning = (() => {
  const DAY = 86400000;
  const MAX_PRACTICE_ATTEMPTS = 8;
  const norm = value => String(value ?? '').trim().replace(/\s+/g, ' ').replace(/[’‘]/g, "'");
  const key = value => norm(value).toLowerCase();
  const equal = (input, target) => /[A-Z]/.test(norm(target))
    ? norm(input) === norm(target) : key(input) === key(target);
  const own = (object, property) => Object.hasOwn(object, property) ? object[property] : undefined;
  const copy = value => JSON.parse(JSON.stringify(value));
  const isChoice = question => ['sentence-choice', 'meaning-choice'].includes(question.type);
  const isRecall = question => ['missing-word', 'definition-recall'].includes(question.type);
  const isBank = question => question.type === 'word-bank';

  function describe(records) {
    return records.map(record => typeof record === 'string' ? {word: record} : record)
      .filter(record => record?.word);
  }

  function distance(left, right) {
    let previous = Array.from({length: right.length + 1}, (_, index) => index);
    let earlier;
    for (let row = 1; row <= left.length; row++) {
      const current = [row];
      for (let column = 1; column <= right.length; column++) {
        current[column] = Math.min(previous[column] + 1, current[column - 1] + 1,
          previous[column - 1] + Number(left[row - 1] !== right[column - 1]));
        if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
          current[column] = Math.min(current[column], earlier[column - 2] + 1);
        }
      }
      earlier = previous;
      previous = current;
    }
    return previous[right.length];
  }

  function stems(word) {
    const forms = [word];
    const suffix = word.match(/(ing|ied|ies|ed|es|ly|s)$/)?.[0];
    if (suffix && word.length - suffix.length >= 3) {
      const base = word.slice(0, -suffix.length);
      forms.push(base);
      if (['ing', 'ed'].includes(suffix)) {
        forms.push(base + 'e');
        if (/(.)\1$/.test(base)) forms.push(base.slice(0, -1));
      }
      if (['ied', 'ies'].includes(suffix)) forms.push(base + 'y');
    }
    return forms;
  }

  function evaluate(question, input, records = [], allowVariants = false) {
    const expected = question.answer;
    const target = key(expected);
    const entered = key(input);
    if ((isChoice(question) ? entered === target : equal(input, expected))) return {correct: true, kind: 'correct'};
    if (!isChoice(question) && allowVariants && question.acceptedSpellings?.some(variant => equal(input, variant))) {
      return {correct: true, kind: 'accepted-variant'};
    }
    if (!isChoice(question) && target !== entered) {
      if (describe(records).some(record => key(record.word) === entered)) return {correct: false, kind: 'other-word'};
      if (stems(target).some(form => stems(entered).includes(form))) return {correct: false, kind: 'word-form'};
      const limit = target.length >= 9 && target.slice(0, 2) === entered.slice(0, 2) ? 2 : 1;
      if (target.length >= 4 && entered.length > 0 && Math.abs(target.length - entered.length) <= limit &&
          distance(target, entered) <= limit) return {correct: false, kind: 'likely-spelling'};
    }
    return {correct: false, kind: 'incorrect'};
  }

  function hideAnswer(text, words, replacement = '_____') {
    return words.filter(Boolean).reduce((clean, word) => {
      const escaped = norm(word).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&').replace(/ /g, '\\s+').replace(/'/g, "['’‘]");
      const pattern = new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu');
      return clean.replace(pattern, (_, prefix) => prefix + replacement);
    }, text);
  }

  function distinct(values) {
    const seen = new Set();
    return values.filter(value => {
      if (!norm(value) || seen.has(key(value))) return false;
      seen.add(key(value));
      return true;
    });
  }

  function rotated(values, offset) {
    const position = offset % values.length || 0;
    return [...values.slice(position), ...values.slice(0, position)];
  }

  function baseSkill() {
    return {attempts: 0, correct: 0, streak: 0, misses: 0, assisted: 0, lastAt: 0,
      nextReview: 0, interval: 0, mastered: false, prompts: []};
  }

  function wordProgress(progress, record) {
    const previous = own(progress, key(record.word));
    const senseId = record.vocabulary?.senseId || '';
    const existingSense = previous?.vocabulary?.senseId === senseId ? previous.vocabulary : null;
    return {
      spelling: {...baseSkill(), ...previous?.spelling},
      vocabulary: {...baseSkill(), recognition: 0, recognitionAttempts: 0, senseId, lastIndependentPrompt: '',
        ...existingSense, prompts: Array.isArray(existingSense?.prompts) ? existingSense.prompts : []}
    };
  }

  function progressFor(progress, record) {
    Object.defineProperty(progress, key(record.word), {value: wordProgress(progress, record),
      enumerable: true, writable: true, configurable: true});
    return own(progress, key(record.word));
  }

  function vocabularyFor(record, test) {
    const vocabulary = record.vocabulary;
    return vocabulary?.definition && (!test || vocabulary.status === 'approved') ? vocabulary : null;
  }

  function optionsFor(session, q, choices, serial) {
    const rawChoices = distinct(choices).slice(0, 4);
    if (rawChoices.length < 2) return null;
    const offset = serial + session.settings.choiceOffset;
    return {...q, choices: rotated(rawChoices, offset)};
  }

  function variants(session, task) {
    const record = session.records[task.recordIndex];
    const {word} = record;
    const vocabulary = vocabularyFor(record, session.type === 'test');
    const common = {
      word, recordIndex: task.recordIndex, choices: [], bank: [],
      acceptedSpellings: record.vocabulary?.acceptedSpellings || [],
      senseId: record.vocabulary?.senseId || ''
    };
    if (task.skill === 'spelling') return [{...common, type: 'dictation', id: 'dictation', prompt: 'Listen and type the word.', answer: word}];
    const safeWords = [word, ...common.acceptedSpellings];
    const definition = hideAnswer(vocabulary.definition, safeWords);
    const context = (vocabulary.examples || []).map(example => hideAnswer(example, safeWords)).filter(Boolean);
    const info = {...common, definition, partOfSpeech: vocabulary.partOfSpeech || '', context};
    const choices = session.settings.multipleChoice;
    const serial = task.recordIndex + session.questions.length;
    const otherWords = distinct(session.records
      .filter(other => !safeWords.some(excluded => key(other.word) === key(excluded)))
      .sort((a, b) => Number(b.vocabulary?.partOfSpeech === vocabulary.partOfSpeech) -
        Number(a.vocabulary?.partOfSpeech === vocabulary.partOfSpeech))
      .map(other => other.word)).slice(0, 3);
    const meaningDistractors = (vocabulary.meaningDistractors || []).map(item => hideAnswer(item, safeWords));
    const meaning = choices && optionsFor(session, {...info, type: 'meaning-choice', id: 'meaning',
      prompt: 'What does “' + word + '” mean?', answer: definition}, [definition, ...meaningDistractors], serial);
    const recall = {...info, type: 'definition-recall', id: 'definition', prompt: definition, answer: word};
    const questions = [meaning, recall].filter(Boolean);
    for (const [index, cloze] of (vocabulary.clozeQuestions || []).entries()) {
      const answer = cloze.answer || word;
      const prompt = hideAnswer(cloze.sentence, [...safeWords, answer]);
      if ((prompt.match(/_{2,}/g) || []).length !== 1) continue;
      const base = {...info, id: 'cloze:' + (cloze.id || index), prompt, answer, explanation: cloze.explanation || ''};
      questions.push({...base, type: 'missing-word'});
      const alternatives = otherWords.filter(other => key(other) !== key(answer));
      const sentence = choices && optionsFor(session, {...base, type: 'sentence-choice'},
        [answer, ...alternatives], serial + index);
      if (sentence) questions.push(sentence);
      if (alternatives.length && (choices || session.type !== 'test')) questions.push({...base, type: 'word-bank',
        bank: rotated([answer, ...alternatives], serial + index + session.settings.choiceOffset)});
    }
    return questions;
  }

  function tier(question) {
    if (isChoice(question)) return 0;
    if (isBank(question)) return 1;
    return 2;
  }

  function choose(session, task, seen = []) {
    if (session.settings.phasedVocabulary && task.skill === 'vocabulary') return choosePhased(session, task);
    const options = variants(session, task);
    if (task.skill === 'spelling') return options[0];
    const record = session.records[task.recordIndex];
    const history = wordProgress(session.progress, record).vocabulary;
    const difficulty = {beginner: 0, intermediate: 1, advanced: 2}[session.settings.difficulty];
    const test = session.type === 'test';
    const level = difficulty ?? (test ? [2, 0, 2][seen.length] : Math.max(0,
      (history.mastered || history.streak || history.assisted ? 2 : Number(history.recognition > 0)) -
      Math.min(task.consecutiveMisses || 0, 2)));
    const prior = seen.at(-1)?.id || history.prompts.at(-1);
    return options.sort((left, right) => {
      const rank = question => (seen.some(previous => previous.id === question.id) ? 100 : 0)
        + Math.abs(tier(question) - level) * 20 + (test && seen.some(previous => previous.type === question.type) ? 8 : 0)
        + (!test && question.id === prior ? 10 : 0) + (!test && history.prompts.includes(question.id) ? 5 : 0)
        + (question.type === 'definition-recall' ? 1 : 0);
      return rank(left) - rank(right);
    })[0];
  }

  function choosePhased(session, task) {
    const record = session.records[task.recordIndex];
    const prompts = phasedPrompts(record, task.recordIndex);
    const history = wordProgress(session.progress, record).vocabulary;
    const previous = task.streak ? task.lastRecall : history.prompts.at(-1);
    const next = prompts.find(question => question.id !== previous) || prompts[0];
    if (task.bankPassed) return next;
    const words = distinct([next.answer, ...session.records.map(row => row.word)]).slice(0, 4);
    const order = session.settings.bankOrder?.[record.word];
    const bank = Array.isArray(order) && order.length === words.length && new Set(order).size === words.length &&
      order.every(index => Number.isInteger(index) && index >= 0 && index < words.length)
      ? order.map(index => words[index]) : rotated(words, task.recordIndex + session.settings.choiceOffset + 1);
    return {...next, type:'word-bank', bank};
  }

  function phasedPrompts(record, recordIndex) {
    const {word, vocabulary} = record;
    if (!vocabulary?.definition) return [];
    const acceptedSpellings = vocabulary.acceptedSpellings || [];
    const mask = (text, extra) => hideAnswer(text, [word, ...acceptedSpellings, extra]);
    const context = (vocabulary.examples || []).map(text => mask(text));
    const info = {word, recordIndex, choices:[], bank:[], acceptedSpellings, senseId:vocabulary.senseId || '',
      definition:mask(vocabulary.definition), partOfSpeech:vocabulary.partOfSpeech || '', context};
    const singleBlank = text => (text.match(/_{2,}/g) || []).length === 1;
    const sentences = (vocabulary.clozeQuestions || []).map((cloze, index) => ({...info, type:'missing-word',
      id:'cloze:' + (cloze.id || index), prompt:mask(cloze.sentence, cloze.answer), answer:cloze.answer || word,
      explanation:cloze.explanation || ''})).filter(question => singleBlank(question.prompt));
    if (sentences.length) return sentences;
    const examples = context.filter(singleBlank).map((prompt, index) => ({...info, type:'missing-word',
      id:'example:' + index, prompt, answer:word}));
    if (examples.length) return examples;
    return [{...info, type:'definition-recall', id:'definition', prompt:info.definition, answer:word}];
  }

  function practiceAudioPrompts(record, index) {
    return [{key:index + '-s', skill:'spelling', text:record.word}, ...phasedPrompts(record, index)
      .map((question, prompt) => ({key:index + '-v' + prompt, skill:'vocabulary', text:audio(question)}))];
  }

  function ordered(values, order) {
    if (!Array.isArray(order)) return values;
    const seen = new Set(order.filter(index => Number.isInteger(index) && index >= 0 && index < values.length));
    return [...Array.from(seen, index => values[index]), ...values.filter((_, index) => !seen.has(index))];
  }

  function priority(session, task, now) {
    const stats = wordProgress(session.progress, session.records[task.recordIndex])[task.skill];
    if (stats.mastered && stats.nextReview <= now) return 100;
    if (!stats.attempts && !stats.recognitionAttempts) return 80;
    if (stats.mastered) return -20;
    return Math.min(stats.misses, 10) * 3 + Math.min(14, (now - stats.lastAt) / DAY) + 2 - stats.streak;
  }

  function pushQuestion(session, task, question) {
    session.questions.push({...question, promptId: question.id,
      id: task.recordIndex + ':' + task.skill + ':' + session.questions.length, taskId: task.id});
  }

  function taskMastered(session, task) {
    if (session.settings.phasedVocabulary) return task.streak >= 2 && (task.skill === 'spelling' || task.bankPassed);
    const skill = wordProgress(session.progress, session.records[task.recordIndex])[task.skill];
    return skill.mastered && skill.streak >= 2;
  }

  function recordPhase(task, result) {
    if (!result.correct || result.hintCount) task.streak = 0;
    else if (isBank(result.question)) task.bankPassed = true;
    else if (task.skill === 'spelling' || task.bankPassed && isRecall(result.question)) {
      if (task.streak < 2) task.streak++;
      task.lastRecall = result.question.promptId;
    }
  }

  function upgradePractice(session) {
    if (session.type !== 'practice' || session.status !== 'active' || session.settings.phasedVocabulary) return;
    Object.assign(session.settings, {phasedVocabulary:true, masteryPractice:true});
    for (const task of session.tasks) Object.assign(task, {bankPassed:false, streak:0, lastRecall:''});
    for (const result of session.results) recordPhase(session.tasks[result.question.taskId], result);
    session.queue = session.queue.filter(id => !taskMastered(session, session.tasks[id]));
    const question = current(session);
    if (!session.feedback && question && question.type !== 'dictation' && !session.hintStage) {
      const replacement = choosePhased(session, session.tasks[question.taskId]);
      session.questions[session.index] = {...replacement, id:question.id, taskId:question.taskId, promptId:replacement.id};
    }
  }

  function practiceWordProgress(session) {
    const pending = new Set(session.queue);
    const question = current(session), feedback = session.feedback;
    if (question && (!feedback?.correct || feedback.assisted || feedback.correctionRequired)) pending.add(question.taskId);
    const words = new Map();
    for (const task of session.tasks) {
      const word = task.recordIndex;
      words.set(word, words.get(word) !== false && !pending.has(task.id) && taskMastered(session, task));
    }
    return {mastered: [...words.values()].filter(Boolean).length, total: words.size};
  }

  function practiceMastered(session) {
    return session.settings.masteryPractice === true && session.type === 'practice' &&
      session.status === 'finished' && session.index === session.questions.length &&
      session.tasks.length > 0 && session.tasks.every(task => taskMastered(session, task));
  }

  function schedule(session) {
    const previous = session.questions.at(-1);
    if (!session.queue.length && session.settings.masteryPractice) {
      session.queue = session.tasks.filter(task => !taskMastered(session, task)).map(task => task.id);
    }
    if (!session.queue.length) {
      session.status = 'finished';
      return;
    }
    const nextIndex = session.queue.findIndex(id => session.tasks[id].recordIndex !== previous?.recordIndex);
    const [taskId] = session.queue.splice(Math.max(0, nextIndex), 1);
    const task = session.tasks[taskId];
    pushQuestion(session, task, choose(session, task));
  }

  function createSession(records, options = {}, progress = {}) {
    const settings = {...options, mode: options.mode || 'spelling', type: options.type === 'test' ? 'test' : 'practice',
      difficulty: options.difficulty || 'adaptive', perWord: Math.min(3, Math.max(1, Math.trunc(options.perWord) || 1)),
      multipleChoice: options.multipleChoice !== false, audioReplay: options.audioReplay !== false,
      choiceOffset: Number.isInteger(options.choiceOffset) && options.choiceOffset >= 0 ? options.choiceOffset : 0,
      reviewIntervals: options.reviewIntervals?.length && options.reviewIntervals.every(days => Number.isFinite(days) && days > 0)
        ? [...options.reviewIntervals] : [1, 3, 7, 14, 30]};
    if (settings.type === 'test') settings.phasedVocabulary = false;
    if (settings.phasedVocabulary) settings.masteryPractice = true;
    const now = typeof options.now === 'number' ? options.now : Date.now();
    const session = {v: 1, type: settings.type, mode: settings.mode, settings, status: 'active', records: copy(describe(records)),
      questions: [], index: 0, tasks: [], queue: [], progress: copy(progress), results: [], hintStage: 0,
      revealed: false, feedback: null, startedAt: now, finishedAt: null};
    for (const skill of ['spelling', 'vocabulary']) {
      if (skill === 'spelling' && settings.mode === 'vocabulary' || skill === 'vocabulary' && settings.mode === 'spelling') continue;
      session.records.forEach((record, recordIndex) => {
        if (skill === 'vocabulary' && !vocabularyFor(record, settings.type === 'test')) return;
        const stats = progressFor(session.progress, record)[skill];
        if (settings.reviewOnly && (!stats.mastered || stats.nextReview > now)) return;
        session.tasks.push({id: session.tasks.length, recordIndex, skill, attempts: 0, successes: 0, consecutiveMisses: 0,
          ...(settings.phasedVocabulary ? {bankPassed:false, streak:0, lastRecall:''} : {})});
      });
    }
    if (session.type === 'test') {
      for (const task of session.tasks) {
        const seen = [];
        const count = task.skill === 'vocabulary' ? settings.perWord : 1;
        for (let index = 0; index < count; index++) {
          const question = choose(session, task, seen);
          if (!question || seen.some(previous => previous.id === question.id)) break;
          seen.push(question);
          pushQuestion(session, task, question);
        }
      }
      if (settings.variedOrder && !settings.order) {
        const offsets = session.tasks.map(task => task.recordIndex);
        session.questions.sort((a, b) => offsets[a.taskId] - offsets[b.taskId] || a.type.localeCompare(b.type));
      }
      session.questions = ordered(session.questions, settings.order);
    } else {
      const initial = [...session.tasks].sort((left, right) => priority(session, right, now) - priority(session, left, now));
      session.queue = ordered(initial, settings.order).map(task => task.id);
      schedule(session);
    }
    if (!session.questions.length) {
      session.status = 'finished';
      session.finishedAt = now;
    }
    return session;
  }

  function current(session) {
    return session.status === 'active' ? session.questions[session.index] || null : null;
  }

  function audio(target, {choices = false} = {}) {
    const question = target.questions ? current(target) : target;
    if (!question || target.questions && !target.settings.audioReplay) return '';
    if (question.type === 'dictation') return question.answer;
    const spoken = (question.type === 'meaning-choice' ? question.prompt
      : hideAnswer(question.prompt, [question.answer, ...(question.acceptedSpellings || [])]))
      .replace(/_{2,}/g, 'blank');
    return choices && isChoice(question) ? [spoken, ...question.choices].join(' ') : spoken;
  }

  function hintDetails(q) {
    const answer = q.answer;
    const letters = Array.from(answer);
    const letterHint = 'Starts with “' + letters[0] + '” and has ' + letters.filter(letter => letter !== ' ').length + ' characters excluding spaces.';
    const partial = 'Starts with “' + letters.slice(0, Math.min(3, letters.length - 1)).join('') + '”.';
    const contents = q.type === 'meaning-choice' ? [q.partOfSpeech, q.context[0]]
      : [q.type !== 'definition-recall' && q.definition, q.partOfSpeech,
        q.type === 'definition-recall' && q.context[0], letters.length > 1 && letterHint, letters.length > 2 && partial];
    return distinct(contents.filter(Boolean).map(item => q.type === 'meaning-choice' ? item : hideAnswer(item, [answer])))
      .concat(answer);
  }

  function lastHint(session) {
    const question = current(session);
    if (!question || !session.hintStage || session.settings.allowHints === false) return null;
    const text = hintDetails(question)[session.hintStage - 1];
    return text ? {stage: session.hintStage, text, revealed: session.revealed} : null;
  }

  function hint(session) {
    const question = current(session);
    if (!question || session.type === 'test' || session.settings.allowHints === false || session.feedback || session.revealed) return null;
    const stages = hintDetails(question);
    session.hintStage++;
    session.revealed = session.hintStage === stages.length;
    return lastHint(session);
  }

  function spacing(stats, correct, now, intervals) {
    if (stats.mastered && (stats.nextReview <= now || !correct)) {
      const previous = Math.max(0, intervals.indexOf(stats.interval));
      const index = correct ? Math.min(previous + 1, intervals.length - 1) : Math.max(0, previous - 1);
      stats.interval = intervals[index];
      stats.nextReview = now + stats.interval * DAY;
    } else if (!stats.mastered && stats.streak >= 2) {
      stats.mastered = true;
      stats.interval = intervals[0];
      stats.nextReview = now + stats.interval * DAY;
    }
  }

  function evidence(session, result) {
    const q = result.question;
    const {correct, assisted, at} = result;
    const stats = progressFor(session.progress, session.records[q.recordIndex]);
    if (q.type === 'dictation') {
      const skill = stats.spelling;
      if (assisted) {
        skill.assisted++;
        if (session.settings.phasedVocabulary) skill.streak = 0;
      } else {
        skill.attempts++;
        skill.correct += Number(correct);
        if (!correct) skill.misses++;
        skill.lastAt = at;
        skill.streak = correct ? skill.streak + 1 : 0;
        spacing(skill, correct, at, session.settings.reviewIntervals);
      }
      return;
    }
    const vocabulary = stats.vocabulary;
    vocabulary.prompts = [...vocabulary.prompts.filter(id => id !== q.promptId), q.promptId].slice(-40);
    vocabulary.lastAt = at;
    if (assisted) vocabulary.assisted += Number(correct);
    if (session.settings.masteryPractice && (!correct || session.settings.phasedVocabulary && assisted)) vocabulary.streak = 0;
    if ((isChoice(q) || session.settings.phasedVocabulary && isBank(q)) && !assisted) {
      vocabulary.recognitionAttempts++;
      vocabulary.recognition += Number(correct);
    }
    if (isRecall(q) && !assisted) {
      vocabulary.attempts++;
      vocabulary.correct += Number(correct);
      if (correct) {
        const distinctPrompts = !session.settings.phasedVocabulary && variants(session, session.tasks[q.taskId]).filter(isRecall)
          .some(candidate => candidate.id !== q.promptId);
        if (!distinctPrompts || vocabulary.lastIndependentPrompt !== q.promptId || !vocabulary.streak) vocabulary.streak++;
        vocabulary.lastIndependentPrompt = q.promptId;
      } else {
        vocabulary.streak = 0;
      }
      spacing(vocabulary, correct, at, session.settings.reviewIntervals);
    }
    if (!correct && !assisted) vocabulary.misses++;
  }

  function recordAnswer(session, input, now, skipped) {
    const question = current(session);
    if (!question || session.feedback || !skipped && !norm(input)) return null;
    if (!skipped && isChoice(question) && !question.choices.some(choice => key(choice) === key(input))) return null;
    const decision = skipped ? {correct: false, kind: 'skipped'} : evaluate(question, input, session.records, session.settings.allowVariants);
    const result = {...decision, question,
      input: norm(input), assisted: session.hintStage > 0 || isBank(question) && !session.settings.phasedVocabulary, hintCount: session.hintStage, at: now};
    session.results.push(result);
    if (session.type === 'test') {
      session.index++;
      if (!current(session)) finish(session, now);
      return {submitted: true};
    }
    evidence(session, result);
    const task = session.tasks[question.taskId];
    task.attempts++;
    task.consecutiveMisses = result.correct && (!session.settings.phasedVocabulary || !result.assisted) ? 0 : task.consecutiveMisses + 1;
    if (session.settings.phasedVocabulary) recordPhase(task, result);
    const wantsRecognition = session.settings.difficulty === 'beginner' && task.skill === 'vocabulary';
    const wantsAssisted = session.settings.difficulty === 'intermediate' && task.skill === 'vocabulary';
    const validSuccess = result.correct && !result.assisted || result.correct && isBank(question) && !result.hintCount && wantsAssisted;
    if (validSuccess) task.successes++;
    const skill = wordProgress(session.progress, session.records[question.recordIndex])[task.skill];
    const mastered = session.settings.masteryPractice ? taskMastered(session, task) : skill.mastered;
    const done = session.settings.phasedVocabulary ? mastered : wantsRecognition || wantsAssisted ? task.successes >= 2
      : mastered && result.correct && !result.assisted && (task.skill === 'spelling' || isRecall(question));
    if (!done && (session.settings.masteryPractice || task.attempts < MAX_PRACTICE_ATTEMPTS) && !session.queue.includes(task.id)) session.queue.push(task.id);
    session.feedback = {correct: result.correct, kind: result.kind, assisted: result.assisted, input: result.input,
      correctionRequired: session.revealed && (!session.settings.phasedVocabulary || !result.correct) ||
        !result.correct && question.type === 'dictation' && session.settings.retypeOnMiss !== false,
      answer: question.answer, explanation: question.explanation || ''};
    return session.feedback;
  }

  function submit(session, input, now = Date.now()) {
    return recordAnswer(session, input, now, false);
  }

  function skip(session, now = Date.now()) {
    return recordAnswer(session, '', now, true);
  }

  function correct(session, input) {
    const q = current(session);
    if (!q || !session.feedback?.correctionRequired || !evaluate(q, input, session.records, session.settings.allowVariants).correct) return false;
    session.feedback.correctionRequired = false;
    return true;
  }

  function advance(session, now = Date.now()) {
    if (session.type === 'test' || !session.feedback || session.feedback.correctionRequired) return current(session);
    session.index++;
    session.feedback = null;
    session.hintStage = 0;
    session.revealed = false;
    schedule(session);
    if (session.status === 'finished') session.finishedAt = now;
    return current(session);
  }

  function finish(session, now = Date.now()) {
    if (session.status !== 'active') return session;
    session.finishedAt = now;
    if (session.type === 'test' && session.index < session.questions.length) {
      session.status = 'unfinished';
      return session;
    }
    session.status = 'finished';
    if (session.type === 'test') session.results.forEach(result => evidence(session, result));
    return session;
  }

  function resume(session) {
    if (session.status === 'unfinished') {
      session.status = 'active';
      session.finishedAt = null;
    }
    return session;
  }

  function sessionOK(session) {
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const string = value => typeof value === 'string';
    const strings = value => Array.isArray(value) && value.every(string);
    const count = value => Number.isInteger(value) && value >= 0;
    const moment = value => Number.isFinite(value) && value >= 0;
    if (!object(session) || session.v !== 1) return false;
    const {type, mode, status, settings, records, questions, tasks, queue, progress, results, index, hintStage, feedback} = session;
    if (!['practice', 'test'].includes(type) || !['spelling', 'vocabulary', 'mixed'].includes(mode) ||
        !['active', 'finished', 'unfinished'].includes(status) || (status === 'unfinished' && type !== 'test') ||
        !object(settings) || settings.type !== type || settings.mode !== mode ||
        !['adaptive', 'beginner', 'intermediate', 'advanced'].includes(settings.difficulty) ||
        ![1, 2, 3].includes(settings.perWord) || !count(settings.choiceOffset) ||
        typeof settings.multipleChoice !== 'boolean' || typeof settings.audioReplay !== 'boolean' ||
        settings.allowHints !== undefined && typeof settings.allowHints !== 'boolean' ||
        !Array.isArray(settings.reviewIntervals) || !settings.reviewIntervals.length ||
        !settings.reviewIntervals.every(days => Number.isFinite(days) && days > 0) ||
        ![records, questions, tasks, queue, results].every(Array.isArray) || !object(progress) ||
        !count(index) || index > questions.length || !count(hintStage) || hintStage > 5 ||
        typeof session.revealed !== 'boolean' || !moment(session.startedAt) ||
        (status === 'active' ? session.finishedAt !== null || index >= questions.length : !moment(session.finishedAt))) return false;

    if (!records.every(record => {
      if (!object(record) || !string(record.word) || !norm(record.word)) return false;
      const v = record.vocabulary;
      return v == null || object(v) && ['definition', 'partOfSpeech', 'senseId', 'status'].every(field => v[field] == null || string(v[field])) &&
        ['examples', 'meaningDistractors', 'acceptedSpellings'].every(field => v[field] == null || strings(v[field])) &&
        (v.clozeQuestions == null || Array.isArray(v.clozeQuestions) && v.clozeQuestions.every(q =>
          object(q) && string(q.sentence) && ['id', 'answer', 'explanation'].every(field => q[field] == null || string(q[field]))));
    })) return false;
    if (!tasks.every((task, i) => object(task) && task.id === i && count(task.recordIndex) && task.recordIndex < records.length &&
        ['spelling', 'vocabulary'].includes(task.skill) && (task.skill !== 'vocabulary' || vocabularyFor(records[task.recordIndex], type === 'test')) &&
        [task.attempts, task.successes, task.consecutiveMisses].every(count) &&
        (!settings.phasedVocabulary || typeof task.bankPassed === 'boolean' && count(task.streak) && task.streak <= task.attempts && string(task.lastRecall)) &&
        (settings.masteryPractice === true || task.attempts <= MAX_PRACTICE_ATTEMPTS) &&
        task.successes <= task.attempts && task.consecutiveMisses <= task.attempts)) return false;
    if (new Set(queue).size !== queue.length || !queue.every(id => count(id) && id < tasks.length)) return false;
    if (new Set(questions.map(question => question?.id)).size !== questions.length || !questions.every(q => {
      if (!object(q) || !count(q.taskId) || !count(q.recordIndex)) return false;
      const task = tasks[q.taskId];
      return task?.recordIndex === q.recordIndex && records[q.recordIndex].word === q.word &&
        [q.id, q.promptId, q.prompt, q.answer, q.senseId].every(string) && !!norm(q.answer) &&
        [q.choices, q.bank, q.acceptedSpellings].every(strings) &&
        (task.skill === 'spelling' ? q.type === 'dictation' && q.answer === q.word
          : (isRecall(q) || isChoice(q) || isBank(q)) && strings(q.context) &&
            string(q.definition) && string(q.partOfSpeech) &&
            (!isChoice(q) || q.choices.length >= 2 && q.choices.includes(q.answer)) &&
            (!isBank(q) || q.bank.length >= (settings.phasedVocabulary ? 1 : 2) && q.bank.includes(q.answer)));
    })) return false;
    if (!Object.values(progress).every(item => object(item) && ['spelling', 'vocabulary'].every(name => {
      const skill = item[name];
      if (skill == null) return true;
      return object(skill) &&
        ['attempts', 'correct', 'misses', 'streak', 'assisted', 'recognition', 'recognitionAttempts']
          .every(field => skill[field] == null || count(skill[field])) &&
        ['nextReview', 'lastAt', 'interval'].every(field => skill[field] == null || moment(skill[field])) &&
        ['senseId', 'lastIndependentPrompt'].every(field => skill[field] == null || string(skill[field])) &&
        (skill.mastered == null || typeof skill.mastered === 'boolean') && (skill.prompts == null || strings(skill.prompts));
    }))) return false;
    if (results.length !== index + Number(!!feedback) || results.length > questions.length || !results.every((result, i) =>
      object(result) && result.question?.id === questions[i].id && result.question.answer === questions[i].answer &&
      result.question.taskId === questions[i].taskId && result.question.recordIndex === questions[i].recordIndex &&
      result.question.type === questions[i].type && result.question.promptId === questions[i].promptId &&
      typeof result.correct === 'boolean' && typeof result.assisted === 'boolean' && count(result.hintCount) &&
      moment(result.at) && string(result.kind) && string(result.input))) return false;
    if (type === 'test') return !feedback && queue.length === 0 && hintStage === 0 && !session.revealed &&
      (status === 'finished' ? index === questions.length : index < questions.length);
    return feedback == null || object(feedback) && typeof feedback.correctionRequired === 'boolean' && string(feedback.answer) &&
      typeof feedback.correct === 'boolean' && typeof feedback.assisted === 'boolean' && string(feedback.kind);
  }

  function measure(results, filter) {
    const assessed = results.filter(filter);
    const correct = assessed.filter(result => result.correct).length;
    return {correct, answered: assessed.length, percent: assessed.length ? Math.round(correct * 100 / assessed.length) : null};
  }

  function report(session) {
    const results = session.type === 'test' && session.status !== 'finished' ? [] : session.results;
    const firstDictation = new Set();
    const firstSpelling = results.filter(result => {
      const {type, taskId} = result.question;
      if (type !== 'dictation' || firstDictation.has(taskId)) return false;
      firstDictation.add(taskId);
      return !result.assisted;
    });
    return {
      status: session.status, type: session.type, total: session.type === 'test' ? session.questions.length : session.tasks.length,
      answered: session.results.length, correct: results.filter(result => result.correct).length,
      assisted: results.filter(result => result.assisted).length, hints: results.reduce((total, result) => total + result.hintCount, 0),
      metrics: {
        spelling: measure(firstSpelling, () => true),
        recognition: measure(results, result => (isChoice(result.question) || session.settings.phasedVocabulary && isBank(result.question)) && !result.assisted),
        recall: measure(results, result => isRecall(result.question) && !result.assisted),
        combined: measure(results, result => isRecall(result.question) && !result.assisted)
      }
    };
  }

  function mastery(progress, records, now = Date.now()) {
    const output = {};
    for (const skill of ['spelling', 'vocabulary']) {
      const levels = {new: 0, learning: 0, familiar: 0, mastered: 0, due: 0};
      const words = {new: [], learning: [], familiar: [], mastered: [], due: []};
      for (const record of describe(records)) {
        if (skill === 'vocabulary' && !record.vocabulary?.definition) continue;
        const stats = wordProgress(progress, record)[skill];
        const stage = stats.mastered ? (stats.nextReview <= now ? 'due' : 'mastered')
          : stats.streak ? 'familiar' : stats.attempts || stats.recognitionAttempts || stats.assisted ? 'learning' : 'new';
        levels[stage]++;
        words[stage].push(record.word);
      }
      const total = Object.values(levels).reduce((sum, count) => sum + count, 0);
      output[skill] = {...levels, total, words,
        percent: total && total > levels.new ? Math.round((levels.mastered + levels.due) * 100 / total) : null};
    }
    return output;
  }

  function flashcards(records, {reverse = false, order} = {}) {
    return ordered(describe(records).filter(record => record.vocabulary?.definition).map(({word, vocabulary}) => {
      const front = reverse ? hideAnswer(vocabulary.definition, [word, ...(vocabulary.acceptedSpellings || [])]) : word;
      return {word, definition: vocabulary.definition, partOfSpeech: vocabulary.partOfSpeech || '',
        examples: vocabulary.examples || [], front, back: reverse ? word : vocabulary.definition, audio: word,
        frontAudio: front.replace(/_{2,}/g, 'blank')};
    }), order);
  }

  return {createSession, current, evaluate, audio, hint, lastHint, submit, skip, correct, advance, finish, resume, upgradePractice, sessionOK, report, mastery, practiceMastered, practiceWordProgress, practiceAudioPrompts, flashcards};
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Learning;
