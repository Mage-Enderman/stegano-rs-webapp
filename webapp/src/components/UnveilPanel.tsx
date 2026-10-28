import { useEffect, useMemo, useRef, useState } from 'react';
import { stegano } from '../lib/stegano';
import type { UnveiledPayload } from '../lib/protocol';
import { downloadBlob, errorMessage, formatBytes, shortenHash } from '../lib/files';
import SplatViewer from './SplatViewer';
import ShareCard from './ShareCard';

interface Previewable {
  name: string;
  data: ArrayBuffer;
  sha256: string;
}

const VIEWABLE = /\.(zip|html?|png|jpe?g|gif|webp|avif|bmp|svg|mp4|webm)$/i;

function withBlob(
  payload: UnveiledPayload,
  action: (blob: Blob) => void,
): void {
  action(new Blob([payload.data]));
}

function UnveilPanel({ initialUrl }: { initialUrl: string }) {
  const [source, setSource] = useState<'file' | 'url'>(initialUrl ? 'url' : 'file');
  const [url, setUrl] = useState(initialUrl);
  const [image, setImage] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [files, setFiles] = useState<UnveiledPayload[]>([]);
  const [viewing, setViewing] = useState<Previewable | null>(null);
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const preview = useObjectUrl(image);

  const fetchFromUrl = async (target: string) => {
    if (!target) return;
    setFetching(true);
    setError(null);
    try {
      const response = await fetch(target);
      if (!response.ok) throw new Error(`Server answered ${response.status}`);
      const blob = await response.blob();
      const name = target.split('/').pop() || 'fetched-image';
      setImage(new File([blob], name, { type: blob.type }));
      setFiles([]);
    } catch (cause) {
      setError({
        message: `Could not load that URL: ${errorMessage(cause).message}`,
        hint: 'The server has to allow cross-origin reads. Downloading the image and selecting it as a file always works.',
      });
    } finally {
      setFetching(false);
    }
  };

  // debounced auto fetch for the URL source
  useEffect(() => {
    if (source !== 'url' || !url) return;
    const timer = window.setTimeout(() => void fetchFromUrl(url), 800);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, source]);

  // paste an image anywhere on this tab
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (!item.type.startsWith('image/')) continue;
        const blob = item.getAsFile();
        if (!blob) continue;
        setImage(new File([blob], 'pasted-image.png', { type: blob.type }));
        setSource('file');
        setFiles([]);
        return;
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  const onUnveil = async () => {
    if (!image) return;
    setBusy(true);
    setError(null);
    setFiles([]);

    try {
      const found = await stegano.unveil(image, password);
      if (found.length === 0) {
        setError({
          message: 'No hidden data was found in this carrier.',
          hint: 'Either it never contained a payload, or it was re-encoded. LSB data does not survive JPEG re-compression, resizing or screenshots.',
        });
      } else {
        setFiles(found);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const viewerData = useMemo(
    () => (viewing ? new Uint8Array(viewing.data) : null),
    [viewing],
  );

  return (
    <div className="tab-content">
      <div className="form-group">
        <label>1. Stego image or audio</label>

        <div className="source-selector">
          <button
            className={`source-btn ${source === 'file' ? 'active' : ''}`}
            onClick={() => setSource('file')}
          >
            📁 File / paste
          </button>
          <button
            className={`source-btn ${source === 'url' ? 'active' : ''}`}
            onClick={() => setSource('url')}
          >
            🔗 Image URL
          </button>
        </div>

        {source === 'file' ? (
          <div
            className={`dropzone ${dragging ? 'dragging' : ''}`}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) {
                setImage(file);
                setFiles([]);
              }
            }}
          >
            {image ? (
              <>
                {preview && <img src={preview} alt="Selected carrier" className="carrier-preview" />}
                <div className="dropzone-file">
                  <strong>{image.name}</strong>
                  <span className="file-size">{formatBytes(image.size)}</span>
                </div>
              </>
            ) : (
              <span className="dropzone-hint">
                📁 Drop the stego file here, click to choose, or paste it (Ctrl+V)
              </span>
            )}
          </div>
        ) : (
          <div className="url-input-group">
            <input
              type="text"
              className="url-input"
              placeholder="https://example.com/stego-image.png"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            {fetching && <span className="helper-text">Fetching…</span>}
          </div>
        )}

        <input
          ref={fileInput}
          type="file"
          accept="image/*,.jxl,audio/wav,.wav"
          className="hidden-input"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) {
              setImage(file);
              setFiles([]);
            }
            event.target.value = '';
          }}
        />
      </div>

      <div className="form-group">
        <label>2. Password (only if one was used)</label>
        <input
          type="password"
          placeholder="Password…"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="off"
        />
      </div>

      {error && (
        <div className="error-msg">
          <strong>{error.message}</strong>
          {error.hint && <span className="error-hint">{error.hint}</span>}
        </div>
      )}

      <button className="btn btn-primary" onClick={onUnveil} disabled={busy || !image}>
        {busy ? 'Reading payload…' : 'Unveil data'}
      </button>

      {files.length > 0 && (
        <div className="result-section">
          <h3>
            {files.length} item{files.length === 1 ? '' : 's'} found
          </h3>
          <ul className="result-list">
            {files.map((file, index) => (
              <li key={`${file.name}-${index}`} className="result-item">
                <div className="result-main">
                  <strong>{file.name}</strong>
                  <span className="file-size">{formatBytes(file.data.byteLength)}</span>
                  <code className="hash" title={file.sha256}>
                    sha256 {shortenHash(file.sha256)}
                  </code>
                </div>
                <div className="result-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      withBlob(file, (blob) => downloadBlob(blob, file.name))
                    }
                  >
                    Download
                  </button>
                  {VIEWABLE.test(file.name) && (
                    <button
                      className="btn btn-primary"
                      onClick={() => setViewing(file)}
                    >
                      View
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <p className="helper-text">
            The SHA-256 digest lets you confirm a file arrived unmodified after downloading it.
          </p>
        </div>
      )}

      {viewing && viewerData && (
        <SplatViewer
          fileData={viewerData}
          fileName={viewing.name}
          onClose={() => setViewing(null)}
        />
      )}

      <ShareCard />
    </div>
  );
}

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

export default UnveilPanel;
