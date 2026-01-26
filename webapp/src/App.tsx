import { useEffect, useState } from 'react';
import './App.css';
import init, { hide_data, unveil_data } from './pkg/stegano_wasm';
import SplatViewer from './components/SplatViewer';

function App() {
  const [activeTab, setActiveTab] = useState<'hide' | 'unveil'>('hide');
  const [isWasmLoaded, setIsWasmLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hide State
  const [carrierFile, setCarrierFile] = useState<File | null>(null);
  const [secretFile, setSecretFile] = useState<File | null>(null);
  const [hidePassword, setHidePassword] = useState('');
  const [hiddenImageUrl, setHiddenImageUrl] = useState<string | null>(null);
  const [autoResize, setAutoResize] = useState(false);
  const [outputFormat, setOutputFormat] = useState<'png' | 'webp'>('png');

  // Capacity Check
  const [needsResize, setNeedsResize] = useState(false);
  const [capacityStats, setCapacityStats] = useState<{ cap: number, payload: number } | null>(null);

  // Naming Options
  const [namingMode, setNamingMode] = useState<'suffix' | 'prefix' | 'custom'>('suffix');
  const [affixText, setAffixText] = useState('_stego');
  const [customName, setCustomName] = useState('');

  const getDownloadName = () => {
    if (!carrierFile) return 'hidden.png';
    const originalName = carrierFile.name;
    const dotIndex = originalName.lastIndexOf('.');
    const name = dotIndex !== -1 ? originalName.substring(0, dotIndex) : originalName;
    const ext = '.' + outputFormat;

    if (namingMode === 'custom') {
      return customName.endsWith('.png') ? customName : (customName + '.png');
    } else if (namingMode === 'prefix') {
      return `${affixText}${name}${ext}`;
    } else {
      return `${name}${affixText}${ext}`;
    }
  };

  // Unveil State
  const [unveilSource, setUnveilSource] = useState<'file' | 'url'>('file');
  const [unveilUrl, setUnveilUrl] = useState('');
  const [unveilImage, setUnveilImage] = useState<File | null>(null);
  const [unveilPassword, setUnveilPassword] = useState('');
  const [unveiledFiles, setUnveiledFiles] = useState<{ name: string; data: Uint8Array }[]>([]);

  // Viewer State
  const [viewingFile, setViewingFile] = useState<{ name: string; data: Uint8Array } | null>(null);

  // Preview State
  const [carrierPreview, setCarrierPreview] = useState<string | null>(null);
  const [unveilPreview, setUnveilPreview] = useState<string | null>(null);

  // Carrier Preview Effect
  useEffect(() => {
    if (!carrierFile) {
      setCarrierPreview(null);
      return;
    }
    const url = URL.createObjectURL(carrierFile);
    setCarrierPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [carrierFile]);

  // Unveil Preview Effect
  useEffect(() => {
    if (!unveilImage) {
      setUnveilPreview(null);
      return;
    }
    const url = URL.createObjectURL(unveilImage);
    setUnveilPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [unveilImage]);

  useEffect(() => {
    init().then(() => {
      setIsWasmLoaded(true);
      console.log('Wasm loaded successfully');
    }).catch(console.error);

    // Check for query param 'url'
    const searchParams = new URLSearchParams(window.location.search);
    const linkedUrl = searchParams.get('url');
    if (linkedUrl) {
      setActiveTab('unveil');
      setUnveilSource('url');
      setUnveilUrl(linkedUrl);
    }
  }, []);

  // Capacity Check Effect
  useEffect(() => {
    const checkCapacity = async () => {
      if (!carrierFile || !secretFile) {
        setNeedsResize(false);
        setCapacityStats(null);
        return;
      }

      try {
        const imgBitmap = await createImageBitmap(carrierFile);
        const width = imgBitmap.width;
        const height = imgBitmap.height;
        // Capacity = (w * h * 3) / 8
        const capacity = Math.floor((width * height * 3) / 8);
        const payload = secretFile.size + 1024; // 1KB overhead estimate matches Rust

        setCapacityStats({ cap: capacity, payload });

        if (payload > capacity) {
          setNeedsResize(true);
        } else {
          setNeedsResize(false);
        }
        imgBitmap.close();
      } catch (e) {
        console.error("Failed to check capacity:", e);
      }
    };
    checkCapacity();
  }, [carrierFile, secretFile]);

  const handleCarrierChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setCarrierFile(e.target.files[0]);
      setHiddenImageUrl(null);
    }
  };

  const handleSecretChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setSecretFile(e.target.files[0]);
    }
  };

  const handleUnveilImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setUnveilImage(e.target.files[0]);
      setUnveiledFiles([]);
    }
  };

  const handleUrlFetch = async (urlToFetch: string) => {
    if (!urlToFetch) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(urlToFetch);
      if (!response.ok) throw new Error("Failed to fetch image");
      const blob = await response.blob();
      const file = new File([blob], "fetched_image.png", { type: blob.type });
      setUnveilImage(file);
      setUnveiledFiles([]);
    } catch (e) {
      console.error(e);
      setError("Failed to fetch image from URL. Ensure CORS is allowed or try another URL.");
    } finally {
      setLoading(false);
    }
  };

  // Debounced Auto-Fetch
  useEffect(() => {
    const timer = setTimeout(() => {
      if (unveilUrl && unveilSource === 'url') {
        handleUrlFetch(unveilUrl);
      }
    }, 800); // 800ms debounce

    return () => clearTimeout(timer);
  }, [unveilUrl, unveilSource]);


  // Global Paste Handler
  useEffect(() => {
    const handleGlobalPaste = async (e: ClipboardEvent) => {
      // Only handle paste if we are on the unveil tab
      if (activeTab !== 'unveil') return;

      if (e.clipboardData && e.clipboardData.items) {
        for (let i = 0; i < e.clipboardData.items.length; i++) {
          const item = e.clipboardData.items[i];
          if (item.type.startsWith('image/')) {
            const blob = item.getAsFile();
            if (blob) {
              const file = new File([blob], "pasted_image.png", { type: blob.type });
              setUnveilImage(file);
              setUnveiledFiles([]);
              // Ensure we are in a mode where the user can see it, though 'file' vs 'url' is just for input method.
              // We can switch to 'file' to show the "Selected: ..." part clearly if we want,
              // but mostly we just want to ensure the file is set.
              setUnveilSource('file');
            }
            return; // Stop after finding an image
          }
        }
      }
    };

    window.addEventListener('paste', handleGlobalPaste);
    return () => {
      window.removeEventListener('paste', handleGlobalPaste);
    };
  }, [activeTab]);

  const onHide = async () => {
    if (!carrierFile || !secretFile || !isWasmLoaded) return;
    setLoading(true);
    setError(null);

    try {
      const carrierBytes = new Uint8Array(await carrierFile.arrayBuffer());
      const secretBytes = new Uint8Array(await secretFile.arrayBuffer());

      // Need to handle password optionality correctly
      const passwordArg = hidePassword.trim() === '' ? undefined : hidePassword;

      // Pass autoResize and outputFormat to WASM
      // hide_data signature: (carrier, name, secret, password, resize, format)
      const result = hide_data(carrierBytes, secretFile.name, secretBytes, passwordArg, autoResize, outputFormat);

      const mimeType = outputFormat === 'png' ? 'image/png' : 'image/webp';
      const blob = new Blob([result as any], { type: mimeType });
      const url = URL.createObjectURL(blob);
      setHiddenImageUrl(url);
    } catch (e: any) {
      console.error(e);
      // Clean up error message
      let msg = typeof e === 'string' ? e : "Ensure image is large enough.";
      if (typeof e === 'object' && e !== null && e.toString) {
        msg = e.toString();
      }
      setError("Failed to hide data. " + msg);
    } finally {
      setLoading(false);
    }
  };

  const onUnveil = async () => {
    if (!unveilImage || !isWasmLoaded) return;
    setLoading(true);
    setError(null);

    try {
      const carrierBytes = new Uint8Array(await unveilImage.arrayBuffer());
      const passwordArg = unveilPassword.trim() === '' ? undefined : unveilPassword;

      const results = unveil_data(carrierBytes, passwordArg);

      const files: { name: string; data: Uint8Array }[] = [];
      for (let i = 0; i < results.length; i++) {
        const item = results[i];
        files.push({
          name: item.name,
          data: item.data
        });
      }

      if (files.length === 0) {
        setError("No hidden data found or incorrect password.");
      } else {
        setUnveiledFiles(files);
      }
    } catch (e: any) {
      console.error(e);
      let msg = typeof e === 'string' ? e : "Check password or image format.";
      if (typeof e === 'object' && e !== null && e.toString) {
        msg = e.toString();
      }
      setError("Failed to unveil data. " + msg);
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = (name: string, data: Uint8Array) => {
    const blob = new Blob([data as any]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isWasmLoaded) {
    return <div className="loading-spinner"></div>;
  }

  return (
    <div className="container">
      <div className="header">
        <h1>Stegano Rust</h1>
        <p>Securely hide and unveil data in images, locally.</p>
      </div>

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'hide' ? 'active' : ''}`}
          onClick={() => setActiveTab('hide')}
        >
          Hide Data
        </button>
        <button
          className={`tab ${activeTab === 'unveil' ? 'active' : ''}`}
          onClick={() => setActiveTab('unveil')}
        >
          Unveil Data
        </button>
      </div>

      <div className="card">
        {activeTab === 'hide' ? (
          <div className="tab-content">
            <div className="form-group">
              <label>1. Select Carrier Image</label>
              <input type="file" accept="image/*" onChange={handleCarrierChange} className="file-input" />
              {carrierPreview && (
                <div className="image-preview-container" style={{ marginTop: '0.5rem' }}>
                  <img
                    src={carrierPreview}
                    alt="Carrier Preview"
                    style={{ maxHeight: '200px', maxWidth: '100%', borderRadius: '4px', border: '1px solid #444' }}
                  />
                </div>
              )}
            </div>

            <div className="form-group">
              <label>2. Select Secret File (Any)</label>
              <input type="file" onChange={handleSecretChange} className="file-input" />
            </div>

            <div className="form-group">
              <label>3. Password (Optional)</label>
              <input
                type="password"
                placeholder="Enter password to encrypt..."
                value={hidePassword}
                onChange={(e) => setHidePassword(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Output Format</label>
              <div style={{ display: 'flex', gap: '1rem' }}>
                <label>
                  <input
                    type="radio"
                    name="outputFormat"
                    value="png"
                    checked={outputFormat === 'png'}
                    onChange={() => setOutputFormat('png')}
                  /> PNG
                </label>
                <label>
                  <input
                    type="radio"
                    name="outputFormat"
                    value="webp"
                    checked={outputFormat === 'webp'}
                    onChange={() => setOutputFormat('webp')}
                  /> WebP
                </label>
              </div>
            </div>

            {/* Auto Resize Toggle */}
            <div className={`form-group ${needsResize ? 'highlight-resize' : ''}`} style={{
              border: needsResize ? '2px solid #ffcf44' : '1px solid #333',
              padding: '10px',
              borderRadius: '8px',
              transition: 'all 0.3s ease',
              background: needsResize ? 'rgba(255, 207, 68, 0.1)' : 'transparent',
              marginTop: '1rem',
              marginBottom: '1rem'
            }}>
              <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', color: needsResize ? '#ffcf44' : 'inherit', width: '100%' }}>
                <input
                  type="checkbox"
                  checked={autoResize}
                  onChange={(e) => setAutoResize(e.target.checked)}
                  style={{ width: 'auto', marginRight: '10px', transform: 'scale(1.2)' }}
                />
                <b style={{ fontSize: '1rem' }}>Autoscale Input Image</b>
              </label>
              <div style={{ fontSize: '0.85rem', marginTop: '8px', color: '#ccc', marginLeft: '26px' }}>
                {needsResize ? (
                  <span style={{ color: '#ffcf44', fontWeight: 'bold' }}>
                    ⚠️ Image too small! <br />
                    Required: {(capacityStats?.payload! / 1024).toFixed(1)} KB<br />
                    Available: {(capacityStats?.cap! / 1024).toFixed(1)} KB<br />
                    Enable this option to automatically resize the carrier.
                  </span>
                ) : (
                  "Automatically resize carrier image if payload is too large."
                )}
              </div>
            </div>

            {error && <div className="error-msg">{error}</div>}

            <div className="form-group">
              <label>4. Output Filename</label>
              <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="namingMode"
                    value="suffix"
                    checked={namingMode === 'suffix'}
                    onChange={() => setNamingMode('suffix')}
                    style={{ width: 'auto', marginRight: '0.5rem' }}
                  /> Suffix
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="namingMode"
                    value="prefix"
                    checked={namingMode === 'prefix'}
                    onChange={() => setNamingMode('prefix')}
                    style={{ width: 'auto', marginRight: '0.5rem' }}
                  /> Prefix
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <input
                    type="radio"
                    name="namingMode"
                    value="custom"
                    checked={namingMode === 'custom'}
                    onChange={() => setNamingMode('custom')}
                    style={{ width: 'auto', marginRight: '0.5rem' }}
                  /> Custom Name
                </label>
              </div>

              {namingMode === 'custom' ? (
                <input
                  type="text"
                  placeholder="my-secret-image.png"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                />
              ) : (
                <input
                  type="text"
                  placeholder={namingMode === 'suffix' ? "e.g. _steg" : "e.g. secret_"}
                  value={affixText}
                  onChange={(e) => setAffixText(e.target.value)}
                />
              )}
            </div>

            <button
              className="btn btn-primary"
              onClick={onHide}
              disabled={loading || !carrierFile || !secretFile}
            >
              {loading ? 'Processing...' : 'Hide Data & Download'}
            </button>

            {hiddenImageUrl && (
              <div className="result-section">
                <h3>Success!</h3>
                <img src={hiddenImageUrl} alt="Hidden Result" className="preview-image" />
                <br />
                <a href={hiddenImageUrl} download={getDownloadName()} className="btn btn-primary" style={{ display: 'inline-block', marginTop: '1rem', textDecoration: 'none' }}>
                  Download Image
                </a>
              </div>
            )}
          </div>
        ) : (
          <div className="tab-content">
            <div className="form-group">
              <label>1. Select Image Source</label>

              <div className="source-selector">
                <button
                  className={`source-btn ${unveilSource === 'file' ? 'active' : ''}`}
                  onClick={() => setUnveilSource('file')}
                >
                  📁 File Upload / Paste
                </button>
                <button
                  className={`source-btn ${unveilSource === 'url' ? 'active' : ''}`}
                  onClick={() => setUnveilSource('url')}
                >
                  🔗 Image URL
                </button>
              </div>

              {unveilSource === 'file' && (
                <div className="upload-area">
                  <input type="file" accept="image/*,.jxl" onChange={handleUnveilImageChange} className="file-input" />
                  <p className="helper-text">💡 You can also paste an image (Ctrl+V) anywhere on this tab.</p>
                </div>
              )}

              {unveilSource === 'url' && (
                <div className="url-input-group">
                  <input
                    type="text"
                    className="url-input"
                    placeholder="https://example.com/image.png"
                    value={unveilUrl}
                    onChange={(e) => setUnveilUrl(e.target.value)}
                  />
                  {loading && <div style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}>Fetching...</div>}
                </div>
              )}

              {unveilImage && (
                <div className="selected-file-preview">
                  {unveilPreview && (
                    <img
                      src={unveilPreview}
                      alt="Unveil Preview"
                      style={{ width: '40px', height: '40px', objectFit: 'cover', borderRadius: '4px', marginRight: '10px' }}
                    />
                  )}
                  <div className="selected-file-info">
                    ✅ <strong>{unveilImage.name}</strong>
                    <span className="file-size">({(unveilImage.size / 1024).toFixed(1)} KB)</span>
                  </div>
                  <button className="btn-clear" onClick={() => { setUnveilImage(null); setUnveiledFiles([]); }}>✕</button>
                </div>
              )}
            </div>

            <div className="form-group">
              <label>2. Password (If used)</label>
              <input
                type="password"
                placeholder="Enter password..."
                value={unveilPassword}
                onChange={(e) => setUnveilPassword(e.target.value)}
              />
            </div>

            {error && <div className="error-msg">{error}</div>}

            <button
              className="btn btn-primary"
              onClick={onUnveil}
              disabled={loading || !unveilImage}
            >
              {loading ? 'Processing...' : 'Unveil Data'}
            </button>

            {unveiledFiles.length > 0 && (
              <div className="result-section">
                <h3>Found Files:</h3>
                {unveiledFiles.map((f, i) => (
                  <div key={i} style={{ marginBottom: '0.5rem' }}>
                    <span>{f.name} ({(f.data.length / 1024).toFixed(2)} KB)</span>
                    <div style={{ display: 'inline-flex', gap: '0.5rem', marginLeft: '1rem' }}>
                      <button
                        className="btn"
                        style={{ width: 'auto', padding: '0.5rem' }}
                        onClick={() => downloadFile(f.name, f.data)}
                      >
                        Download
                      </button>
                      {(f.name.toLowerCase().endsWith('.zip') ||
                        f.name.toLowerCase().endsWith('.html') ||
                        f.name.toLowerCase().match(/\.(png|jpg|jpeg|gif|webp|avif|bmp|svg)$/)) && (
                          <button
                            className="btn btn-primary"
                            style={{ width: 'auto', padding: '0.5rem', background: 'var(--secondary-color)', color: '#000' }}
                            onClick={() => setViewingFile(f)}
                          >
                            View Content
                          </button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {viewingFile && (
              <SplatViewer
                fileData={viewingFile.data}
                fileName={viewingFile.name}
                onClose={() => setViewingFile(null)}
              />
            )}

          </div>
        )}
      </div>
    </div>
  );
}

export default App;
