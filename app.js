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

let currentRoomId = null;
let currentPlayerId = null;
let currentRoomCode = null;
let pollHandle = null;
let busy = false;

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
    .select("id, code, status, host_player_id")
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
  playerCount.textContent = String(players.length);
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
async function leaveRoom() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
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

// Restore this tab's room after a refresh, using the existing anonymous auth session.
(async function restoreRoom() {
  const roomId = sessionStorage.getItem("mfc_room_id");
  const code = sessionStorage.getItem("mfc_room_code");
  const playerId = sessionStorage.getItem("mfc_player_id");
  const name = sessionStorage.getItem("mfc_username");
  if (!roomId || !code || !playerId || !name) return;
  try {
    const { data: { session } } = await db.auth.getSession();
    if (!session || session.user.id !== playerId) return;
    usernameInput.value = name;
    enterRoom(roomId, code, playerId, session.user.id, name);
  } catch {
    // The landing screen remains available if restoration fails.
  }
})();
