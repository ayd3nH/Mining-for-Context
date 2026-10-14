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
const scoreboard = document.querySelector("#scoreboard");

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
    return "This browser session is already in a room. Leave that room or refresh the page to start a new session.";
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
    const { data, error } = await db.rpc("create_game_room", { player_name: name });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error("The room was not created. Please try again.");
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
  const ready = room.scan_status === "ready" || (images >= 50 && messages >= 200);
  const failed = room.scan_status === "failed";
  const isHost = players.some((p) => (p.is_host || p.id === room.host_player_id) && p.id === currentPlayerId);
  scanProgress.style.width = `${percent}%`;
  scanPercent.textContent = `${percent}%`;
  scanCounts.textContent = `${Math.min(images, 50)} / 50 images · ${Math.min(messages, 200)} / 200 messages`;
  scanTitle.textContent = ready ? "Content ready" : failed ? "Scan needs attention" : room.scan_status === "scanning" ? "Soggybot is scanning" : "Waiting for Soggybot";
  scanDetail.textContent = ready ? "Enough content has been collected. The host can start." : failed ? (room.scan_error || "The scan could not find enough eligible content.") : "Progress reflects the content needed to start, not the entire server archive.";
  startBtn.disabled = !(ready && isHost && room.status === "lobby");
  startBtn.textContent = isHost ? "Start game" : "Waiting for host";
  if (room.status === "playing") {
    scanTitle.textContent = "Room started";
    scanDetail.textContent = "The room is marked as started. The round and voting interface is the next game feature to build.";
    startBtn.disabled = true;
  }
}

async function startGame() {
  if (!currentRoom || startBtn.disabled) return;
  startBtn.disabled = true;
  startMessage.textContent = "Starting game…";
  try {
    const { error } = await db.rpc("mfc_start_game", {
      target_room: currentRoomId,
      rounds_total: Number(roundsSetting.value),
      selection_seconds: Number(pickTimeSetting.value),
      voting_seconds: Number(voteTimeSetting.value),
      game_mode: modeSetting.value
    });
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
  const signature = JSON.stringify({status:data.status, phase:round.phase, id:round.id, submitted:data.my_submitted,
    submissions:(data.submissions||[]).map(s=>[s.id,s.votes]), my_vote:data.my_vote, scores:data.scores});
  if (signature !== renderedGameSignature) {
    renderedGameSignature = signature;
    renderGameState(data);
  }
  const deadline = round.phase === "selecting" ? round.selection_deadline : round.phase === "voting" ? round.voting_deadline : null;
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
    return;
  }
  if (phase === "selecting") {
    gameTitle.textContent = state.my_submitted ? "Combos submitted." : "Make two combos.";
    gameInstructions.textContent = state.my_submitted ? "Your pairs are locked in. Voting starts when everyone has submitted or when the timer runs out." : "Drag each image onto the message you want to pair it with. You can also select an image, then tap a message. Submit when both pairs are ready. You have up to 60 seconds.";
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
    gameTitle.textContent = "Pick the funniest.";
    gameInstructions.textContent = "Vote for one combo. You cannot vote for your own submission.";
    renderSubmissions(state, true);
    gameActionBtn.classList.add("hidden");
    return;
  }
  if (phase === "results") {
    gameTitle.textContent = "Round results.";
    gameInstructions.textContent = "The most-voted combo earns 3 points; the runner-up earns 1.";
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
  const images = hand.images || [];
  const messages = hand.messages || [];
  const wrap = document.createElement("div");
  wrap.className = "pairing-board";

  const imageColumn = document.createElement("section");
  imageColumn.className = "pairing-column";
  const imageHeading = document.createElement("h3");
  imageHeading.textContent = "Your images";
  const imageHint = document.createElement("p");
  imageHint.className = "field-note";
  imageHint.textContent = "Drag an image onto a message, or select an image then tap a message.";
  imageColumn.append(imageHeading, imageHint);
  const imageGrid = document.createElement("div");
  imageGrid.className = "draggable-image-grid";
  images.slice(0, 2).forEach((img, index) => {
    const card = document.createElement("article");
    card.className = "draggable-image-card" + (activeImageIndex === index ? " is-active" : "") + (selectedMessages[index] ? " is-paired" : "");
    card.draggable = true;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Image ${index + 1}; ${selectedMessages[index] ? "paired" : "not paired"}`);
    const title = document.createElement("h4");
    title.textContent = `Image ${index + 1}`;
    const image = document.createElement("img");
    image.src = img.url;
    image.alt = `Your image ${index + 1}`;
    image.loading = "lazy";
    const pairLabel = document.createElement("span");
    pairLabel.className = "pair-status";
    const pairedMessage = messages.find((m) => m.id === selectedMessages[index]);
    pairLabel.textContent = pairedMessage ? `Paired: ${pairedMessage.text}` : "Drop onto a message";
    card.addEventListener("dragstart", (event) => {
      activeImageIndex = index;
      event.dataTransfer.setData("text/plain", String(index));
      event.dataTransfer.effectAllowed = "link";
      card.classList.add("is-dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
    card.addEventListener("click", () => {
      activeImageIndex = index;
      renderHand(hand);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); activeImageIndex = index; renderHand(hand);
      }
    });
    card.append(title, image, pairLabel);
    imageGrid.append(card);
  });
  imageColumn.append(imageGrid);

  const messageColumn = document.createElement("section");
  messageColumn.className = "pairing-column";
  const messageHeading = document.createElement("h3");
  messageHeading.textContent = "Your five messages";
  messageColumn.append(messageHeading);
  const messageList = document.createElement("div");
  messageList.className = "message-list drop-message-list";
  messages.forEach((msg, i) => {
    const item = document.createElement("div");
    item.className = "message-option drop-target";
    const pairIndexes = selectedMessages.map((id, index) => id === msg.id ? index : -1).filter((index) => index >= 0);
    if (pairIndexes.length) item.classList.add("has-pair");
    if (activeImageIndex !== null && !pairIndexes.length) item.classList.add("can-drop");
    const text = document.createElement("span");
    text.textContent = `${i + 1}. ${msg.text}`;
    const badge = document.createElement("span");
    badge.className = "drop-badge";
    badge.textContent = pairIndexes.length ? `Image ${pairIndexes.map((n) => n + 1).join(" & ")}` : "Drop image here";
    item.append(text, badge);
    item.addEventListener("dragover", (event) => { event.preventDefault(); item.classList.add("drag-over"); event.dataTransfer.dropEffect = "link"; });
    item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
    item.addEventListener("drop", (event) => {
      event.preventDefault(); item.classList.remove("drag-over");
      const rawIndex = event.dataTransfer.getData("text/plain");
      const index = rawIndex === "" ? activeImageIndex : Number(rawIndex);
      if (index === null || !Number.isInteger(index) || index < 0 || index > 1) return;
      assignMessage(index, msg.id, hand);
    });
    item.addEventListener("click", () => {
      if (activeImageIndex === null) {
        gameMessage.textContent = "Select an image first, then tap the message you want to pair it with.";
        return;
      }
      assignMessage(activeImageIndex, msg.id, hand);
    });
    messageList.append(item);
  });
  messageColumn.append(messageList);
  wrap.append(imageColumn, messageColumn);
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

function renderSubmissions(state, voting) {
  const submissions = state.submissions || [];
  const grid = document.createElement("div"); grid.className="submission-grid";
  submissions.forEach((sub, i) => {
    const card=document.createElement("article"); card.className="submission-card";
    const label=document.createElement("span"); label.className="eyebrow"; label.textContent=`COMBO ${i+1}`;
    const img=document.createElement("img"); img.src=sub.image_url; img.alt="Submitted image"; img.loading="lazy";
    const msg=document.createElement("p"); msg.textContent=sub.message_text;
    const meta=document.createElement("span"); meta.className="submission-author";
    meta.textContent = voting ? `${sub.votes || 0} votes` : `${sub.username} · ${sub.votes || 0} votes`;
    card.append(label,img,msg,meta);
    if (voting && !state.my_vote && sub.player_id !== currentPlayerId) {
      const btn=document.createElement("button"); btn.className="button button-secondary"; btn.textContent="Vote for this combo";
      btn.addEventListener("click", async ()=>{
        btn.disabled=true;
        const {error}=await db.rpc("mfc_vote",{target_room:currentRoomId,target_submission:sub.id});
        if(error){gameMessage.textContent=friendlyError(error);btn.disabled=false;} else {gameMessage.textContent="Vote recorded.";await loadGameState();}
      }); card.append(btn);
    } else if (voting && sub.player_id === currentPlayerId) {
      const own=document.createElement("span"); own.className="submission-author"; own.textContent="Your combo — cannot vote"; card.append(own);
    }
    grid.append(card);
  });
  gameContent.append(grid);
  if (voting && state.my_vote) { const note=document.createElement("p"); note.className="field-note"; note.textContent="Your vote is recorded. Wait for voting to close."; gameContent.append(note); }
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
  if (pollHandle) clearInterval(pollHandle);
  if (gamePollHandle) clearInterval(gamePollHandle);
  pollHandle = null;
  gamePollHandle = null;
  gameState = null;
  renderedGameSignature = "";
  currentRoomId = null;
  currentPlayerId = null;
  currentRoomCode = null;
  // The prototype intentionally leaves the database row intact; room cleanup can be added later.
  sessionStorage.removeItem("mfc_room_id");
  sessionStorage.removeItem("mfc_room_code");
  sessionStorage.removeItem("mfc_player_id");
  sessionStorage.removeItem("mfc_username");
  lobbyView.classList.add("hidden");
  homeView.classList.remove("hidden");
  setHomeMessage("You left the lobby view. Your player entry remains until room cleanup is added.");
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

// Always show the create/join landing screen on a fresh page load.
// Room session details remain in sessionStorage so the UI can offer recovery later,
// but we intentionally do not auto-enter the lobby/game on refresh.

