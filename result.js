// PaperScorer result page: result.html?id=<sid>.
// Reads the public result doc results/{sid} from Firestore and the page panel it names from
// Storage (getBlob, shown as an object URL), then places the score on the natural-rate test
// set using ./result-data.json. Example test papers are static images in ./panels.
// While the result does not exist yet, a single-doc listener on progress/{sid} shows live
// progress (queued, scoring, scored, failed) until the result can be shown.

// User-facing text per progress/{sid}.fail_stage code, from the worker: [what went wrong, what to do].
const FAIL_TEXT = {
  invalid_pdf: [
    "We could not read the uploaded file as a PDF.",
    "Please check that the file opens in a PDF viewer and submit it again.",
  ],
  too_short: [
    "The PDF has fewer than 4 pages, which is too short to score.",
    "Please submit the full paper.",
  ],
  mineru: [
    "Our document parser could not process this PDF, even after several attempts.",
    "This is usually a problem on our side. You can try submitting again later.",
  ],
  not_anonymized: [
    "The paper does not look anonymized: we could not find an anonymous author block (for example \"Anonymous Author(s)\") or an \"Under review\" marker on the first page.",
    "Please compile the paper in the venue's anonymous submission mode (for example, without the camera-ready or final option), check that the first page lists the authors as anonymous, and submit that PDF again.",
  ],
  too_few_body_pages: [
    "We found fewer than 6 pages of main text before the references and appendix, so the paper is too short to score.",
    "Please submit the full paper with its complete main body (at least 6 pages before the references). Extended abstracts and short workshop versions cannot be scored.",
  ],
  no_decision: [
    "The scoring model did not produce an accept or reject prediction for this paper.",
    "This is a problem on our side. You can try submitting again later.",
  ],
  scorer: [
    "The scoring model failed on this paper, even after several attempts.",
    "This is a problem on our side. You can try submitting again later.",
  ],
  rate_limited: [
    "This submission was not scored because a submission limit was reached: either 5 papers per email address per day, or PaperScorer's overall hourly capacity.",
    "Please try again later. If you have already submitted 5 papers today, try again tomorrow.",
  ],
};
const FAIL_FALLBACK = ["We could not process this paper.", "You can try submitting again later."];

const WAIT_LIMIT_MS = 30 * 60 * 1000;  // stop listening for progress after 30 minutes
const RESULT_RETRIES = 2;              // after "scored", re-read results/{sid} up to twice...
const RESULT_RETRY_MS = 2000;          // ...2 s apart

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
// Public web config; access is enforced by the security rules and App Check (same as app.js).
const firebaseConfig = {
  apiKey: "AIzaSyDjKhLZWtI52jwkfWfTB3meCWSQ71h_FwU",
  authDomain: "vision-mix.firebaseapp.com",
  projectId: "vision-mix",
  appId: "1:289186856710:web:d9de427af45723f829e887",
  messagingSenderId: "289186856710",
};
const RECAPTCHA_SITE_KEY = "6Lc2QPItAAAAAC2vUwrTy7ptXCLjSUcD7LXlX5TX";
const BUCKET = "gs://paperscorer-prod";
const MAX_PAGES = 15;

// Example panels: <EXAMPLES_BASE>/<model>/<paper_id>.jpg (1200 x 762), static site files.
// Only the 10 for the result's model, bin and predicted decision are requested, lazily.
const EXAMPLES_BASE = "./panels";

const SID_RE = /^[A-Za-z0-9_-]{20,40}$/;
// base(r): the base-rate note in the headline; line(r): the label of the decision line in the chart.
// r is the prior as a whole percent. The arXiv note is fixed text, the same as the result email
// (~25%, about the natural-rate test set's 24.8%), so its chart line, drawn at the prior (23.2%),
// carries no number.
const MODELS = {
  iclr: {
    name: "PaperScorer-7B-Vision-OpenReview-ICLR", repo: "skonan/PaperScorer-7B-Vision-OpenReview-ICLR", short: "ICLR",
    base: (r) => `ICLR accepts ~${r}`, line: (r) => `ICLR base rate ${r}`,
  },
  arxiv: {
    name: "PaperScorer-7B-Vision-arXiv", repo: "skonan/PaperScorer-7B-Vision-arXiv", short: "arXiv",
    base: () => "top venues accept ~25%", line: () => "top-venue base rate",
  },
};

const IS_LOCAL = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const params = new URLSearchParams(location.search);
// Dev-only stub (see stubLoad below): never active off localhost.
const STUB = IS_LOCAL ? params.get("stub") : null;

const $ = (id) => document.getElementById(id);
const SVG_NS = "http://www.w3.org/2000/svg";
const N_BINS = 10;
const binOf = (p) => Math.min(N_BINS - 1, Math.max(0, Math.floor(p * N_BINS + 1e-9)));
const pct = (x) => `${Math.round(x * 100)}%`;
const range = (b) => `${Math.round(b.lo * 100)}-${Math.round(b.hi * 100)}%`;
const aRange = (b) => `${Math.round(b.lo * 100) === 80 ? "an" : "a"} ${range(b)}`;  // "an 80-90%"
const COUNT_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
const isProb = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

// Percent labels for the chance of acceptance p and the base rate pi, the same rule as the result
// email: p is a whole percent, or one decimal when it rounds to the same whole percent as pi
// ("Leans Reject - 31.4% chance of acceptance (ICLR accepts ~31%)"); pi is always a whole percent.
function chanceLabels(p, pi) {
  const r = Math.round(p * 100), rp = Math.round(pi * 100);
  return { you: r === rp ? `${(p * 100).toFixed(1)}%` : `${r}%`, base: `${rp}%` };
}

function showMessage(title, body) {
  $("state-loading").hidden = true;
  $("state-wait").hidden = true;
  $("state-ok").hidden = true;
  $("msg-title").textContent = title;
  // body: one string, or [what went wrong, what to do] shown as two lines.
  const [first, ...rest] = Array.isArray(body) ? body : [body];
  $("msg-body").textContent = first;
  $("msg-body").parentNode.querySelectorAll(".msg-extra").forEach((n) => n.remove());
  let after = $("msg-body");
  for (const line of rest) {
    const p = document.createElement("p");
    p.className = "msg-extra";
    p.textContent = line;
    after.after(p);
    after = p;
  }
  $("state-msg").hidden = false;
  document.title = `PaperScorer: ${title}`;
}
const showBadLink = () => showMessage("We could not read this result link",
  "The link in your result email ends in result.html?id= followed by your submission id. If you copied it by hand, check that nothing was cut off.");
const showMissing = () => showMessage("We could not find this result",
  "Check the link in your email.");
const showUnavailable = () => showMessage("We could not load this result",
  "The result service is not reachable right now. Please try again in a few minutes.");

// --- Data sources ---------------------------------------------------------------------------

// A source gives the page everything it reads:
//   getResult()                  -> results/{sid} data, or null
//   getPanel(path)               -> Blob of the panel the result names
//   getQueue()                   -> status/queue data, or null
//   watchProgress(onDoc, onErr)  -> unsubscribe; onDoc(progress/{sid} data, or null)
// Real path: Firestore and Storage. Imports are dynamic so a bad link never loads Firebase;
// the SDK version, config, bucket and App Check match app.js.
async function firebaseSource(sid) {
  // On localhost, use an App Check debug token (printed in the console; register it in the Firebase console).
  if (IS_LOCAL) {
    self.FIREBASE_APPCHECK_DEBUG_TOKEN ||= true;
  }
  const [{ initializeApp }, { initializeAppCheck, ReCaptchaEnterpriseProvider }, { getFirestore, doc, getDoc, onSnapshot }, { getStorage, ref, getBlob }] =
    await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-app-check.js`),
      import(`${SDK}/firebase-firestore.js`),
      import(`${SDK}/firebase-storage.js`),
    ]);
  const app = initializeApp(firebaseConfig);
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
  const db = getFirestore(app);
  const storage = getStorage(app, BUCKET);
  const read = async (...path) => {
    const snap = await getDoc(doc(db, ...path));
    return snap.exists() ? snap.data() : null;
  };
  return {
    getResult: () => read("results", sid),
    // Only the panel this result names, and only through the SDK (never a download URL).
    getPanel: (path) => getBlob(ref(storage, path)),
    getQueue: () => read("status", "queue"),
    watchProgress: (onDoc, onErr) =>
      onSnapshot(doc(db, "progress", sid), (snap) => onDoc(snap.exists() ? snap.data() : null), onErr),
  };
}

// Dev-only progress stub, localhost only: result.html?id=<sid>&stub=progress:<mode>, where mode is
//   missing            no progress doc (queued); &backlog=<n> sets status/queue.backlog (default 3)
//   scoring            state "scoring"
//   failed:<code>      state "failed" with fail_stage <code> (e.g. failed:not_anonymized)
//   scored             state "scored" and the stub result is there
//   scored:missing     state "scored" but results/{sid} never appears (retries, then "was emailed")
//   sequence           missing -> scoring (3 s) -> scored (6 s), then the stub result renders
//   timeout            missing, with the 30-minute limit cut to 3 s
// &degraded=1 sets status/queue.degraded. &result=<stub spec> picks the stub result (default 1).
function stubProgressSource(sid, spec) {
  const [mode, arg] = spec.split(":");
  const steps = {
    missing: [[0, null]],
    timeout: [[0, null]],
    scoring: [[0, { state: "scoring" }]],
    failed: [[0, { state: "failed", fail_stage: arg ?? null }]],
    scored: [[0, { state: "scored" }]],
    sequence: [[0, null], [3000, { state: "scoring" }], [6000, { state: "scored" }]],
  }[mode];
  if (!steps) throw new Error(`stub: unknown progress mode "${mode}"`);
  const resultP = stubLoad(sid, params.get("result") || "1");
  let resultVisible = false;
  return {
    waitLimitMs: mode === "timeout" ? 3000 : undefined,
    getResult: async () => (resultVisible ? (await resultP).doc : null),
    getPanel: async (path) => (await resultP).getPanel(path),
    getQueue: async () => ({
      schema_version: 1,
      backlog: Number(params.get("backlog") ?? 3),
      in_progress: 1,
      degraded: params.get("degraded") === "1",
    }),
    watchProgress(onDoc) {
      const timers = steps.map(([ms, d]) => setTimeout(() => {
        // The worker writes results/{sid} before it flips progress to "scored".
        if (d?.state === "scored" && arg !== "missing") resultVisible = true;
        onDoc(d && { schema_version: 1, fail_stage: null, ...d, updated_at: new Date() });
      }, ms));
      console.info("stub: progress listener attached");
      return () => {
        timers.forEach(clearTimeout);
        console.info("stub: progress listener detached");
      };
    },
  };
}

// Wraps the result-only stubs below (stub=1, stub=<model>,..., stub=local, stub=missing).
async function stubResultSource(sid, spec) {
  const { doc, getPanel } = await stubLoad(sid, spec);
  return { getResult: async () => doc, getPanel, getQueue: null, watchProgress: null };
}

// Calibration behind the stub docs: today's (schema_version 3) and the one before it (v2, tauV2).
const STUB_CALIB = { iclr: { tau: 1.251, prior: 0.314, tauV2: 1.258 }, arxiv: { tau: 1.499, prior: 0.232, tauV2: 1.415 } };

// Dev-only stub, localhost only: result.html?id=<sid>&stub=1 (ICLR reject 0.18), or
// stub=<model>,<decision>,<p_accept>,<pages>[,flag...] with flags nopanel, panelfail and v2 (an
// old schema_version 2 doc for the same paper: no prior, max-style confidence), or stub=missing
// (the final "could not find" message, without waiting for progress).
// The panel is drawn in the page, so nothing extra ships with the site.
async function stubLoad(sid, spec) {
  if (spec === "missing") return { doc: null, getPanel: null };
  // stub=local: a real result exported to site/_local/<sid>/{result.json,panel.jpg} (gitignored).
  if (spec === "local") {
    const res = await fetch(`./_local/${sid}/result.json`);
    if (!res.ok) return { doc: null, getPanel: null };
    const doc = await res.json();
    doc.created_at = new Date(doc.created_at);
    const getPanel = async () => (await fetch(`./_local/${sid}/panel.jpg`)).blob();
    return { doc, getPanel };
  }
  const [model, decision, pStr, pages, ...flags] = (spec === "1" ? "iclr,reject,0.18,15" : spec).split(",");
  const { tau, prior, tauV2 } = STUB_CALIB[model] || STUB_CALIB.iclr;
  const pAccept = Number(pStr);
  const lg = (q) => Math.log(q / (1 - q));
  const logit = tau * (lg(pAccept) - lg(prior));  // l = log P(Accept) - log P(Reject)
  const pOld = 1 / (1 + Math.exp(-logit / tauV2));  // the v2 chance: no prior term
  const n = Math.min(MAX_PAGES, Number(pages) || 15);
  const common = {
    model,
    decision,
    pages_used: n,
    panel: flags.includes("nopanel") ? null : `results/${sid}/panel.jpg`,
    created_at: new Date("2026-10-21T15:20:00Z"),
    deploy: "stub",
    title: params.get("title") ?? "A Decade's Battle on Dataset Bias: Are We There Yet?",
  };
  const doc = flags.includes("v2")
    ? { schema_version: 2, ...common, confidence: Number(Math.max(pOld, 1 - pOld).toFixed(4)),
      p_accept: Number(pOld.toFixed(4)), logit: Number(logit.toFixed(4)) }
    : { schema_version: 3, ...common, p_accept: Number(pAccept.toFixed(4)), prior, tau,
      confidence: Number(Math.max(pOld, 1 - pOld).toFixed(4)) };  // legacy field, ignored
  const getPanel = async () => {
    if (flags.includes("panelfail")) throw new Error("stub: panel fetch failed");
    return drawStubPanel(n);
  };
  return { doc, getPanel };
}

// A stand-in for the real panel: 4 columns, 1600 px wide, one portrait page per cell.
function drawStubPanel(n) {
  const cols = 4, W = 1600, cw = W / cols, ch = Math.round(cw * 1.294), pad = 10;
  const rows = Math.ceil(n / cols);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = rows * ch;
  const g = c.getContext("2d");
  g.fillStyle = "#e9e7e1";
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * cw + pad, y = Math.floor(i / cols) * ch + pad, w = cw - 2 * pad, h = ch - 2 * pad;
    g.fillStyle = "#fff";
    g.fillRect(x, y, w, h);
    g.fillStyle = "#c9c6bd";
    let ty = y + 40;
    if (i === 0) {
      g.fillStyle = "#555";
      g.fillRect(x + 50, ty, w - 100, 14);
      g.fillRect(x + 90, ty + 22, w - 180, 14);
      ty += 70;
      g.fillStyle = "#c9c6bd";
    }
    if (i % 3 === 1) {
      g.fillStyle = "#cddff5";
      g.fillRect(x + 32, ty, w - 64, 120);
      ty += 140;
      g.fillStyle = "#c9c6bd";
    }
    for (; ty < y + h - 40; ty += 13) g.fillRect(x + 32, ty, (w - 64) * (ty % 7 === 0 ? 0.6 : 1), 5);
    g.fillStyle = "#888";
    g.font = "16px serif";
    g.fillText(String(i + 1), x + w / 2 - 4, y + h - 14);
  }
  return new Promise((resolve) => c.toBlob(resolve, "image/jpeg", 0.85));
}

// --- Rendering ------------------------------------------------------------------------------

function svgEl(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}
function txt(parent, x, y, s, attrs = {}) {
  const t = svgEl("text", { x, y, ...attrs }, parent);
  t.textContent = s;
  return t;
}

// Two panels on one chance axis (0-1): left, the reliability curve on the natural-rate test set
// (solid; only bins with at least md.minPlot papers) against y = x (dashed); right, how many test
// papers fall in each bin. A dotted vertical line marks the base rate pi (the decision line:
// PaperScorer leans Accept at or right of it) and a red dashed one the user's chance. you is
// {p, label} or null (an older result without a chance). The panels stack when narrow.
function drawChart(container, md, minPlot, pi, baseLabel, you) {
  const bins = md.bins;
  const total = Math.max(300, Math.round(container.clientWidth));
  const stacked = total < 640;
  const W = stacked ? total : Math.floor((total - 28) / 2);
  const ub = you ? binOf(you.p) : -1;
  const m = { l: 50, r: 14, t: 46, b: 52 };
  const ih = stacked ? 220 : 250;
  const H = m.t + ih + m.b;
  const iw = W - m.l - m.r;
  const x = (p) => m.l + p * iw;
  const xTicks = (svg, y0) => {
    for (let k = 0; k <= 5; k++) {
      const c = k / 5;
      const anchor = k === 0 ? "start" : k === 5 ? "end" : "middle";
      txt(svg, x(c), y0 + 18, pct(c), { class: "tick", "text-anchor": iw < 300 ? anchor : "middle" });
    }
    txt(svg, m.l + iw / 2, y0 + 40, "Predicted chance of acceptance", { class: "axis-title", "text-anchor": "middle" });
  };
  const youLine = (svg, y0, y1, withLabel) => {
    if (!you) return;
    const ux = x(you.p);
    svgEl("line", { x1: ux, x2: ux, y1, y2: y0, class: "you-line" }, svg);
    if (!withLabel) return;
    const anchor = ux > W - m.r - 70 ? "end" : ux < m.l + 70 ? "start" : "middle";
    txt(svg, anchor === "end" ? ux + 4 : anchor === "start" ? ux - 4 : ux, y1 - 7, `Your paper, ${you.label}`,
      { class: "you-label", "text-anchor": anchor });
  };
  // The decision line, labeled along it (rotated) near the top: on its left, where the curve
  // stays low, unless the user's line sits just left of it; then on its right.
  const baseLine = (svg, y0, y1, withLabel) => {
    const bx = x(pi);
    svgEl("line", { x1: bx, x2: bx, y1, y2: y0, class: "base-line" }, svg);
    if (!withLabel) return;
    const ux = you ? x(you.p) : -1e9;
    const right = ux < bx && bx - ux < 22;
    const tx = right ? bx + 15 : bx - 6;
    txt(svg, tx, y1 + 4, baseLabel, { class: "base-label", "text-anchor": "end", transform: `rotate(-90 ${tx} ${y1 + 4})` });
  };

  // Left: reliability curve.
  const shown = bins.filter((b) => b.n >= minPlot);
  const yA = (a) => m.t + ih * (1 - a);
  const left = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Reliability curve on the natural-rate test set. ${shown.map((b) => `Chance ${range(b)}: mean predicted ${pct(b.meanP)}, ${pct(b.rate)} actually accepted`).join("; ")}. ${baseLabel}.` });
  txt(left, m.l, 16, "Share actually accepted", { class: "axis-title" });
  for (let k = 0; k <= 5; k++) {
    const a = k / 5;
    svgEl("line", { x1: m.l, x2: W - m.r, y1: yA(a), y2: yA(a), class: k === 0 ? "ax" : "grid" }, left);
    txt(left, m.l - 7, yA(a) + 4.5, pct(a), { class: "tick", "text-anchor": "end" });
  }
  svgEl("line", { x1: x(0), y1: yA(0), x2: x(1), y2: yA(1), class: "ideal" }, left);
  baseLine(left, m.t + ih, m.t, true);
  const pts = shown.map((b) => [x(b.meanP), yA(b.rate)]);
  svgEl("polyline", { points: pts.map((q) => q.join(",")).join(" "), class: "curve" }, left);
  shown.forEach((b, i) => {
    const mine = bins.indexOf(b) === ub;
    svgEl("circle", { cx: pts[i][0], cy: pts[i][1], r: mine ? 5 : 3.5, class: mine ? "pt pt-you" : "pt" }, left);
    if (mine) txt(left, pts[i][0] + 9, pts[i][1] + 16, pct(b.rate), { class: "val val-you" });
  });
  xTicks(left, m.t + ih);
  youLine(left, m.t + ih, m.t - 4, true);
  left.querySelectorAll(".val, .axis-title, .base-label").forEach((n) => left.appendChild(n));

  // Right: papers per bin.
  const maxN = Math.max(...bins.map((b) => b.n));
  const step = maxN > 400 ? 200 : 100;
  const top = Math.ceil(maxN / step) * step;
  const yC = (n) => m.t + ih * (1 - n / top);
  const right = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img",
    "aria-label": `Test papers per chance bin: ${bins.map((b) => `${range(b)}: ${b.n}`).join("; ")}.` });
  txt(right, m.l, 16, "Number of test papers", { class: "axis-title" });
  for (let n = 0; n <= top; n += step) {
    svgEl("line", { x1: m.l, x2: W - m.r, y1: yC(n), y2: yC(n), class: n === 0 ? "ax" : "grid" }, right);
    txt(right, m.l - 7, yC(n) + 4.5, String(n), { class: "tick", "text-anchor": "end" });
  }
  const pad = iw < 400 ? 2 : 4;
  bins.forEach((b, i) => {
    const x0 = x(b.lo) + pad, x1 = x(b.hi) - pad;
    svgEl("rect", { x: x0, y: yC(b.n), width: x1 - x0, height: yC(0) - yC(b.n), class: i === ub ? "cbar cbar-you" : "cbar", rx: 2 }, right);
    txt(right, (x0 + x1) / 2, yC(b.n) - 6, String(b.n), { class: i === ub ? "val val-you" : "val", "text-anchor": "middle" });
  });
  baseLine(right, m.t + ih, m.t, false);
  xTicks(right, m.t + ih);
  youLine(right, m.t + ih, m.t - 4, false);
  right.querySelectorAll(".val, .axis-title").forEach((n) => right.appendChild(n));

  const row = document.createElement("div");
  row.className = stacked ? "chart-row stacked" : "chart-row";
  row.append(left, right);
  container.replaceChildren(row);
}

function openLightbox(src, alt, caption, tall) {
  const dlg = $("lightbox");
  $("lb-img").src = src;
  $("lb-img").alt = alt;
  $("lb-cap").textContent = caption;
  dlg.classList.toggle("is-tall", !!tall);
  if (typeof dlg.showModal === "function") {
    dlg.showModal();
    dlg.scrollTop = 0;
  } else {
    window.open(src, "_blank", "noopener");
  }
}

function renderExamples(papers, modelKey) {
  const grid = $("ex-grid");
  grid.replaceChildren();
  for (const ex of papers) {
    const src = `${EXAMPLES_BASE}/${modelKey}/${encodeURIComponent(ex.id)}.jpg`;
    const li = document.createElement("li");
    li.className = "ex";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ex-img";
    btn.setAttribute("aria-label", `Enlarge the pages of "${ex.title}"`);
    const img = document.createElement("img");
    img.src = src;
    img.alt = `First pages of "${ex.title}"`;
    img.loading = "lazy";
    img.decoding = "async";
    img.width = 1200;
    img.height = 762;
    btn.appendChild(img);
    btn.addEventListener("click", () =>
      openLightbox(src, `Pages of "${ex.title}"`, ex.venue ? `${ex.title} (${ex.venue})` : ex.title, false));
    const title = document.createElement("p");
    title.className = "ex-title";
    title.textContent = ex.title;
    const venue = document.createElement("p");
    venue.className = "ex-venue";
    venue.textContent = ex.venue || "";
    li.append(btn, title, venue);
    grid.appendChild(li);
  }
}

async function showPanel(path, getPanel) {
  const btn = $("you-panel");
  const img = $("you-img");
  try {
    const blob = await getPanel(path);
    if (!blob || !blob.size) throw new Error("empty panel");
    const url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
    const tall = img.naturalHeight > img.naturalWidth * 0.55;
    $("you-grid").classList.toggle("is-tall", tall);
    btn.hidden = false;
    btn.onclick = () => openLightbox(url, "The pages of your paper that PaperScorer read", "Your paper, as PaperScorer read it", tall);
  } catch (err) {
    console.warn("panel unavailable", err);  // show the score without it
    btn.hidden = true;
  }
}

function render(sid, d, data, getPanel) {
  const modelKey = d.model;
  const md = data.models[modelKey];
  const meta = MODELS[modelKey];
  const decision = d.decision === "accept" || d.decision === "reject" ? d.decision : null;
  if (!md || !meta || !decision) {
    showMessage("This result is incomplete", "We found your result but could not read it. Please write to us with the link from your email.");
    return;
  }
  // schema_version 3 carries the chance of acceptance (prior-corrected) and the prior. Older docs
  // (v2: max-style confidence, no prior) show only the lean; their numbers are not recomputed.
  const v3 = d.schema_version >= 3 && isProb(d.p_accept) && isProb(d.prior) && d.prior > 0 && d.prior < 1;
  const pi = v3 ? d.prior : md.prior;
  const labels = v3 ? chanceLabels(d.p_accept, pi) : { you: null, base: pct(pi) };
  const you = v3 ? { p: d.p_accept, label: labels.you } : null;
  const Dec = decision === "accept" ? "Accept" : "Reject";
  const name = meta.name;

  // 1. Your paper: the title, the lean and the chance of acceptance, then the panel the model read.
  const decEl = $("you-dec");
  decEl.textContent = `Leans ${Dec}`;
  decEl.className = `dec dec-${decision}`;
  const chanceEl = $("you-chance");
  if (v3) {
    const num = document.createElement("span");
    num.className = "you-pct";
    num.textContent = `${labels.you} chance of acceptance`;
    chanceEl.replaceChildren(" - ", num, ` (${meta.base(labels.base)})`);
  } else {
    chanceEl.replaceChildren();
  }
  // Optional title extracted from page 1 (display text only; may be slightly garbled).
  const title = typeof d.title === "string" ? d.title.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  $("you-title").textContent = title;
  $("you-title").hidden = !title;
  // The panel lives at results/{sid}/panel.jpg; anything outside this result's folder is ignored.
  if (typeof d.panel === "string" && d.panel.startsWith(`results/${sid}/`) && getPanel) showPanel(d.panel, getPanel);

  // 2. Reliability diagram.
  const chartModel = $("chart-model");
  chartModel.textContent = name;
  chartModel.href = `https://huggingface.co/${meta.repo}`;
  $("legend-you").hidden = !you;
  const minPlot = data.minPlot ?? 5;
  const ub = you ? binOf(you.p) : -1;
  const bin = you ? md.bins[ub] : null;
  const accepted = bin && bin.n ? `${bin.nAccepted} of them ${bin.nAccepted === 1 ? "was" : "were"} accepted` : "";
  $("chart-sentence").textContent = !you
    ? "This result was scored before PaperScorer reported a chance of acceptance, so it is not placed on the chart."
    : bin.n >= minPlot
      ? `Of the ${bin.n} test papers given ${aRange(bin)} chance, ${pct(bin.rate)} were accepted.`
      : bin.n
        ? `Only ${plural(bin.n, "test paper was", "test papers were")} given ${aRange(bin)} chance, too few to plot; ${accepted}.`
        : `No test paper was given ${aRange(bin)} chance, so the chart cannot check a chance this ${ub > md.priorBin ? "high" : "low"}.`;

  // 3. Examples in the user's bin with the same lean (outside the bin holding the prior, every
  //    paper in a bin has the same lean), nearest bins first.
  const ex = you ? md.examples[decision]?.[ub] : null;
  $("examples").hidden = !ex;
  if (ex) {
    const n = ex.papers.length;
    const nWord = n <= 10 ? COUNT_WORDS[n] : String(n);
    const inPiBin = ub === md.priorBin;
    const lean = inPiBin ? ` and that lean ${Dec}, like yours` : "";
    $("ex-hd").textContent = "Test papers PaperScorer gave a similar chance";
    // ex.from: [{bin, n}], how many examples came from which bin (nearby bins fill a sparse one).
    const nOwn = ex.from.find((f) => f.bin === ub)?.n || 0;
    const sameBin = nOwn === n;
    $("ex-lead").textContent = (sameBin
      ? `${nWord} papers from the natural-rate test set that PaperScorer gave ${aRange(bin)} chance of acceptance${lean}.`
      : `${nWord} papers from the natural-rate test set that lean ${Dec}, like yours, at the closest chance PaperScorer gave.`) +
      " Some papers at this chance were accepted and some were not; the chart above shows how often. Click a page panel to enlarge it.";
    const note = $("ex-note");
    note.hidden = sameBin;
    if (!sameBin) {
      const names = ex.from.filter((f) => f.bin !== ub).map((f) => range(md.bins[f.bin]));
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
      const ranges = names.length > 1 ? "ranges" : "range";
      const few = `Few ${meta.short} test papers ${inPiBin ? `that lean ${Dec} ` : ""}get ${aRange(bin)} chance`;
      note.textContent = nOwn
        ? `${few}, so only ${nOwn} of these ${nOwn === 1 ? "comes" : "come"} from that range; the rest come from the ${list} ${ranges}.`
        : `${few}, so these come from the ${list} ${ranges}.`;
    }
    renderExamples(ex.papers, modelKey);
  }

  $("state-loading").hidden = true;
  $("state-wait").hidden = true;
  $("state-ok").hidden = false;
  document.title = "PaperScorer: Your Result";

  const chart = $("chart");
  const draw = () => drawChart(chart, md, minPlot, pi, meta.line(labels.base), you);
  draw();
  let lastW = chart.clientWidth;
  new ResizeObserver(() => {
    if (Math.abs(chart.clientWidth - lastW) > 1) { lastW = chart.clientWidth; draw(); }
  }).observe(chart);
}

// --- Waiting for the result -----------------------------------------------------------------

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// step: 0 received (queued), 1 scoring, 2 loading the result.
function showWaiting(step, title, queue) {
  $("state-loading").hidden = true;
  $("state-msg").hidden = true;
  ["track-received", "track-scoring", "track-result"].forEach((id, i) => {
    $(id).classList.toggle("is-done", i < step || i === 0);
    $(id).classList.toggle("is-now", i === step && i > 0);
    if (i === step) $(id).setAttribute("aria-current", "step"); else $(id).removeAttribute("aria-current");
  });
  $("wait-title").textContent = title;
  const backlog = Number(queue?.backlog);
  const ahead = step === 0 && Number.isInteger(backlog) && backlog > 0;
  $("wait-ahead").textContent = ahead ? `${plural(backlog, "paper", "papers")} ahead of yours.` : "";
  $("wait-ahead").hidden = !ahead;
  $("wait-busy").hidden = !(step < 2 && queue?.degraded === true);
  $("state-wait").hidden = false;
  document.title = step === 1 ? "PaperScorer: Scoring Your Paper" : "PaperScorer: Waiting for Your Result";
}

// results/{sid} is missing: follow progress/{sid} with one listener until the result exists,
// the paper fails, or 30 minutes pass. The listener is dropped as soon as any of these happens,
// and when the page is hidden or unloaded.
function waitForResult(sid, source, data) {
  let queue = null;
  let current = null;  // last progress doc (null: received, not started)
  let unsubscribe = null;
  let finished = false;
  let timer = 0;

  const stop = () => {
    clearTimeout(timer);
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  };
  const finish = () => { finished = true; stop(); };
  const paint = () => {
    if (current?.state === "scoring") {
      showWaiting(1, "Being scored now. This usually takes about 3 minutes.", queue);
    } else {
      showWaiting(0, "Received, waiting to be scored.", queue);
    }
  };

  async function onScored() {
    finish();
    showWaiting(2, "Scored. Loading your result…", queue);
    for (let attempt = 0; attempt <= RESULT_RETRIES; attempt++) {
      if (attempt) await sleep(RESULT_RETRY_MS);
      let d = null;
      try { d = await source.getResult(); } catch (err) { console.warn("result read failed", err); }
      if (d) return render(sid, d, data, source.getPanel);
    }
    // Writing the result page is best-effort on the worker; the email still carries the result.
    showMessage("Your paper was scored", "The result was emailed to you.");
  }

  function onProgress(p) {
    if (finished) return;
    current = p;
    if (p?.state === "scored") return onScored();
    if (p?.state === "failed") {
      finish();
      const text = Object.hasOwn(FAIL_TEXT, p.fail_stage) ? FAIL_TEXT[p.fail_stage] : FAIL_FALLBACK;
      return showMessage("We could not score this paper", text);
    }
    paint();  // no doc, "scoring", or a state this page does not know yet
  }

  function onError(err) {
    if (finished) return;
    console.error("progress listener failed", err);
    finish();
    showUnavailable();
  }

  function start() {
    unsubscribe = source.watchProgress(onProgress, onError);
    timer = setTimeout(() => {
      if (finished) return;
      finish();
      showMessage("We could not find progress for this link yet", "Check your email or come back later.");
    }, source.waitLimitMs ?? WAIT_LIMIT_MS);
  }

  paint();
  source.getQueue()
    .then((q) => { queue = q; if (!finished) paint(); })
    .catch((err) => console.warn("queue status unavailable", err));
  start();

  // Drop the listener when the page goes away; a page restored from the back/forward cache reloads.
  addEventListener("pagehide", stop);
  addEventListener("pageshow", (e) => { if (e.persisted && !finished) location.reload(); });
}

async function main() {
  const dlg = $("lightbox");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  const sid = (params.get("id") || "").trim();
  if (!SID_RE.test(sid)) return showBadLink();

  const dataP = fetch("./result-data.json", { cache: "no-cache" }).then((r) => {
    if (!r.ok) throw new Error(`result-data.json: ${r.status}`);
    return r.json();
  });
  let source, first, data;
  try {
    source = !STUB ? await firebaseSource(sid)
      : STUB.startsWith("progress:") ? stubProgressSource(sid, STUB.slice("progress:".length))
      : await stubResultSource(sid, STUB);
    [first, data] = await Promise.all([source.getResult(), dataP]);
  } catch (err) {
    console.error(err);
    return showUnavailable();
  }
  if (first) return render(sid, first, data, source.getPanel);
  if (!source.watchProgress) return showMissing();
  waitForResult(sid, source, data);
}

main();
