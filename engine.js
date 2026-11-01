// Moteur LFM3 : charge le modèle et génère les réponses.
// Utilisable dans un Web Worker (cas normal) ou directement dans la page (secours).

const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";

let lib = null;          // module Transformers.js
let generator = null;    // pipeline text-generation
let currentModel = null;
let stopper = null;      // InterruptableStoppingCriteria

async function getLib() {
  if (!lib) {
    lib = await import(TRANSFORMERS_URL);
    lib.env.allowLocalModels = false; // pas de dossier /models sur GitHub Pages
    lib.env.useBrowserCache = true;   // le modèle reste en cache => hors ligne
  }
  return lib;
}

export function hasWebGPU() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export async function load(modelId, emit) {
  if (generator && currentModel === modelId) {
    emit({ type: "ready", model: modelId, cached: true });
    return;
  }
  if (!hasWebGPU()) throw new Error("WebGPU indisponible dans ce navigateur.");

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("Aucun GPU utilisable (WebGPU n'a pas trouvé d'adaptateur).");

  emit({ type: "status", text: "Préparation du moteur…" });
  const { pipeline } = await getLib();

  if (generator) {
    try { await generator.dispose(); } catch (_) {}
    generator = null;
  }

  // Agrège la progression de tous les fichiers téléchargés
  const files = {};
  const progress_callback = (p) => {
    if (p.status === "progress" && p.file) {
      files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
      let loaded = 0, total = 0;
      for (const f of Object.values(files)) { loaded += f.loaded; total += f.total; }
      emit({ type: "progress", loaded, total, file: p.file });
    } else if (p.status === "done" && p.file && files[p.file]) {
      files[p.file].loaded = files[p.file].total;
    }
  };

  emit({ type: "status", text: "Chargement du modèle…" });
  generator = await pipeline("text-generation", modelId, {
    dtype: "q4f16",
    device: "webgpu",
    progress_callback,
  });
  currentModel = modelId;

  emit({ type: "status", text: "Initialisation du GPU…" });
  // Petit échauffement : compile les shaders pour que la 1re vraie réponse soit rapide
  try {
    await generator([{ role: "user", content: "Bonjour" }], {
      max_new_tokens: 1,
      tokenizer_encode_kwargs: { enable_thinking: false },
    });
  } catch (_) { /* sans importance */ }

  emit({ type: "ready", model: modelId, cached: false });
}

export async function generate(messages, opts, emit) {
  if (!generator) throw new Error("Le modèle n'est pas chargé.");
  const { TextStreamer, InterruptableStoppingCriteria } = await getLib();

  stopper = new InterruptableStoppingCriteria();
  let tokens = 0;
  let firstTokenAt = 0;
  const start = performance.now();

  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text) => emit({ type: "token", text }),
    token_callback_function: () => {
      tokens++;
      if (!firstTokenAt) firstTokenAt = performance.now();
    },
  });

  const thinking = !!opts.thinking;
  const output = await generator(messages, {
    max_new_tokens: opts.maxTokens || (thinking ? 2048 : 768),
    do_sample: true,
    temperature: opts.temperature ?? 0.1,
    top_k: 50,
    repetition_penalty: 1.1,
    tokenizer_encode_kwargs: { enable_thinking: thinking },
    streamer,
    stopping_criteria: stopper,
  });

  const end = performance.now();
  const genSeconds = firstTokenAt ? (end - firstTokenAt) / 1000 : 0;
  let text = "";
  try { text = output[0].generated_text.at(-1).content; } catch (_) {}
  emit({
    type: "done",
    text,
    stats: {
      tokens,
      tokPerSec: genSeconds > 0 ? tokens / genSeconds : 0,
      firstTokenMs: firstTokenAt ? firstTokenAt - start : 0,
    },
  });
  stopper = null;
}

export function stop() {
  if (stopper) stopper.interrupt();
}

export async function unload() {
  if (generator) {
    try { await generator.dispose(); } catch (_) {}
  }
  generator = null;
  currentModel = null;
}
