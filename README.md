# Lyra WSS Datagram Relay

This standalone Node.js service relays the complete virtual UDP datagrams used
by Unreal Engine's WebAssembly socket subsystem. It is intentionally small:
it leases an endpoint per browser, scopes broadcast discovery by build and
page path, routes unicast packets, applies bounded queues/rate limits, and
expires silent connections. It does not host gameplay, persist accounts, or
provide EOS/WebRTC/TURN functionality.

## Run

Use a TLS certificate trusted by the browsers that will run Lyra. A public
deployment should set both the exact build ID and the HTTPS origin allowed to
open a relay connection.

```powershell
npm run start -- `
  --cert C:\\certs\\fullchain.pem `
  --key C:\\certs\\privkey.pem `
  --host 0.0.0.0 `
  --port 8443 `
  --build-id <served-webassembly-build-id> `
  --origin https://game.example.com
```

For a local Electron-only test, a password-protected PFX is also accepted via
`--pfx <bundle.pfx> --pfx-passphrase <password>`. The browser harness requires
an explicit development opt-in before it will ignore an untrusted certificate;
never use that option for a public test.

Then add an encoded relay endpoint to the browser game URL:

```text
https://game.example.com/LyraStarterGame.html?...&ueRelay=wss%3A%2F%2Frelay.example.com%3A8443%2F
```

`ueRelay` accepts `wss:` only, except that `ws://localhost` and
`ws://127.0.0.1` are allowed for development. The relay protocol is binary
for game datagrams and JSON only for the initial endpoint lease.

## Verify

```powershell
npm run check
```

The browser-side acceptance harness remains in the Unreal Engine WebAssembly
test tree. It should be configured with a real served build URL and a WSS
relay URL before a two-network run.
