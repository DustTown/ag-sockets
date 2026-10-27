import { expect } from 'chai';
import * as WebSocket from 'ws';
import { delay } from './common';
import { Bin, ClientOptions } from '../interfaces';
import { Socket, Method, ClientExtensions, SocketClient, SocketServer, createClientSocket, createUwsServer } from '../index';
import { ServerHost, ServerOptions } from '../serverInterfaces';
import { createServerHost } from '../serverSocket';

const PORT = 12399;

let disconnects: { code: number; reason: string; }[] = [];
let live: (Client & ClientExtensions)[] = [];

@Socket({ path: '/ws', development: true })
class Server implements SocketServer {
	constructor(public client: Client & ClientExtensions) { }
	@Method({ promise: true })
	echo(message: string) {
		return Promise.resolve(message);
	}
	connected() {
		live.push(this.client);
	}
	disconnected(code: number, reason: string) {
		live = live.filter(c => c !== this.client);
		disconnects.push({ code, reason });
	}
}

class Client implements SocketClient {
	@Method({ binary: [[Bin.F32]] })
	chunk(_values: number[]) { }
}

describe('uWebSockets.js server', function () {
	let uWS: any;
	let serverHost: ServerHost;
	let wsServer: any;

	before(function () {
		try {
			uWS = require('uWebSockets.js');
		} catch {
			this.skip(); // the library only has builds for the newest node versions
		}
	});

	function start(options: ServerOptions = {}) {
		const UwsServer = createUwsServer(uWS, { port: PORT, host: '127.0.0.1' });
		serverHost = createServerHost(undefined, { path: '/ws', ws: { Server: class extends UwsServer { constructor(o: any) { super(o); wsServer = this; } } } });
		const socket = serverHost.socket(Server, Client, c => new Server(c), options);
		return new Promise<ClientOptions>(resolve => wsServer.on('listening', () => resolve(socket.options())));
	}

	beforeEach(() => {
		disconnects = [];
		live = [];
		(global as any).window = { addEventListener() { }, removeEventListener() { } };
		(global as any).location = { protocol: 'http', host: `127.0.0.1:${PORT}` };
		(global as any).WebSocket = WebSocket;
	});

	afterEach(() => {
		serverHost && serverHost.close();
	});

	it('answers server calls of a client', async () => {
		const clientOptions = await start();
		const service = createClientSocket<any, any>({ ...clientOptions, host: `127.0.0.1:${PORT}` });
		const connected = new Promise<void>(resolve => service.client = { connected: resolve });
		service.connect();
		await connected;

		try {
			expect(await service.server.echo('hello')).equal('hello');
		} finally {
			service.disconnect();
		}
	});

	it('rejects a client that does not pass verifyClient', async () => {
		await start({ verifyClient: () => false });

		const status = await new Promise<number>(resolve => {
			const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
			socket.on('unexpected-response', (_req, res) => resolve(res.statusCode as number));
			socket.on('error', () => { });
		});

		expect(status).equal(400);
	});

	it('delivers the version message to a client with a different version before disconnecting it', async () => {
		await start({ hash: '1' });

		const received: any[] = [];
		await new Promise<void>(resolve => {
			const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?bin=true&hash=2`);
			socket.on('message', (data, isBinary) => received.push({ isBinary, text: data.toString() }));
			socket.on('close', () => resolve());
			socket.on('error', () => resolve());
		});

		expect(received).length(1);
		expect(JSON.parse(received[0].text)[3]).equal('1');
	});

	it('disconnects a client that stopped reading when the send queue exceeds the limit', async () => {
		await start({ maxBufferedAmount: 500000, hash: '1' });

		const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?bin=true&hash=1`);
		socket.on('error', () => { });
		await new Promise(resolve => socket.on('open', resolve));
		(socket as any)._socket.pause();
		await delay(50);

		const values = Array.from({ length: 25000 }, (_, i) => i);
		const interval = setInterval(() => {
			for (const client of live) client.chunk(values);
		}, 5);

		try {
			const start = Date.now();
			while (!disconnects.length && Date.now() - start < 5000) await delay(20);
		} finally {
			clearInterval(interval);
			socket.terminate();
		}

		expect(disconnects.map(d => d.reason)).eql(['send buffer overflow']);
	});
});
