# Faction War Coordinator

A Torn userscript interface for a Discord-backed faction war coordinator.

## Install

### Desktop (Tampermonkey)

1. Install Tampermonkey in your browser.
2. Open the userscript installation URL:
   `https://raw.githubusercontent.com/DWF15/faction-war-coordinator/main/faction-war-coordinator.user.js`
3. Approve the installation.
4. In the faction Discord, complete the Coordinator's normal `/register` process if you have not already.
5. Run `/userscript link` in Discord.
6. In Torn, click **LINK**, enter the one-time code, and give the device a recognizable name.

### Additional devices / TornPDA

Each device gets its own independent credential. Run `/userscript link` again for each new device and give each one a different name (for example `Desktop Chrome`, `Laptop`, or `TornPDA`). Adding a device does not invalidate existing devices.

Use `/userscript devices` in Discord to view linked devices. Use `/userscript revoke` to revoke one device or `/userscript revoke_all` to revoke all of your devices.

## Updates

The userscript uses a permanent GitHub update URL. Tampermonkey can automatically detect newer versions when the `@version` value changes, so users do not need a new install URL for each release.

## Security model

- The public repository contains only the userscript and documentation. It contains no Discord token, Torn API keys, `.env` files, or Coordinator database.
- The userscript connects to the Coordinator through an authenticated HTTPS endpoint.
- Userscript devices authenticate with unique random tokens issued only after redeeming a one-time Discord linking code.
- Device tokens are stored hashed by the Coordinator.
- Identity and coordinator permissions are enforced by the backend using the member's existing Discord/Torn registration. Editing the userscript does not grant coordinator permissions.
- A lost device can be revoked without affecting the member's other devices.

## Current endpoint

The userscript connects to the authenticated Coordinator bridge at:

`https://dwf-laptop.tail731dbb.ts.net`

The bridge is exposed through Tailscale Funnel and proxies only the Coordinator userscript API.

## Current version

v0.12.0 — Remote HTTPS bridge + permanent GitHub install/update channel.
