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
