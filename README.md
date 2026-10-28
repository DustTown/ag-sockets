# ag-sockets

TypeScript library for communication over WebSockets

This is fork of [Agamnentzar/ag-sockets](https://github.com/Agamnentzar/ag-sockets). It adds:

- `maxPayload` for the server host and `maxBufferedAmount` for clients that stopped reading (see [Limits](#limits));
- `ws` 8 support: the `isBinary` flag, text messages delivered as buffers and the close reason delivered as a buffer are handled;
- an adapter for [uWebSockets.js](https://github.com/uNetworking/uWebSockets.js) (see [WebSocket implementations](#websocket-implementations));

## Installation

Pick a release on the [releases page](https://github.com/DustTown/ag-sockets/releases) and install its tarball (the sha256 of the file is in the release notes, npm also stores its integrity hash in `package-lock.json`):

```bash
npm install https://github.com/DustTown/ag-sockets/releases/download/v14.1.0-dt.2/ag-sockets-14.1.0-dt.2.tgz
npm install ws # peer dependency
```

Methods are declared with decorators, so `experimentalDecorators` has to be enabled in `tsconfig.json`.

## Usage

### Common interfaces

```typescript
// interfaces.ts

import { SocketClient, SocketServer } from 'ag-sockets';

export interface IExampleClient extends SocketClient {
  message(name: string, message: string): void;
}

export interface IExampleServer extends SocketServer {
  broadcast(message: string): void;
  setName(name: string): void;
}
```

### Client object

```typescript
// client.ts

import { Method } from 'ag-sockets';
import { IExampleClient, IExampleServer } from './interfaces';

export class ExampleClient implements IExampleClient {
  constructor(private server: IExampleServer) {
  }
  
  connected() {
    this.server.setName('John');
    this.server.broadcast('Hello!');
  }
  
  @Method()
  message(name: string, message: string) {
    console.log(`${name}: ${message}`);
  }
}
```

### Server object

```typescript
// server.ts

import { Method, Socket, ClientExtensions } from 'ag-sockets';
import { IExampleClient, IExampleServer } from './interfaces';

const clients: (IExampleClient & ClientExtensions)[] = [];

@Socket({ path: '/test' })
export class ExampleServer implements IExampleServer {
  private name = '';
  
  constructor(private client: IExampleClient & ClientExtensions) {
  }
  
  connected() {
    clients.push(this.client);
  }
  
  disconnected(_code: number, _reason: string) {
    clients.splice(clients.indexOf(this.client), 1);
  }
  
  @Method()
  broadcast(message: string) {
    clients.forEach(c => c.message(this.name, message));
  }
  
  @Method()
  setName(name: string) {
    this.name = name;
  }
}
```

Only methods marked with `@Method()` can be called from the other side. The options of `@Socket` are the [server options](#server-options).

### Start the server

```typescript
import * as http from 'http';
import { createServer } from 'ag-sockets';
import { ExampleClient } from './client';
import { ExampleServer } from './server';

const httpServer = http.createServer();
const socket = createServer(httpServer, ExampleServer, ExampleClient, client => new ExampleServer(client));

// pass socket.options() to the client side, it contains the method lists and the connection settings

httpServer.listen(12345);
```

To run several sockets on one WebSocket server, create a host once and add sockets to it. This is also the way to pass the options that belong to the whole server:

```typescript
import { createServerHost } from 'ag-sockets';

const host = createServerHost(httpServer, {
  path: '/ws',
  perMessageDeflate: false,
  maxPayload: 256 * 1024,
});

const socket = host.socket(ExampleServer, ExampleClient, client => new ExampleServer(client), { /* server options */ });
```

The host options are `path` (`/ws` by default), `perMessageDeflate` (`true` by default), `maxPayload` (the default of the WebSocket library if not set), `errorHandler`, `log`, `ws` (the WebSocket library) and `nativePing`.

### Connect the client

```typescript
import { createClientSocket } from 'ag-sockets';
import { ExampleClient } from './client';
import { IExampleClient, IExampleServer } from './interfaces';

const options = /* socket.options() from the server side */;
const service = createClientSocket<IExampleClient, IExampleServer>(options);

service.client = new ExampleClient(service.server);
service.connect();
```

`createClientSocket(options, token?, errorHandler?, apply?, log?)` returns a service with `client`, `server`, `connect()`, `disconnect()`, `isConnected` and traffic counters. When the connection drops, the client reconnects after `reconnectTimeout` milliseconds.

## Methods

`@Method(options)` accepts:

| Option | Meaning |
|---|---|
| `binary` | binary definition of the arguments, see below; the arguments are sent as JSON without it unless `useBinaryByDefault` is set |
| `promise` | the method returns a promise on the caller side and the other side resolves or rejects it |
| `progress` | name of a field that is `true` while a call of this method is pending |
| `ignore` | do not log this method in debug mode |
| `rateLimit` | limit for calls received by this side, `"1/s"`, `"10/30s"`, `"20/m"` |
| `serverRateLimit` | the rate limit for the server |
| `binaryResult` | send the result of a promise method in binary (`true`) or in JSON (`false`) |

### Binary packets

```typescript
export enum Bin {
  I8, U8, I16, U16, I32, U32, F32, F64, // numbers
  Bool,
  Str,                                  // string
  Obj,                                  // any JSON-like value
  Buffer,                               // ArrayBuffer
  U8Array,                              // Uint8Array
  Raw,                                  // bytes written as they are
  U8ArrayOffsetLength,                  // Uint8Array followed by offset and length arguments: only that part is sent
  DataViewOffsetLength,                 // DataView followed by offset and length arguments: only that part is sent
}
```

The array of types has one item per argument, an array in an item means an array of such values and an object means an object with these fields:

```typescript
class Client {
  @Method({ binary: [Bin.I32, Bin.Str] })
  foo(a: number, b: string) { }
    
  @Method({ binary: [[Bin.I32], [Bin.I32, Bin.I32, Bin.I32]] })
  bar(a: number[], b: [number, number, number][]) { }
    
  @Method({ binary: [[Bin.F32], Bin.Obj] })
  boo(a: number[], b: any) { }
}
```

### Batching

On the server, the calls made to a client between `client.beginBatch()` and `client.commitBatch()` (both are in `ClientExtensions`) are collected and sent as one binary WebSocket message.

## Server options

The options of `@Socket(...)` and of `host.socket(...)`:

| Option | Meaning |
|---|---|
| `id` | name of the socket, the client chooses the socket by it when a host has several |
| `path` | WebSocket path, `/ws` by default |
| `hash` | version string, a client with a different one gets a version message and is disconnected |
| `pingInterval` | how often the server pings clients that have been silent, in ms, `0` disables |
| `connectionTimeout` | the server disconnects a client that sent nothing for this long, in ms |
| `connectionTokens`, `tokenLifetime` | allow one connection per token created by `socket.token(data?)`, and the lifetime of an unused token |
| `clientLimit` | maximum number of connected clients |
| `verifyClient` | `(req) => boolean`, return `false` to reject a connection |
| `createClient` | wrap or extend the client object the server methods receive |
| `forceBinary` | only binary packets and binary connections are allowed |
| `forceBinaryPackets` | only binary encoding is allowed for the packets of methods that have `binary` |
| `useBinaryByDefault`, `useBinaryResultByDefault` | encode packets / results in binary when the method has no `binary` option |
| `keepOriginalRequest` | keep `url` and `headers` of the connection request in `client.originalRequest` |
| `errorIfNotConnected` | throw when the server sends something to a disconnected client |
| `arrayBuffer` | give the server `ArrayBuffer` instead of `Buffer` |
| `onSend`, `onRecv` | `(id, name, size, binary)` callbacks for traffic statistics |
| `transferLimit`, `maxBufferedAmount` | see [Limits](#limits) |
| `debug`, `development` | log debug information / additional errors |

The client options (they come from `socket.options()`) also include `host`, `path`, `ssl`, `reconnectTimeout`, `requestParams`, `clientPingInterval` and `clientConnectionTimeout`.

**Pings are configured separately for the two sides.** `pingInterval` and `connectionTimeout` are for the server only. A client sends pings only when `clientPingInterval` is set (in ms), and it reconnects when it receives nothing for `clientConnectionTimeout`. If you set `connectionTimeout` on the server, set `clientPingInterval` as well, otherwise clients that have nothing to send are disconnected after the timeout.

### Limits

- `maxPayload` (host option): the largest message in bytes, a bigger one closes the connection. With `ws` this includes messages that arrive in fragments.
- `transferLimit`: bytes per second a client may send, a client that exceeds it is disconnected.
- `maxBufferedAmount`: bytes waiting to be sent to one client. The server checks it after every send and on every ping, and disconnects a client above the limit with the reason `send buffer overflow`. It protects the server memory from clients that stopped reading. It needs a WebSocket implementation with `bufferedAmount` (`ws` and the uWebSockets.js adapter have it).
- `clientLimit` and the `rateLimit` of methods.

## WebSocket implementations

The server uses `ws` by default. The `ws` option of the host and of the socket takes another implementation with the same interface (an object with a `Server` class).

### uWebSockets.js

uWebSockets.js cannot work on top of a Node `http.Server`, it opens a port by itself. `createUwsServer` returns a class with the interface of `ws.Server` bound to a port:

```typescript
import { createServerHost, createUwsServer } from 'ag-sockets';

const uWS = require('uWebSockets.js');
const UwsServer = createUwsServer(uWS, { port: 9090, host: '127.0.0.1' });

// no http server: the adapter listens on its own port
const host = createServerHost(undefined, { path: '/ws', ws: { Server: UwsServer } });
```

Options of the adapter: `port`, `host`, `ssl` (`{ key_file_name, cert_file_name, passphrase? }`, plain HTTP without it), `maxBackpressure` (bytes queued for one socket before uWebSockets starts dropping messages, 16 MB by default) and `idleTimeout` (seconds, 120 by default).

Things to know:

- `verifyClient`, `maxPayload`, `perMessageDeflate` and `maxBufferedAmount` work. `handleUpgrade` and `nativePing` are not supported.
- `terminate()` closes the socket after the queued messages have been sent (so a client rejected by its version still gets the version message) and drops the connection a second later.

## Development

```bash
npm run build                                        # compile to dist/
npx mocha --timeout 10000 -R dot --exit dist/test    # tests
npm run lint                                         # tslint
```

The tests of the uWebSockets.js adapter need a Node version supported by the installed uWebSockets.js build and are skipped otherwise. Use `--exit`: some tests leave open handles and mocha does not exit without it.

### Release

1. Change the version: `npm version <version> --no-git-tag-version` (for example `14.1.0-dt.3`) and commit it.
2. Tag the commit with `v<version>` and push the tag.
3. The `Release` workflow checks that the tag matches `package.json`, builds, runs the tests, packs the package and creates a GitHub release with the tarball and its sha256. Tags with a `-` are marked as pre-releases.

## License

MIT. The copyright of the original library belongs to its author, see `LICENSE`.
