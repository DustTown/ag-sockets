import { EventEmitter } from 'events';

export interface UwsServerConfig {
	port: number;
	host?: string;
	/** key and certificate files, plain http if not specified (e.g. behind a proxy) */
	ssl?: { key_file_name: string; cert_file_name: string; passphrase?: string; };
	/** bytes that may wait in the send queue of one socket before uWebSockets starts dropping messages */
	maxBackpressure?: number;
	/** seconds of silence after which uWebSockets closes the socket, 0 disables */
	idleTimeout?: number;
}

interface UwsServerOptions {
	path?: string;
	maxPayload?: number;
	perMessageDeflate?: boolean;
	verifyClient?: (info: { req: any; }, next: (result: any, code: number, name: string) => void) => void;
}

const DEFAULT_MAX_PAYLOAD = 16 * 1024 * 1024;
const DEFAULT_MAX_BACKPRESSURE = 16 * 1024 * 1024;
const TERMINATE_TIMEOUT = 1000;

export class UwsSocket extends EventEmitter {
	closed = false;
	upgradeReq: any;
	_socket: { remoteAddress: string; };

	constructor(public socket: any, request: any) {
		super();
		this.upgradeReq = request;
		this._socket = { remoteAddress: request.remoteAddress };
	}
	get bufferedAmount() {
		return this.closed ? 0 : this.socket.getBufferedAmount();
	}
	send(data: string | Uint8Array | Buffer, _options?: any) {
		if (this.closed) return;

		if (typeof data === 'string') {
			this.socket.send(data, false);
		} else {
			this.socket.send(data, true);
		}
	}
	close(code = 1000, reason = '') {
		if (this.closed) return;
		this.socket.end(code, reason);
	}
	// ws drops the connection right away, but closing a uWebSockets socket this way also throws away the queued
	// messages (and the handshake response when called from the connection handler), so the close frame goes
	// after the queue first and the connection is dropped for good a moment later in case the other side is stuck
	terminate() {
		if (this.closed) return;

		this.socket.end(1000);
		setTimeout(() => !this.closed && this.socket.close(), TERMINATE_TIMEOUT).unref();
	}
}

// uWebSockets.js takes a port itself and cannot work on top of an http server, so it is created per
// listening port (see createUwsServer) and has the interface of ws.Server that the rest of the library uses
export class UwsServer extends EventEmitter {
	listenSocket: any;
	port = 0;
	sockets = new Set<UwsSocket>();

	constructor(options: UwsServerOptions, private uWS: any, config: UwsServerConfig) {
		super();

		const { path = '/ws', maxPayload = DEFAULT_MAX_PAYLOAD, perMessageDeflate = false, verifyClient } = options;
		const app = config.ssl ? this.uWS.SSLApp(config.ssl) : this.uWS.App();

		app.ws(path, {
			compression: perMessageDeflate ? this.uWS.SHARED_COMPRESSOR : this.uWS.DISABLED,
			maxPayloadLength: maxPayload,
			maxBackpressure: config.maxBackpressure ?? DEFAULT_MAX_BACKPRESSURE,
			idleTimeout: config.idleTimeout ?? 120,
			upgrade: (res: any, req: any, context: any) => {
				const query = req.getQuery();
				const headers: { [key: string]: string; } = {};
				req.forEach((key: string, value: string) => headers[key] = value);

				const request = {
					url: req.getUrl() + (query ? `?${query}` : ''),
					method: 'GET',
					headers,
					remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString(),
				};
				const secKey = req.getHeader('sec-websocket-key');
				const protocol = req.getHeader('sec-websocket-protocol');
				const extensions = req.getHeader('sec-websocket-extensions');
				let aborted = false;

				res.onAborted(() => aborted = true);

				const next = (result: any, code: number, name: string) => {
					if (aborted) return;

					res.cork(() => {
						if (result) {
							res.upgrade({ request }, secKey, protocol, extensions, context);
						} else {
							res.writeStatus(`${code} ${name}`).end(name);
						}
					});
				};

				try {
					if (verifyClient) {
						verifyClient({ req: request }, next);
					} else {
						next(true, 200, 'OK');
					}
				} catch (e) {
					this.emit('error', e);
					next(false, 400, 'Bad Request');
				}
			},
			open: (socket: any) => {
				const wrapper = new UwsSocket(socket, socket.getUserData().request);
				socket.getUserData().wrapper = wrapper;
				this.sockets.add(wrapper);
				this.emit('connection', wrapper, wrapper.upgradeReq);
			},
			message: (socket: any, message: ArrayBuffer, isBinary: boolean) => {
				const { wrapper } = socket.getUserData();

				// the message memory is only valid until this handler returns, so it has to be copied
				if (isBinary) {
					wrapper.emit('message', Buffer.from(new Uint8Array(message)), { binary: true });
				} else {
					wrapper.emit('message', Buffer.from(message).toString(), { binary: false });
				}
			},
			close: (socket: any, code: number, message: ArrayBuffer) => {
				const { wrapper } = socket.getUserData();
				wrapper.closed = true;
				this.sockets.delete(wrapper);
				wrapper.emit('close', code, Buffer.from(message).toString());
			},
		});

		const onListen = (listenSocket: any) => {
			if (listenSocket) {
				this.listenSocket = listenSocket;
				this.port = this.uWS.us_socket_local_port(listenSocket);
				// uWebSockets calls this synchronously, before anyone could subscribe to the events
				process.nextTick(() => this.emit('listening'));
			} else {
				process.nextTick(() => this.emit('error', new Error(`Failed to listen on port ${config.port}`)));
			}
		};

		if (config.host) {
			app.listen(config.host, config.port, onListen);
		} else {
			app.listen(config.port, onListen);
		}
	}
	handleUpgrade() {
		throw new Error('uWebSockets server listens on its own port and cannot upgrade requests of another server');
	}
	close() {
		if (this.listenSocket) {
			this.uWS.us_listen_socket_close(this.listenSocket);
			this.listenSocket = undefined;
		}

		this.sockets.forEach(socket => socket.terminate());
	}
}

export type UwsServerClass = new (options: UwsServerOptions) => UwsServer;

export function createUwsServer(uWS: any, config: UwsServerConfig): UwsServerClass {
	return class extends UwsServer {
		constructor(options: UwsServerOptions) {
			super(options, uWS, config);
		}
	};
}
