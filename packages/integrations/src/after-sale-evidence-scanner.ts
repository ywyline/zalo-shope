import { Socket } from 'node:net';
import { TextDecoder } from 'node:util';

export const AFTER_SALE_EVIDENCE_SCAN_MAX_BYTES = 50 * 1_024 * 1_024;
export const CLAMAV_INSTREAM_FRAME_MAX_BYTES = 64 * 1_024;

const DEFAULT_SIGNATURE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_LIMIT_BYTES = 64 * 1_024;
const MAX_TIMEOUT_MS = 5 * 60 * 1_000;
const IDSESSION_COMMAND = Buffer.from('zIDSESSION\0', 'ascii');
const VERSION_COMMAND = Buffer.from('zVERSION\0', 'ascii');
const INSTREAM_COMMAND = Buffer.from('zINSTREAM\0', 'ascii');
const END_COMMAND = Buffer.from('zEND\0', 'ascii');
const INSTREAM_END_FRAME = Buffer.alloc(4);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type AfterSaleEvidenceScannerErrorCode =
  'CONFIGURATION' | 'SCANNER_PROTOCOL_ERROR' | 'SCANNER_TIMEOUT' | 'SCANNER_UNAVAILABLE';

const ERROR_MESSAGES: Readonly<Record<AfterSaleEvidenceScannerErrorCode, string>> = {
  CONFIGURATION: 'After-sale evidence scanner configuration is invalid',
  SCANNER_PROTOCOL_ERROR: 'After-sale evidence scanner returned an invalid response',
  SCANNER_TIMEOUT: 'After-sale evidence scanner timed out',
  SCANNER_UNAVAILABLE: 'After-sale evidence scanner is unavailable',
};

export class AfterSaleEvidenceScannerError extends Error {
  public readonly retryable: boolean;

  public constructor(public readonly code: AfterSaleEvidenceScannerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AfterSaleEvidenceScannerError';
    this.retryable = code === 'SCANNER_TIMEOUT' || code === 'SCANNER_UNAVAILABLE';
  }
}

export type AfterSaleEvidenceScanResult =
  | Readonly<{
      engine: 'clamav';
      engineVersion: string;
      signatureVersion: string;
      verdict: 'CLEAN';
    }>
  | Readonly<{
      code: 'MALWARE_DETECTED';
      engine: 'clamav';
      engineVersion: string;
      signatureVersion: string;
      verdict: 'MALICIOUS';
    }>;

export type AfterSaleEvidenceScanInput = Readonly<{
  body: AsyncIterable<Uint8Array>;
  expectedByteSize: number;
}>;

export interface AfterSaleEvidenceScanner {
  scan(input: AfterSaleEvidenceScanInput): Promise<AfterSaleEvidenceScanResult>;
}

export type ClamAvAfterSaleEvidenceScannerOptions = Readonly<{
  host: string;
  now?: () => number;
  port: number;
  responseLimitBytes: number;
  signatureFutureSkewMs?: number;
  signatureMaxAgeMs: number;
  timeoutMs: number;
}>;

type ClamAvIdentity = Readonly<{
  engineVersion: string;
  signatureVersion: string;
}>;

type PendingFrame = {
  reject: (error: AfterSaleEvidenceScannerError) => void;
  resolve: (frame: string) => void;
};

function scannerError(code: AfterSaleEvidenceScannerErrorCode): AfterSaleEvidenceScannerError {
  return new AfterSaleEvidenceScannerError(code);
}

function assertOptions(options: ClamAvAfterSaleEvidenceScannerOptions): void {
  const futureSkew = options.signatureFutureSkewMs ?? DEFAULT_SIGNATURE_FUTURE_SKEW_MS;
  if (
    typeof options.host !== 'string' ||
    options.host.length < 1 ||
    options.host.length > 253 ||
    [...options.host].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f;
    }) ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65_535 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(options.responseLimitBytes) ||
    options.responseLimitBytes < 1 ||
    options.responseLimitBytes > MAX_RESPONSE_LIMIT_BYTES ||
    !Number.isSafeInteger(options.signatureMaxAgeMs) ||
    options.signatureMaxAgeMs < 1 ||
    !Number.isSafeInteger(futureSkew) ||
    futureSkew < 0
  ) {
    throw scannerError('CONFIGURATION');
  }
}

function protocolError(): AfterSaleEvidenceScannerError {
  return scannerError('SCANNER_PROTOCOL_ERROR');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  if (typeof iterator.return !== 'function') return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // Input cleanup is best-effort and must not replace the primary scanner or source error.
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class ClamdSession {
  readonly #failure: Promise<never>;
  readonly #socket = new Socket();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #completed = false;
  #connected = false;
  #endWritten = false;
  #ending = false;
  #frameBuffer = Buffer.alloc(0);
  #pendingFrame: PendingFrame | null = null;
  #rejectFailure!: (error: AfterSaleEvidenceScannerError) => void;
  #resolveClose: (() => void) | null = null;
  #terminalError: AfterSaleEvidenceScannerError | null = null;

  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly responseLimitBytes: number,
    timeoutMs: number,
  ) {
    this.#failure = new Promise<never>((_resolve, reject) => {
      this.#rejectFailure = reject;
    });
    void this.#failure.catch(() => undefined);

    this.#socket.on('data', this.onData);
    this.#socket.on('end', this.onEnd);
    this.#socket.on('error', this.onError);
    this.#socket.on('close', this.onClose);

    this.#timer = setTimeout(() => {
      this.fail(scannerError('SCANNER_TIMEOUT'));
    }, timeoutMs);
    this.#timer.unref();
  }

  public async connect(): Promise<void> {
    const connected = new Promise<void>((resolve) => {
      this.#socket.once('connect', () => {
        this.#connected = true;
        this.#socket.setNoDelay(true);
        resolve();
      });
      try {
        this.#socket.connect({ host: this.host, port: this.port });
      } catch {
        this.fail(scannerError('SCANNER_UNAVAILABLE'));
      }
    });
    await this.race(connected);
  }

  public readFrame(): Promise<string> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#pendingFrame || this.#frameBuffer.byteLength !== 0 || !this.#connected) {
      const error = protocolError();
      this.fail(error);
      return Promise.reject(error);
    }
    return this.race(
      new Promise<string>((resolve, reject) => {
        this.#pendingFrame = { reject, resolve };
      }),
    );
  }

  public async write(bytes: Uint8Array, markEnd = false): Promise<void> {
    if (this.#terminalError) throw this.#terminalError;
    if (!this.#connected || this.#closed || (this.#ending && !markEnd)) {
      const error = scannerError('SCANNER_UNAVAILABLE');
      this.fail(error);
      throw error;
    }

    await this.race(
      new Promise<void>((resolve) => {
        let callbackComplete = false;
        let drainComplete = true;
        const complete = () => {
          if (!callbackComplete || !drainComplete) return;
          if (markEnd) this.#endWritten = true;
          resolve();
        };
        const onDrain = () => {
          drainComplete = true;
          complete();
        };
        try {
          const accepted = this.#socket.write(bytes, (error?: Error | null) => {
            if (error) {
              this.failTransport();
              return;
            }
            callbackComplete = true;
            complete();
          });
          if (!accepted) {
            drainComplete = false;
            this.#socket.once('drain', onDrain);
          }
        } catch {
          this.failTransport();
        }
      }),
    );
  }

  public async exchange(bytes: Uint8Array): Promise<string> {
    const response = this.readFrame();
    const write = this.write(bytes);
    const [, frame] = await Promise.all([write, response]);
    return frame;
  }

  public async finish(): Promise<void> {
    if (this.#terminalError) throw this.#terminalError;
    this.#ending = true;
    await this.write(END_COMMAND, true);

    const closed = this.#closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          this.#resolveClose = resolve;
        });
    try {
      this.#socket.end();
    } catch {
      this.failTransport();
    }
    await this.race(closed);
    this.#completed = true;
    this.cleanup();
  }

  public race<T>(operation: Promise<T>): Promise<T> {
    return Promise.race([operation, this.#failure]);
  }

  public cancel(): void {
    if (this.#completed) return;
    this.#completed = true;
    this.cleanup();
    if (!this.#socket.destroyed) this.#socket.destroy();
  }

  private readonly onData = (chunk: Buffer): void => {
    if (this.#completed || this.#terminalError) return;
    if (!this.#pendingFrame) {
      this.fail(protocolError());
      return;
    }
    this.#frameBuffer = Buffer.concat([this.#frameBuffer, chunk]);
    const terminator = this.#frameBuffer.indexOf(0);
    if (terminator === -1) {
      if (this.#frameBuffer.byteLength >= this.responseLimitBytes) this.fail(protocolError());
      return;
    }
    if (terminator >= this.responseLimitBytes || terminator !== this.#frameBuffer.byteLength - 1) {
      this.fail(protocolError());
      return;
    }

    let frame: string;
    try {
      frame = UTF8_DECODER.decode(this.#frameBuffer.subarray(0, terminator));
    } catch {
      this.fail(protocolError());
      return;
    }
    const pending = this.#pendingFrame;
    this.#pendingFrame = null;
    this.#frameBuffer = Buffer.alloc(0);
    pending.resolve(frame);
  };

  private readonly onEnd = (): void => {
    if (this.#completed || this.#terminalError || this.#ending) return;
    this.failTransport();
  };

  private readonly onError = (): void => {
    if (this.#completed || this.#terminalError) return;
    this.failTransport();
  };

  private readonly onClose = (hadError: boolean): void => {
    this.#closed = true;
    if (this.#completed || this.#terminalError) return;
    if (hadError || !this.#ending || !this.#endWritten) {
      this.failTransport();
      return;
    }
    this.#resolveClose?.();
  };

  private failTransport(): void {
    this.fail(
      this.#frameBuffer.byteLength > 0
        ? scannerError('SCANNER_PROTOCOL_ERROR')
        : scannerError('SCANNER_UNAVAILABLE'),
    );
  }

  private fail(error: AfterSaleEvidenceScannerError): void {
    if (this.#terminalError || this.#completed) return;
    this.#terminalError = error;
    const pending = this.#pendingFrame;
    this.#pendingFrame = null;
    pending?.reject(error);
    this.#rejectFailure(error);
    clearTimeout(this.#timer);
    if (!this.#socket.destroyed) this.#socket.destroy();
  }

  private cleanup(): void {
    clearTimeout(this.#timer);
    this.#resolveClose = null;
    this.#pendingFrame = null;
    this.#socket.removeAllListeners();
  }
}

const CTIME_PATTERN =
  /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):([0-5][0-9]):([0-5][0-9]) ([0-9]{4})$/u;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function parseCtimeUtc(value: string): number | null {
  // clamd ctime has no offset; the scanner deployment contract therefore pins its timezone to UTC.
  const match = CTIME_PATTERN.exec(value);
  if (!match) return null;
  const weekday = match[1];
  const month = MONTHS.indexOf(match[2] as (typeof MONTHS)[number]);
  const day = Number(match[3]);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  const year = Number(match[7]);
  if (year < 1970 || month < 0) return null;

  const timestamp = Date.UTC(year, month, day, hours, minutes, seconds);
  const parsed = new Date(timestamp);
  if (
    !Number.isFinite(timestamp) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hours ||
    parsed.getUTCMinutes() !== minutes ||
    parsed.getUTCSeconds() !== seconds ||
    WEEKDAYS[parsed.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return timestamp;
}

function parseVersion(
  frame: string,
  now: number,
  signatureMaxAgeMs: number,
  signatureFutureSkewMs: number,
): ClamAvIdentity {
  const match = /^1: ClamAV ([0-9A-Za-z][0-9A-Za-z._:+-]{0,63})\/([1-9][0-9]{0,19})\/(.+)$/u.exec(
    frame,
  );
  if (!match) throw protocolError();
  const signatureTimestamp = parseCtimeUtc(match[3] ?? '');
  if (
    signatureTimestamp === null ||
    signatureTimestamp - now > signatureFutureSkewMs ||
    now - signatureTimestamp > signatureMaxAgeMs
  ) {
    throw protocolError();
  }
  return {
    engineVersion: match[1] as string,
    signatureVersion: match[2] as string,
  };
}

function parseScanResult(frame: string, identity: ClamAvIdentity): AfterSaleEvidenceScanResult {
  if (frame === '2: stream: OK') {
    return { engine: 'clamav', ...identity, verdict: 'CLEAN' };
  }
  const prefix = '2: stream: ';
  const suffix = ' FOUND';
  const signature =
    frame.startsWith(prefix) && frame.endsWith(suffix)
      ? frame.slice(prefix.length, -suffix.length)
      : '';
  if (
    signature.length > 0 &&
    signature.trim() === signature &&
    [...signature].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
    })
  ) {
    return {
      code: 'MALWARE_DETECTED',
      engine: 'clamav',
      ...identity,
      verdict: 'MALICIOUS',
    };
  }
  throw protocolError();
}

function instreamFrame(chunk: Uint8Array): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(chunk.byteLength, 0);
  return Buffer.concat([length, Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)]);
}

export class ClamAvAfterSaleEvidenceScanner implements AfterSaleEvidenceScanner {
  readonly #now: () => number;
  readonly #signatureFutureSkewMs: number;

  public constructor(private readonly options: ClamAvAfterSaleEvidenceScannerOptions) {
    assertOptions(options);
    this.#now = options.now ?? Date.now;
    this.#signatureFutureSkewMs = options.signatureFutureSkewMs ?? DEFAULT_SIGNATURE_FUTURE_SKEW_MS;
  }

  public async scan(input: AfterSaleEvidenceScanInput): Promise<AfterSaleEvidenceScanResult> {
    if (
      typeof input !== 'object' ||
      input === null ||
      !Number.isSafeInteger(input.expectedByteSize) ||
      input.expectedByteSize < 0 ||
      input.expectedByteSize > AFTER_SALE_EVIDENCE_SCAN_MAX_BYTES ||
      !isAsyncIterable(input.body)
    ) {
      throw protocolError();
    }

    const iterator = input.body[Symbol.asyncIterator]();
    if (typeof iterator !== 'object' || iterator === null || typeof iterator.next !== 'function') {
      throw protocolError();
    }

    const session = new ClamdSession(
      this.options.host,
      this.options.port,
      this.options.responseLimitBytes,
      this.options.timeoutMs,
    );
    let iteratorCompleted = false;
    let sessionCompleted = false;
    try {
      await session.connect();
      await session.write(IDSESSION_COMMAND);

      const versionFrame = await session.exchange(VERSION_COMMAND);
      let now: number;
      try {
        now = this.#now();
      } catch {
        throw scannerError('CONFIGURATION');
      }
      if (!Number.isSafeInteger(now)) throw scannerError('CONFIGURATION');
      const identity = parseVersion(
        versionFrame,
        now,
        this.options.signatureMaxAgeMs,
        this.#signatureFutureSkewMs,
      );

      await session.write(INSTREAM_COMMAND);
      let byteSize = 0;
      while (true) {
        const next = await session.race(Promise.resolve(iterator.next()));
        if (typeof next !== 'object' || next === null) throw protocolError();
        if (next.done) {
          iteratorCompleted = true;
          break;
        }
        if (!(next.value instanceof Uint8Array)) throw protocolError();
        if (
          next.value.byteLength > input.expectedByteSize - byteSize ||
          next.value.byteLength > AFTER_SALE_EVIDENCE_SCAN_MAX_BYTES - byteSize
        ) {
          throw protocolError();
        }
        byteSize += next.value.byteLength;
        if (next.value.byteLength === 0) {
          await session.race(yieldToEventLoop());
          continue;
        }
        for (
          let offset = 0;
          offset < next.value.byteLength;
          offset += CLAMAV_INSTREAM_FRAME_MAX_BYTES
        ) {
          const frame = next.value.subarray(
            offset,
            Math.min(offset + CLAMAV_INSTREAM_FRAME_MAX_BYTES, next.value.byteLength),
          );
          await session.write(instreamFrame(frame));
          await session.race(yieldToEventLoop());
        }
      }
      if (byteSize !== input.expectedByteSize) throw protocolError();

      const result = parseScanResult(await session.exchange(INSTREAM_END_FRAME), identity);
      await session.finish();
      sessionCompleted = true;
      return result;
    } finally {
      if (!iteratorCompleted) closeIterator(iterator);
      if (!sessionCompleted) session.cancel();
    }
  }
}
