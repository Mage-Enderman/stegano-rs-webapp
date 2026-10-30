import { useEffect, useMemo, useRef, useState } from 'react';
import { stegano } from '../lib/stegano';
import type { EmbeddingDepth, HidePayload, MediaInfoPayload, Phase } from '../lib/protocol';
import { EMBEDDING_DEPTH_OPTIONS, FORMAT_LABELS } from '../lib/protocol';
import {
  downloadBlob,
  errorMessage,
  formatBytes,
  suggestionFor,
} from '../lib/files';
import ShareCard from './ShareCard';

const PHASE_LABELS: Record<Phase, string> = {
  decode: 'Reading carrier…',
  resize: 'Scaling carrier up…',
  embed: 'Embedding payload…',
  verify: 'Verifying the result…',
};

/** Rough overhead of the payload container (zip headers, length header, salt). */
function estimatePayload(files: File[], text: string, password: string): number {
  const fileBytes = files.reduce((total, file) => total + file.size, 0);
  const textBytes = new TextEncoder().encode(text).length;
  const perFileOverhead = files.length * 80;
  const encryptionOverhead = password ? 96 : 0;
  return fileBytes + textBytes + perFileOverhead + encryptionOverhead + 256;
}

function HidePanel() {
  const [carrier, setCarrier] = useState<File | null>(null);
  const [info, setInfo] = useState<MediaInfoPayload | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [secretFiles, setSecretFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const [autoscale, setAutoscale] = useState(false);
  const [depth, setDepth] = useState<EmbeddingDepth>(1);
  const [format, setFormat] = useState('png');
  const [formats, setFormats] = useState<string[]>(['png', 'webp']);

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [result, setResult] = useState<HidePayload | null>(null);
  const [outputName, setOutputName] = useState('');
  const [dragging, setDragging] = useState<'carrier' | 'secret' | null>(null);

  const carrierInput = useRef<HTMLInputElement | null>(null);
  const secretInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    stegano
      .formats()
      .then((available) => {
        if (cancelled) return;
        setFormats(available);
        setFormat((current) => (available.includes(current) ? current : available[0] ?? 'png'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!carrier) {
      setInfo(null);
      setInfoError(null);
      return;
    }
    let cancelled = false;
    setInfo(null);
    setInfoError(null);
    stegano
      .info(carrier, depth)
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setInfoError(errorMessage(cause).message);
      });
    return () => {
      cancelled = true;
    };
  }, [carrier, depth]);

  const carrierPreview = useObjectUrl(carrier);
  const resultPreview = useObjectUrl(result ? result.blob : null);

  const payloadEstimate = useMemo(
    () => estimatePayload(secretFiles, text, password),
    [secretFiles, text, password],
  );
  const capacity = info?.capacityBytes ?? 0;
  const usage = capacity > 0 ? payloadEstimate / capacity : 0;
  const tooLarge = capacity > 0 && payloadEstimate > capacity;
  const hasPayload = secretFiles.length > 0 || text.trim().length > 0;

  const pickCarrier = (file: File | undefined) => {
    if (!file) return;
    setCarrier(file);
    setResult(null);
    setError(null);
    setOutputName('');
  };

  const addSecretFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setSecretFiles((current) => [...current, ...incoming]);
    setResult(null);
  };

  const removeSecretFile = (index: number) => {
    setSecretFiles((current) => current.filter((_, i) => i !== index));
  };

  const onHide = async () => {
    if (!carrier || !hasPayload) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPhase(null);

    try {
      const payload = await stegano.hide({
        carrier,
        files: secretFiles,
        text,
        password,
        autoscale,
        format,
        depth,
        onPhase: setPhase,
      });
      setResult(payload);
      // audio carriers always keep their wav container
      const extension = payload.kind === 'audio' ? 'wav' : payload.format;
      setOutputName(suggestionFor(carrier.name, extension));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setPhase(null);
    }
  };

  return (
    <div className="tab-content">
      <div className="form-group">
        <label>1. Carrier — an image or a WAV file</label>
        <div
          className={`dropzone ${dragging === 'carrier' ? 'dragging' : ''}`}
          onClick={() => carrierInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging('carrier');
          }}
          onDragLeave={() => setDragging(null)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(null);
            pickCarrier(event.dataTransfer.files[0]);
          }}
        >
          {carrier ? (
            <>
              {info?.kind === 'audio' ? (
                <audio controls src={carrierPreview ?? undefined} className="audio-preview" />
              ) : (
                carrierPreview && (
                  <img src={carrierPreview} alt="Carrier preview" className="carrier-preview" />
                )
              )}
              <div className="dropzone-file">
                <strong>{carrier.name}</strong>
                <span className="file-size">{formatBytes(carrier.size)}</span>
              </div>
            </>
          ) : (
            <span className="dropzone-hint">
              📁 Drop a file here or click to choose — PNG, WebP, JPEG, JPEG XL, WAV
            </span>
          )}
        </div>
        <input
          ref={carrierInput}
          type="file"
          accept="image/*,.jxl,audio/wav,.wav"
          className="hidden-input"
          onChange={(event) => pickCarrier(event.target.files?.[0])}
        />

        {info && (
          <div className="capacity">
            <div className="capacity-head">
              <span>
                {info.kind === 'audio'
                  ? 'Audio carrier'
                  : `${info.width} × ${info.height}`}
                {info.isJxl && <span className="pill">JPEG XL</span>}
              </span>
              <span className={tooLarge ? 'capacity-over' : ''}>
                ≈ {formatBytes(payloadEstimate)} / {formatBytes(capacity)}
              </span>
            </div>
            <div className="capacity-meter">
              <div
                className={`capacity-fill ${tooLarge ? 'over' : ''}`}
                style={{ width: `${Math.min(100, Math.round(usage * 100))}%` }}
              />
            </div>
            {tooLarge && (
              <p className="capacity-warning">
                {info.kind === 'audio'
                  ? 'This payload does not fit into the audio track.'
                  : 'This payload does not fit. Enable autoscale below to upscale the carrier.'}
              </p>
            )}
          </div>
        )}
        {infoError && <p className="capacity-warning">{infoError}</p>}
      </div>

      <div className="form-group">
        <label>2. Secret — files and/or a text note</label>
        <div
          className={`dropzone dropzone-small ${dragging === 'secret' ? 'dragging' : ''}`}
          onClick={() => secretInput.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging('secret');
          }}
          onDragLeave={() => setDragging(null)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(null);
            addSecretFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <span className="dropzone-hint">📁 Add files (any type, several allowed)</span>
        </div>
        <input
          ref={secretInput}
          type="file"
          multiple
          className="hidden-input"
          onChange={(event) => {
            // the FileList is live: take a copy before resetting the input
            addSecretFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />

        {secretFiles.length > 0 && (
          <ul className="file-chips">
            {secretFiles.map((file, index) => (
              <li key={`${file.name}-${index}`} className="file-chip">
                <span className="chip-name">{file.name}</span>
                <span className="file-size">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  className="btn-clear"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeSecretFile(index)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <textarea
          rows={3}
          placeholder="…or type a message to hide"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setResult(null);
          }}
        />
      </div>

      <div className="form-group">
        <label>3. Options</label>
        <input
          type="password"
          placeholder="Password (optional, encrypts the payload)"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />

        {/* audio carriers always stay wav and cannot be scaled */}
        {info?.kind !== 'audio' && (
          <>
            <div className="option-row">
              <label className="option-label" htmlFor="embedding-depth">
                Embedding depth
              </label>
              <select
                id="embedding-depth"
                value={depth}
                onChange={(event) => {
                  setDepth(Number(event.target.value) as EmbeddingDepth);
                  setResult(null);
                }}
              >
                {EMBEDDING_DEPTH_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {depth > 1 && (
              <p className="helper-text">
                Deeper embedding multiplies how much fits into the carrier, but it overwrites more
                of every pixel: expect visible speckle, and keep the file lossless either way.
              </p>
            )}

            <div className="option-row">
              <label className="option-label">Output format</label>
              <select value={format} onChange={(event) => setFormat(event.target.value)}>
                {formats.map((name) => (
                  <option key={name} value={name}>
                    {FORMAT_LABELS[name] ?? name.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <label className={`option-toggle ${tooLarge ? 'attention' : ''}`}>
              <input
                type="checkbox"
                checked={autoscale}
                onChange={(event) => setAutoscale(event.target.checked)}
              />
              Autoscale the carrier when the payload does not fit
            </label>
          </>
        )}
      </div>

      {error && (
        <div className="error-msg">
          <strong>{error.message}</strong>
          {error.hint && <span className="error-hint">{error.hint}</span>}
        </div>
      )}

      <button
        className="btn btn-primary"
        onClick={onHide}
        disabled={busy || !carrier || !hasPayload}
      >
        {busy ? (
          <span className="busy">
            {phase ? PHASE_LABELS[phase] : 'Working…'}
            <span className="busy-bar" />
          </span>
        ) : (
          'Hide data'
        )}
      </button>

      {result && (
        <div className="result-section">
          <div className={`verdict ${result.verified ? 'ok' : 'bad'}`}>
            {result.verified ? '✓ Verified —' : '⚠ Verification failed —'} {result.verification}
          </div>

          {resultPreview &&
            (result.kind === 'audio' ? (
              <audio controls src={resultPreview} className="audio-preview" />
            ) : (
              <img src={resultPreview} alt="Result preview" className="preview-image" />
            ))}

          <dl className="stats-grid">
            <div>
              <dt>Payload</dt>
              <dd>
                {formatBytes(result.payloadBytes)} of {formatBytes(result.capacityBytes)}
              </dd>
            </div>
            {result.kind === 'image' && (
              <div>
                <dt>Embedding depth</dt>
                <dd>
                  {result.depth} bit{result.depth === 1 ? '' : 's'} per channel
                </dd>
              </div>
            )}
            <div>
              <dt>Quality</dt>
              <dd>
                {result.psnr === undefined
                  ? '—'
                  : Number.isFinite(result.psnr)
                    ? `${result.psnr.toFixed(1)} dB PSNR`
                    : 'untouched'}
              </dd>
            </div>
            <div>
              <dt>Changed channels</dt>
              <dd>
                {result.changedRatio === undefined
                  ? '—'
                  : `${(result.changedRatio * 100).toFixed(1)} %`}
              </dd>
            </div>
            <div>
              <dt>Took</dt>
              <dd>{(result.elapsedMs / 1000).toFixed(2)} s</dd>
            </div>
          </dl>

          {result.resized && (
            <p className="helper-text">
              The carrier was scaled up to {result.width} × {result.height} to fit the payload.
            </p>
          )}

          <div className="option-row">
            <label className="option-label" htmlFor="output-name">
              File name
            </label>
            <input
              id="output-name"
              type="text"
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
            />
          </div>

          <button
            className="btn btn-primary"
            onClick={() =>
              downloadBlob(
                result.blob,
                outputName || `stego.${result.kind === 'audio' ? 'wav' : result.format}`,
              )
            }
          >
            Download {formatBytes(result.blob.size)}
          </button>

          <p className="helper-text">
            Share this file as-is. Re-saving it as JPEG, sending it through a chat app that
            re-compresses images, or resizing it will destroy the hidden data — the payload lives
            in the least significant bits.
          </p>
        </div>
      )}

      <ShareCard />
    </div>
  );
}

/** Object URL for a file, revoked when it is replaced. */
function useObjectUrl(source: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!source) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(source);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [source]);

  return url;
}

export default HidePanel;
