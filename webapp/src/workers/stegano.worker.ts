import init, {
  hide as wasmHide,
  media_info as wasmMediaInfo,
  supported_output_formats,
  unveil as wasmUnveil,
} from '../pkg/stegano_wasm';

import type {
  HidePayload,
  MediaInfoPayload,
  Phase,
  UnveiledPayload,
  WorkerRequest,
  WorkerResponse,
} from '../lib/protocol';

import { MIME_TYPES } from '../lib/protocol';

/**
 * Minimal structural view of the worker scope. Keeping the DOM lib for the
 * rest of the app is more convenient than pulling in `lib.webworker` here.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

let ready: Promise<unknown> | null = null;

/** The Wasm module is initialized lazily but only once per worker. */
const ensureReady = () => (ready ??= init());

function bytesOf(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

/** Detached copy of the bytes, so the buffer can be transferred. */
function transferable(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function sha256hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function errorPayload(error: unknown) {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const candidate = error as { code?: unknown; message?: unknown; hint?: unknown };
    return {
      code: String(candidate.code ?? 'internal'),
      message: String(candidate.message ?? 'Unexpected error'),
      hint: typeof candidate.hint === 'string' ? candidate.hint : undefined,
    };
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    hint: undefined,
  };
}

async function handleInfo(request: Extract<WorkerRequest, { kind: 'info' }>) {
  const info = wasmMediaInfo(bytesOf(request.carrier), request.hint);
  const payload: MediaInfoPayload = {
    kind: info.kind === 'audio' ? 'audio' : 'image',
    width: info.width,
    height: info.height,
    capacityBytes: info.capacity_bytes,
    isJxl: info.is_jpeg_xl,
  };
  // Wasm objects are not garbage collected, the worker is long lived
  info.free();
  scope.postMessage({ id: request.id, kind: 'info', info: payload });
}

async function handleHide(request: Extract<WorkerRequest, { kind: 'hide' }>) {
  const names = new Array<unknown>();
  const blobs = new Array<unknown>();
  for (const file of request.files) {
    names.push(file.name);
    blobs.push(new Uint8Array(file.data));
  }

  const startedAt = performance.now();
  const result = wasmHide(
    bytesOf(request.carrier),
    request.hint,
    names,
    blobs,
    request.text,
    request.password,
    request.autoscale,
    request.format,
    (phase: string) => {
      scope.postMessage({ id: request.id, kind: 'progress', phase: phase as Phase });
    },
  );

  const bytes = result.bytes;
  const isAudio = result.kind === 'audio';
  const blob = new Blob([transferable(bytes)], {
    // audio carriers are always written as WAV, whatever the requested format
    type: isAudio ? 'audio/wav' : (MIME_TYPES[result.format] ?? 'application/octet-stream'),
  });

  const payload: HidePayload = {
    blob,
    format: result.format,      kind: isAudio ? 'audio' : 'image',
    width: result.width,
    height: result.height,
    capacityBytes: result.capacity_bytes,
    payloadBytes: result.payload_bytes,
    psnr: result.psnr,
    changedRatio: result.changed_ratio,
    maxChannelDelta: result.max_channel_delta,
    verified: result.verified,
    verification: result.verification,
    resized: result.resized,
    elapsedMs: performance.now() - startedAt,
  };

  result.free();
  scope.postMessage({ id: request.id, kind: 'hide', result: payload });
}

async function handleUnveil(request: Extract<WorkerRequest, { kind: 'unveil' }>) {
  const result = wasmUnveil(
    bytesOf(request.carrier),
    request.hint,
    request.password,
  );

  const files: UnveiledPayload[] = [];
  const transfer: Transferable[] = [];

  for (let i = 0; i < result.count; i++) {
    const file = result.files[i] as {
      name: string;
      data: Uint8Array;
      size: number;
      free: () => void;
    };
    const data = transferable(file.data);
    files.push({ name: file.name, data, sha256: await sha256hex(data) });
    transfer.push(data);
    file.free();
  }

  result.free();
  scope.postMessage({ id: request.id, kind: 'unveil', files }, transfer);
}

scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    await ensureReady();

    switch (request.kind) {
      case 'formats':
        scope.postMessage({
          id: request.id,
          kind: 'formats',
          formats: supported_output_formats() as string[],
        });
        break;
      case 'info':
        await handleInfo(request);
        break;
      case 'hide':
        await handleHide(request);
        break;
      case 'unveil':
        await handleUnveil(request);
        break;
    }
  } catch (error) {
    scope.postMessage({ id: request.id, kind: 'error', ...errorPayload(error) });
  }
};

export {};
