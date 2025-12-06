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
    const ext = dotIndex !== -1 ? originalName.substring(dotIndex) : '.png';

    if (namingMode === 'custom') {
      return customName.endsWith('.png') ? customName : (customName + '.png');
    } else if (namingMode === 'prefix') {
      return `${affixText}${name}${ext}`;
    } else {
      return `${name}${affixText}${ext}`;
    }
  };

  // Unveil State
  const [unveilImage, setUnveilImage] = useState<File | null>(null);
  const [unveilPassword, setUnveilPassword] = useState('');
  const [unveiledFiles, setUnveiledFiles] = useState<{ name: string; data: Uint8Array }[]>([]);

  // Viewer State
  const [viewingFile, setViewingFile] = useState<{ name: string; data: Uint8Array } | null>(null);

  useEffect(() => {
    init().then(() => {
      setIsWasmLoaded(true);
      console.log('Wasm loaded successfully');
    }).catch(console.error);
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

  const onHide = async () => {
    if (!carrierFile || !secretFile || !isWasmLoaded) return;
    setLoading(true);
    setError(null);

    try {
      const carrierBytes = new Uint8Array(await carrierFile.arrayBuffer());
      const secretBytes = new Uint8Array(await secretFile.arrayBuffer());

      // Need to handle password optionality correctly
      const passwordArg = hidePassword.trim() === '' ? undefined : hidePassword;

      // Pass autoResize to WASM
      const result = hide_data(carrierBytes, secretFile.name, secretBytes, passwordArg, autoResize);

      const blob = new Blob([result as any], { type: 'image/png' });
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
              <label>1. Select Carrier Image (PNG)</label>
              <input type="file" accept="image/png" onChange={handleCarrierChange} className="file-input" />
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
              <label>1. Select Image with Hidden Data</label>
              <input type="file" accept="image/png" onChange={handleUnveilImageChange} className="file-input" />
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
