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
