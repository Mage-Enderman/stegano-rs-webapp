import type {
  EmbeddingDepth,
  HidePayload,
  MediaInfoPayload,
  Phase,
  UnveiledPayload,
  WorkerRequestBody,
  WorkerResponse,
} from './protocol';

/** An error thrown by the Wasm core, with a stable machine readable code. */
export class SteganoError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'SteganoError';
    this.code = code;
    this.hint = hint;
  }
}

export interface HideOptions {
  carrier: File;
  files: File[];
  text: string;
  password: string;
  autoscale: boolean;
  format: string;
  /** payload bits per color channel, the capacity/quality dial */
  depth: EmbeddingDepth;
  onPhase?: (phase: Phase) => void;
}

interface Pending {
  resolve: (response: WorkerResponse) => void;
  reject: (error: unknown) => void;
  onPhase?: (phase: Phase) => void;
}

class SteganoClient {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/stegano.worker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.handle(event.data);
      this.worker.onerror = (event) => {
        for (const [, entry] of this.pending) {
          entry.reject(new SteganoError('internal', event.message || 'worker crashed'));
        }
        this.pending.clear();
      };
    }
    return this.worker;
  }

  private handle(response: WorkerResponse) {
    const entry = this.pending.get(response.id);
    if (!entry) return;

    if (response.kind === 'progress') {
      entry.onPhase?.(response.phase);
      return;
    }

    this.pending.delete(response.id);

    if (response.kind === 'error') {
      entry.reject(new SteganoError(response.code, response.message, response.hint));
      return;
    }

    entry.resolve(response);
  }

  private send(
    body: WorkerRequestBody,
    transfer: Transferable[] = [],
    onPhase?: (phase: Phase) => void,
  ): Promise<WorkerResponse> {
    const worker = this.ensureWorker();
    const id = ++this.sequence;

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onPhase });
      worker.postMessage({ ...body, id }, transfer);
    });
  }

  /** Output formats the current build can write. */
  async formats(): Promise<string[]> {
    const response = await this.send({ kind: 'formats' });
    return response.kind === 'formats' ? response.formats : ['png', 'webp'];
  }

  /**
   * Reads dimensions and capacity of a carrier file.
   *
   * The capacity depends on the embedding depth, so the depth the user has
   * selected has to be passed in for the meter to be exact.
   */
  async info(file: File, depth: EmbeddingDepth): Promise<MediaInfoPayload> {
    const carrier = await file.arrayBuffer();
    const response = await this.send(
      { kind: 'info', carrier, hint: file.name, depth },
      [carrier],
    );
    if (response.kind !== 'info') throw new SteganoError('internal', 'unexpected response');
    return response.info;
  }

  async hide(options: HideOptions): Promise<HidePayload> {
    const carrier = await options.carrier.arrayBuffer();
    const payloads = await Promise.all(
      options.files.map(async (file) => ({
        name: file.name,
        data: await file.arrayBuffer(),
      })),
    );

    const transfer: Transferable[] = [carrier, ...payloads.map((p) => p.data)];

    const response = await this.send(
      {
        kind: 'hide',
        carrier,
        hint: options.carrier.name,
        files: payloads,
        text: options.text,
        password: options.password,
        autoscale: options.autoscale,
        format: options.format,
        depth: options.depth,
      },
      transfer,
      options.onPhase,
    );

    if (response.kind !== 'hide') throw new SteganoError('internal', 'unexpected response');
    return response.result;
  }

  async unveil(file: File, password: string): Promise<UnveiledPayload[]> {
    const carrier = await file.arrayBuffer();
    const response = await this.send(
      { kind: 'unveil', carrier, hint: file.name, password },
      [carrier],
    );

    if (response.kind !== 'unveil') throw new SteganoError('internal', 'unexpected response');
    return response.files;
  }
}

export const stegano = new SteganoClient();
