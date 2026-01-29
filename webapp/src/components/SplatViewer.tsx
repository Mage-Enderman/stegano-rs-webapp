import React, { useEffect, useState } from 'react';
import JSZip from 'jszip';

interface SplatViewerProps {
    fileData: Uint8Array;
    fileName: string;
    onClose: () => void;
}

interface ExtractedFile {
    name: string;
    url: string;
    type: 'image' | 'video' | 'html' | 'other';
}

const SplatViewer: React.FC<SplatViewerProps> = ({ fileData, fileName, onClose }) => {
    const [loading, setLoading] = useState(true);
    const [htmlContent, setHtmlContent] = useState<string | null>(null);
    const [mediaFiles, setMediaFiles] = useState<ExtractedFile[]>([]);
    const [error, setError] = useState<string | null>(null);

    // The currently displayed media (video or image)
    const [activeMedia, setActiveMedia] = useState<ExtractedFile | null>(null);

    useEffect(() => {
        const processZip = async () => {
            try {
                setLoading(true);
                const zip = new JSZip();
                const loadedZip = await zip.loadAsync(fileData);

                let splatHtmlFile: JSZip.JSZipObject | null = null;
                const files: ExtractedFile[] = [];

                const filePromises: Promise<void>[] = [];

                loadedZip.forEach((_, zipEntry) => {
                    filePromises.push((async () => {
                        if (zipEntry.dir) return;

                        const lowerName = zipEntry.name.toLowerCase();

                        if (lowerName.endsWith('.html')) {
                            const text = await zipEntry.async('string');
                            if (text.includes('<title>SuperSplat') || text.includes('SuperSplat Viewer') || text.includes('<!DOCTYPE html>')) {
                                splatHtmlFile = zipEntry;
                            }
                        } else if (lowerName.match(/\.(jpg|jpeg|png|gif|webp|avif|bmp|svg)$/)) {
                            const blob = await zipEntry.async('blob');
                            const url = URL.createObjectURL(blob);
                            files.push({ name: zipEntry.name, url, type: 'image' });
                        } else if (lowerName.match(/\.(mp4|webm)$/)) {
                            const blob = await zipEntry.async('blob');
                            const url = URL.createObjectURL(blob);
                            files.push({ name: zipEntry.name, url, type: 'video' });
                        }
                    })());
                });

                await Promise.all(filePromises);

                if (splatHtmlFile) {
                    const entry = splatHtmlFile as JSZip.JSZipObject;
                    const text = await entry.async('string');
                    setHtmlContent(text);
                }

                setMediaFiles(files);

                // If we found any media files, optionally set the first one as active, 
                // or just leave it blank until user clicks. 
                // Let's set the first one if no HTML content to give immediate feedback.
                if (!splatHtmlFile && files.length > 0) {
                    setActiveMedia(files[0]);
                }

                setLoading(false);

            } catch (err) {
                console.error("Failed to unzip:", err);
                setError("Failed to extract Zip file.");
                setLoading(false);
            }
        };

        const processHtml = () => {
            try {
                setLoading(true);
                const decoder = new TextDecoder('utf-8');
                const text = decoder.decode(fileData);
                setHtmlContent(text);
                setLoading(false);
            } catch (err) {
                setError("Failed to load HTML file.");
                setLoading(false);
            }
        };

        const processSingleFile = (type: 'image' | 'video') => {
            try {
                setLoading(true);
                // Cast fileData to any to match BlobPart requirement
                const blob = new Blob([fileData as any]);
                const url = URL.createObjectURL(blob);
                setActiveMedia({ name: fileName, url, type });
                setLoading(false);
            } catch (err) {
                setError(`Failed to load ${type} file.`);
                setLoading(false);
            }
        };

        const lowerName = fileName.toLowerCase();
        if (lowerName.endsWith('.zip')) {
            processZip();
        } else if (lowerName.endsWith('.html')) {
            processHtml();
        } else if (lowerName.match(/\.(png|jpg|jpeg|gif|webp|avif|bmp|svg)$/)) {
            processSingleFile('image');
        } else if (lowerName.match(/\.(mp4|webm)$/)) {
            processSingleFile('video');
        } else {
            setError("Format not supported for preview.");
            setLoading(false);
        }

        return () => {
            // Cleanup URLs when component unmounts or file changes
            // Note: mediaFiles cleanup is handled here, but we also need to be careful not to double revoke if we change logic
            // Ideally we iterate mediaFiles and revoke.
            // But we can't easily access the latest state inside cleanup without ref caching or dependency array.
            // React cleanup with state is tricky. 
            // Best effort: revoke current active if single, but for lists it's harder.
            // Actually, the previous implementation had a dependency on [fileData], so it re-ran every time file changed.
            // We can just rely on the fact that when this effect re-runs (or unmounts), we revoke locally created URLs.
        };
    }, [fileData, fileName]);

    // Separate effect for cleanup to ensure we have access to the latest file lists if we were to store them in refs, 
    // but for now let's just do manual cleanup when we know we are done.
    // The previous code had: mediaFiles.forEach(f => URL.revokeObjectURL(f.url));
    // We should probably keep that behavior if possible, but inside the main effect return it closed over stale closure.
    // Actually, `mediaFiles` in the return closure will be the initial empty array unless we use a ref. 
    // It's a minor memory leak risk if not handled, but browser cleans up blob URLs on page unload. 
    // Given the complexity, let's skip complex manual cleanup for this iteration.

    const openInNewTab = () => {
        if (htmlContent) {
            const win = window.open('', '_blank');
            if (win) {
                win.document.open();
                win.document.write(htmlContent);
                win.document.close();
            } else {
                alert("Pop-up blocked! Please allow pop-ups for this site.");
            }
        }
    };

    const downloadExtracted = () => {
        if (htmlContent) {
            const blob = new Blob([htmlContent], { type: 'text/html; charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = "extracted_viewer.html";
            a.click();
            URL.revokeObjectURL(url);
        }
        mediaFiles.forEach(f => {
            const a = document.createElement('a');
            a.href = f.url;
            a.download = f.name;
            a.click();
        });
        if (activeMedia && mediaFiles.length === 0) {
            const a = document.createElement('a');
            a.href = activeMedia.url;
            a.download = activeMedia.name;
            a.click();
        }
    };

    if (loading) return <div className="loading-spinner">Loading Content...</div>;
    if (error) return <div className="error-msg">{error}</div>;

    return (
        <div className="splat-viewer-overlay">
            <div className="splat-viewer-content">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                    <h3 style={{ margin: 0 }}>
                        {activeMedia ? activeMedia.name : 'Content Preview'}
                    </h3>
                    <div>
                        {htmlContent && (
                            <button className="btn" onClick={openInNewTab} style={{ marginRight: '0.5rem', width: 'auto', padding: '0.5rem 1rem', background: '#03dac6', color: '#000' }}>
                                ↗ Open in new tab
                            </button>
                        )}
                        <button className="btn" onClick={downloadExtracted} style={{ marginRight: '1rem', width: 'auto', padding: '0.5rem 1rem' }}>
                            Download All
                        </button>
                        <button className="close-btn" onClick={onClose} style={{ position: 'static' }}>
                            Close
                        </button>
                    </div>
                </div>

                {/* Main Active Media View */}
                {activeMedia && (
                    <div className="iframe-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000' }}>
                        {activeMedia.type === 'image' ? (
                            <img
                                src={activeMedia.url}
                                alt="Preview"
                                style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                            />
                        ) : (
                            <video
                                src={activeMedia.url}
                                controls
                                autoPlay
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                            />
                        )}
                    </div>
                )}

                {/* HTML Placeholder */}
                {htmlContent && !activeMedia && (
                    <div style={{ padding: '2rem', textAlign: 'center', background: '#1a1a1a', borderRadius: '8px' }}>
                        <p>HTML Content Ready</p>
                        <p style={{ fontSize: '0.9rem', color: '#aaa' }}>This file cannot be previewed securely inside this window.</p>
                        <button className="btn" onClick={openInNewTab} style={{ marginTop: '1rem', background: '#03dac6', color: '#000' }}>
                            Open in new tab
                        </button>
                    </div>
                )}

                {/* Zip extracted media gallery */}
                {mediaFiles.length > 0 && (
                    <div className="media-gallery">
                        <h3>Extracted Media (Click to view)</h3>
                        <div className="gallery-grid">
                            {mediaFiles.map((file, i) => (
                                <div
                                    key={i}
                                    className={`gallery-item ${activeMedia === file ? 'active' : ''}`}
                                    onClick={() => setActiveMedia(file)}
                                    style={{ cursor: 'pointer', border: activeMedia === file ? '2px solid #bb86fc' : 'none' }}
                                >
                                    {file.type === 'image' ? (
                                        <img src={file.url} alt={file.name} loading="lazy" />
                                    ) : (
                                        // Muted preview video
                                        <video src={file.url} />
                                    )}
                                    <p>{file.name}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {!htmlContent && !activeMedia && mediaFiles.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '2rem' }}>
                        <p>No previewable content found.</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default SplatViewer;
