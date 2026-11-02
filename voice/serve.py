# /// script
# requires-python = ">=3.13"
# dependencies = [
#   "av<19",
#   "faster-whisper",
#   "numpy",
#   "piper-tts",
#   "praat-parselmouth",
# ]
# ///
"""Local speech for Levelhead's voice UI: POST /transcribe (audio bytes -> text),
POST /speak (text -> WAV bytes), POST /prosody (audio bytes -> word timings and acoustics).
No prebuilt binary (whisper.cpp's server SIGILLs on some CPUs); both models are pure-Python,
loaded once, kept warm in process. No network model call.

Run: uv run voice/serve.py
"""

import http.server
import json
import os
import socketserver
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio
from piper import PiperVoice
from piper.download_voices import download_voice

# Flat, because the sidecar runs as `uv run voice/serve.py` and voice/ is the script's own directory.
from prosody import intensity_track, pitch_track, terminal_contours

PORT = int(os.environ.get("VOICE_PORT", "8091"))
HOST = os.environ.get("VOICE_HOST", "127.0.0.1")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "base.en")
PIPER_VOICE_NAME = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")
LOCAL_ONLY = os.environ.get("LEVELHEAD_LOCAL_ONLY", "").lower() == "true"
SAMPLE_RATE = 16_000
SENTENCE_END = (".", "?", "!")
DATA_DIR = Path(os.environ.get("VOICE_DATA_DIR", ".levelhead/voice-models"))
ALLOWED_ORIGINS = frozenset(
    origin.strip()
    for origin in os.environ.get(
        "VOICE_ORIGINS",
        "http://localhost:3001,http://127.0.0.1:3001,http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
)
MAX_BODY_BYTES = 10 * 1024 * 1024
DATA_DIR.mkdir(parents=True, exist_ok=True)

print(f"loading whisper {WHISPER_MODEL}...", file=sys.stderr)
try:
    whisper = WhisperModel(
        WHISPER_MODEL, device="cpu", compute_type="int8", local_files_only=LOCAL_ONLY
    )
except Exception as exc:
    if LOCAL_ONLY:
        raise RuntimeError(
            f"Whisper {WHISPER_MODEL} is not cached; provision it before starting local-only speech"
        ) from exc
    raise

piper_model_path = DATA_DIR / f"{PIPER_VOICE_NAME}.onnx"
if not piper_model_path.exists() or not Path(f"{piper_model_path}.json").exists():
    if LOCAL_ONLY:
        raise RuntimeError(
            f"Piper {PIPER_VOICE_NAME} model/config missing in {DATA_DIR}; provision both before starting local-only speech"
        )
    print(f"downloading piper voice {PIPER_VOICE_NAME}...", file=sys.stderr)
    download_voice(PIPER_VOICE_NAME, DATA_DIR)
print(f"loading piper {PIPER_VOICE_NAME}...", file=sys.stderr)
piper = PiperVoice.load(str(piper_model_path))


def speak(text: str) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav") as out:
        with wave.open(out.name, "wb") as wf:
            piper.synthesize_wav(text, wf)
        return Path(out.name).read_bytes()


def transcribe(audio: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix) as f:
        f.write(audio)
        f.flush()
        # vad_filter strips silence/near-silence before it reaches the decoder. Without it, Whisper
        # doesn't say "I heard nothing" on quiet or noisy audio - it hallucinates a fluent sentence
        # from nothing (a well-known failure mode; ' You' on pure silence is the classic case).
        # Verified live: silence -> '' with this on, vs ' You' with it off; real speech unaffected.
        segments, _ = whisper.transcribe(f.name, vad_filter=True)
        return "".join(segment.text for segment in segments).strip()


def prosody(audio: bytes, suffix: str) -> dict:
    with tempfile.NamedTemporaryFile(suffix=suffix) as source:
        source.write(audio)
        source.flush()
        # vad_filter stays on for the reason spelled out in transcribe above. Here it matters twice
        # over: every timing below would otherwise be measured off a sentence Whisper invented.
        segments, _ = whisper.transcribe(source.name, word_timestamps=True, vad_filter=True)
        words = [
            {"text": word.word.strip(), "startMs": int(word.start * 1000), "endMs": int(word.end * 1000)}
            for segment in segments
            # word_timestamps=True fills segment.words, but a segment can still carry none.
            for word in (segment.words or ())
            if word.word.strip()
        ]

        # Praat reads a WAV and the browser sends a container it does not. faster-whisper's decoder
        # is already a dependency, so re-encoding here costs an import rather than a second binary.
        decoded = decode_audio(source.name, sampling_rate=SAMPLE_RATE)
        with tempfile.NamedTemporaryFile(suffix=".wav") as wav:
            with wave.open(wav.name, "wb") as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(SAMPLE_RATE)
                wf.writeframes((np.clip(decoded, -1.0, 1.0) * 32767.0).astype("<i2").tobytes())
            audio_ms = int(len(decoded) / SAMPLE_RATE * 1000)

            # Sentences are contiguous runs of word indices, so the caller can walk the same word
            # list with these counts and land on the same boundaries.
            sentences = []
            first = 0
            for index, word in enumerate(words):
                if word["text"].endswith(SENTENCE_END) or index == len(words) - 1:
                    sentences.append((first, index))
                    first = index + 1
            spans = [(words[start]["startMs"] / 1000, words[end]["endMs"] / 1000) for start, end in sentences]

            return {
                "audioMs": audio_ms,
                "words": words,
                "sentences": [
                    {"words": end - start + 1, "endsRising": rising}
                    for (start, end), rising in zip(sentences, terminal_contours(wav.name, spans))
                ],
                "pitch": pitch_track(wav.name),
                "intensity": intensity_track(wav.name),
            }


class Handler(http.server.BaseHTTPRequestHandler):
    def _headers(self, code: int, content_type: str, length: int) -> None:
        self.send_response(code)
        origin = self.headers.get("Origin")
        self.send_header("Vary", "Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.end_headers()

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self._headers(code, "application/json", len(body))
        self.wfile.write(body)

    # Two routes take the same audio bytes, so the container-to-extension mapping is decided once.
    def _suffix(self) -> str:
        content_type = self.headers.get("Content-Type", "")
        return ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".wav"

    def do_OPTIONS(self) -> None:
        if self.headers.get("Origin") not in ALLOWED_ORIGINS:
            self._json(403, {"error": "origin not allowed"})
            return
        self._headers(204, "text/plain", 0)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"status": "ok", "whisperModel": WHISPER_MODEL, "piperVoice": PIPER_VOICE_NAME})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        origin = self.headers.get("Origin")
        if origin is not None and origin not in ALLOWED_ORIGINS:
            self._json(403, {"error": "origin not allowed"})
            return
        length = self.headers.get("Content-Length", "")
        if self.headers.get("Transfer-Encoding") or not length.isdecimal():
            self._json(400, {"error": "Content-Length required; chunked requests unsupported"})
            return
        limit = 16_384 if self.path == "/speak" else MAX_BODY_BYTES
        if int(length) > limit:
            self._json(413, {"error": "request body too large"})
            return
        body = self.rfile.read(int(length))
        if len(body) != int(length):
            self._json(400, {"error": "incomplete request body"})
            return
        try:
            if self.path == "/speak":
                text = json.loads(body).get("text", "").strip()
                if not text:
                    self._json(400, {"error": "text is required"})
                    return
                wav = speak(text)
                self._headers(200, "audio/wav", len(wav))
                self.wfile.write(wav)
            elif self.path == "/transcribe":
                self._json(200, {"text": transcribe(body, self._suffix())})
            elif self.path == "/prosody":
                self._json(200, prosody(body, self._suffix()))
            else:
                self._json(404, {"error": "not found"})
        except Exception as exc:  # noqa: BLE001 - always report as JSON, never a raw traceback
            self._json(502, {"error": str(exc)})

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    server = ThreadingServer((HOST, PORT), Handler)
    print(f"voice service ready on {HOST}:{PORT}", file=sys.stderr)
    server.serve_forever()
