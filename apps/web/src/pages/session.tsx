import { EndInterruptedInterview } from '../components/session-history.tsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { ApiError, api, type StartSessionBody } from '../api/client.ts'
import type { Finding, QuotedEvidence, TurnUpdate } from '../api/types.ts'
import { EvidenceProvider, Highlighted, useEvidence } from '../components/evidence.tsx'
import { FindingCard } from '../components/finding-card.tsx'
import { ClaimChip, FilePanel, TopicChip } from '../components/question.tsx'
import { Recorder } from '../components/recorder.tsx'
import { LiveRecorder } from '../components/live-recorder.tsx'
import { InterviewCall } from '../components/interview-call.tsx'
import { Button, Empty, Failed, Loading, Panel, Quiet, Tag } from '../components/primitives.tsx'
import { JourneyIcon, JourneyLink, PageIntro, PracticeFlow } from '../components/journey.tsx'
import { useClaimSet, usePreparation } from '../lib/claim-set.ts'
import {
  LEVEL_LABEL,
  ROUND_BLURB,
  ROUND_LABEL,
  inRoundOrder,
  isRound,
  roleAreasLabel,
  roundsAbout,
  subjectOf,
  topicsFor,
  useTopicCatalog,
  type Level,
  type Role,
  type RoundKind,
  type SubjectKind,
  type TopicSummary,
} from '../lib/catalog.ts'
import { words } from '../lib/format.ts'
import { cancelSpeech, speak, type SpokenAnswer } from '../lib/voice.ts'

type Question = NonNullable<TurnUpdate['question']>
type RoundInfo = NonNullable<TurnUpdate['round']>
type Persona = NonNullable<StartSessionBody['personaId']>
type Mode = NonNullable<StartSessionBody['mode']>

const PERSONAS: readonly { id: Persona; label: string }[] = [
  { id: 'collaborator', label: 'Collaborator: warm, builds on your answers' },
  { id: 'skeptic', label: 'Skeptic: assumes nothing, asks for evidence' },
  { id: 'bar_raiser', label: 'Bar raiser: probes for the level above yours' },
  { id: 'rusher', label: 'Rusher: terse, cuts in, moves on sooner' },
]

const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'coach', label: 'Coach: findings after every answer' },
  { id: 'simulation', label: 'Simulation: findings held until each round ends' },
  { id: 'drill', label: 'Drill: repeated practice on a weak spot' },
  { id: 'transfer', label: 'Transfer: the same idea under changed constraints' },
]

const STOPPED: Record<string, string> = {
  interrupted:
    'the server lost its continuation; saved work was preserved without grading unfinished answers',
  turns: 'every planned question was asked',
  end_topic: 'the interviewer ran out of new ground to cover',
  ceiling: 'a cost or model-call ceiling was reached, so it stopped rather than degrade',
  evaluator_failure: 'the evaluator failed, so it stopped rather than guess',
  timeout: 'answer time expired; the unanswered question was saved without a judgment',
  practice_outcome_rejected:
    'an invalid or conflicting practice outcome was rejected; earlier gap progress was preserved',
}

interface Exchange {
  question: Question
  opened?: RoundInfo
  notices: string[]
  answer: string | null
}

interface Room {
  interrupted?: boolean
  mode: Mode
  exchanges: Exchange[]
  findings: Finding[]
  quotes: QuotedEvidence[]
  tail: string[]
  round: RoundInfo | null
  pressure: number
  ceiling: number
  closedBy: string | null
  deadlineAt?: string | undefined
  timingPaused?: boolean
}

interface Opening {
  mode: Mode
  update: TurnUpdate
  ceiling: number
}

function absorb(room: Room, update: TurnUpdate): Room {
  const asked = update.question
  return {
    mode: room.mode,
    exchanges:
      asked === undefined
        ? update.stoppedBy === 'timeout'
          ? room.exchanges.map((exchange, index) =>
              index === room.exchanges.length - 1 ? { ...exchange, answer: null } : exchange,
            )
          : room.exchanges
        : [
            ...room.exchanges,
            {
              question: asked,
              ...(update.round === undefined ? {} : { opened: update.round }),
              notices: update.notices,
              answer: null,
            },
          ],
    findings: [...room.findings, ...update.findings],
    quotes: [...room.quotes, ...update.quotes],
    tail: asked === undefined ? update.notices : [],
    round: update.round ?? room.round,
    pressure: asked?.pressureLevel ?? room.pressure,
    ceiling: room.ceiling,
    closedBy: update.status === 'closed' ? (update.stoppedBy ?? 'closed') : room.closedBy,
    deadlineAt: update.deadlineAt,
    timingPaused: update.timingPaused ?? false,
  }
}

function opened({ update, ceiling, mode }: Opening): Room {
  const empty: Room = {
    mode,
    exchanges: [],
    findings: [],
    quotes: [],
    tail: [],
    round: null,
    pressure: 0,
    ceiling,
    closedBy: null,
    deadlineAt: update.deadlineAt,
    timingPaused: update.timingPaused ?? false,
  }
  return absorb(empty, update)
}

async function excerpt(
  snapshotId: string | undefined,
  artifactId: string,
): Promise<readonly [string, Question['artifact']]> {
  if (snapshotId === undefined) return [artifactId, undefined]
  try {
    return [artifactId, (await api.artifact(snapshotId, artifactId)).artifact]
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [artifactId, undefined]
    throw error
  }
}

async function restore(sessionId: string, topics: readonly TopicSummary[]): Promise<Room> {
  const [view, events, claimSet] = await Promise.all([
    api.session(sessionId),
    api.events(sessionId),
    api.claimSet(),
  ])
  const total = view.session?.rounds.length ?? 1
  const artifactIds = new Set(
    events.flatMap((event) =>
      event.kind === 'policy_action' && event.payload.artifactId !== undefined
        ? [event.payload.artifactId]
        : [],
    ),
  )
  const shown = new Map(
    await Promise.all([...artifactIds].map((id) => excerpt(view.session?.snapshotId, id))),
  )
  const answers = new Map(
    view.transcript
      .filter((entry) => entry.role === 'candidate')
      .map((entry) => [entry.attemptId, entry.text]),
  )
  const exchanges: Exchange[] = []
  const actions = new Map<string, Extract<(typeof events)[number], { kind: 'policy_action' }>>()
  const attemptRounds = new Map<string, number>()
  let round: RoundInfo | null = null
  let pending: RoundInfo | undefined

  for (const event of events) {
    if (event.kind === 'policy_action') {
      actions.set(event.payload.attemptId, event)
      if (round !== null) attemptRounds.set(event.payload.attemptId, round.index)
    }
    if (event.kind === 'state_change' && event.payload.change === 'round_started') {
      const { kind, index, brief } = event.payload
      round = { kind, index, total, ...(brief === undefined ? {} : { brief }) }
      pending = round
    }
    if (event.kind !== 'question') continue
    const { attemptId, text } = event.payload
    const policy = actions.get(attemptId)?.payload
    const topic = topics.find((entry) => entry.id === policy?.topicId)
    const claim = claimSet.claims.find((entry) => entry.id === policy?.claimId)
    const artifact = policy?.artifactId === undefined ? undefined : shown.get(policy.artifactId)
    exchanges.push({
      question: {
        attemptId,
        text,
        turn: exchanges.length,
        action: policy?.action ?? 'PROBE_MECHANISM',
        pressureLevel: policy?.pressureLevel ?? 0,
        round: policy?.round ?? round?.kind ?? 'cs_fundamentals',
        ...(topic === undefined
          ? {}
          : { topic: { id: topic.id, area: topic.area, title: topic.title } }),
        ...(claim === undefined ? {} : { claim: { id: claim.id, assertion: claim.assertion } }),
        ...(artifact === undefined ? {} : { artifact }),
      },
      ...(pending === undefined ? {} : { opened: pending }),
      notices: [],
      answer: answers.get(attemptId) ?? null,
    })
    pending = undefined
  }

  return {
    exchanges,
    interrupted: view.availability === 'interrupted',
    mode: view.session?.mode ?? 'coach',
    findings:
      view.session?.mode === 'simulation' && view.state !== 'closed'
        ? view.findings.filter((finding) => {
            const completedIn = attemptRounds.get(finding.attemptId)
            return completedIn !== undefined && completedIn < (round?.index ?? 0)
          })
        : view.findings,
    quotes: view.quotes,
    tail: [],
    round,
    pressure: view.pressureLevel,
    ceiling: view.session?.pressureCeiling ?? 3,
    deadlineAt: view.deadlineAt,
    timingPaused: view.timingPaused ?? false,
    closedBy: view.state === 'closed' ? (view.closed?.reason ?? 'closed') : null,
  }
}

function PressureLadder({ level, ceiling }: { level: number; ceiling: number }) {
  return (
    <span className="flex items-center gap-1" title="Pressure is dosed, never maximal">
      {[0, 1, 2, 3].map((rung) => (
        <span
          key={rung}
          className={`h-3 w-3 rounded-sm border ${
            rung <= level
              ? 'border-shaky/60 bg-shaky/60'
              : rung <= ceiling
                ? 'border-edge'
                : 'border-edge/40 opacity-40'
          }`}
        />
      ))}
      <span className="ml-1 text-[11px] text-quiet">
        pressure {level} · your ceiling {ceiling}
      </span>
    </span>
  )
}

function Section({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="setup-section border-t border-edge pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-quiet">
          {label}
        </h2>
        {hint !== undefined && <p className="text-[12px] text-quiet">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Choice({
  pressed,
  onClick,
  badge,
  children,
}: {
  pressed: boolean
  onClick: () => void
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`setup-choice ring-focus relative rounded-xl border p-3.5 pr-9 text-left transition-all ${
        pressed
          ? 'border-accent/60 bg-accent/10 shadow-[inset_0_0_0_1px_rgba(139,123,255,0.25)]'
          : 'border-edge bg-white/[0.02] hover:border-edge-strong hover:bg-white/[0.04]'
      }`}
    >
      {children}
      {pressed && (
        <span
          aria-hidden
          className="absolute right-3 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full bg-accent text-[11px] font-bold text-white"
        >
          {badge ?? '✓'}
        </span>
      )}
    </button>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-[12px] text-quiet">
      {label}
      <span className="mt-1 block">{children}</span>
    </label>
  )
}

const INPUT =
  'ring-focus w-full rounded-lg border border-edge bg-ink-2 px-2.5 py-1.5 text-sm text-body'

function roundBlurb(round: RoundKind, role: Role): string {
  return round === 'role_knowledge'
    ? `${roleAreasLabel(role)}: what this role leans on every day.`
    : ROUND_BLURB[round]
}

const RESUME_LINK = 'text-accent-soft underline underline-offset-2'

// The server's refusals name its routes; the candidate is owed the page that fixes them.
function StartFailed({ error }: { error: Error }) {
  const missing =
    error instanceof ApiError && error.message === 'no confirmed claims'
      ? 'Cross-questioning needs at least one résumé claim you have confirmed.'
      : error instanceof ApiError && error.message === 'pin a repository first'
        ? 'A walkthrough opens files from a project you have pinned, and none is pinned.'
        : null
  if (missing === null) return <Failed error={error} />
  return (
    <p className="rounded-lg border border-shaky/40 bg-shaky/5 px-3 py-2 text-[13px] text-muted">
      {missing}{' '}
      <Link to="/resume" className={RESUME_LINK}>
        Open Résumé &amp; projects
      </Link>
    </p>
  )
}

function Setup({ onOpened }: { onOpened: (opening: Opening) => void }) {
  const [params, setParams] = useSearchParams()
  const catalog = useTopicCatalog()
  const gapId = params.get('gapId')
  const storyId = params.get('storyId')
  const storyRevision = Number(params.get('storyRevision'))
  const stories = useQuery({
    queryKey: ['stories'],
    queryFn: api.stories,
    enabled: storyId !== null,
  })
  const story = stories.data?.stories.find(
    (entry) => entry.id === storyId && entry.revision === storyRevision,
  )
  const designId = params.get('designId')
  const designRevision = Number(params.get('designRevision'))
  const designs = useQuery({
    queryKey: ['designs'],
    queryFn: api.designs,
    enabled: designId !== null,
  })
  const design = designs.data?.designs.find(
    (entry) => entry.id === designId && entry.revision === designRevision,
  )
  const practice = useQuery({ queryKey: ['ledger'], queryFn: api.ledger, enabled: gapId !== null })
  const practiceGap = practice.data?.gaps.find((gap) => gap.id === gapId)
  const preparationState = usePreparation()
  const snapshotId =
    practiceGap?.snapshotId ??
    params.get('snapshotId') ??
    preparationState.data?.selection?.snapshotId ??
    null
  const selectedClaimIds = preparationState.data?.selection?.claimIds

  const updateSetup = (key: string, value: string) =>
    setParams((current) => {
      const next = new URLSearchParams(current)
      next.set(key, value)
      return next
    })
  const roleId = params.get('role')
  const setRoleId = (value: string) => updateSetup('role', value)
  const setPicked = (value: RoundKind[]) => updateSetup('rounds', value.join(','))
  const setLevel = (value: Level) => updateSetup('level', value)
  const [persona, setPersona] = useState<Persona>('collaborator')
  const mode = MODES.find((entry) => entry.id === params.get('mode'))?.id ?? 'coach'
  const transferTopicId = params.get('transferTopicId')
  const setMode = (value: Mode) => updateSetup('mode', value)
  const [ceiling, setCeiling] = useState(1)
  const requestedTurns = Number(params.get('turns'))
  const [turns, setTurns] = useState(
    Number.isInteger(requestedTurns) && requestedTurns >= 1 && requestedTurns <= 20
      ? requestedTurns
      : 4,
  )
  const timed = params.get('timed') === 'true'
  const requestedSeconds = Number(params.get('answerSeconds'))
  const answerSeconds =
    Number.isInteger(requestedSeconds) && requestedSeconds >= 10 && requestedSeconds <= 900
      ? requestedSeconds
      : 90

  const snapshots = useQuery({ queryKey: ['snapshots'], queryFn: api.snapshots })
  const claimSet = useClaimSet()

  const start = useMutation({
    mutationFn: (body: StartSessionBody) => api.startSession(body),
    onSuccess: (update) => onOpened({ update, ceiling, mode }),
  })

  if (catalog.isLoading) return <Loading what="roles and rounds" />
  if (catalog.isError) return <Failed error={catalog.error} />
  const data = catalog.data
  if (data === undefined) return null
  const role = data.roles.find((entry) => entry.id === roleId) ?? data.roles[0]
  if (role === undefined) return <Empty>No roles are configured on this server.</Empty>

  const requested = inRoundOrder(
    data,
    (params.get('rounds') ?? '').split(',').filter((round) => isRound(data, round)),
  )
  const interviewRounds = roundsAbout(data, 'topic')
  const resumeRounds = [...roundsAbout(data, 'claim'), ...roundsAbout(data, 'artifact')]
  const fromResume =
    requested.length > 0 && requested.every((round) => resumeRounds.includes(round))
  const offered = fromResume
    ? resumeRounds
    : requested.some((round) => resumeRounds.includes(round))
      ? [...interviewRounds, ...resumeRounds]
      : interviewRounds

  const loop = role.defaultRounds.filter((round) => interviewRounds.includes(round))
  const targetTopic = data.topics.find(
    (topic) =>
      topic.id ===
      (mode === 'transfer' && practiceGap?.artifactId !== undefined
        ? transferTopicId
        : practiceGap?.topicId),
  )
  const requestedTopicId = params.get('topicId')
  const requestedTopic =
    requestedTopicId === null
      ? undefined
      : data.topics.find((topic) => topic.id === requestedTopicId)
  const rounds =
    gapId !== null && practiceGap !== undefined
      ? [
          practiceGap.snapshotId !== undefined && mode === 'drill'
            ? 'code_walkthrough'
            : (targetTopic?.round ?? 'project_deep_dive'),
        ]
      : params.has('rounds')
        ? requested
        : loop.slice(0, 1)
  const level = data.levels.find((entry) => entry === params.get('level')) ?? role.defaultLevel
  const asks = (subject: SubjectKind) => rounds.some((round) => subjectOf(data, round) === subject)
  const project = snapshots.data?.snapshots.find(
    (entry) => entry.id === snapshotId && !entry.deleted,
  )
  const noProject = asks('artifact') && project === undefined
  const noClaims =
    asks('claim') &&
    (claimSet.data === undefined ||
      !claimSet.data.claims.some(
        (claim) =>
          claimSet.data.confirmed.has(claim.id) &&
          (practiceGap?.claimId === undefined
            ? selectedClaimIds === undefined || selectedClaimIds.includes(claim.id)
            : claim.id === practiceGap.claimId),
      ))

  const toggle = (round: RoundKind) => {
    const next = rounds.includes(round)
      ? rounds.filter((entry) => entry !== round)
      : inRoundOrder(data, [...rounds, round])
    setPicked(next)
  }

  const begin = () =>
    start.mutate({
      roleId: role.id,
      ...(gapId === null ? {} : { gapId }),
      ...(mode === 'transfer' && practiceGap?.artifactId !== undefined && transferTopicId !== null
        ? { transferTopicId }
        : {}),
      ...(story === undefined ? {} : { storyId: story.id, storyRevision: story.revision }),
      ...(design === undefined ? {} : { designId: design.id, designRevision: design.revision }),
      ...(gapId === null && requestedTopic !== undefined && rounds.includes(requestedTopic.round)
        ? { topicIds: [requestedTopic.id] }
        : {}),
      rounds,
      level,
      personaId: persona,
      mode,
      pressureCeiling: ceiling,
      turnsPerRound: turns,
      drill: !timed && !params.has('turns'),
      ...(timed && mode === 'simulation' ? { timedMock: { answerSeconds } } : {}),
      ...(asks('claim') && selectedClaimIds !== undefined && selectedClaimIds.length > 0
        ? { claimIds: selectedClaimIds }
        : {}),
      ...(project !== undefined && asks('artifact') ? { snapshotId: project.id } : {}),
    })
  const preparation = new URLSearchParams(params)
  preparation.delete('id')
  preparation.set('role', role.id)
  preparation.set('level', level)
  preparation.set('rounds', rounds.join(','))
  preparation.set('mode', mode)

  return (
    <div className="journey-page">
      <PageIntro
        eyebrow="Ready when you are"
        title={fromResume ? 'Cross-question your own work' : 'Set up your interview'}
        displayTitle={
          fromResume ? (
            <>
              Your work,
              <br />
              <em>in focus.</em>
            </>
          ) : (
            <>
              One more
              <br />
              <em>look.</em>
            </>
          )
        }
        description={
          fromResume
            ? 'The interviewer picks from the claims you confirmed and the project you pinned.'
            : 'Your preparation is here. Review the rounds and level, then let the interviewer lead.'
        }
        action={
          <Link to={`/prepare?${preparation}`} className="journey-secondary">
            Back to Prepare
          </Link>
        }
      />

      {gapId !== null && (
        <Panel title="Targeted practice">
          {practice.isPending ? (
            <Loading what="the practice target" />
          ) : practice.isError ? (
            <Failed error={practice.error} />
          ) : practiceGap === undefined ? (
            <Empty>This gap is unavailable for this owner.</Empty>
          ) : (
            <>
              <p>{practiceGap.summary}</p>
              {mode === 'transfer' && practiceGap.artifactId !== undefined && (
                <label className="mt-3 block text-sm">
                  Choose an unfamiliar topic that tests the same skill
                  <select
                    className="journey-select mt-2"
                    value={transferTopicId ?? ''}
                    onChange={(event) => updateSetup('transferTopicId', event.target.value)}
                  >
                    <option value="">Choose a topic</option>
                    {data.topics
                      .filter((topic) =>
                        [
                          'dbms.indexes',
                          'dsa.hash_maps',
                          'dsa.bfs_dfs',
                          'dbms.transactions_isolation',
                          'os.deadlock',
                          'backend.rest_idempotency',
                        ].includes(topic.id),
                      )
                      .map((topic) => (
                        <option key={topic.id} value={topic.id}>
                          {topic.title}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <p className="mt-2 text-xs text-quiet">
                The saved target and original assessment level determine this drill. Coaching does
                not close a gap.
              </p>
            </>
          )}
        </Panel>
      )}
      {gapId === null && requestedTopicId !== null && (
        <Panel title="Selected topic">
          {requestedTopic === undefined ? (
            <Empty>This topic is unavailable.</Empty>
          ) : (
            <p>
              {requestedTopic.title}
              {!rounds.includes(requestedTopic.round) && ' — select its round to continue.'}
            </p>
          )}
        </Panel>
      )}
      {storyId !== null && (
        <Panel title="Confirmed story">
          {stories.isPending ? (
            <Loading what="your story" />
          ) : story === undefined ? (
            <Empty>This story version is unavailable.</Empty>
          ) : (
            <>
              <p>{story.situation}</p>
              <p className="mt-2">{story.action}</p>
              <p className="mt-2">{story.result}</p>
              <p className="mt-2 text-xs text-quiet">
                Version {story.revision} will be saved with this interview.
              </p>
            </>
          )}
        </Panel>
      )}
      <section className="setup-form rise space-y-5">
        <Section label="Role" hint="Sets the role-knowledge round and the full loop.">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.roles.map((entry) => (
              <Choice
                key={entry.id}
                pressed={entry.id === role.id}
                onClick={() => setRoleId(entry.id)}
              >
                <span className="block text-[14px] font-semibold text-body">{entry.label}</span>
                <span className="mt-1 block text-[12px] text-quiet">{roleAreasLabel(entry)}</span>
              </Choice>
            ))}
          </div>
        </Section>

        <Section
          label={fromResume ? 'From your résumé & projects' : 'Rounds'}
          hint="Pick several to chain them into a loop."
        >
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {offered.map((round) => {
              const at = rounds.indexOf(round)
              return (
                <Choice
                  key={round}
                  pressed={at >= 0}
                  onClick={() => toggle(round)}
                  badge={rounds.length > 1 ? at + 1 : undefined}
                >
                  <span className="block text-[14px] font-semibold text-body">
                    {ROUND_LABEL[round]}
                  </span>
                  <span className="mt-1 block text-[12px] leading-snug text-quiet">
                    {roundBlurb(round, role)}
                  </span>
                </Choice>
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-quiet">
            {rounds.length > 0 && (
              <span>In order: {rounds.map((round) => ROUND_LABEL[round]).join(' → ')}</span>
            )}
            {!fromResume && (
              <button
                type="button"
                onClick={() => setPicked(loop)}
                className="text-accent-soft underline underline-offset-2 hover:text-body"
              >
                Use the full loop for this role
              </button>
            )}
            {fromResume ? (
              <Link to="/session" className="text-accent-soft underline underline-offset-2">
                Practise an interview round instead
              </Link>
            ) : (
              <Link to="/resume" className="text-accent-soft underline underline-offset-2">
                Questions about your own résumé or code start from Résumé &amp; projects
              </Link>
            )}
          </div>
          {asks('artifact') && (
            <p className="mt-3 rounded-lg border border-edge bg-ink-2 px-3 py-2 text-[13px] text-muted">
              {project !== undefined ? (
                <>
                  Project: <span className="mono text-body">{project.repoPath}</span> at commit{' '}
                  <span className="mono">{project.commit.slice(0, 7)}</span>
                </>
              ) : noProject ? (
                <>
                  Select an available pinned project from Prepare or Résumé &amp; projects.{' '}
                  <Link to="/resume" className={RESUME_LINK}>
                    Pin one under Résumé &amp; projects
                  </Link>
                </>
              ) : (
                'Looking for your pinned project…'
              )}
            </p>
          )}
          {noClaims && (
            <p className="mt-3 rounded-lg border border-edge bg-ink-2 px-3 py-2 text-[13px] text-muted">
              No available résumé claim is selected. Choose confirmed material in Prepare.{' '}
              <Link to="/resume" className={RESUME_LINK}>
                Confirm some under Résumé &amp; projects
              </Link>
            </p>
          )}
          {!fromResume && rounds.length > 0 && (
            <details className="mt-3 text-[13px]">
              <summary className="cursor-pointer text-quiet hover:text-body">
                What these rounds can ask about
              </summary>
              <div className="mt-3 space-y-3">
                {rounds.map((round) => (
                  <div key={round}>
                    <p className="mb-1.5 text-[12px] text-quiet">{ROUND_LABEL[round]}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {topicsFor(data, role, round, level).map((topic) => (
                        <TopicChip key={topic.id} topic={topic} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </Section>

        <Section label="Level" hint="The bar every answer is judged against.">
          <div className="flex flex-wrap gap-2">
            {data.levels.map((entry) => (
              <Choice key={entry} pressed={entry === level} onClick={() => setLevel(entry)}>
                <span className="text-[13px] font-medium text-body">{LEVEL_LABEL[entry]}</span>
              </Choice>
            ))}
          </div>
        </Section>

        <div className="border-t border-edge pt-4">
          <details>
            <summary className="cursor-pointer text-[12px] font-semibold uppercase tracking-[0.14em] text-quiet hover:text-body">
              Advanced options
            </summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Interviewer">
                <select
                  value={persona}
                  onChange={(event) => setPersona(event.target.value as Persona)}
                  className={INPUT}
                >
                  {PERSONAS.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Mode">
                <select
                  value={mode}
                  onChange={(event) => setMode(event.target.value as Mode)}
                  className={INPUT}
                >
                  {MODES.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Pressure ceiling">
                <span className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={3}
                    value={ceiling}
                    onChange={(event) => setCeiling(Number(event.target.value))}
                    className="w-32 accent-body"
                  />
                  <span className="text-[11px] text-quiet">ceiling {ceiling} of 3</span>
                </span>
              </Field>
              <Field label="Questions per round">
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={turns}
                  onChange={(event) => setTurns(Number(event.target.value))}
                  className={`${INPUT} w-24`}
                />
              </Field>
              {mode === 'simulation' && gapId === null && (
                <Field label="Timed mock">
                  <input
                    type="checkbox"
                    checked={timed}
                    onChange={(event) => updateSetup('timed', String(event.target.checked))}
                  />
                  <span className="ml-2">Limit each answer</span>
                </Field>
              )}
              {timed && mode === 'simulation' && (
                <Field label="Seconds per answer (10–900)">
                  <input
                    type="number"
                    min={10}
                    max={900}
                    value={answerSeconds}
                    onChange={(event) => updateSetup('answerSeconds', event.target.value)}
                    className={`${INPUT} w-24`}
                  />
                </Field>
              )}
            </div>
          </details>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-edge pt-5">
          <Button
            tone="primary"
            onClick={begin}
            disabled={
              (gapId !== null &&
                (practiceGap === undefined ||
                  practiceGap.status !== (mode === 'transfer' ? 'drilled' : 'open'))) ||
              (mode === 'transfer' && practiceGap?.artifactId !== undefined && !transferTopicId) ||
              (gapId === null &&
                requestedTopicId !== null &&
                (requestedTopic === undefined || !rounds.includes(requestedTopic.round))) ||
              (storyId !== null && (story === undefined || !rounds.includes('behavioral'))) ||
              (designId !== null && (design === undefined || !rounds.includes('system_design'))) ||
              start.isPending ||
              rounds.length === 0 ||
              noProject ||
              noClaims ||
              ((asks('artifact') || asks('claim')) && !preparationState.isSuccess)
            }
          >
            {start.isPending ? 'starting…' : 'Start the interview'}
          </Button>
          <Quiet>
            {rounds.length === 0
              ? 'Pick at least one round.'
              : `${role.label} · ${LEVEL_LABEL[level]} · ${turns} questions per round${timed && mode === 'simulation' ? ` · ${answerSeconds}s per answer` : params.has('turns') ? '' : ', and one drill if an answer opens a gap'}`}
          </Quiet>
        </div>
        {start.isError && <StartFailed error={start.error} />}
      </section>
    </div>
  )
}

function RoundDivider({ round }: { round: RoundInfo }) {
  return (
    <div className="pt-2">
      <div className="flex items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-accent-soft">
          Round {round.index + 1} of {round.total} · {ROUND_LABEL[round.kind]}
        </span>
        <span className="h-px flex-1 bg-edge" />
      </div>
      {round.brief !== undefined && (
        <p className="mt-1.5 text-[13px] italic text-quiet">{round.brief}</p>
      )}
    </div>
  )
}

function Transcript({
  exchanges,
  findings,
  quotes,
  live,
}: {
  exchanges: readonly Exchange[]
  findings: readonly Finding[]
  quotes: readonly QuotedEvidence[]
  live: boolean
}) {
  const evidence = useEvidence()
  return (
    <ol className="space-y-4">
      {exchanges.map((exchange, index) => {
        const { question } = exchange
        const current = live && index === exchanges.length - 1
        const judged = findings.filter((finding) => finding.attemptId === question.attemptId)
        return (
          <li key={index} className="space-y-2">
            {exchange.opened !== undefined && <RoundDivider round={exchange.opened} />}
            {exchange.notices.map((notice, at) => (
              <p key={at} className="text-[12px] text-quiet">
                — {notice}
              </p>
            ))}
            <div
              className="dialogue-turn"
              data-current={current}
              id={current ? 'current-question' : undefined}
            >
              <div className="flex flex-wrap items-center gap-2">
                {question.topic !== undefined && <TopicChip topic={question.topic} />}
                {question.claim !== undefined && <ClaimChip assertion={question.claim.assertion} />}
                <Tag tone="accent">{words(question.action.toLowerCase())}</Tag>
                <Tag>pressure {question.pressureLevel}</Tag>
              </div>
              {question.artifact !== undefined && (
                <div className="mt-3">
                  <FilePanel artifact={question.artifact} />
                </div>
              )}
              <p className="prompt-text mt-3 text-[15px] leading-relaxed text-body">
                {question.text}
              </p>
              {exchange.answer !== null && (
                <div className="candidate-answer mt-3">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-quiet/80">
                    you
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-muted">
                    <Highlighted text={exchange.answer} quotes={evidence.active} />
                  </p>
                </div>
              )}
              {judged.length > 0 && (
                <div className="mt-3 space-y-2">
                  {judged.map((finding) => (
                    <FindingCard key={finding.id} finding={finding} quotes={quotes} />
                  ))}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Closing({
  sessionId,
  reason,
  onRestart,
}: {
  sessionId: string
  reason: string
  onRestart: () => void
}) {
  const link =
    'ring-focus inline-flex items-center rounded-xl border border-edge bg-raised px-4 py-2 text-sm font-medium text-muted transition hover:border-edge-strong hover:text-body'
  return (
    <div className="mt-5 rounded-xl border border-edge bg-white/[0.02] p-4">
      <p className="text-[15px] font-semibold text-body">That is the interview.</p>
      <p className="mt-1 text-[13px] text-quiet">
        It stopped because {STOPPED[reason] ?? words(reason)}.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link to={`/debrief?id=${sessionId}`} className={link}>
          Read the debrief
        </Link>
        <Link to="/ledger" className={link}>
          See your gaps
        </Link>
        <Link to={`/replay?id=${sessionId}`} className={link}>
          Replay it
        </Link>
        <Button tone="primary" onClick={onRestart}>
          Start another interview
        </Button>
      </div>
    </div>
  )
}

function InterviewRoom({
  sessionId,
  opening,
  onRestart,
}: {
  sessionId: string
  opening: Opening | null
  onRestart: () => void
}) {
  const catalog = useTopicCatalog()
  const queryClient = useQueryClient()
  const [room, setRoom] = useState<Room | null>(opening === null ? null : opened(opening))
  const [answer, setAnswer] = useState('')
  const [hintLevel, setHintLevel] = useState(0)
  const hint = useMutation({
    mutationFn: () => api.hint(sessionId, Math.min(3, hintLevel + 1)),
    onSuccess: () => setHintLevel((level) => level + 1),
  })
  const [spoken, setSpoken] = useState<SpokenAnswer | null>(null)
  const [voice, setVoice] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const [delivery, setDelivery] = useState<Record<string, number | string> | null>(null)
  const [now, setNow] = useState(Date.now())
  const answerBox = useRef<HTMLTextAreaElement>(null)

  const restored = useQuery({
    queryKey: ['interview', sessionId],
    queryFn: () => restore(sessionId, catalog.data?.topics ?? []),
    enabled: room === null && catalog.data !== undefined,
    gcTime: 0,
  })
  useEffect(() => {
    if (room === null && restored.data !== undefined) setRoom(restored.data)
  }, [room, restored.data])
  useEffect(() => () => cancelSpeech(), [sessionId])
  useEffect(() => {
    if (room?.deadlineAt === undefined || room.closedBy !== null) return
    let checking = false
    const interval = setInterval(() => {
      setNow(Date.now())
      if (Date.now() < Date.parse(room.deadlineAt!) || checking) return
      checking = true
      void api
        .session(sessionId)
        .then(async (view) => {
          if (view.availability === 'closed')
            setRoom(await restore(sessionId, catalog.data?.topics ?? []))
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false
        })
    }, 1000)
    return () => clearInterval(interval)
  }, [room?.deadlineAt, room?.closedBy, sessionId, catalog.data?.topics])

  const reply = useMutation({
    mutationFn: (text: string) => api.answer(sessionId, text),
    onSuccess: (update) => {
      setRoom((current) => (current === null ? current : absorb(current, update)))
      if (voice && update.question !== undefined) {
        setSpeechError(null)
        void speak(update.question.text).catch(() =>
          setSpeechError('Question audio could not play. The question remains available as text.'),
        )
      } else cancelSpeech()
      void queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'topics' })
    },
  })
  const timing = useMutation({
    mutationFn: (action: 'pause' | 'resume') => api.timing(sessionId, action),
    onSuccess: (update) =>
      setRoom((current) =>
        current === null
          ? null
          : {
              ...current,
              timingPaused: update.paused,
              deadlineAt: update.deadlineAt,
            },
      ),
  })
  const stop = useMutation({
    mutationFn: () => api.stopSession(sessionId),
    onSuccess: (update) =>
      setRoom((current) => (current === null ? null : absorb(current, update))),
  })

  // Delivery is recorded against the attempt the answer belonged to, after the turn is judged, and
  // never travels with the answer — the Evaluator receives the same string a typed answer produces.
  const recordDelivery = async (attemptId: string, heard: SpokenAnswer) => {
    try {
      const recorded = await api.recordDelivery(sessionId, {
        attemptId,
        transcript: heard.transcript,
        audioMs: heard.audioMs,
        pauses: heard.pauses,
      })
      setDelivery(recorded.report as unknown as Record<string, number | string>)
    } catch {
      // Delivery is an observation beside the interview; failing to record one costs nothing else.
    }
  }

  const send = () => {
    if (answer.trim() === '' || room === null || room.timingPaused || reply.isPending) return
    const attemptId = room.exchanges.at(-1)?.question.attemptId
    const heard = spoken
    setRoom({
      ...room,
      exchanges: room.exchanges.map((exchange, index) =>
        index === room.exchanges.length - 1 ? { ...exchange, answer } : exchange,
      ),
    })
    reply.mutate(answer, {
      onSuccess: (update) => {
        if (attemptId !== undefined && heard !== null && update.stoppedBy !== 'timeout')
          void recordDelivery(attemptId, heard)
        setAnswer('')
        setSpoken(null)
        answerBox.current?.focus()
      },
      onError: async (error) => {
        setRoom(room)
        if (error instanceof ApiError && error.status === 409) {
          const saved = await api.session(sessionId).catch(() => null)
          if (saved?.availability === 'interrupted') setRoom({ ...room, interrupted: true })
        }
      },
    })
  }

  if (room === null) {
    if (restored.isError) return <Failed error={restored.error} />
    if (catalog.isError) return <Failed error={catalog.error} />
    return <Loading what="the interview" />
  }

  const live = room.closedBy === null && !room.interrupted
  const feedbackAvailable = room.mode !== 'simulation' || room.closedBy !== null

  const currentQuestion = room.exchanges.at(-1)?.question
  if (live && currentQuestion !== undefined) {
    return (
      <EvidenceProvider>
        <InterviewCall
          sessionId={sessionId}
          question={currentQuestion}
          context={`${words(room.mode)} · Round ${(room.round?.index ?? 0) + 1} of ${room.round?.total ?? 1} · ${ROUND_LABEL[currentQuestion.round]}`}
          meta={
            <>
              {currentQuestion.topic && <TopicChip topic={currentQuestion.topic} />}
              {currentQuestion.claim && <ClaimChip assertion={currentQuestion.claim.assertion} />}
              <Tag tone="accent">{words(currentQuestion.action.toLowerCase())}</Tag>
            </>
          }
          artifact={
            currentQuestion.artifact === undefined ? null : (
              <FilePanel artifact={currentQuestion.artifact} />
            )
          }
          history={
            room.exchanges.length > 1 ? (
              <section>
                <h2>Conversation so far</h2>
                <p>
                  Earlier answers stay with their findings. Hover a finding to see the words it
                  cites.
                </p>
                <Transcript
                  exchanges={room.exchanges.slice(0, -1)}
                  findings={room.findings}
                  quotes={room.quotes}
                  live={false}
                />
              </section>
            ) : null
          }
          pending={reply.isPending || stop.isPending}
          paused={Boolean(room.timingPaused)}
          deadline={room.deadlineAt}
          answer={answer}
          onAnswer={setAnswer}
          onSpoken={setSpoken}
          onSend={send}
          onEnd={() => stop.mutate()}
          error={
            <>
              {reply.isError && <Failed error={reply.error} />}
              {stop.isError && <Failed error={stop.error} />}
            </>
          }
        >
          <PressureLadder level={room.pressure} ceiling={room.ceiling} />
          {room.deadlineAt !== undefined || room.timingPaused ? (
            <Button
              onClick={() => timing.mutate(room.timingPaused ? 'resume' : 'pause')}
              disabled={timing.isPending || reply.isPending}
            >
              {room.timingPaused ? 'Resume timer' : 'Pause timer'}
            </Button>
          ) : null}
          {timing.isError && <Failed error={timing.error} />}
          {room.mode === 'drill' && (
            <div>
              <Button disabled={hint.isPending || hintLevel >= 3} onClick={() => hint.mutate()}>
                Show coaching hint
              </Button>
              {hint.data && <p>{hint.data.text}</p>}
              {hint.isError && <Failed error={hint.error} />}
            </div>
          )}
        </InterviewCall>
      </EvidenceProvider>
    )
  }

  return (
    <EvidenceProvider>
      <div className="journey-page">
        <PageIntro
          eyebrow="One question at a time"
          title="Interview"
          displayTitle={
            live ? (
              <>
                Stay with
                <br />
                <em>the question.</em>
              </>
            ) : (
              <>
                Leave with
                <br />
                <em>the evidence.</em>
              </>
            )
          }
          description={
            live
              ? 'Follow the question. Explain your reasoning. Take the time you need.'
              : 'Your interview is saved. Review the findings, then choose what to practise next.'
          }
          action={
            <Link to="/history" className="journey-secondary">
              View history
            </Link>
          }
        />
        {room.interrupted && (
          <Panel title="This interview was interrupted">
            <p className="text-sm">
              The server lost the live session. Saved answers remain intact; this interview cannot
              accept another answer.
            </p>
            {answer.trim() !== '' && (
              <label className="mt-3 block text-xs">
                Unsent answer draft — copy it before leaving
                <textarea
                  aria-label="Unsent answer draft"
                  readOnly
                  value={answer}
                  className="mt-2 w-full rounded border border-edge bg-ink-2 p-3"
                />
              </label>
            )}
            <div className="mt-3">
              <EndInterruptedInterview sessionId={sessionId} />
            </div>
          </Panel>
        )}
        <div className="interview-status">
          <span className="journey-icon">
            <JourneyIcon name="interview" />
          </span>
          <div className="flex-1">
            <p className="text-sm font-medium">
              {!live ? 'Interview complete' : reply.isPending ? 'Reading your answer' : 'Your turn'}
            </p>
            {live && room.deadlineAt !== undefined && (
              <p className="mt-1 text-xs text-quiet" role="timer">
                {now >= Date.parse(room.deadlineAt)
                  ? 'Time expired — finishing the question'
                  : `${Math.ceil((Date.parse(room.deadlineAt) - now) / 1000)} seconds left for this answer`}
              </p>
            )}
            <p className="text-xs text-quiet">
              {!live
                ? 'The transcript and findings stay together.'
                : 'Text and recorded answers use the same interview.'}
            </p>
            {live && room.timingPaused && (
              <p className="mt-1 text-xs text-quiet">Timed mock paused</p>
            )}
          </div>
          {live && (room.deadlineAt !== undefined || room.timingPaused) && (
            <div className="flex gap-2">
              <Button
                onClick={() => timing.mutate(room.timingPaused ? 'resume' : 'pause')}
                disabled={timing.isPending || reply.isPending}
              >
                {room.timingPaused ? 'Resume timer' : 'Pause timer'}
              </Button>
              <Button onClick={() => stop.mutate()} disabled={stop.isPending || reply.isPending}>
                Stop mock
              </Button>
            </div>
          )}
          {timing.isError && <Failed error={timing.error} />}
          {stop.isError && <Failed error={stop.error} />}
          <PressureLadder level={room.pressure} ceiling={room.ceiling} />
        </div>
        <div className="conversation-layout">
          <div className="space-y-4">
            <section className="conversation-panel">
              <header className="mb-5">
                <h2 className="text-sm font-semibold">Conversation</h2>
                <p className="mt-1 text-xs text-quiet">
                  Each finding cites your words. Hover a finding to see its evidence. There is no
                  score.
                </p>
              </header>
              {room.exchanges.length === 0 ? (
                <Empty>No question was asked in this session.</Empty>
              ) : (
                <Transcript
                  exchanges={room.exchanges}
                  findings={room.findings}
                  quotes={room.quotes}
                  live={live && !reply.isPending}
                />
              )}
              {!live && room.findings.length === 0 && (
                <p className="mt-3 text-[13px] text-quiet">Nothing was judged in this session.</p>
              )}
              {room.tail.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {room.tail.map((notice, index) => (
                    <li key={index} className="text-[12px] text-quiet">
                      — {notice}
                    </li>
                  ))}
                </ul>
              )}

              {reply.isPending && (
                <p className="pulse-soft mt-4 text-[13px] text-quiet">
                  The evaluator is reading your answer…
                </p>
              )}

              {live && !reply.isPending && (
                <div className="mt-5">
                  {room.mode === 'drill' && (
                    <div className="mb-3">
                      <Button
                        disabled={hint.isPending || hintLevel >= 3}
                        onClick={() => hint.mutate()}
                      >
                        Show coaching hint
                      </Button>
                      {hint.data !== undefined && <p className="mt-2 text-sm">{hint.data.text}</p>}
                      {hint.isError && <Failed error={hint.error} />}
                    </div>
                  )}
                  <textarea
                    ref={answerBox}
                    aria-label="Your answer"
                    value={answer}
                    onChange={(event) => setAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send()
                    }}
                    rows={5}
                    placeholder="Answer in your own words. The evaluator can only cite what appears here."
                    className="ring-focus w-full rounded-xl border border-edge bg-ink-2 p-3.5 text-sm leading-relaxed text-body outline-none placeholder:text-quiet/60 focus:border-accent/50"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <Button
                      tone="primary"
                      onClick={send}
                      disabled={answer.trim() === '' || Boolean(room.timingPaused)}
                    >
                      Send answer
                    </Button>
                    <span className="text-[12px] text-quiet">Ctrl + Enter sends</span>
                    <label className="ml-auto flex items-center gap-2 text-[12px] text-quiet">
                      <input
                        type="checkbox"
                        checked={voice}
                        onChange={(event) => {
                          setVoice(event.target.checked)
                          if (!event.target.checked) {
                            cancelSpeech()
                            setSpeechError(null)
                          }
                        }}
                      />
                      read questions aloud and let me answer by voice
                    </label>
                  </div>
                  {speechError !== null && (
                    <p role="alert" className="mt-2 text-xs text-broken">
                      {speechError}
                    </p>
                  )}
                  {voice && (
                    <div className="mt-2 space-y-3">
                      <LiveRecorder
                        key={room.exchanges.at(-1)?.question.attemptId ?? sessionId}
                        sessionId={sessionId}
                        onAnswer={(text) => setAnswer(text)}
                      />
                      <Recorder
                        onAnswer={(heard) => {
                          setSpoken(heard)
                          setAnswer(heard.transcript)
                        }}
                      />
                    </div>
                  )}
                  <p className="mt-3 text-[12px] leading-relaxed text-quiet">
                    Say &ldquo;I don&rsquo;t know&rdquo; when you don&rsquo;t: that counts as
                    composure holding, not as a miss. Want to practise saying it out loud?{' '}
                    <Link
                      to={`/studio?id=${sessionId}`}
                      className="text-accent-soft underline underline-offset-2"
                    >
                      Answer this one aloud
                    </Link>
                    .
                  </p>
                </div>
              )}
              {reply.isError && (
                <div className="mt-3">
                  <Failed error={reply.error} />
                </div>
              )}

              {room.closedBy !== null && (
                <Closing sessionId={sessionId} reason={room.closedBy} onRestart={onRestart} />
              )}
            </section>

            {delivery !== null && (
              <Panel
                title="Delivery"
                subtitle="Observations about how you spoke. They say nothing about whether the answer was any good, and they never reach a finding or the gap ledger."
              >
                <div className="flex flex-wrap gap-2">
                  <Tag>{Number(delivery['wordsPerMinute']).toFixed(0)} words/min</Tag>
                  <Tag>{delivery['longPauseCount']} long pauses</Tag>
                  <Tag>
                    {Number(delivery['fillerRatePerHundredWords']).toFixed(1)} fillers per 100 words
                  </Tag>
                </div>
              </Panel>
            )}
          </div>
          <aside className="room-aside space-y-4">
            <PracticeFlow />
            <section className="card p-5">
              <p className="journey-eyebrow">Your interview room</p>
              <h2 className="mt-3 text-sm font-semibold">Make your reasoning visible</h2>
              <p className="mt-2 text-xs leading-relaxed text-quiet">
                Explain what you know and say when you are unsure. Nothing is submitted until you
                choose Send answer.
              </p>
              <div className="mt-4 border-t border-edge pt-4 text-[11px] leading-relaxed text-quiet">
                Questions, answers, policy choices and findings are recorded together.
                <details className="mt-3">
                  <summary className="cursor-pointer text-muted">Session details</summary>
                  <p className="mono mt-2 break-all">{sessionId}</p>
                </details>
              </div>
            </section>
            {feedbackAvailable ? (
              <JourneyLink
                to={`/improve?id=${encodeURIComponent(sessionId)}`}
                title="Your practice workspace"
                description="Open saved feedback and your practice schedule."
                icon="improve"
              />
            ) : (
              <section className="card p-5">
                <h2 className="text-sm font-medium">Feedback after the round</h2>
                <p className="mt-2 text-xs leading-relaxed text-quiet">
                  Your simulation keeps new findings out of view while you answer. The full debrief
                  opens when the interview ends.
                </p>
              </section>
            )}
          </aside>
        </div>
      </div>
    </EvidenceProvider>
  )
}

export function SessionPage() {
  const [params, setParams] = useSearchParams()
  const [opening, setOpening] = useState<Opening | null>(null)
  const sessionId = params.get('id')

  if (sessionId !== null) {
    return (
      <InterviewRoom
        key={sessionId}
        sessionId={sessionId}
        opening={opening?.update.sessionId === sessionId ? opening : null}
        onRestart={() => {
          setOpening(null)
          setParams({})
        }}
      />
    )
  }

  return (
    <Setup
      onOpened={(next) => {
        setOpening(next)
        setParams({ id: next.update.sessionId })
      }}
    />
  )
}
