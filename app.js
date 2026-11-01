// LFM3 de poche — logique de l'interface

const MODELS = {
  std:   { id: "onnx-community/LFM3-1.7B-ONNX", device: "webgpu", dtype: "q4f16", label: "LFM3-1.7B · standard",   size: "1,4 Go" },
  light: { id: "daveycodez/LFM3-1.7B-Web",     device: "webgpu", dtype: "q4f16", noF16: true, label: "LFM3-1.7B · allégée",    size: "0,9 Go" },
  std_f16: { id: "onnx-community/LFM3-1.7B-ONNX", device: "webgpu", dtype: "q4f16", label: "", size: "", internal: true },
  cpu:   { id: "onnx-community/LFM3-1.7B-ONNX", device: "wasm",   dtype: "q4",    label: "LFM3-1.7B · processeur", size: "1,6 Go" },
};
// Version réellement utilisée : sans demi-précision (f16) sur la carte graphique,
// la version standard passe en pleine précision (« q4 », mêmes fichiers que le mode processeur).
function cfg(key) {
  const m = MODELS[key];
  if (m.internal) return m;
  if (m.device === "webgpu" && state.gpuOk && !state.f16 && m.dtype === "q4f16") {
    return m.noF16 ? { ...m, unsupported: true } : { ...m, dtype: m.noF16Dtype || "q4" };
  }
  return m;
}

const DEFAULT_SYSTEM = "Tu es un assistant utile, clair et concis. Réponds dans la langue de l'utilisateur.";
const MAX_HISTORY = 12; // nombre de messages renvoyés au modèle (sa mémoire de conversation)

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const state = {
  modelKey: store.get("modelKey", "std"),
  thinking: store.get("thinking", false),
  system: store.get("system", DEFAULT_SYSTEM),
  messages: store.get("messages", []),
  ready: false,
  gpuOk: false,
  f16: false,
  busy: false,
  loading: false,
};

/* ---------- Moteur (worker, ou page en secours) ---------- */

let send = null;            // fonction pour envoyer un message au moteur
let handlers = [];          // écouteurs des messages du moteur
const onEngine = (fn) => { handlers.push(fn); return () => { handlers = handlers.filter((h) => h !== fn); }; };
const dispatch = (msg) => handlers.forEach((h) => h(msg));

async function startEngine() {
  // 1) Essai dans un Web Worker (l'interface reste fluide pendant la génération)
  const viaWorker = await new Promise((resolve) => {
    let w;
    try { w = new Worker(new URL("./worker.js", import.meta.url), { type: "module" }); }
    catch { return resolve(null); }
    const timer = setTimeout(() => { w.terminate(); resolve(null); }, 8000);
    w.onerror = () => { clearTimeout(timer); w.terminate(); resolve(null); };
    w.onmessage = (e) => {
      if (e.data.type === "capabilities") {
        clearTimeout(timer);
        if (e.data.webgpu || !navigator.gpu) {
          w.onmessage = (ev) => dispatch(ev.data);
          w.onerror = (ev) => dispatch({ type: "error", message: ev.message || "Erreur du moteur" });
          resolve((msg) => w.postMessage(msg));
        } else {
          // WebGPU existe dans la page mais pas dans le worker : on passe en mode page
          w.terminate(); resolve(null);
        }
      }
    };
  });
  if (viaWorker) { send = viaWorker; return "worker"; }

  // 2) Secours : moteur directement dans la page
  const engine = await import("./engine.js");
  send = async (msg) => {
    try {
      if (msg.type === "load") await engine.load(msg.model, dispatch, msg.opts);
      else if (msg.type === "generate") await engine.generate(msg.messages, msg.opts || {}, dispatch);
      else if (msg.type === "stop") engine.stop();
      else if (msg.type === "unload") { await engine.unload(); dispatch({ type: "unloaded" }); }
    } catch (err) {
      dispatch({ type: "error", during: msg.type, message: String(err?.message || err) });
    }
  };
  return "page";
}

/* ---------- Cache du modèle ---------- */

// Un fichier appartient à une version du modèle s'il vient de son dépôt et porte sa précision
const belongsTo = (url, m) => url.includes(m.id) && url.includes(`/model_${m.dtype}.onnx`);

async function isModelCached(key) {
  const m = cfg(key);
  if (!("caches" in window)) return false;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith("lfm3-")) continue;
      const keys = await (await caches.open(name)).keys();
      if (keys.some((r) => belongsTo(r.url, m))) return true;
    }
  } catch {}
  return false;
}

async function deleteModelCache(key) {
  const m = cfg(key);
  let n = 0;
  for (const name of await caches.keys()) {
    if (name.startsWith("lfm3-")) continue;
    const c = await caches.open(name);
    for (const r of await c.keys()) {
      if (belongsTo(r.url, m)) { await c.delete(r); n++; }
    }
  }
  return n;
}

/* ---------- Petits utilitaires ---------- */

const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(2).replace(".", ",") + " Go" : Math.round(b / 1e6) + " Mo";
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isMobile = () => isIOS() || /Android/.test(navigator.userAgent);
const isChromium = () => /Chrome|Chromium|Edg\//.test(navigator.userAgent) && !isIOS();
// La carte graphique a « décroché » (pilote planté ou réinitialisé)
const GPU_LOST = /Instance reference no longer exists|device (was |is )?lost|DeviceLost|mapAsync|Failed to download data from buffer/i;
// Bascule vers le mode processeur : on recharge la page pour repartir d'un état propre
const goCpu = () => { store.set("modelKey", "cpu"); location.reload(); };

const isLinux = () => /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
let installPrompt = null; // invitation d'installation de Chrome/Edge

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Rendu Markdown minimal et sûr (le texte est échappé avant toute mise en forme)
function renderMarkdown(src) {
  const blocks = [];
  src = src.replace(/```[\w-]*\n?([\s\S]*?)(```|$)/g, (_, code, end) => {
    if (!end) code = code.replace(/`{1,2}$/, ""); // fin de bloc pas encore arrivée
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (t) => escapeHtml(t)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of src.split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (/^\u0000\d+\u0000$/.test(line.trim())) { closeList(); out.push(line.trim()); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`); continue;
    }
    closeList();
    if ((m = line.match(/^#{1,6}\s+(.*)/))) { out.push(`<h4>${inline(m[1])}</h4>`); continue; }
    if (line.trim() === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n").replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}

// Sépare l'éventuel raisonnement (<think>…</think>) de la réponse
function splitThinking(text) {
  const open = text.indexOf("<think>");
  if (open === -1) return { think: "", answer: text, thinkingOpen: false };
  const close = text.indexOf("</think>", open);
  if (close === -1) return { think: text.slice(open + 7), answer: "", thinkingOpen: true };
  return { think: text.slice(open + 7, close).trim(), answer: (text.slice(0, open) + text.slice(close + 8)).trim(), thinkingOpen: false };
}

function renderBot(el, text, streaming) {
  const { think, answer, thinkingOpen } = splitThinking(text);
  let html = "";
  if (think) {
    html += `<details${thinkingOpen ? " open" : ""}><summary>${thinkingOpen ? "Réflexion en cours…" : "Voir la réflexion"}</summary>${renderMarkdown(think)}</details>`;
  }
  if (answer) html += renderMarkdown(answer);
  else if (!think && streaming) html = `<span class="typing"><span></span><span></span><span></span></span>`;
  el.querySelector(".body").innerHTML = html;
  el.querySelector(".body").classList.toggle("cursor", streaming && !!answer);
}

/* ---------- Affichage ---------- */

function show(view) {
  $("setup").hidden = view !== "setup";
  $("chat").hidden = view !== "chat";
  $("composer").hidden = view !== "chat";
}

function updateNetChip() {
  const chip = $("netChip");
  const cachedFlag = store.get("cached:" + state.modelKey, false);
  if (!navigator.onLine) { chip.textContent = "Hors ligne"; chip.className = "chip ok"; }
  else if (cachedFlag) { chip.textContent = "Prêt hors ligne"; chip.className = "chip ok"; }
  else { chip.textContent = "En ligne"; chip.className = "chip"; }
}

function setCheck(name, status, text) {
  const li = document.querySelector(`[data-check="${name}"]`);
  li.className = status;
  if (text) li.querySelector("span:last-child").innerHTML = text;
}

async function runChecks() {
  let gpuOk = false, f16 = false, software = false;
  state.gpuName = "";
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      gpuOk = !!adapter;
      f16 = !!adapter?.features?.has("shader-f16");
      if (adapter) {
        let info = adapter.info || {};
        if (!adapter.info && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch {} }
        const desc = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(" ");
        state.gpuName = desc;
        // Carte « logicielle » (SwiftShader, llvmpipe…) : le GPU est simulé par le processeur, c'est très lent
        software = !!(adapter.isFallbackAdapter || info.isFallbackAdapter) || /swiftshader|llvmpipe|lavapipe|softpipe|software/i.test(desc);
      }
    } catch {}
  }
  if (software) gpuOk = false;
  state.gpuOk = gpuOk;
  state.f16 = f16;
  const name = state.gpuName ? ` <small>· ${escapeHtml(state.gpuName)}</small>` : "";
  let gpuMsg;
  if (software) gpuMsg = `Seule une carte graphique <em>logicielle</em> est disponible${name} <small>— elle est simulée par le processeur, donc bien plus lente que le mode Processeur. Vérifie <code>chrome://gpu</code> et tes pilotes Vulkan.</small>`;
  else if (gpuOk && f16) gpuMsg = `Accélération graphique (WebGPU) disponible${name}`;
  else if (gpuOk) gpuMsg = `Accélération graphique (WebGPU) disponible${name} <small>— sans demi-précision (f16) : la version standard utilisera un format compatible, un peu plus lourd</small>`;
  else if (isIOS()) gpuMsg = "WebGPU indisponible <small>— mets à jour vers iOS 26 (Safari récent requis)</small>";
  else if (isLinux() && isChromium()) gpuMsg = "WebGPU indisponible <small>— sous Linux, active-le dans <code>chrome://flags/#enable-unsafe-webgpu</code> puis relance Chrome, ou utilise le mode Processeur</small>";
  else if (!isChromium() && !isIOS()) gpuMsg = "WebGPU indisponible <small>— utilise Chrome ou Edge à jour, ou le mode Processeur</small>";
  else gpuMsg = "WebGPU indisponible <small>— mets Chrome à jour, ou utilise le mode Processeur</small>";
  setCheck("webgpu", gpuOk ? "ok" : (isMobile() ? "bad" : "warn"), gpuMsg);

  if (isStandalone()) setCheck("installed", "ok", isMobile() ? "Ouverte depuis l'écran d'accueil" : "Installée comme application");
  else setCheck("installed", "warn", isIOS()
    ? "Pas encore sur l'écran d'accueil <small>— conseillé pour le hors ligne</small>"
    : "Pas installée <small>— facultatif sur ordinateur, pratique pour l'ouvrir hors ligne</small>");
  $("howToInstall").hidden = isStandalone();
  $("howIOS").hidden = !isIOS();
  $("howDesktop").hidden = isIOS();
  $("howNote").hidden = !isIOS();
  // Le mode processeur demande trop de mémoire pour un téléphone
  $("cpuOpt").hidden = isMobile();
  $("setupTitle").textContent = isMobile() ? "Ton assistant, dans ton téléphone" : "Ton assistant, sur ton ordinateur";

  if (navigator.storage?.estimate) {
    try {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      const free = quota - usage;
      setCheck("storage", free > 2e9 ? "ok" : "warn", `Espace disponible pour l'app : ${fmtBytes(free)}`);
    } catch { setCheck("storage", "", "Espace de stockage : inconnu"); }
  } else setCheck("storage", "", "Espace de stockage : inconnu");

  return gpuOk;
}

function renderMessages() {
  const box = $("messages");
  box.innerHTML = "";
  for (const m of state.messages) {
    const el = addBubble(m.role === "user" ? "user" : "bot", m.content);
    if (m.meta) el.querySelector(".meta").textContent = m.meta;
  }
  $("emptyState").hidden = state.messages.length > 0;
}

function addBubble(kind, text) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.innerHTML = `<div class="body"></div><div class="meta"></div>`;
  if (kind === "user") el.querySelector(".body").textContent = text;
  else renderBot(el, text, false);
  $("messages").appendChild(el);
  $("emptyState").hidden = true;
  return el;
}

const scrollDown = () => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });

function setBusy(b) {
  state.busy = b;
  $("sendBtn").hidden = b;
  $("stopBtn").hidden = !b;
  $("input").disabled = false;
}

function autoGrow() {
  const t = $("input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}

/* ---------- Chargement du modèle ---------- */

function loadModel() {
  if (state.loading) return;
  state.loading = true;
  const model = cfg(state.modelKey);
  $("modelLabel").textContent = model.label + (model.dtype !== MODELS[state.modelKey].dtype ? " (sans f16)" : "");
  $("setupError").hidden = true;
  $("cpuBtn").hidden = true;
  $("loadBtn").disabled = true;
  $("progressBox").hidden = false;
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "Démarrage…";
  $("loadingLine").hidden = false;
  $("sendBtn").disabled = true;

  let lastPct = -1;
  // Minuteur pendant la préparation sur la carte graphique (compilation des shaders)
  let initTimer = null;
  const stopInitTimer = () => {
    clearInterval(initTimer); initTimer = null;
    $("slowBtn").hidden = true; $("slowBtn2").hidden = true;
  };
  const startInitTimer = (label) => {
    stopInitTimer();
    const t0 = Date.now();
    initTimer = setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      const txt = `${label} ${s} s` + (s >= 10 ? " — la première fois, la préparation peut prendre une à deux minutes" : "");
      $("progressText").textContent = txt;
      $("loadingLine").textContent = txt;
      if (s >= 45 && model.device === "webgpu" && !isMobile()) { $("slowBtn").hidden = false; $("slowBtn2").hidden = false; }
    }, 1000);
  };
  const off = onEngine(async (msg) => {
    if (msg.type === "status") {
      $("progressText").textContent = msg.text;
      $("loadingLine").textContent = msg.text;
      if (/^Initialisation/.test(msg.text)) startInitTimer(msg.text);
    } else if (msg.type === "progress" && msg.total > 0) {
      const pct = Math.min(100, (msg.loaded / msg.total) * 100);
      if (Math.floor(pct) !== lastPct) {
        lastPct = Math.floor(pct);
        $("progressFill").style.width = pct.toFixed(1) + "%";
        const t = `${fmtBytes(msg.loaded)} / ${fmtBytes(msg.total)} · ${lastPct} %`;
        $("progressText").textContent = t;
        $("loadingLine").textContent = "Chargement du modèle… " + lastPct + " %";
      }
    } else if (msg.type === "ready") {
      off();
      stopInitTimer();
      state.loading = false;
      state.ready = true;
      store.set("cached:" + state.modelKey, true);
      store.set("everLoaded", state.modelKey);
      // Demande à Safari de ne pas effacer le modèle quand l'espace manque
      try { await navigator.storage?.persist?.(); } catch {}
      $("loadingLine").hidden = true;
      $("sendBtn").disabled = false;
      $("loadBtn").disabled = false;
      updateNetChip();
      show("chat");
      renderMessages();
      scrollDown();
    } else if (msg.type === "error" && msg.during === "load") {
      off();
      stopInitTimer();
      state.loading = false;
      $("loadBtn").disabled = false;
      $("loadingLine").hidden = true;
      $("progressBox").hidden = true;
      show("setup");
      let hint = "";
      if (!navigator.onLine) hint = "\nTu es hors ligne et le modèle n'est pas encore sur l'appareil : connecte-toi pour le télécharger.";
      else if (/memory|allocation|OOM|out of/i.test(msg.message)) hint = isMobile()
        ? "\nMémoire insuffisante : essaie la version allégée, et ferme les autres apps."
        : "\nMémoire insuffisante : ferme des onglets, ou essaie la version allégée.";
      else if (GPU_LOST.test(msg.message)) hint = isMobile()
        ? "\nLe processeur graphique a été interrompu (souvent par manque de mémoire) : ferme les autres apps et essaie la version allégée."
        : "\nLa carte graphique a décroché pendant le calcul : son pilote ne supporte pas bien WebGPU. Le mode Processeur, plus lent mais fiable, évite ce problème.";
      else if (/NO_F16|requires f16|shader-f16/.test(msg.message)) hint = isMobile()
        ? "\nCet appareil ne gère pas la demi-précision : essaie la version standard."
        : "\nChoisis la version Standard (format compatible) ou Processeur.";
      else if (/WebGPU|GPU|OrtRun|shader/.test(msg.message) && !isMobile()) hint = "\nChoisis la version « Processeur » : elle marche sans carte graphique.";
      else hint = isMobile() ? "\nSi l'onglet a planté ou rechargé, essaie la version allégée." : "\nEssaie une autre version du modèle.";
      $("setupError").textContent = "Le chargement a échoué : " + msg.message + hint;
      $("setupError").hidden = false;
      $("cpuBtn").hidden = !(model.device === "webgpu" && !isMobile());
    }
  });
  send({ type: "load", model: model.id, opts: { device: model.device, dtype: model.dtype } });
}

/* ---------- Conversation ---------- */

function sendMessage(text) {
  text = text.trim();
  if (!text || state.busy || !state.ready) return;
  state.messages.push({ role: "user", content: text });
  addBubble("user", text);
  $("input").value = "";
  autoGrow();

  const bot = addBubble("bot", "");
  renderBot(bot, "", true);
  scrollDown();
  setBusy(true);

  let acc = "";
  let pending = false;
  const history = state.messages.slice(-MAX_HISTORY);
  const msgs = [{ role: "system", content: state.system || DEFAULT_SYSTEM }, ...history];

  const off = onEngine((msg) => {
    if (msg.type === "token") {
      acc += msg.text;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          renderBot(bot, acc, true);
          const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 160;
          if (nearBottom) window.scrollTo(0, document.body.scrollHeight);
        });
      }
    } else if (msg.type === "done") {
      off();
      const finalText = (msg.text || acc).trim();
      requestAnimationFrame(() => renderBot(bot, finalText, false));
      const s = msg.stats || {};
      const meta = s.tokPerSec ? `${s.tokens} jetons · ${s.tokPerSec.toFixed(1).replace(".", ",")} jetons/s` : "";
      bot.querySelector(".meta").textContent = meta;
      // On ne garde pas la réflexion dans l'historique : elle prendrait trop de place
      state.messages.push({ role: "assistant", content: splitThinking(finalText).answer || finalText, meta });
      store.set("messages", state.messages);
      setBusy(false);
    } else if (msg.type === "error") {
      off();
      bot.querySelector(".body").innerHTML = `<p style="color:var(--bad)">Erreur : ${escapeHtml(msg.message)}</p>`;
      if (GPU_LOST.test(msg.message) || /OrtRun|WebGPU|shader/.test(msg.message)) {
        const p = document.createElement("p");
        p.textContent = isMobile()
          ? "Le processeur graphique a été interrompu. Ferme l'app et rouvre-la ; si ça se répète, essaie la version allégée."
          : "La carte graphique a décroché. Le mode Processeur, plus lent mais fiable, évite ce problème.";
        bot.querySelector(".body").appendChild(p);
        if (!isMobile() && cfg(state.modelKey).device === "webgpu") {
          const b = document.createElement("button");
          b.className = "secondary"; b.textContent = "Passer en mode Processeur"; b.onclick = goCpu;
          bot.querySelector(".body").appendChild(b);
        }
        state.ready = false; // le modèle n'est plus utilisable tel quel
      }
      state.messages.pop(); // retire la question sans réponse de l'historique
      store.set("messages", state.messages);
      setBusy(false);
    }
  });

  send({ type: "generate", messages: msgs, opts: { thinking: state.thinking } });
}

/* ---------- Réglages ---------- */

async function openSheet() {
  $("thinkToggle").checked = state.thinking;
  $("systemPrompt").value = state.system;
  const model = MODELS[state.modelKey];
  const cached = await isModelCached(state.modelKey);
  let info = `${model.label} — ${cached ? "enregistré sur l'appareil, utilisable hors ligne ✓" : "pas encore enregistré sur l'appareil"}.`;
  if (navigator.storage?.persisted) {
    try { if (await navigator.storage.persisted()) info += " Stockage protégé ✓"; } catch {}
  }
  $("offlineInfo").textContent = info;
  $("installBtn2").hidden = !installPrompt || isStandalone();
  $("sheet").hidden = false;
  $("sheetBackdrop").hidden = false;
}
function closeSheet() {
  state.system = $("systemPrompt").value.trim() || DEFAULT_SYSTEM;
  store.set("system", state.system);
  $("sheet").hidden = true;
  $("sheetBackdrop").hidden = true;
}

/* ---------- Démarrage ---------- */

// Active le bouton de chargement selon la version choisie et ce que l'appareil sait faire
function refreshLoadButton() {
  const key = document.querySelector('input[name="model"]:checked').value;
  const m = cfg(key);
  const usable = (m.device === "wasm" || state.gpuOk) && !m.unsupported;
  $("loadBtn").disabled = !usable || state.loading;
  if (m.unsupported) {
    $("setupNote").textContent = "La version allégée a besoin de la demi-précision (f16), que ta carte graphique ne gère pas. Choisis Standard (format compatible) ou Processeur.";
  } else if (!usable) {
    $("setupNote").textContent = isMobile()
      ? "Ce navigateur ne permet pas de faire tourner le modèle. Sur iPhone, mets à jour vers iOS 26 puis ouvre cette page dans Safari."
      : "Cette version a besoin de WebGPU, indisponible ici. Choisis la version « Processeur ».";
  } else if (MODELS[key].device === "wasm") {
    $("setupNote").textContent = crossOriginIsolated
      ? `Mode processeur : réponses plus lentes qu'avec la carte graphique (${navigator.hardwareConcurrency || "?"} cœurs détectés).`
      : "Mode processeur : réponses lentes (un seul cœur utilisé). Recharge la page pour activer le multicœur.";
  } else {
    $("setupNote").textContent = isMobile()
      ? "Le téléchargement se fait une seule fois. Fais-le en Wi-Fi et garde l'écran allumé."
      : "Le téléchargement se fait une seule fois, ensuite le modèle reste sur cet ordinateur.";
  }
}

async function main() {
  // Service worker = l'app s'ouvre même sans réseau
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW", e); }
    // Sur Chrome, le service worker ajoute les en-têtes qui débloquent le multicœur (mode processeur).
    // Ils ne s'appliquent qu'après un rechargement : on le fait une fois, automatiquement.
    if (isChromium() && !crossOriginIsolated) {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        // Première visite : on attend que le service worker prenne la main (max 3 s)
        await new Promise((r) => {
          navigator.serviceWorker.addEventListener("controllerchange", r, { once: true });
          setTimeout(r, 3000);
        });
      }
      if (navigator.serviceWorker.controller && !sessionStorage.getItem("coiReload")) {
        sessionStorage.setItem("coiReload", "1");
        location.reload();
        return;
      }
    }
  }

  // Invitation d'installation (Chrome / Edge sur ordinateur et Android)
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!isStandalone()) $("installBtn").hidden = false;
  });
  addEventListener("appinstalled", () => { installPrompt = null; $("installBtn").hidden = true; $("installBtn2").hidden = true; runChecks(); });
  const doInstall = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch {}
    installPrompt = null;
    $("installBtn").hidden = true;
    $("installBtn2").hidden = true;
  };
  $("installBtn").onclick = doInstall;
  $("slowBtn").onclick = goCpu;
  $("cpuBtn").onclick = goCpu;
  $("slowBtn2").onclick = goCpu;
  $("installBtn2").onclick = () => { closeSheet(); doInstall(); };

  document.querySelector(`input[name="model"][value="${state.modelKey}"]`).checked = true;
  $("modelLabel").textContent = MODELS[state.modelKey].label;
  updateNetChip();
  addEventListener("online", updateNetChip);
  addEventListener("offline", updateNetChip);

  // Événements
  document.querySelectorAll('input[name="model"]').forEach((r) => (r.onchange = refreshLoadButton));
  $("loadBtn").onclick = () => {
    state.modelKey = document.querySelector('input[name="model"]:checked').value;
    store.set("modelKey", state.modelKey);
    loadModel();
  };
  $("form").onsubmit = (e) => { e.preventDefault(); sendMessage($("input").value); };
  $("input").addEventListener("input", autoGrow);
  $("input").addEventListener("keydown", (e) => {
    // Entrée envoie sur ordinateur ; sur iPhone, le bouton « envoyer » du clavier fait pareil
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && !isIOS()) { e.preventDefault(); sendMessage($("input").value); }
  });
  $("stopBtn").onclick = () => send({ type: "stop" });
  document.querySelectorAll(".sugg").forEach((b) => (b.onclick = () => sendMessage(b.textContent)));
  $("newChatBtn").onclick = () => {
    if (state.busy) return;
    state.messages = [];
    store.set("messages", []);
    renderMessages();
  };
  $("menuBtn").onclick = openSheet;
  $("closeSheetBtn").onclick = closeSheet;
  $("sheetBackdrop").onclick = closeSheet;
  $("thinkToggle").onchange = (e) => { state.thinking = e.target.checked; store.set("thinking", state.thinking); };
  $("switchModelBtn").onclick = async () => {
    closeSheet();
    if (state.busy) return;
    state.ready = false;
    send({ type: "unload" });
    $("progressBox").hidden = true;
    $("loadBtn").textContent = "Charger cette version";
    show("setup");
    state.gpuOk = await runChecks();
    refreshLoadButton();
  };
  $("deleteModelBtn").onclick = async () => {
    const model = MODELS[state.modelKey];
    if (!confirm(`Supprimer ${model.label} (${model.size}) de l'appareil ? Il faudra le re-télécharger pour l'utiliser.`)) return;
    closeSheet();
    state.ready = false;
    send({ type: "unload" });
    await deleteModelCache(state.modelKey);
    store.del("cached:" + state.modelKey);
    updateNetChip();
    $("progressBox").hidden = true;
    $("loadBtn").textContent = "Télécharger le modèle";
    show("setup");
    state.gpuOk = await runChecks();
    refreshLoadButton();
  };

  const mode = await startEngine();
  console.log("Moteur :", mode);

  const gpuOk = (state.gpuOk = await runChecks());
  // Carte sans f16 : les fichiers « q4f16 » éventuellement téléchargés avant ne servent à rien, on libère la place
  if (gpuOk && !state.f16) {
    try { await deleteModelCache("std_f16"); } catch {}
  }
  // Sur ordinateur sans WebGPU, on propose d'office le mode processeur
  if (!gpuOk && !isMobile() && MODELS[state.modelKey].device !== "wasm") {
    state.modelKey = "cpu";
    document.querySelector('input[name="model"][value="cpu"]').checked = true;
    $("modelLabel").textContent = MODELS.cpu.label;
  }
  const model = cfg(state.modelKey);
  const usable = (model.device === "wasm" || gpuOk) && !model.unsupported;
  const cached = await isModelCached(state.modelKey);
  if (!cached) store.del("cached:" + state.modelKey);
  updateNetChip();

  if (cached && usable) {
    // Modèle déjà sur l'appareil : on ouvre directement la conversation
    show("chat");
    renderMessages();
    loadModel();
  } else {
    $("loadBtn").textContent = cached ? "Charger le modèle" : `Télécharger le modèle`;
    refreshLoadButton();
    show("setup");
  }
}

main();
