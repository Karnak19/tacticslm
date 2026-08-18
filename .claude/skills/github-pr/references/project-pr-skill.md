# Creating a project `pr` skill

A project `pr` skill is an **opt-in override**: it carries the per-repo settings that differ from the global defaults. Without one, the global `github-pr` skill just works with defaults (no screenshots, no review bot, squash merge). Create one when the repo deviates — it has a UI worth screenshotting, a review bot, a custom merge policy, or its own build gate.

## Where it lives

`.claude/skills/pr/SKILL.md` or `.agents/skills/pr/SKILL.md` — both are read (fitcrew keeps the file in `.claude/skills/pr/` and symlinks `.agents/skills/pr` to it, but either location alone works). The `name` in frontmatter must match the folder: `pr`.

**Team projects: also vendor the `github-pr` skill into the repo** (`.claude/skills/github-pr/`, copied from the global install) — teammates can't be expected to have a machine-local copy, and this skill's procedure is only as reliable as its pointer. The vendored copy shadows the global one on machines that have both; same content, no conflict.

## Frontmatter

```yaml
---
name: pr
description: <triggers so the agent fires it on its own — opening a PR, pushing a branch for review, answering review comments, asking what the review bot says>
---
```

The description is what makes the agent reach for this skill instead of (or before) the global one. Model-invoked — no `disable-model-invocation`.

## Body

One pointer line to the shared procedure, then the settings table:

> Read `.claude/skills/github-pr/SKILL.md` and run its procedure with these values:

## Settings

Defaults live in the global skill; list here what differs (a full table like fitcrew's is fine too — the agent reads whichever you write).

| Setting | Default | Meaning |
|---|---|---|
| owner/repo | derived from `git remote get-url origin` | only needed if remote parsing would be wrong |
| frontend | no | `yes` = the repo has a UI; screenshots become required for UI changes |
| target viewport | 390x844 | screenshot size |
| review bot | none | GitHub App login that reviews on push; drives the review loop (CI + human review otherwise) |
| merge style | squash | what `gh pr merge` should do (rulesets usually force squash anyway) |
| screenshots heading | — | heading for shots in the PR body (fitcrew: `## Écrans`) |
| build gate | the project's AGENTS.md | the build + self-check commands; the bar is a green build |

## Example

fitcrew's — the reference project copy — is its own file: [`fitcrew.md`](fitcrew.md).

## Checklist

- Folder named `pr`, `name: pr` in frontmatter.
- Description has the triggers — otherwise the agent never loads it.
- Pointer line to the global skill present.
- At least the settings that deviate from defaults are listed.
