(() => {
  "use strict";

  const $ = selector => document.querySelector(selector);
  const elements = {
    modeChooser: $("#modeChooser"),
    readyText: $("#readyTextButton"),
    customText: $("#customTextButton"),
    gradeChooser: $("#gradeChooser"),
    gradeBack: $("#gradeBackButton"),
    gradeButtons: [...document.querySelectorAll(".grade-button")],
    activeModeBar: $("#activeModeBar"),
    changeMode: $("#changeModeButton"),
    selectedMode: $("#selectedModeText"),
    workspace: $("#readerWorkspace"),
    resultsSection: $("#resultsSection"),
    historySection: $("#historySection"),
    supportSection: $("#supportSection"),
    readingCard: $(".reading-card"),
    source: $("#sourceText"),
    sourceCount: $("#sourceCount"),
    sample: $("#sampleButton"),
    transcript: $("#transcriptText"),
    interim: $("#interimText"),
    start: $("#startButton"),
    stop: $("#stopButton"),
    save: $("#saveButton"),
    timerDisplay: $("#timerDisplay"),
    timerLabel: $("#timerLabel"),
    timerProgress: $("#timerProgress"),
    timerRing: $("#timerRing"),
    badge: $("#recognitionBadge"),
    notice: $("#notice"),
    listening: $("#listeningLabel"),
    wpm: $("#wpmMetric"),
    pace: $("#paceMessage"),
    words: $("#wordMetric"),
    target: $("#targetMetric"),
    time: $("#timeMetric"),
    accuracy: $("#accuracyMetric"),
    match: $("#matchMetric"),
    errors: $("#errorMetric"),
    omissions: $("#omissionMetric"),
    comparison: $("#comparisonText"),
    history: $("#historyList"),
    clearHistory: $("#clearHistoryButton"),
    toast: $("#toast"),
    help: $("#helpButton"),
    helpPanel: $("#helpPanel"),
    install: $("#installButton"),
    apiIcon: $("#apiSupportIcon"),
    apiText: $("#apiSupportText"),
    secureIcon: $("#secureSupportIcon"),
    secureText: $("#secureSupportText"),
    networkIcon: $("#networkSupportIcon"),
    networkText: $("#networkSupportText")
  };

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const STORAGE_KEY = "oqy-qarqyny-results-v1";
  const TIMER_CIRCUMFERENCE = 496;
  const SESSION_DURATION_MS = 60_000;
  const readingTexts = window.READING_TEXTS || {};

  let recognition = null;
  let timerId = null;
  let startedAt = 0;
  let elapsedMs = 0;
  let wantsListening = false;
  let finalTranscript = "";
  const recognitionFinalResults = new Map();
  const recognitionInterimResults = new Map();
  let deferredInstall = null;
  let toastTimer = null;
  let selectedGrade = null;
  const lastTextIndex = new Map();

  function normalizeWord(word) {
    return word.toLocaleLowerCase("kk-KZ").replace(/[’'`]/g, "").replace(/[^\p{L}\p{N}-]/gu, "");
  }

  function tokenize(text) {
    const matches = String(text || "").match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu) || [];
    return matches.map(original => ({ original, normalized: normalizeWord(original) })).filter(item => item.normalized);
  }

  function orderedRecognitionText(results) {
    return [...results.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value)
      .filter(Boolean)
      .join(" ")
      .trim();
  }

  function appendWithoutRepeatedOverlap(base, next) {
    const baseTokens = tokenize(base);
    const nextTokens = tokenize(next);
    if (!baseTokens.length) return nextTokens.map(token => token.original).join(" ");
    if (!nextTokens.length) return baseTokens.map(token => token.original).join(" ");

    let overlap = 0;
    const maximum = Math.min(baseTokens.length, nextTokens.length);
    for (let size = maximum; size > 0; size -= 1) {
      const start = baseTokens.length - size;
      const same = nextTokens.slice(0, size).every((token, index) => token.normalized === baseTokens[start + index].normalized);
      if (same) {
        overlap = size;
        break;
      }
    }

    return [...baseTokens, ...nextTokens.slice(overlap)].map(token => token.original).join(" ");
  }

  function resetRecognitionResults() {
    recognitionFinalResults.clear();
    recognitionInterimResults.clear();
  }

  function formatTime(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function formatCountdown(ms) {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }

  function currentElapsed() {
    return wantsListening && startedAt ? elapsedMs + (Date.now() - startedAt) : elapsedMs;
  }

  function setNotice(message, type = "") {
    elements.notice.classList.remove("error", "success");
    if (type) elements.notice.classList.add(type);
    elements.notice.querySelector("span").textContent = message;
  }

  function toast(message) {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    toastTimer = window.setTimeout(() => elements.toast.classList.remove("show"), 2600);
  }

  function updateTimer() {
    const ms = Math.min(currentElapsed(), SESSION_DURATION_MS);
    const remaining = Math.max(0, SESSION_DURATION_MS - ms);
    elements.timerDisplay.textContent = formatCountdown(remaining);
    elements.time.textContent = formatTime(ms);
    elements.timerProgress.style.strokeDashoffset = String(TIMER_CIRCUMFERENCE * (1 - remaining / SESSION_DURATION_MS));
    updateMetrics(false);
    if (wantsListening && remaining <= 0) finishSession(true);
  }

  function alignWords(sourceTokens, spokenTokens) {
    const n = sourceTokens.length;
    const m = spokenTokens.length;
    if (!n && !m) return { operations: [], matches: 0, substitutions: 0, omissions: 0, additions: 0 };

    const width = m + 1;
    const size = (n + 1) * width;
    const costs = new Uint16Array(size);
    const directions = new Uint8Array(size); // 1 diagonal, 2 deletion, 3 insertion

    for (let i = 1; i <= n; i += 1) {
      costs[i * width] = i;
      directions[i * width] = 2;
    }
    for (let j = 1; j <= m; j += 1) {
      costs[j] = j;
      directions[j] = 3;
    }

    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        const index = i * width + j;
        const same = sourceTokens[i - 1].normalized === spokenTokens[j - 1].normalized;
        const diagonal = costs[(i - 1) * width + (j - 1)] + (same ? 0 : 1);
        const deletion = costs[(i - 1) * width + j] + 1;
        const insertion = costs[i * width + (j - 1)] + 1;
        if (diagonal <= deletion && diagonal <= insertion) {
          costs[index] = diagonal;
          directions[index] = 1;
        } else if (deletion <= insertion) {
          costs[index] = deletion;
          directions[index] = 2;
        } else {
          costs[index] = insertion;
          directions[index] = 3;
        }
      }
    }

    const operations = [];
    let matches = 0;
    let substitutions = 0;
    let omissions = 0;
    let additions = 0;
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      const direction = directions[i * width + j];
      if (i > 0 && j > 0 && direction === 1) {
        const same = sourceTokens[i - 1].normalized === spokenTokens[j - 1].normalized;
        operations.push({ type: same ? "match" : "substitution", source: sourceTokens[i - 1], spoken: spokenTokens[j - 1] });
        if (same) matches += 1;
        else substitutions += 1;
        i -= 1;
        j -= 1;
      } else if (i > 0 && (direction === 2 || j === 0)) {
        operations.push({ type: "omission", source: sourceTokens[i - 1], spoken: null });
        omissions += 1;
        i -= 1;
      } else {
        operations.push({ type: "addition", source: null, spoken: spokenTokens[j - 1] });
        additions += 1;
        j -= 1;
      }
    }

    operations.reverse();
    return { operations, matches, substitutions, omissions, additions };
  }

  function renderComparison(alignment, hasSource, hasSpoken) {
    elements.comparison.textContent = "";
    if (!hasSource || !hasSpoken) {
      elements.comparison.className = "comparison-text empty-state";
      elements.comparison.textContent = "Оқу мәтіні мен танылған сөздер болғанда салыстыру осы жерде көрінеді.";
      return;
    }

    elements.comparison.className = "comparison-text";
    const fragment = document.createDocumentFragment();
    alignment.operations.forEach(operation => {
      if (operation.type === "addition") return;
      const span = document.createElement("span");
      span.className = `word-token ${operation.type === "substitution" ? "error" : operation.type}`;
      span.textContent = operation.source.original;
      if (operation.type === "substitution") span.title = `Танылғаны: ${operation.spoken.original}`;
      if (operation.type === "omission") span.title = "Өткізілген болуы мүмкін";
      fragment.appendChild(span);
      fragment.appendChild(document.createTextNode(" "));
    });
    elements.comparison.appendChild(fragment);
  }

  function paceMessage(wpm, words) {
    if (!words) return "Нәтиже оқу басталғанда шығады";
    if (wpm < 45) return "Асықпай, анық оқу қарқыны";
    if (wpm < 90) return "Бірқалыпты оқу қарқыны";
    if (wpm < 140) return "Шапшаң оқу қарқыны";
    return "Өте жоғары қарқын — дәлдікті тексеріңіз";
  }

  function updateMetrics(render = true) {
    const sourceTokens = tokenize(elements.source.value);
    const spokenTokens = tokenize(elements.transcript.value);
    const duration = currentElapsed();
    const alignment = alignWords(sourceTokens, spokenTokens);
    // Reading progress is bounded by the assigned text. Extra recognition output
    // remains visible as an error, but cannot inflate the read-word or WPM metrics.
    const readWordCount = sourceTokens.length
      ? Math.min(sourceTokens.length, alignment.matches + alignment.substitutions)
      : spokenTokens.length;
    const minutes = duration / 60000;
    const wpm = readWordCount && minutes > 0 ? Math.round(readWordCount / minutes) : 0;
    // Match percentage answers “how much of the assigned text matched?”. Extra
    // words are reported separately and no longer distort this percentage.
    const accuracy = sourceTokens.length && spokenTokens.length
      ? Math.max(0, Math.round((alignment.matches / sourceTokens.length) * 100))
      : null;

    elements.sourceCount.textContent = `${sourceTokens.length} сөз`;
    elements.target.textContent = `Мәтінде ${sourceTokens.length} сөз`;
    elements.words.textContent = String(readWordCount);
    elements.wpm.textContent = String(wpm);
    elements.pace.textContent = paceMessage(wpm, readWordCount);
    elements.accuracy.textContent = accuracy === null ? "—" : `${accuracy}%`;
    elements.match.textContent = accuracy === null ? "Салыстыруға екі мәтін де керек" : `${alignment.matches} сөз дәл сәйкесті`;
    elements.errors.textContent = String(alignment.substitutions + alignment.additions);
    elements.omissions.textContent = String(alignment.omissions);
    elements.save.disabled = readWordCount === 0 || duration < 1000;

    if (render) renderComparison(alignment, sourceTokens.length > 0, spokenTokens.length > 0);
    return { sourceTokens, spokenTokens, readWordCount, duration, wpm, accuracy, alignment };
  }

  function resetSessionView() {
    if (wantsListening) finishSession(false, false);
    elapsedMs = 0;
    startedAt = 0;
    finalTranscript = "";
    resetRecognitionResults();
    elements.transcript.value = "";
    elements.interim.textContent = "";
    elements.resultsSection.hidden = true;
    elements.timerDisplay.textContent = "01:00";
    elements.time.textContent = "00:00";
    elements.timerProgress.style.strokeDashoffset = "0";
    setNotice("«Бастау» түймесін басқанда браузер микрофонға рұқсат сұрайды.");
    updateControls(false);
    updateMetrics();
  }

  function showReader() {
    elements.modeChooser.hidden = true;
    elements.gradeChooser.hidden = true;
    elements.activeModeBar.hidden = false;
    elements.workspace.hidden = false;
    elements.historySection.hidden = false;
    elements.supportSection.hidden = false;
    elements.resultsSection.hidden = true;
    resetSessionView();
    elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showModeChooser() {
    if (wantsListening) finishSession(false, false);
    elements.modeChooser.hidden = false;
    elements.gradeChooser.hidden = true;
    elements.activeModeBar.hidden = true;
    elements.workspace.hidden = true;
    elements.resultsSection.hidden = true;
    elements.historySection.hidden = true;
    elements.supportSection.hidden = true;
    selectedGrade = null;
    elements.source.value = "";
    elements.source.readOnly = false;
    elements.sample.hidden = true;
    elements.readingCard.classList.remove("ready-text");
    resetSessionView();
    elements.modeChooser.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function chooseRandomText(grade) {
    const entries = readingTexts[String(grade)] || [];
    if (!entries.length) {
      toast("Бұл сыныптың мәтіндері табылмады");
      return;
    }

    let index = Math.floor(Math.random() * entries.length);
    const previous = lastTextIndex.get(grade);
    if (entries.length > 1 && index === previous) index = (index + 1 + Math.floor(Math.random() * (entries.length - 1))) % entries.length;
    lastTextIndex.set(grade, index);

    const entry = entries[index];
    selectedGrade = Number(grade);
    elements.source.value = entry.text;
    elements.source.readOnly = true;
    elements.sample.hidden = false;
    elements.sample.textContent = "Басқа мәтін";
    elements.readingCard.classList.add("ready-text");
    elements.selectedMode.textContent = `${grade}-сынып · «${entry.title}» · ${tokenize(entry.text).length} сөз`;
    showReader();
    toast(`${grade}-сынып мәтіні таңдалды`);
  }

  function chooseCustomText() {
    selectedGrade = null;
    elements.source.value = "";
    elements.source.readOnly = false;
    elements.sample.hidden = true;
    elements.readingCard.classList.remove("ready-text");
    elements.selectedMode.textContent = "Өз мәтініңізді енгізу режимі";
    showReader();
    window.setTimeout(() => elements.source.focus(), 350);
  }

  function updateControls(active) {
    elements.start.disabled = active;
    elements.stop.disabled = !active;
    elements.source.disabled = active;
    elements.listening.hidden = !active;
    elements.timerLabel.textContent = active ? "Қалған уақыт" : elapsedMs > 0 ? "Аяқталды" : "Дайын";
  }

  function stopTimer() {
    if (startedAt) {
      elapsedMs += Date.now() - startedAt;
      startedAt = 0;
    }
    window.clearInterval(timerId);
    timerId = null;
    updateTimer();
  }

  function recognitionErrorMessage(error) {
    const messages = {
      "not-allowed": "Микрофонға рұқсат берілмеді. Браузер баптауынан рұқсатты қосып, қайта көріңіз.",
      "service-not-allowed": "Браузердің сөйлеуді тану қызметіне рұқсат жоқ.",
      "audio-capture": "Микрофон табылмады немесе оны басқа қолданба пайдаланып тұр.",
      "network": "Сөйлеуді тану қызметімен байланыс үзілді. Интернетті тексеріңіз.",
      "language-not-supported": "Бұл құрылғының тану қызметі kk-KZ тілін қолдамайды.",
      "language-unavailable": "Қазақ тілі осы құрылғыда қазір қолжетімсіз.",
      "no-speech": "Дауыс естілмеді. Микрофонға жақынырақ, анық оқып көріңіз.",
      "aborted": "Тану тоқтатылды."
    };
    return messages[error] || `Сөйлеуді тану қатесі: ${error || "белгісіз"}`;
  }

  function buildRecognition() {
    if (!SpeechRecognition) return null;
    const instance = new SpeechRecognition();
    instance.lang = "kk-KZ";
    instance.continuous = true;
    instance.interimResults = true;
    instance.maxAlternatives = 1;

    instance.onstart = () => {
      resetRecognitionResults();
      elements.interim.textContent = "";
      setNotice("Микрофон қосылды. Мәтінді қалыпты дауыспен оқи беріңіз.", "success");
    };

    instance.onresult = event => {
      // Rebuild the current recognition run from indexed results. Some mobile
      // implementations resend old final results with resultIndex = 0; appending
      // them caused the same short text to be counted hundreds of times.
      resetRecognitionResults();
      for (let i = 0; i < event.results.length; i += 1) {
        const piece = event.results[i][0].transcript.trim();
        if (!piece) continue;
        if (event.results[i].isFinal) recognitionFinalResults.set(i, piece);
        else recognitionInterimResults.set(i, piece);
      }
      const sessionFinal = orderedRecognitionText(recognitionFinalResults);
      const interim = orderedRecognitionText(recognitionInterimResults);
      const confirmed = appendWithoutRepeatedOverlap(finalTranscript, sessionFinal);
      elements.transcript.value = appendWithoutRepeatedOverlap(confirmed, interim);
      elements.interim.textContent = interim ? `Анықталуда: ${interim}` : "";
      updateMetrics();
    };

    instance.onerror = event => {
      if (event.error === "no-speech" && wantsListening) {
        setNotice(recognitionErrorMessage(event.error));
        return;
      }
      setNotice(recognitionErrorMessage(event.error), "error");
      if (["not-allowed", "service-not-allowed", "audio-capture", "language-not-supported", "language-unavailable"].includes(event.error)) {
        wantsListening = false;
        stopTimer();
        updateControls(false);
      }
    };

    instance.onend = () => {
      const sessionFinal = orderedRecognitionText(recognitionFinalResults);
      if (sessionFinal) finalTranscript = appendWithoutRepeatedOverlap(finalTranscript, sessionFinal);
      resetRecognitionResults();
      elements.transcript.value = finalTranscript;
      updateMetrics();
      if (!wantsListening) return;
      window.setTimeout(() => {
        if (!wantsListening) return;
        try { instance.start(); }
        catch (error) {
          setNotice("Тану автоматты жалғаспады. «Тоқтату» басып, қайта бастаңыз.", "error");
        }
      }, 240);
    };
    return instance;
  }

  async function requestMicrophonePermission() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(track => track.stop());
  }

  async function startSession() {
    if (wantsListening) return;
    if (!elements.source.value.trim()) {
      toast("Алдымен оқылатын мәтінді енгізіңіз");
      elements.source.focus();
      return;
    }

    finalTranscript = "";
    resetRecognitionResults();
    elements.transcript.value = "";
    elements.interim.textContent = "";
    elapsedMs = 0;
    startedAt = Date.now();
    wantsListening = true;
    elements.resultsSection.hidden = true;
    elements.timerProgress.style.strokeDashoffset = "0";
    updateControls(true);
    updateTimer();
    timerId = window.setInterval(updateTimer, 250);

    if (!SpeechRecognition) {
      setNotice("Бұл браузер сөйлеуді автоматты танымайды. Таймер жұмыс істейді: оқып болған соң танылған мәтін орнына сөздерді қолмен енгізуге болады.", "error");
      return;
    }

    try {
      await requestMicrophonePermission();
      if (!wantsListening) return;
      recognition = buildRecognition();
      recognition.start();
    } catch (error) {
      wantsListening = false;
      stopTimer();
      updateControls(false);
      const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
      setNotice(denied ? recognitionErrorMessage("not-allowed") : "Микрофонды қосу мүмкін болмады. Құрылғы мен браузер рұқсатын тексеріңіз.", "error");
    }
  }

  function finishSession(automatic = false, revealResults = true) {
    if (!wantsListening && !startedAt) return;
    wantsListening = false;
    if (startedAt) {
      elapsedMs = Math.min(SESSION_DURATION_MS, elapsedMs + (Date.now() - startedAt));
      startedAt = 0;
    }
    window.clearInterval(timerId);
    timerId = null;
    updateControls(false);
    elements.interim.textContent = "";
    if (recognition) {
      try { recognition.stop(); } catch (_) { /* already stopped */ }
    }
    recognition = null;
    finalTranscript = elements.transcript.value.trim();
    resetRecognitionResults();
    updateTimer();
    setNotice(automatic
      ? "Бір минут аяқталды. Нәтиже төменде көрсетілді."
      : "Сеанс тоқтатылды. Нәтижені қарап, қажет болса танылған мәтінді түзетіңіз.", "success");
    updateMetrics();
    if (revealResults) {
      elements.resultsSection.hidden = false;
      window.setTimeout(() => elements.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    }
  }

  function stopSession() {
    finishSession(false, true);
  }

  function getHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function setHistory(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 30)));
  }

  function readableDate(iso) {
    try {
      return new Intl.DateTimeFormat("kk-KZ", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch (_) {
      return new Date(iso).toLocaleString();
    }
  }

  function renderHistory() {
    const items = getHistory();
    elements.history.textContent = "";
    elements.clearHistory.hidden = items.length === 0;
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "Әзірге сақталған нәтиже жоқ.";
      elements.history.appendChild(empty);
      return;
    }

    items.forEach(item => {
      const row = document.createElement("article");
      row.className = "history-item";
      const title = document.createElement("div");
      const heading = document.createElement("h3");
      heading.textContent = readableDate(item.createdAt);
      const excerpt = document.createElement("p");
      excerpt.textContent = item.sourceExcerpt || "Мәтінсіз сеанс";
      title.append(heading, excerpt);

      const stats = [
        [item.wpm, "сөз/мин"],
        [item.words, "сөз"],
        [item.accuracy === null ? "—" : `${item.accuracy}%`, "сәйкестік"]
      ].map(([value, label]) => {
        const box = document.createElement("div");
        box.className = "history-stat";
        const strong = document.createElement("strong");
        strong.textContent = String(value);
        const span = document.createElement("span");
        span.textContent = label;
        box.append(strong, span);
        return box;
      });

      const remove = document.createElement("button");
      remove.className = "delete-result";
      remove.type = "button";
      remove.setAttribute("aria-label", "Нәтижені өшіру");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"/></svg>';
      remove.addEventListener("click", () => {
        setHistory(getHistory().filter(saved => saved.id !== item.id));
        renderHistory();
        toast("Нәтиже өшірілді");
      });
      row.append(title, ...stats, remove);
      elements.history.appendChild(row);
    });
  }

  function saveResult() {
    const metrics = updateMetrics();
    if (!metrics.spokenTokens.length || metrics.duration < 1000) {
      toast("Сақтау үшін аяқталған оқу сеансы керек");
      return;
    }
    const result = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      createdAt: new Date().toISOString(),
      durationMs: Math.round(metrics.duration),
      wpm: metrics.wpm,
      words: metrics.readWordCount,
      accuracy: metrics.accuracy,
      errors: metrics.alignment.substitutions + metrics.alignment.additions,
      omissions: metrics.alignment.omissions,
      sourceExcerpt: elements.source.value.trim().slice(0, 85),
      source: elements.source.value.trim(),
      transcript: elements.transcript.value.trim()
    };
    setHistory([result, ...getHistory()]);
    renderHistory();
    toast("Нәтиже осы құрылғыда сақталды");
  }

  function setSupport(icon, textNode, ok, text) {
    icon.textContent = ok ? "✓" : "!";
    icon.className = `support-icon ${ok ? "ok" : "bad"}`;
    textNode.textContent = text;
  }

  async function detectSupport() {
    const hasApi = Boolean(SpeechRecognition);
    elements.badge.className = `status-badge ${hasApi ? "supported" : "unsupported"}`;
    elements.badge.innerHTML = `<i></i>${hasApi ? "Тану қолдауы бар" : "Тану қолдауы жоқ"}`;
    setSupport(elements.apiIcon, elements.apiText, hasApi, hasApi ? "API бар; kk-KZ сеанста тексеріледі" : "Қолмен енгізу режимі қолжетімді");
    setSupport(elements.secureIcon, elements.secureText, window.isSecureContext, window.isSecureContext ? "Қауіпсіз орта — микрофонға рұқсат сұрауға болады" : "HTTPS қажет");
    updateNetworkSupport();

    if (hasApi && typeof SpeechRecognition.available === "function") {
      try {
        const availability = await SpeechRecognition.available({ langs: ["kk-KZ"], processLocally: false, quality: "dictation" });
        if (availability === "available") elements.apiText.textContent = "API бар; kk-KZ қолжетімді деп хабарланды";
        else if (availability === "unavailable") elements.apiText.textContent = "API бар; kk-KZ қолдауы кепілденбейді";
      } catch (_) { /* experimental check unavailable in this implementation */ }
    }

    if (!hasApi) {
      const isiOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      setNotice(isiOS ? "Бұл браузерде тану ашылмады. iPhone/iPad құрылғысында Safari арқылы ашып, Siri баптауын тексеріңіз." : "Бұл браузер сөйлеуді автоматты танымайды. Android құрылғысында Chrome арқылы ашып көріңіз немесе мәтінді қолмен енгізіңіз.", "error");
    }
  }

  function updateNetworkSupport() {
    const online = navigator.onLine;
    setSupport(elements.networkIcon, elements.networkText, online, online ? "Қосулы — бұлттық тану жұмыс істеуі мүмкін" : "Өшірулі — тану тоқтауы мүмкін");
  }

  function registerEvents() {
    elements.readyText.addEventListener("click", () => {
      elements.modeChooser.hidden = true;
      elements.gradeChooser.hidden = false;
      elements.gradeChooser.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    elements.customText.addEventListener("click", chooseCustomText);
    elements.gradeBack.addEventListener("click", () => {
      elements.gradeChooser.hidden = true;
      elements.modeChooser.hidden = false;
      elements.modeChooser.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    elements.gradeButtons.forEach(button => button.addEventListener("click", () => chooseRandomText(button.dataset.grade)));
    elements.changeMode.addEventListener("click", showModeChooser);
    elements.source.addEventListener("input", () => updateMetrics());
    elements.transcript.addEventListener("input", () => {
      if (!wantsListening) {
        finalTranscript = elements.transcript.value.trim();
        resetRecognitionResults();
      }
      updateMetrics();
    });
    elements.sample.addEventListener("click", () => {
      if (selectedGrade) chooseRandomText(selectedGrade);
    });
    elements.start.addEventListener("click", startSession);
    elements.stop.addEventListener("click", stopSession);
    elements.save.addEventListener("click", saveResult);
    elements.clearHistory.addEventListener("click", () => {
      if (!window.confirm("Барлық сақталған нәтижені осы құрылғыдан өшірейік пе?")) return;
      setHistory([]);
      renderHistory();
      toast("Барлық нәтиже өшірілді");
    });
    elements.help.addEventListener("click", () => {
      const next = elements.helpPanel.hidden;
      elements.helpPanel.hidden = !next;
      elements.help.setAttribute("aria-expanded", String(next));
      if (next) elements.helpPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    window.addEventListener("online", updateNetworkSupport);
    window.addEventListener("offline", updateNetworkSupport);
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      deferredInstall = event;
      elements.install.hidden = false;
    });
    elements.install.addEventListener("click", async () => {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      elements.install.hidden = true;
    });
    window.addEventListener("appinstalled", () => toast("Қосымша құрылғыға орнатылды"));
    window.addEventListener("beforeunload", () => {
      wantsListening = false;
      if (recognition) try { recognition.abort(); } catch (_) { /* ignore */ }
    });
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  function init() {
    registerEvents();
    registerServiceWorker();
    renderHistory();
    updateMetrics();
    detectSupport();
    updateControls(false);
    elements.timerDisplay.textContent = "01:00";
    elements.timerProgress.style.strokeDashoffset = "0";
  }

  // Small read-only surface used by automated QA; it does not alter saved user data.
  window.__oqyQarqyny = { tokenize, alignWords, appendWithoutRepeatedOverlap, updateMetrics };
  init();
})();
