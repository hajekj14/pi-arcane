/**
 * Minimal RFC 6455 client, just enough to drain a log stream.
 *
 * Arcane serves container and project logs only over WebSocket
 * (`/api/environments/{id}/ws/.../logs`) — there is no REST equivalent in the
 * OpenAPI spec. The browser `WebSocket` API cannot set request headers, and the
 * connection has to carry `X-API-Key`, so the handshake is done with
 * `node:https` and the resulting socket is framed by hand.
 *
 * Only what a one-shot read needs is implemented: text/binary data frames,
 * fragmentation, ping/pong and close. Client-sent frames are masked as the spec
 * requires.
 */

import { randomBytes, createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B49";

export interface CollectOptions {
	headers?: Record<string, string>;
	/** Give up after this long overall. */
	timeoutMs?: number;
	/** Stop early once this many messages have arrived. */
	maxMessages?: number;
	/** Stop early once the collected payload exceeds this many bytes. */
	maxBytes?: number;
	/**
	 * Close the socket this long after the last message. Guards against servers
	 * that keep a `follow=false` stream open instead of closing it.
	 */
	idleMs?: number;
	/**
	 * Abort when `Sec-WebSocket-Accept` does not match the key we sent.
	 *
	 * Off by default. Arcane sits behind a proxy that re-keys the handshake and
	 * returns an accept token derived from its own key, so a strict check
	 * rejects a connection that then streams perfectly well. The 101 status and
	 * the `Upgrade: websocket` header already establish that the peer spoke
	 * WebSocket; the token adds little against a server we authenticated to over
	 * TLS with an API key.
	 */
	requireAcceptMatch?: boolean;
	signal?: AbortSignal;
}

export interface CollectResult {
	messages: string[];
	/** True when a limit or timeout cut the stream short. */
	truncated: boolean;
	/** Close code, when the server closed cleanly. */
	closeCode?: number;
	/** True when the handshake token did not match (see `requireAcceptMatch`). */
	acceptMismatch?: boolean;
}

export class WebSocketError extends Error {
	readonly status?: number;
	readonly body?: string;

	constructor(message: string, status?: number, body?: string) {
		super(message);
		this.name = "WebSocketError";
		this.status = status;
		this.body = body;
	}
}

function maskedFrame(opcode: number, payload: Buffer): Buffer {
	const mask = randomBytes(4);
	const length = payload.length;

	let header: Buffer;
	if (length < 126) {
		header = Buffer.alloc(2);
		header[1] = 0x80 | length;
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 0x80 | 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	header[0] = 0x80 | opcode;

	const masked = Buffer.allocUnsafe(length);
	for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4];

	return Buffer.concat([header, mask, masked]);
}

interface ParsedFrame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
	/** Total bytes consumed from the input buffer. */
	size: number;
}

/** Parse one frame off the front of `buffer`, or return undefined if incomplete. */
function parseFrame(buffer: Buffer): ParsedFrame | undefined {
	if (buffer.length < 2) return undefined;

	const fin = (buffer[0] & 0x80) !== 0;
	const opcode = buffer[0] & 0x0f;
	const masked = (buffer[1] & 0x80) !== 0;
	let length = buffer[1] & 0x7f;
	let offset = 2;

	if (length === 126) {
		if (buffer.length < offset + 2) return undefined;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return undefined;
		const big = buffer.readBigUInt64BE(offset);
		if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new WebSocketError("WebSocket frame too large");
		}
		length = Number(big);
		offset += 8;
	}

	let mask: Buffer | undefined;
	if (masked) {
		if (buffer.length < offset + 4) return undefined;
		mask = buffer.subarray(offset, offset + 4);
		offset += 4;
	}

	if (buffer.length < offset + length) return undefined;

	const payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (mask) {
		for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
	}

	return { fin, opcode, payload, size: offset + length };
}

/**
 * Open `url`, collect the messages the server sends, and resolve once it closes
 * or a limit is hit. Intended for `follow=false` streams that terminate on
 * their own; `idleMs` and `timeoutMs` bound the wait either way.
 */
export function collectWebSocketMessages(
	url: string,
	options: CollectOptions = {},
): Promise<CollectResult> {
	const {
		headers = {},
		timeoutMs = 30_000,
		maxMessages = 5000,
		maxBytes = 2 * 1024 * 1024,
		idleMs = 2500,
		requireAcceptMatch = false,
		signal,
	} = options;

	return new Promise<CollectResult>((resolve, reject) => {
		const target = new URL(url);
		const secure = target.protocol === "wss:" || target.protocol === "https:";
		target.protocol = secure ? "https:" : "http:";

		const key = randomBytes(16).toString("base64");
		const expectedAccept = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");

		const messages: string[] = [];
		let bytes = 0;
		let truncated = false;
		let closeCode: number | undefined;
		let acceptMismatch = false;
		let settled = false;
		let socket: Duplex | undefined;
		let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		let fragments: Buffer[] = [];

		let overallTimer: NodeJS.Timeout | undefined;
		let idleTimer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (overallTimer) clearTimeout(overallTimer);
			if (idleTimer) clearTimeout(idleTimer);
			signal?.removeEventListener("abort", onAbort);
			socket?.removeAllListeners();
			socket?.destroy();
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ messages, truncated, closeCode, acceptMismatch });
		};

		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};

		function onAbort() {
			truncated = true;
			finish();
		}

		const bumpIdle = () => {
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				truncated = true;
				finish();
			}, idleMs);
		};

		if (signal?.aborted) {
			resolve({ messages: [], truncated: true });
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		overallTimer = setTimeout(() => {
			truncated = true;
			finish();
		}, timeoutMs);

		const requestFn = secure ? httpsRequest : httpRequest;
		const req: ClientRequest = requestFn(target, {
			headers: {
				...headers,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
			},
		});

		req.on("error", (error) => fail(new WebSocketError(`WebSocket connect failed: ${error.message}`)));

		// A non-101 answer means the handshake was rejected; surface the body.
		req.on("response", (res: IncomingMessage) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => {
				if (chunks.length < 64) chunks.push(chunk);
			});
			res.on("end", () => {
				const body = Buffer.concat(chunks).toString("utf8").slice(0, 2000);
				fail(
					new WebSocketError(
						`WebSocket handshake rejected with HTTP ${res.statusCode}`,
						res.statusCode,
						body,
					),
				);
			});
		});

		req.on("upgrade", (res: IncomingMessage, upgraded: Duplex, head: Buffer) => {
			const accept = res.headers["sec-websocket-accept"];
			if (accept !== expectedAccept) {
				acceptMismatch = true;
				if (requireAcceptMatch) {
					fail(
						new WebSocketError("WebSocket handshake returned an invalid Sec-WebSocket-Accept"),
					);
					return;
				}
			}

			socket = upgraded;
			(socket as Duplex & { setNoDelay?: (on: boolean) => void }).setNoDelay?.(true);
			bumpIdle();

			const closeGracefully = (code: number) => {
				closeCode = code;
				const payload = Buffer.alloc(2);
				payload.writeUInt16BE(1000, 0);
				try {
					socket?.write(maskedFrame(OPCODE_CLOSE, payload));
				} catch {
					// Socket already gone — the result is still valid.
				}
				finish();
			};

			const onData = (chunk: Buffer) => {
				if (settled) return;
				buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);

				for (;;) {
					let frame: ParsedFrame | undefined;
					try {
						frame = parseFrame(buffer);
					} catch (error) {
						fail(error as Error);
						return;
					}
					if (!frame) return;
					buffer = buffer.subarray(frame.size);

					switch (frame.opcode) {
						case OPCODE_PING:
							try {
								socket?.write(maskedFrame(OPCODE_PONG, frame.payload));
							} catch {
								// Ignore: a failed pong only matters if the peer then closes.
							}
							break;

						case OPCODE_PONG:
							break;

						case OPCODE_CLOSE: {
							const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
							closeGracefully(code);
							return;
						}

						case OPCODE_TEXT:
						case OPCODE_BINARY:
						case OPCODE_CONTINUATION: {
							if (frame.opcode !== OPCODE_CONTINUATION) fragments = [];
							fragments.push(frame.payload);

							if (!frame.fin) break;

							const text = Buffer.concat(fragments).toString("utf8");
							fragments = [];

							messages.push(text);
							bytes += Buffer.byteLength(text, "utf8");
							bumpIdle();

							if (messages.length >= maxMessages || bytes >= maxBytes) {
								truncated = true;
								closeGracefully(1000);
								return;
							}
							break;
						}

						default:
							// Unknown opcode: ignore rather than tear down a working stream.
							break;
					}
				}
			};

			socket.on("data", onData);
			socket.on("end", () => finish());
			socket.on("close", () => finish());
			socket.on("error", (error: Error) => {
				// A reset after the server has already sent everything is common;
				// keep whatever was collected.
				if (messages.length > 0) finish();
				else fail(new WebSocketError(`WebSocket error: ${error.message}`));
			});

			if (head && head.length > 0) onData(head);
		});

		req.end();
	});
}
