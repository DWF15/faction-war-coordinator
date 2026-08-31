# Faction War Coordinator

A Torn userscript interface for a Discord-backed faction war coordinator.

## Install

### Desktop (Tampermonkey)

1. Install Tampermonkey in your browser.
2. Open the permanent userscript URL:
   `https://raw.githubusercontent.com/DWF15/faction-war-coordinator/main/faction-war-coordinator.user.js`
3. Approve the installation.
4. In the faction Discord, complete the Coordinator's normal `/register` process if you have not already.
5. Run `/userscript link` in Discord.
6. In Torn, click **LINK**, enter the one-time code, and give the device a recognizable name.

### Additional devices / TornPDA

Each device gets its own independent credential. Run `/userscript link` again for each new device and give each one a different name, for example `Desktop Chrome`, `Laptop`, or `TornPDA`.

Adding a device does not invalidate existing devices.

Use `/userscript devices` in Discord to view linked devices. Use `/userscript revoke` to revoke one device or `/userscript revoke_all` to revoke all of your devices.

## Current functionality

- Persistent rotation ticker on Torn
- Live Coordinator rotation order and ETAs
- Live target, energy, health, and status details
- Chain timer
- Join / Leave
- Coordinator-only Move, Skip / Return, Remove, and Change Rotation controls
- Full-rotation target allocation
- Desktop and mobile/PDA-oriented layouts
- Multi-device authentication tied to the existing Discord/Torn registration
- Secure remote HTTPS Coordinator connection

## Updates

The userscript uses a permanent GitHub update URL. Tampermonkey can automatically detect newer versions whenever the script's `@version` value changes, so users do not need a new install URL for each release.

## Security model

- This public repository contains only the userscript and documentation. It contains no Discord token, Torn API keys, `.env` files, Coordinator database, or other backend secrets.
- The userscript connects to the Coordinator through an authenticated HTTPS endpoint.
- Each installation authenticates with its own random device token issued only after redeeming a one-time Discord linking code.
- Device tokens are stored hashed by the Coordinator.
- Identity and coordinator permissions are enforced by the backend using the member's existing Discord/Torn registration. Editing the userscript does not grant coordinator permissions.
- A lost device can be revoked without affecting the member's other devices.

## Coordinator endpoint

The userscript currently connects to:

`https://dwf-laptop.tail731dbb.ts.net`

Tailscale Funnel proxies only the local Coordinator userscript API at `127.0.0.1:8765`.

## Current version

**v0.12.2** — remote HTTPS bridge, persistent userscript-manager authentication, multi-device support, and coordinator Skip / Return lifecycle.
