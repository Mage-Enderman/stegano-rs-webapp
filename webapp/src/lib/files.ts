export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function baseName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

export function suggestionFor(carrierName: string, extension: string): string {
  return `${baseName(carrierName)}_stego.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Shortens a long hash for display while keeping the ends recognizable. */
export function shortenHash(hash: string, length = 16): string {
  return hash.length <= length * 2
    ? hash
    : `${hash.slice(0, length)}…${hash.slice(-length)}`;
}

export function errorMessage(error: unknown): { message: string; hint?: string } {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; hint?: unknown };
    return {
      message: String(candidate.message ?? error),
      hint: typeof candidate.hint === 'string' ? candidate.hint : undefined,
    };
  }
  return { message: String(error) };
}
