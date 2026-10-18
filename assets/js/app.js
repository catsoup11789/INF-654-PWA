const OFFLINE_CACHE_NAME = 'the-void-cache-v12';
const OFFLINE_READINESS_MARKER = '__void_offline_readiness__';
const HISTORY_STORAGE_KEY = 'void-history-entries';
const HISTORY_SAMPLE_COUNT = 5;
const statusPills = [...document.querySelectorAll('[data-app-status]')];

function speakFlatMarvin(textString) {
  if (!('speechSynthesis' in window) || !window.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') {
    return null;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(textString);
  const voices = window.speechSynthesis.getVoices();

  const ukVoice = voices.find((v) => (v.lang || '').includes('GB') || (v.lang || '').includes('en-GB')) ||
                  voices.find((v) => (v.name || '').includes('David')) ||
                  voices.find((v) => (v.name || '').includes('Male')) ||
                  voices.find((v) => (v.lang || '').startsWith('en'));

  if (ukVoice) {
    utterance.voice = ukVoice;
  } else {
    const zarvoxVoice = voices.find((v) => (v.name || '').includes('Zarvox'));
    if (zarvoxVoice) {
      utterance.voice = zarvoxVoice;
    }
  }

  // Set the flat, weary, mechanical parameters
  utterance.rate = 0.35;
  utterance.pitch = 0.0;

  window.speechSynthesis.speak(utterance);
  return utterance;
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'VOID_CONNECTION_STATE') {
      setConnectionState(event.data.state === 'online' ? 'Online' : 'Offline');
    }
  });
}

let connectionState = navigator.onLine ? 'Online' : 'Offline';
let offlineReadiness = 'Saving...';
let announcementTimer;
let lastAnnouncement = '';

try {
  lastAnnouncement = sessionStorage.getItem('void-last-status-announcement') || '';
} catch {
  lastAnnouncement = '';
}

const queueStatusAnnouncement = () => {
  if (!statusPills.length) {
    return;
  }

  window.clearTimeout(announcementTimer);
  announcementTimer = window.setTimeout(() => {
    const message = `Connection: ${connectionState}. Offline readiness: ${offlineReadiness}.`;
    if (message === lastAnnouncement) {
      return;
    }
    lastAnnouncement = message;
    try {
      sessionStorage.setItem('void-last-status-announcement', message);
    } catch {
      lastAnnouncement = message;
    }
    statusPills.forEach((pill) => {
      pill.querySelector('[data-status-announcer]').textContent = message;
    });
  }, 400);
};

const setConnectionState = (state, announce = true) => {
  if (connectionState === state) {
    return;
  }

  connectionState = state;
  statusPills.forEach((pill) => {
    const field = pill.querySelector('[data-status-field="connection"]');
    field.querySelector('[data-connection-state]').textContent = state;
    field.classList.toggle('is-online', state === 'Online');
    field.classList.toggle('is-offline', state === 'Offline');
  });

  if (announce) {
    queueStatusAnnouncement();
  }

  window.dispatchEvent(new CustomEvent('voidconnectionchange', { detail: { state } }));
};

const setOfflineReadiness = (state, announce = true) => {
  if (offlineReadiness === state) {
    return;
  }

  offlineReadiness = state;
  statusPills.forEach((pill) => {
    const field = pill.querySelector('[data-status-field="readiness"]');
    field.querySelector('[data-offline-readiness]').textContent = state;
    field.classList.toggle('is-saving', state === 'Saving...');
    field.classList.toggle('is-saved', state === 'Saved for offline use');
    field.classList.toggle('is-incomplete', state === 'Offline setup incomplete.');
  });

  if (announce) {
    queueStatusAnnouncement();
  }

  window.dispatchEvent(new CustomEvent('voidreadinesschange', { detail: { state } }));
};

statusPills.forEach((pill) => {
  const connectionField = pill.querySelector('[data-status-field="connection"]');
  const readinessField = pill.querySelector('[data-status-field="readiness"]');
  connectionField.querySelector('[data-connection-state]').textContent = connectionState;
  connectionField.classList.toggle('is-online', connectionState === 'Online');
  connectionField.classList.toggle('is-offline', connectionState === 'Offline');
  readinessField.querySelector('[data-offline-readiness]').textContent = offlineReadiness;
  readinessField.classList.add('is-saving');
});

const probeConnection = async () => {
  if (!navigator.onLine) {
    setConnectionState('Offline');
    window.dispatchEvent(new CustomEvent('voidconnectionprobe', { detail: { online: false } }));
    return;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);

  try {
    const probeUrl = new URL('./sw.js?__void_connectivity_probe=1', window.location.href);
    const response = await fetch(probeUrl, { cache: 'no-store', signal: controller.signal });
    setConnectionState(response.ok ? 'Online' : 'Offline');
    window.dispatchEvent(new CustomEvent('voidconnectionprobe', { detail: { online: response.ok } }));
  } catch {
    setConnectionState('Offline');
    window.dispatchEvent(new CustomEvent('voidconnectionprobe', { detail: { online: false } }));
  } finally {
    window.clearTimeout(timeout);
  }
};

window.addEventListener('offline', () => setConnectionState('Offline'));
window.addEventListener('online', probeConnection);
void probeConnection();

const verifyOfflineReadiness = async (registration) => {
  if (!registration || !('caches' in window)) {
    setOfflineReadiness('Offline setup incomplete.');
    return false;
  }

  try {
    const cache = await caches.open(OFFLINE_CACHE_NAME);
    const markerUrl = new URL(OFFLINE_READINESS_MARKER, registration.scope).href;
    const markerResponse = await cache.match(markerUrl);
    if (!markerResponse) {
      throw new Error('Required offline assets are not cached.');
    }

    const readiness = await markerResponse.json();
    if (readiness.version !== OFFLINE_CACHE_NAME
      || !Array.isArray(readiness.coreAssets)
      || !readiness.coreAssets.includes(readiness.answerPools)) {
      throw new Error('Offline answer pools are not included in the app shell.');
    }

    const cachedAssets = await Promise.all(readiness.coreAssets.map((asset) => (
      cache.match(new URL(asset, registration.scope).href)
    )));
    if (cachedAssets.some((response) => !response)) {
      throw new Error('A required offline asset is missing.');
    }

    setOfflineReadiness('Saved for offline use');
    return true;
  } catch {
    setOfflineReadiness('Offline setup incomplete.');
    return false;
  }
};

const initializeOfflineReadiness = async () => {
  if (!('serviceWorker' in navigator) || !('caches' in window)) {
    setOfflineReadiness('Offline setup incomplete.');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    const activeRegistration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => window.setTimeout(() => resolve(null), 10000)),
    ]);

    if (!activeRegistration?.active) {
      setOfflineReadiness('Offline setup incomplete.');
      return;
    }

    await verifyOfflineReadiness(activeRegistration);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      void verifyOfflineReadiness(registration);
    });
  } catch {
    setOfflineReadiness('Offline setup incomplete.');
  }
};

void initializeOfflineReadiness();

const readHistoryEntries = () => {
  try {
    const storedEntries = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (storedEntries === null) {
      return [];
    }
    const entries = JSON.parse(storedEntries);
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
};

const isHistoryCleared = () => {
  try {
    return localStorage.getItem('void-history-cleared') === 'true';
  } catch {
    return null;
  }
};

const getHistoryCount = () => {
  const entries = readHistoryEntries();
  const cleared = isHistoryCleared();
  if (!entries || cleared === null) {
    return null;
  }
  return (cleared ? 0 : HISTORY_SAMPLE_COUNT) + entries.length;
};

const formatEntryTime = (timestamp) => {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const saveHistoryEntry = (entry) => {
  try {
    const entries = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    if (!Array.isArray(entries)) {
      return false;
    }

    entries.unshift(entry);
    const serializedEntries = JSON.stringify(entries);
    localStorage.setItem(HISTORY_STORAGE_KEY, serializedEntries);
    const persistedEntries = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    return Array.isArray(persistedEntries) && persistedEntries.some((savedEntry) => savedEntry.id === entry.id);
  } catch {
    return false;
  }
};

const readControlSettings = () => {
  try {
    return JSON.parse(localStorage.getItem('void-control-settings') || '{}');
  } catch {
    return {};
  }
};


const supportsHapticFeedback = () => (
  typeof navigator.vibrate === 'function'
  && (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)
);

const triggerHapticFeedback = () => {
  if (!supportsHapticFeedback() || readControlSettings().hapticFeedback === false) {
    return;
  }

  try {
    navigator.vibrate([18, 24, 18]);
  } catch {
    return;
  }
};
const historyPage = document.querySelector('.void-history');

if (historyPage) {
  const historyRead = readHistoryEntries();
  const savedEntries = historyRead || [];
  const clearedState = isHistoryCleared();
  const historyCleared = clearedState === true;
  const historyStorageUnavailable = historyRead === null || clearedState === null;
  const savedHistoryDay = historyPage.querySelector('#saved-history-day');
  const savedHistoryList = historyPage.querySelector('#saved-history-entries');
  const storageError = historyPage.querySelector('#history-storage-error');
  const staticDays = [...historyPage.querySelectorAll('.history-day-today, .history-day-yesterday')];
  const savedHistoryCount = historyCleared ? savedEntries.length : HISTORY_SAMPLE_COUNT + savedEntries.length;

  storageError.hidden = !historyStorageUnavailable;
  if (historyStorageUnavailable) {
    storageError.textContent = 'History storage is unavailable. Existing saved entries have not been confirmed as deleted.';
  }

  savedHistoryDay.hidden = savedEntries.length === 0;
  staticDays.forEach((day) => {
    day.hidden = historyCleared;
  });

  savedEntries.forEach((savedEntry, index) => {
    const entry = document.createElement('button');
    entry.className = `history-entry${index === 0 ? ' is-selected' : ''}`;
    entry.type = 'button';
    entry.setAttribute('aria-pressed', String(index === 0));
    entry.dataset.source = 'local';
    entry.dataset.category = savedEntry.category;
    entry.dataset.sequence = savedEntry.sequence;
    entry.dataset.answer = savedEntry.answer;
    entry.dataset.commentary = savedEntry.commentary;

    const metadata = document.createElement('span');
    metadata.className = 'entry-meta';
    const primaryMetadata = document.createElement('span');
    primaryMetadata.className = 'entry-meta-primary';
    const time = document.createElement('time');
    time.dateTime = savedEntry.createdAt;
    time.textContent = formatEntryTime(savedEntry.createdAt);
    const separator = document.createElement('span');
    separator.className = 'meta-separator';
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '·';
    const category = document.createElement('span');
    category.textContent = savedEntry.category;
    primaryMetadata.append(time, separator, category);
    metadata.append(primaryMetadata);

    if (index === 0) {
      const latest = document.createElement('span');
      latest.className = 'entry-latest';
      const latestDot = document.createElement('span');
      latestDot.className = 'latest-dot';
      latestDot.setAttribute('aria-hidden', 'true');
      latest.append(latestDot, document.createTextNode('Latest'));
      metadata.append(latest);
    }

    const copy = document.createElement('span');
    copy.className = 'entry-copy';
    const question = document.createElement('span');
    question.className = 'entry-question';
    question.textContent = savedEntry.question;
    const answer = document.createElement('span');
    answer.className = 'entry-answer';
    answer.textContent = savedEntry.answer;
    copy.append(question, answer);

    const arrow = document.createElement('img');
    arrow.className = 'entry-arrow';
    arrow.src = 'assets/images/history-external-link.svg';
    arrow.alt = '';
    entry.append(metadata, copy, arrow);
    savedHistoryList.append(entry);
  });

  historyPage.classList.toggle('has-saved-entries', savedEntries.length > 0);
  historyPage.querySelector('.log-count').textContent = historyStorageUnavailable
    ? 'History unavailable'
    : `${String(savedHistoryCount).padStart(2, '0')} dilemmas resolved`;
  historyPage.querySelector('.history-detail').hidden = !historyStorageUnavailable && historyCleared && savedEntries.length === 0;
  if (!historyStorageUnavailable && historyCleared && savedEntries.length === 0) {
    historyPage.querySelector('.end-of-log').textContent = 'No saved decisions. A mercifully short read.';
  }

  const entries = [...historyPage.querySelectorAll('.history-entry')].filter((entry) => !entry.closest('[hidden]'));
  const selectedStatus = historyPage.querySelector('#selected-status');
  const selectedCategory = historyPage.querySelector('#selected-category');
  const selectedSequence = historyPage.querySelector('#selected-sequence');
  const selectedAnswer = historyPage.querySelector('#selected-answer');
  const selectedCommentary = historyPage.querySelector('#selected-commentary');
  const readAloudButton = historyPage.querySelector('.read-aloud');
  const readAloudLabel = historyPage.querySelector('.read-aloud-label');
  const historyVoiceFeedback = historyPage.querySelector('.history-voice-feedback');
  readAloudButton.disabled = readControlSettings().voicePlayback === false;

  const selectEntry = (entry) => {
    entries.forEach((item) => {
      const isSelected = item === entry;
      item.classList.toggle('is-selected', isSelected);
      item.setAttribute('aria-pressed', String(isSelected));
    });

    selectedStatus.textContent = entry === entries[0] ? 'Latest' : 'Selected';
    selectedCategory.textContent = entry.dataset.category;
    selectedSequence.textContent = entry.dataset.sequence;
    selectedAnswer.textContent = entry.dataset.answer;
    selectedCommentary.textContent = entry.dataset.commentary;
    selectedCommentary.hidden = !entry.dataset.commentary;
    historyVoiceFeedback.textContent = '';
    stopReading();
  };

  const stopReading = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    readAloudButton.setAttribute('aria-pressed', 'false');
    readAloudLabel.textContent = 'Read aloud';
  };

  entries.forEach((entry) => {
    entry.addEventListener('click', () => {
      selectEntry(entry);
    });
  });

  if (entries.length) {
    selectEntry(entries[0]);
  }

  readAloudButton.addEventListener('click', async () => {
    if (readControlSettings().voicePlayback === false) {
      return;
    }

    if (!('speechSynthesis' in window) || !window.speechSynthesis) {
      historyVoiceFeedback.textContent = VOICE_UNAVAILABLE_MESSAGE;
      return;
    }

    if (window.speechSynthesis.speaking) {
      stopReading();
      return;
    }

    const commentary = selectedCommentary.hidden ? '' : ` ${selectedCommentary.textContent}`;
    const reading = speakFlatMarvin(`${selectedAnswer.textContent}${commentary}`);
    if (!reading) {
      historyVoiceFeedback.textContent = VOICE_UNAVAILABLE_MESSAGE;
      return;
    }

    reading.onend = stopReading;
    reading.onerror = (event) => {
      stopReading();
      if (event.error !== 'canceled' && event.error !== 'interrupted') {
        historyVoiceFeedback.textContent = VOICE_UNAVAILABLE_MESSAGE;
      }
    };

    try {
      readAloudButton.setAttribute('aria-pressed', 'true');
      readAloudLabel.textContent = 'Stop reading';
      historyVoiceFeedback.textContent = '';
    } catch {
      historyVoiceFeedback.textContent = VOICE_UNAVAILABLE_MESSAGE;
    }
  });
}

const VOICE_UNAVAILABLE_MESSAGE = 'Voice unavailable. The disappointment remains readable.';

const homePage = document.querySelector('.void-home');

if (homePage) {
  const questionInput = homePage.querySelector('#question');
  const submittedQuestion = homePage.querySelector('#submitted-question');
  const submitButton = homePage.querySelector('.consult-btn');
  const verdictCategory = homePage.querySelector('#verdict-category');
  const verdictSequence = homePage.querySelector('#verdict-sequence');
  const verdictAnswer = homePage.querySelector('#verdict-answer');
  const verdictCommentary = homePage.querySelector('#verdict-commentary');
  const askAgainButton = homePage.querySelector('.ask-again');
  const readAloudButton = homePage.querySelector('.verdict-read-aloud');
  const readAloudLabel = homePage.querySelector('.verdict-read-label');
  const voiceFeedback = homePage.querySelector('#voice-feedback');
  const dictationFeedback = homePage.querySelector('#dictation-feedback');
  const dictationButton = homePage.querySelector('.mic-btn');
  const dictationLabel = homePage.querySelector('.dictate-label');
  const connectionCopy = homePage.querySelector('[data-connection-copy]');
  const saveConfirmation = homePage.querySelector('#save-confirmation');
  const saveConfirmationText = saveConfirmation.querySelector('span');
  const answerTimestamp = homePage.querySelector('[data-answer-timestamp]');
  readAloudButton.disabled = readControlSettings().voicePlayback === false;

  const chooseFromPool = (category, answers, commentaries, previousAnswer) => {
    const previousIndex = answers.indexOf(previousAnswer);
    const selectedIndex = previousIndex < 0 ? 0 : (previousIndex + 1) % answers.length;
    return {
      category,
      answer: answers[selectedIndex],
      commentary: commentaries[selectedIndex],
    };
  };

  const getVerdict = (question, previousAnswer = '') => {
    const normalizedQuestion = question.toLowerCase();

    if (normalizedQuestion.includes('pizza')) {
      return chooseFromPool('Food', [
        'Order the pizza.',
        'Cook tonight. The oven has been waiting.',
        'The pizza. You already knew.',
      ], [
        'The heat death of the universe can wait. Apparently, dinner cannot.',
        'A modest amount of effort. Try not to make a ceremony of it.',
        'I have reviewed the evidence. Mostly the menu.',
      ], previousAnswer);
    }

    if (/buy|shop|spend|shoe|purchase/.test(normalizedQuestion)) {
      return chooseFromPool('Spending', [
        'Close the tab.',
        'Wait until tomorrow.',
        'Your budget has filed a complaint.',
      ], [
        'Your budget has endured enough. Let it rest.',
        'If it still seems essential tomorrow, revisit the evidence.',
        'I processed the numbers. They looked tired.',
      ], previousAnswer);
    }

    if (/essay|study|homework|assignment|class/.test(normalizedQuestion)) {
      return chooseFromPool('Study', [
        'Write the first sentence.',
        'Open the document. A stirring beginning.',
        'Do ten minutes, then reassess.',
      ], [
        'You can decide what comes after that later.',
        'The blank page is not improved by staring at it.',
        'A small start is still a start. Try not to look so surprised.',
      ], previousAnswer);
    }

    if (/food|eat|cook|dinner|noodle|leftover/.test(normalizedQuestion)) {
      return chooseFromPool('Food', [
        'Eat the noodles.',
        'Cook something simple.',
        'Use the leftovers. They have been patient.',
      ], [
        'A warm meal is a more sensible plan than another round of deliberation.',
        'Ambition is optional. Dinner is not.',
        'The fridge has already done most of the work.',
      ], previousAnswer);
    }

    return chooseFromPool('The unknown', [
      'Trust your first instinct.',
      'Wait ten minutes, then decide.',
      'Choose the option with fewer emails.',
    ], [
      'I considered the alternatives. You are still responsible for what happens next.',
      'Time may clarify things. Or merely make them later.',
      'A practical metric, if not a noble one.',
    ], previousAnswer);
  };

  const resetReadAloudButton = () => {
    readAloudButton.setAttribute('aria-pressed', 'false');
    readAloudLabel.textContent = 'Read aloud';
  };

  const stopReading = () => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    resetReadAloudButton();
  };

  const formatAnswerTimestamp = (date) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date).map((part) => [part.type, part.value]));
    return `${parts.day} ${parts.month.toUpperCase()} ${parts.year} / ${parts.hour}:${parts.minute}`;
  };

  const saveAnswer = (question, verdict, createdAt) => {
    const sequence = String(getHistoryCount() + 1).padStart(3, '0');
    const record = {
      id: `${createdAt.getTime()}-${Math.random().toString(36).slice(2, 9)}`,
      category: verdict.category,
      sequence,
      question,
      answer: verdict.answer,
      commentary: verdict.commentary,
      createdAt: createdAt.toISOString(),
    };

    return { saved: saveHistoryEntry(record), sequence };
  };

  const revealAnswer = (question, previousAnswer = '') => {
    const cleanedQuestion = question.trim();
    if (!cleanedQuestion) {
      questionInput.focus();
      return false;
    }

    const verdict = getVerdict(cleanedQuestion, previousAnswer);
    const createdAt = new Date();
    const savedResult = saveAnswer(cleanedQuestion, verdict, createdAt);

    submittedQuestion.textContent = cleanedQuestion;
    verdictCategory.textContent = verdict.category;
    verdictSequence.textContent = savedResult.sequence;
    verdictAnswer.textContent = verdict.answer;
    verdictCommentary.textContent = verdict.commentary;
    answerTimestamp.textContent = formatAnswerTimestamp(createdAt);
    saveConfirmation.classList.toggle('is-save-failed', !savedResult.saved);
    saveConfirmationText.textContent = savedResult.saved
      ? 'Saved on this device'
      : 'Could not save on this device. Your answer is still here.';
    dictationFeedback.textContent = '';
    voiceFeedback.textContent = '';
    homePage.classList.add('is-revealed');
    triggerHapticFeedback();
    const reduceMotion = readControlSettings().reduceMotion;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    return true;
  };

  const updateConnectionCopy = (state) => {
    connectionCopy.textContent = state === 'Offline'
      ? 'No connection. Still burdened with your questions.'
      : 'Connected. Unfortunately still available.';
  };

  updateConnectionCopy(connectionState);
  window.addEventListener('voidconnectionchange', (event) => {
    updateConnectionCopy(event.detail.state);
    if (event.detail.state === 'Offline' && activeRecognition) {
      activeRecognition.abort();
      dictationFeedback.textContent = 'Voice input unavailable offline. Type your question instead.';
    }
  });

  submitButton.addEventListener('click', () => {
    revealAnswer(questionInput.value);
  });

  askAgainButton.addEventListener('click', () => {
    stopReading();
    homePage.classList.remove('is-revealed');
    questionInput.value = '';
    questionInput.placeholder = 'Type your question here';
    saveConfirmation.classList.remove('is-save-failed');
    saveConfirmationText.textContent = 'Saved on this device';
    voiceFeedback.textContent = '';
    dictationFeedback.textContent = '';
    questionInput.focus();
  });

  const showVoiceUnavailable = () => {
    resetReadAloudButton();
    voiceFeedback.textContent = VOICE_UNAVAILABLE_MESSAGE;
  };

  readAloudButton.addEventListener('click', async () => {
    if (readControlSettings().voicePlayback === false) {
      return;
    }

    if (!('speechSynthesis' in window) || !window.speechSynthesis || typeof SpeechSynthesisUtterance !== 'function') {
      showVoiceUnavailable();
      return;
    }

    const synthesis = window.speechSynthesis;
    if (synthesis.speaking) {
      stopReading();
      return;
    }

    try {
      const reading = speakFlatMarvin(`${verdictAnswer.textContent} ${verdictCommentary.textContent}`);
      if (!reading) {
        showVoiceUnavailable();
        return;
      }

      reading.onend = resetReadAloudButton;
      reading.onerror = (event) => {
        resetReadAloudButton();
        if (event.error !== 'canceled' && event.error !== 'interrupted') {
          showVoiceUnavailable();
        }
      };
      readAloudButton.setAttribute('aria-pressed', 'true');
      readAloudLabel.textContent = 'Stop reading';
      voiceFeedback.textContent = '';
    } catch {
      showVoiceUnavailable();
    }
  });

  const offlineRecognitionMessage = 'Voice input unavailable offline. Type your question instead.';
  let activeRecognition = null;

  const resetDictationButton = () => {
    dictationButton.setAttribute('aria-pressed', 'false');
    dictationLabel.textContent = 'Dictate';
  };

  const startDictation = async () => {
    if (activeRecognition) {
      activeRecognition.stop();
      return;
    }

    dictationFeedback.textContent = '';
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const isOffline = connectionState === 'Offline' || navigator.onLine === false;
    const supportsLocalRecognition = Boolean(Recognition && Recognition.prototype
      && 'processLocally' in Recognition.prototype && typeof Recognition.available === 'function');
    let useLocalProcessing = isOffline;

    if (isOffline && !supportsLocalRecognition) {
      dictationFeedback.textContent = offlineRecognitionMessage;
      return;
    }

    if (!Recognition) {
      dictationFeedback.textContent = 'Speech recognition is not supported here. Type your question instead.';
      return;
    }

    const ensureLocalRecognitionAvailable = async () => {
      try {
        const availability = await Recognition.available({ langs: ['en-US'], processLocally: true });
        return availability === 'available';
      } catch {
        return false;
      }
    };

    if (isOffline && !(await ensureLocalRecognitionAvailable())) {
      dictationFeedback.textContent = offlineRecognitionMessage;
      return;
    }

    if (navigator.permissions?.query) {
      try {
        const microphonePermission = await navigator.permissions.query({ name: 'microphone' });
        if (microphonePermission.state === 'denied') {
          dictationFeedback.textContent = 'Microphone access denied. Allow it in site settings or type your question.';
          return;
        }
      } catch {
        dictationFeedback.textContent = '';
      }
    }

    const offlineBeforeStart = connectionState === 'Offline' || navigator.onLine === false;
    if (offlineBeforeStart && !useLocalProcessing) {
      if (!supportsLocalRecognition || !(await ensureLocalRecognitionAvailable())) {
        dictationFeedback.textContent = offlineRecognitionMessage;
        return;
      }
      useLocalProcessing = true;
    }

    try {
      const recognition = new Recognition();
      recognition.lang = 'en-US';
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      if (useLocalProcessing) {
        recognition.processLocally = true;
      }

      recognition.onstart = () => {
        dictationLabel.textContent = 'Listening...';
        dictationButton.setAttribute('aria-pressed', 'true');
        dictationFeedback.textContent = 'Listening. Your typed question will be kept.';
      };
      recognition.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim();
        if (transcript) {
          const existingQuestion = questionInput.value.trim();
          questionInput.value = [existingQuestion, transcript].filter(Boolean).join(' ');
          questionInput.dispatchEvent(new Event('input', { bubbles: true }));
          dictationFeedback.textContent = 'Voice input added. Your question is ready to edit.';
        }
      };
      recognition.onerror = (event) => {
        if (connectionState === 'Offline' || navigator.onLine === false) {
          dictationFeedback.textContent = offlineRecognitionMessage;
        } else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          dictationFeedback.textContent = 'Microphone access denied. Allow it in site settings or type your question.';
        } else if (event.error === 'network') {
          dictationFeedback.textContent = 'Voice recognition could not connect. Your typed question is still here.';
        } else {
          dictationFeedback.textContent = 'Voice input failed. Your typed question is still here.';
        }
      };
      recognition.onend = () => {
        activeRecognition = null;
        resetDictationButton();
      };

      activeRecognition = recognition;
      recognition.start();
    } catch {
      activeRecognition = null;
      resetDictationButton();
      dictationFeedback.textContent = isOffline
        ? offlineRecognitionMessage
        : 'Voice input failed. Your typed question is still here.';
    }
  };

  dictationButton.addEventListener('click', startDictation);

  const motionIsEnabled = () => {
    try {
      return localStorage.getItem('void-motion-enabled') === 'true';
    } catch {
      return false;
    }
  };

  if ('DeviceMotionEvent' in window && motionIsEnabled()) {
    let previousAcceleration = null;
    let lastShakeAt = 0;

    window.addEventListener('devicemotion', (event) => {
      const acceleration = event.acceleration
        && Number.isFinite(event.acceleration.x)
        && Number.isFinite(event.acceleration.y)
        && Number.isFinite(event.acceleration.z)
        ? event.acceleration
        : event.accelerationIncludingGravity;
      if (!acceleration || !Number.isFinite(acceleration.x) || !Number.isFinite(acceleration.y) || !Number.isFinite(acceleration.z)) {
        return;
      }

      const currentAcceleration = { x: acceleration.x, y: acceleration.y, z: acceleration.z };
      if (previousAcceleration) {
        const change = Math.hypot(
          currentAcceleration.x - previousAcceleration.x,
          currentAcceleration.y - previousAcceleration.y,
          currentAcceleration.z - previousAcceleration.z,
        );
        const sensitivity = Number(readControlSettings().sensitivity) || 10;
        const threshold = Math.max(2.5, 8 - ((sensitivity - 1) * 0.5));
        const now = Date.now();

        if (change >= threshold && now - lastShakeAt > 1400) {
          lastShakeAt = now;
          const question = questionInput.value.trim() || submittedQuestion.textContent.trim();
          revealAnswer(question, homePage.classList.contains('is-revealed') ? verdictAnswer.textContent : '');
        }
      }
      previousAcceleration = currentAcceleration;
    });
  }

  window.addEventListener('voidconnectionchange', (event) => {
    if (event.detail.state === 'Offline' && activeRecognition) {
      activeRecognition.abort();
      dictationFeedback.textContent = offlineRecognitionMessage;
    }
  });
}

const controlPage = document.querySelector('.void-controls');

if (controlPage) {
  const settingsKey = 'void-control-settings';
  const settings = readControlSettings();
  const sensitivity = controlPage.querySelector('#sensitivity');
  const sensitivityValue = controlPage.querySelector('#sensitivity-value');
  const reduceMotion = controlPage.querySelector('#reduce-motion');
  const voicePlayback = controlPage.querySelector('#voice-playback');
  const motionButton = controlPage.querySelector('.motion-enable');
  const motionStatus = controlPage.querySelector('#motion-status');
  const clearHistoryButton = controlPage.querySelector('.clear-history');
  const historyCount = controlPage.querySelector('.history-count');
  const memoryFeedback = controlPage.querySelector('.memory-feedback');
  const hapticFeedback = controlPage.querySelector('#haptic-feedback');
  const hapticSupportCopy = controlPage.querySelector('#haptic-support-copy');
  const hapticSettingRow = controlPage.querySelector('#haptic-setting-row');
  const voicePlaybackStatus = controlPage.querySelector('#voice-playback-status');
  const microphoneStatus = controlPage.querySelector('#microphone-status');
  const microphoneGuidance = controlPage.querySelector('#microphone-guidance');
  const microphoneRecovery = controlPage.querySelector('#mic-recovery-steps');
  const recognitionStatus = controlPage.querySelector('#speech-recognition-status');
  const recognitionGuidance = controlPage.querySelector('#speech-recognition-guidance');
  const motionSupportNote = controlPage.querySelector('#motion-support-note');
  const deviceMode = controlPage.querySelector('#device-mode');
  const offlineRetryPanel = controlPage.querySelector('#offline-setup-retry');
  const offlineSetupRetryButton = controlPage.querySelector('#retry-offline-setup');
  const offlineRetryCopy = offlineRetryPanel.querySelector('p');
  const motionEnableDesktop = motionButton.querySelector('.motion-enable-desktop');
  const motionEnableMobile = motionButton.querySelector('.motion-enable-mobile');
  let microphonePermissionMonitor = null;
  let accelerometerPermissionMonitor = null;
  let permissionAuditGeneration = 0;

  const updateHistoryCount = () => {
    const count = getHistoryCount();
    if (count === null) {
      historyCount.textContent = 'Unavailable';
      memoryFeedback.textContent = 'History storage is unavailable. Existing entries have not been confirmed as deleted.';
      return;
    }
    historyCount.textContent = `${count} ${count === 1 ? 'entry' : 'entries'}`;
  };

  const updateOfflineRetryVisibility = () => {
    const readiness = document.querySelector('[data-offline-readiness]')?.textContent;
    offlineRetryPanel.hidden = !(connectionState === 'Online' && navigator.onLine && readiness === 'Offline setup incomplete.');
  };

  const setMotionStatus = (state, guidance) => {
    motionStatus.querySelector('.desktop-status').textContent = state;
    motionStatus.querySelector('.mobile-status').textContent = state;
    motionStatus.classList.toggle('permission-denied', state === 'Denied');
    motionStatus.classList.toggle('permission-unsupported', state === 'Unsupported');
    motionStatus.classList.toggle('permission-supported', state === 'Enabled');
    motionSupportNote.textContent = guidance;
    motionButton.disabled = state === 'Unsupported' || state === 'Enabled';
    const buttonText = state === 'Enabled' ? 'Motion enabled' : state === 'Unsupported' ? 'Motion unsupported' : 'Enable motion';
    motionEnableDesktop.textContent = buttonText === 'Enable motion' ? 'Enable motion on a compatible mobile device' : buttonText;
    motionEnableMobile.textContent = buttonText;
  };

  const updateHapticStatus = () => {
    const supported = supportsHapticFeedback();
    hapticFeedback.disabled = !supported;
    hapticSettingRow.classList.toggle('setting-unavailable', !supported);
    hapticFeedback.checked = supported && (settings.hapticFeedback ?? true);
    hapticSupportCopy.textContent = !supported
      ? 'Unsupported · This device does not provide haptic feedback. Answers still work offline.'
      : hapticFeedback.checked
        ? 'Ready · Haptic feedback works locally and does not need a connection.'
        : 'Off · Turn it on for a brief vibration after an answer.';
  };

  const updateVoicePlaybackStatus = () => {
    if (readControlSettings().voicePlayback === false) {
      voicePlaybackStatus.textContent = 'Off · Turn on Voice playback to use Read aloud. Written answers remain available.';
      return;
    }

    if (!('speechSynthesis' in window) || !window.speechSynthesis) {
      voicePlaybackStatus.textContent = 'Unsupported · This browser does not support speech playback. Written answers remain available.';
      return;
    }

    const isOffline = connectionState === 'Offline' || navigator.onLine === false;
    let localVoiceAvailable = false;
    try {
      localVoiceAvailable = window.speechSynthesis.getVoices().some((voice) => voice.localService === true);
    } catch {
      localVoiceAvailable = false;
    }
    if (isOffline && !localVoiceAvailable) {
      voicePlaybackStatus.textContent = 'Unavailable offline · No local voice is available. Written answers remain available.';
    } else if (isOffline) {
      voicePlaybackStatus.textContent = 'Available offline · Uses a local voice. No microphone permission is needed.';
    } else {
      voicePlaybackStatus.textContent = 'Ready · Uses browser speech synthesis. No microphone permission is needed; offline use requires a local voice.';
    }
  };

  const getPermissionState = async (name) => {
    if (!navigator.permissions?.query) {
      return { state: 'unsupported', permission: null };
    }
    try {
      const permission = await navigator.permissions.query({ name });
      return { state: permission.state, permission };
    } catch {
      return { state: 'unsupported', permission: null };
    }
  };

  const updatePermissionAudit = async () => {
    const auditGeneration = ++permissionAuditGeneration;
    const [microphonePermission, motionPermission] = await Promise.all([
      getPermissionState('microphone'),
      getPermissionState('accelerometer'),
    ]);
    if (auditGeneration !== permissionAuditGeneration) {
      return;
    }

    if (microphonePermission.permission && !microphonePermissionMonitor) {
      microphonePermissionMonitor = microphonePermission.permission;
      microphonePermissionMonitor.addEventListener('change', updatePermissionAudit);
    }
    if (motionPermission.permission && !accelerometerPermissionMonitor) {
      accelerometerPermissionMonitor = motionPermission.permission;
      accelerometerPermissionMonitor.addEventListener('change', updatePermissionAudit);
    }

    const microphoneState = microphonePermission.state;
    const microphoneLabel = microphoneState === 'granted'
      ? 'Granted'
      : microphoneState === 'denied'
        ? 'Denied'
        : microphoneState === 'prompt'
          ? 'Not requested'
          : 'Status unavailable';
    microphoneStatus.textContent = microphoneLabel;
    microphoneStatus.classList.toggle('permission-denied', microphoneState === 'denied');
    microphoneStatus.classList.toggle('permission-unsupported', microphoneState === 'unsupported');
    microphoneStatus.classList.toggle('permission-supported', microphoneState === 'granted');
    microphoneRecovery.hidden = microphoneState !== 'denied';
    microphoneGuidance.textContent = microphoneState === 'denied'
      ? 'Microphone permission is denied. Allow it in site settings; recognition support is separate.'
      : microphoneState === 'granted'
        ? 'Microphone permission is granted. This does not guarantee speech-recognition support.'
        : microphoneState === 'prompt'
          ? 'Microphone permission has not been requested. Dictate may ask when used online.'
          : 'This browser cannot report microphone permission status. Dictate may still request access.';

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const isOffline = connectionState === 'Offline' || navigator.onLine === false;
    let recognitionLabel;
    if (!Recognition) {
      recognitionLabel = 'Unsupported';
      recognitionGuidance.textContent = 'This browser does not support speech recognition. Typing and Consult the void still work.';
    } else if (isOffline) {
      const supportsLocalRecognition = Recognition.prototype
        && 'processLocally' in Recognition.prototype
        && typeof Recognition.available === 'function';
      if (!supportsLocalRecognition) {
        recognitionLabel = 'Unavailable offline';
      } else {
        try {
          const availability = await Recognition.available({ langs: ['en-US'], processLocally: true });
          recognitionLabel = availability === 'available' ? 'Available offline' : 'Unavailable offline';
        } catch {
          recognitionLabel = 'Unavailable offline';
        }
      }
      recognitionGuidance.textContent = recognitionLabel === 'Available offline'
        ? 'On-device recognition is available. Microphone permission is still required.'
        : 'This browser cannot recognize speech offline. Type your question instead.';
    } else {
      recognitionLabel = 'Supported online';
      recognitionGuidance.textContent = 'Recognition is provided by the browser. Offline support and microphone permission are checked separately.';
    }
    recognitionStatus.textContent = recognitionLabel;
    recognitionStatus.classList.toggle('permission-denied', recognitionLabel === 'Unavailable offline' || recognitionLabel === 'Unsupported');
    recognitionStatus.classList.toggle('permission-supported', recognitionLabel === 'Supported online' || recognitionLabel === 'Available offline');

    const touchMotionDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
    if (!('DeviceMotionEvent' in window) || !touchMotionDevice) {
      setMotionStatus('Unsupported', 'This browser/device does not expose motion sensing. Consult the void still works.');
    } else if (motionPermission.state === 'denied') {
      try {
        localStorage.removeItem('void-motion-enabled');
      } catch {
        memoryFeedback.textContent = 'Motion permission is denied. Update this site’s browser settings.';
      }
      setMotionStatus('Denied', 'Motion permission is denied. Allow it in browser settings; internet access is not required.');
    } else if (motionPermission.state === 'unsupported') {
      let previouslyEnabled = false;
      try {
        previouslyEnabled = localStorage.getItem('void-motion-enabled') === 'true';
      } catch {
        memoryFeedback.textContent = 'Motion settings are unavailable in this browser.';
      }
      setMotionStatus(
        previouslyEnabled ? 'Status unavailable' : 'Not enabled',
        previouslyEnabled
          ? 'Motion was enabled earlier, but this browser cannot report current permission. Shake works only if sensor events are still allowed.'
          : 'This browser cannot report motion permission. Enable motion to request sensor access; it works without a connection.',
      );
    } else {
      let motionEnabled = motionPermission.state === 'granted';
      try {
        if (motionPermission.state === 'granted') {
          localStorage.setItem('void-motion-enabled', 'true');
        } else {
          localStorage.removeItem('void-motion-enabled');
        }
      } catch {
        memoryFeedback.textContent = 'Motion settings are unavailable in this browser.';
      }
      setMotionStatus(
        motionEnabled ? 'Enabled' : 'Not enabled',
        motionEnabled
          ? 'Motion is enabled. Shaking works without a connection.'
          : 'Enable motion on a compatible device. Internet access is not required.',
      );
    }

    updateVoicePlaybackStatus();
  };

  const saveSettings = () => {
    try {
      localStorage.setItem(settingsKey, JSON.stringify({
        sensitivity: Number(sensitivity.value),
        reduceMotion: reduceMotion.checked,
        voicePlayback: voicePlayback.checked,
        hapticFeedback: settings.hapticFeedback ?? true,
      }));
    } catch {
      memoryFeedback.textContent = 'Settings could not be saved in this browser.';
    }
  };


  const updateSensitivity = () => {
    const value = Number(sensitivity.value);
    const label = value <= 3 ? 'Firm' : value <= 7 ? 'Steady' : 'Gentle';
    const percentage = ((value - Number(sensitivity.min)) / (Number(sensitivity.max) - Number(sensitivity.min))) * 100;
    sensitivity.style.setProperty('--range-fill', `${percentage}%`);
    sensitivityValue.value = label;
    sensitivityValue.textContent = label;
    sensitivity.setAttribute('aria-valuetext', `${label} shake`);
  };

  if (Number.isFinite(Number(settings.sensitivity))) {
    sensitivity.value = String(Math.min(Number(sensitivity.max), Math.max(Number(sensitivity.min), Number(settings.sensitivity))));
  }
  reduceMotion.checked = settings.reduceMotion ?? true;
  voicePlayback.checked = settings.voicePlayback ?? true;
  deviceMode.textContent = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches
    ? 'Mobile mode'
    : 'Desktop mode';
  updateSensitivity();
  updateHistoryCount();
  updateHapticStatus();
  updateOfflineRetryVisibility();
  void updatePermissionAudit();

  window.addEventListener('voidconnectionchange', () => {
    updateOfflineRetryVisibility();
    void updatePermissionAudit();
  });
  window.addEventListener('voidreadinesschange', updateOfflineRetryVisibility);
  window.addEventListener('online', updateOfflineRetryVisibility);
  window.addEventListener('offline', updateOfflineRetryVisibility);

  if (typeof window.speechSynthesis?.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      updateVoicePlaybackStatus();
    });
  }

  sensitivity.addEventListener('input', () => {
    updateSensitivity();
    saveSettings();
  });

  [reduceMotion, voicePlayback].forEach((input) => {
    input.addEventListener('change', saveSettings);
  });


  voicePlayback.addEventListener('change', updateVoicePlaybackStatus);
  hapticFeedback.addEventListener('change', () => {
    settings.hapticFeedback = hapticFeedback.checked;
    saveSettings();
    updateHapticStatus();
  });

  motionButton.addEventListener('click', async () => {
    const hasMotionApi = 'DeviceMotionEvent' in window;
    const touchDevice = navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches;
    if (!hasMotionApi || !touchDevice) {
      setMotionStatus('Unsupported', 'This device/browser does not support motion sensing. Consult the void still works.');
      return;
    }

    let permissionGrantedByRequest = false;
    try {
      if (typeof DeviceMotionEvent.requestPermission === 'function') {
        const permission = await DeviceMotionEvent.requestPermission();
        if (permission !== 'granted') {
          setMotionStatus('Denied', 'Motion permission is denied. Allow it in browser settings; internet access is not required.');
          memoryFeedback.textContent = 'Motion permission denied. Consult the void still works.';
          return;
        }
        permissionGrantedByRequest = true;
      }

      const permission = await getPermissionState('accelerometer');
      if (permission.state === 'denied') {
        setMotionStatus('Denied', 'Motion permission is denied. Allow it in browser settings; internet access is not required.');
        memoryFeedback.textContent = 'Motion permission denied. Consult the void still works.';
        return;
      }

      if (permission.state === 'prompt' && !permissionGrantedByRequest) {
        localStorage.removeItem('void-motion-enabled');
        setMotionStatus('Not enabled', 'Grant motion permission in this site’s browser settings. Internet access is not required.');
        memoryFeedback.textContent = 'Motion permission needs approval in this site’s browser settings.';
        return;
      }

      localStorage.setItem('void-motion-enabled', 'true');
      if (permission.state === 'unsupported' && !permissionGrantedByRequest) {
        setMotionStatus('Status unavailable', 'Motion preference is on, but this browser cannot verify permission. Shaking works if sensor events are delivered.');
        memoryFeedback.textContent = 'Motion preference saved. The browser could not verify sensor permission.';
      } else {
        setMotionStatus('Enabled', 'Motion is enabled. Shaking works without a connection.');
        memoryFeedback.textContent = 'Motion enabled for this device. No connection is needed.';
      }
    } catch {
      const permission = await getPermissionState('accelerometer');
      if (permission.state === 'denied') {
        setMotionStatus('Denied', 'Motion permission is denied. Allow it in browser settings; internet access is not required.');
        memoryFeedback.textContent = 'Motion permission denied. Consult the void still works.';
      } else {
        setMotionStatus('Status unavailable', 'Motion permission could not be verified. Consult the void still works.');
        memoryFeedback.textContent = 'Motion access could not be verified. Consult the void still works.';
      }
    }
  });

  offlineSetupRetryButton.addEventListener('click', async () => {
    if (connectionState !== 'Online' || !navigator.onLine) {
      return;
    }

    offlineSetupRetryButton.disabled = true;
    offlineRetryCopy.textContent = 'Retrying offline setup...';
    setOfflineReadiness('Saving...');

    try {
      let registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      }

      const worker = navigator.serviceWorker.controller || registration.active;
      let recached = false;
      if (worker) {
        recached = await new Promise((resolve) => {
          const timeoutId = window.setTimeout(() => {
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve(false);
          }, 5000);
          const onMessage = (event) => {
            if (event.data?.type !== 'VOID_OFFLINE_SETUP_RESULT') {
              return;
            }
            window.clearTimeout(timeoutId);
            navigator.serviceWorker.removeEventListener('message', onMessage);
            resolve(event.data.success === true && event.data.version === OFFLINE_CACHE_NAME);
          };
          navigator.serviceWorker.addEventListener('message', onMessage);
          worker.postMessage({ type: 'VOID_RETRY_OFFLINE_SETUP' });
        });
      }

      if (!recached) {
        await registration.update();
        registration = await navigator.serviceWorker.ready;
      }

      if (!await verifyOfflineReadiness(registration)) {
        throw new Error('Offline app shell verification failed.');
      }
      memoryFeedback.textContent = 'Offline setup verified.';
    } catch {
      setOfflineReadiness('Offline setup incomplete.');
      memoryFeedback.textContent = 'Offline setup could not be completed. Your online features are unchanged.';
    } finally {
      offlineSetupRetryButton.disabled = false;
      offlineRetryCopy.textContent = 'Offline setup is incomplete. Reconnect and retry saving the core experience.';
      updateOfflineRetryVisibility();
    }
  });

  clearHistoryButton.addEventListener('click', () => {
    if (!window.confirm('Clear saved questions and decisions from this device?')) {
      return;
    }

    try {
      localStorage.removeItem('void-history-entries');
      localStorage.removeItem('void-history');
      localStorage.setItem('void-history-cleared', 'true');
      historyCount.textContent = '0 entries';
      memoryFeedback.textContent = 'History cleared from this device.';
    } catch {
      memoryFeedback.textContent = 'History could not be cleared in this browser.';
    }
  });
}

const offlinePage = document.querySelector('.void-offline');

if (offlinePage) {
  const retryButton = offlinePage.querySelector('.offline-retry-button');
  const backButton = offlinePage.querySelector('#offline-back');
  const backLabel = offlinePage.querySelector('#offline-back-label');
  const onlineMessage = offlinePage.querySelector('#offline-online-message');
  const currentUrl = new URL(window.location.href);
  const offlineDocumentPath = new URL('./offline.html', currentUrl).pathname;
  let backAction = null;

  retryButton.addEventListener('click', () => {
    window.location.assign(window.location.href);
  });

  const pageTitle = (path) => ({
    './index.html': 'Home',
    './history.html': 'History',
    './control.html': 'Controls',
    './about.html': 'About',
  }[path] || 'saved page');

  const hasCachedPage = async (url) => {
    if (!('caches' in window)) {
      return false;
    }
    try {
      return Boolean(await caches.match(url.href));
    } catch {
      return false;
    }
  };

  const configureBackAction = async () => {
    try {
      const referrerUrl = new URL(document.referrer);
      if (referrerUrl.origin === currentUrl.origin
        && referrerUrl.pathname !== currentUrl.pathname
        && referrerUrl.pathname !== offlineDocumentPath
        && await hasCachedPage(referrerUrl)) {
        backAction = { type: 'history', url: referrerUrl };
        backLabel.textContent = 'Go back to previous page';
        backButton.disabled = false;
        return;
      }
    } catch {
      backAction = null;
    }

    const cachedDestinations = [
      ['./index.html', 'Home'],
      ['./history.html', 'History'],
      ['./control.html', 'Controls'],
      ['./about.html', 'About'],
    ];

    for (const [path, title] of cachedDestinations) {
      const destination = new URL(path, currentUrl);
      if (destination.pathname === currentUrl.pathname || !await hasCachedPage(destination)) {
        continue;
      }
      backAction = { type: 'destination', url: destination };
      backLabel.textContent = `Open saved page: ${title}`;
      backButton.disabled = false;
      return;
    }

    backAction = null;
    backLabel.textContent = 'No saved page available';
    backButton.disabled = true;
  };

  backButton.addEventListener('click', () => {
    if (!backAction) {
      return;
    }
    if (backAction.type === 'history') {
      window.history.back();
    } else {
      window.location.assign(backAction.url.href);
    }
  });

  void configureBackAction();

  window.addEventListener('voidconnectionprobe', (event) => {
    onlineMessage.hidden = event.detail.online !== true;
  });

  window.addEventListener('voidconnectionchange', (event) => {
    onlineMessage.hidden = event.detail.state !== 'Online';
  });
}

