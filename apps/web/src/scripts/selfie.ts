/**
 * Selfie-inspired flow (opt-in).
 *
 * Pipeline:
 *   1. User picks file from the hidden input.
 *   2. We decode it locally into an HTMLImageElement.
 *   3. classifyAttributes() runs the on-device model; for the MVP scaffold
 *      we ship a heuristic pass and leave a TODO to swap in MediaPipe / ONNX.
 *   4. User sees the human-readable preview and confirms.
 *   5. We send only the bucketId to the assignment API.
 *
 * The selfie itself never leaves the browser.
 */

import { describeAttributes, bucketId, type Attributes } from "@zaruce/shared/attributes";

const API_BASE = (import.meta.env.PUBLIC_API_BASE || "").replace(/\/$/, "");

const dialog = document.getElementById("selfie-dialog") as HTMLDialogElement | null;
const input = document.getElementById("selfie-input") as HTMLInputElement | null;
const preview = document.getElementById("selfie-preview") as HTMLDivElement | null;
const attrsList = document.getElementById("selfie-attrs") as HTMLUListElement | null;
const confirmBtn = document.getElementById("selfie-confirm") as HTMLButtonElement | null;

if (!dialog || !input || !preview || !attrsList || !confirmBtn) {
  // Selfie UI optional — bail out silently if markup is absent.
  // (Page still works through the anonymous CTA flow.)
} else {
  let pending: Attributes | null = null;

  // Reveal the "use your selfie" trigger (kept hidden in the SSR'd HTML so
  // a no-JS visitor doesn't see a button that wouldn't open anything) and
  // wire it to open the dialog. The rest of the flow is unchanged.
  const opener = document.getElementById("selfie-cta") as HTMLButtonElement | null;
  if (opener) {
    opener.hidden = false;
    opener.addEventListener("click", () => dialog.showModal());
  }

  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const attrs = await classifyAttributes(file);
      pending = attrs;
      attrsList.replaceChildren(
        ...describeAttributes(attrs).map((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          return li;
        }),
      );
      preview.hidden = false;
      confirmBtn.disabled = false;
    } catch (err) {
      console.warn("attribute classification failed", err);
      attrsList.replaceChildren();
      const li = document.createElement("li");
      li.textContent = "could not analyze image — try a clearer selfie";
      attrsList.appendChild(li);
      preview.hidden = false;
      confirmBtn.disabled = true;
    }
  });

  dialog.addEventListener("close", async () => {
    if (dialog.returnValue !== "confirm" || !pending) {
      pending = null;
      return;
    }
    const id = bucketId(pending);
    try {
      const res = await fetch(`${API_BASE}/api/assign`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attributeBucketId: id }),
      });
      if (!res.ok) throw new Error(`assign failed: ${res.status}`);
      const data = (await res.json()) as { index: string };
      window.__zaruceSnapTo?.(BigInt(data.index), { highlight: true });
    } catch (err) {
      console.error(err);
    } finally {
      pending = null;
      input.value = "";
      preview.hidden = true;
      confirmBtn.disabled = true;
    }
  });
}

/**
 * Convert a selfie file into the coarse attribute bucket described in the PRD.
 *
 * MVP: this is a heuristic stub. The real implementation will use a
 * lightweight on-device model (MediaPipe FaceLandmarker for landmarks +
 * presence of glasses, an ONNX age/gender classifier, and a sampled-pixel
 * estimate of skin tone / hair color). All inference stays in the browser.
 *
 * The contract returned here is the same in either case — only the
 * implementation behind it changes when the model is wired up.
 */
async function classifyAttributes(file: File): Promise<Attributes> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    // Sample a small grid of pixels to estimate skin tone and average brightness.
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(img, 0, 0, 64, 64);
    const { data } = ctx.getImageData(0, 0, 64, 64);

    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!;
      g += data[i + 1]!;
      b += data[i + 2]!;
      n++;
    }
    r /= n; g /= n; b /= n;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;

    // TODO(MediaPipe): replace heuristic with real face-landmarker output.
    // For now, map average luma to a Fitzpatrick-ish bucket so the demo
    // produces *some* signal without bundling a 50MB model.
    const skinTone = (luma > 210 ? 1 :
                      luma > 180 ? 2 :
                      luma > 145 ? 3 :
                      luma > 110 ? 4 :
                      luma > 75  ? 5 : 6) as Attributes["skinTone"];

    return {
      age: "young-adult",
      presentation: "ambiguous",
      hairColor: luma < 80 ? "black" : luma < 140 ? "brown" : "blond",
      skinTone,
      glasses: false,
      hairLength: "medium",
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}
