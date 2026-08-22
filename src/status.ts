import type { EventStore } from "./store.js";

/**
 * Founder-readable progress, without asking an engineer.
 *
 * Plain HTML on purpose: no build step, no JS, readable on a phone, and it works
 * when the thing it is reporting on is broken — which is exactly when someone
 * non-technical goes looking for it.
 */
export function renderStatus(store: EventStore, opts: { installed: boolean; mode: string; now?: number }): string {
  const now = opts.now ?? Date.now();
  const counts = {
    queued: store.count("queued"),
    running: store.count("running"),
    done: store.count("done"),
    failed: store.count("failed"),
  };
  const total = counts.queued + counts.running + counts.done + counts.failed;
  const recent = store.recent(25, now);

  const esc = (s: string) => s.replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));

  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  const tile = (label: string, n: number, tone: string) =>
    `<div class="tile ${tone}"><div class="n">${n}</div><div class="l">${label}</div></div>`;

  const rows = recent.length
    ? recent.map((r) => `<tr>
        <td><span class="pill ${r.state}">${r.state}</span></td>
        <td class="mono">${esc(r.session)}</td>
        <td>${esc(r.action)}</td>
        <td class="dim">${ago(r.received_at)}</td>
        <td class="dim">${r.attempts}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="dim pad">Nothing yet. Delegate an issue to the agent in Linear.</td></tr>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Control Plane — status</title>
<style>
:root{color-scheme:light dark}
body{font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:2rem 1.25rem;
     max-width:60rem;margin-inline:auto}
h1{font-size:1.35rem;margin:0 0 .25rem}
.sub{color:#6b7280;margin:0 0 1.5rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(7rem,1fr));gap:.75rem;margin-bottom:1.75rem}
.tile{border:1px solid #d1d5db33;border-radius:.6rem;padding:.9rem 1rem}
.tile .n{font-size:1.8rem;font-weight:600;line-height:1}
.tile .l{color:#6b7280;font-size:.8rem;margin-top:.3rem;text-transform:uppercase;letter-spacing:.04em}
.ok .n{color:#15803d}.warn .n{color:#b45309}.bad .n{color:#b91c1c}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;color:#6b7280;font-weight:500;font-size:.78rem;text-transform:uppercase;
   letter-spacing:.04em;padding:.4rem .5rem;border-bottom:1px solid #d1d5db55}
td{padding:.5rem;border-bottom:1px solid #d1d5db22;vertical-align:top}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;word-break:break-all}
.dim{color:#6b7280}.pad{padding:1.5rem;text-align:center}
.pill{display:inline-block;padding:.1rem .5rem;border-radius:1rem;font-size:.75rem;
      border:1px solid currentColor}
.pill.done{color:#15803d}.pill.queued{color:#6b7280}
.pill.running{color:#b45309}.pill.failed{color:#b91c1c}
.banner{border:1px solid #b4530955;background:#b4530911;border-radius:.6rem;
        padding:.75rem 1rem;margin-bottom:1.5rem;font-size:.9rem}
footer{margin-top:2rem;color:#6b7280;font-size:.8rem}
</style></head><body>
<h1>Agent Control Plane</h1>
<p class="sub">Linear as the control plane for parallel coding agents · mode <strong>${esc(opts.mode)}</strong></p>

${opts.installed ? "" : `<div class="banner"><strong>Not installed.</strong> Visit <code>/oauth/authorize</code> to connect a Linear workspace. Until then no sessions can arrive.</div>`}
${opts.mode === "replay" ? `<div class="banner">Running in <strong>replay</strong> mode: the control plane is live against Linear, but no model is called and nothing is spent.</div>` : ""}

<div class="tiles">
  ${tile("Delivered", total, "")}
  ${tile("Completed", counts.done, "ok")}
  ${tile("In flight", counts.queued + counts.running, "warn")}
  ${tile("Failed", counts.failed, counts.failed ? "bad" : "")}
</div>

<table>
  <thead><tr><th>State</th><th>Session</th><th>Event</th><th>Received</th><th>Tries</th></tr></thead>
  <tbody>${rows}</tbody>
</table>

<footer>Generated ${new Date(now).toISOString()} · this page reads the queue directly and needs no engineer to interpret.</footer>
</body></html>`;
}
