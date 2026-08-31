MWC Torn Remote Bridge v0.12.7

Userscript-only TornPDA enrollment fix. Backend remains v0.12.6.

Changes:
- Adds a pure-JavaScript SHA-256 fallback when TornPDA WebView does not expose Web Crypto.
- Uses globalThis.crypto safely when Web Crypto is available.
- Fixes fresh PDA enrollment: an expected pre-link HTTP 401 no longer traps the UI in DIAG mode; LINK remains available for an unregistered PDA proof.
- Shows a compact PDA startup status if a proof cannot be generated: key=yes/no, proof=no.
- Desktop Tampermonkey authentication is unchanged.

Install:
1. Keep the v0.12.6 backend patch installed and the bot running.
2. Replace the TornPDA userscript with faction-war-coordinator.user.js v0.12.7.
3. Open Torn. If LINK appears, run /userscript link in Discord and redeem the new one-time code.
4. After linking, change pages, refresh, close TornPDA, and reopen it.
