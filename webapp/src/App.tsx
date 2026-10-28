import { useEffect, useState } from 'react';
import './App.css';
import HidePanel from './components/HidePanel';
import UnveilPanel from './components/UnveilPanel';

type Tab = 'hide' | 'unveil';

function App() {
  const [tab, setTab] = useState<Tab>('hide');
  const [linkedUrl, setLinkedUrl] = useState('');

  // ?url=... deep link opens the unveil tab with a remote image already loaded
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('url');
    if (linked) {
      setLinkedUrl(linked);
      setTab('unveil');
    }
  }, []);

  return (
    <div className="container">
      <header className="header">
        <h1>Stegano Rust</h1>
        <p>Hide and unveil data in images and audio, entirely in your browser.</p>
      </header>

      <div className="tabs">
        <button
          className={`tab ${tab === 'hide' ? 'active' : ''}`}
          onClick={() => setTab('hide')}
        >
          Hide data
        </button>
        <button
          className={`tab ${tab === 'unveil' ? 'active' : ''}`}
          onClick={() => setTab('unveil')}
        >
          Unveil data
        </button>
      </div>

      <div className="card">
        {tab === 'hide' ? <HidePanel /> : <UnveilPanel initialUrl={linkedUrl} />}
      </div>

      <p className="footer-note">
        Everything runs locally in WebAssembly — no file ever leaves your device.
      </p>
    </div>
  );
}

export default App;
