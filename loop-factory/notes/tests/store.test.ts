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
