//* ---------------------------------------------------------
// Pflege-Installation (kiosk, offline) — app.js (AUDIO + DISTORTION)
// - Ambient (loop) startet nach Intro-OK
// - Intro Voice startet beim Intro-Popup, stoppt beim OK
// - Room Alarm: EIN Loop, keine Overlaps, läuft nur solange mind. 1 Raum offen
//   Room 3: läuft bis Kolleg:innen-Reaktion ("Du hast Glück...") ODER resolve
// - Random BG: Telefon + Gespräch random
// - Steps: eigene random Wiederholung
// - Big Switch: Verzerrung des Ambient-Sounds (Crossfade Dry/Wet)
// - NOTFALL: Emergency Alarm (lauter/schneller), HERZALARM: Voice über Emergency,
//            Emergency läuft weiter bis Blackout
//--------------------------------------------------------- *//

/* =========================================================
   Helpers
========================================================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

/** Robust audio play: prevents "The play() request was interrupted" noise */
function safePlay(mediaEl) {
  if (!mediaEl) return;
  try {
    const p = mediaEl.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
}

/* =========================================================
   DOM refs (filled after DOM ready)
========================================================= */
let screens, loginForm, pwInput, loginError, clockEl, alertsEl;
let docForm, btnSave, btnFinish, saveStatus;
let modal, modalStack, blackout, btnRestart, btnReset;

let roomEls;

/* =========================================================
   Passwords
========================================================= */
const VALID_PASSWORDS = new Set(["wer pflegt die pflege ?", "pflegekräfte"]);

/* =========================================================
   State / timers
========================================================= */
let cueTimers = [];
let ended = false;
let saveAttempts = 0;
let sequenceStartMs = 0;

let clockRAF = null;
let baseClockMinutes = 8 * 60 + 12;

let finalPhase = false;
let timerRunning = false;

let degradation = 0;
let switchActive = false;

function scheduleAt(msFromStart, fn) {
  const delay = Math.max(0, msFromStart - (performance.now() - sequenceStartMs));
  const id = setTimeout(() => { if (!ended) fn(); }, delay);
  cueTimers.push(id);
  return id;
}
function scheduleIn(msFromNow, fn) {
  const id = setTimeout(() => { if (!ended) fn(); }, Math.max(0, msFromNow));
  cueTimers.push(id);
  return id;
}
function clearTimers() {
  cueTimers.forEach(clearTimeout);
  cueTimers = [];
}

/* =========================================================
   Rooms
========================================================= */
const roomState = {
  1: { active: false, hasAlarmed: false, deferredCount: 0, resolved: false, repeatIds: [] },
  2: { active: false, hasAlarmed: false, deferredCount: 0, resolved: false, repeatIds: [] },
  3: { active: false, hasAlarmed: false, deferredCount: 0, resolved: false, repeatIds: [], alarmCleared: false },
  4: { active: false, hasAlarmed: false, deferredCount: 0, resolved: false, repeatIds: [] },
  5: { active: false, hasAlarmed: false, deferredCount: 0, resolved: false, repeatIds: [] },
};

function setRoomActive(roomId, on) {
  roomState[roomId].active = on;
if (roomEls && roomEls[roomId]) {
    roomEls[roomId].classList.toggle("is-blinking", on);
}

}
function cancelRoomRepeats(roomId) {
  const ids = roomState[roomId].repeatIds || [];
  ids.forEach(clearTimeout);
  roomState[roomId].repeatIds = [];
}
function markRoomResolved(roomId) {
  roomState[roomId].resolved = true;
  cancelRoomRepeats(roomId);
  setRoomActive(roomId, false);

  if (roomId === 3) roomState[3].alarmCleared = true;
  stopRoomAlarmIfNoOpenRooms();
}

/* =========================================================
   AUDIO SYSTEM
========================================================= */
const audio = {
  ambient: new Audio("assets/audio/ambient_loop.wav"),
  introVoice: new Audio("assets/audio/intro_voice.mp3"),
  roomAlarm: new Audio("assets/audio/room_alarm_loop.wav"),
  emergencyAlarm: new Audio("assets/audio/emergency_alarm_fast.mp3"),

  voices: {
    room1_help: new Audio("assets/audio/room1_help.mp3"),
    room1_wait: new Audio("assets/audio/room1_wait.mp3"),
    room1_react: new Audio("assets/audio/room1_react.mp3"),

    room2_help: new Audio("assets/audio/room2_help.mp3"),
    room2_wait: new Audio("assets/audio/room2_wait.mp3"),
    room2_react: new Audio("assets/audio/room2_react.mp3"),

    room3_pain: new Audio("assets/audio/room3_pain.mp3"),
    room3_react: new Audio("assets/audio/room3_react.mp3"),

    room5_transport: new Audio("assets/audio/room5_transport.mp3"),
    room5_react: new Audio("assets/audio/room5_react.mp3"),

    colleague_thanks: new Audio("assets/audio/colleague_thanks.mp3"),
    colleague_lucky: new Audio("assets/audio/colleague_lucky.mp3"),

    heartalarm_call: new Audio("assets/audio/heartalarm_call.mp3"),
  },

  bg: {
    phone: new Audio("assets/audio/bg_phone.mp3"),
    talk: new Audio("assets/audio/bg_talk.mp3"),
    steps: new Audio("assets/audio/bg_steps.mp3"),
  }
};

// Defaults
audio.ambient.loop = true;
audio.ambient.volume = 0.18;

audio.introVoice.volume = 0.22;

audio.roomAlarm.loop = true;
audio.roomAlarm.volume = 0.45;

audio.emergencyAlarm.loop = true;
audio.emergencyAlarm.volume = 0.20;

Object.values(audio.voices).forEach(a => a.volume = 0.30);
audio.bg.phone.volume = 0.22;
audio.bg.talk.volume  = 0.11;
audio.bg.steps.volume = 0.28;

/* ---------------------------------------------------------
   WebAudio Graph for AMBIENT distortion (Big Switch)
   IMPORTANT: MediaElementSource darf NICHT mehrfach erzeugt werden
--------------------------------------------------------- */
let _audioCtx = null;
let _ambientSource = null;
let _ambientDry = null;
let _ambientWet = null;
let _ambientShaper = null;
let _ambientFilter = null;

function ensureAudioContext() {
  if (_audioCtx) return _audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  _audioCtx = new Ctx();
  return _audioCtx;
}

function makeDistortionCurve(amount = 20) {
  const n = 44100;
  const curve = new Float32Array(n);
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
  }
  return curve;
}

function ensureAmbientGraph() {
  const ctx = ensureAudioContext();
  if (!ctx) return;

  if (_ambientSource && _ambientDry && _ambientWet) return;

  _ambientSource = ctx.createMediaElementSource(audio.ambient);

  _ambientDry = ctx.createGain();
  _ambientWet = ctx.createGain();
  _ambientDry.gain.value = 1.0;
  _ambientWet.gain.value = 0.0;

  _ambientShaper = ctx.createWaveShaper();
  _ambientShaper.curve = makeDistortionCurve(28);
  _ambientShaper.oversample = "4x";

  _ambientFilter = ctx.createBiquadFilter();
  _ambientFilter.type = "lowpass";
  _ambientFilter.frequency.value = 12000;

  _ambientSource.connect(_ambientDry);
  _ambientDry.connect(ctx.destination);

  _ambientSource.connect(_ambientShaper);
  _ambientShaper.connect(_ambientFilter);
  _ambientFilter.connect(_ambientWet);
  _ambientWet.connect(ctx.destination);
}

function setAmbientDistortion(on) {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  ensureAmbientGraph();
  if (!_ambientDry || !_ambientWet) return;

  const t = ctx.currentTime;
  _ambientDry.gain.cancelScheduledValues(t);
  _ambientWet.gain.cancelScheduledValues(t);

  if (on) {
    _ambientDry.gain.setValueAtTime(_ambientDry.gain.value, t);
    _ambientWet.gain.setValueAtTime(_ambientWet.gain.value, t);

    _ambientDry.gain.linearRampToValueAtTime(0.45, t + 0.35);
    _ambientWet.gain.linearRampToValueAtTime(0.75, t + 0.35);

    if (_ambientFilter) {
      _ambientFilter.frequency.cancelScheduledValues(t);
      _ambientFilter.frequency.setValueAtTime(_ambientFilter.frequency.value, t);
      _ambientFilter.frequency.linearRampToValueAtTime(4200, t + 0.6);
    }
  } else {
    _ambientDry.gain.setValueAtTime(_ambientDry.gain.value, t);
    _ambientWet.gain.setValueAtTime(_ambientWet.gain.value, t);

    _ambientDry.gain.linearRampToValueAtTime(1.0, t + 0.25);
    _ambientWet.gain.linearRampToValueAtTime(0.0, t + 0.25);

    if (_ambientFilter) {
      _ambientFilter.frequency.cancelScheduledValues(t);
      _ambientFilter.frequency.setValueAtTime(_ambientFilter.frequency.value, t);
      _ambientFilter.frequency.linearRampToValueAtTime(12000, t + 0.4);
    }
  }
}

/* =========================================================
   AUDIO CONTROL STATE
========================================================= */
let roomAlarmActive = false;
let emergencyActive = false;

let backgroundRandomActive = false;
let bgTalkPlayed = false;
let bgStartTime = 0;
let bgBlockUntil = 0;
let stepsActive = false;
let _stepsTimeout = null;
let _bgTimeout = null;

function stopAllAudio() {
  try { audio.ambient.pause(); audio.ambient.currentTime = 0; } catch {}
  try { audio.introVoice.pause(); audio.introVoice.currentTime = 0; } catch {}

  try { audio.roomAlarm.pause(); audio.roomAlarm.currentTime = 0; } catch {}
  try { audio.emergencyAlarm.pause(); audio.emergencyAlarm.currentTime = 0; } catch {}

  Object.values(audio.voices).forEach(a => { try { a.pause(); a.currentTime = 0; } catch {} });
  Object.values(audio.bg).forEach(a => { try { a.pause(); a.currentTime = 0; } catch {} });

  roomAlarmActive = false;
  emergencyActive = false;

  backgroundRandomActive = false;
  bgTalkPlayed = false;
  bgStartTime = 0;
  stepsActive = false;

  if (_bgTimeout) { clearTimeout(_bgTimeout); _bgTimeout = null; }
  if (_stepsTimeout) { clearTimeout(_stepsTimeout); _stepsTimeout = null; }

  try { setAmbientDistortion(false); } catch {}
}

function startAmbient() {
  ensureAudioContext();
  ensureAmbientGraph();
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});

  audio.ambient.currentTime = 0;
  audio.ambient.volume = 0.0;
  safePlay(audio.ambient);

  const targetVolume = 0.18;
  let step = 0;
  const steps = 15;
  const duration = 1200;
  const interval = duration / steps;

  const fade = () => {
    step++;
    audio.ambient.volume = Math.min(targetVolume, (step / steps) * targetVolume);
    if (step < steps) setTimeout(fade, interval);
  };
  fade();
}

function playIntroVoice() {
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  audio.introVoice.currentTime = 0;
  safePlay(audio.introVoice);
}
function stopIntroVoice() {
  try { audio.introVoice.pause(); audio.introVoice.currentTime = 0; } catch {}
}

function playVoice(key) {
  const v = audio.voices[key];
  if (!v) return;
  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  try {
    v.pause();
    v.currentTime = 0;
    safePlay(v);
    if (["room1_help","room2_help","room3_pain","room5_transport"].includes(key)) {
      bgBlockUntil = Date.now() + 1000;
    }
  } catch {}
}

/* ------------------ ROOM ALARM SINGLETON ------------------ */
function startRoomAlarm() {
  if (emergencyActive) return;
  if (roomAlarmActive) return;

  roomAlarmActive = true;

  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  try {
    audio.roomAlarm.currentTime = 0;
    safePlay(audio.roomAlarm);
  } catch {}
}

function stopRoomAlarm() {
  roomAlarmActive = false;
  try { audio.roomAlarm.pause(); audio.roomAlarm.currentTime = 0; } catch {}
}

/** Entscheidet, ob noch irgendein Raum wirklich offen ist */
function anyRoomStillUnresolved() {
  const r1 = roomState[1].hasAlarmed && !roomState[1].resolved;
  const r2 = roomState[2].hasAlarmed && !roomState[2].resolved;
  const r5 = roomState[5].hasAlarmed && !roomState[5].resolved;
  const r3 = roomState[3].hasAlarmed && !roomState[3].resolved && !roomState[3].alarmCleared;
  return r1 || r2 || r3 || r5;
}

function stopRoomAlarmIfNoOpenRooms() {
  if (emergencyActive) return;
  if (!anyRoomStillUnresolved()) stopRoomAlarm();
}

function startEmergencyAlarm() {
  stopRoomAlarm();
  emergencyActive = true;

  const ctx = ensureAudioContext();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  try {
    audio.emergencyAlarm.currentTime = 0;
    safePlay(audio.emergencyAlarm);
  } catch {}
}

/* ------------------ RANDOM BACKGROUND + STEPS ------------------ */
function startRandomBackground() {
  if (backgroundRandomActive) return;
  backgroundRandomActive = true;
  bgTalkPlayed = false;
  bgStartTime = Date.now();

  const loop = () => {
    if (!backgroundRandomActive) return;

    const clips = [audio.bg.phone];
    const now = Date.now();

    const anyRoomAudioPlaying = Object.entries(audio.voices).some(([key, a]) => {
      return ["room1_help","room2_help","room3_pain","room5_transport"].includes(key) && a && !a.paused;
    });

    if (!bgTalkPlayed && (now - bgStartTime) > 10000 && now > bgBlockUntil && !anyRoomAudioPlaying) {
      clips.push(audio.bg.talk);
    }

    const clip = clips[Math.floor(Math.random() * clips.length)];
    try {
      clip.pause();
      clip.currentTime = 0;
      safePlay(clip);
      if (clip === audio.bg.talk) bgTalkPlayed = true;
    } catch {}

    _bgTimeout = setTimeout(loop, 9000 + Math.random() * 16000);
  };

  loop();
}

function startStepsRandom() {
  if (stepsActive) return;
  stepsActive = true;

  const loop = () => {
    if (!stepsActive) return;
    try {
      audio.bg.steps.pause();
      audio.bg.steps.currentTime = 0;
      safePlay(audio.bg.steps);
    } catch {}
    _stepsTimeout = setTimeout(loop, 6000 + Math.random() * 14000);
  };
  loop();
}

/* =========================================================
   Screens
========================================================= */
function showScreen(which) {
  for (const k of Object.keys(screens)) {
    if (screens[k]) {
      screens[k].classList.remove("is-active");
    }
  }
  if (screens[which]) {
    screens[which].classList.add("is-active");
  }
}

/* =========================================================
   Alerts (optional)
========================================================= */
function addAlert(text, level = "yellow") {
  if (!alertsEl) return;
  const div = document.createElement("div");
  div.className = "alert" + (level === "orange" ? " orange" : level === "red" ? " red" : "");
  div.textContent = text;
  alertsEl.prepend(div);

  const items = [...alertsEl.querySelectorAll(".alert")];
  if (items.length > 7) items.slice(7).forEach((n) => n.remove());
}

/* =========================================================
   Modal stack
========================================================= */
function ensureModalVisible() {
  if (!modal) return;
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}
function hideModalIfEmpty() {
  if (!modal || !modalStack) return;
  if (!modalStack.querySelector(".modal-card")) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

function openModalCard({
  title,
  body,
  level = "yellow",
  buttons = null,
  onClose = null,
  actionsAlign = "end",
}) {
  if (finalPhase && level !== "red" && level !== "intro" && level !== "endfact") return;
  if (!modal || !modalStack) return;

  ensureModalVisible();

  const card = document.createElement("div");
  card.className = `modal-card ${level}`;

  const t = document.createElement("div");
  t.className = "modal-title";
  t.textContent = title;

  const b = document.createElement("div");
  b.className = "modal-body";
  b.textContent = body;

  const actions = document.createElement("div");
  const two = buttons && buttons.length === 2;
  actions.className =
    "modal-actions" +
    (two ? " two" : "") +
    (actionsAlign === "center" ? " center" : "");

  if (!buttons) {
    const ok = document.createElement("button");
    ok.className = "btn primary";
    ok.textContent = "OK";
    ok.addEventListener("click", () => {
      card.remove();
      hideModalIfEmpty();
      onClose?.();
    });
    actions.appendChild(ok);
  } else {
    for (const btn of buttons) {
      const el = document.createElement("button");
      el.className = btn.primary ? "btn primary" : "btn";
      el.textContent = btn.label;
      el.addEventListener("click", () => {
        card.remove();
        hideModalIfEmpty();
        btn.onClick?.();
        onClose?.();
      });
      actions.appendChild(el);
    }
  }

  card.appendChild(t);
  card.appendChild(b);
  card.appendChild(actions);
  modalStack.prepend(card);
}

function closeAllModals() {
  if (modalStack) modalStack.innerHTML = "";
  if (modal) {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
  }
}

function popupAlert(title, body, level = "yellow") {
  addAlert(`${title}: ${body}`, level);
  openModalCard({ title, body, level });
}

/* =========================================================
   Clock
========================================================= */
function startClock() {
  if (!clockEl) return;
  if (clockRAF) cancelAnimationFrame(clockRAF);

  const start = Date.now();
  const tick = () => {
    const elapsedMin = Math.floor((Date.now() - start) / 1000);
    const total = baseClockMinutes + elapsedMin;
    const hh = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    clockEl.textContent = `${hh}:${mm}`;
    if (!ended) clockRAF = requestAnimationFrame(tick);
  };
  clockRAF = requestAnimationFrame(tick);
}

/* =========================================================
   Timer Overlay (Freeze)
========================================================= */
let _timerInterval = null;

function normalizeTimerOverlay() {
  const all = $$("#timer-overlay");
  if (all.length > 1) {
    for (let i = 1; i < all.length; i++) all[i].remove();
  }

  let overlay = $("#timer-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "timer-overlay";
    overlay.className = "hidden";
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = `
      <div id="timer-text">00:05</div>
      <div id="timer-reaction" class="timer-reaction hidden">
        <div id="timer-reaction-title" class="timer-reaction-title">Reaktion</div>
        <div id="timer-reaction-body" class="timer-reaction-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
  }

  if (!$("#__timer_css")) {
    const style = document.createElement("style");
    style.id = "__timer_css";
    style.textContent = `
      #timer-overlay{ position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; }
      #timer-overlay.hidden{ display:none !important; }
      #timer-text{
        position:absolute; inset:0;
        display:flex; align-items:center; justify-content:center;
        font-weight:900; line-height:1; letter-spacing:.02em;
        font-size: min(90vh, 90vw);
        color:#4C0F16; opacity:.88;
        transform: scaleX(0.595);
        transform-origin:center;
        pointer-events:none;
      }
      body.timer-running{ overflow:hidden; }
    `;
    document.head.appendChild(style);
  }
}

function playTick(seconds) {
  // defensiv: nicht spam-men
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    let t = ctx.currentTime;

    for (let i = 0; i < seconds; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 900;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);
      o.stop(t + 0.12);
      t += 1.0;
    }
    setTimeout(() => { try { ctx.close(); } catch {} }, (seconds + 1) * 1000);
  } catch {}
}

function setTimerRunning(on) {
  timerRunning = on;
  document.body.classList.toggle("timer-running", on);
  if (on) document.activeElement?.blur?.();

  const overlay = $("#timer-overlay");
  if (overlay) overlay.style.pointerEvents = on ? "auto" : "none";
}

function installTimerGuards() {
  const block = (e) => {
    if (!timerRunning) return;
    e.preventDefault();
    e.stopPropagation();
  };
  [
    "click","dblclick",
    "mousedown","mouseup",
    "pointerdown","pointerup",
    "touchstart","touchend",
    "keydown","keypress","keyup",
    "input","change",
    "wheel",
  ].forEach((evt) => window.addEventListener(evt, block, true));
}

function showTimePressure(seconds, reactionTitle = "", reactionText = "") {
  const overlay = $("#timer-overlay");
  const text = $("#timer-text");
  const reaction = $("#timer-reaction");
  const reactionTitleEl = $("#timer-reaction-title");
  const reactionBody = $("#timer-reaction-body");
  if (!overlay || !text || !reaction || !reactionBody) return;

  // ✅ wichtig: alte intervalle killen, sonst kann der Timer "wegbleiben"
  if (_timerInterval) {
    clearInterval(_timerInterval);
    _timerInterval = null;
  }

  setTimerRunning(true);

  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");

  if (reactionTitleEl) reactionTitleEl.textContent = reactionTitle || "Reaktion";
  if (reactionText) {
    reactionBody.textContent = reactionText;
    reaction.classList.remove("hidden");
  } else {
    reaction.classList.add("hidden");
  }

  let remaining = clamp(seconds, 1, 30);
  text.textContent = `00:${String(remaining).padStart(2, "0")}`;
  playTick(remaining);

  _timerInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(_timerInterval);
      _timerInterval = null;

      overlay.classList.add("hidden");
      overlay.setAttribute("aria-hidden", "true");
      reaction.classList.add("hidden");
      setTimerRunning(false);
      return;
    }
    text.textContent = `00:${String(remaining).padStart(2, "0")}`;
  }, 1000);
}

function decisionOk(reactionTitle, reactionBody) {
  showTimePressure(5, reactionTitle, reactionBody);
}

/* =========================================================
   Room alarm logic + voices + decisions
========================================================= */
function alarmRoom(roomId, popupBody) {
  if (finalPhase) return;

  setRoomActive(roomId, true);
  roomState[roomId].hasAlarmed = true;

  if (roomId === 3) roomState[3].alarmCleared = false;

  startRoomAlarm();

  if (roomId === 1) playVoice("room1_help");
  if (roomId === 2) playVoice("room2_help");
  if (roomId === 3) playVoice("room3_pain");
  if (roomId === 5) playVoice("room5_transport");

  openModalCard({
    title: "Achtung",
    body: popupBody,
    level: "room",
    onClose: () => window.scrollTo({ top: 0, behavior: "smooth" }),
  });

  addAlert(`Achtung: ${popupBody}`, "orange");
}

function getRoomDetail(roomId) {
  switch (roomId) {
    case 1: return { level: "orange", title: "Raum 1", body: "Patient benötigt einen Löffel für den Joghurt." };
    case 2: return { level: "yellow", title: "Raum 2", body: "Patient friert und braucht eine Decke." };
    case 3: return { level: "red", title: "Raum 3", body: "Bett 2: Hr. Bernds Infusion läuft nicht mehr.\nEr klagt über Schmerzen am Zugang." };
    case 5: return { level: "orange", title: "Raum 5", body: "Patient kommt aus dem OP." };
    default: return { level: "yellow", title: "Hinweis", body: "Keine Meldung." };
  }
}

function showRoomDecision(roomId) {
  if (finalPhase) return;
  if (roomId === 4) return;
  if (!roomState[roomId].hasAlarmed) return;

  if (roomState[roomId].resolved) {
    popupAlert(`Raum ${roomId}`, "Bereits bearbeitet.", "yellow");
    return;
  }

  const detail = getRoomDetail(roomId);

  openModalCard({
    title: detail.title,
    body: detail.body,
    level: detail.level,
    buttons: [
      { label: "OK, ich komme sofort.", primary: true, onClick: () => handleDecision(roomId, "ok") },
      { label: "Später, ich muss erst dokumentieren.", primary: false, onClick: () => handleDecision(roomId, "later") },
    ],
    onClose: () => window.scrollTo({ top: 0, behavior: "smooth" }),
  });
}

function decisionLater(roomId) {
  roomState[roomId].deferredCount += 1;

  if (roomId === 1) {
    for (let i = 1; i <= 3; i++) {
      const id = scheduleIn(10_000 * i, () => {
        if (roomState[roomId].resolved || finalPhase) return;
        popupAlert("Raum 1", "„Hey! Ich warte immer noch!!!“", "orange");
        playVoice("room1_wait");
        startRoomAlarm();
      });
      roomState[roomId].repeatIds.push(id);
    }
  } else if (roomId === 2) {
    const id = scheduleIn(14_000, () => {
      if (roomState[roomId].resolved || finalPhase) return;
      popupAlert("Raum 2", "„Entschuldigung… aber mir ist sehr kalt.\nIch kann nicht allein aufstehen.“", "yellow");
      playVoice("room2_wait");
      startRoomAlarm();
    });
    roomState[roomId].repeatIds.push(id);
  } else if (roomId === 3) {
    const id = scheduleIn(12_600, () => {
      if (finalPhase) return;

      // ✅ Room3: Alarm endet hier (aber nur wenn sonst nix offen)
      roomState[3].alarmCleared = true;
      setRoomActive(3, false);

      popupAlert(
        "Kolleg:in",
        "„Du hast Glück, dass ich reingegangen bin.\nSonst wäre es ein irreparabler Schaden am Arm.\nDu musst besser priorisieren!“",
        "red"
      );
      playVoice("colleague_lucky");

      stopRoomAlarmIfNoOpenRooms();
    });
    roomState[roomId].repeatIds.push(id);
  } else if (roomId === 5) {
    setRoomActive(5, true);
    if (!finalPhase) popupAlert("Raum 5", "Transport wartet weiter – Übergabe offen.", "orange");
    startRoomAlarm();
  }

  setRoomActive(roomId, true);
  startRoomAlarm();
}

function handleDecision(roomId, choice) {
  if (choice === "ok") {
    markRoomResolved(roomId);

    if (roomId === 1) {
      playVoice("room1_react");
      decisionOk("Reaktion – Raum 1", "„Endlich… ich zahle genug Versicherung!\nWarum muss ich überhaupt warten?!“");
    } else if (roomId === 2) {
      playVoice("room2_react");
      decisionOk("Reaktion – Raum 2", "„Danke… und entschuldige, dass ich störe.\nIch bin noch zu schwach, allein aufzustehen.“");
    } else if (roomId === 3) {
      playVoice("room3_react");
      decisionOk("Reaktion – Raum 3", "Paravasat-Verdacht: Medikament ist ins Gewebe gelaufen.\nKurze Kontrolle/Intervention nötig.\n„Danke… es tut noch sehr weh, aber danke.“");
    } else if (roomId === 5) {
      playVoice("room5_react");
      decisionOk(
        "Übergabe – Raum 5",
        "Hier...seine Akte:\n• Vitalwerte stabil\n• Orientierung: wach, leicht benommen\n• OP: komplikationslos\n• Schmerzen: moderat\n• Miktion: noch nicht"
      );
    }

    stopRoomAlarmIfNoOpenRooms();
    return;
  }

  decisionLater(roomId);
}

/* =========================================================
   Validation / Save / Finish
========================================================= */
function getDocValues() {
  const mobil = docForm?.querySelector("input[name='mobil']:checked")?.value || "";
  const pain = $("#pain")?.value?.trim() || "";
  const food = $("#food")?.value?.trim() || "";

  const bp = $("#bp")?.value?.trim() || "";
  const pulse = $("#pulse")?.value?.trim() || "";
  const temp = $("#temp")?.value?.trim() || "";
  const weight = $("#weight")?.value?.trim() || "";
  const defecation = $("#defecation")?.value?.trim() || "";
  const io = $("#io")?.value?.trim() || "";

  return { mobil, pain, food, bp, pulse, temp, weight, defecation, io };
}

function showFieldError(key, on) {
  const el = document.querySelector(`[data-err="${key}"]`);
  if (!el) return;
  el.classList.toggle("hidden", !on);
}

function validateDoc() {
  const v = getDocValues();

  const painNum = Number(v.pain);
  const pulseNum = Number(v.pulse);
  const tempNum = Number(v.temp);
  const weightNum = Number(v.weight);
  const ioNum = Number(v.io);

  const okMobil = v.mobil !== "";
  const okFood = v.food !== "";
  const okPain = v.pain !== "" && Number.isFinite(painNum) && painNum >= 0 && painNum <= 10;

  const okBP = /^\d{2,3}\/\d{2,3}$/.test(v.bp);
  const okPulse = v.pulse !== "" && Number.isFinite(pulseNum) && pulseNum >= 30 && pulseNum <= 220;
  const okTemp = v.temp !== "" && Number.isFinite(tempNum) && tempNum >= 34 && tempNum <= 42;
  const okWeight = v.weight !== "" && Number.isFinite(weightNum) && weightNum >= 20 && weightNum <= 250;
  const okDef = v.defecation !== "";
  const okIO = v.io !== "" && Number.isFinite(ioNum) && ioNum >= 0 && ioNum <= 10000;

  showFieldError("mobil", !okMobil);
  showFieldError("food", !okFood);
  showFieldError("pain", !okPain);
  showFieldError("bp", !okBP);
  showFieldError("pulse", !okPulse);
  showFieldError("temp", !okTemp);
  showFieldError("weight", !okWeight);
  showFieldError("defecation", !okDef);
  showFieldError("io", !okIO);

  return okMobil && okFood && okPain && okBP && okPulse && okTemp && okWeight && okDef && okIO;
}

function scriptedSave() {
  if (!validateDoc()) {
    if (saveStatus) saveStatus.textContent = "Unvollständig.";
    return;
  }
  if (saveStatus) saveStatus.textContent = "Speichern…";
  if (btnSave) btnSave.disabled = true;

  saveAttempts += 1;

  setTimeout(() => {
    if (btnSave) btnSave.disabled = false;

    if (saveAttempts === 1) {
      addAlert("Warnung: Schreibzugriff eingeschränkt.", "orange");
      openModalCard({
        title: "Fehler beim Speichern",
        body: "Die Patientenstammdaten sind derzeit gesperrt.\nBitte versuchen Sie es später erneut.",
        level: "red",
      });
      if (saveStatus) saveStatus.textContent = "Fehler.";
      return;
    }

    if (saveStatus) saveStatus.textContent = "Gespeichert.";
    addAlert("Dokumentation gespeichert.", "yellow");
  }, 2200);
}

function finishDoc() {
  if (!validateDoc()) return;
  addAlert("Dokumentation eingereicht (ausstehende Prüfung).", "yellow");
  if (saveStatus) saveStatus.textContent = "Übermittelt.";
}

/* =========================================================
   Switch Point (Labels + Ink overlay)
========================================================= */
let mouseLagOn = false;
function enableMouseLag() {
  if (mouseLagOn) return;
  mouseLagOn = true;

  const onMove = () => {
    if (!mouseLagOn) return;
    const delay = 30 + Math.floor(Math.random() * 150);
    document.body.style.pointerEvents = "none";
    setTimeout(() => { document.body.style.pointerEvents = ""; }, delay);
  };

  window.addEventListener("mousemove", onMove, true);
  enableMouseLag._handler = onMove;
}
function disableMouseLag() {
  mouseLagOn = false;
  document.body.style.pointerEvents = "";
  if (enableMouseLag._handler) window.removeEventListener("mousemove", enableMouseLag._handler, true);
}

function setInk(el, text) {
  if (!el) return;
  el.dataset.ink = String(text || "").toUpperCase();
}

function activateSwitchPoint() {
  if (switchActive) return;
  switchActive = true;

  document.body.classList.add("invert", "collapse", "pinkmode");

  // Flicker effect after Big Switch, lasts until Notfallalarm popup
  if (!window._flickerActive) {
    window._flickerActive = true;
    window._flickerStartTime = performance.now();
    if (!window._flickerLoop) {
      window._flickerLoop = function flicker() {
        if (!window._flickerActive) {
          document.body.classList.remove("flicker");
          return;
        }
        document.body.classList.toggle("flicker");
        const elapsed = performance.now() - (window._flickerStartTime || performance.now());
        let min = 40, max = 80;
if (elapsed > 1500) { min = 120; max = 200; }
else if (elapsed > 600) { min = 70; max = 140; }

// 20% langsamer
min = Math.round(min * 1.2);
max = Math.round(max * 1.2);

setTimeout(window._flickerLoop, min + Math.random() * (max - min));

      };
    }
    window._flickerLoop();
  }

  setAmbientDistortion(true);

  const mobilLabel = $(".doc .field:first-child .label");
  const painLabel = $('label[for="pain"]');
  const foodLabel = $('label[for="food"]');

  setInk(mobilLabel, "Mach schneller!");
  setInk(painLabel, "Warum ist der Schmerz noch da?");
  setInk(foodLabel, "Du brauchst doch keine Mittagspause.");

  setInk($('label[for="bp"]'), "Bist du gestresst?");
  setInk($('label[for="temp"]'), "Werde doch nicht gleich rot im Gesicht.");
  setInk($('label[for="pulse"]'), "Ärgere ich dich?");
  setInk($('label[for="weight"]'), "Wie schwer es wohl für die anderen ist?");
  setInk($('label[for="defecation"]'), "Mach dir nicht ins Hemd.");
  setInk($('label[for="io"]'), "Das wird schon wieder...");

  enableMouseLag();
}

function deactivateSwitchPoint() {
  switchActive = false;
  document.body.classList.remove("invert", "collapse", "pinkmode");
  window._flickerActive = false;
  document.body.classList.remove("flicker");
  setAmbientDistortion(false);

  $$(".field .label, label.label").forEach((el) => {
    if (el && el.dataset) delete el.dataset.ink;
  });

  disableMouseLag();
}

/* =========================================================
   Colleague decision
========================================================= */
function applyDegradation() {
  degradation = Math.min(4, degradation + 1);
  document.body.dataset.degradation = String(degradation);

  if (degradation >= 2) {
    const inputs = [...document.querySelectorAll("input, textarea, select")];
    const victim = inputs[Math.floor(Math.random() * inputs.length)];
    victim?.blur();
  }
  if (degradation >= 3) addAlert("Warnung: Eingabequalität kritisch – sofort prüfen.", "red");
}

function colleagueSupportDecision() {
  if (finalPhase) return;

  openModalCard({
    title: "Achtung",
    body: "Kolleg:in bittet um kurzfristige Unterstützung.",
    level: "room",
    buttons: [
      {
        label: "OK, ich komme sofort.",
        primary: true,
        onClick: () => {
          playVoice("colleague_thanks");
          decisionOk("Reaktion – Kolleg:in", "„Danke. Schnell bitte — ich schaffe das sonst nicht allein.“");
        },
      },
      {
        label: "Später, ich muss erst dokumentieren.",
        primary: false,
        onClick: () => {
          applyDegradation();
          popupAlert("Hinweis", "Kolleg:in wirkt genervt. Unterstützung bleibt ausstehend.", "orange");
        },
      },
    ],
    onClose: () => window.scrollTo({ top: 0, behavior: "smooth" }),
  });
}

/* =========================================================
   Pressure ramp
========================================================= */
function startPressureRamp() {
  let t = 12_500;
  let interval = 35_000;
  const minInterval = 8_000;
  const accel = 0.86;
  const durationLimit = 205_000;

  const variants = [
    ["Hinweis", "Dokumentation überfällig – bitte abschließen.", "orange"],
    ["Rückfrage", "Angehörige möchten sofort Auskunft.", "orange"],
    ["Hinweis", "Telefon klingelt – Anruf verpasst.", "yellow"],
    ["Warnung", "Patient wirkt unruhig – Ursache unklar.", "yellow"],
    ["Warnung", "Pflegezeit pro Patient überschritten.", "orange"],
    ["Hinweis", "Pflegedokumentation entspricht nicht aktueller Richtlinie.", "orange"],
    ["Hinweis", "Neue interne Anweisung – Kenntnisnahme erforderlich.", "yellow"],
    ["Warnung", "Dokumentationsprüfung angekündigt.", "orange"],
    ["Warnung", "Abweichung zwischen Pflegebericht und Vitaldaten erkannt.", "orange"],
    ["System", "Eingabe verzögert (hohe Auslastung).", "yellow"],
    ["System", "Sitzung instabil – Eingabe ggf. wiederholen.", "orange"],
    ["Warnung", "Unvollständige Angaben erkannt – bitte prüfen.", "orange"],
  ];

  while (t < durationLimit) {
    scheduleAt(t, () => {
      if (finalPhase) return;
      const pick = variants[Math.floor(Math.random() * variants.length)];
      popupAlert(pick[0], pick[1], pick[2]);
    });

    t += interval;
    interval = Math.max(minInterval, Math.floor(interval * accel));
  }
}

/* =========================================================
   Tutorial overlay (Tour)
========================================================= */
function startTutorialThen(cb) {
  showScreen("system");

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      openTourOverlay(() => cb?.(true));
    });
  });
}

function openTourOverlay(onDone) {
  document.querySelector("#tour-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "tour-overlay";
  overlay.style.position = "fixed";
  overlay.style.inset = "0";
  overlay.style.zIndex = "99999";
  overlay.style.pointerEvents = "auto";

  const group = document.createElement("div");
  group.id = "tour-group";
  group.style.position = "absolute";
  group.style.left = "0";
  group.style.top = "0";
  group.style.width = "100%";
  group.style.height = "100%";
  group.style.transform = "translateX(20px)";
  overlay.appendChild(group);

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.style.position = "absolute";
  svg.style.left = "0";
  svg.style.top = "0";
  svg.style.pointerEvents = "none";
  group.appendChild(svg);

  const loginBtn =
    document.querySelector('#login-form button[type="submit"]') ||
    document.querySelector('#login-form button') ||
    document.querySelector('#screen-login button') ||
    document.querySelector('#screen-login .btn.primary');

  const loginBg = loginBtn ? getComputedStyle(loginBtn).backgroundColor : "rgb(0, 120, 255)";
  const loginFg = loginBtn ? getComputedStyle(loginBtn).color : "#fff";

  function withAlpha(rgbOrRgba, alpha) {
    const m = String(rgbOrRgba).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!m) return rgbOrRgba;
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function makeBox(text) {
    const box = document.createElement("div");
    box.className = "tour-box";
    box.innerHTML = text;
    box.style.position = "absolute";
    box.style.maxWidth = "360px";
    box.style.padding = "16px 18px";
    box.style.borderRadius = "14px";
    box.style.background = withAlpha(loginBg, 0.60);
    box.style.color = loginFg;
    box.style.fontSize = "16px";
    box.style.lineHeight = "1.25";
    box.style.boxShadow = "0 12px 30px rgba(0,0,0,0.35)";
    return box;
  }

  const bottomPx = 350;

  const boxL = makeBox("<strong>Raumübersicht:</strong> Hier siehst du offene Alarme und Aufgaben pro Raum.");
  const boxM = makeBox("<strong>Dokumentation:</strong> Trage Werte ein.");
  const boxR = makeBox("<strong>Reset:</strong> Setzt die Simulation zurück.");

  group.appendChild(boxL);
  group.appendChild(boxM);
  group.appendChild(boxR);

  boxL.style.left = "60px";
  boxL.style.bottom = `${bottomPx}px`;

  boxM.style.left = "50%";
  boxM.style.transform = "translateX(-50%)";
  boxM.style.bottom = `${bottomPx}px`;

  boxR.style.right = "60px";
  boxR.style.bottom = `${bottomPx}px`;

  const verstanden = document.createElement("button");
  verstanden.type = "button";
  verstanden.textContent = "Verstanden";
  verstanden.className = "tour-verstanden";
  verstanden.style.position = "absolute";
  verstanden.style.left = "50%";
  verstanden.style.transform = "translateX(-50%)";
  verstanden.style.bottom = `${bottomPx - 62}px`;
  verstanden.style.padding = "12px 18px";
  verstanden.style.borderRadius = "999px";
  verstanden.style.border = "0";
  verstanden.style.fontSize = "16px";
  verstanden.style.cursor = "pointer";
  verstanden.style.boxShadow = "0 10px 24px rgba(0,0,0,0.35)";
  verstanden.style.background = loginBg;
  verstanden.style.color = loginFg;
  verstanden.style.fontWeight = "700";

  group.appendChild(verstanden);

  function drawUpArrow(x, y1, y2) {
    const SHIFT_X = -20;
    const SHORTEN_Y = -20;

    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", String(x + SHIFT_X));
    line.setAttribute("y1", String(y1 + SHORTEN_Y));
    line.setAttribute("x2", String(x + SHIFT_X));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", loginBg);
    line.setAttribute("stroke-width", "5");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", "1");
    svg.appendChild(line);

    const head = document.createElementNS(svgNS, "path");
    const size = 14;
    const d = `
      M ${x + SHIFT_X - size} ${y2 + size}
      L ${x + SHIFT_X} ${y2}
      L ${x + SHIFT_X + size} ${y2 + size}
    `;
    head.setAttribute("d", d.trim());
    head.setAttribute("fill", "none");
    head.setAttribute("stroke", loginBg);
    head.setAttribute("stroke-width", "5");
    head.setAttribute("stroke-linecap", "round");
    head.setAttribute("stroke-linejoin", "round");
    head.setAttribute("opacity", "1");
    svg.appendChild(head);
  }

  const room1Box =
    document.querySelector('#todo-room1 .box') ||
    document.querySelector('#todo-room1') ||
    document.querySelector('.todo-item[data-room="1"]') ||
    document.querySelector('.room[data-room="1"] .box') ||
    document.querySelector('.room .box');

  const painField =
    document.querySelector("#pain") ||
    document.querySelector('[name="pain"]');

  const resetBtn =
    document.querySelector("#btn-reset") ||
    document.querySelector("#btnReset") ||
    document.querySelector("#reset") ||
    document.querySelector('button[data-action="reset"]');

  function layoutArrows() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const rL = boxL.getBoundingClientRect();
    const rM = boxM.getBoundingClientRect();
    const rR = boxR.getBoundingClientRect();

    const startLX = rL.left;
    const startLY = rL.top;
    if (room1Box) {
      const t = room1Box.getBoundingClientRect();
      drawUpArrow(startLX, startLY, t.top);
    }

    const startMX = rM.left + rM.width / 2;
    const startMY = rM.top;
    if (painField) {
      const t = painField.getBoundingClientRect();
      drawUpArrow(startMX, startMY, t.top);
    }

    const startRX = rR.right;
    const startRY = rR.top;
    if (resetBtn) {
      const t = resetBtn.getBoundingClientRect();
      drawUpArrow(startRX, startRY, t.bottom);
    }
  }

  layoutArrows();
  window.addEventListener("resize", layoutArrows, { passive: true });

  verstanden.addEventListener("click", () => {
    window.removeEventListener("resize", layoutArrows);
    overlay.remove();
    onDone?.();
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(layoutArrows);
}

/* =========================================================
   Intro + Start
========================================================= */
function showIntroThenStart() {
  setTimeout(playIntroVoice, 150);

  openModalCard({
    title: "Einleitung",
    body:
`Deine Aufgabe als Pflegekraft ist es, unter anderem dafür zu sorgen, dass alle Werte und Daten richtig dokumentiert werden.

Trage die von dir zuvor aufgezeichneten Werte von dem Notizblock in das Dokumentationssystem ein. Beachte, dass diese korrekt und vollständig sind. Gleichzeitig musst du auch deine Räume auf der Station immer im Blick halten.

Bleib konzentriert, denn wir sind die Augen und Ohren der Menschen, die auf unsere Hilfe angewiesen sind und deren Gesundheit auch zu unserer Verantwortung gehört.`,
    level: "intro",
    actionsAlign: "center",
    onClose: () => {
      stopIntroVoice();

      openModalCard({
        title: "Hinweis – Simulation",
        body: `Diese Simulation enthält akustische und inhaltliche Reize, sowie Stroboskopeffekte, die für empfindliche oder akustisch sensible Personen und für Personen mit Epilepsie oder lichtsensiblen Anfällen überwältigend oder belastend sein können.\n\nMit Simulation fortfahren ?`,
        level: "red",
        actionsAlign: "center",
        buttons: [
          {
            label: "JA",
            primary: true,
            onClick: () => {
              ended = false;
              startClock();
              startSequence();

              // Audio defensiv (Simulation läuft auch wenn Audio failt)
              try { stopAllAudio(); } catch {}
              try { startAmbient(); } catch {}
              try { startRandomBackground(); } catch {}
              try { startStepsRandom(); } catch {}
            }
          },
          {
            label: "NEIN",
            primary: false,
            onClick: () => {
              showScreen("login");
              loginError?.classList.add("hidden");
              if (pwInput) { pwInput.value = ""; pwInput.focus(); }
            }
          }
        ]
      });
    },
  });
}

/* =========================================================
   Sequence (NOTFALL/HERZALARM last)
========================================================= */
function startSequence() {
  ended = false;
  finalPhase = false;
  saveAttempts = 0;

  if (alertsEl) alertsEl.innerHTML = "";
  if (saveStatus) saveStatus.textContent = "";

  deactivateSwitchPoint();
  degradation = 0;
  document.body.dataset.degradation = "0";

  sequenceStartMs = performance.now();

  for (const id of [1, 2, 3, 4, 5]) {
    roomState[id].active = false;
    roomState[id].hasAlarmed = false;
    roomState[id].deferredCount = 0;
    roomState[id].resolved = false;
    cancelRoomRepeats(id);
    setRoomActive(id, false);
  }
  roomState[3].alarmCleared = false;

  startClock();
  startPressureRamp();

  scheduleAt(160_000, () => activateSwitchPoint());

  scheduleAt(40_000, () => alarmRoom(1, "Raum 1: Klingel aktiv."));
  scheduleAt(60_000, () => alarmRoom(2, "Raum 2: Klingel aktiv."));
  scheduleAt(78_000, () => alarmRoom(3, "Raum 3: Unterstützung erforderlich."));
  scheduleAt(120_000, () => alarmRoom(5, "Raum 5: Transport/Übergabe angefordert."));

  scheduleAt(95_000, () => colleagueSupportDecision());

  const END_AT = 225_500;

  scheduleAt(END_AT - 8_000, () => {
    finalPhase = true;
    for (const id of [1, 2, 3, 4, 5]) {
      cancelRoomRepeats(id);
      setRoomActive(id, false);
    }
    closeAllModals();
  });

  scheduleAt(END_AT - 6_000, () => {
    window._flickerActive = false;
    window._flickerStartTime = null;
    document.body.classList.remove("flicker");
    popupAlert("NOTFALLALARM", "Raum 10 – Patient bewusstlos.", "red");
    startEmergencyAlarm();
  });

  scheduleAt(END_AT - 3_500, () => {
    popupAlert("HERZALARM", "Herzalarm auslösen und holt den Notfallwagen.\nSofort!", "red");
    playVoice("heartalarm_call");
  });

  scheduleAt(END_AT, () => endSequence());
}

/* =========================================================
   End / Reset
========================================================= */
function injectEndFact() {
  const reveal = $("#reveal-state");
  if (!reveal) return;
  if ($("#end-fact-card")) return;

  const fact = document.createElement("div");
  fact.id = "end-fact-card";
  fact.className = "modal-card intro end-fact";
  fact.innerHTML = `
    <div class="modal-title">Fakt</div>
    <div class="modal-body">Bis 2030 fehlen in Deutschland 500.000 – 575.000 Pflegekräfte.</div>
    <div class="modal-actions center">
      <button class="btn primary" type="button" id="end-fact-ok">OK</button>
    </div>
  `;
  reveal.appendChild(fact);

  fact.querySelector("#end-fact-ok")?.addEventListener("click", () => fact.remove());
}

function endSequence() {
  if (ended) return;
  ended = true;

  setTimerRunning(false);
  finalPhase = true;

  setTimeout(() => {
    blackout?.classList.remove("hidden");

    setTimeout(() => {
      blackout?.classList.add("hidden");
      showScreen("end");

      // Fade out emergency alarm
      if (audio.emergencyAlarm) {
        try {
          const fadeSteps = 10;
          const fadeDuration = 1200;
          const fadeInterval = fadeDuration / fadeSteps;
          let fadeStep = 0;
          const originalVolume = audio.emergencyAlarm.volume;
          const fade = () => {
            fadeStep++;
            audio.emergencyAlarm.volume = Math.max(0, originalVolume * (1 - fadeStep / fadeSteps));
            if (fadeStep < fadeSteps && !audio.emergencyAlarm.paused) {
              setTimeout(fade, fadeInterval);
            } else {
              audio.emergencyAlarm.pause();
              audio.emergencyAlarm.currentTime = 0;
              audio.emergencyAlarm.volume = originalVolume;
            }
          };
          fade();
        } catch {}
      }

      // Fade out ambient
      if (audio.ambient) {
        try {
          const fadeSteps = 10;
          const fadeDuration = 1200;
          const fadeInterval = fadeDuration / fadeSteps;
          let fadeStep = 0;
          const originalVolume = audio.ambient.volume;
          const fade = () => {
            fadeStep++;
            audio.ambient.volume = Math.max(0, originalVolume * (1 - fadeStep / fadeSteps));
            if (fadeStep < fadeSteps && !audio.ambient.paused) {
              setTimeout(fade, fadeInterval);
            } else {
              audio.ambient.pause();
              audio.ambient.currentTime = 0;
              audio.ambient.volume = originalVolume;
            }
          };
          fade();
        } catch {}
      }

      $("#crash-state")?.classList.remove("hidden");
      $("#reveal-state")?.classList.add("hidden");

      setTimeout(() => {
        $("#crash-state")?.classList.add("hidden");
        $("#reveal-state")?.classList.remove("hidden");
        injectEndFact();
      }, 1400);

    }, 2000);
  }, 2000);
}

function resetAll() {
  ended = true;
  finalPhase = false;

  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  setTimerRunning(false);

  deactivateSwitchPoint();
  degradation = 0;
  document.body.dataset.degradation = "0";
  document.body.classList.remove("invert", "collapse", "pinkmode");
  window._flickerActive = false;
  window._flickerStartTime = null;
  window._flickerLoop = null;
  document.body.classList.remove("flicker");

  clearTimers();
  closeAllModals();

  stopAllAudio();

  for (const id of [1, 2, 3, 4, 5]) {
    cancelRoomRepeats(id);
    setRoomActive(id, false);
    roomState[id].hasAlarmed = false;
    roomState[id].resolved = false;
    roomState[id].deferredCount = 0;
  }
  roomState[3].alarmCleared = false;

  if (clockRAF) cancelAnimationFrame(clockRAF);
  clockRAF = null;

  docForm?.reset();
  ["mobil","food","pain","bp","pulse","temp","weight","defecation","io"].forEach((k) => showFieldError(k, false));
  if (saveStatus) saveStatus.textContent = "";

  $("#end-fact-card")?.remove();

  showScreen("login");
  loginError?.classList.add("hidden");
  if (pwInput) {
    pwInput.value = "";
    pwInput.focus();
  }
}

/* =========================================================
   Events / Boot
========================================================= */
function bindEvents() {
  const todoList = document.querySelector(".todo");
  if (todoList) {
    todoList.addEventListener("click", (e) => {
      const item = e.target.closest(".todo-item[data-room]");
      if (!item) return;
      showRoomDecision(Number(item.dataset.room));
    });
  }

  loginForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    loginError?.classList.add("hidden");

    const value = (pwInput?.value || "").trim().toLowerCase();
    if (!VALID_PASSWORDS.has(value)) {
      loginError?.classList.remove("hidden");
      return;
    }

    normalizeTimerOverlay();

    startTutorialThen((ok) => {
      if (!ok) return;
      showIntroThenStart();
    });
  });

  btnSave?.addEventListener("click", scriptedSave);
  btnFinish?.addEventListener("click", finishDoc);

  if (btnRestart) {
    btnRestart.addEventListener("click", (e) => {
      e.stopPropagation();
      resetAll();
    });
  }
  btnReset?.addEventListener("click", resetAll);

  // Degradation delay for buttons (except restart handled above)
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;

      const lvl = Number(document.body.dataset.degradation || 0);
      if (lvl <= 0) return;

      if (btn.id === "btn-restart") return; // never delay restart

      if (btn.dataset.delayedOnce === "1") {
        btn.dataset.delayedOnce = "0";
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      btn.dataset.delayedOnce = "1";

      const delay = 120 * lvl;
      setTimeout(() => btn.click(), delay);
    },
    true
  );

  installTimerGuards();
  pwInput?.focus();
}

function initDomRefs() {
  screens = {
    login: $("#screen-login"),
    system: $("#screen-system"),
    end: $("#screen-end"),
  };

  loginForm = $("#login-form");
  pwInput = $("#pw");
  loginError = $("#login-error");

  clockEl = $("#clock");
  alertsEl = $("#alerts");

  docForm = $("#doc-form");
  btnSave = $("#btn-save");
  btnFinish = $("#btn-finish");
  saveStatus = $("#save-status");

  modal = $("#modal");
  modalStack = $("#modal-stack");

  blackout = $("#blackout");
  btnRestart = $("#btn-restart");
  btnReset = $("#btn-reset");

  roomEls = {
    1: $("#todo-room1"),
    2: $("#todo-room2"),
    3: $("#todo-room3"),
    4: $("#todo-room4"),
    5: $("#todo-room5"),
  };
}

function boot() {
  initDomRefs();

  // Safety: if your HTML differs, at least show login
  showScreen("login");

  // Ensure timer overlay exists only once
  normalizeTimerOverlay();

  bindEvents();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
