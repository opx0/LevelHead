# PR-Agent

Automated first-pass review on pull requests. It comments on the diff; it does not gate. A red
`Checks` run stays red whether or not PR-Agent reviewed the branch.

Workflow: `.github/workflows/pr-agent.yml`. Tuning: `.pr_agent.toml` at the repository root.

## What runs, and when

- **Automatic:** `pull_request` with action `opened` or `ready_for_review`, for branches in this
  repository. Drafts are skipped. There is no `synchronize` trigger, so pushing to an open PR does
  not start another review; use a comment command when you want a re-run.
- **Manual, from a PR comment:** `/review`, `/describe`, `/improve`, or `/ask <question>`. Only the
  repository owner, members and collaborators are accepted, the PR must still be open, and the
  command must be the comment body. A command on a merged PR is skipped by design.
- **Skipped:** bot comments, forks, drafts, pushes, merges, reopen.

The workflow is separate from `ci.yml`. It has `contents: read`, `issues: write` and
`pull-requests: write`; it cannot push, label, approve or merge.

## Secret

`GEMINI_API_KEY` is a repository Actions secret. If it is missing, the `Check Gemini API key` step
fails with `Add the GEMINI_API_KEY repository Actions secret to enable PR-Agent.` The workflow does
not fall back to another provider, and a missing key is never reported as a successful review.

## Cost and limits

The model and spend ceiling are set in the workflow environment, not guessed at runtime:

- model `gemini/gemini-3.5-flash-lite`, fallback `gemini/gemini-3.1-flash-lite`, reasoning effort
  `low`, output capped at 4096 tokens;
- `.pr_agent.toml` limits the reviewer to 3 findings and clips very large diffs;
- the diff is split at 32 000 tokens; past that the patch is clipped rather than sent whole.

Observed on PR #15 (run 41507905028): the diff was 3 702 tokens and the review finished in about
40 s, including the image pull. Gemini bills per token on your Google AI Studio account; check
current pricing there rather than relying on a figure in this file.

Provider capacity is not a code defect. A `503 UNAVAILABLE` from Gemini fails the job and leaves the
PR unchanged; the review is retried on the next open/`ready_for_review` or comment command.

## Data flow and privacy

- Sent to Google Gemini: the PR diff, PR title and description, and `.pr_agent.toml` review
  instructions.
- Not sent: `AGENTS.md`, `docs/` and other ignored files. `repo_context_files = []` and
  `.pr_agent.toml` is public review guidance only, so private planning stays out of the prompt.
- Kept in GitHub: PR-Agent posts one persistent review comment, edited in place on later runs
  (`persistent_comment = true`). The Gemini key is exposed only as an environment variable inside
  the container step; it is never printed.
- Treat diff content, including résumés, transcripts and repository material, as untrusted data. The
  review prompt says so.

## Upgrade

The image is pinned by digest, not tag:

```
pragent/pr-agent@sha256:b1ed6e8de56eb4d6e4169ee0d5c209bb5ed1ef071a01c0c042c64b80192a785c
```

To upgrade, resolve the digest of the release you want and update the `uses:` line:

```sh
docker buildx imagetools inspect pragent/pr-agent:latest
```

Then open a PR, confirm one real review appears on that PR, and record the run link. Do not replace
the digest with `:latest`; a floating tag would change review behavior without a reviewed commit.
After a model retirement or a pricing change, change `config.model` in the workflow the same way.

## Disable

- **Pause reviews:** disable the `PR-Agent` workflow in the Actions tab. Nothing else changes;
  `ci.yml` and `validate.yml` are independent.
- **Remove permanently:** delete `.github/workflows/pr-agent.yml` and `GEMINI_API_KEY`. Delete
  `.pr_agent.toml` if no other tool uses it.
- **One-off:** keep the workflow but comment `/review` only when a second opinion is wanted. Do not
  delete `Checks` as a substitute; PR-Agent is not the gate.
