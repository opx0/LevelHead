import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cancelSpeech, measurePauses, speak, transcribe, type SpokenAnswer } from '../lib/voice.ts'
import { LiveRecorder } from './live-recorder.tsx'

type Phase = 'ready' | 'speaking' | 'connecting' | 'listening' | 'transcribing' | 'review'

// The interview room: one question on stage, one answer control, and the previous turns kept
// below with their findings. Camera is a separate instrument and never gates audio.
export function InterviewCall({
  sessionId,
  question,
  context,
  meta,
  artifact,
  history,
  pending,
  paused,
  deadline,
  answer,
  onAnswer,
  onSpoken,
  onSend,
  onEnd,
  error,
  children,
}: {
  sessionId: string
  question: { attemptId: string; text: string }
  context: string
  meta: ReactNode
  artifact: ReactNode
  history: ReactNode
  pending: boolean
  paused: boolean
  deadline?: string | undefined
  answer: string
  onAnswer: (text: string) => void
  onSpoken: (answer: SpokenAnswer) => void
  onSend: () => void
  onEnd: () => void
  error: ReactNode
  children: ReactNode
}) {
  const [phase, setPhase] = useState<Phase>('ready')
  const [audio, setAudio] = useState(true)
  const [captions, setCaptions] = useState(false)
  const [problem, setProblem] = useState('')
  const [cameraProblem, setCameraProblem] = useState('')
  const [camera, setCamera] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>(() => Array(25).fill(0.05))
  const recorder = useRef<MediaRecorder | null>(null)
  const mic = useRef<MediaStream | null>(null)
  const cam = useRef<MediaStream | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const animation = useRef(0)
  const mounted = useRef(true)
  const cameraBusy = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelSpeech()
      if (recorder.current?.state === 'recording') recorder.current.stop()
      mic.current?.getTracks().forEach((track) => track.stop())
      cam.current?.getTracks().forEach((track) => track.stop())
      cancelAnimationFrame(animation.current)
      void contextRef.current?.close()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setProblem('')
    setCaptions(false)
    if (!audio) {
      setPhase('ready')
      return
    }
    setPhase('speaking')
    void speak(question.text)
      .then(() => {
        if (!cancelled) setPhase('ready')
      })
      .catch(() => {
        if (!cancelled) {
          setPhase('ready')
          setProblem('Question audio is not playing. Use Replay question, or answer from the text.')
        }
      })
    return () => {
      cancelled = true
      cancelSpeech()
    }
  }, [question.attemptId, question.text, audio])

  useEffect(() => {
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [question.attemptId])

  const toggleCamera = async () => {
    if (cameraBusy.current) return
    if (cam.current !== null) {
      cam.current.getTracks().forEach((track) => track.stop())
      cam.current = null
      setCamera(false)
      return
    }
    cameraBusy.current = true
    setCameraProblem('')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (!mounted.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      cam.current = media
      if (video.current !== null) video.current.srcObject = media
      setCamera(true)
    } catch {
      setCameraProblem('Camera unavailable. Your microphone and the interview are unaffected.')
    } finally {
      cameraBusy.current = false
    }
  }

  const record = async () => {
    cancelSpeech()
    setProblem('')
    // Captions own the microphone while open; close them so one recording path is live at a time.
    setCaptions(false)
    setPhase('connecting')
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      if (!mounted.current) {
        media.getTracks().forEach((track) => track.stop())
        return
      }
      mic.current = media
      const ctx = new AudioContext()
      contextRef.current = ctx
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 128
      ctx.createMediaStreamSource(media).connect(analyser)
      const samples = new Uint8Array(analyser.frequencyBinCount)
      const draw = () => {
        analyser.getByteFrequencyData(samples)
        setLevels(Array.from({ length: 25 }, (_, index) => (samples[index * 2 + 2] ?? 0) / 255))
        animation.current = requestAnimationFrame(draw)
      }
      draw()
      const chunks: Blob[] = []
      const rec = new MediaRecorder(media)
      rec.ondataavailable = (event) => chunks.push(event.data)
      rec.onstop = () => {
        media.getTracks().forEach((track) => track.stop())
        mic.current = null
        cancelAnimationFrame(animation.current)
        void ctx.close()
        contextRef.current = null
        setLevels(Array(25).fill(0.05))
        if (!mounted.current) return
        setPhase('transcribing')
        const blob = new Blob(chunks, { type: rec.mimeType })
        void Promise.all([transcribe(blob), measurePauses(blob)])
          .then(([text, timing]) => {
            if (!mounted.current) return
            onSpoken({ transcript: text, ...timing })
            onAnswer(text)
            if (text.trim() === '') {
              setProblem('No speech was recognised. Try again, or type your answer.')
            }
            setPhase('review')
          })
          .catch(() => {
            if (!mounted.current) return
            setProblem('Transcription failed. Your draft is unchanged; type it instead or retry.')
            setPhase('review')
          })
      }
      recorder.current = rec
      rec.start()
      setPhase('listening')
    } catch {
      mic.current?.getTracks().forEach((track) => track.stop())
      cancelAnimationFrame(animation.current)
      void contextRef.current?.close()
      contextRef.current = null
      setProblem('Microphone unavailable. Check permission, or type your answer.')
      setPhase('ready')
    }
  }

  const busy = pending || phase === 'transcribing' || phase === 'connecting'
  const listening = phase === 'listening'
  const status = paused
    ? 'Interview paused'
    : pending
      ? 'Considering your answer'
      : listening
        ? 'Listening to you'
        : {
            ready: 'Your turn',
            speaking: 'Interviewer speaking',
            connecting: 'Connecting microphone',
            listening: 'Listening to you',
            transcribing: 'Transcribing your answer',
            review: 'Review your transcript, then send',
          }[phase]

  return (
    <section className="call-room">
      <header className="call-top">
        <span>LEVELHEAD / INTERVIEW</span>
        <span>{context}</span>
      </header>

      <article className="call-question">
        <div className="call-question-label">
          <span className="call-avatar" aria-hidden="true">
            lh
          </span>
          <span>Your interviewer</span>
        </div>
        <div className="call-question-meta">{meta}</div>
        <h1>{question.text}</h1>
        {artifact !== null && <div className="call-artifact">{artifact}</div>}
      </article>

      <div className="call-stage" data-phase={pending ? 'thinking' : phase}>
        <div className={`call-wave ${listening ? 'is-live' : ''}`} aria-hidden="true">
          {levels.map((level, index) => (
            <i key={index} style={{ height: `${8 + level * 110}px` }} />
          ))}
        </div>
        <p role="status" aria-live="polite" className="call-status">
          <span />
          {status}
        </p>
        <p className="call-clock">
          {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          {deadline !== undefined && paused ? ' · timer paused' : ''}
        </p>
        {deadline !== undefined && !paused && (
          <p role="timer" className="call-clock">
            {Math.max(0, Math.ceil((Date.parse(deadline) - Date.now()) / 1000))} seconds left for
            this answer
          </p>
        )}
        <div className={`call-self ${camera ? 'is-on' : ''}`}>
          <video
            ref={video}
            aria-label={camera ? 'Your camera preview' : 'Camera preview is off'}
            muted
            autoPlay
            playsInline
          />
          <span aria-live="polite">{camera ? 'You · stays on this device' : 'Camera off'}</span>
        </div>
      </div>

      <div className="call-controls">
        <button
          type="button"
          className="call-secondary"
          onClick={() => void toggleCamera()}
          aria-pressed={camera}
        >
          {camera ? 'Turn camera off' : 'Turn camera on'}
        </button>
        {listening ? (
          <button type="button" className="call-primary" onClick={() => recorder.current?.stop()}>
            Done speaking
          </button>
        ) : (
          <button
            type="button"
            className="call-primary"
            disabled={busy || paused}
            onClick={() => void record()}
          >
            {phase === 'connecting'
              ? 'Connecting…'
              : phase === 'transcribing'
                ? 'Transcribing…'
                : 'Answer by voice'}
          </button>
        )}
        <button
          type="button"
          className="call-secondary"
          aria-pressed={captions}
          disabled={busy || listening}
          onClick={() => {
            cancelSpeech()
            setCaptions((value) => !value)
          }}
        >
          {captions ? 'Hide live captions' : 'Live captions'}
        </button>
        <button
          type="button"
          className="call-secondary"
          disabled={busy}
          onClick={() => {
            // End the turn cleanly: stop any in-flight recording before leaving the room.
            if (recorder.current?.state === 'recording') recorder.current.stop()
            onEnd()
          }}
        >
          End interview
        </button>
      </div>

      <div className="call-options">
        <button type="button" onClick={() => setAudio((value) => !value)} aria-pressed={audio}>
          Question audio {audio ? 'on' : 'off'}
        </button>
        <button
          type="button"
          disabled={busy || listening}
          onClick={() => {
            setPhase('speaking')
            void speak(question.text)
              .then(() => setPhase('ready'))
              .catch(() => {
                setPhase('ready')
                setProblem('Audio unavailable. The question stays above; answer in text.')
              })
          }}
        >
          Replay question
        </button>
      </div>

      {(problem !== '' || cameraProblem !== '') && (
        <p role="status" className="call-problem">
          {problem !== '' ? problem : cameraProblem}
        </p>
      )}

      {captions && (
        <section className="call-captions">
          <LiveRecorder
            key={question.attemptId}
            sessionId={sessionId}
            onAnswer={(text) => {
              onAnswer(text)
              setPhase('review')
            }}
          />
        </section>
      )}

      <section className="call-review">
        <label htmlFor="call-answer">
          Your answer
          <span>
            {listening
              ? 'Your words land here when you finish.'
              : 'Review it before sending. Nothing is submitted automatically.'}
          </span>
        </label>
        <textarea
          id="call-answer"
          aria-label="Your answer"
          value={answer}
          onChange={(event) => onAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) onSend()
          }}
          placeholder="Answer in your own words"
          rows={3}
          disabled={pending || listening}
        />
        <div className="call-review__actions">
          <button
            type="button"
            className="call-primary"
            disabled={busy || paused || listening || answer.trim() === ''}
            onClick={onSend}
          >
            Send answer
          </button>
          <span>Ctrl + Enter sends</span>
        </div>
      </section>

      <p className="call-note">There is no score. Findings cite the words you actually said.</p>

      {error}

      {history !== null && <div className="call-history">{history}</div>}

      <details className="call-context">
        <summary>Timing, coaching and session details</summary>
        {children}
      </details>
    </section>
  )
}
