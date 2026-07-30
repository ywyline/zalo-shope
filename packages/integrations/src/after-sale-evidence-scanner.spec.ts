import { once } from 'node:events';
import { createServer, Socket, type AddressInfo, type Server } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AFTER_SALE_EVIDENCE_SCAN_MAX_BYTES,
  AfterSaleEvidenceScannerError,
  ClamAvAfterSaleEvidenceScanner,
  type ClamAvAfterSaleEvidenceScannerOptions,
} from './after-sale-evidence-scanner';

const NOW = Date.UTC(2026, 6, 29, 0, 0, 0);
const VERSION = '1: ClamAV 1.5.3/27790/Tue Jul 28 12:34:56 2026\0';
const CLEAN = '2: stream: OK\0';

type ScriptedOptions = Readonly<{
  onInstreamCommand?: (socket: Socket) => void;
  onVersionCommand?: (socket: Socket) => void;
  scanResponse?: readonly Buffer[];
  versionResponse?: readonly Buffer[];
}>;

type ConnectionState = {
  buffer: Buffer;
  state: 'END' | 'FRAMES' | 'IDSESSION' | 'INSTREAM' | 'VERSION';
};

class ScriptedClamd {
  public readonly commands: string[] = [];
  public readonly errors: Error[] = [];
  public readonly frameHeaders: Buffer[] = [];
  public readonly frames: Buffer[] = [];
  public readonly sockets = new Set<Socket>();
  public endCount = 0;
  public zeroFrameCount = 0;
  readonly #server: Server;

  private constructor(
    public readonly port: number,
    private readonly options: ScriptedOptions,
    server: Server,
  ) {
    this.#server = server;
  }

  public static async start(options: ScriptedOptions = {}): Promise<ScriptedClamd> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const fake = new ScriptedClamd(address.port, options, server);
    server.on('connection', (socket) => fake.accept(socket));
    activeServers.push(fake);
    return fake;
  }

  public async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.#server.listening) {
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }
  }

  public async waitForNoSockets(): Promise<void> {
    const openSockets = [...this.sockets];
    if (openSockets.length === 0) return;
    await Promise.all(openSockets.map((socket) => once(socket, 'close')));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => this.sockets.delete(socket));
    const state: ConnectionState = { buffer: Buffer.alloc(0), state: 'IDSESSION' };
    socket.on('data', (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      this.process(socket, state);
    });
  }

  private process(socket: Socket, connection: ConnectionState): void {
    while (!socket.destroyed) {
      if (connection.state === 'FRAMES') {
        if (connection.buffer.byteLength < 4) return;
        const header = Buffer.from(connection.buffer.subarray(0, 4));
        const length = header.readUInt32BE(0);
        if (connection.buffer.byteLength < 4 + length) return;
        const frame = Buffer.from(connection.buffer.subarray(4, 4 + length));
        connection.buffer = connection.buffer.subarray(4 + length);
        if (length === 0) {
          this.zeroFrameCount += 1;
          connection.state = 'END';
          this.writeChunks(socket, this.options.scanResponse ?? [Buffer.from(CLEAN)]);
        } else {
          this.frameHeaders.push(header);
          this.frames.push(frame);
        }
        continue;
      }

      const expected =
        connection.state === 'IDSESSION'
          ? Buffer.from('zIDSESSION\0')
          : connection.state === 'VERSION'
            ? Buffer.from('zVERSION\0')
            : connection.state === 'INSTREAM'
              ? Buffer.from('zINSTREAM\0')
              : Buffer.from('zEND\0');
      if (connection.buffer.byteLength < expected.byteLength) {
        if (!expected.subarray(0, connection.buffer.byteLength).equals(connection.buffer)) {
          this.fail(socket, `Unexpected partial ${connection.state} command`);
        }
        return;
      }
      if (!connection.buffer.subarray(0, expected.byteLength).equals(expected)) {
        this.fail(socket, `Unexpected ${connection.state} command`);
        return;
      }
      connection.buffer = connection.buffer.subarray(expected.byteLength);
      this.commands.push(connection.state);

      switch (connection.state) {
        case 'IDSESSION':
          connection.state = 'VERSION';
          break;
        case 'VERSION':
          connection.state = 'INSTREAM';
          if (this.options.onVersionCommand) this.options.onVersionCommand(socket);
          else this.writeChunks(socket, this.options.versionResponse ?? [Buffer.from(VERSION)]);
          break;
        case 'INSTREAM':
          connection.state = 'FRAMES';
          this.options.onInstreamCommand?.(socket);
          break;
        case 'END':
          this.endCount += 1;
          if (connection.buffer.byteLength !== 0) {
            this.fail(socket, 'Trailing client bytes after END');
            return;
          }
          socket.end();
          return;
      }
    }
  }

  private writeChunks(socket: Socket, chunks: readonly Buffer[]): void {
    const write = (index: number) => {
      const chunk = chunks[index];
      if (!chunk || socket.destroyed) return;
      socket.write(chunk);
      if (index + 1 < chunks.length) setImmediate(() => write(index + 1));
    };
    write(0);
  }

  private fail(socket: Socket, message: string): void {
    this.errors.push(new Error(message));
    socket.destroy();
  }
}

const activeServers: ScriptedClamd[] = [];

afterEach(async () => {
  const servers = activeServers.splice(0);
  await Promise.all(servers.map((server) => server.close()));
});

function scanner(
  port: number,
  overrides: Partial<ClamAvAfterSaleEvidenceScannerOptions> = {},
): ClamAvAfterSaleEvidenceScanner {
  return new ClamAvAfterSaleEvidenceScanner({
    host: '127.0.0.1',
    now: () => NOW,
    port,
    responseLimitBytes: 1_024,
    signatureFutureSkewMs: 5 * 60 * 1_000,
    signatureMaxAgeMs: 48 * 60 * 60 * 1_000,
    timeoutMs: 1_000,
    ...overrides,
  });
}

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  await Promise.resolve();
  for (const value of values) yield value;
}

function scan(
  provider: ClamAvAfterSaleEvidenceScanner,
  values: unknown[],
  expectedByteSize = values.reduce<number>(
    (total, value) => total + (value instanceof Uint8Array ? value.byteLength : 0),
    0,
  ),
) {
  return provider.scan({
    body: chunks(...values) as AsyncIterable<Uint8Array>,
    expectedByteSize,
  });
}

function expectScannerError(
  promise: Promise<unknown>,
  code: AfterSaleEvidenceScannerError['code'],
  retryable: boolean,
) {
  return expect(promise).rejects.toMatchObject({ code, retryable });
}

async function expectVersionProtocolError(
  response: Buffer,
  overrides: Partial<ClamAvAfterSaleEvidenceScannerOptions> = {},
): Promise<AfterSaleEvidenceScannerError> {
  const fake = await ScriptedClamd.start({ versionResponse: [response] });
  let received: unknown;
  try {
    await scan(scanner(fake.port, overrides), [Buffer.from('safe')]);
  } catch (error) {
    received = error;
  }
  expect(received).toBeInstanceOf(AfterSaleEvidenceScannerError);
  expect(received).toMatchObject({ code: 'SCANNER_PROTOCOL_ERROR', retryable: false });
  return received as AfterSaleEvidenceScannerError;
}

describe('ClamAV after-sale evidence scanner protocol', () => {
  it('uses one IDSESSION connection and accepts fragmented NUL-terminated responses', async () => {
    const fake = await ScriptedClamd.start({
      scanResponse: [Buffer.from('2: stream:'), Buffer.from(' OK'), Buffer.from([0])],
      versionResponse: [
        Buffer.from('1: ClamAV 1.5.3/'),
        Buffer.from('27790/Tue Jul 28 12:34:56 2026'),
        Buffer.from([0]),
      ],
    });
    const backing = Buffer.from('xpayloady');
    const body = backing.subarray(1, backing.byteLength - 1);

    await expect(
      scan(scanner(fake.port), [body.subarray(0, 2), Buffer.alloc(0), body.subarray(2)]),
    ).resolves.toEqual({
      engine: 'clamav',
      engineVersion: '1.5.3',
      signatureVersion: '27790',
      verdict: 'CLEAN',
    });
    expect(fake.commands).toEqual(['IDSESSION', 'VERSION', 'INSTREAM', 'END']);
    expect(Buffer.concat(fake.frames)).toEqual(body);
    expect(fake.zeroFrameCount).toBe(1);
    expect(fake.endCount).toBe(1);
    expect(fake.errors).toEqual([]);
  });

  it('splits large chunks into 64 KiB network-order INSTREAM frames', async () => {
    const fake = await ScriptedClamd.start();
    const backing = Buffer.alloc(65_539, 7);
    const body = backing.subarray(1, 65_538);

    await expect(scan(scanner(fake.port), [body])).resolves.toMatchObject({ verdict: 'CLEAN' });
    expect(fake.frames.map((frame) => frame.byteLength)).toEqual([65_536, 1]);
    expect(fake.frameHeaders.map((header) => header.toString('hex'))).toEqual([
      '00010000',
      '00000001',
    ]);
    expect(Buffer.concat(fake.frames)).toEqual(body);
    expect(fake.zeroFrameCount).toBe(1);
  });

  it('waits for socket drain before consuming and terminating the input stream', async () => {
    const fake = await ScriptedClamd.start();
    const body = Buffer.from('backpressure');
    const originalWrite = Reflect.get(Socket.prototype, 'write');
    let releaseDrain: (() => void) | undefined;
    let signalForcedWrite: (() => void) | undefined;
    const forcedWrite = new Promise<void>((resolve) => {
      signalForcedWrite = resolve;
    });
    let forced = false;
    const writeSpy = vi.spyOn(Socket.prototype, 'write').mockImplementation(function (
      this: Socket,
      ...args: Parameters<Socket['write']>
    ) {
      const accepted = Reflect.apply(originalWrite, this, args);
      const chunk = args[0];
      if (
        !forced &&
        this.remotePort === fake.port &&
        chunk instanceof Uint8Array &&
        chunk.byteLength === body.byteLength + 4 &&
        Buffer.from(chunk.buffer, chunk.byteOffset, 4).readUInt32BE(0) === body.byteLength
      ) {
        forced = true;
        releaseDrain = () => this.emit('drain');
        signalForcedWrite?.();
        return false;
      }
      return accepted;
    });

    try {
      let settled = false;
      const operation = scan(scanner(fake.port), [body]).finally(() => {
        settled = true;
      });
      await forcedWrite;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      releaseDrain?.();
      await expect(operation).resolves.toMatchObject({ verdict: 'CLEAN' });
      expect(fake.zeroFrameCount).toBe(1);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('returns a stable malicious result without exposing the ClamAV signature', async () => {
    const signature = 'Win.Test.Highly-Sensitive-Signature';
    const fake = await ScriptedClamd.start({
      scanResponse: [Buffer.from(`2: stream: ${signature} FOUND\0`)],
    });

    const result = await scan(scanner(fake.port), [Buffer.from('payload')]);
    expect(result).toEqual({
      code: 'MALWARE_DETECTED',
      engine: 'clamav',
      engineVersion: '1.5.3',
      signatureVersion: '27790',
      verdict: 'MALICIOUS',
    });
    expect(JSON.stringify(result)).not.toContain(signature);
  });

  it('fails closed for short, long and non-byte streams without terminating INSTREAM', async () => {
    for (const testCase of [
      { expected: 4, values: [Buffer.from('abc')] },
      { expected: 2, values: [Buffer.from('abc')] },
      { expected: 0, values: ['sensitive non-byte value'] },
    ]) {
      const fake = await ScriptedClamd.start();
      const operation = scan(scanner(fake.port), testCase.values, testCase.expected);
      await expectScannerError(operation, 'SCANNER_PROTOCOL_ERROR', false);
      expect(fake.zeroFrameCount).toBe(0);
      expect(fake.endCount).toBe(0);
    }
  });

  it('rejects invalid declared sizes and the 50 MiB hard limit before connecting', async () => {
    const fake = await ScriptedClamd.start();
    for (const expectedByteSize of [-1, 1.5, AFTER_SALE_EVIDENCE_SCAN_MAX_BYTES + 1]) {
      await expectScannerError(
        scanner(fake.port).scan({ body: chunks() as AsyncIterable<Uint8Array>, expectedByteSize }),
        'SCANNER_PROTOCOL_ERROR',
        false,
      );
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.sockets.size).toBe(0);
  });

  it('rethrows an input iterable failure unchanged and closes the socket', async () => {
    const fake = await ScriptedClamd.start();
    const sentinel = new Error('sensitive storage stream failure');
    let finalized = false;
    async function* failingBody() {
      await Promise.resolve();
      try {
        yield Buffer.from('ok');
        throw sentinel;
      } finally {
        finalized = true;
      }
    }

    let received: unknown;
    try {
      await scanner(fake.port).scan({ body: failingBody(), expectedByteSize: 2 });
    } catch (error) {
      received = error;
    }
    expect(received).toBe(sentinel);
    expect(finalized).toBe(true);
    await fake.waitForNoSockets();
    expect(fake.sockets.size).toBe(0);
    expect(fake.zeroFrameCount).toBe(0);
  });

  it('rejects wrong IDs, invalid UTF-8, extra frames and response-limit overflow', async () => {
    const responses = [
      Buffer.from('9: ClamAV 1.5.3/27790/Tue Jul 28 12:34:56 2026\0'),
      Buffer.from([0x31, 0x3a, 0x20, 0xc3, 0x28, 0]),
      Buffer.from(`${VERSION}1: unexpected second frame\0`),
      Buffer.alloc(33, 0x78),
    ];
    for (const response of responses) {
      const error = await expectVersionProtocolError(response, { responseLimitBytes: 32 });
      expect(String(error)).not.toContain(response.toString('utf8'));
    }
  });

  it('counts the required terminal NUL within the response byte limit', async () => {
    const exactFrameBytes = Buffer.byteLength(VERSION);
    const accepted = await ScriptedClamd.start();
    await expect(
      scan(scanner(accepted.port, { responseLimitBytes: exactFrameBytes }), [Buffer.from('safe')]),
    ).resolves.toMatchObject({ verdict: 'CLEAN' });

    const rejected = await ScriptedClamd.start();
    await expectScannerError(
      scan(scanner(rejected.port, { responseLimitBytes: exactFrameBytes - 1 }), [
        Buffer.from('safe'),
      ]),
      'SCANNER_PROTOCOL_ERROR',
      false,
    );
  });

  it('classifies a partial response followed by EOF as a protocol error', async () => {
    const raw = '1: ClamAV private upstream response';
    const fake = await ScriptedClamd.start({
      onVersionCommand: (socket) => socket.end(raw),
    });
    let received: unknown;
    try {
      await scan(scanner(fake.port), [Buffer.from('safe')]);
    } catch (error) {
      received = error;
    }
    expect(received).toMatchObject({ code: 'SCANNER_PROTOCOL_ERROR', retryable: false });
    expect(String(received)).not.toContain(raw);
  });

  it('rejects unknown, ERROR and malformed FOUND scan responses without leaking them', async () => {
    for (const raw of [
      '2: stream: scan failed ERROR',
      '2: stream:  FOUND',
      '2: stream: OK ',
      '1: stream: OK',
      '2: stream: unknown',
    ]) {
      const fake = await ScriptedClamd.start({ scanResponse: [Buffer.from(`${raw}\0`)] });
      let received: unknown;
      try {
        await scan(scanner(fake.port), [Buffer.from('safe')]);
      } catch (error) {
        received = error;
      }
      expect(received).toMatchObject({ code: 'SCANNER_PROTOCOL_ERROR', retryable: false });
      expect(String(received)).not.toContain(raw);
    }
  });

  it('rejects invalid UTF-8 and a second NUL frame in the scan response', async () => {
    const responses = [
      Buffer.from([...Buffer.from('2: stream: Secret-'), 0xc3, 0x28, ...Buffer.from(' FOUND\0')]),
      Buffer.from(`${CLEAN}2: stream: Secret FOUND\0`),
    ];
    for (const response of responses) {
      const fake = await ScriptedClamd.start({ scanResponse: [response] });
      let received: unknown;
      try {
        await scan(scanner(fake.port), [Buffer.from('safe')]);
      } catch (error) {
        received = error;
      }
      expect(received).toMatchObject({ code: 'SCANNER_PROTOCOL_ERROR', retryable: false });
      expect(String(received)).not.toContain('Secret');
      expect(fake.endCount).toBe(0);
    }
  });

  it('stops reading input when clamd returns an early protocol error', async () => {
    const fake = await ScriptedClamd.start({
      onInstreamCommand: (socket) => socket.write('2: INSTREAM size limit exceeded. ERROR\0'),
    });
    let pulls = 0;
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            pulls += 1;
            return Promise.resolve({
              done: false as const,
              value: Buffer.from([pulls % 255]),
            });
          },
          return: () => {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };

    await expectScannerError(
      scanner(fake.port).scan({ body, expectedByteSize: 1_000_000 }),
      'SCANNER_PROTOCOL_ERROR',
      false,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    expect(pulls).toBeLessThan(1_000_000);
    expect(fake.zeroFrameCount).toBe(0);
    expect(fake.endCount).toBe(0);
  });
});

describe('ClamAV version freshness and stable failures', () => {
  it('strictly rejects missing databases, malformed ctime, stale and future signatures', async () => {
    const invalidVersions = [
      '1: ClamAV 1.5.3//Tue Jul 28 12:34:56 2026\0',
      '1: ClamAV 1.5.3/0/Tue Jul 28 12:34:56 2026\0',
      '1: ClamAV 1.5.3~custom/27790/Tue Jul 28 12:34:56 2026\0',
      '1: Other 1.5.3/27790/Tue Jul 28 12:34:56 2026\0',
      '1: ClamAV 1.5.3/not-numeric/Tue Jul 28 12:34:56 2026\0',
      '1: ClamAV 1.5.3/27790/Mon Feb 30 12:34:56 2026\0',
      '1: ClamAV 1.5.3/27790/Mon Jul 28 12:34:56 2026\0',
      '1: ClamAV 1.5.3/27790/Mon Jul 20 12:34:56 2026\0',
      '1: ClamAV 1.5.3/27790/Thu Jul 30 12:34:56 2026\0',
    ];
    for (const value of invalidVersions) {
      const error = await expectVersionProtocolError(Buffer.from(value));
      expect(String(error)).not.toContain(value.slice(0, -1));
    }
  });

  it('uses one absolute deadline even while response bytes keep arriving', async () => {
    let interval: NodeJS.Timeout | undefined;
    const fake = await ScriptedClamd.start({
      onVersionCommand: (socket) => {
        interval = setInterval(() => {
          if (!socket.destroyed) socket.write('x');
        }, 5);
      },
    });
    const startedAt = Date.now();
    try {
      await expectScannerError(
        scan(scanner(fake.port, { responseLimitBytes: 1_024, timeoutMs: 80 }), [
          Buffer.from('safe'),
        ]),
        'SCANNER_TIMEOUT',
        true,
      );
    } finally {
      if (interval) clearInterval(interval);
    }
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('applies the absolute deadline to a stalled input iterator and closes it', async () => {
    const fake = await ScriptedClamd.start();
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };

    await expectScannerError(
      scanner(fake.port, { timeoutMs: 80 }).scan({ body, expectedByteSize: 1 }),
      'SCANNER_TIMEOUT',
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    expect([...fake.sockets].every((socket) => socket.destroyed)).toBe(true);
  });

  it('cannot starve the absolute deadline with an infinite sequence of empty chunks', async () => {
    const fake = await ScriptedClamd.start();
    let returned = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false as const, value: Buffer.alloc(0) }),
          return: () => {
            returned = true;
            return Promise.resolve({ done: true as const, value: undefined });
          },
        };
      },
    };

    await expectScannerError(
      scanner(fake.port, { timeoutMs: 80 }).scan({ body, expectedByteSize: 1 }),
      'SCANNER_TIMEOUT',
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    expect(fake.zeroFrameCount).toBe(0);
  });

  it('maps connection refusal and reset-before-response to retryable unavailable errors', async () => {
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const unusedPort = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));

    await expectScannerError(
      scan(scanner(unusedPort, { timeoutMs: 500 }), [Buffer.from('safe')]),
      'SCANNER_UNAVAILABLE',
      true,
    );

    const reset = await ScriptedClamd.start({
      onVersionCommand: (socket) => socket.destroy(),
    });
    await expectScannerError(
      scan(scanner(reset.port), [Buffer.from('safe')]),
      'SCANNER_UNAVAILABLE',
      true,
    );
  });

  it('exposes fixed configuration errors without host or raw option values', () => {
    const secretHost = 'secret host.invalid';
    let received: unknown;
    try {
      scanner(3310, { host: secretHost });
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AfterSaleEvidenceScannerError);
    expect(received).toMatchObject({ code: 'CONFIGURATION', retryable: false });
    expect(String(received)).not.toContain(secretHost);
  });
});
