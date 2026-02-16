const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROUND_TIME_SECONDS = 60;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

function makeId(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i += 1) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function clampRoundCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 5;
  }
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function sanitizeName(name, fallback = "Player") {
  if (typeof name !== "string") {
    return fallback;
  }
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, 24);
}

function sanitizeLetter(letter) {
  if (typeof letter !== "string" || !letter.trim()) {
    return null;
  }
  const first = letter.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : null;
}

function normalizeAnswer(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().replace(/\s+/g, " ");
}

function startsWithLetter(text, letter) {
  if (!text || !letter) {
    return false;
  }
  const first = text.trim().charAt(0).toUpperCase();
  return first === letter;
}

function createPlayer(socketId, name) {
  return {
    id: makeId(8),
    socketId,
    name: sanitizeName(name),
    score: 0,
    roundsCompleted: 0,
    turnsAnswered: 0,
    fullCompletions: 0,
    totalAnswerTime: 0,
    streak: 0,
    connected: true
  };
}

function createRoom(hostSocketId, hostName) {
  let id = makeId(5);
  while (rooms.has(id)) {
    id = makeId(5);
  }

  const hostPlayer = createPlayer(hostSocketId, hostName);
  const room = {
    id,
    hostSocketId,
    players: [hostPlayer],
    settings: {
      roundsPerPlayer: 5
    },
    state: {
      phase: "lobby",
      selectorId: null,
      selectedLetter: null,
      opponentId: null,
      answerStartedAt: null,
      answerDeadline: null,
      turnNumber: 0,
      lastResult: null
    },
    timeoutHandle: null,
    createdAt: Date.now()
  };

  rooms.set(id, room);
  return room;
}

function getPlayerBySocket(room, socketId) {
  return room.players.find((player) => player.socketId === socketId);
}

function getPlayerById(room, playerId) {
  return room.players.find((player) => player.id === playerId);
}

function allPlayersDone(room) {
  return room.players.every((player) => player.roundsCompleted >= room.settings.roundsPerPlayer);
}

function eligibleOpponents(room, selectorId) {
  return room.players.filter(
    (player) => player.id !== selectorId && player.roundsCompleted < room.settings.roundsPerPlayer
  );
}

function findNextSelector(room, currentSelectorId = null) {
  if (room.players.length < MIN_PLAYERS) {
    return null;
  }

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

function clearRoomTimer(room) {
  if (room.timeoutHandle) {
    clearTimeout(room.timeoutHandle);
    room.timeoutHandle = null;
  }
}

function publicRoomState(room) {
  return {
    id: room.id,
    hostSocketId: room.hostSocketId,
    settings: room.settings,
    state: room.state,
    players: room.players.map((player) => ({
      id: player.id,
      socketId: player.socketId,
      name: player.name,
      score: player.score,
      roundsCompleted: player.roundsCompleted,
      turnsAnswered: player.turnsAnswered,
      fullCompletions: player.fullCompletions,
      averageTime:
        player.turnsAnswered > 0 ? Number((player.totalAnswerTime / player.turnsAnswered).toFixed(1)) : 0,
      connected: player.connected
    }))
  };
}

function emitRoom(room) {
  io.to(room.id).emit("room:update", publicRoomState(room));
}

function evaluateTurn(letter, answers, elapsedSeconds, streakBefore) {
  const categories = ["name", "place", "animal", "thing"];
  const normalizedAnswers = {};
  const validity = {};
  let validCount = 0;

  for (const category of categories) {
    const cleaned = normalizeAnswer(answers[category]);
    normalizedAnswers[category] = cleaned;
    const valid = startsWithLetter(cleaned, letter);
    validity[category] = valid;
    if (valid) {
      validCount += 1;
    }
  }

  const participation = 8;
  const categoryPoints = validCount * 15;
  const speedBonus = Math.max(0, Math.round((ROUND_TIME_SECONDS - elapsedSeconds) * 0.5));
  const completionBonus = validCount === categories.length ? 20 : 0;
  const streakBonus = validCount === categories.length && streakBefore > 0 ? Math.min(15, streakBefore * 5) : 0;

  const total = participation + categoryPoints + speedBonus + completionBonus + streakBonus;

  return {
    normalizedAnswers,
    validity,
    elapsedSeconds,
    validCount,
    participation,
    categoryPoints,
    speedBonus,
    completionBonus,
    streakBonus,
    total,
    fullClear: validCount === categories.length
  };
}

function moveToNextStep(room) {
  if (allPlayersDone(room)) {
    room.state.phase = "finished";
    room.state.selectorId = null;
    room.state.selectedLetter = null;
    room.state.opponentId = null;
    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;
    return;
  }

  const nextSelector = findNextSelector(room, room.state.selectorId);
  if (!nextSelector) {
    room.state.phase = "finished";
    room.state.selectorId = null;
    room.state.selectedLetter = null;
    room.state.opponentId = null;
    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;
    return;
  }

  room.state.phase = "setup";
  room.state.selectorId = nextSelector.id;
  room.state.selectedLetter = null;
  room.state.opponentId = null;
  room.state.answerStartedAt = null;
  room.state.answerDeadline = null;
}

function finalizeSubmission(room, opponentId, rawAnswers = {}, timedOut = false) {
  if (room.state.phase !== "answering") {
    return;
  }

  const opponent = getPlayerById(room, opponentId);
  if (!opponent) {
    return;
  }

  const now = Date.now();
  const startedAt = room.state.answerStartedAt || now;
  const elapsedSeconds = Math.max(
    0,
    Math.min(ROUND_TIME_SECONDS, Math.round((now - startedAt) / 1000))
  );

  const evaluation = evaluateTurn(
    room.state.selectedLetter,
    rawAnswers,
    elapsedSeconds,
    opponent.streak
  );

  opponent.score += evaluation.total;
  opponent.roundsCompleted += 1;
  opponent.turnsAnswered += 1;
  opponent.totalAnswerTime += elapsedSeconds;

  if (evaluation.fullClear) {
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
    answers: evaluation.normalizedAnswers,
    validity: evaluation.validity,
    elapsedSeconds,
    timedOut,
    scoreBreakdown: {
      participation: evaluation.participation,
      categoryPoints: evaluation.categoryPoints,
      speedBonus: evaluation.speedBonus,
      completionBonus: evaluation.completionBonus,
      streakBonus: evaluation.streakBonus,
      total: evaluation.total,
      validCount: evaluation.validCount
    }
  };

  room.state.answerStartedAt = null;
  room.state.answerDeadline = null;
  clearRoomTimer(room);
}

function startGame(room, roundsPerPlayer) {
  clearRoomTimer(room);

  room.settings.roundsPerPlayer = clampRoundCount(roundsPerPlayer);

  for (const player of room.players) {
    player.score = 0;
    player.roundsCompleted = 0;
    player.turnsAnswered = 0;
    player.fullCompletions = 0;
    player.totalAnswerTime = 0;
    player.streak = 0;
  }

  room.state.phase = "setup";
  room.state.turnNumber = 1;
  room.state.lastResult = null;

  const selector = findNextSelector(room, null);
  room.state.selectorId = selector ? selector.id : null;
  room.state.selectedLetter = null;
  room.state.opponentId = null;
  room.state.answerStartedAt = null;
  room.state.answerDeadline = null;
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload = {}, ack = () => {}) => {
    const room = createRoom(socket.id, payload.name || "Host");
    const player = getPlayerBySocket(room, socket.id);
    socket.join(room.id);
    emitRoom(room);
    ack({ ok: true, roomId: room.id, playerId: player.id });
  });

  socket.on("room:join", (payload = {}, ack = () => {}) => {
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    const room = rooms.get(roomId);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }

    if (room.state.phase !== "lobby") {
      ack({ ok: false, error: "Game already started. Create a new room." });
      return;
    }

    if (room.players.length >= MAX_PLAYERS) {
      ack({ ok: false, error: "Room is full." });
      return;
    }

    const player = createPlayer(socket.id, payload.name || "Player");
    room.players.push(player);
    socket.join(room.id);
    emitRoom(room);
    ack({ ok: true, roomId: room.id, playerId: player.id });
  });

  socket.on("lobby:setRounds", (payload = {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || room.hostSocketId !== socket.id || room.state.phase !== "lobby") {
      return;
    }
    room.settings.roundsPerPlayer = clampRoundCount(payload.roundsPerPlayer);
    emitRoom(room);
  });

  socket.on("game:start", (payload = {}, ack = () => {}) => {
    const room = rooms.get(payload.roomId);
    if (!room) {
      ack({ ok: false, error: "Room not found." });
      return;
    }

    if (room.hostSocketId !== socket.id) {
      ack({ ok: false, error: "Only host can start." });
      return;
    }

    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) {
      ack({ ok: false, error: "Game needs 2-4 players." });
      return;
    }

    startGame(room, payload.roundsPerPlayer);
    emitRoom(room);
    ack({ ok: true });
  });

  socket.on("turn:start", (payload = {}, ack = () => {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || room.state.phase !== "setup") {
      ack({ ok: false, error: "Round setup is not active." });
      return;
    }

    const selector = getPlayerBySocket(room, socket.id);
    if (!selector || selector.id !== room.state.selectorId) {
      ack({ ok: false, error: "It is not your turn to choose." });
      return;
    }

    const letter = sanitizeLetter(payload.letter);
    if (!letter) {
      ack({ ok: false, error: "Choose a valid letter A-Z." });
      return;
    }

    let opponentId = payload.opponentId;
    const opponents = eligibleOpponents(room, selector.id);

    if (room.players.length === 2) {
      opponentId = opponents[0] ? opponents[0].id : null;
    }

    const opponent = getPlayerById(room, opponentId);
    if (!opponent || !opponents.find((player) => player.id === opponent.id)) {
      ack({ ok: false, error: "Choose a valid opponent." });
      return;
    }

    room.state.phase = "answering";
    room.state.selectedLetter = letter;
    room.state.opponentId = opponent.id;
    room.state.answerStartedAt = Date.now();
    room.state.answerDeadline = room.state.answerStartedAt + ROUND_TIME_SECONDS * 1000;
    room.state.turnNumber += 1;

    clearRoomTimer(room);
    room.timeoutHandle = setTimeout(() => {
      finalizeSubmission(room, opponent.id, {}, true);
      emitRoom(room);
    }, ROUND_TIME_SECONDS * 1000 + 30);

    emitRoom(room);
    ack({ ok: true });
  });

  socket.on("turn:submit", (payload = {}, ack = () => {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || room.state.phase !== "answering") {
      ack({ ok: false, error: "No active answer turn." });
      return;
    }

    const opponent = getPlayerBySocket(room, socket.id);
    if (!opponent || opponent.id !== room.state.opponentId) {
      ack({ ok: false, error: "Only the active opponent can submit." });
      return;
    }

    finalizeSubmission(room, opponent.id, payload.answers || {}, false);
    emitRoom(room);
    ack({ ok: true });
  });

  socket.on("turn:continue", (payload = {}, ack = () => {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || room.state.phase !== "result") {
      ack({ ok: false, error: "No result screen active." });
      return;
    }

    moveToNextStep(room);
    emitRoom(room);
    ack({ ok: true });
  });

  socket.on("game:restart", (payload = {}, ack = () => {}) => {
    const room = rooms.get(payload.roomId);
    if (!room || room.hostSocketId !== socket.id) {
      ack({ ok: false, error: "Only host can restart." });
      return;
    }
    room.state.phase = "lobby";
    room.state.selectorId = null;
    room.state.selectedLetter = null;
    room.state.opponentId = null;
    room.state.answerStartedAt = null;
    room.state.answerDeadline = null;
    room.state.lastResult = null;
    room.state.turnNumber = 0;
    clearRoomTimer(room);

    for (const player of room.players) {
      player.score = 0;
      player.roundsCompleted = 0;
      player.turnsAnswered = 0;
      player.fullCompletions = 0;
      player.totalAnswerTime = 0;
      player.streak = 0;
    }

    emitRoom(room);
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = getPlayerBySocket(room, socket.id);
      if (!player) {
        continue;
      }

      if (room.state.phase === "lobby") {
        room.players = room.players.filter((candidate) => candidate.socketId !== socket.id);
      } else {
        player.connected = false;
      }

      if (room.hostSocketId === socket.id) {
        const replacement = room.players.find((candidate) => candidate.connected !== false);
        room.hostSocketId = replacement ? replacement.socketId : "";
      }

      if (room.players.length === 0) {
        clearRoomTimer(room);
        rooms.delete(room.id);
        break;
      }

      if (room.state.phase === "setup") {
        const selector = getPlayerById(room, room.state.selectorId);
        if (!selector || selector.connected === false) {
          moveToNextStep(room);
        }
      }

      if (room.state.phase === "answering") {
        const opponent = getPlayerById(room, room.state.opponentId);
        if (!opponent || opponent.connected === false) {
          finalizeSubmission(room, room.state.opponentId, {}, true);
        }
      }

      emitRoom(room);
      break;
    }
  });
});

server.listen(PORT, () => {
  console.log(`Letter Clash running on http://localhost:${PORT}`);
});
