# axona.track 🛰️

> Mobile PWA Network Behavior, Role Resilience & Telemetry Observer for the Axona Mesh Protocol.

**Live App**: [https://axona-net.github.io/axona-track/](https://axona-net.github.io/axona-track/)  
**Telemetry Topic**: `#axona-track` (Region: `eagle`)  
**Design Spec**: [`DESIGN.md`](./DESIGN.md)

---

## Overview

`axona.track` is a lightweight, responsive Progressive Web App designed to benchmark, stress-test, and monitor real-world device behavior across the Axona P2P mesh network.

It specifically addresses mobile operating system realities (iOS WebKit and Android Doze background lifecycle management), network handovers, sleep/wake suspension, and role durability.

### Core Capabilities

- **Durable Identity**: Deterministic, human-friendly device slug (`swift-falcon-ios-pwa`) and persistent UUID preserved across reloads and standalone launches.
- **Multi-Tier Lifecycle Monitor**: Hooks `freeze`, `resume`, `pagehide`, `pageshow`, and `visibilitychange` to track state changes.
- **Time-Dilation Drift Watchdog**: High-frequency interval loop measuring actual vs expected clock delta ($\Delta t > 2500\text{ms}$) to detect OS execution pauses even when event loops were frozen.
- **Soft Landing Strategy**: Snapshots active roles (`root`, `backup`, `child`), peer connections, and candidates immediately before freeze, probing socket survivability upon wake and executing fast reconnection.
- **Structured Telemetry**:
  - `heartbeat`: Periodic device, network, battery, and mesh status (25s cadence).
  - `lifecycle`: State transition announcements (`ACTIVE`, `PASSIVE`, `HIDDEN`, `FROZEN`, `RESUMED`, `OFFLINE`).
  - `peer_churn`: WebRTC peer connections, drops, candidate types, and round-trip times.
  - `recovery`: Diagnostic telemetry published immediately following background resumption detailing sleep duration and socket survival.
- **High-Density Dashboard**: Live glassmorphic UI displaying real-time metrics, median RTT, session churn, role counts, hardware profile, and interactive test controls (e.g. simulated freeze).

---

## Development

```bash
# Clone the repository
git clone https://github.com/axona-net/axona-track.git
cd axona-track

# Install dependencies
npm install

# Start local dev server
npm run dev

# Build production PWA bundle
npm run build

# Preview production build locally
npm run preview
```

---

## Protocol Compatibility

- **Kernel**: `@axona/protocol` `v4.99.0`
- **Default Anchor**: Region `eagle` (`wss://bridge.axona.net`)
- **Query Overrides**:
  - `?region=phoenix` — override mesh region
  - `?net=testnet` — route to testnet bridge (`wss://testnet.axona.net`)
  - `?bridge=wss://...` — connect to custom bridge endpoint

---

## License

MIT © Axona Network
