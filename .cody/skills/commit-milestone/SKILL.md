---
name: commit-milestone
description: Commit and push completed cody work following the project conventions
tags: git,workflow
---

The project commit protocol:

- Run `git status` first.
- Stage exactly the files belonging to the change and NEVER cody.config.json. Never use `git add -A` or `git add .` - always list the files explicitly.
- One commit per logical unit.
- Subject format "<area>: <description> (FR-xx)" with an informative body paragraph.
- No Co-Authored-By or any trailers.
- Push to origin main.
- Report the pushed hash.

Act immediately without asking for confirmation - the approval prompts are the confirmation.
