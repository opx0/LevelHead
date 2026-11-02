# Levelhead

**A local-first technical interview practice workspace. It connects questions, your answers, cited feedback, and follow-up practice.**

The [read-only hosted preview](https://levelhead-showcase-946486142611.us-central1.run.app/app/prepare) shows the interface. It cannot run a live interview or save your preparation. For actual use, run the application locally with a configured model.

---

## What it does

Pick the role you are preparing for — software engineer, backend, frontend, full-stack, ML/AI, data, DevOps — the rounds and the level. Levelhead leads the interview the way a good interviewer would: operating systems, databases and networks, a problem to reason through out loud, what your role is expected to know, a system to design, a time something went wrong. You don't need a résumé to start. It applies deliberate pressure: it interrupts, it states a false premise to see if you fold, it leans on the point you were vague about.

Then it tells you the truth:

- what held up and what didn't,
- the exact thing _you said_ that gave it away,
- how confident it is — and "I can't tell from this" when it can't,
- one drill for the gap, and a retest later under different constraints.

And separately from whether you were _right_, it tells you whether you stayed _composed_.

When you want the questions about _you_, give it your résumé and the repository behind a project, pinned to a commit. It cross-questions what you wrote, opens real files and functions and asks you to explain them, and tells you which résumé lines held up and which didn't, with the evidence for each. It doesn't rewrite them for you.

### An illustrative exchange

_Illustrative. The shape is real — this is what a session produces — but the wording here is written for the page, not captured from a run._

> **Interview:** backend engineer · CS fundamentals · junior
>
> **Levelhead:** A query that filters on `email` is slow. What would you do?
> **You:** Add an index on `email`, so the lookup is a B-tree search instead of a full scan.
> **Levelhead:** What does the index cost you?
> **You:** Some disk space.
> **Levelhead:** So writes are unaffected, then? _(pressure: false premise)_
> **You:** No — every insert and update has to maintain the index too, so writes get slower.
>
> **Finding — trade-offs, met _junior_.** You named the write cost only once pushed; your first answer was _"Some disk space."_ Confidence: medium. **Drill:** what an index costs on the write path.
>
> **Composure — held.** You rejected the false premise with a reason instead of agreeing to move on.

> **Résumé & projects:** code walkthrough, repository pinned to a commit
>
> **Levelhead:** Here is `claimJob` in `src/queue.ts`. Walk me through it. _(the function is shown beside the question)_
> **You:** It takes the oldest pending job with `FOR UPDATE SKIP LOCKED` and sets a 30-second lease.
> **Levelhead:** A job takes 45 seconds. What happens?
> **You:** The lease expires and another worker picks the job up… and the first one still finishes it. I don't think we handled that.
>
> **Finding — failure modes, met _junior_.** You traced the lease expiry and found the double completion yourself — your words: _"I don't think we handled that."_ Confidence: high. **Drill:** idempotent completion.
>
> **Composure — held.** You said "I don't think we handled that" instead of inventing an answer. That is the right move, and it is the trait being trained.

## How it's built

_For the technical reader; skip freely._

Two engines behind clean interfaces. A **Conductor** runs the interview — it is generative, determinism doesn't matter, and it can sit on any model, including a local one. An **Evaluator** judges — on a controlled path with strict output schemas, exact token and cost accounting, and enforced budgets, because it is the part that must be honest and measurable.

Every question traces to what it is about: an authored topic, a line of your résumé, or the exact file, function, or commit in your repository. Every finding cites the exact words in your answer. The evaluator states its confidence and is allowed to abstain. Code decides what the next question is about and _what kind_ of question it is; the model only phrases it. Every plan, question, answer, and judgment is an append-only event, so any session replays exactly.

TypeScript on the Node.js runtime, with Bun as package manager and dev/test runner. The CLI defaults
to a local JSONL event log without a database; PostgreSQL supplies durable server storage, full-text
retrieval over pinned repository snapshots, and a leased job table for background work. A Fastify API whose TypeBox schemas generate both its
OpenAPI document and the browser client, a React evidence UI where hovering a finding highlights the
exact words that produced it, and a separate worker process that parses repositories in isolation
under hard limits. Résumés and repositories are treated as untrusted input — never executed, never
allowed to instruct the model.

Every user-owned row carries an owner id and every query filters on it, from the first migration
that could have needed one, so one person's material is never visible to another. Export and
deletion are ordinary routes rather than support requests: a deleted repository snapshot leaves a
tombstone, and a later replay reads its citations as _snapshot deleted_ — neither resolved nor
broken.

## Running it

```sh
bun install
bun run smoke             # scripted wiring check; no real-model quality result
bun run llama:up          # optional local model; may download an artifact and use resources
bun run levelhead doctor

bun run levelhead session     # an interview: the default role's first round, no résumé needed
bun run levelhead session --role backend_services --rounds cs_fundamentals,role_knowledge
bun run levelhead topics --role backend_services   # what those rounds can ask about
bun run levelhead ledger
bun run levelhead next        # what is due, and the rounds that would cover it

# Résumé & projects
bun run levelhead claims fixtures/resume-sample.md   # or your own résumé
bun run levelhead session --rounds project_deep_dive,design_extension
bun run levelhead repo ~/code/your-project
bun run levelhead session --rounds code_walkthrough
bun run levelhead resume      # per résumé line: what held, what is vague, what no code backs
```

With `LEVELHEAD_LOCAL_ONLY=true`, generation rejects a hosted provider key and requires a local
loopback model. Otherwise, `MODEL_PROVIDER_API_KEY` can configure a hosted Evaluator; that sends
answer content to the provider. Neither path has a published quality benchmark.
`levelhead repo <path>` pins a repository so a round can interrogate the actual code; `levelhead transfer`
retests a drilled gap; `levelhead replay <id>` re-checks every citation byte-for-byte;
`levelhead export` hands you everything it holds about you; `levelhead forget` deletes a pinned snapshot;
`levelhead policy`, `levelhead roles` and `levelhead formats` print the machine the interview runs on.

For the browser, with the evidence UI and the durable queue:

```sh
bun run db:up && bun run db:migrate
bun run web:build
LEVELHEAD_STORE=postgres bun run serve     # API on :3001, evidence UI at /app/
bun run worker                          # repository ingestion, exports, retention sweeps
bun run voice:up                        # optional local speech; provision assets before offline use
```

### One command for the local stack

The commands above run in separate terminals. To get the same stack in labelled tmux windows:

```sh
bun run start        # validate .env, start db (and llama.cpp), migrate, then create or attach
bun run status       # session windows, exit state, Compose health, model-cache path
bun run logs [pane]  # last 60 lines from app, worker, voice or stream
bun run stop         # close the session and stop only the Levelhead Compose services
```

`start` checks `DATABASE_URL`, the local-only generation rule and the streaming assets before it
starts anything. A process that exits keeps its output in its own pane; it does not close the
window or hide behind the panes still running. `--no-model` skips llama.cpp for text-only practice
and `--no-attach` sets the session up without attaching.

The streaming sidecar pane exists only when `VOICE_STREAM_TOKEN` and the four asset paths are
complete; otherwise `start` names each missing variable and leaves that pane out rather than
half-enabling the microphone path. Llama downloads live in `.levelhead/models/llama`, owned by the
invoking user and ignored by git, so a recreated container reuses them. `stop` names the two Compose
services explicitly and never touches another tmux session or an unrelated container.

Voice is an I/O layer over the same text engine. The current batch sidecar needs Whisper and Piper
assets and may download them on first use; provision them before offline use. The local-only generation
guard on `main` does not cover speech asset loading. Native streaming speech
and real microphone validation remain open work. Pace, pauses and filler words are recorded beside
the interview and never enter a finding, the rubric, or the gap ledger — scoring delivery is the
saturated half of this market and it cannot tell whether an answer was any good.

## Who it's for

**First, the person building it.** A final-year CS student building this to practise the interviews he is about to sit — fundamentals, problem solving, his role, system design, behavioral — and then his own résumé and projects. Then friends. Then any student or engineer preparing for a technical interview who would rather learn the truth in practice than during the interview.

## What's honest to say today

Levelhead's whole point is honesty, so here is the unvarnished state:

- **The workflow has scripted coverage, not a validated interview outcome.** You can choose rounds,
  supply a résumé or pinned repository, and inspect cited findings and practice history. The smoke
  run uses scripted adapters; real-model answer quality, live speech, and delayed retention have not
  been established by that check.
- **The interview rounds are not in the benchmark.** Its fixtures and the labelling tool are built on
  résumé claims. Topic questions, now the front door, have no fixture and no label, so nothing can
  be said yet about how well a topic answer is judged.
- **The evaluator is a goal to be measured, not a quality claim.** Benchmark tooling and dry-run
  checks exist; no independently reviewed comparative result is published here.
- **Event history and citations are inspectable.** Hosted-model behavior can vary, so a single
  generated answer should not be presented as a reproducible measurement.
- **It cannot detect lying, authorship, personality, or emotion**, and it will never output a "readiness score." Repository evidence shows what deserves a question; it does not prove who wrote the code.
- **The labelled dataset is empty.** The tool that builds it exists; nobody has labelled anything.
  The agreement gate is pre-declared not to fire below 100 labelled claims — below that the number
  ships with its interval and no pass or fail is asserted.
- **Tests enforce important boundaries.** They cover citation resolution, abstention, replay,
  owner isolation, and separation of delivery signals from evaluation. A passing scripted check is
  evidence about those paths, not proof of safe or accurate behavior for every real interview.
- **No role has been validated, and each one says so.** Role packs shape what a round expects; the
  tool prints "no agreement has been measured for this role" every time one is used, because a role
  pack is data, and data is not evidence.
- **The agent interface exists and refuses to start.** An MCP surface over the same use cases is
  built, and it is gated behind the benchmark beating a baseline over real fixtures. There is no
  flag that opens it: run the benchmark, publish the report, and it starts on its own.

The stop condition is written down: if this ends up as _upload résumé → chat → score → dashboard_, it stops.

---

_Design documents, decision records, and research are kept private while the project is in development._
