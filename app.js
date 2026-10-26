// PaperScorer submission page. Static; talks only to Firebase.
// Flow: anonymous sign-in -> create submissions/{sid} (UPLOADING) while its email
// is under the daily cap -> upload {sid}.pdf and {sid}.csv -> mark SUBMITTED and
// count it against the email's day in one batch.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, writeBatch, increment, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// Public web config; access is enforced by the security rules and App Check.
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
const MAX_BYTES = 20 * 1024 * 1024;
const DAILY_LIMIT = 5;

// On localhost, use an App Check debug token (printed in the console; register it in the Firebase console).
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  self.FIREBASE_APPCHECK_DEBUG_TOKEN ||= true;
}

const app = initializeApp(firebaseConfig);
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app, BUCKET);

const $ = (id) => document.getElementById(id);
const form = $("submit-form");
const submitBtn = $("submit");
const message = $("message");
const progress = $("progress");
const pdfNote = $("pdf-note");
const pdfInput = $("pdf");
const drop = $("drop");
const dropMain = $("drop-main");
const dropSub = $("drop-sub");
const modelHint = $("model-hint");
const DROP_MAIN = dropMain.textContent;
const DROP_SUB = dropSub.textContent;
const MODEL_HINT = modelHint.textContent;

let user = null;
let prepared = null; // { bytes: Uint8Array, pages: number, cropped: boolean }

function say(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function newSubmissionId() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function csvField(value) {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function preparePdf(file) {
  const original = new Uint8Array(await file.arrayBuffer());
  const src = await PDFLib.PDFDocument.load(original);
  const pages = src.getPageCount();
  if (pages <= MAX_PAGES) return { bytes: original, pages, cropped: false };
  const out = await PDFLib.PDFDocument.create();
  const copied = await out.copyPages(src, [...Array(MAX_PAGES).keys()]);
  copied.forEach((p) => out.addPage(p));
  return { bytes: await out.save(), pages, cropped: true };
}

// --- UI helpers (display only; no effect on what is uploaded) ---

function formatSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function setDropSub(parts) {
  // parts: array of strings or [number, unit] pairs; numbers are set in the mono face.
  dropSub.replaceChildren();
  parts.forEach((part, i) => {
    if (i) dropSub.append(" · ");
    if (Array.isArray(part)) {
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = part[0];
      dropSub.append(num, ` ${part[1]}`);
    } else {
      dropSub.append(part);
    }
  });
}

function showDrop(state, file) {
  drop.classList.remove("has-file", "bad", "is-busy");
  drop.removeAttribute("aria-invalid");
  if (state === "empty") {
    dropMain.textContent = DROP_MAIN;
    dropSub.textContent = DROP_SUB;
    return;
  }
  dropMain.textContent = file.name;
  if (state === "busy") {
    drop.classList.add("is-busy");
    dropSub.textContent = "Reading the PDF…";
  } else if (state === "bad") {
    drop.classList.add("bad");
    dropSub.textContent = "Choose another file";
  } else {
    drop.classList.add("has-file");
    const pages = prepared.pages === 1 ? "page" : "pages";
    const size = formatSize(prepared.bytes.byteLength).split(" ");
    setDropSub([[prepared.pages, pages], [size[0], size[1]], "click to change"]);
  }
}

function showModel() {
  const conf = $("conference").value;
  if (!conf) { modelHint.textContent = MODEL_HINT; return; }
  const model = conf === "ICLR" ? "PaperScorer-7B-Vision-OpenReview-ICLR" : "PaperScorer-7B-Vision-arXiv";
  const code = document.createElement("code");
  code.textContent = model;
  const link = document.createElement("a");
  link.href = `https://huggingface.co/skonan/${model}`;
  link.append(code);
  modelHint.replaceChildren(`${conf} papers are scored by `, link, ".");
}

function clearInvalid(el) {
  el.removeAttribute("aria-invalid");
  el.closest("label.check")?.classList.remove("is-invalid");
}

function markInvalid() {
  for (const id of ["email", "conference"]) {
    const el = $(id);
    if (el.checkValidity()) clearInvalid(el); else el.setAttribute("aria-invalid", "true");
  }
  for (const id of ["anonymized", "author"]) {
    $(id).closest("label.check").classList.toggle("is-invalid", !$(id).checked);
  }
  if (!prepared) drop.setAttribute("aria-invalid", "true");
  form.querySelector('[aria-invalid="true"], label.check.is-invalid input')?.focus();
}

$("conference").addEventListener("change", (e) => { clearInvalid(e.target); showModel(); });
$("email").addEventListener("input", (e) => clearInvalid(e.target));
for (const id of ["anonymized", "author"]) $(id).addEventListener("change", (e) => clearInvalid(e.target));

// Drag and drop: hand the dropped file to the file input and reuse its change handler.
for (const type of ["dragenter", "dragover"]) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    drop.classList.add("dragging");
  });
}
drop.addEventListener("dragleave", (e) => {
  if (!drop.contains(e.relatedTarget)) drop.classList.remove("dragging");
});
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (!file) return;
  const dt = new DataTransfer();
  dt.items.add(file);
  pdfInput.files = dt.files;
  pdfInput.dispatchEvent(new Event("change", { bubbles: true }));
});
// A file dropped beside the zone should not navigate away from the form.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("pdf").addEventListener("change", async (e) => {
  prepared = null;
  pdfNote.hidden = true;
  const file = e.target.files[0];
  if (!file) { showDrop("empty"); return; }
  showDrop("busy", file);
  try {
    prepared = await preparePdf(file);
  } catch (err) {
    console.error(err);
    showDrop("bad", file);
    say("We could not read that file as a PDF. Please choose another file.", true);
    return;
  }
  if (prepared.cropped) {
    pdfNote.textContent = `Your PDF has ${prepared.pages} pages; only the first ${MAX_PAGES} will be uploaded.`;
    pdfNote.hidden = false;
  }
  if (prepared.bytes.byteLength > MAX_BYTES) {
    showDrop("bad", file);
    say("This PDF is larger than 20 MB after cropping. Please compress it and try again.", true);
    prepared = null;
    return;
  }
  showDrop("ready", file);
  say("");
});

function upload(path, bytes, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), bytes, { contentType });
    task.on("state_changed", (snap) => onProgress && onProgress(snap.bytesTransferred / snap.totalBytes), reject, resolve);
  });
}

// The email's counter id: sha256 of the trimmed, lowercased address as lowercase
// hex, then the UTC day. The rules compute the same id from the submission.
async function emailHash(email) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email.trim().toLowerCase()));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The page cannot read the email counters (so no one can look up an address),
// so a full day shows up as the rules refusing a write. If a read the rules
// always allow still works (signed in, App Check passing), the refusal was the
// daily limit.
async function limitOr(err) {
  if (err.code !== "permission-denied") return err;
  try {
    await getDoc(doc(db, "status", "queue"));
  } catch {
    return err;
  }
  return new Error("daily-limit");
}

// Create the submission. The rules allow it only while the email has fewer than
// 5 counted submissions today, or is on the server-side unlimited list
// (config/limits). Nothing is counted yet.
async function createSubmission(sid, fields) {
  try {
    await setDoc(doc(db, "submissions", sid), { ...fields, status: "UPLOADING", created_at: serverTimestamp() });
  } catch (err) {
    throw await limitOr(err);
  }
}

// Commit the finished upload and count it: mark it SUBMITTED and bump the
// email's counter for today in one batch, so a failed or abandoned upload never
// uses up one of the 5. The rules key the counter on the server's UTC day, so
// retry with the neighbouring day if the browser clock sits on the other side of
// midnight. Emails on the unlimited list may commit without the counter.
async function commitSubmission(sid, email) {
  const today = Math.floor(Date.now() / 86400000);
  const hash = await emailHash(email);
  let lastErr = null;
  for (const day of [today, today - 1, today + 1]) {
    const batch = writeBatch(db);
    batch.set(doc(db, "email_quota", `${hash}_${day}`), { count: increment(1) }, { merge: true });
    batch.update(doc(db, "submissions", sid), { status: "SUBMITTED" });
    try {
      await batch.commit();
      return;
    } catch (err) {
      if (err.code !== "permission-denied") throw err;
      lastErr = err;
    }
  }
  try {
    await updateDoc(doc(db, "submissions", sid), { status: "SUBMITTED" });
    return;
  } catch {
    // not on the unlimited list
  }
  throw await limitOr(lastErr);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const conference = $("conference").value;
  if (!form.checkValidity() || !prepared) {
    markInvalid();
    say("Please fill in every field, choose a PDF, and tick both boxes.", true);
    return;
  }
  submitBtn.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  const sid = newSubmissionId();
  const base = `${user.uid}/${sid}/${sid}`;
  try {
    say("Creating your submission…");
    await createSubmission(sid, { uid: user.uid, email, conference, anonymized_ack: true, author_ack: true });

    say("Uploading…");
    await upload(`${base}.pdf`, prepared.bytes, "application/pdf", (f) => (progress.value = Math.round(f * 95)));
    const csv = "submission_id,email,conference,created_at\n"
      + [sid, email, conference, new Date().toISOString()].map(csvField).join(",") + "\n";
    await upload(`${base}.csv`, new TextEncoder().encode(csv), "text/csv");
    progress.value = 100;

    await commitSubmission(sid, email);

    showDone(sid, email);
    say("");
  } catch (err) {
    console.error(err);
    say(err.message === "daily-limit"
      ? `This email address has reached the limit of ${DAILY_LIMIT} submissions for today (UTC). Please try again tomorrow.`
      : "Something went wrong while submitting. Please try again in a few minutes.", true);
  } finally {
    submitBtn.disabled = false;
    progress.hidden = true;
  }
});

// --- Confirmation (display only) ---

// The result page sits next to this page: works on paperscorer-ai.com, the github.io redirect and localhost.
function resultUrl(sid) {
  const dir = location.pathname.replace(/[^/]*$/, "");
  return `${location.origin}${dir}result.html?id=${encodeURIComponent(sid)}`;
}

let copyTimer = 0;
function setCopied(copied) {
  clearTimeout(copyTimer);
  $("copy-link").classList.toggle("is-copied", copied);
  $("copy-text").textContent = copied ? "Copied" : "Copy";
  if (copied) copyTimer = setTimeout(() => setCopied(false), 2000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page without clipboard permission.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

function showDone(sid, email) {
  const url = resultUrl(sid);
  const link = $("done-link");
  link.href = url;
  link.textContent = url;
  setCopied(false);
  form.hidden = true;
  $("done-email").textContent = email;
  $("done-id").textContent = sid;
  $("done").hidden = false;
}

$("copy-link").addEventListener("click", async () => {
  const link = $("done-link");
  if (await copyText(link.href)) {
    setCopied(true);
  } else {
    // Could not copy: select the link so it can be copied by hand.
    const range = document.createRange();
    range.selectNodeContents(link);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  }
});

$("again").addEventListener("click", () => {
  form.reset();
  prepared = null;
  pdfNote.hidden = true;
  showDrop("empty");
  showModel();
  say("");
  $("done").hidden = true;
  form.hidden = false;
});

async function showQueueStatus() {
  try {
    const snap = await getDoc(doc(db, "status", "queue"));
    if (snap.exists() && snap.data().degraded) {
      $("banner").hidden = false; // the banner's text lives in index.html
    }
  } catch (err) {
    console.warn("status unavailable", err);
  }
}

try {
  user = (await signInAnonymously(auth)).user;
  submitBtn.disabled = false;
  submitBtn.textContent = "Submit";
  showQueueStatus();
} catch (err) {
  console.error("sign-in failed:", err.code, err.message);
  submitBtn.textContent = "Unavailable";
  say("The submission service is not reachable right now. Please try again later.", true);
}
