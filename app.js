// LFM3 de poche — logique de l'interface

const MODELS = {
  std:   { id: "onnx-community/LFM3-1.7B-ONNX", label: "LFM3-1.7B · standard", size: "1,4 Go" },
  light: { id: "daveycodez/LFM3-1.7B-Web",     label: "LFM3-1.7B · allégée",  size: "0,9 Go" },
};
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
      if (msg.type === "load") await engine.load(msg.model, dispatch);
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

async function isModelCached(modelId) {
  if (!("caches" in window)) return false;
  try {
    for (const name of await caches.keys()) {
      if (name.startsWith("lfm3-")) continue;
      const keys = await (await caches.open(name)).keys();
      if (keys.some((r) => r.url.includes(modelId) && r.url.includes("onnx_data"))) return true;
    }
  } catch {}
  return false;
}

async function deleteModelCache(modelId) {
  let n = 0;
  for (const name of await caches.keys()) {
    if (name.startsWith("lfm3-")) continue;
    const c = await caches.open(name);
    for (const r of await c.keys()) {
      if (r.url.includes(modelId)) { await c.delete(r); n++; }
    }
  }
  return n;
}

/* ---------- Petits utilitaires ---------- */

const fmtBytes = (b) => b >= 1e9 ? (b / 1e9).toFixed(2).replace(".", ",") + " Go" : Math.round(b / 1e6) + " Mo";
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

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
  const cachedFlag = store.get("cached:" + MODELS[state.modelKey].id, false);
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
  let gpuOk = false;
  if (navigator.gpu) {
    try { gpuOk = !!(await navigator.gpu.requestAdapter()); } catch {}
  }
  setCheck("webgpu", gpuOk ? "ok" : "bad", gpuOk
    ? "Accélération graphique (WebGPU) disponible"
    : "WebGPU indisponible <small>— mets à jour iOS (Safari récent requis)</small>");

  if (isStandalone()) setCheck("installed", "ok", "Ouverte depuis l'écran d'accueil");
  else setCheck("installed", "warn", isIOS()
    ? "Pas encore sur l'écran d'accueil <small>— conseillé pour le hors ligne</small>"
    : "Pas installée <small>— conseillé pour le hors ligne</small>");
  $("howToInstall").hidden = isStandalone();

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
  const model = MODELS[state.modelKey];
  $("modelLabel").textContent = model.label;
  $("setupError").hidden = true;
  $("loadBtn").disabled = true;
  $("progressBox").hidden = false;
  $("progressFill").style.width = "0%";
  $("progressText").textContent = "Démarrage…";
  $("loadingLine").hidden = false;
  $("sendBtn").disabled = true;

  let lastPct = -1;
  const off = onEngine(async (msg) => {
    if (msg.type === "status") {
      $("progressText").textContent = msg.text;
      $("loadingLine").textContent = msg.text;
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
      state.loading = false;
      state.ready = true;
      store.set("cached:" + model.id, true);
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
      state.loading = false;
      $("loadBtn").disabled = false;
      $("loadingLine").hidden = true;
      $("progressBox").hidden = true;
      show("setup");
      let hint = "";
      if (!navigator.onLine) hint = "\nTu es hors ligne et le modèle n'est pas encore sur l'appareil : connecte-toi pour le télécharger.";
      else if (/memory|allocation|OOM|out of/i.test(msg.message)) hint = "\nMémoire insuffisante : essaie la version allégée, et ferme les autres apps.";
      else hint = "\nSi l'onglet a planté ou rechargé, essaie la version allégée.";
      $("setupError").textContent = "Le chargement a échoué : " + msg.message + hint;
      $("setupError").hidden = false;
    }
  });
  send({ type: "load", model: model.id });
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
  const cached = await isModelCached(model.id);
  let info = `${model.label} — ${cached ? "enregistré sur l'appareil, utilisable hors ligne ✓" : "pas encore enregistré sur l'appareil"}.`;
  if (navigator.storage?.persisted) {
    try { if (await navigator.storage.persisted()) info += " Stockage protégé ✓"; } catch {}
  }
  $("offlineInfo").textContent = info;
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

async function main() {
  // Service worker = l'app s'ouvre même sans réseau
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("./sw.js"); } catch (e) { console.warn("SW", e); }
  }

  document.querySelector(`input[name="model"][value="${state.modelKey}"]`).checked = true;
  $("modelLabel").textContent = MODELS[state.modelKey].label;
  updateNetChip();
  addEventListener("online", updateNetChip);
  addEventListener("offline", updateNetChip);

  // Événements
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
    runChecks();
  };
  $("deleteModelBtn").onclick = async () => {
    const model = MODELS[state.modelKey];
    if (!confirm(`Supprimer ${model.label} (${model.size}) de l'appareil ? Il faudra le re-télécharger pour l'utiliser.`)) return;
    closeSheet();
    state.ready = false;
    send({ type: "unload" });
    await deleteModelCache(model.id);
    store.del("cached:" + model.id);
    updateNetChip();
    $("progressBox").hidden = true;
    $("loadBtn").textContent = "Télécharger le modèle";
    show("setup");
    runChecks();
  };

  const mode = await startEngine();
  console.log("Moteur :", mode);

  const gpuOk = await runChecks();
  const model = MODELS[state.modelKey];
  const cached = await isModelCached(model.id);
  if (!cached) store.del("cached:" + model.id);
  updateNetChip();

  if (cached && gpuOk) {
    // Modèle déjà sur l'appareil : on ouvre directement la conversation
    show("chat");
    renderMessages();
    loadModel();
  } else {
    $("loadBtn").textContent = cached ? "Charger le modèle" : `Télécharger le modèle`;
    $("loadBtn").disabled = !gpuOk;
    if (!gpuOk) {
      $("setupNote").textContent = "Ce navigateur ne permet pas de faire tourner le modèle. Sur iPhone, mets à jour iOS puis ouvre cette page dans Safari.";
    }
    show("setup");
  }
}

main();
