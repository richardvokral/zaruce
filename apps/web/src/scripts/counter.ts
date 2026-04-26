/**
 * Subtle counter in the corner. Polls /api/counter every 30s.
 * The response carries today's `total` (population grows ~190k/day);
 * we broadcast it so the carousel can extend its upper bound mid-session.
 */

const API_BASE = (import.meta.env.PUBLIC_API_BASE || "").replace(/\/$/, "");
const occupiedEl = document.getElementById("counter-occupied");
const totalEl = document.getElementById("counter-total");
if (!occupiedEl || !totalEl) throw new Error("counter root missing");

const fmt = new Intl.NumberFormat("en-US");

async function poll() {
  try {
    const res = await fetch(`${API_BASE}/api/counter`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { occupied: string; total: string };
    occupiedEl!.textContent = fmt.format(BigInt(data.occupied));
    if (data.total && data.total !== totalEl!.dataset.total) {
      totalEl!.dataset.total = data.total;
      totalEl!.textContent = fmt.format(BigInt(data.total));
      window.dispatchEvent(new CustomEvent("zaruce:total", { detail: { total: data.total } }));
    }
  } catch {
    // best-effort; carousel keeps the SSR'd cap
  }
}

void poll();
setInterval(poll, 30_000);
