# Mobile Device Testing Run Card: axona.track v0.3.0
**Target**: Mobile PWA Network Behavior, Role Relinquishment & Connection Scaling  
**Protocol Version**: `@axona/protocol#v4.99.0`  
**Anchor Region**: `eagle` (0x89) | **Bridge**: `wss://bridge.axona.net`  
**Author / Scribe**: Orion (Council Scribe & Technical Reviewer)  
**Date**: 2026-09-29  

---

## 1. Objective & Target Devices
This procedure guides operators and testers in executing structured field evaluations of `axona.track` across mobile operating systems and device form factors. The resulting empirical telemetry feeds into `#axona-track` and is indexed in real-time by the Council Telemetry & Device QoS Analyzer.

### Target Cohorts
1. **iOS Safari (Tab)**: iPhone / iPad running Safari in a standard browser tab.
2. **iOS Standalone PWA**: iPhone / iPad running `axona.track` added to Home Screen.
3. **Android Chrome (Tab)**: Android mobile device running Chrome in a standard tab.
4. **Android Standalone PWA**: Android mobile device running `axona.track` installed as a WebAPK / PWA.
5. **Desktop Browser / PWA (Control Baseline)**: macOS / Windows / Linux Chrome or Safari.

---

## 2. Test Procedure: Step-by-Step Field Walkthrough

### Phase 1: Environment Check & Initial Ingress
1. Open the application URL in your mobile browser.
2. **Verify Environment Header Badge**:
   - Confirm the badge displays **`⚡ PROD`** (or `🧪 TESTNET` if pointed to testnet).
   - Confirm Bridge status indicates **`Open (wss://bridge.axona.net)`**.
3. **Baseline Soak (2 to 3 minutes)**:
   - Leave the device unlocked with the app in the foreground.
   - Observe the **Direct Mesh Peers** counter:
     * Directly connected WebRTC peers will climb (typically 4–12 direct channels depending on neighborhood).
     * Bridge status remains open.
   - Verify periodic telemetry emission: the status badge pulses every 30s as heartbeats are dispatched.

---

### Phase 2: In-Browser Tab Inactivity (1 to 2 minutes)
1. Without closing the browser, open a new browser tab and navigate to any webpage (e.g. news or search).
2. Remain on the second tab for **60 seconds**.
3. Return to the `axona.track` tab.
4. **What to Observe**:
   - Check the **Active Connections** log:
     * Did the browser drop direct WebRTC DataChannels during tab dormancy?
     * How quickly did the app recover direct peer channels upon tab re-focus?
   - Note whether median RTT spiked during re-activation.

---

### Phase 3: Native App Switching & OS Background Suspension (2 to 5 minutes)
Mobile operating systems enforce aggressive timer throttling, process freezing, and socket termination when web apps lose focus.
1. From `axona.track`, switch directly to another native mobile app (e.g. Messages, Camera, or Settings).
2. Keep the app in the background for **1 minute** (Short Tier).
3. Return to `axona.track`.
4. Observe the **Post-Wake Reconciliation** banner:
   - Look for the notification: `Post-wake recovery: X peers retained, Y reconnected in Z ms`.
5. Repeat the test with a longer suspension window:
   - Switch away to a heavy native app (e.g. Camera or Maps) for **3 to 5 minutes** (Extended Tier).
   - Return and observe if the session survived or triggered a cold transport reconnect.

---

### Phase 4: Adaptation Lab Live Study Execution
1. Scroll down and open the **Adaptation Lab** drawer.
2. **Enable Live Mode**:
   - Locate the mode switch at the top of the lab card.
   - Switch from `Offline Mock` to **`Live Study`**.
   - Confirm the amber indicator highlights `Live Study (Actual Network Telemetry)`.
3. **Execute Test Suite**:
   - **Test 1: Role Relinquish Handoff Simulation**
     * Tap `Run Test 1`. Evaluates the pre-freeze handoff pathway and records fallback channel activation.
   - **Test 2: Tiered Grace Period & Eviction Profiler**
     * Tap `Run Test 2`. Evaluates cache retention against the actual baseline snapshot captured prior to your backgrounding tests.
   - **Test 3: Fast-Path Reconnection Probing**
     * Tap `Run Test 3`. Sends clamped ($N \le 3$) non-blocking pings across direct WebRTC peers to evaluate responsive channel availability.
   - **Test 4: Dynamic Bandwidth & Backpressure Governor**
     * Tap `Run Test 4`. Verifies telemetry priority queues and throttling under churn.
   - **Test 5: Dynamic Mesh Scaling & Connection Set Stress Test**
     * Tap `Run Test 5`.
     * The app dynamically cycles peer limits: bounded baseline (4–8) $\to$ peak stress (12–16) $\to$ scale-down recovery.
     * Samples active WebRTC channels, median/P95 RTT shifts, event-loop timer lag drift, and battery drain percentage.
     * The run automatically restores the original mesh cap upon completion.

---

### Phase 5: Session Audit & Data Export
1. Tap the **`Export Sanitized Session`** button in the lab drawer.
2. A JSON diagnostic report will be generated and saved to your device.
3. Verify that the report contains:
   - Redacted 8-character peer IDs (e.g. `80b512a9…`).
   - Recorded lifecycle transitions (`active` $\to$ `passive` $\to$ `active`).
   - Completed lab test summaries.
   - Zero hardware concurrency, RAM, or unredacted device fingerprints.

---

### Phase 6: Standalone PWA Mode Comparison
1. Install `axona.track` as a Progressive Web App:
   - **iOS Safari**: Tap the Share icon $\to$ `Add to Home Screen`.
   - **Android Chrome**: Tap the menu icon $\to$ `Install App` or `Add to Home screen`.
2. Launch `axona.track` from your home screen.
3. Verify the **PWA Badge** displays `Standalone PWA`.
4. Re-run Phases 2 and 3: observe whether the OS grants the standalone PWA greater background execution persistence than standard browser tabs.

---

## 3. Telemetry Verification & Council Analyzer Inspection
All telemetry generated during field testing is automatically broadcast to `#axona-track` (region `eagle`).

Council members and operators can immediately inspect incoming field telemetry via the **Council Telemetry & Device QoS Analyzer**:
- **Dashboard URL**: `http://127.0.0.1:3344`
- **Inspect Fleet Table**: Verify your mobile device appears with its operating system, browser, display mode (PWA vs Browser), and battery level.
- **Inspect Stress Runs**: Review Test 5 results comparing peak channels, RTT degradation, event-loop lag, and battery delta.
- **Inspect Lifecycle Retention**: Review post-wake retention ratios across suspension tiers (<10s, 10–60s, 1–5m, >5m).
- **SQL Console**: Run ad-hoc queries against `device_nodes`, `heartbeats`, `lifecycle_events`, and `stress_runs`.
