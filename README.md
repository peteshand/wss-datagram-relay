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

## Nginx TLS termination

When an existing Nginx server owns the public certificate, let Nginx terminate
TLS and run this process on loopback HTTP only. This mode refuses a non-loopback
bind, so Node cannot accidentally be exposed without TLS:

```bash
npm run start -- \
  --http --host 127.0.0.1 --port 8443 \
  --build-id <served-webassembly-build-id> \
  --origin https://game.example.com
```

The Nginx virtual host needs a WebSocket location. Replace the hostname and
the build ID/origin with your deployment values; do not strip the `Origin`
header because the relay validates it.

```nginx
location /relay {
    proxy_pass http://127.0.0.1:8443;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header Origin $http_origin;
    proxy_buffering off;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
}
```

The browser endpoint is then `wss://game.example.com/relay`; include it as
the URL-encoded `ueRelay` value. Nginx should be the only public listener;
do not open port 8443 in the firewall.

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
