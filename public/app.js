(() => {
  const ROUND_TIME_SECONDS = 60;
  const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

  const els = {
    homeView: document.getElementById("homeView"),
    lobbyView: document.getElementById("lobbyView"),
    gameView: document.getElementById("gameView"),

    modeLocal: document.getElementById("modeLocal"),
    modeOnline: document.getElementById("modeOnline"),
    localSetupPanel: document.getElementById("localSetupPanel"),
    onlineSetupPanel: document.getElementById("onlineSetupPanel"),

    localPlayers: document.getElementById("localPlayers"),
    addLocalPlayer: document.getElementById("addLocalPlayer"),
    removeLocalPlayer: document.getElementById("removeLocalPlayer"),
    localRounds: document.getElementById("localRounds"),
    startLocalBtn: document.getElementById("startLocalBtn"),

    onlineName: document.getElementById("onlineName"),
    onlineRounds: document.getElementById("onlineRounds"),
    createRoomBtn: document.getElementById("createRoomBtn"),
    joinCode: document.getElementById("joinCode"),
    joinRoomBtn: document.getElementById("joinRoomBtn"),

    roomCode: document.getElementById("roomCode"),
    copyCodeBtn: document.getElementById("copyCodeBtn"),
    lobbyPlayers: document.getElementById("lobbyPlayers"),
    lobbyRounds: document.getElementById("lobbyRounds"),
    startOnlineBtn: document.getElementById("startOnlineBtn"),
    leaveRoomBtn: document.getElementById("leaveRoomBtn"),

    phaseBadge: document.getElementById("phaseBadge"),
    roundStatus: document.getElementById("roundStatus"),
    timerChip: document.getElementById("timerChip"),
    scoreboard: document.getElementById("scoreboard"),

    setupPanel: document.getElementById("setupPanel"),
    setupTitle: document.getElementById("setupTitle"),
    setupHint: document.getElementById("setupHint"),
    letterSelect: document.getElementById("letterSelect"),
    randomLetterBtn: document.getElementById("randomLetterBtn"),
    opponentSelectWrap: document.getElementById("opponentSelectWrap"),
    opponentButtons: document.getElementById("opponentButtons"),
    beginTurnBtn: document.getElementById("beginTurnBtn"),

    answerPanel: document.getElementById("answerPanel"),
    answerTitle: document.getElementById("answerTitle"),
    answerHint: document.getElementById("answerHint"),
    answerForm: document.getElementById("answerForm"),
    answerName: document.getElementById("answerName"),
    answerPlace: document.getElementById("answerPlace"),
    answerAnimal: document.getElementById("answerAnimal"),
    answerThing: document.getElementById("answerThing"),

    waitingPanel: document.getElementById("waitingPanel"),
    waitingTitle: document.getElementById("waitingTitle"),
    waitingHint: document.getElementById("waitingHint"),

    resultPanel: document.getElementById("resultPanel"),
    resultSummary: document.getElementById("resultSummary"),
    resultFields: document.getElementById("resultFields"),
    resultScoreBreakdown: document.getElementById("resultScoreBreakdown"),
    continueBtn: document.getElementById("continueBtn"),

    finalPanel: document.getElementById("finalPanel"),
    finalScores: document.getElementById("finalScores"),
    newSessionBtn: document.getElementById("newSessionBtn"),
    backHomeBtn: document.getElementById("backHomeBtn"),

    passOverlay: document.getElementById("passOverlay"),
    passTitle: document.getElementById("passTitle"),
    passHint: document.getElementById("passHint"),
    revealTurnBtn: document.getElementById("revealTurnBtn"),

    toast: document.getElementById("toast")
  };

  const appState = {
    mode: "local",
    local: null,
    online: {
      socket: null,
      room: null,
      roomId: null,
      myPlayerId: null,
      mySocketId: null
    },
    ui: {
      localDraftNames: ["Player 1", "Player 2"],
      selectedLetter: "A",
      selectedOpponentId: null,
      answerTurnKey: null,
      localRevealKey: null,
      awaitingReveal: false
    },
    timers: {
      countdownInterval: null,
      countdownDeadline: null,
      localAnswerTimeout: null,
      toastTimeout: null
    }
  };

  function clearLocalAnswerTimeout() {
    if (appState.timers.localAnswerTimeout) {
      clearTimeout(appState.timers.localAnswerTimeout);
      appState.timers.localAnswerTimeout = null;
    }
  }

  function clampRounds(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 5;
    }
    return Math.max(1, Math.min(10, Math.floor(parsed)));
  }

  function sanitizeName(name, fallback) {
    const cleaned = String(name || "").trim().replace(/\s+/g, " ");
    if (!cleaned) {
      return fallback;
    }
    return cleaned.slice(0, 24);
  }

  function sanitizeLetter(letter) {
    const candidate = String(letter || "").trim().toUpperCase().slice(0, 1);
    return LETTERS.includes(candidate) ? candidate : null;
  }

  function normalizeAnswer(raw) {
    return String(raw || "").trim().replace(/\s+/g, " ");
  }

  function startsWithLetter(text, letter) {
    const normalized = normalizeAnswer(text);
    if (!normalized || !letter) {
      return false;
    }
    return normalized.charAt(0).toUpperCase() === letter;
  }

  function evaluateTurn(letter, answers, elapsedSeconds, streakBefore) {
    const categories = ["name", "place", "animal", "thing"];
    let validCount = 0;
    const normalizedAnswers = {};
    const validity = {};

    categories.forEach((category) => {
      const cleaned = normalizeAnswer(answers[category]);
      normalizedAnswers[category] = cleaned;
      const valid = startsWithLetter(cleaned, letter);
      validity[category] = valid;
      if (valid) {
        validCount += 1;
      }
    });

    const participation = 8;
    const categoryPoints = validCount * 15;
    const speedBonus = Math.max(0, Math.round((ROUND_TIME_SECONDS - elapsedSeconds) * 0.5));
    const completionBonus = validCount === 4 ? 20 : 0;
    const streakBonus = validCount === 4 && streakBefore > 0 ? Math.min(15, streakBefore * 5) : 0;
    const total = participation + categoryPoints + speedBonus + completionBonus + streakBonus;

    return {
      normalizedAnswers,
      validity,
      validCount,
      participation,
      categoryPoints,
      speedBonus,
      completionBonus,
      streakBonus,
      total,
      fullClear: validCount === 4,
      elapsedSeconds
    };
  }

  function showToast(message) {
    if (!message) {
      return;
    }
    els.toast.textContent = message;
    els.toast.classList.remove("hidden");

    if (appState.timers.toastTimeout) {
      clearTimeout(appState.timers.toastTimeout);
    }

    appState.timers.toastTimeout = setTimeout(() => {
      els.toast.classList.add("hidden");
    }, 2400);
  }

  function setMode(mode) {
    appState.mode = mode;
    els.modeLocal.classList.toggle("active", mode === "local");
    els.modeOnline.classList.toggle("active", mode === "online");
    els.localSetupPanel.classList.toggle("hidden", mode !== "local");
    els.onlineSetupPanel.classList.toggle("hidden", mode !== "online");
    render();
  }

  function showView(viewName) {
    els.homeView.classList.toggle("hidden", viewName !== "home");
    els.lobbyView.classList.toggle("hidden", viewName !== "lobby");
    els.gameView.classList.toggle("hidden", viewName !== "game");
  }

  function createLocalPlayer(name, index) {
    return {
      id: `L-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 6)}`,
      socketId: `local-${index}`,
      name,
      score: 0,
      roundsCompleted: 0,
      turnsAnswered: 0,
      fullCompletions: 0,
      totalAnswerTime: 0,
      averageTime: 0,
      streak: 0,
      connected: true
    };
  }

  function getPlayer(room, playerId) {
    return room.players.find((player) => player.id === playerId) || null;
  }

  function eligibleOpponents(room, selectorId) {
    return room.players.filter(
      (player) => player.id !== selectorId && player.roundsCompleted < room.settings.roundsPerPlayer
    );
  }

  function allPlayersDone(room) {
    return room.players.every((player) => player.roundsCompleted >= room.settings.roundsPerPlayer);
  }

  function findNextSelector(room, currentSelectorId = null) {
    const startIndex = currentSelectorId
      ? room.players.findIndex((player) => player.id === currentSelectorId)
      : -1;

    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const idx = (startIndex + offset + room.players.length) % room.players.length;
      const candidate = room.players[idx];
      if (eligibleOpponents(room, candidate.id).length > 0) {
        return candidate;
      }
    }

    return null;
  }

  function createLocalRoom(names, roundsPerPlayer) {
    const players = names.map((name, index) => createLocalPlayer(name, index));
    const room = {
      id: "LOCAL",
      hostSocketId: "local-host",
      settings: {
        roundsPerPlayer
      },
      players,
      state: {
        phase: "setup",
        selectorId: null,
        selectedLetter: null,
        opponentId: null,
        answerStartedAt: null,
        answerDeadline: null,
        turnNumber: 1,
        lastResult: null
      }
    };

    const selector = findNextSelector(room, null);
    room.state.selectorId = selector ? selector.id : null;

    return room;
  }

  function clearCountdown() {
    if (appState.timers.countdownInterval) {
      clearInterval(appState.timers.countdownInterval);
      appState.timers.countdownInterval = null;
    }
    appState.timers.countdownDeadline = null;
    els.timerChip.textContent = `${ROUND_TIME_SECONDS}s`;
    els.timerChip.classList.remove("warning", "danger");
  }

  function startCountdown(deadlineMs) {
    if (!deadlineMs) {
      clearCountdown();
      return;
    }

    if (appState.timers.countdownDeadline === deadlineMs && appState.timers.countdownInterval) {
      return;
    }

    clearCountdown();
    appState.timers.countdownDeadline = deadlineMs;

    const tick = () => {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      const remainingSec = Math.ceil(remainingMs / 1000);
      els.timerChip.textContent = `${remainingSec}s`;
      els.timerChip.classList.toggle("warning", remainingSec <= 20 && remainingSec > 8);
      els.timerChip.classList.toggle("danger", remainingSec <= 8);
      if (remainingSec <= 0 && appState.timers.countdownInterval) {
        clearInterval(appState.timers.countdownInterval);
        appState.timers.countdownInterval = null;
      }
    };

    tick();
    appState.timers.countdownInterval = setInterval(tick, 220);
  }

  function resetAnswerForm() {
    els.answerName.value = "";
    els.answerPlace.value = "";
    els.answerAnimal.value = "";
    els.answerThing.value = "";
  }

  function updateLocalPlayerInputs() {
    els.localPlayers.innerHTML = appState.ui.localDraftNames
      .map(
        (name, index) => `
        <div>
          <label class="field-label" for="playerName${index}">Player ${index + 1}</label>
          <input id="playerName${index}" data-player-index="${index}" class="text-input local-player-input" value="${name.replace(
            /"/g,
            "&quot;"
          )}" maxlength="24" />
        </div>
      `
      )
      .join("");
  }

  function startLocalGame() {
    const roundsPerPlayer = clampRounds(els.localRounds.value);
    const names = appState.ui.localDraftNames.map((name, index) => sanitizeName(name, `Player ${index + 1}`));

    if (names.length < 2 || names.length > 4) {
      showToast("Local mode needs 2-4 players.");
      return;
    }

    appState.local = createLocalRoom(names, roundsPerPlayer);
    appState.ui.selectedLetter = "A";
    appState.ui.selectedOpponentId = null;
    appState.ui.answerTurnKey = null;
    appState.ui.localRevealKey = null;
    appState.ui.awaitingReveal = false;
    resetAnswerForm();
    render();
  }

  function beginLocalTurn() {
    const room = appState.local;
    if (!room || room.state.phase !== "setup") {
      return;
    }

    const selector = getPlayer(room, room.state.selectorId);
    if (!selector) {
      return;
    }

    const letter = sanitizeLetter(appState.ui.selectedLetter || els.letterSelect.value);
    if (!letter) {
      showToast("Pick a valid letter.");
      return;
    }

    const options = eligibleOpponents(room, selector.id);
    let opponentId = appState.ui.selectedOpponentId;

    if (room.players.length === 2) {
      opponentId = options[0] ? options[0].id : null;
    }

    const opponent = getPlayer(room, opponentId);
    if (!opponent || !options.find((candidate) => candidate.id === opponent.id)) {
      showToast("Choose an opponent.");
      return;
    }

    room.state.phase = "answering";
    room.state.selectedLetter = letter;
    room.state.opponentId = opponent.id;
    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;
    room.state.turnNumber += 1;

    appState.ui.answerTurnKey = null;
    appState.ui.localRevealKey = `${room.state.turnNumber}-${opponent.id}`;
    appState.ui.awaitingReveal = true;
    resetAnswerForm();

    render();
  }

  function startLocalAnswerClock() {
    const room = appState.local;
    if (!room || room.state.phase !== "answering" || room.state.answerStartedAt) {
      return;
    }

    room.state.answerStartedAt = Date.now();
    room.state.answerDeadline = room.state.answerStartedAt + ROUND_TIME_SECONDS * 1000;
    clearLocalAnswerTimeout();
    appState.timers.localAnswerTimeout = setTimeout(() => {
      submitLocalTurn({}, true);
    }, ROUND_TIME_SECONDS * 1000 + 30);
  }

  function submitLocalTurn(answers, timedOut) {
    const room = appState.local;
    if (!room || room.state.phase !== "answering") {
      return;
    }

    const opponent = getPlayer(room, room.state.opponentId);
    if (!opponent) {
      return;
    }

    const now = Date.now();
    const startedAt = room.state.answerStartedAt || now;
    const elapsedSeconds = Math.max(
      0,
      Math.min(ROUND_TIME_SECONDS, Math.round((now - startedAt) / 1000))
    );

    const result = evaluateTurn(room.state.selectedLetter, answers, elapsedSeconds, opponent.streak);

    opponent.score += result.total;
    opponent.roundsCompleted += 1;
    opponent.turnsAnswered += 1;
    opponent.totalAnswerTime += elapsedSeconds;
    opponent.averageTime = Number((opponent.totalAnswerTime / opponent.turnsAnswered).toFixed(1));

    if (result.fullClear) {
      opponent.fullCompletions += 1;
      opponent.streak += 1;
    } else {
      opponent.streak = 0;
    }

    room.state.phase = "result";
    room.state.lastResult = {
      selectorId: room.state.selectorId,
      opponentId: opponent.id,
      letter: room.state.selectedLetter,
      answers: result.normalizedAnswers,
      validity: result.validity,
      elapsedSeconds,
      timedOut,
      scoreBreakdown: {
        participation: result.participation,
        categoryPoints: result.categoryPoints,
        speedBonus: result.speedBonus,
        completionBonus: result.completionBonus,
        streakBonus: result.streakBonus,
        validCount: result.validCount,
        total: result.total
      }
    };

    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;
    appState.ui.awaitingReveal = false;

    clearLocalAnswerTimeout();

    render();
  }

  function continueLocalTurn() {
    const room = appState.local;
    if (!room || room.state.phase !== "result") {
      return;
    }

    if (allPlayersDone(room)) {
      room.state.phase = "finished";
      room.state.selectorId = null;
      room.state.selectedLetter = null;
      room.state.opponentId = null;
      render();
      return;
    }

    const nextSelector = findNextSelector(room, room.state.selectorId);
    if (!nextSelector) {
      room.state.phase = "finished";
      room.state.selectorId = null;
      room.state.selectedLetter = null;
      room.state.opponentId = null;
      render();
      return;
    }

    room.state.phase = "setup";
    room.state.selectorId = nextSelector.id;
    room.state.selectedLetter = null;
    room.state.opponentId = null;
    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;

    appState.ui.selectedOpponentId = null;
    appState.ui.selectedLetter = "A";
    render();
  }

  function ensureSocket() {
    if (appState.online.socket) {
      return appState.online.socket;
    }

    if (typeof io !== "function") {
      showToast("Socket client unavailable.");
      return null;
    }

    const socket = io();
    appState.online.socket = socket;

    socket.on("connect", () => {
      appState.online.mySocketId = socket.id;
      render();
    });

    socket.on("disconnect", () => {
      showToast("Disconnected from server.");
      render();
    });

    socket.on("room:update", (room) => {
      appState.online.room = room;
      if (!appState.online.roomId) {
        appState.online.roomId = room.id;
      }
      if (room.state.phase === "lobby") {
        els.lobbyRounds.value = String(room.settings.roundsPerPlayer);
      }
      render();
    });

    return socket;
  }

  function createOnlineRoom() {
    const socket = ensureSocket();
    if (!socket) {
      return;
    }

    const name = sanitizeName(els.onlineName.value, "Host");
    const roundsPerPlayer = clampRounds(els.onlineRounds.value);

    socket.emit("room:create", { name }, (response) => {
      if (!response || !response.ok) {
        showToast(response && response.error ? response.error : "Could not create room.");
        return;
      }

      appState.online.roomId = response.roomId;
      appState.online.myPlayerId = response.playerId;
      socket.emit("lobby:setRounds", {
        roomId: response.roomId,
        roundsPerPlayer
      });
      showToast(`Room ${response.roomId} created.`);
    });
  }

  function joinOnlineRoom() {
    const socket = ensureSocket();
    if (!socket) {
      return;
    }

    const roomId = String(els.joinCode.value || "").trim().toUpperCase();
    if (!roomId) {
      showToast("Enter a room code.");
      return;
    }

    const name = sanitizeName(els.onlineName.value, "Player");

    socket.emit("room:join", { roomId, name }, (response) => {
      if (!response || !response.ok) {
        showToast(response && response.error ? response.error : "Could not join room.");
        return;
      }

      appState.online.roomId = response.roomId;
      appState.online.myPlayerId = response.playerId;
      showToast(`Joined room ${response.roomId}.`);
    });
  }

  function startOnlineGame() {
    const socket = appState.online.socket;
    const room = appState.online.room;
    if (!socket || !room) {
      return;
    }

    const roundsPerPlayer = clampRounds(els.lobbyRounds.value);

    socket.emit(
      "game:start",
      {
        roomId: room.id,
        roundsPerPlayer
      },
      (response) => {
        if (!response || !response.ok) {
          showToast(response && response.error ? response.error : "Could not start game.");
        }
      }
    );
  }

  function beginOnlineTurn() {
    const socket = appState.online.socket;
    const room = appState.online.room;
    if (!socket || !room || room.state.phase !== "setup") {
      return;
    }

    const selector = getPlayer(room, room.state.selectorId);
    if (!selector) {
      return;
    }

    const opponents = eligibleOpponents(room, selector.id);
    let opponentId = appState.ui.selectedOpponentId;
    if (room.players.length === 2) {
      opponentId = opponents[0] ? opponents[0].id : null;
    }

    const letter = sanitizeLetter(appState.ui.selectedLetter || els.letterSelect.value);
    if (!letter) {
      showToast("Choose a letter A-Z.");
      return;
    }

    socket.emit(
      "turn:start",
      {
        roomId: room.id,
        letter,
        opponentId
      },
      (response) => {
        if (!response || !response.ok) {
          showToast(response && response.error ? response.error : "Could not begin turn.");
          return;
        }
        appState.ui.answerTurnKey = null;
      }
    );
  }

  function submitOnlineTurn(answers) {
    const socket = appState.online.socket;
    const room = appState.online.room;
    if (!socket || !room) {
      return;
    }

    socket.emit(
      "turn:submit",
      {
        roomId: room.id,
        answers
      },
      (response) => {
        if (!response || !response.ok) {
          showToast(response && response.error ? response.error : "Could not submit answers.");
        }
      }
    );
  }

  function continueOnlineTurn() {
    const socket = appState.online.socket;
    const room = appState.online.room;
    if (!socket || !room) {
      return;
    }

    socket.emit("turn:continue", { roomId: room.id }, (response) => {
      if (!response || !response.ok) {
        showToast(response && response.error ? response.error : "Could not continue.");
      }
    });
  }

  function restartOnlineToLobby() {
    const socket = appState.online.socket;
    const room = appState.online.room;
    if (!socket || !room) {
      return;
    }

    socket.emit("game:restart", { roomId: room.id }, (response) => {
      if (!response || !response.ok) {
        showToast(response && response.error ? response.error : "Only host can restart.");
      }
    });
  }

  function leaveOnlineRoom() {
    if (appState.online.socket) {
      appState.online.socket.disconnect();
    }

    appState.online = {
      socket: null,
      room: null,
      roomId: null,
      myPlayerId: null,
      mySocketId: null
    };
    appState.ui.answerTurnKey = null;
    appState.ui.awaitingReveal = false;
    clearCountdown();
    clearLocalAnswerTimeout();
    render();
  }

  function myOnlinePlayer(room) {
    if (!room) {
      return null;
    }
    return room.players.find((player) => player.id === appState.online.myPlayerId) || null;
  }

  function isOnlineHost(room) {
    return Boolean(room && room.hostSocketId && room.hostSocketId === appState.online.mySocketId);
  }

  function clearStagePanels() {
    [els.setupPanel, els.answerPanel, els.waitingPanel, els.resultPanel, els.finalPanel].forEach((panel) => {
      panel.classList.add("hidden");
    });
  }

  function renderScoreboard(players, roundsPerPlayer) {
    const sorted = [...players].sort((a, b) => b.score - a.score);
    els.scoreboard.innerHTML = sorted
      .map(
        (player, index) => `
          <div class="score-row ${index === 0 ? "top" : ""}">
            <div class="score-row-name">
              <span>${player.name}</span>
              <span>${player.score} pts</span>
            </div>
            <div class="score-row-meta">
              Rounds: ${player.roundsCompleted}/${roundsPerPlayer} | Full clears: ${player.fullCompletions}
            </div>
          </div>
        `
      )
      .join("");
  }

  function renderSetupPanel(room, isOnline) {
    const selector = getPlayer(room, room.state.selectorId);
    const currentPlayer = isOnline ? myOnlinePlayer(room) : null;
    const amSelector = !isOnline || (currentPlayer && selector && currentPlayer.id === selector.id);

    if (!selector) {
      clearStagePanels();
      els.waitingPanel.classList.remove("hidden");
      els.waitingTitle.textContent = "Waiting for next turn";
      els.waitingHint.textContent = "No eligible selector found.";
      return;
    }

    if (!amSelector) {
      clearStagePanels();
      els.waitingPanel.classList.remove("hidden");
      els.waitingTitle.textContent = `${selector.name} is choosing the challenge`;
      els.waitingHint.textContent = "Hang tight. The round starts once they lock in letter and opponent.";
      return;
    }

    clearStagePanels();
    els.setupPanel.classList.remove("hidden");
    els.setupTitle.textContent = `${selector.name}, set this round`;
    els.setupHint.textContent = "Pick a letter and choose who answers. Faster correct answers score more points.";

    els.letterSelect.value = appState.ui.selectedLetter;

    const opponents = eligibleOpponents(room, selector.id);
    if (room.players.length === 2) {
      const autoOpponent = opponents[0];
      appState.ui.selectedOpponentId = autoOpponent ? autoOpponent.id : null;
      els.opponentButtons.innerHTML = autoOpponent
        ? `<span class="opponent-chip active">${autoOpponent.name} (auto-selected)</span>`
        : "<span class=\"panel-note\">No opponent available</span>";
    } else {
      if (!opponents.find((player) => player.id === appState.ui.selectedOpponentId)) {
        appState.ui.selectedOpponentId = opponents[0] ? opponents[0].id : null;
      }
      els.opponentButtons.innerHTML = opponents
        .map(
          (player) => `
            <button
              class="opponent-chip ${player.id === appState.ui.selectedOpponentId ? "active" : ""}"
              data-opponent-id="${player.id}"
              type="button"
            >
              ${player.name} (${player.roundsCompleted}/${room.settings.roundsPerPlayer})
            </button>
          `
        )
        .join("");
    }

    els.beginTurnBtn.disabled = !sanitizeLetter(appState.ui.selectedLetter);
  }

  function renderAnswerPanel(room, isOnline) {
    const selector = getPlayer(room, room.state.selectorId);
    const opponent = getPlayer(room, room.state.opponentId);
    const currentPlayer = isOnline ? myOnlinePlayer(room) : null;
    const amOpponent = !isOnline || (currentPlayer && opponent && currentPlayer.id === opponent.id);

    if (!opponent || !selector) {
      clearStagePanels();
      els.waitingPanel.classList.remove("hidden");
      els.waitingTitle.textContent = "Waiting";
      els.waitingHint.textContent = "Active turn data missing.";
      return;
    }

    if (isOnline && !amOpponent) {
      clearStagePanels();
      els.waitingPanel.classList.remove("hidden");
      els.waitingTitle.textContent = `${opponent.name} is answering now`;
      els.waitingHint.textContent = `Letter: ${room.state.selectedLetter}. 60 seconds on the clock.`;
      return;
    }

    if (!isOnline) {
      const revealKey = `${room.state.turnNumber}-${opponent.id}`;
      if (appState.ui.localRevealKey !== revealKey) {
        appState.ui.localRevealKey = revealKey;
        appState.ui.awaitingReveal = true;
      }

      if (appState.ui.awaitingReveal) {
        clearStagePanels();
        els.waitingPanel.classList.remove("hidden");
        els.waitingTitle.textContent = "Private turn loading";
        els.waitingHint.textContent = "Use the pass screen to reveal the answering form.";
        els.passOverlay.classList.remove("hidden");
        els.passTitle.textContent = `Pass device to ${opponent.name}`;
        els.passHint.textContent = `Their 60-second timer starts when you reveal letter ${room.state.selectedLetter}.`;
        return;
      }
    }

    els.passOverlay.classList.add("hidden");
    clearStagePanels();
    els.answerPanel.classList.remove("hidden");

    const turnKey = `${room.state.answerStartedAt}-${opponent.id}-${room.state.selectedLetter}`;
    if (appState.ui.answerTurnKey !== turnKey) {
      appState.ui.answerTurnKey = turnKey;
      resetAnswerForm();
      setTimeout(() => {
        els.answerName.focus();
      }, 20);
    }

    els.answerTitle.textContent = `${opponent.name}, your turn`;
    els.answerHint.textContent = `Use letter ${room.state.selectedLetter} for all answers. Submit early for speed bonus.`;
  }

  function renderResultPanel(room) {
    const result = room.state.lastResult;
    if (!result) {
      clearStagePanels();
      els.waitingPanel.classList.remove("hidden");
      els.waitingTitle.textContent = "Processing result";
      els.waitingHint.textContent = "Please wait.";
      return;
    }

    const opponent = getPlayer(room, result.opponentId);
    const labelByField = {
      name: "Name",
      place: "Place",
      animal: "Animal",
      thing: "Thing"
    };

    clearStagePanels();
    els.resultPanel.classList.remove("hidden");

    els.resultSummary.textContent = `${opponent ? opponent.name : "Player"} scored ${
      result.scoreBreakdown.total
    } points on letter ${result.letter}${result.timedOut ? " (time expired)" : ""}.`;

    els.resultFields.innerHTML = Object.keys(labelByField)
      .map((field) => {
        const valid = Boolean(result.validity[field]);
        const value = result.answers[field] || "(blank)";
        return `
          <div class="result-cell ${valid ? "good" : "bad"}">
            <strong>${labelByField[field]}</strong>
            <p>${value}</p>
            <small>${valid ? "Valid" : "No point"}</small>
          </div>
        `;
      })
      .join("");

    const b = result.scoreBreakdown;
    els.resultScoreBreakdown.innerHTML = `
      <p>Participation: +${b.participation}</p>
      <p>Valid answers (${b.validCount}/4): +${b.categoryPoints}</p>
      <p>Speed bonus (${result.elapsedSeconds}s): +${b.speedBonus}</p>
      <p>All-correct bonus: +${b.completionBonus}</p>
      <p>Streak bonus: +${b.streakBonus}</p>
      <p><strong>Total: ${b.total} points</strong></p>
    `;
  }

  function renderFinalPanel(room, isOnline) {
    clearStagePanels();
    els.finalPanel.classList.remove("hidden");

    const sorted = [...room.players].sort((a, b) => b.score - a.score);
    els.finalScores.innerHTML = `
      <ul class="final-list">
        ${sorted
          .map(
            (player, index) => `
              <li class="${index === 0 ? "winner" : ""}">
                <span>${index + 1}. ${player.name}</span>
                <span>${player.score} pts</span>
              </li>
            `
          )
          .join("")}
      </ul>
    `;

    if (!isOnline) {
      els.newSessionBtn.textContent = "New Session";
      els.newSessionBtn.disabled = false;
      return;
    }

    const amHost = isOnlineHost(room);
    els.newSessionBtn.textContent = amHost ? "Play Again (Lobby)" : "Waiting for host";
    els.newSessionBtn.disabled = !amHost;
  }

  function renderGame(room, isOnline) {
    const phaseLabel = {
      setup: "Setup",
      answering: "Answering",
      result: "Result",
      finished: "Final"
    }[room.state.phase] || "Game";

    const totalRoundsTarget = room.settings.roundsPerPlayer * room.players.length;
    const roundsDone = room.players.reduce((sum, player) => sum + player.roundsCompleted, 0);

    els.phaseBadge.textContent = phaseLabel;
    els.roundStatus.textContent = `${roundsDone}/${totalRoundsTarget} answered turns`;

    renderScoreboard(room.players, room.settings.roundsPerPlayer);

    if (room.state.phase === "answering") {
      startCountdown(room.state.answerDeadline);
    } else {
      clearCountdown();
    }

    if (room.state.phase === "setup") {
      renderSetupPanel(room, isOnline);
      return;
    }

    if (room.state.phase === "answering") {
      renderAnswerPanel(room, isOnline);
      return;
    }

    if (room.state.phase === "result") {
      renderResultPanel(room);
      return;
    }

    if (room.state.phase === "finished") {
      renderFinalPanel(room, isOnline);
      return;
    }

    clearStagePanels();
    els.waitingPanel.classList.remove("hidden");
    els.waitingTitle.textContent = "Waiting";
    els.waitingHint.textContent = "Preparing game state.";
  }

  function renderLobby(room) {
    showView("lobby");
    els.roomCode.textContent = room.id;

    const hostPlayer = room.players.find((player) => player.socketId === room.hostSocketId);
    els.lobbyPlayers.innerHTML = room.players
      .map((player) => {
        const parts = [player.name];
        if (hostPlayer && hostPlayer.id === player.id) {
          parts.push("(host)");
        }
        if (player.connected === false) {
          parts.push("(disconnected)");
        }
        return `<li>${parts.join(" ")}</li>`;
      })
      .join("");

    const amHost = isOnlineHost(room);
    els.lobbyRounds.value = String(room.settings.roundsPerPlayer);
    els.lobbyRounds.disabled = !amHost;
    els.startOnlineBtn.disabled = !amHost || room.players.length < 2;
  }

  function renderHome() {
    showView("home");
    updateLocalPlayerInputs();
  }

  function render() {
    els.localSetupPanel.classList.toggle("hidden", appState.mode !== "local");
    els.onlineSetupPanel.classList.toggle("hidden", appState.mode !== "online");

    if (appState.mode === "online" && appState.online.room) {
      const room = appState.online.room;
      if (room.state.phase === "lobby") {
        clearCountdown();
        els.passOverlay.classList.add("hidden");
        renderLobby(room);
      } else {
        showView("game");
        renderGame(room, true);
      }
      return;
    }

    if (appState.mode === "local" && appState.local) {
      showView("game");
      renderGame(appState.local, false);
      return;
    }

    els.passOverlay.classList.add("hidden");
    renderHome();
  }

  function initLetterSelect() {
    els.letterSelect.innerHTML = LETTERS.map((letter) => `<option value="${letter}">${letter}</option>`).join("");
    els.letterSelect.value = appState.ui.selectedLetter;
  }

  function initEvents() {
    els.modeLocal.addEventListener("click", () => setMode("local"));
    els.modeOnline.addEventListener("click", () => setMode("online"));

    els.localPlayers.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) {
        return;
      }
      const index = Number(target.dataset.playerIndex);
      if (!Number.isFinite(index)) {
        return;
      }
      appState.ui.localDraftNames[index] = target.value;
    });

    els.addLocalPlayer.addEventListener("click", () => {
      if (appState.ui.localDraftNames.length >= 4) {
        showToast("Maximum 4 players.");
        return;
      }
      appState.ui.localDraftNames.push(`Player ${appState.ui.localDraftNames.length + 1}`);
      updateLocalPlayerInputs();
    });

    els.removeLocalPlayer.addEventListener("click", () => {
      if (appState.ui.localDraftNames.length <= 2) {
        showToast("Minimum 2 players.");
        return;
      }
      appState.ui.localDraftNames.pop();
      updateLocalPlayerInputs();
    });

    els.startLocalBtn.addEventListener("click", startLocalGame);

    els.createRoomBtn.addEventListener("click", createOnlineRoom);
    els.joinRoomBtn.addEventListener("click", joinOnlineRoom);

    els.copyCodeBtn.addEventListener("click", async () => {
      const code = els.roomCode.textContent;
      if (!code || code === "-----") {
        return;
      }
      try {
        await navigator.clipboard.writeText(code);
        showToast("Room code copied.");
      } catch {
        showToast("Copy failed.");
      }
    });

    els.startOnlineBtn.addEventListener("click", startOnlineGame);

    els.lobbyRounds.addEventListener("change", () => {
      const room = appState.online.room;
      const socket = appState.online.socket;
      if (!room || !socket || !isOnlineHost(room)) {
        return;
      }
      socket.emit("lobby:setRounds", {
        roomId: room.id,
        roundsPerPlayer: clampRounds(els.lobbyRounds.value)
      });
    });

    els.leaveRoomBtn.addEventListener("click", leaveOnlineRoom);

    els.letterSelect.addEventListener("change", () => {
      appState.ui.selectedLetter = els.letterSelect.value;
    });

    els.randomLetterBtn.addEventListener("click", () => {
      const random = LETTERS[Math.floor(Math.random() * LETTERS.length)];
      appState.ui.selectedLetter = random;
      els.letterSelect.value = random;
    });

    els.opponentButtons.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest("[data-opponent-id]");
      if (!button) {
        return;
      }
      const opponentId = button.getAttribute("data-opponent-id");
      if (!opponentId) {
        return;
      }
      appState.ui.selectedOpponentId = opponentId;
      render();
    });

    els.beginTurnBtn.addEventListener("click", () => {
      if (appState.mode === "local" && appState.local) {
        beginLocalTurn();
        return;
      }
      if (appState.mode === "online" && appState.online.room) {
        beginOnlineTurn();
      }
    });

    els.answerForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const answers = {
        name: els.answerName.value,
        place: els.answerPlace.value,
        animal: els.answerAnimal.value,
        thing: els.answerThing.value
      };

      if (appState.mode === "local" && appState.local) {
        submitLocalTurn(answers, false);
        return;
      }

      if (appState.mode === "online" && appState.online.room) {
        submitOnlineTurn(answers);
      }
    });

    els.continueBtn.addEventListener("click", () => {
      if (appState.mode === "local" && appState.local) {
        continueLocalTurn();
        return;
      }
      if (appState.mode === "online" && appState.online.room) {
        continueOnlineTurn();
      }
    });

    els.newSessionBtn.addEventListener("click", () => {
      if (appState.mode === "local") {
        appState.local = null;
        clearCountdown();
        clearLocalAnswerTimeout();
        render();
        return;
      }

      if (appState.mode === "online" && appState.online.room) {
        restartOnlineToLobby();
      }
    });

    els.backHomeBtn.addEventListener("click", () => {
      if (appState.mode === "online") {
        leaveOnlineRoom();
      }
      appState.local = null;
      clearCountdown();
      clearLocalAnswerTimeout();
      render();
    });

    els.revealTurnBtn.addEventListener("click", () => {
      appState.ui.awaitingReveal = false;
      startLocalAnswerClock();
      els.passOverlay.classList.add("hidden");
      render();
    });

    els.joinCode.addEventListener("input", () => {
      els.joinCode.value = els.joinCode.value.toUpperCase();
    });
  }

  function init() {
    initLetterSelect();
    initEvents();
    updateLocalPlayerInputs();
    render();
  }

  init();
})();
