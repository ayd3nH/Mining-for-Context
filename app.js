// Mining for Context — room and lobby prototype.
// The publishable key is safe for browser use. Never add a service-role key here.
const SUPABASE_URL = "https://wrebybmavlzrhkxabbal.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Ie43kUAqX4O4BQzDR13dKw_ve7p27Wl";

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const homeView = document.querySelector("#homeView");
const lobbyView = document.querySelector("#lobbyView");
const usernameInput = document.querySelector("#username");
const roomCodeInput = document.querySelector("#roomCode");
const createBtn = document.querySelector("#createBtn");
const joinBtn = document.querySelector("#joinBtn");
const resetSessionBtn = document.querySelector("#resetSessionBtn");
const homeMessage = document.querySelector("#homeMessage");
const playerMessage = document.querySelector("#playerMessage");
const roomCodeDisplay = document.querySelector("#roomCodeDisplay");
const playerList = document.querySelector("#playerList");
const playerCount = document.querySelector("#playerCount");
const lobbyStatus = document.querySelector("#lobbyStatus");
const scanTitle = document.querySelector("#scanTitle");
const scanPercent = document.querySelector("#scanPercent");
const scanProgress = document.querySelector("#scanProgress");
const scanCounts = document.querySelector("#scanCounts");
const scanDetail = document.querySelector("#scanDetail");
const startBtn = document.querySelector("#startBtn");
const startMessage = document.querySelector("#startMessage");
const hostSettings = document.querySelector("#hostSettings");
const roundsSetting = document.querySelector("#roundsSetting");
const modeSetting = document.querySelector("#modeSetting");
const pickTimeSetting = document.querySelector("#pickTimeSetting");
const voteTimeSetting = document.querySelector("#voteTimeSetting");
const gameView = document.querySelector("#gameView");
const gameRoundLabel = document.querySelector("#gameRoundLabel");
const gameTimer = document.querySelector("#gameTimer");
const gameTitle = document.querySelector("#gameTitle");
const gameInstructions = document.querySelector("#gameInstructions");
const gameContent = document.querySelector("#gameContent");
const gameMessage = document.querySelector("#gameMessage");
const gameActionBtn = document.querySelector("#gameActionBtn");
const gameNextBtn = document.querySelector("#gameNextBtn");
const gameLeaveBtn = document.querySelector("#gameLeaveBtn");
const startNewGameBtn = document.querySelector("#startNewGameBtn");
const scoreboard = document.querySelector("#scoreboard");
const hostView = document.querySelector("#hostView");
const hostDisplayBtn = document.querySelector("#openHostDisplayBtn");
let hostPollHandle = null;
let hostDisplayMode = false;
let hostLastSignature = "";

let currentRoomId = null;
let currentPlayerId = null;
let currentRoomCode = null;
let pollHandle = null;
let busy = false;
let currentRoom = null;
let currentPlayers = [];
let gamePollHandle = null;
let gameState = null;
let renderedGameSignature = "";
let selectedMessages = ["", ""] ;
let activeImageIndex = null;
let votedSubmission = null;

function setHomeMessage(message = "") {
  homeMessage.textContent = message;
}
function setPlayerMessage(message = "") {
  playerMessage.textContent = message;
}
function setBusy(value) {
  busy = value;
  createBtn.disabled = value;
  joinBtn.disabled = value;
  createBtn.textContent = value ? "Please wait…" : "Create a room";
  joinBtn.textContent = value ? "…" : "Join";
}
function friendlyError(error) {
  const raw = error?.message || "Something went wrong. Please try again.";
  if (/anonymous/i.test(raw) || /signup is disabled/i.test(raw)) {
    return "Anonymous sign-in is not enabled yet. In Supabase, enable Anonymous Sign-Ins under Authentication.";
  }
  if (/row-level security|permission denied/i.test(raw)) {
    return "Supabase blocked this request. Check that you ran the database SQL and enabled anonymous sign-ins.";
  }
  if (/already in a room/i.test(raw)) {
    return 'Your account is still listed in a room. Click “Clear stuck room session” below, then try again.';
  }
  if (/game has already started|game already started|no longer in the lobby/i.test(raw)) {
    return "That room's game has already started. Ask the host to start a new game or join a lobby that has not started.";
  }
  return raw;
}
async function ensureAnonymousSession() {
  const { data: { session }, error: sessionError } = await db.auth.getSession();
  if (sessionError) throw sessionError;
  if (session) return session;
  const { data, error } = await db.auth.signInAnonymously();
  if (error) throw error;
  return data.session;
}
function validUsername() {
  const name = usernameInput.value.trim();
  if (!name) throw new Error("Enter a username first.");
  if (name.length > 24) throw new Error("Your username must be 24 characters or fewer.");
  return name;
}
async function createRoom() {
  if (busy) return;
  setHomeMessage("");
  setBusy(true);
  try {
    const name = validUsername();
    const session = await ensureAnonymousSession();

    // Remove any stale memberships for this authenticated browser before asking
    // Supabase to create a brand-new lobby. The recovery RPC deletes only this
    // user's memberships; it does not delete rooms or game content.
    const { error: cleanupError } = await db.rpc("mfc_leave_all_rooms");
    if (cleanupError) {
      throw new Error(`Could not clear an old room membership before creating a new room: ${friendlyError(cleanupError)}. Run the latest upgrade_content_on_demand.sql migration, then use “Clear stuck room session”.`);
    }
    ["mfc_room_id", "mfc_room_code", "mfc_player_id", "mfc_username"].forEach(k => {
      sessionStorage.removeItem(k);
      localStorage.removeItem(k);
    });

    const { data, error } = await db.rpc("create_game_room", { player_name: name });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result || !result.room_id || !result.room_code) {
      throw new Error("Supabase did not return a valid new room. Check the create_game_room function and its returned columns.");
    }
    enterRoom(result.room_id, result.room_code, result.player_id, session.user.id, name);
  } catch (error) {
    setHomeMessage(friendlyError(error));
  } finally {
    setBusy(false);
  }
}
async function joinRoom() {
  if (busy) return;
  setHomeMessage("");
  setBusy(true);
  try {
    const name = validUsername();
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!/^[A-F0-9]{6}$/.test(code)) throw new Error("Enter the six-character room code.");
    const session = await ensureAnonymousSession();
    const { data, error } = await db.rpc("join_game_room", {
      requested_code: code,
      player_name: name
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error("Could not join the room.");
    enterRoom(result.room_id, result.room_code, result.player_id, session.user.id, name);
  } catch (error) {
    setHomeMessage(friendlyError(error));
  } finally {
    setBusy(false);
  }
}
function enterRoom(roomId, code, playerId, userId, name) {
  currentRoomId = roomId;
  currentRoomCode = code;
  currentPlayerId = playerId || userId;
  sessionStorage.setItem("mfc_room_id", roomId);
  sessionStorage.setItem("mfc_room_code", code);
  sessionStorage.setItem("mfc_player_id", currentPlayerId);
  sessionStorage.setItem("mfc_username", name);
  roomCodeDisplay.textContent = code;
  homeView.classList.add("hidden");
  lobbyView.classList.remove("hidden");
  setPlayerMessage("");
  refreshLobby();
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = setInterval(refreshLobby, 2500);
}
async function refreshLobby() {
  if (!currentRoomId) return;
  const { data: room, error: roomError } = await db
    .from("game_rooms")
    .select("id, code, status, host_player_id, scan_status, scan_images, scan_messages, scan_error")
    .eq("id", currentRoomId)
    .maybeSingle();
  if (roomError) {
    setPlayerMessage("Could not refresh the room. Check your connection.");
    return;
  }
  if (!room) {
    setPlayerMessage("This room no longer exists.");
    return;
  }
  const { data: players, error: playersError } = await db
    .from("game_players")
    .select("id, username, is_host, joined_at")
    .eq("room_id", currentRoomId)
    .order("joined_at", { ascending: true });
  if (playersError) {
    setPlayerMessage("Could not load players. Check the Supabase policies.");
    return;
  }
  setPlayerMessage("");
  currentRoom = room;
  currentPlayers = players;
  updateScanDisplay(room, players);
  playerCount.textContent = String(players.length);
  if (room.status === "playing" || room.status === "finished") {
    homeView.classList.add("hidden");
    lobbyView.classList.add("hidden");
    gameView.classList.remove("hidden");
    hostSettings.classList.add("hidden");
    startBtn.classList.add("hidden");
    if (!gamePollHandle) {
      loadGameState();
      gamePollHandle = setInterval(loadGameState, 1500);
    }
  }
  lobbyStatus.textContent = room.status === "lobby" ? "Waiting for players" :
    room.status === "playing" ? "Game in progress" : "Game finished";
  playerList.replaceChildren();
  players.forEach((player) => {
    const li = document.createElement("li");
    const left = document.createElement("span");
    left.className = "player-name";
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = player.username.trim().charAt(0).toUpperCase();
    const username = document.createElement("span");
    username.textContent = player.username;
    left.append(avatar, username);
    li.append(left);
    if (player.is_host || player.id === room.host_player_id) {
      const tag = document.createElement("span");
      tag.className = "host-tag";
      tag.textContent = "HOST";
      li.append(tag);
    }
    playerList.append(li);
  });
}

function updateScanDisplay(room, players) {
  const images = Math.max(0, Number(room.scan_images) || 0);
  const messages = Math.max(0, Number(room.scan_messages) || 0);
  const imageProgress = Math.min(images / 50, 1);
  const messageProgress = Math.min(messages / 200, 1);
  const percent = Math.round(((imageProgress + messageProgress) / 2) * 100);
  const isHost = players.some((p) => (p.is_host || p.id === room.host_player_id) && p.id === currentPlayerId);
  if (hostDisplayBtn) hostDisplayBtn.classList.toggle("hidden", !isHost);
  scanProgress.style.width = "0%";
  scanPercent.textContent = "On demand";
  scanCounts.textContent = "Images and messages are gathered only after Start game is clicked.";
  scanTitle.textContent = "Content gathered when the game starts";
  scanDetail.textContent = "If more content is needed, Soggybot will collect it and the game will start automatically when ready.";
  startBtn.disabled = !(isHost && room.status === "lobby");
  startBtn.textContent = isHost ? "Start game" : "Waiting for host";
  if (room.status === "playing") {
    scanTitle.textContent = "Room started";
    scanDetail.textContent = "The game is running. Use the separate spectator Host Mode display for the shared big-screen view.";
    startBtn.disabled = true;
  }
}

async function startGame() {
  if (!currentRoom || startBtn.disabled) return;
  startBtn.disabled = true;
  const settings = {
    target_room: currentRoomId,
    rounds_total: Number(roundsSetting.value),
    selection_seconds: Number(pickTimeSetting.value),
    voting_seconds: Number(voteTimeSetting.value),
    game_mode: modeSetting.value
  };
  let requestPoll = null;
  try {
    startMessage.textContent = "Checking the content library for this game…";
    const { data: request, error: requestError } = await db.rpc("mfc_request_content_for_game", settings);
    if (requestError) throw requestError;
    if (!request?.request_id) throw new Error("Supabase did not return a content request ID. Run upgrade_content_on_demand.sql first.");
    if (request.status !== "ready") {
      startMessage.textContent = "The library is short. Gathering additional content from Discord… Keep Soggybot online; this may take a while.";
      requestPoll = setInterval(async () => {
        try {
          const { data, error } = await db.from("mfc_content_requests")
            .select("status,error").eq("id", request.request_id).single();
          if (error) throw error;
          if (data.status === "ready") {
            clearInterval(requestPoll);
            requestPoll = null;
            await launchRequestedGame(settings);
          } else if (data.status === "failed") {
            clearInterval(requestPoll);
            requestPoll = null;
            startMessage.textContent = data.error || "Soggybot could not find enough eligible Discord content.";
            startBtn.disabled = false;
          } else {
            startMessage.textContent = data.status === "scanning"
              ? "The library is short. Soggybot is scanning accessible Discord history for the missing content."
              : "The library is short. Waiting for Soggybot to gather the missing content.";
          }
        } catch (pollError) {
          if (requestPoll) clearInterval(requestPoll);
          requestPoll = null;
          startMessage.textContent = friendlyError(pollError);
          startBtn.disabled = false;
        }
      }, 2500);
      return;
    }
    await launchRequestedGame(settings);
  } catch (error) {
    if (requestPoll) clearInterval(requestPoll);
    startMessage.textContent = friendlyError(error);
    startBtn.disabled = false;
  }
}

async function launchRequestedGame(settings) {
  try {
    startMessage.textContent = "Content is ready. Starting game…";
    const { error } = await db.rpc("mfc_start_game", settings);
    if (error) throw error;
    startMessage.textContent = "Game started.";
    await refreshLobby();
  } catch (error) {
    startMessage.textContent = friendlyError(error);
    startBtn.disabled = false;
  }
}

async function loadGameState() {
  if (!currentRoomId || gameView.classList.contains("hidden")) return;
  const { data, error } = await db.rpc("mfc_get_game_state", { target_room: currentRoomId });
  if (error) {
    gameMessage.textContent = friendlyError(error);
    return;
  }
  gameState = data;
  const round = data.round || {};
  const matchup = data.current_matchup || {};
  const elapsed = matchup.reveal_started_at ? Math.max(0, (Date.now() - new Date(matchup.reveal_started_at).getTime()) / 1000) : 0;
  const revealStep = matchup.status === "revealing" ? Math.min(3, Math.floor(elapsed / 5)) : 4;
  const signature = JSON.stringify({status:data.status, phase:round.phase, id:round.id, submitted:data.my_submitted,
    submissions:(data.submissions||[]).map(s=>[s.id,s.votes]), my_vote:data.my_vote, scores:data.scores,
    matchup:matchup.id, matchupStatus:matchup.status, revealStep, votesCast:matchup.votes_cast});
  if (signature !== renderedGameSignature) {
    renderedGameSignature = signature;
    renderGameState(data);
  }
  const deadline = round.phase === "selecting" ? round.selection_deadline : (round.phase === "voting" && matchup.status === "voting") ? matchup.voting_deadline : null;
  if (deadline) {
    const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000));
    gameTimer.textContent = `00:${String(seconds).padStart(2,"0")}`;
  } else gameTimer.textContent = "";
}

function renderGameState(state) {
  const round = state.round || {};
  const phase = round.phase || "waiting";
  gameRoundLabel.textContent = state.status === "finished" ? "GAME COMPLETE" : `ROUND ${round.number || 1} OF ${state.rounds_total || 5}`;
  gameMessage.textContent = "";
  gameNextBtn.classList.add("hidden");
  gameActionBtn.classList.remove("hidden");
  gameContent.replaceChildren();
  scoreboard.replaceChildren();
  renderScoreboard(state.scores || []);

  if (state.status === "finished" || phase === "finished") {
    gameTitle.textContent = "Final results.";
    gameInstructions.textContent = "The game is over. Here's how everyone finished.";
    gameActionBtn.classList.add("hidden");
    gameNextBtn.classList.add("hidden");
    if (state.is_host) startNewGameBtn.classList.remove("hidden");
    return;
  }
  startNewGameBtn.classList.add("hidden");
  if (phase === "selecting") {
    gameTitle.textContent = state.my_submitted ? "Combos submitted." : "Make two combos.";
    gameInstructions.textContent = state.my_submitted ? "Your pairs are locked in. Voting starts when everyone has submitted or when the timer runs out." : "";
    if (!state.my_submitted) renderHand(state.hand || {});
    else {
      const wait = document.createElement("div"); wait.className="hand-card"; wait.textContent="Your choices are locked in. Waiting for the timer…"; gameContent.append(wait);
      gameActionBtn.classList.add("hidden");
    }
    gameActionBtn.textContent = "Submit pairs";
    gameActionBtn.disabled = !!state.my_submitted;
    return;
  }
  if (phase === "voting") {
    const matchup = state.current_matchup;
    gameTitle.textContent = matchup?.status === "voting" ? "Which entry wins?" : "The showdown is unfolding…";
    gameInstructions.textContent = "Two entries face off. Each eligible player votes once; you cannot vote if either entry is yours.";
    renderHeadToHead(state);
    gameActionBtn.classList.add("hidden");
    return;
  }
  if (phase === "results") {
    gameTitle.textContent = "Round results.";
    gameInstructions.textContent = "Each vote earns the entry's owner 2 points. Every voter earns 1 point, and a unanimous matchup earns the winning entry an extra point.";
    renderSubmissions(state, false);
    gameActionBtn.classList.add("hidden");
    if (state.is_host) {
      gameNextBtn.textContent = round.number >= state.rounds_total ? "Show final results" : "Start next round";
      gameNextBtn.classList.remove("hidden");
    }
    return;
  }
  gameTitle.textContent = "Getting the round ready…";
  gameInstructions.textContent = "Waiting for game data.";
  gameActionBtn.classList.add("hidden");
}

function renderHand(hand) {
  // Always replace the existing editor. Never append a second copy after a drag.
  gameContent.replaceChildren();
  const images = (hand.images || []).slice(0, 2);
  const messages = hand.messages || [];
  const wrap = document.createElement("div");
  wrap.className = "pairing-board pairing-board-stacked";

  const imageGrid = document.createElement("div");
  imageGrid.className = "pairing-image-grid";
  images.forEach((img, index) => {
    const card = document.createElement("article");
    card.className = "pairing-image-card";
    const heading = document.createElement("h3"); heading.textContent = `Image ${index + 1}`;
    const image = document.createElement("img"); image.src = img.url; image.alt = `Image ${index + 1}`; image.loading = "lazy";
    const slot = document.createElement("div");
    slot.className = "pair-drop-slot" + (selectedMessages[index] ? " filled" : "");
    slot.dataset.imageIndex = String(index);
    const chosen = messages.find(m => m.id === selectedMessages[index]);
    slot.textContent = chosen ? `“${String(chosen.text).replace(/^[“"']|[”"']$/g, "").trim()}”` : "Drop a message here";
    slot.addEventListener("dragover", e => { e.preventDefault(); slot.classList.add("drag-over"); });
    slot.addEventListener("dragleave", () => slot.classList.remove("drag-over"));
    slot.addEventListener("drop", e => {
      e.preventDefault(); slot.classList.remove("drag-over");
      const payload = e.dataTransfer.getData("text/plain");
      if (payload.startsWith("slot:")) {
        const from = Number(payload.slice(5));
        if (Number.isInteger(from) && from >= 0 && from < 2) {
          const moving = selectedMessages[from];
          selectedMessages[from] = selectedMessages[index];
          selectedMessages[index] = moving;
          gameMessage.textContent = ""; renderHand(hand);
        }
      } else if (payload) assignMessage(index, payload, hand);
    });
    // Drag a selected message out of its slot and drop it back into the message list to unassign it.
    if (chosen) {
      slot.draggable = true;
      slot.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", `slot:${index}`); e.dataTransfer.effectAllowed = "move"; });
    }
    slot.addEventListener("click", () => {
      if (selectedMessages[index]) { selectedMessages[index] = ""; gameMessage.textContent = ""; renderHand(hand); }
    });
    card.append(heading, image, slot);
    imageGrid.append(card);
  });

  const messageSection = document.createElement("section");
  messageSection.className = "pairing-messages pairing-messages-below";
  const heading = document.createElement("h3"); heading.textContent = "Your five messages";
  const hint = document.createElement("p"); hint.className = "field-note"; hint.textContent = "Drag a message into a slot below an image. Used messages disappear; drag a filled slot back here to return its message.";
  const list = document.createElement("div"); list.className = "message-list clean-message-list";
  list.addEventListener("dragover", e => { if (e.dataTransfer.types.includes("text/plain")) e.preventDefault(); list.classList.add("drag-over"); });
  list.addEventListener("dragleave", () => list.classList.remove("drag-over"));
  list.addEventListener("drop", e => {
    e.preventDefault(); list.classList.remove("drag-over");
    const payload = e.dataTransfer.getData("text/plain");
    if (payload.startsWith("slot:")) {
      const index = Number(payload.slice(5));
      if (Number.isInteger(index) && index >= 0 && index < 2) { selectedMessages[index] = ""; gameMessage.textContent = ""; renderHand(hand); }
    }
  });
  messages.forEach((msg, i) => {
    if (selectedMessages.includes(msg.id)) return;
    const item = document.createElement("div"); item.className = "message-option clean-message"; item.draggable = true;
    const text = document.createElement("span"); text.textContent = `“${String(msg.text).replace(/^[“"']|[”"']$/g, "").trim()}”`;
    const hint = document.createElement("span"); hint.className = "message-drag-hint"; hint.textContent = "Drag";
    item.append(text, hint);
    item.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", String(msg.id)); e.dataTransfer.effectAllowed = "move"; });
    item.addEventListener("click", () => {
      const empty = selectedMessages.findIndex(x => !x);
      if (empty < 0) { gameMessage.textContent = "Both slots are full. Drag a filled slot back here first."; return; }
      assignMessage(empty, msg.id, hand);
    });
    list.append(item);
  });
  messageSection.append(heading, hint, list);
  wrap.append(imageGrid, messageSection);
  gameContent.append(wrap);
}
function assignMessage(imageIndex, messageId, hand) {
  const otherIndex = imageIndex === 0 ? 1 : 0;
  if (selectedMessages[otherIndex] === messageId) {
    selectedMessages[otherIndex] = "";
  }
  selectedMessages[imageIndex] = messageId;
  activeImageIndex = null;
  gameMessage.textContent = "";
  renderHand(hand);
}

function renderHeadToHead(state) {
  const m = state.current_matchup;
  if (!m) {
    const wait = document.createElement("div"); wait.className = "hand-card";
    wait.textContent = "Preparing fair head-to-head matchups…"; gameContent.append(wait); return;
  }
  const elapsed = m.reveal_started_at ? Math.max(0, (Date.now() - new Date(m.reveal_started_at).getTime()) / 1000) : 0;
  const step = m.status === "voting" ? 4 : Math.min(3, Math.floor(elapsed / 5));
  const grid = document.createElement("div"); grid.className = "head-to-head-grid";
  [m.a, m.b].forEach((entry, index) => {
    const side = index === 0 ? "A" : "B";
    const msgVisible = index === 0 ? step >= 0 : step >= 2;
    const imageVisible = index === 0 ? step >= 1 : step >= 3;
    const card = document.createElement("article"); card.className = "submission-card head-to-head-card";
    const label = document.createElement("span"); label.className = "eyebrow"; label.textContent = `ENTRY ${side}`; card.append(label);
    if (msgVisible) {
      const msg = document.createElement("p"); msg.className = "reveal-in head-to-head-message";
      msg.textContent = `“${String(entry.message_text || "").replace(/^[“"']|[”"']$/g, "").trim()}”`; card.append(msg);
    } else { const waiting = document.createElement("div"); waiting.className = "reveal-placeholder"; waiting.textContent = "Message incoming…"; card.append(waiting); }
    if (imageVisible) {
      const img = document.createElement("img"); img.className = "reveal-in"; img.src = entry.image_url; img.alt = `Entry ${side} image`; card.append(img);
    } else { const waiting = document.createElement("div"); waiting.className = "reveal-placeholder image-placeholder"; waiting.textContent = "Image reveal next"; card.append(waiting); }
    if (m.status === "voting") {
      const ownEntry = entry.player_id === currentPlayerId;
      const alreadyVoted = !!m.my_vote;
      const btn = document.createElement("button"); btn.className = "button button-primary";
      btn.textContent = m.my_vote === entry.id ? `Your vote: ${side}` : `Vote for ${side}`;
      btn.disabled = ownEntry || alreadyVoted;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        const { error } = await db.rpc("mfc_vote_matchup", { target_room: currentRoomId, target_matchup: m.id, target_submission: entry.id });
        if (error) { gameMessage.textContent = friendlyError(error); btn.disabled = false; }
        else { gameMessage.textContent = "Vote recorded. You earn 1 point for voting."; renderedGameSignature = ""; await loadGameState(); }
      });
      card.append(btn);
      if (ownEntry) { const note=document.createElement("span"); note.className="submission-author"; note.textContent="Your entry — you cannot vote in this matchup."; card.append(note); }
    } else {
      const note=document.createElement("span"); note.className="submission-author";
      note.textContent = m.status === "revealing" ? `Revealing in sequence · ${Math.max(0, 20-Math.floor(elapsed))}s until voting` : `${entry.votes || 0} votes`;
      card.append(note);
    }
    grid.append(card);
  });
  gameContent.append(grid);
  const progress=document.createElement("p"); progress.className="field-note";
  progress.textContent = m.status === "voting" ? `Matchup ${m.number} of ${state.matchups_total || "?"} · ${m.votes_cast || 0}/${m.eligible_voters || 0} eligible votes received` : `Matchup ${m.number} of ${state.matchups_total || "?"} · entries reveal one at a time`;
  gameContent.append(progress);
}

function renderSubmissions(state, voting) {
  const submissions = state.submissions || [];
  const grid = document.createElement("div"); grid.className="submission-grid";
  submissions.forEach((sub, i) => {
    const card=document.createElement("article"); card.className="submission-card";
    const label=document.createElement("span"); label.className="eyebrow"; label.textContent=`ENTRY ${i+1}`;
    const img=document.createElement("img"); img.src=sub.image_url; img.alt="Submitted image"; img.loading="lazy";
    const msg=document.createElement("p"); msg.textContent=`“${String(sub.message_text||"").replace(/^[“"']|[”"']$/g,"").trim()}”`;
    const meta=document.createElement("span"); meta.className="submission-author"; meta.textContent=`${sub.username || "Player"} · ${sub.votes || 0} votes`;
    card.append(label,img,msg,meta); grid.append(card);
  });
  gameContent.append(grid);
}

function renderScoreboard(scores) {
  if (!scores.length) return;
  const heading=document.createElement("h2"); heading.textContent="Leaderboard"; scoreboard.append(heading);
  scores.forEach((player,index)=>{ const row=document.createElement("div"); row.className="score-row"; const name=document.createElement("span"); name.textContent=`${index+1}. ${player.username}`; if(index===0 && Number(player.points)>0) name.className="winner-label"; const pts=document.createElement("strong"); pts.textContent=`${player.points} pts`; row.append(name,pts); scoreboard.append(row); });
}

async function nextRound() {
  gameNextBtn.disabled=true;
  const {error}=await db.rpc("mfc_next_round",{target_room:currentRoomId});
  if(error) gameMessage.textContent=friendlyError(error);
  renderedGameSignature="";
  gameNextBtn.disabled=false;
  await loadGameState();
}

async function leaveRoom() {
  if (!currentRoomId) return;
  const buttons = [gameLeaveBtn, document.querySelector("#leaveBtn")].filter(Boolean);
  buttons.forEach(b => b.disabled = true);
  try {
    const { error } = await db.rpc("mfc_leave_room", { target_room: currentRoomId });
    if (error) throw error;
    if (pollHandle) clearInterval(pollHandle);
    if (gamePollHandle) clearInterval(gamePollHandle);
    pollHandle = null; gamePollHandle = null; gameState = null; currentRoom = null; currentPlayers = [];
    renderedGameSignature = ""; selectedMessages = ["", ""]; activeImageIndex = null;
    currentRoomId = null; currentPlayerId = null; currentRoomCode = null;
    ["mfc_room_id", "mfc_room_code", "mfc_player_id", "mfc_username"].forEach(k => sessionStorage.removeItem(k));
    gameView.classList.add("hidden"); lobbyView.classList.add("hidden"); homeView.classList.remove("hidden");
    setHomeMessage("You left the room. You can create or join another one now.");
  } catch (error) {
    gameMessage.textContent = `Could not leave room: ${friendlyError(error)}. Run the updated SQL migration first.`;
  } finally { buttons.forEach(b => b.disabled = false); }
}
async function clearRoomSession() {
  if (resetSessionBtn) resetSessionBtn.disabled = true;
  setHomeMessage("Clearing this browser's room session and removing room membership…");

  // Clear local browser state first, so a stale room never traps the UI if the
  // server-side recovery RPC returns an error. We still call the RPC below to
  // remove this authenticated user from Supabase room memberships.
  if (pollHandle) clearInterval(pollHandle);
  if (gamePollHandle) clearInterval(gamePollHandle);
  pollHandle = null;
  gamePollHandle = null;
  gameState = null;
  currentRoom = null;
  currentPlayers = [];
  renderedGameSignature = "";
  selectedMessages = ["", ""];
  activeImageIndex = null;
  votedSubmission = null;
  currentRoomId = null;
  currentPlayerId = null;
  currentRoomCode = null;
  ["mfc_room_id", "mfc_room_code", "mfc_player_id", "mfc_username"].forEach(k => {
    sessionStorage.removeItem(k);
    localStorage.removeItem(k);
  });
  gameView.classList.add("hidden");
  lobbyView.classList.add("hidden");
  homeView.classList.remove("hidden");

  try {
    const { error } = await db.rpc("mfc_leave_all_rooms");
    if (error) throw error;
    setHomeMessage("Room session cleared successfully. You can create a new room or join an active lobby now.");
  } catch (error) {
    setHomeMessage(`Browser session cleared, but Supabase could not remove the old room membership: ${friendlyError(error)}. Run the latest upgrade_content_on_demand.sql migration, then click this button again.`);
  } finally {
    if (resetSessionBtn) resetSessionBtn.disabled = false;
  }
}
async function startNewGame() {
  if (!currentRoomId || !gameState?.is_host) return;
  startNewGameBtn.disabled = true;
  try {
    const { error } = await db.rpc("mfc_restart_game", { target_room: currentRoomId });
    if (error) throw error;
    if (gamePollHandle) clearInterval(gamePollHandle);
    gamePollHandle = null; gameState = null; renderedGameSignature = ""; selectedMessages = ["", ""];
    gameView.classList.add("hidden"); lobbyView.classList.remove("hidden");
    await refreshLobby();
    if (!pollHandle) pollHandle = setInterval(refreshLobby, 2500);
  } catch (error) { gameMessage.textContent = `Could not start a new game: ${friendlyError(error)}. Run the updated SQL migration first.`; }
  finally { startNewGameBtn.disabled = false; }
}
function hostFadeElement(tag, className, text) {
  const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el;
}
function hostRenderEntry(entry, side, step, index, closed) {
  const msgVisible = index === 0 ? step >= 0 : step >= 2;
  const imageVisible = index === 0 ? step >= 1 : step >= 3;
  const card = hostFadeElement("article", "host-entry");
  card.append(hostFadeElement("div", "host-entry-label", `ENTRY ${side}`));
  card.append(msgVisible ? hostFadeElement("p", "host-entry-message reveal-in", `“${String(entry?.message_text || "").replace(/^[“"']|[”"']$/g, "").trim()}”`) : hostFadeElement("div", "host-placeholder", "Message incoming…"));
  if (imageVisible && entry?.image_url) { const img=document.createElement("img"); img.src=entry.image_url; img.alt=`Entry ${side}`; img.className="reveal-in"; card.append(img); }
  else card.append(hostFadeElement("div", "host-placeholder host-image-placeholder", "Image reveal next"));
  if (closed || step === 4) card.append(hostFadeElement("div", "host-vote-count", `${entry?.votes || 0} vote${Number(entry?.votes)===1?"":"s"}`));
  if (closed && entry?.username) card.append(hostFadeElement("div", "host-entry-author", entry.username));
  return card;
}
function renderHostState(data) {
  const hostLobby=document.querySelector("#hostLobby"), hostGame=document.querySelector("#hostGame");
  document.querySelector("#hostRoomCode").textContent=data.room_code || "------";
  document.querySelector("#hostCodeLarge").textContent=data.room_code || "------";
  const players=document.querySelector("#hostPlayers"); players.replaceChildren();
  (data.players||[]).forEach((p,i)=>{ const item=hostFadeElement("div","host-player"); item.append(hostFadeElement("span","host-player-number",String(i+1).padStart(2,"0")),hostFadeElement("span","host-player-name",p.username),p.is_host?hostFadeElement("span","host-tag","HOST / PLAYER"):hostFadeElement("span","host-player-status","JOINED")); players.append(item); });
  const round=data.round;
  if (!round || data.status === "lobby") { hostLobby.classList.remove("hidden"); hostGame.classList.add("hidden"); return; }
  hostLobby.classList.add("hidden"); hostGame.classList.remove("hidden");
  document.querySelector("#hostRoundLabel").textContent=`ROUND ${round.number} OF ${round.rounds_total || "?"}`;
  document.querySelector("#hostMatchupLabel").textContent=data.current_matchup ? `MATCHUP ${data.current_matchup.number} / ${data.matchups_total}` : (round.phase === "results" ? "ROUND RESULTS" : "GETTING READY");
  const title=document.querySelector("#hostGameTitle"), subtitle=document.querySelector("#hostGameSubtitle"), board=document.querySelector("#hostMatchup"); board.replaceChildren();
  const m=data.current_matchup;
  if (round.phase === "results" || data.status === "finished") { title.textContent=data.status === "finished"?"GAME COMPLETE":"ROUND COMPLETE"; subtitle.textContent="Scores update as each vote is counted."; }
  else if (!m) { title.textContent="Get ready…"; subtitle.textContent="The host is preparing the first matchup."; }
  else {
    const elapsed=m.reveal_started_at?Math.max(0,(Date.now()-new Date(m.reveal_started_at).getTime())/1000):0;
    const step=m.status === "voting" ? 4 : Math.min(3,Math.floor(elapsed/5));
    title.textContent=m.status === "voting"?"PICK THE FUNNIER ENTRY":"THE SHOWDOWN";
    subtitle.textContent=m.status === "voting"?`${m.votes_cast || 0} of ${m.eligible_voters || 0} eligible votes received`:`Revealing the entries · ${Math.max(0,20-Math.floor(elapsed))} seconds until voting`;
    board.className="host-matchup"; board.append(hostRenderEntry(m.a,"A",step,0,m.status==="closed"),hostRenderEntry(m.b,"B",step,1,m.status==="closed"));
  }
  const scores=document.querySelector("#hostScoreboard"); scores.replaceChildren(hostFadeElement("h2","","SCOREBOARD"));
  (data.scores||[]).forEach((p,i)=>{const row=hostFadeElement("div","host-score-row");row.append(hostFadeElement("span","host-score-rank",String(i+1).padStart(2,"0")),hostFadeElement("span","host-score-name",p.username),hostFadeElement("strong","host-score-points",`${p.points} PTS`));scores.append(row);});
}
async function pollHostDisplay() {
  const code = new URLSearchParams(location.search).get("host");
  if (!code) return;
  const { data, error } = await db.rpc("mfc_get_spectator_state", { requested_code: code });
  if (error) { document.querySelector("#hostError").textContent = friendlyError(error); return; }
  document.querySelector("#hostError").textContent = "";
  const m=data.current_matchup||{}; const elapsed=m.reveal_started_at?Math.max(0,(Date.now()-new Date(m.reveal_started_at).getTime())/1000):0;
  const signature=JSON.stringify({status:data.status,round:data.round?.number,phase:data.round?.phase,matchup:m.number,matchStatus:m.status,step:m.status==="revealing"?Math.floor(elapsed/5):4,votes:m.votes_cast,scores:data.scores,players:data.players});
  if(signature!==hostLastSignature){hostLastSignature=signature;renderHostState(data);}
}
async function bootHostDisplay() {
  const code = new URLSearchParams(location.search).get("host");
  if (!code) return;
  hostDisplayMode=true; homeView.classList.add("hidden"); lobbyView.classList.add("hidden"); gameView.classList.add("hidden"); hostView.classList.remove("hidden");
  document.body.classList.add("host-display-body");
  await pollHostDisplay(); hostPollHandle=setInterval(pollHostDisplay,2000);
}

createBtn.addEventListener("click", createRoom);
startBtn.addEventListener("click", startGame);
gameActionBtn.addEventListener("click", async () => {
  if (!gameState || !gameState.hand) return;
  const [imageA,imageB] = gameState.hand.images || [];
  if (!imageA || !imageB) { gameMessage.textContent="This hand is missing images. Please ask the host to restart the round."; return; }
  if (!selectedMessages[0] || !selectedMessages[1]) { gameMessage.textContent="Pair both images with a message before submitting."; return; }
  if (selectedMessages[0] === selectedMessages[1]) { gameMessage.textContent="Choose two different messages."; return; }
  gameActionBtn.disabled=true;
  const pairs=[{image_id:imageA.id,message_id:selectedMessages[0]},{image_id:imageB.id,message_id:selectedMessages[1]}];
  const {error}=await db.rpc("mfc_submit_combos",{target_room:currentRoomId,pairs});
  if(error){gameMessage.textContent=friendlyError(error);gameActionBtn.disabled=false;return;}
  selectedMessages=["",""];
  renderedGameSignature="";
  await loadGameState();
});
gameNextBtn.addEventListener("click", nextRound);
joinBtn.addEventListener("click", joinRoom);
roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-F0-9]/g, "").slice(0, 6);
});
roomCodeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});
usernameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") createRoom();
});
document.querySelector("#copyCodeBtn").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(currentRoomCode || roomCodeDisplay.textContent);
    document.querySelector("#copyCodeBtn").textContent = "Copied";
    setTimeout(() => document.querySelector("#copyCodeBtn").textContent = "Copy", 1400);
  } catch {
    setPlayerMessage("Copy was blocked by the browser. Select the room code and copy it manually.");
  }
});
document.querySelector("#leaveBtn").addEventListener("click", leaveRoom);
resetSessionBtn?.addEventListener("click", clearRoomSession);
gameLeaveBtn.addEventListener("click", leaveRoom);
startNewGameBtn.addEventListener("click", startNewGame);
hostDisplayBtn?.addEventListener("click", () => {
  if (!currentRoomCode) return;
  const url = new URL(location.href); url.searchParams.set("host", currentRoomCode);
  window.open(url.toString(), "_blank", "noopener");
});
bootHostDisplay();

// Always show the create/join landing screen on a fresh page load.
// Room session details remain in sessionStorage so the UI can offer recovery later,
// but we intentionally do not auto-enter the lobby/game on refresh.

