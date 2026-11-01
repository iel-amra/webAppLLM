// Fait tourner le modèle hors de la page pour que l'interface reste fluide.
import * as engine from "./engine.js";

const emit = (msg) => self.postMessage(msg);

self.postMessage({ type: "capabilities", webgpu: engine.hasWebGPU() });

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === "load") await engine.load(msg.model, emit);
    else if (msg.type === "generate") await engine.generate(msg.messages, msg.opts || {}, emit);
    else if (msg.type === "stop") engine.stop();
    else if (msg.type === "unload") { await engine.unload(); emit({ type: "unloaded" }); }
  } catch (err) {
    emit({ type: "error", during: msg.type, message: String(err && err.message || err) });
  }
};
