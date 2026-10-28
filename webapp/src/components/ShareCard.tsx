import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';

/**
 * Builds a link that opens this app with a remote image already loaded.
 *
 * The app is fully local: images are never uploaded, so a link can only point
 * at an image that is already reachable on the web. The QR code exists to get
 * that link onto a phone without typing it.
 */
function ShareCard() {
  const [imageUrl, setImageUrl] = useState('');
  const [shareLink, setShareLink] = useState('');
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!shareLink || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, shareLink, {
      width: 180,
      margin: 1,
      color: { dark: '#121212', light: '#ffffff' },
    }).catch(() => {
      /* the link itself stays usable when QR rendering fails */
    });
  }, [shareLink]);

  const buildLink = () => {
    const trimmed = imageUrl.trim();
    if (!trimmed) {
      setShareLink('');
      return;
    }
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('url', trimmed);
    setShareLink(url.toString());
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable, the field is selectable */
    }
  };

  return (
    <div className="share-card">
      <h3>Open on another device</h3>
      <p className="helper-text">
        Paste the public URL of a stego image. You get a link (and QR code) that opens this
        app with that image ready to unveil. Nothing is uploaded.
      </p>

      <div className="share-input-row">
        <input
          type="url"
          className="url-input"
          placeholder="https://example.com/secret.png"
          value={imageUrl}
          onChange={(event) => setImageUrl(event.target.value)}
        />
        <button className="btn" type="button" onClick={buildLink} disabled={!imageUrl.trim()}>
          Create link
        </button>
      </div>

      {shareLink && (
        <div className="share-result">
          <div className="share-link-row">
            <input className="url-input" readOnly value={shareLink} onFocus={(e) => e.target.select()} />
            <button className="btn btn-primary" type="button" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <canvas ref={canvasRef} className="qr-canvas" aria-label="QR code of the share link" />
        </div>
      )}
    </div>
  );
}

export default ShareCard;
