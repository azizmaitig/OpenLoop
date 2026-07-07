---
last_run: '2026-07-07T04:39:57.610Z'
current_state: running
iteration: 1
active_children: 0
high_priority: 0
watch_items: 0
task_count: 1
---





## Tasks

### High Priority
- [ ] **Build failure** — CI fails on Windows in `src/llm.ts` line 42: `Bun.spawn` does not accept `.ps1` extension. Needs a shim that resolves the true executable before spawning.
- [ ] **State drift** — `STATE.md` iteration counter not reliably incremented across all branches. Some plan paths leave it stale, causing loop re-entry detection to miss restarts.

### Watch Items
- [ ] **Worktree cleanup** — `worktree.ts` creates git worktrees but does not auto-clean on interruption. If the loop crashes mid-worktree, stale branches accumulate. Only act if >5 stale worktrees detected.

### Recently Closed
- [x] Opencode provider — `callOpenCode()` implemented. Root cause: Windows file buffer not flushed before PowerShell read. Fix: read-back after write.
