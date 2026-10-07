/* speakrail live UI: the same ws protocol as web/app.js (16 kHz int16 up, 24 kHz int16 + JSON events down), presented as
 * a blob that moves with the voices, subtitles for the reply, and a card per web search. Settings live in the top-left
 * dropdown and are sent as query params on connect (they only apply on the next start). */
const $ = (id) => document.getElementById(id);
const CAPTURE_HZ = 16000;
const SETTINGS = ["barge", "search", "showlog", "pregenerate", "systemPrompt"];
const AUDIO_SETTINGS = ["microphone", "speaker"];
let voiceDepthCurrent = null;

let ws, micCtx, playCtx, worklet, stream, analyser, anaBuf, outGain;
let sources = [], playCursor = 0, uttStart = 0, uttId = 0;
const ijUtts = new Set();   // utts of v3 interjections (live tasks): never cut by the next utt
let running = false;

// ---------------------------------------------------------------- settings dropdown
const panel = $("panel"), gear = $("gear");
gear.onclick = (e) => { e.stopPropagation(); const open = panel.hidden; panel.hidden = !open; gear.setAttribute("aria-expanded", open); };
panel.onclick = (e) => e.stopPropagation();
document.addEventListener("click", () => { panel.hidden = true; gear.setAttribute("aria-expanded", "false"); });
for (const id of SETTINGS) {
  const el = $(id), saved = localStorage.getItem("speakrail." + id);
  if (saved != null) { if (el.type === "checkbox") el.checked = saved === "1"; else el.value = saved; }
  el.onchange = () => { localStorage.setItem("speakrail." + id, el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value); if (id === "showlog") $("log").hidden = !el.checked; };
}
const SYSTEM_PROMPT_MAX_BYTES = 1200;
function updateSystemPromptHint() {
  const bytes = new TextEncoder().encode($("systemPrompt").value).length;
  const hint = $("systemPromptHint");
  hint.textContent = bytes > SYSTEM_PROMPT_MAX_BYTES
    ? `Prompt is ${bytes} bytes; shorten it to ${SYSTEM_PROMPT_MAX_BYTES} bytes or less.`
    : `Added to Speakrail’s built-in prompt. Changes apply next start. ${bytes}/${SYSTEM_PROMPT_MAX_BYTES} bytes.`;
  hint.dataset.invalid = bytes > SYSTEM_PROMPT_MAX_BYTES ? "true" : "false";
}
$("systemPrompt").oninput = () => {
  localStorage.setItem("speakrail.systemPrompt", $("systemPrompt").value);
  updateSystemPromptHint();
};
updateSystemPromptHint();
$("log").hidden = !$("showlog").checked;
function lockSettings(lock) {
  for (const id of SETTINGS) if (id !== "showlog") $(id).disabled = lock;
  $("voiceDepth").disabled = lock;
  $("applyVoiceDepth").disabled = lock || Number($("voiceDepth").value) === voiceDepthCurrent;
}
for (const id of AUDIO_SETTINGS) {
  const saved = localStorage.getItem("speakrail." + id);
  if (saved != null) $(id).value = saved;
  $(id).onchange = () => localStorage.setItem("speakrail." + id, $(id).value);
}
function lockAudioSettings(lock) {
  for (const id of AUDIO_SETTINGS) $(id).disabled = lock;
  $("refreshDevices").disabled = lock;
  $("chooseSpeaker").disabled = lock;
}
async function refreshAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const [id, kind, label] of [["microphone", "audioinput", "Microphone"], ["speaker", "audiooutput", "Speaker"]]) {
      const select = $(id), selected = localStorage.getItem("speakrail." + id) || "";
      const matching = devices.filter((d) => d.kind === kind);
      select.replaceChildren(new Option("System default", ""));
      matching.forEach((d, i) => select.add(new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
      if (selected && matching.some((d) => d.deviceId === selected)) select.value = selected;
      else if (selected) {
        select.add(new Option("Saved device unavailable", selected));
        select.value = selected;
      } else select.value = "";
    }
    const named = devices.some((d) => d.label);
    const inputs = devices.filter((d) => d.kind === "audioinput").length;
    const outputs = devices.filter((d) => d.kind === "audiooutput").length;
    $("deviceHint").textContent = named
      ? `${inputs} mic${inputs === 1 ? "" : "s"}, ${outputs} speaker${outputs === 1 ? "" : "s"} found. Changes apply next start.`
      : "Click Find devices to grant access and list your mic and speakers.";
  } catch (_) { /* Device enumeration is optional; browser defaults still work. */ }
}
$("refreshDevices").onclick = async () => {
  const button = $("refreshDevices"); button.disabled = true;
  try {
    const temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    temporaryStream.getTracks().forEach((track) => track.stop());
    await refreshAudioDevices();
  } catch (e) {
    $("deviceHint").textContent = "Could not access devices: " + e.message;
  } finally { button.disabled = running; }
};
$("chooseSpeaker").onclick = async () => {
  const button = $("chooseSpeaker"); button.disabled = true;
  try {
    if (!navigator.mediaDevices?.selectAudioOutput) {
      throw new Error("This browser has no speaker picker. Connect the headset to the device running your browser, then use Find devices.");
    }
    const device = await navigator.mediaDevices.selectAudioOutput();
    await refreshAudioDevices();
    const select = $("speaker");
    let option = [...select.options].find((o) => o.value === device.deviceId);
    if (!option) { option = new Option(device.label || "Selected speaker", device.deviceId); select.add(option); }
    select.value = device.deviceId;
    localStorage.setItem("speakrail.speaker", device.deviceId);
    $("deviceHint").textContent = `${device.label || "Speaker selected"}. It will be used next start.`;
  } catch (e) {
    if (e.name !== "NotAllowedError") $("deviceHint").textContent = e.message;
  } finally { button.disabled = running; }
};
refreshAudioDevices();
navigator.mediaDevices?.addEventListener?.("devicechange", refreshAudioDevices);

// AMD Breeze codebook depth is process-wide: applying a changed value safely reloads the TTS worker.
async function refreshVoiceDepth() {
  try {
    const r = await fetch("/api/voice-depth", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    voiceDepthCurrent = Number(data.levels);
    if (!Number.isInteger(voiceDepthCurrent)) return;
    $("voiceFidelity").hidden = false;
    $("voiceDepth").value = String(voiceDepthCurrent);
    $("voiceDepthValue").value = String(voiceDepthCurrent);
    $("applyVoiceDepth").disabled = true;
    $("voiceDepthHint").textContent = `Active: ${voiceDepthCurrent} levels. Higher levels preserve more voice detail; changing this restarts TTS.`;
  } catch (_) { /* Non-AMD TTS servers do not expose this setting. */ }
}
$("voiceDepth").oninput = () => {
  const value = Number($("voiceDepth").value);
  $("voiceDepthValue").value = String(value);
  $("applyVoiceDepth").disabled = running || value === voiceDepthCurrent;
};
$("applyVoiceDepth").onclick = async () => {
  const button = $("applyVoiceDepth"), slider = $("voiceDepth"), hint = $("voiceDepthHint");
  const levels = Number(slider.value);
  button.disabled = true; slider.disabled = true; button.textContent = "Restarting TTS…";
  hint.textContent = `Switching to ${levels} levels. Speech will resume when TTS finishes warming up.`;
  try {
    const r = await fetch("/api/voice-depth", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ levels }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    const started = Date.now();
    const poll = async () => {
      try {
        const status = await fetch("/api/voice-depth", { cache: "no-store" });
        const current = status.ok ? await status.json() : null;
        if (current && !current.restarting && Number(current.levels) === levels) {
          voiceDepthCurrent = levels; slider.disabled = false; button.textContent = "Apply and restart TTS";
          hint.textContent = `Active: ${levels} levels. Higher levels preserve more voice detail; changing this restarts TTS.`;
          return;
        }
      } catch (_) { /* TTS is reloading; retry. */ }
      if (Date.now() - started > 300000) {
        slider.disabled = false; button.textContent = "Apply and restart TTS";
        hint.textContent = "TTS is taking a while to restart. Reload this page to check its status.";
        return;
      }
      setTimeout(poll, 2500);
    };
    setTimeout(poll, 2500);
  } catch (e) {
    slider.disabled = false; button.textContent = "Apply and restart TTS"; button.disabled = false;
    hint.textContent = "Could not change voice fidelity: " + e.message;
  }
};
refreshVoiceDepth();

// ---------------------------------------------------------------- blob
const canvas = $("blob"), ctx = canvas.getContext("2d");
const orbColors = getComputedStyle(document.documentElement);
const orbIce = orbColors.getPropertyValue("--orb-ice-rgb").trim();
const orbCyan = orbColors.getPropertyValue("--orb-cyan-rgb").trim();
const orbBlue = orbColors.getPropertyValue("--orb-blue-rgb").trim();
const orbIndigo = orbColors.getPropertyValue("--orb-indigo-rgb").trim();
const orbDeep = orbColors.getPropertyValue("--orb-deep-rgb").trim();
const lvl = { mic: 0, micTarget: 0, head: 0, bot: 0, botTarget: 0 };   // 0..1, smoothed in the draw loop
let botSpeaking = false;
function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize); resize();

function drawBlob(t) {
  const w = canvas.clientWidth, h = canvas.clientHeight, cx = w / 2, cy = h / 2;
  ctx.clearRect(0, 0, w, h);
  // smoothing: fast attack, slow release, so a syllable shows and the shape settles gently
  lvl.mic += (lvl.micTarget - lvl.mic) * (lvl.micTarget > lvl.mic ? 0.35 : 0.06);
  lvl.bot += (lvl.botTarget - lvl.bot) * (lvl.botTarget > lvl.bot ? 0.4 : 0.08);
  const user = Math.min(1, lvl.mic * 1.6 + lvl.head * 0.4);       // the mic level, lifted by the turn head's P(speaking)
  const bot = Math.min(1, lvl.bot * 1.8);
  const base = Math.min(w, h) * 0.28;
  const breathe = 1 + 0.008 * Math.sin(t * 0.0007);
  const R = base * breathe * (1 + user * 0.018 + bot * 0.025);
  const amp = 0.006 + user * 0.018 + bot * 0.014;                 // keep the sphere round; speech adds only a soft ripple
  const s = t * 0.001;
  const N = 180, pts = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const n = 0.5 * Math.sin(3 * a + s * 1.1) + 0.3 * Math.sin(5 * a - s * 0.8 + 1.0) + 0.2 * Math.sin(7 * a + s * 1.7 + 2.0)
            + user * 0.35 * Math.sin(11 * a - s * 6.0);           // a fine ripple only while the user talks
    const r = R * (1 + amp * n);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  const path = new Path2D();
  for (let i = 0; i < N; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % N], mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2;
    if (i === 0) path.moveTo(mx, my); else path.quadraticCurveTo(p0[0], p0[1], mx, my);
  }
  const p0 = pts[0], p1 = pts[1]; path.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
  path.closePath();

  // Quiet blue aura; it swells with playback rather than washing out the dark page.
  const glow = ctx.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.55);
  const halo = 0.025 + bot * 0.085 + user * 0.025;
  glow.addColorStop(0, `rgba(${orbBlue},${halo})`);
  glow.addColorStop(1, `rgba(${orbBlue},0)`);
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

  // Smooth periwinkle sphere, with the brighter blue above and a pale lavender base.
  const fill = ctx.createLinearGradient(cx - R * 0.12, cy - R, cx + R * 0.12, cy + R);
  fill.addColorStop(0, "rgb(75,101,215)");
  fill.addColorStop(0.36, `rgb(${orbBlue})`);
  fill.addColorStop(0.7, `rgb(${orbIndigo})`);
  fill.addColorStop(1, `rgb(${orbDeep})`);
  ctx.shadowColor = `rgba(${orbBlue},0.16)`; ctx.shadowBlur = 20 + bot * 22;
  ctx.fillStyle = fill; ctx.fill(path);
  ctx.shadowBlur = 0;

  // The soft white-blue cloud band and its brighter upper-right curl echo the reference.
  ctx.save(); ctx.clip(path);
  const drift = Math.sin(t * 0.00012) * R * 0.035;
  ctx.translate(cx + drift, cy + drift * 0.5);
  ctx.rotate(-0.39);
  ctx.scale(1, 0.39);
  const cloud = ctx.createLinearGradient(-R * 1.25, 0, R * 1.25, 0);
  cloud.addColorStop(0, "rgba(248,250,255,0)");
  cloud.addColorStop(0.24, "rgba(248,250,255,0.06)");
  cloud.addColorStop(0.43, `rgba(${orbIce},${0.28 + bot * 0.12})`);
  cloud.addColorStop(0.56, `rgba(${orbIce},${0.54 + bot * 0.12})`);
  cloud.addColorStop(0.68, `rgba(${orbIce},${0.20 + bot * 0.12})`);
  cloud.addColorStop(0.82, "rgba(248,250,255,0.09)");
  cloud.addColorStop(1, "rgba(248,250,255,0)");
  ctx.fillStyle = cloud; ctx.fillRect(-R * 1.3, -R * 1.6, R * 2.6, R * 3.2);
  ctx.restore();

  ctx.save(); ctx.clip(path);
  const flareX = cx + R * 0.58, flareY = cy - R * 0.34;
  const flare = ctx.createRadialGradient(flareX, flareY, 0, flareX, flareY, R * 0.82);
  flare.addColorStop(0, `rgba(${orbIce},${0.54 + bot * 0.12})`);
  flare.addColorStop(0.24, `rgba(${orbIce},${0.28 + bot * 0.10})`);
  flare.addColorStop(1, `rgba(${orbIce},0)`);
  ctx.fillStyle = flare; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // Diffuse cloudlets soften the band edge; their slow drift keeps the idle orb alive.
  for (const [x, y, size, alpha, phase] of [
    [-0.48, 0.28, 0.64, 0.22, 0.3], [0.18, 0.06, 0.72, 0.16, 1.7], [0.63, -0.31, 0.48, 0.20, 2.8],
  ]) {
    const px = cx + R * (x + Math.sin(t * 0.00016 + phase) * 0.025);
    const py = cy + R * (y + Math.cos(t * 0.00013 + phase) * 0.018);
    const mist = ctx.createRadialGradient(px, py, 0, px, py, R * size);
    mist.addColorStop(0, `rgba(${orbIce},${alpha + bot * 0.06})`);
    mist.addColorStop(0.5, `rgba(${orbIce},${alpha * 0.38})`);
    mist.addColorStop(1, `rgba(${orbIce},0)`);
    ctx.fillStyle = mist; ctx.fillRect(px - R * size, py - R * size, R * size * 2, R * size * 2);
  }
  ctx.restore();

  ctx.strokeStyle = `rgba(${orbIce},${0.08 + bot * 0.06})`; ctx.lineWidth = 1; ctx.stroke(path);

  // the assistant's voice: a second, thinner membrane pulsing outside the body
  if (bot > 0.02) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2, r = R * (1.015 + bot * 0.045 + 0.008 * Math.sin(9 * a + s * 2));
      i ? ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    ctx.strokeStyle = `rgba(${orbCyan},${0.12 + bot * 0.28})`; ctx.lineWidth = 1.5; ctx.stroke();
  }
  // output level from the playback analyser (drives `bot`)
  if (analyser && botSpeaking) {
    analyser.getFloatTimeDomainData(anaBuf);
    let sum = 0; for (let i = 0; i < anaBuf.length; i++) sum += anaBuf[i] * anaBuf[i];
    lvl.botTarget = Math.min(1, Math.sqrt(sum / anaBuf.length) * 6);
  } else lvl.botTarget = 0;
  requestAnimationFrame(drawBlob);
}
requestAnimationFrame(drawBlob);

// ---------------------------------------------------------------- subtitles
const subUser = $("user"), subBot = $("bot");
let botRaw = "", userRaw = "", fadeTimer = null;
const clean = (s) => s.replace(/<\|[a-z_]+:[a-z_]+\|>/g, "").replace(/<\|[^>]*$/, "").replace(/\((laugh|sigh|cough|clears throat)\)/g, "").replace(/\s+/g, " ").trim();
function showUser(text) { userRaw = text; subUser.textContent = text; subUser.classList.toggle("show", !!text); }
function showBot(text, cut) {
  botRaw = text; subBot.textContent = clean(text); subBot.classList.add("show"); subBot.classList.toggle("cut", !!cut);
  clearTimeout(fadeTimer);
}
function fadeBotLater(ms) { clearTimeout(fadeTimer); fadeTimer = setTimeout(() => { subBot.classList.remove("show"); subUser.classList.remove("show"); }, ms); }

// ---------------------------------------------------------------- search cards
const cards = $("cards"); const cardByTurn = {};
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function cardSearch(m) {
  for (const t in cardByTurn) if (+t !== m.turn) dropCard(+t);
  const c = document.createElement("div"); c.className = "card";
  c.innerHTML = `<div class="head"><span class="spin"></span>Searching the web<span class="meta">…</span></div><div class="q">${esc(m.query)}</div>`;
  cards.appendChild(c); cardByTurn[m.turn] = c;
  clearTimeout(c.ttl); c.ttl = setTimeout(() => dropCard(m.turn), 40000);
}
function cardDone(m) {
  const c = cardByTurn[m.turn]; if (!c) return;
  const head = c.querySelector(".head");
  head.innerHTML = (m.n < 0 ? "Search failed" : "Web search") + `<span class="meta">${m.n < 0 ? "" : m.n + " results · "}${m.ms} ms</span>`;
  const res = (m.results || []).slice(0, 4);
  if (!res.length) c.insertAdjacentHTML("beforeend", `<div class="none">${m.n < 0 ? "The search did not answer in time." : "Nothing useful came back."}</div>`);
  for (const r of res) {
    let host = ""; try { host = new URL(r.url).host.replace(/^www\./, ""); } catch (e) {}
    c.insertAdjacentHTML("beforeend", `<div class="res"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.snippet)}</div><div class="u">${esc(host)}</div></div>`);
  }
}
// tool cards: one per call (drops after 20 s) + a pinned "Memory" card with the session's notes / lists / todos / counters
const TOOL_TITLE = {claude_code: "Claude", task_status: "Task status", cancel_task: "Task cancelled", reset_chat: "Reset chat", record_note: "Note saved", list_add: "Added to list", todo_add: "To-do added", counter: "Counter",
  stopwatch: "Stopwatch", get_weather: "Weather", unit_convert: "Convert", calculator: "Calculator", dice_roll: "Dice", get_time: "Time"};
let toolN = 0;
function cardTool(m) {
  const c = document.createElement("div"); c.className = "card tool"; const key = "tool" + (++toolN);
  const args = Object.entries(m.args || {}).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
  const r = m.result || {};
  const res = r.error ? `<div class="none">${esc(r.error)}</div>`
    : `<div class="kv">${Object.entries(r).map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(typeof v === "string" ? v : JSON.stringify(v))}</span>`).join("")}</div>`;
  c.innerHTML = `<div class="head">${esc(TOOL_TITLE[m.name] || m.name)}<span class="meta">${esc(m.name)} · ${m.ms} ms</span></div>` +
    (args ? `<div class="args">${esc(args)}</div>` : "") + res;
  cards.appendChild(c); cardByTurn[key] = c; setTimeout(() => dropCard(key), 20000);
  if (["record_note", "list_add", "todo_add", "counter"].includes(m.name)) cardMemory(m.store || {});
}
function cardMemory(st) {
  let c = $("memcard");
  if (!c) { c = document.createElement("div"); c.className = "card mem"; c.id = "memcard"; cards.prepend(c); }
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
  let h = `<div class="head">Memory<span class="meta">this session</span></div>`;
  if ((st.notes || []).length) h += `<div class="sec">Notes</div><ul>${li(st.notes)}</ul>`;
  for (const [name, items] of Object.entries(st.lists || {})) h += `<div class="sec">${esc(name)}</div><ul>${li(items)}</ul>`;
  if ((st.todos || []).length) h += `<div class="sec">To-do</div><ul>${li(st.todos.map((t) => t.text + (t.due ? " (" + t.due + ")" : "")))}</ul>`;
  const cs = Object.entries(st.counters || {});
  if (cs.length) h += `<div class="sec">Counters</div><div class="kv">${cs.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${v}</span>`).join("")}</div>`;
  c.innerHTML = h;
}
function dropCard(turn) { const c = cardByTurn[turn]; if (!c) return; delete cardByTurn[turn]; c.classList.add("gone"); setTimeout(() => c.remove(), 450); }

// ---------------------------------------------------------------- timings log (optional)
function logTurn(m) {
  const f = (v) => (v == null ? "–" : v + " ms");
  const line = document.createElement("div");
  line.innerHTML = `<b>#${m.turn}</b> word end→ear ${f(m.word_end_to_ear)} · ttft ${f(m.llm_ttft)} · tts ${f(m.tts_ttfa)}` +
    (m.search ? ` · search ${f(m.search_ms)} (${m.search_n} res)` : "") + (m.cut ? ` · cut: ${m.cut}` : "");
  const log = $("log"); log.appendChild(line); while (log.children.length > 6) log.firstChild.remove();
}

// ---------------------------------------------------------------- state & events
function setState(s) { const e = $("state"); e.className = "pill " + s; e.textContent = s; }

function onMessage(ev) {
  if (ev.data instanceof ArrayBuffer) { const dv = new DataView(ev.data); playChunk(dv.getUint16(0, true), new Int16Array(ev.data, 4)); return; }
  const m = JSON.parse(ev.data);
  switch (m.type) {
    case "ready": break;
    case "head": lvl.head = m.p[0]; break;
    case "word": showUser(userRaw + m.raw); break;
    case "endpoint": showUser(m.text); break;
    case "backchannel": showUser(""); break;
    case "interject": ijUtts.add(m.utt); showBot(m.text, false); fadeBotLater(3000); break;
    case "reply_start": setState("thinking"); botRaw = ""; break;
    case "reply_delta": if (!botSpeaking) { botSpeaking = true; setState("speaking"); } showBot(botRaw + m.text, false); break;
    case "search": cardSearch(m); break;
    case "search_done": cardDone(m); break;
    case "tool": cardTool(m); break;
    case "reply_end": botSpeaking = false; setState("listening"); userRaw = ""; fadeBotLater(6000); break;
    case "stop_audio": stopPlayback(); botSpeaking = false; setState("listening"); if (botRaw) showBot(botRaw, true); userRaw = ""; fadeBotLater(2500); break;
    case "turn": logTurn(m); break;
    case "duck": if (outGain) outGain.gain.setTargetAtTime(m.gain, playCtx.currentTime, 0.03); break;
    case "error": setState("error"); showBot("error in " + m.where + ": " + m.detail, true); break;
    case "reset": showBot("(new chat" + (m.instructions ? ": " + m.instructions : "") + ")", false); fadeBotLater(4000); break;   // reset_chat
  }
}

// ---------------------------------------------------------------- audio (as in web/app.js)
const WORKLET = `class Cap extends AudioWorkletProcessor { process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(new Float32Array(ch)); return true; } } registerProcessor('cap', Cap);`;

async function start() {
  if (new TextEncoder().encode($("systemPrompt").value).length > SYSTEM_PROMPT_MAX_BYTES) {
    updateSystemPromptHint();
    $("systemPrompt").focus();
    return;
  }
  $("go").disabled = true;
  let micId = $("microphone").value;
  if (micId && ![...$("microphone").options].some((o) => o.value === micId && o.value)) {
    micId = ""; localStorage.removeItem("speakrail.microphone"); $("microphone").value = "";
  }
  try {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: CAPTURE_HZ };
    if (micId) audio.deviceId = { exact: micId };
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) { setState("error"); showBot("Microphone denied: " + e.message, true); $("go").disabled = false; return; }
  await refreshAudioDevices();
  playCtx = new AudioContext({ sampleRate: 24000 }); await playCtx.resume();
  const speakerId = $("speaker").value;
  if (speakerId) {
    try {
      if (typeof playCtx.setSinkId !== "function") throw new Error("Speaker selection is not supported by this browser");
      await playCtx.setSinkId(speakerId);
    } catch (e) {
      showBot("Could not select speaker: " + e.message, true);
      playCtx.close(); stream.getTracks().forEach((t) => t.stop()); stream = null;
      $("go").disabled = false; setState("error"); return;
    }
  }
  analyser = playCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5; anaBuf = new Float32Array(analyser.fftSize);
  analyser.connect(playCtx.destination);
  outGain = playCtx.createGain(); outGain.connect(analyser);      // ducking: lower our volume while the user talks over a reply
  micCtx = new AudioContext({ sampleRate: CAPTURE_HZ });
  await micCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));

  const prompt = encodeURIComponent($("systemPrompt").value);
  const qs = `?barge=${$("barge").value}&search=${$("search").value}&pregenerate=${$("pregenerate").checked ? "1" : "0"}&system_prompt=${prompt}`;
  const ck = new URLSearchParams(location.search).get("ck");     // the claude_code access key, if the page has one
  const wsUrl = new URL("ws" + qs + (ck ? "&ck=" + encodeURIComponent(ck) : ""), location.href); wsUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(wsUrl); ws.binaryType = "arraybuffer";
  ws.onmessage = onMessage;
  ws.onclose = () => { if (running) stop(true); };
  ws.onerror = () => setState("error");
  await new Promise((r) => (ws.onopen = r));

  worklet = new AudioWorkletNode(micCtx, "cap");
  worklet.port.onmessage = (ev) => {
    const f = ev.data, src = micCtx.sampleRate === CAPTURE_HZ ? f : downsample(f, micCtx.sampleRate, CAPTURE_HZ);
    const pcm = new Int16Array(src.length); let peak = 0;
    for (let i = 0; i < src.length; i++) { pcm[i] = Math.max(-1, Math.min(1, src[i])) * 32767; peak = Math.max(peak, Math.abs(src[i])); }
    lvl.micTarget = Math.min(1, peak * 2.5);
    if (ws.readyState === 1) ws.send(pcm.buffer);
  };
  micCtx.createMediaStreamSource(stream).connect(worklet);
  worklet.connect(micCtx.destination);
  running = true; lockSettings(true); lockAudioSettings(true);
  $("go").hidden = true; $("controls").hidden = false;
  setState("listening");
}

function stop(fromClose) {
  running = false;
  if (ws && !fromClose && ws.readyState === 1) ws.send(JSON.stringify({ cmd: "stop" }));
  stopPlayback(); botSpeaking = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (playCtx) playCtx.close();
  stream = null; playCtx = null;
  if (micCtx) micCtx.close();
  lvl.micTarget = 0; lvl.head = 0;
  $("controls").hidden = true; $("go").hidden = false; $("go").disabled = false; lockSettings(false); lockAudioSettings(false);
  setState("idle");
}

function downsample(buf, from, to) {
  const ratio = from / to, out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = buf[Math.floor(i * ratio)];
  return out;
}
function stopPlayback() { for (const s of sources) { try { s.stop(); } catch (e) {} } sources = []; playCursor = 0; uttStart = 0; }
function playChunk(utt, pcm) {
  if (utt !== uttId) {                 // a new utt cuts the old one, unless the old one was an interjection: queue after it
    if (ijUtts.has(uttId)) uttStart = 0; else stopPlayback();
    uttId = utt;
  }
  const buf = playCtx.createBuffer(1, pcm.length, playCtx.sampleRate), ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = playCtx.createBufferSource(); src.buffer = buf; src.connect(outGain || analyser);
  const now = playCtx.currentTime;
  if (playCursor < now) playCursor = now + 0.008;
  if (uttStart === 0) { uttStart = playCursor; ws.send(JSON.stringify({ cmd: "play_start", utt: utt, delay_ms: (playCursor - now) * 1000 })); }
  src.start(playCursor); playCursor += pcm.length / playCtx.sampleRate;
  sources.push(src); src.onended = () => { sources = sources.filter((s) => s !== src); };
}

$("go").onclick = start;
$("stop").onclick = () => stop(false);
$("interrupt").onclick = () => ws && ws.readyState === 1 && ws.send(JSON.stringify({ cmd: "interrupt" }));
$("reconnect").onclick = () => ws && ws.readyState === 1 && ws.send(JSON.stringify({ cmd: "reconnect_asr" }));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && running && !["SELECT", "INPUT", "BUTTON"].includes(document.activeElement.tagName)) { e.preventDefault(); $("interrupt").click(); }
});

// ?demo=1: a static preview of the running state (subtitles + a search card + a moving blob), no microphone needed
if (new URLSearchParams(location.search).get("demo") === "1") {
  if (new URLSearchParams(location.search).get("settings") === "1") panel.hidden = false;
  $("go").hidden = true; $("controls").hidden = false; setState("speaking");
  showUser("What's the weather like in Berlin right now?");
  cardSearch({ turn: 1, query: "current weather in Berlin" });
  cardDone({ turn: 1, n: 5, ms: 379, results: [
    { title: "Berlin, Berlin, Germany Weather Forecast - AccuWeather", snippet: "Today. 9/19. 70° 59°. Breezy this morning. Night: Partly to mostly cloudy.", url: "https://www.accuweather.com/en/de/berlin/10178/weather-forecast/178087" },
    { title: "Berlin - BBC Weather", snippet: "Light rain and a gentle breeze. Sunny intervals and a moderate breeze later in the week.", url: "https://www.bbc.com/weather/2950159" },
    { title: "Weather Forecast and Conditions for Berlin, Germany - The Weather Channel", snippet: "Today's Outlook · 1 pm 65° · 2 pm 66° · Partly cloudy with a light breeze.", url: "https://weather.com/weather/today/l/Berlin" }] });
  showBot("One sec, looking that up, Right now, it is around sixty-five degrees and partly cloudy in Berlin. It feels like about sixty-six degrees with a light breeze.", false);
  let ph = 0; setInterval(() => { ph += 0.09; lvl.micTarget = Math.max(0, 0.45 * Math.sin(ph) + 0.2 * Math.sin(ph * 3.1)); lvl.head = 0.8; }, 40);
}
