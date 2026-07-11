$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\loop-factory\notes'
$src = Join-Path $root 'src'
$public = Join-Path $root 'public'
if (-not (Test-Path $src)) { New-Item -ItemType Directory -Path $src | Out-Null }
if (-not (Test-Path $public)) { New-Item -ItemType Directory -Path $public | Out-Null }

# ---- notes store: file-backed markdown with tags + trash ----
$store = @'
import { promises as fs } from "node:fs";
import path from "node:path";

const NOTES_DIR = path.resolve(process.env.NOTES_DIR ?? path.join(import.meta.dirname, "..", "notes"));

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  trashed: boolean;
  createdAt: string;
  updatedAt: string;
}

function slug(title: string, id: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${base || "note"}-${id}.md`;
}

function parse(file: string, raw: string): Note {
  const id = file.replace(/\.md$/, "").split("-").pop() ?? file;
  const meta = raw.match(/^<!--\s*tags:(.*?)\s*trashed:(.*?)\s*-->\s*\n/);
  const m = raw.match(/^<!--[\s\S]*?-->\s*\n#\s+(.*)\r?\n/);
  const title = m ? m[1].trim() : "(untitled)";
  const body = m ? raw.slice(m[0].length) : raw.replace(/^<!--[\s\S]*?-->\s*\n/, "");
  const tags = meta ? meta[1].split(",").map((t) => t.trim()).filter(Boolean) : [];
  const trashed = meta ? meta[2].trim() === "true" : false;
  return { id, title, body: body.replace(/^\r?\n/, ""), tags, trashed, createdAt: "", updatedAt: "" };
}

function serialize(n: Note): string {
  const tagLine = `<!-- tags:${n.tags.join(",")} trashed:${n.trashed} -->`;
  return `${tagLine}\n# ${n.title}\n\n${n.body}`;
}

async function files(): Promise<string[]> {
  await fs.mkdir(NOTES_DIR, { recursive: true });
  return (await fs.readdir(NOTES_DIR)).filter((f) => f.endsWith(".md"));
}

export async function listNotes(opts: { trashed?: boolean; tag?: string; q?: string } = {}): Promise<Note[]> {
  let out = (await Promise.all((await files()).map(async (f) => parse(f, await fs.readFile(path.join(NOTES_DIR, f), "utf8")))));
  if (opts.trashed !== undefined) out = out.filter((n) => n.trashed === opts.trashed);
  if (opts.tag) out = out.filter((n) => n.tags.includes(opts.tag!));
  if (opts.q) {
    const q = opts.q.toLowerCase();
    out = out.filter((n) => n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) || n.tags.some((t) => t.toLowerCase().includes(q)));
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export async function getNote(id: string): Promise<Note | null> {
  for (const f of await files()) {
    if (f.endsWith(`-${id}.md`)) return parse(f, await fs.readFile(path.join(NOTES_DIR, f), "utf8"));
  }
  return null;
}

export async function createNote(title: string, body: string, tags: string[] = []): Promise<Note> {
  const id = Math.random().toString(36).slice(2, 10);
  const now = new Date().toISOString();
  const note: Note = { id, title, body, tags, trashed: false, createdAt: now, updatedAt: now };
  await fs.writeFile(path.join(NOTES_DIR, slug(title, id)), serialize(note), "utf8");
  return note;
}

export async function updateNote(id: string, patch: Partial<Pick<Note, "title" | "body" | "tags">>): Promise<Note | null> {
  const f = (await files()).find((x) => x.endsWith(`-${id}.md`));
  if (!f) return null;
  const cur = parse(f, await fs.readFile(path.join(NOTES_DIR, f), "utf8"));
  const next: Note = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(path.join(NOTES_DIR, f), serialize(next), "utf8");
  return next;
}

export async function trashNote(id: string, trashed = true): Promise<boolean> {
  const cur = await getNote(id);
  if (!cur) return false;
  const f = (await files()).find((x) => x.endsWith(`-${id}.md`))!;
  const next: Note = { ...cur, trashed };
  await fs.writeFile(path.join(NOTES_DIR, f), serialize(next), "utf8");
  return true;
}

export async function deleteNote(id: string): Promise<boolean> {
  const f = (await files()).find((x) => x.endsWith(`-${id}.md`));
  if (!f) return false;
  await fs.unlink(path.join(NOTES_DIR, f));
  return true;
}
'@
Set-Content -Path (Join-Path $src 'store.ts') -Value $store

# ---- server: API + static ----
$server = @'
import express from "express";
import path from "node:path";
import { listNotes, getNote, createNote, updateNote, trashNote, deleteNote } from "./store.js";

export function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(import.meta.dirname, "..", "public")));

  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/api/notes", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const trashed = req.query.trashed === "true";
    res.json(await listNotes({ q, tag, trashed }));
  });

  app.get("/api/notes/:id", async (req, res) => {
    const n = await getNote(req.params.id);
    if (!n) return res.status(404).json({ error: "not found" });
    res.json(n);
  });

  app.post("/api/notes", async (req, res) => {
    const { title, body, tags } = req.body ?? {};
    if (!title || typeof body !== "string") return res.status(400).json({ error: "title (string) and body (string) required" });
    res.status(201).json(await createNote(title, body, Array.isArray(tags) ? tags : []));
  });

  app.put("/api/notes/:id", async (req, res) => {
    const n = await updateNote(req.params.id, req.body ?? {});
    if (!n) return res.status(404).json({ error: "not found" });
    res.json(n);
  });

  app.patch("/api/notes/:id/trash", async (req, res) => {
    const ok = await trashNote(req.params.id, true);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ trashed: req.params.id });
  });

  app.patch("/api/notes/:id/restore", async (req, res) => {
    const ok = await trashNote(req.params.id, false);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ restored: req.params.id });
  });

  app.delete("/api/notes/:id", async (req, res) => {
    const ok = await deleteNote(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ deleted: req.params.id });
  });

  return app;
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  buildApp().listen(port, () => console.log(`notes-app listening on :${port}`));
}
'@
Set-Content -Path (Join-Path $src 'server.ts') -Value $server

# ---- index.html: 3-pane UI, textarea + live preview, tags, search, trash ----
$html = @'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Notes</title>
<style>
  :root { --bg:#fafafa; --panel:#fff; --border:#e3e3e3; --text:#1a1a1a; --muted:#777; --accent:#2563eb; }
  [data-theme="dark"] { --bg:#16161a; --panel:#1e1e24; --border:#2c2c34; --text:#e6e6e6; --muted:#999; --accent:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 system-ui, sans-serif; background:var(--bg); color:var(--text); height:100vh; display:flex; flex-direction:column; }
  header { display:flex; gap:8px; align-items:center; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--panel); }
  header h1 { font-size:15px; margin:0; flex:1; }
  button { cursor:pointer; border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:6px; padding:5px 10px; font-size:13px; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  main { flex:1; display:grid; grid-template-columns:280px 1fr 1fr; min-height:0; }
  .col { border-right:1px solid var(--border); display:flex; flex-direction:column; min-height:0; overflow:hidden; }
  .col:last-child { border-right:none; }
  .search { padding:8px; border-bottom:1px solid var(--border); }
  .search input { width:100%; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); }
  .list { overflow:auto; flex:1; }
  .item { padding:8px 12px; border-bottom:1px solid var(--border); cursor:pointer; }
  .item.active { background:var(--accent); color:#fff; }
  .item .t { font-weight:600; }
  .item .s { color:var(--muted); font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .item.active .s { color:#e6e6e6; }
  .editor { display:flex; flex-direction:column; padding:10px; gap:8px; min-height:0; }
  .editor input.title { font-size:16px; font-weight:600; padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); }
  .editor .tagsin { padding:6px 8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); }
  textarea { flex:1; resize:none; padding:8px; border:1px solid var(--border); border-radius:6px; background:var(--bg); color:var(--text); font:13px/1.5 ui-monospace, monospace; }
  .preview { padding:12px; overflow:auto; }
  .preview h1 { margin-top:0; }
  .muted { color:var(--muted); }
  .row { display:flex; gap:6px; }
</style>
</head>
<body>
<header>
  <h1>Notes</h1>
  <button id="new">+ New</button>
  <button id="trashView">Trash</button>
  <button id="theme">Theme</button>
</header>
<main>
  <section class="col">
    <div class="search"><input id="search" placeholder="Search notes..." /></div>
    <div class="list" id="list"></div>
  </section>
  <section class="col editor">
    <input class="title" id="title" placeholder="Title" />
    <input class="tagsin" id="tags" placeholder="tags, comma, separated" />
    <textarea id="body" placeholder="Write markdown... (auto-saves)"></textarea>
    <div class="row">
      <button id="save" class="primary">Save</button>
      <button id="trash">Move to Trash</button>
    </div>
  </section>
  <section class="col preview" id="preview"><p class="muted">Select or create a note.</p></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let currentId = null, trashedView = false, debounce;

function md(src) {
  return src
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>)/gs, "<ul>$1</ul>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>");
}

async function load() {
  const q = $("search").value;
  const url = `/api/notes?trashed=${trashedView}` + (q ? `&q=${encodeURIComponent(q)}` : "");
  const notes = await (await fetch(url)).json();
  const list = $("list"); list.innerHTML = "";
  for (const n of notes) {
    const d = document.createElement("div");
    d.className = "item" + (n.id === currentId ? " active" : "");
    d.innerHTML = `<div class="t"></div><div class="s"></div>`;
    d.querySelector(".t").textContent = n.title || "(untitled)";
    d.querySelector(".s").textContent = (n.body || "").slice(0, 60);
    d.onclick = () => open(n);
    list.appendChild(d);
  }
}

async function open(n) {
  currentId = n.id;
  $("title").value = n.title; $("tags").value = (n.tags || []).join(", ");
  $("body").value = n.body; renderPreview();
  $("trash").textContent = trashedView ? "Restore" : "Move to Trash";
  load();
}

function renderPreview() { $("preview").innerHTML = "<p>" + md($("body").value) + "</p>"; }

function autoSave() { clearTimeout(debounce); debounce = setTimeout(save, 500); }

function tagArr() { return $("tags").value.split(",").map(t=>t.trim()).filter(Boolean); }

async function save() {
  if (!currentId) {
    const n = await (await fetch("/api/notes", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ title:$("title").value, body:$("body").value, tags: tagArr() }) })).json();
    currentId = n.id;
  } else {
    await fetch(`/api/notes/${currentId}`, { method:"PUT", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ title:$("title").value, body:$("body").value, tags: tagArr() }) });
  }
  renderPreview(); load();
}

$("new").onclick = () => { currentId = null; $("title").value=""; $("tags").value=""; $("body").value=""; renderPreview(); load(); };
$("save").onclick = save;
$("body").oninput = () => { renderPreview(); autoSave(); };
$("title").oninput = autoSave; $("tags").oninput = autoSave;
$("search").oninput = load;
$("theme").onclick = () => { const t = document.body.dataset.theme === "dark" ? "" : "dark"; document.body.dataset.theme = t; localStorage.setItem("theme", t); };
$("trashView").onclick = () => { trashedView = !trashedView; load(); };
$("trash").onclick = async () => {
  if (!currentId) return;
  await fetch(`/api/notes/${currentId}/${trashedView ? "restore" : "trash"}`, { method:"PATCH" });
  currentId = null; load();
};
document.body.dataset.theme = localStorage.getItem("theme") || "";
load();
</script>
</body>
</html>
'@
Set-Content -Path (Join-Path $public 'index.html') -Value $html

# ---- tests (no network) ----
$tests = @'
import { describe, it, expect, beforeEach } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listNotes, getNote, createNote, updateNote, trashNote, deleteNote } from "../src/store";

const dir = path.join(os.tmpdir(), `notes-test-${Date.now()}`);
process.env.NOTES_DIR = dir;

beforeEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
});

describe("notes store", () => {
  it("creates and lists a note", async () => {
    const n = await createNote("Hello", "body");
    const all = await listNotes();
    expect(all.length).toBe(1);
    expect(all[0].title).toBe("Hello");
  });
  it("stores tags", async () => {
    const n = await createNote("T", "b", ["a", "b"]);
    const got = await getNote(n.id);
    expect(got!.tags).toEqual(["a", "b"]);
  });
  it("reads by id", async () => {
    const n = await createNote("T", "the body");
    expect((await getNote(n.id))!.body).toBe("the body");
  });
  it("updates a note", async () => {
    const n = await createNote("T", "b");
    const u = await updateNote(n.id, { title: "T2", body: "b2" });
    expect(u!.title).toBe("T2");
    expect(u!.body).toBe("b2");
  });
  it("soft-trashes then restores", async () => {
    const n = await createNote("T", "b");
    expect(await trashNote(n.id, true)).toBe(true);
    expect((await listNotes({ trashed: true })).length).toBe(1);
    expect((await listNotes({ trashed: false })).length).toBe(0);
    await trashNote(n.id, false);
    expect((await listNotes({ trashed: false })).length).toBe(1);
  });
  it("filters by tag", async () => {
    await createNote("A", "x", ["work"]);
    await createNote("B", "y", ["home"]);
    expect((await listNotes({ tag: "work" })).length).toBe(1);
  });
  it("full-text search across body", async () => {
    await createNote("Apple", "red fruit");
    await createNote("Banana", "yellow fruit");
    expect((await listNotes({ q: "yellow" })).length).toBe(1);
  });
  it("hard-deletes a note", async () => {
    const n = await createNote("T", "b");
    expect(await deleteNote(n.id)).toBe(true);
    expect(await getNote(n.id)).toBeNull();
  });
});
'@
$testDir = Join-Path $root 'tests'
if (-not (Test-Path $testDir)) { New-Item -ItemType Directory -Path $testDir | Out-Null }
Set-Content -Path (Join-Path $testDir 'store.test.ts') -Value $tests

Write-Host "write-notes-source-ok"
