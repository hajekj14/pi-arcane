/**
 * Exercise the hand-rolled WebSocket client against a local server.
 *
 * ws.ts implements RFC 6455 framing by hand, so this covers the cases the
 * Arcane log stream can actually produce: short and extended payload lengths,
 * fragmented messages, interleaved pings, and a clean server close. It also
 * checks that the handshake carries the X-API-Key header and that a rejected
 * handshake surfaces the HTTP status.
 *
 * Run with: node --experimental-strip-types scripts/ws-test.ts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { collectWebSocketMessages, WebSocketError } from "../extension/ws.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B49";

/** Server-to-client frames are unmasked. */
function frame(opcode: number, payload: Buffer, fin = true): Buffer {
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.alloc(2);
		header[1] = payload.length;
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	header[0] = (fin ? 0x80 : 0x00) | opcode;
	return Buffer.concat([header, payload]);
}

function textFrame(text: string): Buffer {
	return frame(0x1, Buffer.from(text, "utf8"));
}

interface TestServer {
	server: Server;
	port: number;
	lastHeaders: Record<string, string | string[] | undefined>;
}

async function startServer(
	onUpgrade: (socket: Duplex) => void,
	rejectWith?: number,
	/** Return a bogus accept token, as a re-keying proxy does. */
	mangleAccept = false,
): Promise<TestServer> {
	const state: TestServer = { server: undefined as never, port: 0, lastHeaders: {} };

	const server = createServer((_req, res) => {
		res.statusCode = 426;
		res.end("upgrade required");
	});

	server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
		state.lastHeaders = req.headers;

		if (rejectWith) {
			const body = '{"success":false,"data":{"error":"Authentication required"}}';
			socket.write(
				[
					`HTTP/1.1 ${rejectWith} Unauthorized`,
					"Content-Type: application/json",
					`Content-Length: ${Buffer.byteLength(body)}`,
					"Connection: close",
					"",
					body,
				].join("\r\n"),
			);
			socket.end();
			return;
		}

		const key = req.headers["sec-websocket-key"] as string;
		const accept = mangleAccept
			? createHash("sha1").update(`different-key${WS_GUID}`).digest("base64")
			: createHash("sha1")
					.update(key + WS_GUID)
					.digest("base64");
		socket.write(
			[
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${accept}`,
				"\r\n",
			].join("\r\n"),
		);
		onUpgrade(socket);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	state.server = server;
	state.port = (server.address() as { port: number }).port;
	return state;
}

// --- 1. Mixed frame sizes, fragmentation, ping, clean close -----------------
{
	// 300 bytes forces the 16-bit extended length path.
	const long = "L".repeat(300);

	const test = await startServer((socket) => {
		socket.write(textFrame("first line\n"));
		socket.write(frame(0x1, Buffer.from(long), true));
		// Fragmented message: text(fin=0) + continuation(fin=1).
		socket.write(frame(0x1, Buffer.from("frag-part-1|"), false));
		socket.write(frame(0x9, Buffer.from("ping"))); // control frame mid-fragment
		socket.write(frame(0x0, Buffer.from("frag-part-2"), true));
		socket.write(textFrame("last line\n"));
		const close = Buffer.alloc(2);
		close.writeUInt16BE(1000, 0);
		socket.write(frame(0x8, close));
	});

	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		headers: { "X-API-Key": "test-key" },
		timeoutMs: 5000,
	});

	assert.deepEqual(result.messages, [
		"first line\n",
		long,
		"frag-part-1|frag-part-2",
		"last line\n",
	]);
	assert.equal(result.truncated, false);
	assert.equal(result.closeCode, 1000);
	assert.equal(test.lastHeaders["x-api-key"], "test-key", "API key header is sent");
	assert.equal(test.lastHeaders["upgrade"], "websocket");
	test.server.close();
}

// --- 2. 64-bit extended length ---------------------------------------------
{
	const huge = "H".repeat(70_000);
	const test = await startServer((socket) => {
		socket.write(frame(0x1, Buffer.from(huge)));
		const close = Buffer.alloc(2);
		close.writeUInt16BE(1000, 0);
		socket.write(frame(0x8, close));
	});

	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 5000,
	});
	assert.equal(result.messages.length, 1);
	assert.equal(result.messages[0].length, 70_000);
	test.server.close();
}

// --- 3. Server ends without a close frame ----------------------------------
{
	const test = await startServer((socket) => {
		socket.write(textFrame("only line"));
		setTimeout(() => socket.end(), 20);
	});

	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 5000,
	});
	assert.deepEqual(result.messages, ["only line"]);
	test.server.close();
}

// --- 4. Idle timeout when the server never closes --------------------------
{
	const test = await startServer((socket) => {
		socket.write(textFrame("hanging"));
		// then nothing, and never close
	});

	const started = Date.now();
	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 10_000,
		idleMs: 300,
	});
	assert.deepEqual(result.messages, ["hanging"]);
	assert.equal(result.truncated, true, "idle cut-off marks the result truncated");
	assert.ok(Date.now() - started < 5000, "idle timeout fires well before the overall timeout");
	test.server.close();
}

// --- 5. maxMessages stops the stream early ---------------------------------
{
	const test = await startServer((socket) => {
		for (let i = 0; i < 50; i += 1) socket.write(textFrame(`line ${i}\n`));
	});

	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 5000,
		idleMs: 500,
		maxMessages: 10,
	});
	assert.equal(result.messages.length, 10);
	assert.equal(result.truncated, true);
	test.server.close();
}

// --- 6. Rejected handshake surfaces the status -----------------------------
{
	const test = await startServer(() => {}, 401);
	await assert.rejects(
		() => collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, { timeoutMs: 5000 }),
		(error: unknown) => {
			assert.ok(error instanceof WebSocketError);
			assert.equal(error.status, 401);
			return true;
		},
	);
	test.server.close();
}

// --- 7. Abort signal ---------------------------------------------------------
{
	const test = await startServer((socket) => {
		socket.write(textFrame("before abort"));
	});

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 100);
	const result = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 10_000,
		idleMs: 9000,
		signal: controller.signal,
	});
	assert.deepEqual(result.messages, ["before abort"]);
	assert.equal(result.truncated, true);
	test.server.close();
}

// --- 8. Re-keying proxy: mismatched accept ---------------------------------
// Arcane sits behind a proxy that returns an accept token derived from its own
// key. The stream is perfectly usable, so the default must be to carry on and
// report the mismatch — but a caller that asks for strictness still gets it.
{
	const test = await startServer(
		(socket) => {
			socket.write(textFrame("log line from behind a proxy"));
			const close = Buffer.alloc(2);
			close.writeUInt16BE(1000, 0);
			socket.write(frame(0x8, close));
		},
		undefined,
		true,
	);

	const lenient = await collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
		timeoutMs: 5000,
	});
	assert.deepEqual(lenient.messages, ["log line from behind a proxy"]);
	assert.equal(lenient.acceptMismatch, true, "the mismatch is still reported");

	await assert.rejects(
		() =>
			collectWebSocketMessages(`ws://127.0.0.1:${test.port}/logs`, {
				timeoutMs: 5000,
				requireAcceptMatch: true,
			}),
		(error: unknown) => error instanceof WebSocketError,
	);
	test.server.close();
}

console.log(
	"OK — websocket client: framing, fragmentation, limits, close, reject, abort, proxy re-key",
);
