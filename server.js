const fs = require("fs");
const path = require("path");
const vm = require("vm");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const allCities = require("all-the-cities");
const worldCountries = require("world-countries");
const countryPopulationRows = require("country-json/src/country-by-population.json");
const maleFirstNames = require("@stdlib/datasets-male-first-names-en")();
const femaleFirstNames = require("@stdlib/datasets-female-first-names-en")();
const animals = require("animals").words;
const englishWords = require("an-array-of-english-words");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROUND_TIME_SECONDS = 60;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;
const CATEGORIES = ["name", "place", "animal", "thing"];

const IRREGULAR_SINGULARS = new Map([
  ["mice", "mouse"],
  ["geese", "goose"],
  ["teeth", "tooth"],
  ["feet", "foot"],
  ["wolves", "wolf"],
  ["leaves", "leaf"],
  ["children", "child"],
  ["men", "man"],
  ["women", "woman"]
]);

const rooms = new Map();

app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

function clamp01(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeLookup(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularizeSimple(word) {
  const input = normalizeLookup(word);
  if (!input) {
    return "";
  }
  if (IRREGULAR_SINGULARS.has(input)) {
    return IRREGULAR_SINGULARS.get(input);
  }
  if (input.endsWith("ies") && input.length > 4) {
    return `${input.slice(0, -3)}y`;
  }
  if (input.endsWith("ves") && input.length > 4) {
    return `${input.slice(0, -3)}f`;
  }
  if (input.endsWith("es") && input.length > 3) {
    return input.slice(0, -2);
  }
  if (input.endsWith("s") && input.length > 2) {
    return input.slice(0, -1);
  }
  return input;
}

function startsWithLetter(text, letter) {
  if (!text || !letter) {
    return false;
  }
  const normalized = normalizeLookup(text);
  const first = normalized.match(/[a-z]/);
  return Boolean(first && first[0].toUpperCase() === letter);
}

function normalizeAnswer(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().replace(/\s+/g, " ");
}

function loadPopularWordRanks() {
  try {
    const wordsFile = path.join(__dirname, "node_modules", "popular-english-words", "words.js");
    const raw = fs.readFileSync(wordsFile, "utf8");
    const executable = raw.replace(/\nexport\s+\{words\}\s*;?\s*$/, "\nmodule.exports = words;");
    const sandbox = { module: { exports: [] } };
    vm.runInNewContext(executable, sandbox);

    const list = Array.isArray(sandbox.module.exports) ? sandbox.module.exports : [];
    const rankByWord = new Map();

    for (let idx = 0; idx < list.length; idx += 1) {
      const key = normalizeLookup(list[idx]);
      if (!key || rankByWord.has(key)) {
        continue;
      }
      rankByWord.set(key, idx);
    }

    return {
      rankByWord,
      wordCount: list.length
    };
  } catch (error) {
    console.warn("Failed to load popularity ranks:", error.message);
    return {
      rankByWord: new Map(),
      wordCount: 0
    };
  }
}

const POPULAR_WORDS = loadPopularWordRanks();

function toPopulationValue(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createPopulationBounds(populationMap) {
  let minLog = Infinity;
  let maxLog = -Infinity;

  for (const population of populationMap.values()) {
    if (!Number.isFinite(population) || population <= 0) {
      continue;
    }
    const logPop = Math.log10(population);
    minLog = Math.min(minLog, logPop);
    maxLog = Math.max(maxLog, logPop);
  }

  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog) || minLog === maxLog) {
    return { minLog: 1, maxLog: 8 };
  }

  return { minLog, maxLog };
}

function commonnessFromPopulation(population, bounds) {
  if (!Number.isFinite(population) || population <= 0) {
    return 0.25;
  }
  const logPop = Math.log10(population);
  return clamp01((logPop - bounds.minLog) / (bounds.maxLog - bounds.minLog));
}

function commonnessFromWord(term) {
  const normalized = normalizeLookup(term);
  if (!normalized || POPULAR_WORDS.wordCount === 0) {
    return null;
  }

  const candidates = new Set([normalized]);
  const singular = singularizeSimple(normalized);
  if (singular) {
    candidates.add(singular);
  }

  const tokenized = normalized.split(/[\s-]+/).filter(Boolean);
  for (const token of tokenized) {
    candidates.add(token);
    const singularToken = singularizeSimple(token);
    if (singularToken) {
      candidates.add(singularToken);
    }
  }

  let bestRank = Infinity;
  for (const candidate of candidates) {
    const rank = POPULAR_WORDS.rankByWord.get(candidate);
    if (Number.isFinite(rank) && rank < bestRank) {
      bestRank = rank;
    }
  }

  if (!Number.isFinite(bestRank)) {
    return null;
  }

  return clamp01(1 - bestRank / Math.max(1, POPULAR_WORDS.wordCount - 1));
}

function scoreFromCommonness(commonness) {
  const value = clamp01(commonness);
  const points = Math.round(8 + (1 - value) * 15);

  let difficultyLabel = "Uncommon";
  if (value >= 0.82) {
    difficultyLabel = "Very Common";
  } else if (value >= 0.62) {
    difficultyLabel = "Common";
  } else if (value >= 0.4) {
    difficultyLabel = "Uncommon";
  } else if (value >= 0.22) {
    difficultyLabel = "Rare";
  } else {
    difficultyLabel = "Very Rare";
  }

  return {
    points,
    difficultyLabel,
    commonness: Number(value.toFixed(3))
  };
}

const NAME_SET = new Set(
  [...maleFirstNames, ...femaleFirstNames]
    .map((name) => normalizeLookup(name))
    .filter(Boolean)
);

const ANIMAL_SET = new Set(
  animals
    .flatMap((animal) => {
      const normalized = normalizeLookup(animal);
      const singular = singularizeSimple(animal);
      return [normalized, singular].filter(Boolean);
    })
    .filter(Boolean)
);

const THING_WORD_SET = new Set(
  englishWords
    .map((word) => normalizeLookup(word))
    .filter(Boolean)
);

const CITY_POPULATION_BY_NAME = new Map();
for (const city of allCities) {
  const population = toPopulationValue(city.population, 1000);
  const variants = [city.name, city.altName].filter(Boolean);

  for (const variant of variants) {
    const key = normalizeLookup(variant);
    if (!key) {
      continue;
    }
    const current = CITY_POPULATION_BY_NAME.get(key) || 0;
    if (population > current) {
      CITY_POPULATION_BY_NAME.set(key, population);
    }
  }
}

const COUNTRY_POPULATION_BY_NAME = new Map();
for (const row of countryPopulationRows) {
  const key = normalizeLookup(row.country);
  if (!key) {
    continue;
  }
  COUNTRY_POPULATION_BY_NAME.set(key, toPopulationValue(row.population, 100000));
}

for (const country of worldCountries) {
  const variants = new Set();
  if (country.name && country.name.common) {
    variants.add(country.name.common);
  }
  if (country.name && country.name.official) {
    variants.add(country.name.official);
  }
  if (Array.isArray(country.altSpellings)) {
    country.altSpellings.forEach((value) => variants.add(value));
  }

  let knownPopulation = 0;
  if (country.name && country.name.common) {
    knownPopulation = COUNTRY_POPULATION_BY_NAME.get(normalizeLookup(country.name.common)) || 0;
  }
  if (!knownPopulation && country.name && country.name.official) {
    knownPopulation = COUNTRY_POPULATION_BY_NAME.get(normalizeLookup(country.name.official)) || 0;
  }
  if (!knownPopulation) {
    knownPopulation = 1000000;
  }

  for (const variant of variants) {
    const key = normalizeLookup(variant);
    if (!key) {
      continue;
    }
    if (!COUNTRY_POPULATION_BY_NAME.has(key)) {
      COUNTRY_POPULATION_BY_NAME.set(key, knownPopulation);
    }
  }
}

const CITY_POP_BOUNDS = createPopulationBounds(CITY_POPULATION_BY_NAME);
const COUNTRY_POP_BOUNDS = createPopulationBounds(COUNTRY_POPULATION_BY_NAME);

function validateNameAnswer(answer) {
  const normalized = normalizeLookup(answer);
  const firstToken = normalized.split(/[\s'-]+/).filter(Boolean)[0] || "";

  if (!firstToken || !NAME_SET.has(firstToken)) {
    return {
      valid: false,
      reason: "Not recognized as a common first name."
    };
  }

  const commonness = commonnessFromWord(firstToken);
  return {
    valid: true,
    commonness: commonness === null ? 0.55 : commonness
  };
}

function validatePlaceAnswer(answer) {
  const normalized = normalizeLookup(answer);
  if (!normalized) {
    return {
      valid: false,
      reason: "No place provided."
    };
  }

  const candidates = new Set([
    normalized,
    normalized.replace(/\bcity\b/g, "").replace(/\s+/g, " ").trim()
  ]);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const countryPopulation = COUNTRY_POPULATION_BY_NAME.get(candidate);
    if (countryPopulation) {
      return {
        valid: true,
        commonness: commonnessFromPopulation(countryPopulation, COUNTRY_POP_BOUNDS),
        detectedAs: "country"
      };
    }

    const cityPopulation = CITY_POPULATION_BY_NAME.get(candidate);
    if (cityPopulation) {
      return {
        valid: true,
        commonness: commonnessFromPopulation(cityPopulation, CITY_POP_BOUNDS),
        detectedAs: "city"
      };
    }
  }

  return {
    valid: false,
    reason: "Place not found in city/country data."
  };
}

function validateAnimalAnswer(answer) {
  const normalized = normalizeLookup(answer);
  if (!normalized) {
    return {
      valid: false,
      reason: "No animal provided."
    };
  }

  const tokens = normalized.split(/[\s-]+/).filter(Boolean);
  const lastToken = tokens[tokens.length - 1] || "";
  const candidates = new Set([
    normalized,
    singularizeSimple(normalized),
    lastToken,
    singularizeSimple(lastToken)
  ]);

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (ANIMAL_SET.has(candidate)) {
      const commonness = commonnessFromWord(candidate);
      return {
        valid: true,
        commonness: commonness === null ? 0.35 : commonness
      };
    }
  }

  return {
    valid: false,
    reason: "Not recognized in the animal list."
  };
}

function isThingWord(token) {
  if (!token) {
    return false;
  }
  if (THING_WORD_SET.has(token)) {
    return true;
  }
  const singular = singularizeSimple(token);
  return Boolean(singular && THING_WORD_SET.has(singular));
}

function validateThingAnswer(answer) {
  const normalized = normalizeLookup(answer);
  if (!normalized) {
    return {
      valid: false,
      reason: "No thing provided."
    };
  }

  if (CITY_POPULATION_BY_NAME.has(normalized) || COUNTRY_POPULATION_BY_NAME.has(normalized)) {
    return {
      valid: false,
      reason: "That is a place, not a random thing."
    };
  }

  const tokens = normalized.split(/[\s-]+/).filter(Boolean);
  if (tokens.length === 0 || !tokens.every((token) => isThingWord(token))) {
    return {
      valid: false,
      reason: "Not recognized as an English thing/object word."
    };
  }

  if (tokens.length === 1) {
    const single = tokens[0];
    if (ANIMAL_SET.has(single) || NAME_SET.has(single)) {
      return {
        valid: false,
        reason: "Looks like an animal or name, not a thing."
      };
    }
  }

  const commonness = commonnessFromWord(normalized);
  return {
    valid: true,
    commonness: commonness === null ? 0.45 : commonness
  };
}

function evaluateCategory(category, answer, letter) {
  const cleaned = normalizeAnswer(answer);

  if (!cleaned) {
    return {
      answer: "",
      valid: false,
      reason: "Blank answer.",
      points: 0,
      difficultyLabel: null,
      commonness: null,
      detectedAs: null
    };
  }

  if (!startsWithLetter(cleaned, letter)) {
    return {
      answer: cleaned,
      valid: false,
      reason: `Must start with ${letter}.`,
      points: 0,
      difficultyLabel: null,
      commonness: null,
      detectedAs: null
    };
  }

  let verdict = {
    valid: false,
    reason: "Invalid answer."
  };

  if (category === "name") {
    verdict = validateNameAnswer(cleaned);
  } else if (category === "place") {
    verdict = validatePlaceAnswer(cleaned);
  } else if (category === "animal") {
    verdict = validateAnimalAnswer(cleaned);
  } else if (category === "thing") {
    verdict = validateThingAnswer(cleaned);
  }

  if (!verdict.valid) {
    return {
      answer: cleaned,
      valid: false,
      reason: verdict.reason || "Invalid answer.",
      points: 0,
      difficultyLabel: null,
      commonness: null,
      detectedAs: verdict.detectedAs || null
    };
  }

  const score = scoreFromCommonness(verdict.commonness);
  return {
    answer: cleaned,
    valid: true,
    reason: null,
    points: score.points,
    difficultyLabel: score.difficultyLabel,
    commonness: score.commonness,
    detectedAs: verdict.detectedAs || null
  };
}

function evaluateTurn(letter, answers, elapsedSeconds, streakBefore) {
  const categoryDetails = {};
  const normalizedAnswers = {};
  const validity = {};

  let validCount = 0;
  let categoryPoints = 0;

  for (const category of CATEGORIES) {
    const detail = evaluateCategory(category, answers[category], letter);
    categoryDetails[category] = detail;
    normalizedAnswers[category] = detail.answer;
    validity[category] = detail.valid;

    if (detail.valid) {
      validCount += 1;
      categoryPoints += detail.points;
    }
  }

  const participation = 8;
  const speedBonus = Math.max(0, Math.round((ROUND_TIME_SECONDS - elapsedSeconds) * 0.5));
  const completionBonus = validCount === CATEGORIES.length ? 15 : 0;
  const streakBonus =
    validCount === CATEGORIES.length && streakBefore > 0 ? Math.min(20, streakBefore * 4) : 0;

  const total = participation + categoryPoints + speedBonus + completionBonus + streakBonus;

  return {
    normalizedAnswers,
    validity,
    categoryDetails,
    elapsedSeconds,
    validCount,
    participation,
    categoryPoints,
    speedBonus,
    completionBonus,
    streakBonus,
    total,
    fullClear: validCount === CATEGORIES.length
  };
}

app.post("/api/evaluate-turn", (req, res) => {
  try {
    const letter = sanitizeLetter(req.body.letter);
    if (!letter) {
      res.status(400).json({ ok: false, error: "Invalid letter." });
      return;
    }

    const answers = req.body.answers && typeof req.body.answers === "object" ? req.body.answers : {};
    const elapsedSeconds = Math.max(
      0,
      Math.min(ROUND_TIME_SECONDS, Number(req.body.elapsedSeconds) || 0)
    );
    const streakBefore = Math.max(0, Math.floor(Number(req.body.streakBefore) || 0));

    const evaluation = evaluateTurn(letter, answers, elapsedSeconds, streakBefore);
    res.json({ ok: true, evaluation });
  } catch (error) {
    console.error("Evaluation endpoint failed:", error);
    res.status(500).json({ ok: false, error: "Failed to evaluate turn." });
  }
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

  const evaluation = evaluateTurn(room.state.selectedLetter, rawAnswers, elapsedSeconds, opponent.streak);

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
    categoryDetails: evaluation.categoryDetails,
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
