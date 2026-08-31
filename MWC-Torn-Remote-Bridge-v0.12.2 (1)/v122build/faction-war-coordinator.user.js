// ==UserScript==
// @name         Faction Rotation Ticker
// @namespace    faction-rotation-ticker
// @version      0.12.2
// @description  Live Torn ranked-war rotation ticker powered by the Coordinator.
// @homepageURL  https://github.com/DWF15/faction-war-coordinator
// @updateURL    https://raw.githubusercontent.com/DWF15/faction-war-coordinator/main/faction-war-coordinator.user.js
// @downloadURL  https://raw.githubusercontent.com/DWF15/faction-war-coordinator/main/faction-war-coordinator.user.js
// @match        https://www.torn.com/*
// @match        https://torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      dwf-laptop.tail731dbb.ts.net
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const ROOT_ID = 'frt-root';
  const OVERLAY_ID = 'frt-player-overlay';
  const ROTATION_EDITOR_ID = 'frt-rotation-editor';
  const STYLE_ID = 'frt-style';
  const OFF_BUTTON_ID = 'frt-header-enable';
  const KEY_ENABLED = 'frt-enabled';
  const TOKEN_KEY = 'fwc-device-token-v1';
  const DEVICE_NAME_KEY = 'fwc-device-name-v1';
  const API_ROOT = 'https://dwf-laptop.tail731dbb.ts.net';
  const API_URL = `${API_ROOT}/api/v1/rotation`;
  const AUTH_REDEEM_URL = `${API_ROOT}/api/v1/auth/redeem`;
  const JOIN_URL = `${API_ROOT}/api/v1/rotation/join`;
  const LEAVE_URL = `${API_ROOT}/api/v1/rotation/leave`;
  const COORD_BASE_URL = `${API_ROOT}/api/v1/coordinator/rotation`;
  const POLL_MS = 5000;
  const CACHE_KEY = 'frt-last-good-state-v1';
  const OFFLINE_GRACE_MS = 15000;
  const FAILURES_BEFORE_OFFLINE = 3;
  const CACHE_MAX_AGE_MS = 60000;

  let rotation = [];
  let chainSeconds = null;
  let viewerTornId = null;
  let apiOnline = false;
  let lastError = '';
  let pollTimer = null;
  let writePending = false;
  let consecutiveFailures = 0;
  let lastSuccessAt = 0;
  let canManageRotation = false;
  let authRequired = false;

  const enabled = () => localStorage.getItem(KEY_ENABLED) !== 'false';
  const setEnabled = v => localStorage.setItem(KEY_ENABLED, String(v));

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  function formatEta(seconds) {
    if (seconds === null || seconds === undefined) return '--';
    const value = Math.max(0, Number(seconds) || 0);
    if (value === 0) return 'NOW';
    const minutes = Math.floor(value / 60);
    const secs = value % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function formatChain(seconds) {
    if (seconds === null || seconds === undefined) return '--:--';
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const secs = value % 60;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function roleLabel(m) {
    if (m.role === 'up') return 'UP NOW';
    if (m.role === 'on-deck') return 'ON DECK';
    if (m.role === 'in-hole') return 'IN THE HOLE';
    return '';
  }

  function joined() {
    return viewerTornId !== null && rotation.some(m => m.tornId === viewerTornId);
  }

  function detectViewerTornId() {
    const selectors = [
      '#sidebarroot a[href*="profiles.php?XID="]',
      'a[href*="profiles.php?XID="][class*="name"]',
      'a[href*="profiles.php?XID="]'
    ];
    for (const selector of selectors) {
      for (const link of document.querySelectorAll(selector)) {
        const match = String(link.getAttribute('href') || '').match(/[?&]XID=(\d+)/i);
        if (match) return Number(match[1]);
      }
    }
    return null;
  }

  function mobileMembers() {
    if (!rotation.length) return [];
    if (!joined()) return rotation.slice(0, 3);
    const me = rotation.findIndex(m => m.tornId === viewerTornId);
    if (me < 0) return rotation.slice(0, 3);
    return [me - 2, me - 1, me].map(i => rotation[(i + rotation.length) % rotation.length]);
  }

  function memberHTML(m) {
    const me = viewerTornId !== null && m.tornId === viewerTornId;
    const warning = m.status && !/^okay$/i.test(m.status) && !/^ready$/i.test(m.status);
    const target = m.target || '—';
    const secondary = m.role === 'normal'
      ? `<span class="frt-arrow">→</span><span>${esc(target)}</span>`
      : `<b>${esc(roleLabel(m))}</b><span> • ${esc(target)}</span>`;

    return `<button type="button" class="frt-member frt-${m.role} ${me ? 'frt-me' : ''}" data-rotation-id="${m.rotationUserId}">
      <span class="frt-line1">
        <span class="frt-name">${esc(m.name)}</span>
        ${me ? '<span class="frt-you">YOU</span>' : ''}
        <span class="frt-dot">•</span>
        <span class="frt-eta">${esc(m.eta)}</span>
        ${warning ? '<span class="frt-warn">!</span>' : ''}
      </span>
      <span class="frt-line2">${secondary}</span>
    </button>`;
  }

  function normalizeMember(raw) {
    const target = raw.target && typeof raw.target === 'object' ? raw.target : null;
    return {
      // Rotation/Discord IDs are transported as strings because Discord
      // snowflakes exceed JavaScript's Number.MAX_SAFE_INTEGER.
      rotationUserId: String(raw.rotation_user_id ?? raw.discord_user_id ?? ''),
      tornId: raw.torn_id === null || raw.torn_id === undefined ? null : Number(raw.torn_id),
      name: String(raw.name || 'Unknown'),
      eta: formatEta(raw.eta_seconds),
      etaSeconds: raw.eta_seconds,
      target: target ? String(target.name || '') : null,
      targetId: target ? Number(target.id || 0) : null,
      attackUrl: target ? String(target.attack_url || '') : '',
      energy: raw.energy ?? null,
      health: raw.health_percent ?? null,
      status: String(raw.status || raw.readiness_state || 'Unknown'),
      role: raw.role || 'normal',
      rotationStatus: String(raw.rotation_status || 'active'),
      position: Number(raw.position ?? 0)
    };
  }

  function applyState(data, options = {}) {
    if (!data.ok || !Array.isArray(data.members)) throw new Error(data.error || 'Invalid Coordinator response');
    rotation = data.members.map(normalizeMember);
    chainSeconds = data.chain_seconds;
    canManageRotation = Boolean(data.permissions && data.permissions.manage_rotation);
    if (data.viewer && data.viewer.torn_id) viewerTornId = Number(data.viewer.torn_id);
    authRequired = false;
    apiOnline = true;
    lastError = '';
    consecutiveFailures = 0;
    lastSuccessAt = Date.now();

    if (options.persist !== false) {
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({
          saved_at: lastSuccessAt,
          data
        }));
      } catch (_) {
        // Cache failure should never affect the live ticker.
      }
    }
  }

  function restoreCachedState() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!cached || !cached.data || !cached.saved_at) return false;
      const age = Date.now() - Number(cached.saved_at);
      if (!Number.isFinite(age) || age < 0 || age > CACHE_MAX_AGE_MS) return false;

      applyState(cached.data, { persist: false });
      lastSuccessAt = Number(cached.saved_at);
      return true;
    } catch (_) {
      return false;
    }
  }

  function handleReadFailure(message) {
    consecutiveFailures += 1;
    lastError = message;

    const withinGrace = lastSuccessAt > 0 && (Date.now() - lastSuccessAt) < OFFLINE_GRACE_MS;
    if (apiOnline && (withinGrace || consecutiveFailures < FAILURES_BEFORE_OFFLINE)) {
      // Torn navigation can briefly interrupt a request. Keep the last known
      // good rotation visible instead of flashing "Coordinator offline".
      return;
    }

    apiOnline = false;
    render();
  }

  function scriptStorageGet(key, fallback = '') {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (_) {}
    try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  }
  function scriptStorageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
    } catch (_) {}
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  function scriptStorageDelete(key) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
    } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
  }
  function migrateAuthStorage() {
    try {
      const gmToken = typeof GM_getValue === 'function' ? GM_getValue(TOKEN_KEY, '') : '';
      const legacyToken = localStorage.getItem(TOKEN_KEY) || '';
      if (!gmToken && legacyToken) {
        scriptStorageSet(TOKEN_KEY, legacyToken);
        scriptStorageDelete(TOKEN_KEY);
      }
      const gmName = typeof GM_getValue === 'function' ? GM_getValue(DEVICE_NAME_KEY, '') : '';
      const legacyName = localStorage.getItem(DEVICE_NAME_KEY) || '';
      if (!gmName && legacyName) {
        scriptStorageSet(DEVICE_NAME_KEY, legacyName);
        localStorage.removeItem(DEVICE_NAME_KEY);
      }
    } catch (_) {}
  }
  function authToken() { return String(scriptStorageGet(TOKEN_KEY, '') || ''); }
  function authHeaders(extra = {}) {
    const token = authToken();
    return Object.assign({}, extra, token ? { 'Authorization': `Bearer ${token}` } : {});
  }
  function defaultDeviceName() {
    const ua = navigator.userAgent || '';
    if (/TornPDA/i.test(ua)) return 'TornPDA';
    if (/Android/i.test(ua)) return 'Android';
    if (/iPhone|iPad/i.test(ua)) return 'iPhone/iPad';
    if (/Windows/i.test(ua)) return 'Windows browser';
    if (/Macintosh/i.test(ua)) return 'Mac browser';
    return 'Torn userscript device';
  }
  function clearAuth() {
    scriptStorageDelete(TOKEN_KEY);
    authRequired = true;
    canManageRotation = false;
  }
  function linkDevice() {
    const code = prompt('Enter the one-time code from Discord /userscript link:');
    if (!code) return;
    const remembered = scriptStorageGet(DEVICE_NAME_KEY, '') || defaultDeviceName();
    const deviceName = prompt('Name this device:', remembered) || remembered;
    GM_xmlhttpRequest({
      method: 'POST', url: AUTH_REDEEM_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ code, device_name: deviceName }), timeout: 8000,
      onload: response => {
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status < 200 || response.status >= 300 || !data.ok || !data.token) throw new Error(data.error || `HTTP ${response.status}`);
          scriptStorageSet(TOKEN_KEY, data.token);
          scriptStorageSet(DEVICE_NAME_KEY, deviceName);
          authRequired = false;
          viewerTornId = Number(data.torn_id || 0) || viewerTornId;
          alert(`Linked as ${data.name || 'registered member'} on ${deviceName}.`);
          requestState();
        } catch (err) { alert(`Device link failed: ${String(err?.message || err)}`); }
      },
      onerror: () => alert('Device link failed: Coordinator API unavailable.'),
      ontimeout: () => alert('Device link timed out.')
    });
  }

  function rotationAction(action) {
    if (writePending) return;
    viewerTornId = detectViewerTornId() || viewerTornId;
    if (!viewerTornId) {
      alert('I could not determine your Torn player ID from this page. Refresh Torn and try again.');
      return;
    }
    if (!apiOnline) {
      alert('The Coordinator is currently offline. Start the bot and try again.');
      return;
    }
    if (action === 'join' && !confirm('Join the active rotation?')) return;

    writePending = true;
    render();
    GM_xmlhttpRequest({
      method: 'POST',
      url: action === 'join' ? JOIN_URL : LEAVE_URL,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      data: JSON.stringify({}),
      timeout: 8000,
      onload: response => {
        writePending = false;
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status < 200 || response.status >= 300 || !data.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          applyState(data);
          render();
        } catch (err) {
          lastError = String(err?.message || err);
          render();
          alert(`Rotation ${action} failed: ${lastError}`);
        }
      },
      onerror: () => {
        writePending = false;
        lastError = 'Coordinator API unavailable';
        render();
        alert(`Rotation ${action} failed: ${lastError}`);
      },
      ontimeout: () => {
        writePending = false;
        lastError = 'Coordinator API timed out';
        render();
        alert(`Rotation ${action} failed: ${lastError}`);
      }
    });
  }

  function saveRotationOrder(orderedMembers) {
    if (writePending || !canManageRotation) return;
    viewerTornId = detectViewerTornId() || viewerTornId;
    if (!viewerTornId) {
      alert('I could not determine your Torn player ID from this page. Refresh Torn and try again.');
      return;
    }
    if (!Array.isArray(orderedMembers) || orderedMembers.length !== rotation.length) {
      alert('The rotation editor is out of date. Close it and reopen Change Rotation.');
      return;
    }

    writePending = true;
    closeRotationEditor();
    render();
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${COORD_BASE_URL}/replace`,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      data: JSON.stringify({
        ordered_rotation_user_ids: orderedMembers.map(member => member.rotationUserId)
      }),
      timeout: 8000,
      onload: response => {
        writePending = false;
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status < 200 || response.status >= 300 || !data.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          applyState(data);
          render();
        } catch (err) {
          alert(`Change Rotation failed: ${String(err?.message || err)}`);
          requestState();
        }
      },
      onerror: () => { writePending = false; alert('Change Rotation failed: API unavailable'); requestState(); },
      ontimeout: () => { writePending = false; alert('Change Rotation failed: Coordinator API timed out'); requestState(); }
    });
  }

  function coordinatorAction(action, member) {
    if (writePending || !canManageRotation) return;
    viewerTornId = detectViewerTornId() || viewerTornId;
    if (!viewerTornId) {
      alert('I could not determine your Torn player ID from this page. Refresh Torn and try again.');
      return;
    }

    if (action === 'rotation') {
      closeOverlay();
      openRotationEditor();
      return;
    }

    let position = null;
    if (action === 'move') {
      const answer = prompt(`Move ${member.name} to which rotation position?\n\n1 = Up Now`, String((member.position || 0) + 1));
      if (answer === null) return;
      position = Number(answer);
      if (!Number.isInteger(position) || position < 1) {
        alert('Enter a whole-number rotation position starting with 1.');
        return;
      }
    }
    if (action === 'skip' && !confirm(`Skip ${member.name} while preserving their place in the rotation?`)) return;
    if (action === 'resume' && !confirm(`Return ${member.name} to the active rotation in their current place?`)) return;
    if (action === 'remove' && !confirm(`Remove ${member.name} from the rotation?`)) return;

    writePending = true;
    closeOverlay();
    render();
    GM_xmlhttpRequest({
      method: 'POST',
      url: `${COORD_BASE_URL}/${action}`,
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      data: JSON.stringify({
        target_rotation_user_id: member.rotationUserId,
        position
      }),
      timeout: 8000,
      onload: response => {
        writePending = false;
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status < 200 || response.status >= 300 || !data.ok) {
            throw new Error(data.error || `HTTP ${response.status}`);
          }
          applyState(data);
          render();
        } catch (err) {
          alert(`Coordinator ${action} failed: ${String(err?.message || err)}`);
          requestState();
        }
      },
      onerror: () => {
        writePending = false;
        alert(`Coordinator ${action} failed: API unavailable`);
        requestState();
      },
      ontimeout: () => {
        writePending = false;
        alert(`Coordinator ${action} timed out. Check the ticker before retrying.`);
        requestState();
      }
    });
  }

  function requestState() {
    if (!enabled()) return;
    viewerTornId = detectViewerTornId() || viewerTornId;
    GM_xmlhttpRequest({
      method: 'GET',
      url: API_URL,
      headers: authHeaders(),
      timeout: 4000,
      onload: response => {
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status === 401 || data.auth_required) { clearAuth(); render(); return; }
          if (response.status < 200 || response.status >= 300) throw new Error(data.error || `HTTP ${response.status}`);
          applyState(data);
          render();
        } catch (err) {
          handleReadFailure(String(err?.message || err));
        }
      },
      onerror: () => {
        handleReadFailure('Coordinator API unavailable');
      },
      ontimeout: () => {
        handleReadFailure('Coordinator API timed out');
      }
    });
  }

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${ROOT_ID} { --bg:rgba(16,18,21,.985); --border:#3a4047; --text:#f3f5f7; --muted:#aab1b8; --up:#49d17d; --deck:#55aaff; --hole:#e8c94f; --me:#d990ff; --danger:#ff6b6b; position:sticky; top:0; z-index:999990; width:100%; background:var(--bg); color:var(--text); border-bottom:1px solid var(--border); font-family:Arial,Helvetica,sans-serif; box-sizing:border-box; }
      #${ROOT_ID} * { box-sizing:border-box; }
      #${ROOT_ID} .frt-bar { display:grid; grid-template-columns:auto minmax(0,1fr) auto auto; min-height:44px; align-items:stretch; }
      #${ROOT_ID} .frt-brand { display:flex; align-items:center; gap:7px; padding:4px 10px; border-right:1px solid var(--border); font-size:11px; font-weight:900; letter-spacing:.06em; white-space:nowrap; }
      #${ROOT_ID} .frt-live { width:8px; height:8px; border-radius:50%; background:var(--up); box-shadow:0 0 7px rgba(73,209,125,.75); }
      #${ROOT_ID}.frt-offline .frt-live { background:var(--danger); box-shadow:0 0 7px rgba(255,107,107,.65); }
      #${ROOT_ID} .frt-desktop, #${ROOT_ID} .frt-mobile { display:flex; min-width:0; align-items:stretch; }
      #${ROOT_ID} .frt-mobile { display:none; }
      #${ROOT_ID} .frt-empty { flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:10px; padding:0 12px; }
      #${ROOT_ID} .frt-member { flex:1 1 0; min-width:112px; max-width:220px; border:0; border-right:1px solid var(--border); border-top:3px solid transparent; background:transparent; color:inherit; padding:3px 7px 4px; cursor:pointer; text-align:center; }
      #${ROOT_ID} .frt-member:hover, #${ROOT_ID} .frt-member:focus-visible { background:rgba(255,255,255,.055); outline:none; }
      #${ROOT_ID} .frt-line1, #${ROOT_ID} .frt-line2 { display:flex; align-items:center; justify-content:center; gap:4px; min-width:0; white-space:nowrap; }
      #${ROOT_ID} .frt-line1 { font-size:13px; font-weight:800; line-height:16px; }
      #${ROOT_ID} .frt-line2 { font-size:9px; line-height:12px; color:var(--muted); overflow:hidden; }
      #${ROOT_ID} .frt-line2 span { overflow:hidden; text-overflow:ellipsis; }
      #${ROOT_ID} .frt-arrow { color:var(--muted); font-weight:900; }
      #${ROOT_ID} .frt-name { overflow:hidden; text-overflow:ellipsis; }
      #${ROOT_ID} .frt-eta { font-variant-numeric:tabular-nums; }
      #${ROOT_ID} .frt-up { border-top-color:var(--up); } #${ROOT_ID} .frt-up .frt-line1, #${ROOT_ID} .frt-up .frt-line2 b { color:var(--up); }
      #${ROOT_ID} .frt-on-deck { border-top-color:var(--deck); } #${ROOT_ID} .frt-on-deck .frt-line1, #${ROOT_ID} .frt-on-deck .frt-line2 b { color:var(--deck); }
      #${ROOT_ID} .frt-in-hole { border-top-color:var(--hole); } #${ROOT_ID} .frt-in-hole .frt-line1, #${ROOT_ID} .frt-in-hole .frt-line2 b { color:var(--hole); }
      #${ROOT_ID} .frt-me .frt-name { font-weight:900; }
      #${ROOT_ID} .frt-you { font-size:7px; padding:1px 3px; border:1px solid var(--me); border-radius:3px; color:var(--me); }
      #${ROOT_ID} .frt-warn { display:inline-grid; place-items:center; width:14px; height:14px; border-radius:50%; background:var(--danger); color:white; font-size:9px; }
      #${ROOT_ID} .frt-timer { min-width:98px; display:flex; flex-direction:column; align-items:center; justify-content:center; border-left:1px solid var(--border); padding:2px 8px; }
      #${ROOT_ID} .frt-timer small { color:var(--muted); font-size:7px; font-weight:900; letter-spacing:.08em; }
      #${ROOT_ID} .frt-timer strong { font-size:14px; font-variant-numeric:tabular-nums; line-height:17px; }
      #${ROOT_ID} .frt-off { border:0; background:transparent; color:var(--muted); font-size:7px; font-weight:800; cursor:pointer; padding:0; }
      #${ROOT_ID} .frt-actions { display:flex; align-items:center; padding:4px 9px; border-left:1px solid var(--border); }
      #${ROOT_ID} .frt-joinleave { min-width:90px; height:30px; border-radius:5px; border:1px solid var(--border); color:white; font-size:10px; font-weight:900; cursor:pointer; }
      #${ROOT_ID} .frt-joinleave:disabled { opacity:.55; cursor:wait; }
      #${ROOT_ID} .frt-join { background:#286d45; } #${ROOT_ID} .frt-leave { background:#653535; }
      #${OFF_BUTTON_ID} { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; min-width:26px; margin-left:5px; padding:0; border:1px solid rgba(255,255,255,.12); border-radius:4px; background:rgba(12,15,18,.90); color:#e8edf1; cursor:pointer; box-sizing:border-box; vertical-align:middle; }
      #${OFF_BUTTON_ID} svg { width:20px; height:20px; display:block; } #${OFF_BUTTON_ID} .frt-chain { stroke:#cfd3d6; } #${OFF_BUTTON_ID} .frt-rotate { stroke:#55c95f; }
      #${OFF_BUTTON_ID}:hover { background:rgba(255,255,255,.08); border-color:rgba(85,201,95,.75); box-shadow:0 0 8px rgba(85,201,95,.28); }
      #${OFF_BUTTON_ID}:focus-visible { outline:1px solid #55c95f; outline-offset:2px; }
      #${OFF_BUTTON_ID}.frt-header-fallback { position:fixed; top:8px; right:8px; z-index:1000010; margin:0; }
      #${OVERLAY_ID} { --border:#454b53; --text:#f3f5f7; --muted:#aab1b8; position:fixed; z-index:1000005; width:min(330px,calc(100vw - 20px)); background:#191c20; color:var(--text); border:1px solid var(--border); border-radius:8px; box-shadow:0 10px 35px rgba(0,0,0,.58); font-family:Arial,Helvetica,sans-serif; padding:11px; box-sizing:border-box; }
      #${OVERLAY_ID} .frt-ov-head { display:flex; justify-content:space-between; align-items:center; gap:10px; padding-bottom:7px; border-bottom:1px solid var(--border); }
      #${OVERLAY_ID} .frt-ov-head strong { font-size:15px; } #${OVERLAY_ID} .frt-close { border:0; background:transparent; color:var(--muted); font-size:18px; cursor:pointer; }
      #${OVERLAY_ID} .frt-ov-row { display:flex; justify-content:space-between; gap:15px; padding:6px 0; font-size:12px; border-bottom:1px solid #30353b; }
      #${OVERLAY_ID} .frt-ov-row span:first-child { color:var(--muted); }
      #${OVERLAY_ID} .frt-attack { display:block; margin-top:9px; padding:8px; border-radius:5px; background:#2e7d4c; color:white; text-align:center; text-decoration:none; font-size:11px; font-weight:900; }
      #${OVERLAY_ID} .frt-attack-disabled { background:#343a40; color:#999; pointer-events:none; }
      #${OVERLAY_ID} .frt-coord-label { margin-top:10px; padding-top:8px; border-top:1px solid var(--border); color:var(--muted); font-size:8px; font-weight:900; letter-spacing:.1em; }
      #${OVERLAY_ID} .frt-admin { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-top:6px; }
      #${OVERLAY_ID} .frt-admin button { min-height:29px; border:1px solid var(--border); border-radius:4px; background:#252a30; color:var(--text); font-size:9px; font-weight:800; cursor:pointer; }
      #${OVERLAY_ID} .frt-admin button:hover:not(:disabled) { background:#30363d; border-color:#59616a; }
      #${OVERLAY_ID} .frt-admin button:disabled { color:#747b82; cursor:not-allowed; opacity:.58; }
      #${ROTATION_EDITOR_ID} { position:fixed; inset:0; z-index:1000012; display:grid; place-items:start center; padding:72px 12px 20px; background:rgba(0,0,0,.58); font-family:Arial,Helvetica,sans-serif; box-sizing:border-box; }
      #${ROTATION_EDITOR_ID} * { box-sizing:border-box; }
      #${ROTATION_EDITOR_ID} .frt-editor-card { width:min(460px,100%); max-height:calc(100vh - 92px); overflow:auto; background:#191c20; color:#f3f5f7; border:1px solid #454b53; border-radius:9px; box-shadow:0 14px 42px rgba(0,0,0,.62); padding:12px; }
      #${ROTATION_EDITOR_ID} .frt-editor-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding-bottom:9px; border-bottom:1px solid #3a4047; }
      #${ROTATION_EDITOR_ID} .frt-editor-head strong { font-size:15px; }
      #${ROTATION_EDITOR_ID} .frt-editor-head small { display:block; margin-top:2px; color:#aab1b8; font-size:9px; font-weight:normal; }
      #${ROTATION_EDITOR_ID} .frt-editor-close { border:0; background:transparent; color:#aab1b8; font-size:20px; cursor:pointer; }
      #${ROTATION_EDITOR_ID} .frt-editor-list { display:grid; gap:5px; margin:10px 0; }
      #${ROTATION_EDITOR_ID} .frt-editor-row { display:grid; grid-template-columns:26px minmax(0,1fr) auto; align-items:center; gap:7px; min-height:42px; padding:5px 6px; background:#24282d; border:1px solid #3b4148; border-radius:5px; }
      #${ROTATION_EDITOR_ID} .frt-editor-row[draggable="true"] { cursor:grab; }
      #${ROTATION_EDITOR_ID} .frt-editor-row.frt-dragging { opacity:.45; }
      #${ROTATION_EDITOR_ID} .frt-editor-row.frt-drop-before { border-top-color:#55aaff; box-shadow:inset 0 2px #55aaff; }
      #${ROTATION_EDITOR_ID} .frt-editor-number { color:#aab1b8; font-size:11px; font-weight:900; text-align:center; }
      #${ROTATION_EDITOR_ID} .frt-editor-name { min-width:0; }
      #${ROTATION_EDITOR_ID} .frt-editor-name strong { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
      #${ROTATION_EDITOR_ID} .frt-editor-name span { display:block; margin-top:2px; color:#aab1b8; font-size:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #${ROTATION_EDITOR_ID} .frt-editor-move { display:flex; gap:4px; }
      #${ROTATION_EDITOR_ID} .frt-editor-move button { width:30px; height:30px; border:1px solid #454b53; border-radius:4px; background:#1c2024; color:#f3f5f7; font-size:14px; font-weight:900; cursor:pointer; }
      #${ROTATION_EDITOR_ID} .frt-editor-move button:disabled { opacity:.28; cursor:default; }
      #${ROTATION_EDITOR_ID} .frt-editor-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; padding-top:9px; border-top:1px solid #3a4047; }
      #${ROTATION_EDITOR_ID} .frt-editor-actions button { min-height:36px; border-radius:5px; border:1px solid #454b53; font-size:10px; font-weight:900; cursor:pointer; }
      #${ROTATION_EDITOR_ID} .frt-editor-save { background:#2e7d4c; color:white; }
      #${ROTATION_EDITOR_ID} .frt-editor-cancel { background:#252a30; color:#f3f5f7; }

      @media (max-width:720px) {
        #${ROOT_ID} .frt-bar { grid-template-columns:minmax(0,1fr) auto auto; min-height:42px; }
        #${ROOT_ID} .frt-brand, #${ROOT_ID} .frt-desktop { display:none; }
        #${ROOT_ID} .frt-mobile { display:flex; min-width:0; }
        #${ROOT_ID} .frt-member { min-width:0; max-width:none; padding:2px 3px 3px; }
        #${ROOT_ID} .frt-line1 { font-size:10px; line-height:14px; gap:2px; }
        #${ROOT_ID} .frt-line2 { font-size:7px; line-height:10px; gap:2px; }
        #${ROOT_ID} .frt-you { display:none; }
        #${ROOT_ID} .frt-timer { min-width:64px; padding:2px 4px; }
        #${ROOT_ID} .frt-timer strong { font-size:10px; line-height:13px; }
        #${ROOT_ID} .frt-timer small, #${ROOT_ID} .frt-off { font-size:6px; }
        #${ROOT_ID} .frt-actions { padding:3px 4px; }
        #${ROOT_ID} .frt-joinleave { min-width:44px; width:44px; height:28px; font-size:8px; padding:0; }
        #${ROTATION_EDITOR_ID} { padding:54px 8px 12px; }
        #${ROTATION_EDITOR_ID} .frt-editor-card { max-height:calc(100vh - 66px); padding:9px; }
        #${ROTATION_EDITOR_ID} .frt-editor-row { grid-template-columns:22px minmax(0,1fr) auto; min-height:46px; padding:5px 4px; }
        #${ROTATION_EDITOR_ID} .frt-editor-move button { width:34px; height:34px; }
      }`;
    document.head.appendChild(s);
  }

  function closeOverlay() { document.getElementById(OVERLAY_ID)?.remove(); }
  function closeRotationEditor() { document.getElementById(ROTATION_EDITOR_ID)?.remove(); }

  function openRotationEditor() {
    closeOverlay();
    closeRotationEditor();
    if (!canManageRotation) return;
    if (!rotation.length) { alert('The rotation is currently empty.'); return; }

    let ordered = rotation.slice();
    let draggedId = null;
    const editor = document.createElement('div');
    editor.id = ROTATION_EDITOR_ID;
    editor.innerHTML = `<div class="frt-editor-card" role="dialog" aria-modal="true" aria-label="Change Rotation">
      <div class="frt-editor-head"><div><strong>CHANGE ROTATION</strong><small>Drag members or use ↑ / ↓, then save the complete order.</small></div><button type="button" class="frt-editor-close" aria-label="Close">×</button></div>
      <div class="frt-editor-list"></div>
      <div class="frt-editor-actions"><button type="button" class="frt-editor-cancel">CANCEL</button><button type="button" class="frt-editor-save">SAVE ROTATION</button></div>
    </div>`;
    document.body.appendChild(editor);

    const list = editor.querySelector('.frt-editor-list');
    function redraw() {
      list.innerHTML = ordered.map((member, index) => `<div class="frt-editor-row" draggable="true" data-id="${esc(member.rotationUserId)}">
        <span class="frt-editor-number">${index + 1}</span>
        <span class="frt-editor-name"><strong>${esc(member.name)}</strong><span>${index === 0 ? 'UP NOW' : index === 1 ? 'ON DECK' : index === 2 ? 'IN THE HOLE' : `Position ${index + 1}`}</span></span>
        <span class="frt-editor-move"><button type="button" data-shift="-1" ${index === 0 ? 'disabled' : ''} aria-label="Move ${esc(member.name)} up">↑</button><button type="button" data-shift="1" ${index === ordered.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(member.name)} down">↓</button></span>
      </div>`).join('');

      list.querySelectorAll('[data-shift]').forEach(button => button.addEventListener('click', event => {
        const row = event.currentTarget.closest('.frt-editor-row');
        const index = ordered.findIndex(member => member.rotationUserId === row.dataset.id);
        const next = index + Number(event.currentTarget.dataset.shift);
        if (index < 0 || next < 0 || next >= ordered.length) return;
        [ordered[index], ordered[next]] = [ordered[next], ordered[index]];
        redraw();
      }));

      list.querySelectorAll('.frt-editor-row').forEach(row => {
        row.addEventListener('dragstart', event => { draggedId = row.dataset.id; row.classList.add('frt-dragging'); event.dataTransfer.effectAllowed = 'move'; });
        row.addEventListener('dragend', () => { draggedId = null; list.querySelectorAll('.frt-editor-row').forEach(item => item.classList.remove('frt-dragging','frt-drop-before')); });
        row.addEventListener('dragover', event => { event.preventDefault(); if (draggedId && draggedId !== row.dataset.id) row.classList.add('frt-drop-before'); });
        row.addEventListener('dragleave', () => row.classList.remove('frt-drop-before'));
        row.addEventListener('drop', event => {
          event.preventDefault();
          row.classList.remove('frt-drop-before');
          if (!draggedId || draggedId === row.dataset.id) return;
          const from = ordered.findIndex(member => member.rotationUserId === draggedId);
          const to = ordered.findIndex(member => member.rotationUserId === row.dataset.id);
          if (from < 0 || to < 0) return;
          const [moved] = ordered.splice(from, 1);
          ordered.splice(to, 0, moved);
          redraw();
        });
      });
    }

    redraw();
    editor.querySelector('.frt-editor-close').addEventListener('click', closeRotationEditor);
    editor.querySelector('.frt-editor-cancel').addEventListener('click', closeRotationEditor);
    editor.querySelector('.frt-editor-save').addEventListener('click', () => {
      if (!confirm(`Replace the complete rotation with this ${ordered.length}-member order?`)) return;
      saveRotationOrder(ordered);
    });
    editor.addEventListener('pointerdown', event => { if (event.target === editor) closeRotationEditor(); });
  }

  function openOverlay(member, anchor) {
    closeOverlay();
    const targetText = member.target || 'No active assignment';
    const energyText = member.energy === null ? 'Unknown' : member.energy;
    const healthText = member.health === null ? 'Unknown' : `${member.health}%`;
    const attack = member.attackUrl
      ? `<a class="frt-attack" href="${esc(member.attackUrl)}">ATTACK ${esc(member.target)}</a>`
      : `<span class="frt-attack frt-attack-disabled">NO ACTIVE TARGET</span>`;
    const ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.innerHTML = `
      <div class="frt-ov-head"><strong>${esc(member.name)}</strong><button type="button" class="frt-close" aria-label="Close">×</button></div>
      <div class="frt-ov-row"><span>Rotation</span><strong>${esc(roleLabel(member) || 'IN ROTATION')} • ${esc(member.eta)}</strong></div>
      <div class="frt-ov-row"><span>Target</span><strong>${esc(targetText)}</strong></div>
      <div class="frt-ov-row"><span>Energy</span><strong>${esc(energyText)}</strong></div>
      <div class="frt-ov-row"><span>Health</span><strong>${esc(healthText)}</strong></div>
      <div class="frt-ov-row"><span>Status</span><strong>${esc(member.status)}</strong></div>
      ${attack}
      ${canManageRotation ? `<div class="frt-coord-label">COORDINATOR</div><div class="frt-admin"><button type="button" data-coord="rotation" title="Reorder the complete active rotation.">CHANGE ROTATION</button><button type="button" data-coord="move">MOVE</button><button type="button" data-coord="${member.rotationStatus === 'skip' || member.rotationStatus === 'away' ? 'resume' : 'skip'}">${member.rotationStatus === 'skip' || member.rotationStatus === 'away' ? 'RETURN' : 'SKIP'}</button><button type="button" data-coord="remove">REMOVE</button></div>` : ''}`;
    document.body.appendChild(ov);
    const r = anchor.getBoundingClientRect();
    const w = ov.offsetWidth;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    ov.style.left = `${left}px`;
    ov.style.top = `${Math.min(r.bottom + 6, Math.max(8, window.innerHeight - ov.offsetHeight - 8))}px`;
    ov.querySelector('.frt-close').addEventListener('click', closeOverlay);
    ov.querySelectorAll('[data-coord]').forEach(btn => {
      if (btn.disabled) return;
      btn.addEventListener('click', () => coordinatorAction(btn.dataset.coord, member));
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  }

  function findTornProfileControl() {
    const selectors = ['a[href*="profiles.php"]','a[href*="sid=User"]','a[title*="profile" i]','button[title*="profile" i]','[aria-label*="profile" i]','[data-testid*="profile" i]'];
    const candidates = [];
    for (const selector of selectors) for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top >= 0 && r.top < 135) candidates.push(el);
    }
    candidates.sort((a,b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    return candidates[0] || null;
  }

  function mountOffButton() {
    document.getElementById(OFF_BUTTON_ID)?.remove();
    const btn = document.createElement('button');
    btn.id = OFF_BUTTON_ID; btn.type = 'button'; btn.title = 'Enable Rotation'; btn.setAttribute('aria-label','Enable Rotation');
    btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path class="frt-rotate" d="M5 8.2a8 8 0 0 1 12.8-2.1" fill="none" stroke-width="1.8" stroke-linecap="round"/><path class="frt-rotate" d="M17.8 3.9l.4 3.7-3.7-.3" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path class="frt-rotate" d="M19 15.8a8 8 0 0 1-12.8 2.1" fill="none" stroke-width="1.8" stroke-linecap="round"/><path class="frt-rotate" d="M6.2 20.1l-.4-3.7 3.7.3" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path class="frt-chain" d="M9.1 14.9l-1.2 1.2a3 3 0 0 1-4.2-4.2l2.2-2.2a3 3 0 0 1 4.2 0" fill="none" stroke-width="2.1" stroke-linecap="round"/><path class="frt-chain" d="M14.9 9.1l1.2-1.2a3 3 0 1 1 4.2 4.2l-2.2 2.2a3 3 0 0 1-4.2 0" fill="none" stroke-width="2.1" stroke-linecap="round"/><path class="frt-chain" d="M8.6 15.4l6.8-6.8" fill="none" stroke-width="2.1" stroke-linecap="round"/></svg>`;
    btn.addEventListener('click', () => { setEnabled(true); render(); requestState(); startPolling(); });
    const profile = findTornProfileControl();
    if (profile) (profile.closest('li') || profile).insertAdjacentElement('afterend', btn);
    else { document.body.appendChild(btn); btn.classList.add('frt-header-fallback'); }
  }

  function render() {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(OFF_BUTTON_ID)?.remove();
    closeOverlay(); addStyles();
    if (!enabled()) { mountOffButton(); return; }

    const desktop = authRequired ? `<div class="frt-empty">Link this device through Discord to use the Coordinator.</div>` : (rotation.length ? rotation.map(memberHTML).join('') : `<div class="frt-empty">${apiOnline ? 'No one is currently in the rotation.' : `Coordinator offline${lastError ? ` · ${esc(lastError)}` : ''}`}</div>`);
    const mobile = authRequired ? `<div class="frt-empty">Device not linked</div>` : (rotation.length ? mobileMembers().map(memberHTML).join('') : `<div class="frt-empty">${apiOnline ? 'Rotation empty' : 'Coordinator offline'}</div>`);
    const root = document.createElement('section');
    root.id = ROOT_ID;
    if (!apiOnline) root.classList.add('frt-offline');
    root.innerHTML = `<div class="frt-bar"><div class="frt-brand" title="${esc(lastError)}"><span class="frt-live"></span>ROTATION</div><div class="frt-desktop">${desktop}</div><div class="frt-mobile">${mobile}</div><div class="frt-timer"><small>CHAIN TIMER</small><strong>${esc(formatChain(chainSeconds))}</strong><button type="button" class="frt-off">OFF</button></div><div class="frt-actions">${authRequired ? '<button type="button" class="frt-joinleave frt-join frt-link">LINK</button>' : `<button type="button" class="frt-joinleave ${joined() ? 'frt-leave' : 'frt-join'}" ${writePending || !apiOnline ? 'disabled' : ''}>${writePending ? 'WORKING…' : (joined() ? 'LEAVE' : 'JOIN')}</button>`}</div></div>`;
    document.body.prepend(root);

    root.querySelectorAll('.frt-member').forEach(btn => btn.addEventListener('click', e => {
      const member = rotation.find(m => m.rotationUserId === String(e.currentTarget.dataset.rotationId));
      if (member) openOverlay(member, e.currentTarget);
    }));
    const actionButton = root.querySelector('.frt-joinleave');
    if (actionButton) actionButton.addEventListener('click', () => authRequired ? linkDevice() : rotationAction(joined() ? 'leave' : 'join'));
    root.querySelector('.frt-off').addEventListener('click', () => { closeRotationEditor(); setEnabled(false); stopPolling(); render(); });
  }

  function startPolling() {
    stopPolling();
    if (!enabled()) return;
    pollTimer = window.setInterval(requestState, POLL_MS);
  }
  function stopPolling() { if (pollTimer !== null) window.clearInterval(pollTimer); pollTimer = null; }

  document.addEventListener('pointerdown', e => {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov && !ov.contains(e.target) && !e.target.closest?.(`#${ROOT_ID} .frt-member`)) closeOverlay();
  }, true);

  const observer = new MutationObserver(() => {
    viewerTornId = detectViewerTornId() || viewerTornId;
    if (enabled()) { if (!document.getElementById(ROOT_ID)) render(); }
    else if (!document.getElementById(OFF_BUTTON_ID)) mountOffButton();
  });

  migrateAuthStorage();
  viewerTornId = detectViewerTornId();
  authRequired = !authToken();
  if (!authRequired) restoreCachedState();
  render();
  requestState();
  startPolling();
  observer.observe(document.documentElement, { childList:true, subtree:true });
})();
