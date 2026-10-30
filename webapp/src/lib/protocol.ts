/** Phases a hide operation goes through, reported for progress feedback. */
export type Phase = 'decode' | 'resize' | 'embed' | 'verify';

export type MediaKind = 'image' | 'audio';

export interface FilePayload {
  name: string;
  data: ArrayBuffer;
}

/**
 * How many payload bits are stored in every used color channel.
 *
 * `1` is the invisible least significant bit embed, deeper values are a
 * capacity/quality trade off.
 */
export type EmbeddingDepth = 1 | 2 | 4;

export const EMBEDDING_DEPTH_OPTIONS: { value: EmbeddingDepth; label: string }[] = [
  { value: 1, label: 'Invisible — 1 bit per channel' },
  { value: 2, label: 'Dense — 2 bits per channel (2× capacity)' },
  { value: 4, label: 'Maximum — 4 bits per channel (4× capacity)' },
];

export type WorkerRequestBody =
  | { kind: 'formats' }
  | { kind: 'info'; carrier: ArrayBuffer; hint: string; depth: EmbeddingDepth }
  | {
      kind: 'hide';
      carrier: ArrayBuffer;
      hint: string;
      files: FilePayload[];
      text: string;
      password: string;
      autoscale: boolean;
      format: string;
      depth: EmbeddingDepth;
    }
  | { kind: 'unveil'; carrier: ArrayBuffer; hint: string; password: string };

export type WorkerRequest = WorkerRequestBody & { id: number };

export interface MediaInfoPayload {
  kind: MediaKind;
  width?: number;
  height?: number;
  capacityBytes: number;
  isJxl: boolean;
}

export interface HidePayload {
  blob: Blob;
  format: string;
  kind: MediaKind;
  width?: number;
  height?: number;
  capacityBytes: number;
  payloadBytes: number;
  /** payload bits per color channel the carrier was embedded with */
  depth: number;
  psnr?: number;
  changedRatio?: number;
  maxChannelDelta?: number;
  verified: boolean;
  verification: string;
  resized: boolean;
  elapsedMs: number;
}

export interface UnveiledPayload {
  name: string;
  data: ArrayBuffer;
  sha256: string;
}

export type WorkerResponse =
  | { id: number; kind: 'progress'; phase: Phase }
  | { id: number; kind: 'info'; info: MediaInfoPayload }
  | { id: number; kind: 'hide'; result: HidePayload }
  | { id: number; kind: 'unveil'; files: UnveiledPayload[] }
  | { id: number; kind: 'formats'; formats: string[] }
  | { id: number; kind: 'error'; code: string; message: string; hint?: string };

export const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jxl: 'image/jxl',
  wav: 'audio/wav',
};

export const FORMAT_LABELS: Record<string, string> = {
  png: 'PNG (lossless)',
  webp: 'WebP (lossless)',
  jxl: 'JPEG XL (lossless)',
};
