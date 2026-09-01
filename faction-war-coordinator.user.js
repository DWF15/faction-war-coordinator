// ==UserScript==
// @name         Faction Rotation Ticker
// @namespace    faction-rotation-ticker
// @version      0.14.3
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
  const SETTINGS_ID = 'frt-settings';
  const ALERT_ID = 'frt-transition-alert';
  const KEY_ENABLED = 'frt-enabled';
  const SETTINGS_KEY = 'frt-settings-v1';
  const ALERT_STAGE_KEY = 'frt-alert-stage-v1';
  const ALERT_CLAIM_KEY = 'frt-alert-claim-v1';
  const TOKEN_KEY = 'fwc-device-token-v1';
  const PDA_API_KEY = '###PDA-APIKEY###';
  const DEVICE_NAME_KEY = 'fwc-device-name-v1';
  const API_ROOT = 'https://dwf-laptop.tail731dbb.ts.net';
  const API_URL = `${API_ROOT}/api/v1/rotation`;
  const AUTH_REDEEM_URL = `${API_ROOT}/api/v1/auth/redeem`;
  const JOIN_URL = `${API_ROOT}/api/v1/rotation/join`;
  const LEAVE_URL = `${API_ROOT}/api/v1/rotation/leave`;
  const SELF_SKIP_URL = `${API_ROOT}/api/v1/rotation/skip`;
  const SELF_RETURN_URL = `${API_ROOT}/api/v1/rotation/return`;
  const COORD_BASE_URL = `${API_ROOT}/api/v1/coordinator/rotation`;
  const POLL_MS = 5000;
  const CACHE_KEY = 'frt-last-good-state-v1';
  const OFFLINE_GRACE_MS = 15000;
  const FAILURES_BEFORE_OFFLINE = 3;
  const CACHE_MAX_AGE_MS = 60000;
  const ATTACK_ENERGY_COST = 25;
  const LOW_HEALTH_PERCENT = 25;

  let rotation = [];
  let chainSeconds = null;
  let hitTimeSeconds = null;
  let chainDeadlineAt = null;
  let chainTickTimer = null;
  let maintenanceTimer = null;
  let viewerTornId = null;
  let apiOnline = false;
  let lastError = '';
  let pollTimer = null;
  let writePending = false;
  let consecutiveFailures = 0;
  let lastSuccessAt = 0;
  let canManageRotation = false;
  let authRequired = false;
  let authDiagnostic = null;
  let authDiagnosticAlerted = false;
  let pdaDeviceProof = '';
  let alertBaselineInitialized = false;
  let lastAlertStage = null;
  let alertHideTimer = null;
  let audioContext = null;
  let audioRunId = 0;

  const enabled = () => localStorage.getItem(KEY_ENABLED) !== 'false';
  const setEnabled = v => localStorage.setItem(KEY_ENABLED, String(v));


  const DEFAULT_SETTINGS = Object.freeze({
    visualAlerts: true,
    readinessAlerts: true,
    getReadyAlert: true,
    nextAlert: true,
    upNowAlert: true,
    attackNowAlert: true,
    audioAlerts: false,
    audioReadiness: true,
    audioGetReady: true,
    audioNext: true,
    audioUpNow: true,
    audioAttackNow: true,
    audioVolume: 60
  });

  function loadSettings() {
    try {
      const raw = scriptStorageGet(SETTINGS_KEY, '');
      const parsed = raw ? JSON.parse(raw) : {};
      return Object.assign({}, DEFAULT_SETTINGS, parsed && typeof parsed === 'object' ? parsed : {});
    } catch (_) {
      return Object.assign({}, DEFAULT_SETTINGS);
    }
  }

  function saveSettings(settings) {
    scriptStorageSet(SETTINGS_KEY, JSON.stringify(Object.assign({}, DEFAULT_SETTINGS, settings || {})));
  }

  function closeSettings() { document.getElementById(SETTINGS_ID)?.remove(); }
  function closeTransitionAlert() {
    document.getElementById(ALERT_ID)?.remove();
    if (alertHideTimer !== null) window.clearTimeout(alertHideTimer);
    alertHideTimer = null;
  }

  function alertDefinition(stage, detail = '') {
    const definitions = {
      blocked: { title: 'NOT READY', detail: detail || 'Your current status prevents an attack.', kind: 'danger', duration: 6500 },
      return_ready: { title: 'RETURN READY', detail: 'Your blocking condition has cleared. Return when you are ready.', kind: 'ready', duration: 6000 },
      get_ready: { title: 'GET READY', detail: 'You are In the Hole. Prepare for your upcoming turn.', kind: 'ready', duration: 4500 },
      next: { title: "YOU'RE NEXT", detail: 'You are On Deck. Be ready to take over the chain.', kind: 'next', duration: 5500 },
      up_now: { title: 'UP NOW', detail: 'You own the current rotation turn. Watch the chain timer.', kind: 'up', duration: 7000 },
      attack_now: { title: 'ATTACK NOW', detail: 'The configured hit window has arrived.', kind: 'attack', duration: 10000 }
    };
    return definitions[stage] || null;
  }

  function stageEnabled(stage, settings = loadSettings()) {
    if (!settings.visualAlerts) return false;
    if (stage === 'blocked' || stage === 'return_ready') return Boolean(settings.readinessAlerts);
    if (stage === 'get_ready') return Boolean(settings.getReadyAlert);
    if (stage === 'next') return Boolean(settings.nextAlert);
    if (stage === 'up_now') return Boolean(settings.upNowAlert);
    if (stage === 'attack_now') return Boolean(settings.attackNowAlert);
    return false;
  }

  function audioStageEnabled(stage, settings = loadSettings()) {
    if (!settings.audioAlerts) return false;
    if (stage === 'blocked' || stage === 'return_ready') return Boolean(settings.audioReadiness);
    if (stage === 'get_ready') return Boolean(settings.audioGetReady);
    if (stage === 'next') return Boolean(settings.audioNext);
    if (stage === 'up_now') return Boolean(settings.audioUpNow);
    if (stage === 'attack_now') return Boolean(settings.audioAttackNow);
    return false;
  }

  function audioPattern(stage) {
    const patterns = {
      blocked: [
        { at: 0, frequency: 300, duration: 150, gain: 0.55 },
        { at: 230, frequency: 260, duration: 220, gain: 0.62 }
      ],
      return_ready: [
        { at: 0, frequency: 480, duration: 130, gain: 0.42 },
        { at: 145, frequency: 620, duration: 180, gain: 0.48 }
      ],
      get_ready: [
        { at: 0, frequency: 440, duration: 120, gain: 0.38 },
        { at: 160, frequency: 540, duration: 150, gain: 0.42 }
      ],
      next: [
        { at: 0, frequency: 610, duration: 130, gain: 0.48 },
        { at: 190, frequency: 610, duration: 130, gain: 0.48 }
      ],
      up_now: [
        { at: 0, frequency: 720, duration: 130, gain: 0.52 },
        { at: 170, frequency: 820, duration: 130, gain: 0.56 },
        { at: 340, frequency: 920, duration: 180, gain: 0.60 }
      ],
      attack_now: [
        { at: 0, frequency: 900, duration: 150, gain: 0.72 },
        { at: 190, frequency: 1100, duration: 150, gain: 0.76 },
        { at: 380, frequency: 900, duration: 150, gain: 0.72 },
        { at: 570, frequency: 1100, duration: 220, gain: 0.80 },
        { at: 1050, frequency: 900, duration: 150, gain: 0.72 },
        { at: 1240, frequency: 1100, duration: 220, gain: 0.80 }
      ]
    };
    return patterns[stage] || [];
  }

  function ensureAudioContext() {
    if (audioContext && audioContext.state !== 'closed') return audioContext;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try { audioContext = new AudioCtor(); } catch (_) { audioContext = null; }
    return audioContext;
  }

  async function primeAudio() {
    const context = ensureAudioContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') await context.resume();
      return context.state === 'running';
    } catch (_) {
      return false;
    }
  }

  function scheduleTone(context, masterGain, step, baseTime) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startAt = baseTime + Math.max(0, Number(step.at) || 0) / 1000;
    const duration = Math.max(0.04, (Number(step.duration) || 120) / 1000);
    const peak = Math.max(0.0001, Math.min(1, Number(step.gain) || 0.5));
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(Math.max(80, Number(step.frequency) || 440), startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + Math.min(0.025, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(masterGain);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  async function playStageAudio(stage, { preview = false } = {}) {
    const settings = loadSettings();
    if (!preview && !audioStageEnabled(stage, settings)) return false;
    const pattern = audioPattern(stage);
    if (!pattern.length) return false;
    const context = ensureAudioContext();
    if (!context) return false;
    try {
      if (context.state === 'suspended') await context.resume();
      if (context.state !== 'running') return false;
      const runId = ++audioRunId;
      const master = context.createGain();
      const volume = Math.max(0, Math.min(100, Number(settings.audioVolume) || 0)) / 100;
      master.gain.setValueAtTime(Math.max(0.0001, volume), context.currentTime);
      master.connect(context.destination);
      const baseTime = context.currentTime + 0.015;
      pattern.forEach(step => scheduleTone(context, master, step, baseTime));
      const endMs = Math.max(...pattern.map(step => (Number(step.at) || 0) + (Number(step.duration) || 120))) + 100;
      window.setTimeout(() => {
        if (runId <= audioRunId) {
          try { master.disconnect(); } catch (_) {}
        }
      }, endMs);
      return true;
    } catch (_) {
      return false;
    }
  }

  function showTransitionAlert(stage, detail = '', { preview = false, audio = true } = {}) {
    const settings = loadSettings();
    const visualAllowed = preview || stageEnabled(stage, settings);
    const audioAllowed = audio && (preview || audioStageEnabled(stage, settings));
    if (!visualAllowed && !audioAllowed) return;
    const def = alertDefinition(stage, detail);
    if (!def) return;
    if (audioAllowed) void playStageAudio(stage, { preview });
    if (!visualAllowed) return;
    closeTransitionAlert();
    const node = document.createElement('div');
    node.id = ALERT_ID;
    node.className = `frt-alert frt-alert-${def.kind}`;
    node.setAttribute('role', 'status');
    node.innerHTML = `<button type="button" class="frt-alert-close" aria-label="Dismiss">×</button><strong>${esc(def.title)}</strong><span>${esc(def.detail)}</span>`;
    document.body.appendChild(node);
    node.querySelector('.frt-alert-close')?.addEventListener('click', closeTransitionAlert);
    alertHideTimer = window.setTimeout(closeTransitionAlert, def.duration);
  }

  function viewerOperationalStage() {
    const member = viewerRotationMember();
    if (!member) return { stage: null, detail: '' };
    const blocker = attackBlockerFor(member);
    const skipped = member.rotationStatus === 'skip' || member.rotationStatus === 'away';
    if (skipped) {
      if (!blocker) return { stage: 'return_ready', detail: '' };
      return { stage: 'blocked', detail: blocker.label };
    }
    if (blocker) return { stage: 'blocked', detail: blocker.label };
    if (member.role === 'in-hole') return { stage: 'get_ready', detail: '' };
    if (member.role === 'on-deck') return { stage: 'next', detail: '' };
    if (member.role === 'up') {
      const current = currentChainSeconds();
      const threshold = Number(hitTimeSeconds);
      if (Number.isFinite(threshold) && threshold >= 0 && current !== null && current <= threshold) {
        return { stage: 'attack_now', detail: '' };
      }
      return { stage: 'up_now', detail: '' };
    }
    return { stage: null, detail: '' };
  }

  function storedAlertStage() {
    try {
      const value = sessionStorage.getItem(ALERT_STAGE_KEY);
      return value === null ? undefined : (value || null);
    } catch (_) {
      return undefined;
    }
  }

  function rememberAlertStage(stage) {
    try { sessionStorage.setItem(ALERT_STAGE_KEY, stage || ''); } catch (_) {}
  }

  function evaluateAlertTransition({ rerender = false } = {}) {
    if (authRequired || !apiOnline) return;
    const current = viewerOperationalStage();
    if (!alertBaselineInitialized) {
      alertBaselineInitialized = true;
      const stored = storedAlertStage();
      lastAlertStage = stored === undefined ? current.stage : stored;
      rememberAlertStage(current.stage);
      // A page/layout reinjection must never turn an unchanged status into a
      // fresh alert. Only a real Coordinator state transition after baseline
      // initialization is allowed to notify the user.
      return;
    }
    if (current.stage === lastAlertStage) return;
    lastAlertStage = current.stage;
    rememberAlertStage(current.stage);
    if (current.stage && alertClaim(current.stage, current.detail)) showTransitionAlert(current.stage, current.detail);
    if (rerender && document.getElementById(ROOT_ID)) render();
  }

  function alertClaim(stage, detail = '') {
    if (!stage) return true;
    const signature = `${stage}|${String(detail || '').trim().toUpperCase()}`;
    try {
      const raw = sessionStorage.getItem(ALERT_CLAIM_KEY);
      const previous = raw ? JSON.parse(raw) : null;
      const now = Date.now();
      // Multiple userscript instances can briefly overlap during Torn/PDA SPA
      // navigation or viewport reinjection. Only the first instance may claim
      // an unchanged semantic alert within this short guard window.
      if (previous && previous.signature === signature && now - Number(previous.at || 0) < 30000) return false;
      sessionStorage.setItem(ALERT_CLAIM_KEY, JSON.stringify({ signature, at: now }));
    } catch (_) {}
    return true;
  }

  function ordinal(value) {
    const n = Math.max(1, Number(value) || 1);
    const mod100 = n % 100;
    const suffix = mod100 >= 11 && mod100 <= 13 ? 'TH' : ({1:'ST',2:'ND',3:'RD'}[n % 10] || 'TH');
    return `${n}${suffix}`;
  }

  function compactStatus(member) {
    if (!member) return '';
    const readiness = readinessFor(member);
    if (readiness) {
      return readiness.label.replace(/^SKIP · /, '').replace(/^SKIPPED · /, '').replace(/^RETURN READY$/, 'READY');
    }
    const status = String(member.status || '').trim();
    return status && !/^okay$|^ready$/i.test(status) ? status.toUpperCase() : '';
  }

  function compactMemberButton(member, kind) {
    if (!member) return `<span class="frt-compact-person frt-compact-${kind} frt-compact-empty">—</span>`;
    return `<button type="button" class="frt-compact-person frt-compact-${kind}" data-rotation-id="${esc(member.rotationUserId)}" title="${esc(member.name)}">${esc(member.name)}</button>`;
  }

  function compactViewerRow() {
    const member = viewerRotationMember();
    if (!member) return `<div class="frt-compact-me frt-compact-me-empty">YOU · NOT IN ROTATION</div>`;
    const index = rotation.findIndex(candidate => candidate.rotationUserId === member.rotationUserId);
    const place = index >= 0 ? index + 1 : (Number(member.position) || 1);
    const status = compactStatus(member);
    const skipped = viewerIsSkipped();
    const state = [ordinal(place), skipped ? 'SKIPPED' : '', status].filter(Boolean).join(' · ');
    return `<button type="button" class="frt-compact-me" data-rotation-id="${esc(member.rotationUserId)}"><span class="frt-compact-me-name">${esc(member.name)}</span><span class="frt-compact-you">YOU</span><span class="frt-compact-me-state">${esc(state)}</span></button>`;
  }

  function openSettings() {
    closeSettings();
    const settings = loadSettings();
    const modal = document.createElement('div');
    modal.id = SETTINGS_ID;
    modal.innerHTML = `<div class="frt-settings-card" role="dialog" aria-modal="true" aria-label="Faction War Coordinator settings">
      <div class="frt-settings-head"><div><strong>ROTATION SETTINGS</strong><small>These preferences are stored on this device.</small></div><button type="button" class="frt-settings-close" aria-label="Close">×</button></div>
      <div class="frt-settings-section"><strong>IN-PAGE ALERTS</strong>
        <label><span>Enable visual alerts</span><input type="checkbox" data-setting="visualAlerts" ${settings.visualAlerts ? 'checked' : ''}></label>
        <label><span>Readiness / unavailable alerts</span><input type="checkbox" data-setting="readinessAlerts" ${settings.readinessAlerts ? 'checked' : ''}></label>
        <label><span>GET READY</span><input type="checkbox" data-setting="getReadyAlert" ${settings.getReadyAlert ? 'checked' : ''}></label>
        <label><span>YOU'RE NEXT</span><input type="checkbox" data-setting="nextAlert" ${settings.nextAlert ? 'checked' : ''}></label>
        <label><span>UP NOW</span><input type="checkbox" data-setting="upNowAlert" ${settings.upNowAlert ? 'checked' : ''}></label>
        <label><span>ATTACK NOW</span><input type="checkbox" data-setting="attackNowAlert" ${settings.attackNowAlert ? 'checked' : ''}></label>
      </div>
      <div class="frt-settings-section"><strong>AUDIO ALERTS</strong>
        <label><span>Enable audio alerts</span><input type="checkbox" data-setting="audioAlerts" ${settings.audioAlerts ? 'checked' : ''}></label>
        <label><span>Readiness / unavailable sound</span><input type="checkbox" data-setting="audioReadiness" ${settings.audioReadiness ? 'checked' : ''}></label>
        <label><span>GET READY sound</span><input type="checkbox" data-setting="audioGetReady" ${settings.audioGetReady ? 'checked' : ''}></label>
        <label><span>YOU'RE NEXT sound</span><input type="checkbox" data-setting="audioNext" ${settings.audioNext ? 'checked' : ''}></label>
        <label><span>UP NOW sound</span><input type="checkbox" data-setting="audioUpNow" ${settings.audioUpNow ? 'checked' : ''}></label>
        <label><span>ATTACK NOW sound</span><input type="checkbox" data-setting="audioAttackNow" ${settings.audioAttackNow ? 'checked' : ''}></label>
        <label class="frt-volume-row"><span>Audio volume <b class="frt-volume-value">${Math.max(0, Math.min(100, Number(settings.audioVolume) || 0))}%</b></span><input type="range" min="0" max="100" step="5" data-setting="audioVolume" value="${Math.max(0, Math.min(100, Number(settings.audioVolume) || 0))}"></label>
        <small>Audio is off by default. Use the test buttons below once on each device to verify that browser/PDA audio is permitted.</small><small class="frt-audio-status">Audio test status: not tested on this page.</small>
      </div>
      <div class="frt-settings-section"><strong>PREVIEW / TEST ALERTS</strong><div class="frt-preview-grid"><button data-preview="get_ready">GET READY</button><button data-preview="next">YOU'RE NEXT</button><button data-preview="up_now">UP NOW</button><button data-preview="attack_now">ATTACK NOW</button><button data-preview="blocked">NOT READY</button><button data-preview="return_ready">RETURN READY</button></div><small>Preview buttons show the visual alert and play that stage's sound even if audio alerts are currently disabled.</small></div>
      <div class="frt-settings-actions"><button type="button" class="frt-settings-cancel">CANCEL</button><button type="button" class="frt-settings-save">SAVE</button></div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('.frt-settings-close')?.addEventListener('click', closeSettings);
    modal.querySelector('.frt-settings-cancel')?.addEventListener('click', closeSettings);
    modal.querySelector('.frt-settings-save')?.addEventListener('click', () => {
      const next = Object.assign({}, settings);
      modal.querySelectorAll('[data-setting]').forEach(input => {
        next[input.dataset.setting] = input.type === 'range' ? Number(input.value) : Boolean(input.checked);
      });
      saveSettings(next);
      if (next.audioAlerts) void primeAudio();
      closeSettings();
    });
    const volumeInput = modal.querySelector('input[type="range"][data-setting="audioVolume"]');
    const volumeValue = modal.querySelector('.frt-volume-value');
    volumeInput?.addEventListener('input', () => { if (volumeValue) volumeValue.textContent = `${volumeInput.value}%`; });
    const audioStatus = modal.querySelector('.frt-audio-status');
    modal.querySelectorAll('[data-preview]').forEach(button => button.addEventListener('click', async () => {
      const audioReady = await primeAudio();
      if (audioStatus) audioStatus.textContent = audioReady ? 'Audio test status: ready.' : 'Audio test status: blocked or unavailable on this page/device.';
      showTransitionAlert(button.dataset.preview, '', { preview: true, audio: true });
    }));
    modal.addEventListener('pointerdown', event => { if (event.target === modal) closeSettings(); });
  }

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


  function currentChainSeconds() {
    if (chainDeadlineAt === null) return chainSeconds;
    return Math.max(0, Math.ceil((chainDeadlineAt - Date.now()) / 1000));
  }

  function updateChainTimerDisplay() {
    const value = formatChain(currentChainSeconds());
    const timer = document.querySelector(`#${ROOT_ID} .frt-timer strong`);
    if (timer) timer.textContent = value;
    const compactTimer = document.querySelector(`#${ROOT_ID} .frt-compact-timer-value`);
    if (compactTimer) compactTimer.textContent = value;
    if (!timer && !compactTimer) return;
    evaluateAlertTransition({ rerender: true });
  }

  function scheduleChainTick() {
    if (!enabled()) return;
    updateChainTimerDisplay();

    // The UI only displays whole seconds. Wake once near the next visible
    // second boundary instead of four times per second. This keeps the timer
    // fluid while avoiding needless DOM work during Torn combat animations.
    const remainingMs = chainDeadlineAt === null
      ? 1000
      : Math.max(0, chainDeadlineAt - Date.now());
    const fractional = remainingMs % 1000;
    const delay = Math.max(100, Math.min(1000, fractional || 1000));
    chainTickTimer = window.setTimeout(scheduleChainTick, delay);
  }

  function startChainTicker() {
    stopChainTicker();
    scheduleChainTick();
  }

  function stopChainTicker() {
    if (chainTickTimer !== null) window.clearTimeout(chainTickTimer);
    chainTickTimer = null;
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

  function viewerRotationMember() {
    if (viewerTornId === null) return null;
    return rotation.find(m => m.tornId === viewerTornId) || null;
  }

  function viewerIsSkipped() {
    const member = viewerRotationMember();
    if (!member) return false;
    const status = String(member.rotationStatus || '').toLowerCase();
    return status === 'skip' || status === 'away';
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

    // PDA/mobile shows the viewer plus up to two people immediately ahead,
    // but never duplicates a member when the rotation contains fewer than 3.
    const count = Math.min(3, rotation.length);
    const members = [];
    for (let offset = count - 1; offset >= 0; offset -= 1) {
      const index = (me - offset + rotation.length) % rotation.length;
      const member = rotation[index];
      if (member && !members.some(existing => existing.rotationUserId === member.rotationUserId)) {
        members.push(member);
      }
    }
    return members;
  }

  function attackBlockerFor(m) {
    const status = String(m.status || '').trim();
    const lower = status.toLowerCase();
    const statusIsReady = !status || /^okay$/i.test(status) || /^ready$/i.test(status);

    if (!statusIsReady) {
      if (/hospital/.test(lower)) return { label: 'HOSPITALIZED', reason: 'You are hospitalized and cannot attack.' };
      if (/travel|abroad|flying/.test(lower)) return { label: 'TRAVELING', reason: 'You are traveling and cannot attack.' };
      if (/jail|jailed/.test(lower)) return { label: 'JAILED', reason: 'You are jailed and cannot attack.' };
      return { label: status.toUpperCase(), reason: `Current status: ${status}` };
    }
    if (m.energy !== null && Number(m.energy) < ATTACK_ENERGY_COST) {
      return { label: 'LOW ENERGY', reason: `${m.energy} energy available; a normal attack costs ${ATTACK_ENERGY_COST}.` };
    }
    return null;
  }

  function readinessFor(m) {
    const me = viewerTornId !== null && m.tornId === viewerTornId;
    if (!me) return null;

    const skipped = m.rotationStatus === 'skip' || m.rotationStatus === 'away';
    const blocker = attackBlockerFor(m);

    if (skipped) {
      if (blocker) {
        return { label: `SKIPPED · ${blocker.label}`, kind: 'paused', title: `${blocker.reason} Stay skipped until this clears.` };
      }
      return { label: 'RETURN READY', kind: 'go', action: 'return', title: 'You appear ready to attack again. Tap to return to the active rotation.' };
    }

    if (blocker) {
      return { label: `SKIP · ${blocker.label}`, kind: 'danger', action: 'skip', title: `${blocker.reason} Tap to skip yourself while keeping your rotation place.` };
    }
    if (m.health !== null && Number(m.health) <= LOW_HEALTH_PERCENT) {
      return { label: 'LOW HEALTH', kind: 'warning', title: `Health is ${m.health}%. This is a warning only; you remain active.` };
    }
    if (m.role === 'up') {
      const current = currentChainSeconds();
      const threshold = Number(hitTimeSeconds);
      const attackWindow = Number.isFinite(threshold) && threshold >= 0 && current !== null && current <= threshold;
      return attackWindow
        ? { label: 'ATTACK NOW', kind: 'go', title: 'The configured hit window has arrived.' }
        : { label: 'UP NOW', kind: 'go', title: 'You own the current turn. Watch the chain timer for the hit window.' };
    }
    if (m.role === 'on-deck') return { label: "YOU'RE NEXT", kind: 'next', title: 'You are On Deck.' };
    if (m.role === 'in-hole') return { label: 'GET READY', kind: 'ready', title: 'You are In the Hole.' };
    return null;
  }

  function targetHTML(m, target) {
    if (!m.attackUrl) return `<span>${esc(target)}</span>`;
    return `<span class="frt-target-hit" data-attack-url="${esc(m.attackUrl)}" title="Attack ${esc(target)}">${esc(target)} <span class="frt-target-open">↗</span></span>`;
  }

  function memberHTML(m) {
    const me = viewerTornId !== null && m.tornId === viewerTornId;
    const warning = m.status && !/^okay$/i.test(m.status) && !/^ready$/i.test(m.status);
    const target = m.target || '—';
    const targetMarkup = targetHTML(m, target);
    const readiness = readinessFor(m);
    const secondary = m.role === 'normal'
      ? `<span class="frt-arrow">→</span>${targetMarkup}`
      : `<b>${esc(roleLabel(m))}</b><span> • </span>${targetMarkup}`;

    return `<button type="button" class="frt-member frt-${m.role} ${me ? 'frt-me' : ''} ${readiness ? `frt-readiness-${readiness.kind}` : ''}" data-rotation-id="${m.rotationUserId}">
      <span class="frt-line1">
        <span class="frt-name">${esc(m.name)}</span>
        ${me ? '<span class="frt-you">YOU</span>' : ''}
        <span class="frt-dot">•</span>
        <span class="frt-eta">${esc(m.eta)}</span>
        ${warning ? '<span class="frt-warn">!</span>' : ''}
      </span>
      <span class="frt-line2">${secondary}</span>
      ${readiness ? `<span class="frt-readiness ${readiness.action ? 'frt-readiness-action' : ''}" ${readiness.action ? `data-readiness-action="${readiness.action}"` : ''} title="${esc(readiness.title)}">${esc(readiness.label)}</span>` : ''}
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

  function viewStateSignature() {
    return JSON.stringify({
      viewerTornId,
      canManageRotation,
      authRequired,
      apiOnline,
      lastError,
      hitTimeSeconds,
      members: rotation.map(m => ({
        id: m.rotationUserId, tornId: m.tornId, name: m.name, eta: m.eta,
        target: m.target, targetId: m.targetId, attackUrl: m.attackUrl,
        energy: m.energy, health: m.health, status: m.status, role: m.role,
        rotationStatus: m.rotationStatus, position: m.position
      }))
    });
  }

  function applyState(data, options = {}) {
    const previousView = viewStateSignature();
    if (!data.ok || !Array.isArray(data.members)) throw new Error(data.error || 'Invalid Coordinator response');
    rotation = data.members.map(normalizeMember);
    const reportedHitTime = Number(data.hit_time_seconds);
    hitTimeSeconds = Number.isFinite(reportedHitTime) && reportedHitTime >= 0 ? reportedHitTime : null;
    chainSeconds = data.chain_seconds;
    if (chainSeconds === null || chainSeconds === undefined) {
      chainDeadlineAt = null;
    } else {
      const serverDeadline = Number(data.chain_deadline_at_ms);
      const serverSampledAt = Number(data.chain_sampled_at_ms);
      if (Number.isFinite(serverDeadline) && serverDeadline > 0) {
        // v0.13.2+: use the Coordinator's absolute deadline. This preserves
        // the fractional observation time and automatically subtracts the
        // time spent crossing Funnel/network/WebView before this response
        // reached the browser.
        chainDeadlineAt = serverDeadline;
      } else if (Number.isFinite(serverSampledAt) && serverSampledAt > 0) {
        // Compatibility fallback for a backend that exposes only the sample
        // timestamp. Subtract response age instead of restarting a stale
        // integer countdown on arrival.
        const responseAgeMs = Math.max(0, Date.now() - serverSampledAt);
        chainDeadlineAt = Date.now()
          + Math.max(0, (Number(chainSeconds) || 0) * 1000 - responseAgeMs);
      } else {
        // Legacy backend fallback.
        chainDeadlineAt = Date.now() + Math.max(0, Number(chainSeconds) || 0) * 1000;
      }
    }
    canManageRotation = Boolean(data.permissions && data.permissions.manage_rotation);
    if (data.viewer && data.viewer.torn_id) viewerTornId = Number(data.viewer.torn_id);
    authRequired = false;
    authDiagnostic = null;
    authDiagnosticAlerted = false;
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

    evaluateAlertTransition();
    return previousView !== viewStateSignature();
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

  function gmStorageValue(key, fallback = '') {
    try {
      if (typeof GM_getValue !== 'function') return fallback;
      const value = GM_getValue(key, fallback);
      // Some userscript hosts expose Promise-based GM storage. This script's
      // request path is synchronous, so ignore Promise-like values and use the
      // localStorage mirror instead.
      if (value && typeof value.then === 'function') return fallback;
      return value ?? fallback;
    } catch (_) { return fallback; }
  }
  function localStorageValue(key, fallback = '') {
    try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  }
  function scriptStorageGet(key, fallback = '') {
    const gmValue = gmStorageValue(key, '');
    if (gmValue !== '') return gmValue;
    return localStorageValue(key, fallback);
  }
  function scriptStorageSet(key, value) {
    // Dual-write. Tampermonkey gets durable userscript storage while TornPDA
    // has a localStorage mirror for hosts where GM storage is partial or
    // behaves differently.
    try {
      if (typeof GM_setValue === 'function') {
        const result = GM_setValue(key, value);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch (_) {}
    try { localStorage.setItem(key, value); } catch (_) {}
  }
  function scriptStorageDelete(key) {
    try {
      if (typeof GM_deleteValue === 'function') {
        const result = GM_deleteValue(key);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      }
    } catch (_) {}
    try { localStorage.removeItem(key); } catch (_) {}
  }
  function migrateAuthStorage() {
    try {
      const token = gmStorageValue(TOKEN_KEY, '') || localStorageValue(TOKEN_KEY, '');
      if (token) scriptStorageSet(TOKEN_KEY, token);
      const deviceName = gmStorageValue(DEVICE_NAME_KEY, '') || localStorageValue(DEVICE_NAME_KEY, '');
      if (deviceName) scriptStorageSet(DEVICE_NAME_KEY, deviceName);
    } catch (_) {}
  }

  function hasTornPdaApiKey() {
    return typeof PDA_API_KEY === 'string' && PDA_API_KEY.length >= 8 && !PDA_API_KEY.includes('###');
  }

  function stablePdaFingerprint() {
    const sw = Number(screen?.width || 0);
    const sh = Number(screen?.height || 0);
    const dims = [sw, sh].sort((a, b) => a - b).join('x');
    return [
      navigator.userAgent || '',
      navigator.platform || '',
      dims,
      String(window.devicePixelRatio || 1)
    ].join('|');
  }

  function sha256HexFallback(text) {
    // Pure-JavaScript SHA-256 fallback for TornPDA WebViews where Web Crypto
    // is unavailable. This hashes locally; the Torn API key is never sent.
    const k = [
      0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,
        h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
    const input = unescape(encodeURIComponent(String(text)));
    const bytes = Array.from(input, ch => ch.charCodeAt(0));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    const high = Math.floor(bitLen / 0x100000000);
    const low = bitLen >>> 0;
    bytes.push((high>>>24)&255,(high>>>16)&255,(high>>>8)&255,high&255,(low>>>24)&255,(low>>>16)&255,(low>>>8)&255,low&255);
    const rotr = (x,n) => (x>>>n)|(x<<(32-n));
    for (let offset=0; offset<bytes.length; offset+=64) {
      const w = new Array(64);
      for (let i=0;i<16;i++) {
        const j=offset+i*4;
        w[i]=((bytes[j]<<24)|(bytes[j+1]<<16)|(bytes[j+2]<<8)|bytes[j+3])>>>0;
      }
      for (let i=16;i<64;i++) {
        const s0=(rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3))>>>0;
        const s1=(rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10))>>>0;
        w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;
      }
      let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,h=h7;
      for (let i=0;i<64;i++) {
        const S1=(rotr(e,6)^rotr(e,11)^rotr(e,25))>>>0;
        const ch=((e&f)^((~e)&g))>>>0;
        const t1=(h+S1+ch+k[i]+w[i])>>>0;
        const S0=(rotr(a,2)^rotr(a,13)^rotr(a,22))>>>0;
        const maj=((a&b)^(a&c)^(b&c))>>>0;
        const t2=(S0+maj)>>>0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      h0=(h0+a)>>>0; h1=(h1+b)>>>0; h2=(h2+c)>>>0; h3=(h3+d)>>>0;
      h4=(h4+e)>>>0; h5=(h5+f)>>>0; h6=(h6+g)>>>0; h7=(h7+h)>>>0;
    }
    return [h0,h1,h2,h3,h4,h5,h6,h7].map(v=>v.toString(16).padStart(8,'0')).join('');
  }

  async function sha256Hex(value) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle && typeof TextEncoder !== 'undefined') {
      try {
        const bytes = new TextEncoder().encode(value);
        const digest = await subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      } catch (_) {
        // Fall through to the WebView-safe implementation below.
      }
    }
    return sha256HexFallback(value);
  }

  async function initializePdaDeviceProof() {
    pdaDeviceProof = '';
    if (!hasTornPdaApiKey()) return;
    try {
      // The raw Torn API key never leaves this device. Only this one-way proof
      // is sent to the Coordinator. It is recreated after every PDA restart,
      // removing any dependence on Torn page localStorage.
      const seed = `fwc-pda-v1|${PDA_API_KEY}|${stablePdaFingerprint()}`;
      pdaDeviceProof = `pda_${await sha256Hex(seed)}`;
    } catch (err) {
      console.warn('Faction War Coordinator could not derive PDA device proof', err);
      pdaDeviceProof = '';
    }
  }

  function hasAuthCredential() {
    return Boolean(authToken() || pdaDeviceProof);
  }

  function fwcHttpRequest(options) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const url = options.url;
    const body = options.data ?? '';

    const nativeGet = typeof PDA_httpGet === 'function' ? PDA_httpGet : null;
    const nativePost = typeof PDA_httpPost === 'function' ? PDA_httpPost : null;
    const canUsePda = (method === 'GET' && nativeGet) || (method === 'POST' && nativePost);
    const transport = canUsePda ? 'PDA' : 'GM';

    if (!canUsePda) {
      const originalOnload = options.onload;
      return GM_xmlhttpRequest(Object.assign({}, options, {
        onload: response => {
          response._fwcTransport = transport;
          response._fwcRawKeys = response && typeof response === 'object' ? Object.keys(response).sort() : [];
          if (typeof originalOnload === 'function') originalOnload(response);
        }
      }));
    }

    let settled = false;
    const timeoutMs = Number(options.timeout || 0);
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (typeof options.ontimeout === 'function') options.ontimeout();
      }, timeoutMs);
    }

    let request;
    try {
      request = method === 'GET'
        ? nativeGet(url, headers)
        : nativePost(url, headers, body);
    } catch (error) {
      if (timer) clearTimeout(timer);
      settled = true;
      if (typeof options.onerror === 'function') options.onerror(error);
      return null;
    }

    Promise.resolve(request).then(response => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      // TornPDA has changed its response wrapper across versions. Capture and
      // normalize several likely field names, but retain the raw key list for
      // diagnostics so we can see what this particular PDA build returned.
      const statusCandidate = response?.status ?? response?.statusCode ?? response?.code ?? response?.httpStatus ?? 0;
      const textCandidate = response?.responseText ?? response?.body ?? response?.data ?? response?.response ?? '';
      const normalizedText = typeof textCandidate === 'string'
        ? textCandidate
        : (() => { try { return JSON.stringify(textCandidate ?? ''); } catch (_) { return String(textCandidate ?? ''); } })();

      if (typeof options.onload === 'function') {
        options.onload({
          status: Number(statusCandidate || 0),
          statusText: String(response?.statusText ?? response?.message ?? ''),
          responseText: normalizedText,
          responseHeaders: String(response?.responseHeaders ?? response?.headers ?? ''),
          _fwcTransport: transport,
          _fwcRawKeys: response && typeof response === 'object' ? Object.keys(response).sort() : [],
          _fwcRawType: Object.prototype.toString.call(response)
        });
      }
    }).catch(error => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof options.onerror === 'function') options.onerror(error);
    });

    return null;
  }

  function authToken() { return String(scriptStorageGet(TOKEN_KEY, '') || ''); }
  function authHeaders(extra = {}) {
    const token = authToken();
    if (token) return Object.assign({}, extra, { 'Authorization': `Bearer ${token}` });
    if (pdaDeviceProof) return Object.assign({}, extra, { 'X-FWC-PDA-Proof': pdaDeviceProof });
    return Object.assign({}, extra);
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
  function clearAuth({ deleteToken = true } = {}) {
    if (deleteToken) scriptStorageDelete(TOKEN_KEY);
    authRequired = true;
    canManageRotation = false;
  }
  function diagnosticSummary() {
    if (!authDiagnostic) return '';
    return `AUTH FAILED · ${authDiagnostic.transport} · token=${authDiagnostic.tokenPresent ? 'yes' : 'no'} · pda=${authDiagnostic.pdaProofPresent ? 'yes' : 'no'} · HTTP=${authDiagnostic.httpStatus}`;
  }
  function diagnosticDetails() {
    if (!authDiagnostic) return 'No authentication diagnostic has been recorded yet.';
    return [
      'Faction War Coordinator auth diagnostic',
      `Version: 0.13.1`,
      `Transport: ${authDiagnostic.transport}`,
      `Token present before request: ${authDiagnostic.tokenPresent ? 'yes' : 'no'}`,
      `Token length: ${authDiagnostic.tokenLength}`,
      `PDA proof present: ${authDiagnostic.pdaProofPresent ? 'yes' : 'no'}`,
      `HTTP status: ${authDiagnostic.httpStatus}`,
      `Server auth_required: ${authDiagnostic.authRequired ? 'yes' : 'no'}`,
      `Server error: ${authDiagnostic.serverError || '(none)'}`,
      `Response keys: ${authDiagnostic.responseKeys.join(', ') || '(none)'}`,
      `Response preview: ${authDiagnostic.responsePreview || '(empty)'}`
    ].join('\n');
  }
  function recordAuthDiagnostic(response, data = {}) {
    const token = authToken();
    authDiagnostic = {
      transport: String(response?._fwcTransport || 'unknown'),
      tokenPresent: Boolean(token),
      tokenLength: token.length,
      httpStatus: Number(response?.status ?? 0),
      authRequired: Boolean(data && data.auth_required),
      serverError: String(data?.error || ''),
      responseKeys: Array.isArray(response?._fwcRawKeys) ? response._fwcRawKeys : [],
      responsePreview: String(response?.responseText || '').slice(0, 240).replace(/\s+/g, ' ')
    };
    // Diagnostic build deliberately preserves the token. A single rejected
    // request must not destroy the evidence we are trying to inspect.
    clearAuth({ deleteToken: false });
    lastError = diagnosticSummary();
    if (!authDiagnosticAlerted) {
      authDiagnosticAlerted = true;
      setTimeout(() => alert(diagnosticDetails()), 50);
    }
  }
  function linkDevice() {
    const code = prompt('Enter the one-time code from Discord /userscript link:');
    if (!code) return;
    const remembered = scriptStorageGet(DEVICE_NAME_KEY, '') || defaultDeviceName();
    const deviceName = prompt('Name this device:', remembered) || remembered;
    fwcHttpRequest({
      method: 'POST', url: AUTH_REDEEM_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ code, device_name: deviceName, pda_proof: pdaDeviceProof || null }), timeout: 8000,
      onload: response => {
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status < 200 || response.status >= 300 || !data.ok || !data.token) throw new Error(data.error || `HTTP ${response.status}`);
          if (!pdaDeviceProof) scriptStorageSet(TOKEN_KEY, data.token);
          scriptStorageSet(DEVICE_NAME_KEY, deviceName);
          authRequired = false;
          authDiagnostic = null;
          authDiagnosticAlerted = false;
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
    fwcHttpRequest({
      method: 'POST',
      url: action === 'join' ? JOIN_URL
        : action === 'leave' ? LEAVE_URL
        : action === 'skip' ? SELF_SKIP_URL
        : SELF_RETURN_URL,
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
    fwcHttpRequest({
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
    fwcHttpRequest({
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
    fwcHttpRequest({
      method: 'GET',
      url: API_URL,
      headers: authHeaders(),
      timeout: 4000,
      onload: response => {
        try {
          const data = JSON.parse(response.responseText || '{}');
          if (response.status === 401 || data.auth_required) { recordAuthDiagnostic(response, data); render(); return; }
          if (response.status < 200 || response.status >= 300) throw new Error(data.error || `HTTP ${response.status}`);
          const viewChanged = applyState(data);
          if (viewChanged || !document.getElementById(ROOT_ID)) render();
          else updateChainTimerDisplay();
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
      #${ROOT_ID} .frt-compact { display:none; }
      #${ROOT_ID} .frt-empty { flex:1; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:10px; padding:0 12px; }
      #${ROOT_ID} .frt-member { flex:1 1 0; min-width:112px; max-width:220px; border:0; border-right:1px solid var(--border); border-top:3px solid transparent; background:transparent; color:inherit; padding:3px 7px 4px; cursor:pointer; text-align:center; }
      #${ROOT_ID} .frt-member:hover, #${ROOT_ID} .frt-member:focus-visible { background:rgba(255,255,255,.055); outline:none; }
      #${ROOT_ID} .frt-line1, #${ROOT_ID} .frt-line2 { display:flex; align-items:center; justify-content:center; gap:4px; min-width:0; white-space:nowrap; }
      #${ROOT_ID} .frt-line1 { font-size:13px; font-weight:800; line-height:16px; }
      #${ROOT_ID} .frt-line2 { font-size:9px; line-height:12px; color:var(--muted); overflow:hidden; }
      #${ROOT_ID} .frt-line2 span { overflow:hidden; text-overflow:ellipsis; }
      #${ROOT_ID} .frt-target-hit { color:#e8edf1; text-decoration:underline; text-decoration-style:dotted; text-underline-offset:2px; cursor:pointer; font-weight:800; }
      #${ROOT_ID} .frt-target-hit:hover { color:white; text-decoration-style:solid; }
      #${ROOT_ID} .frt-target-open { color:var(--deck); font-size:.9em; text-decoration:none; }
      #${ROOT_ID} .frt-readiness { display:inline-flex; align-items:center; justify-content:center; margin-top:2px; padding:1px 5px; border-radius:3px; font-size:7px; line-height:10px; font-weight:900; letter-spacing:.05em; white-space:nowrap; }
      #${ROOT_ID} .frt-readiness-danger .frt-readiness { background:rgba(255,107,107,.18); color:#ff8b8b; border:1px solid rgba(255,107,107,.52); }
      #${ROOT_ID} .frt-readiness-warning .frt-readiness { background:rgba(232,201,79,.15); color:#f0d866; border:1px solid rgba(232,201,79,.45); }
      #${ROOT_ID} .frt-readiness-paused .frt-readiness { background:rgba(170,177,184,.13); color:#c8cdd2; border:1px solid rgba(170,177,184,.38); }
      #${ROOT_ID} .frt-readiness-ready .frt-readiness { background:rgba(232,201,79,.14); color:var(--hole); border:1px solid rgba(232,201,79,.4); }
      #${ROOT_ID} .frt-readiness-next .frt-readiness { background:rgba(85,170,255,.14); color:var(--deck); border:1px solid rgba(85,170,255,.42); }
      #${ROOT_ID} .frt-readiness-go { box-shadow:inset 0 0 0 1px rgba(73,209,125,.28); }
      #${ROOT_ID} .frt-readiness-go .frt-readiness { background:rgba(73,209,125,.18); color:#72e39b; border:1px solid rgba(73,209,125,.58); }
      #${ROOT_ID} .frt-readiness-action { cursor:pointer; box-shadow:0 0 0 1px rgba(255,255,255,.08); }
      #${ROOT_ID} .frt-readiness-action:hover { filter:brightness(1.18); }
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
      #${ROOT_ID} .frt-actions { display:flex; align-items:center; gap:6px; padding:4px 9px; border-left:1px solid var(--border); }
      #${ROOT_ID} .frt-self-actions { display:flex; align-items:center; gap:5px; }
      #${ROOT_ID} .frt-joinleave { min-width:90px; height:30px; border-radius:5px; border:1px solid var(--border); color:white; font-size:10px; font-weight:900; cursor:pointer; }
      #${ROOT_ID} .frt-joinleave:disabled { opacity:.55; cursor:wait; }
      #${ROOT_ID} .frt-join { background:#286d45; } #${ROOT_ID} .frt-leave { background:#653535; } #${ROOT_ID} .frt-skip { background:#66551e; } #${ROOT_ID} .frt-return { background:#285f73; }
      #${ROOT_ID} .frt-timer-controls { display:flex; align-items:center; justify-content:center; gap:5px; min-height:10px; }
      #${ROOT_ID} .frt-off { border:0; background:transparent; color:var(--muted); font-size:7px; font-weight:800; cursor:pointer; padding:0; }
      #${ROOT_ID} .frt-off:hover { color:white; }
      #${ROOT_ID} .frt-settings-button { min-width:82px; height:30px; padding:0 9px; border:1px solid #4a5159; border-radius:5px; background:#2a3036; color:#edf1f4; font-size:9px; font-weight:900; letter-spacing:.02em; cursor:pointer; white-space:nowrap; }
      #${ROOT_ID} .frt-settings-button:hover { background:#353c43; border-color:#69737d; color:white; }
      #${ROOT_ID} .frt-settings-button:focus-visible { outline:1px solid var(--deck); outline-offset:2px; }
      #${ALERT_ID} { position:fixed; z-index:1000014; top:58px; left:50%; transform:translateX(-50%); width:min(520px,calc(100vw - 18px)); min-height:52px; display:grid; grid-template-columns:1fr auto; align-items:center; gap:2px 12px; padding:9px 34px 9px 14px; border:1px solid #4b535c; border-radius:7px; background:#1a1e22; color:#f4f6f8; box-shadow:0 10px 30px rgba(0,0,0,.48); font-family:Arial,Helvetica,sans-serif; box-sizing:border-box; }
      #${ALERT_ID} strong { grid-column:1; font-size:15px; letter-spacing:.04em; }
      #${ALERT_ID} span { grid-column:1; font-size:10px; color:#c3c9cf; }
      #${ALERT_ID} .frt-alert-close { position:absolute; top:5px; right:7px; border:0; background:transparent; color:#aab1b8; font-size:17px; cursor:pointer; }
      #${ALERT_ID}.frt-alert-ready { border-left:5px solid #e8c94f; }
      #${ALERT_ID}.frt-alert-next { border-left:5px solid #55aaff; }
      #${ALERT_ID}.frt-alert-up { border-left:5px solid #49d17d; }
      #${ALERT_ID}.frt-alert-attack { border:2px solid #ff6b6b; border-left-width:7px; box-shadow:0 10px 34px rgba(255,107,107,.2),0 10px 30px rgba(0,0,0,.5); }
      #${ALERT_ID}.frt-alert-attack strong { color:#ff8a8a; font-size:18px; }
      #${ALERT_ID}.frt-alert-danger { border-left:5px solid #ff6b6b; }
      #${SETTINGS_ID} { position:fixed; inset:0; z-index:1000016; display:grid; place-items:start center; padding:70px 10px 18px; background:rgba(0,0,0,.58); font-family:Arial,Helvetica,sans-serif; box-sizing:border-box; }
      #${SETTINGS_ID} * { box-sizing:border-box; }
      #${SETTINGS_ID} .frt-settings-card { width:min(430px,100%); max-height:calc(100vh - 88px); overflow:auto; background:#191c20; color:#f3f5f7; border:1px solid #454b53; border-radius:9px; box-shadow:0 14px 42px rgba(0,0,0,.62); padding:12px; }
      #${SETTINGS_ID} .frt-settings-head { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; padding-bottom:9px; border-bottom:1px solid #3a4047; }
      #${SETTINGS_ID} .frt-settings-head strong { font-size:14px; }
      #${SETTINGS_ID} .frt-settings-head small { display:block; margin-top:2px; color:#aab1b8; font-size:9px; }
      #${SETTINGS_ID} .frt-settings-close { border:0; background:transparent; color:#aab1b8; font-size:20px; cursor:pointer; }
      #${SETTINGS_ID} .frt-settings-section { margin-top:10px; padding:9px; border:1px solid #353b42; border-radius:6px; background:#20242a; }
      #${SETTINGS_ID} .frt-settings-section > strong { display:block; margin-bottom:5px; color:#b9c0c7; font-size:9px; letter-spacing:.08em; }
      #${SETTINGS_ID} .frt-settings-section > small { display:block; margin-top:7px; color:#8f979f; font-size:8px; line-height:1.35; }
      #${SETTINGS_ID} label { display:flex; align-items:center; justify-content:space-between; gap:12px; min-height:31px; border-bottom:1px solid #30353b; font-size:11px; }
      #${SETTINGS_ID} label:last-child { border-bottom:0; }
      #${SETTINGS_ID} input[type="checkbox"] { width:18px; height:18px; accent-color:#49d17d; }
      #${SETTINGS_ID} .frt-volume-row { display:grid; grid-template-columns:1fr 145px; }
      #${SETTINGS_ID} .frt-volume-row b { color:#f3f5f7; font-variant-numeric:tabular-nums; }
      #${SETTINGS_ID} input[type="range"] { width:145px; accent-color:#49d17d; }
      #${SETTINGS_ID} .frt-preview-grid { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
      #${SETTINGS_ID} .frt-preview-grid button { min-height:30px; border:1px solid #454b53; border-radius:4px; background:#282d33; color:#f3f5f7; font-size:9px; font-weight:800; cursor:pointer; }
      #${SETTINGS_ID} .frt-settings-actions { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:10px; }
      #${SETTINGS_ID} .frt-settings-actions button { min-height:35px; border:1px solid #454b53; border-radius:5px; color:white; font-size:10px; font-weight:900; cursor:pointer; }
      #${SETTINGS_ID} .frt-settings-cancel { background:#292e34; }
      #${SETTINGS_ID} .frt-settings-save { background:#2e7d4c; }
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
        #${ROOT_ID} .frt-bar { display:none; }
        #${ROOT_ID} .frt-compact { display:grid; grid-template-rows:auto auto auto; width:100%; min-width:0; }
        #${ROOT_ID} .frt-compact-top { display:grid; grid-template-columns:minmax(100px,1fr) auto auto auto; align-items:stretch; min-height:34px; border-bottom:1px solid var(--border); }
        #${ROOT_ID} .frt-compact-brand { display:flex; align-items:center; gap:5px; min-width:0; padding:3px 7px; font-size:9px; font-weight:900; white-space:nowrap; }
        #${ROOT_ID} .frt-compact-brand .frt-live { flex:0 0 7px; width:7px; height:7px; }
        #${ROOT_ID} .frt-compact-timer-value { color:#f3f5f7; font-size:9px; font-variant-numeric:tabular-nums; }
        #${ROOT_ID} .frt-compact-top button { min-width:0; height:34px; padding:0 8px; border:0; border-left:1px solid var(--border); border-radius:0; color:white; font-size:8px; font-weight:900; cursor:pointer; white-space:nowrap; }
        #${ROOT_ID} .frt-compact-settings { background:#2a3036; }
        #${ROOT_ID} .frt-compact-skip { background:#66551e; }
        #${ROOT_ID} .frt-compact-return { background:#285f73; }
        #${ROOT_ID} .frt-compact-leave { background:#653535; }
        #${ROOT_ID} .frt-compact-join { background:#286d45; }
        #${ROOT_ID} .frt-compact-top button:disabled { opacity:.55; }
        #${ROOT_ID} .frt-compact-front { display:grid; grid-template-columns:1fr 1fr; min-height:29px; border-bottom:1px solid var(--border); }
        #${ROOT_ID} .frt-compact-person { min-width:0; border:0; background:transparent; padding:4px 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:center; font-size:10px; font-weight:900; cursor:pointer; }
        #${ROOT_ID} .frt-compact-person + .frt-compact-person { border-left:1px solid var(--border); }
        #${ROOT_ID} .frt-compact-up { color:var(--up); border-top:2px solid var(--up); }
        #${ROOT_ID} .frt-compact-deck { color:var(--deck); border-top:2px solid var(--deck); }
        #${ROOT_ID} .frt-compact-empty { color:#6f777e; cursor:default; }
        #${ROOT_ID} .frt-compact-me { width:100%; min-width:0; min-height:30px; display:flex; align-items:center; justify-content:center; gap:5px; border:0; background:transparent; color:#f3f5f7; padding:4px 8px; cursor:pointer; white-space:nowrap; overflow:hidden; }
        #${ROOT_ID} .frt-compact-me-name { min-width:0; max-width:40%; overflow:hidden; text-overflow:ellipsis; font-size:10px; font-weight:900; }
        #${ROOT_ID} .frt-compact-you { flex:0 0 auto; padding:1px 3px; border:1px solid var(--me); border-radius:3px; color:var(--me); font-size:6px; font-weight:900; }
        #${ROOT_ID} .frt-compact-me-state { min-width:0; overflow:hidden; text-overflow:ellipsis; color:#b9c0c7; font-size:8px; font-weight:800; }
        #${ROOT_ID} .frt-compact-me-empty { color:#8f979f; cursor:default; }
        #${ALERT_ID} { top:98px; min-height:46px; padding:7px 28px 7px 10px; }
        #${ALERT_ID} strong { font-size:12px; }
        #${ALERT_ID} span { font-size:9px; }
        #${ALERT_ID}.frt-alert-attack strong { font-size:15px; }
        #${SETTINGS_ID} { padding:104px 7px 10px; }
        #${SETTINGS_ID} .frt-volume-row { grid-template-columns:1fr 110px; }
        #${SETTINGS_ID} input[type="range"] { width:110px; }
        #${ROTATION_EDITOR_ID} { padding:104px 8px 12px; }
        #${ROTATION_EDITOR_ID} .frt-editor-card { max-height:calc(100vh - 116px); padding:9px; }
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
    const readiness = readinessFor(member);
    const readinessRow = readiness
      ? `<div class="frt-ov-row"><span>Readiness</span><strong>${esc(readiness.label)}</strong></div>${readiness.action ? `<button type="button" class="frt-attack frt-smart-action" data-self-action="${readiness.action}">${readiness.action === 'skip' ? 'SKIP UNTIL READY' : 'RETURN TO ROTATION'}</button>` : ''}`
      : '';
    const ov = document.createElement('div');
    ov.id = OVERLAY_ID;
    ov.innerHTML = `
      <div class="frt-ov-head"><strong>${esc(member.name)}</strong><button type="button" class="frt-close" aria-label="Close">×</button></div>
      <div class="frt-ov-row"><span>Rotation</span><strong>${esc(roleLabel(member) || 'IN ROTATION')} • ${esc(member.eta)}</strong></div>
      <div class="frt-ov-row"><span>Target</span><strong>${esc(targetText)}</strong></div>
      <div class="frt-ov-row"><span>Energy</span><strong>${esc(energyText)}</strong></div>
      <div class="frt-ov-row"><span>Health</span><strong>${esc(healthText)}</strong></div>
      <div class="frt-ov-row"><span>Status</span><strong>${esc(member.status)}</strong></div>
      ${readinessRow}
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
    ov.querySelectorAll('[data-self-action]').forEach(btn => {
      btn.addEventListener('click', () => { closeOverlay(); rotationAction(btn.dataset.selfAction); });
    });
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

    const pdaKeyInjected = hasTornPdaApiKey();
    const isPdaHost = typeof PDA_httpGet === 'function' || typeof PDA_httpPost === 'function';
    const authText = authDiagnostic
      ? diagnosticSummary()
      : (isPdaHost && !pdaDeviceProof
          ? `PDA AUTH SETUP · key=${pdaKeyInjected ? 'yes' : 'no'} · proof=no`
          : 'Device not linked');
    const desktop = authRequired ? `<div class="frt-empty">${esc(authText)}</div>` : (rotation.length ? rotation.map(memberHTML).join('') : `<div class="frt-empty">${apiOnline ? 'No one is currently in the rotation.' : `Coordinator offline${lastError ? ` · ${esc(lastError)}` : ''}`}</div>`);
    const mobile = authRequired ? `<div class="frt-empty">${esc(authText)}</div>` : (rotation.length ? mobileMembers().map(memberHTML).join('') : `<div class="frt-empty">${apiOnline ? 'Rotation empty' : 'Coordinator offline'}</div>`);
    const root = document.createElement('section');
    root.id = ROOT_ID;
    if (!apiOnline) root.classList.add('frt-offline');
    const disabled = writePending || !apiOnline ? 'disabled' : '';
    let actionHtml;
    if (authRequired) {
      actionHtml = (pdaDeviceProof || !authDiagnostic)
        ? '<button type="button" class="frt-joinleave frt-join frt-link">LINK</button>'
        : '<button type="button" class="frt-joinleave frt-join frt-diag">DIAG</button>';
    } else if (!joined()) {
      actionHtml = `<button type="button" class="frt-joinleave frt-join" data-self-action="join" ${disabled}>${writePending ? 'WORKING…' : 'JOIN'}</button>`;
    } else {
      const skipped = viewerIsSkipped();
      actionHtml = `<div class="frt-self-actions"><button type="button" class="frt-joinleave ${skipped ? 'frt-return' : 'frt-skip'}" data-self-action="${skipped ? 'return' : 'skip'}" ${disabled}>${writePending ? 'WORKING…' : (skipped ? 'RETURN' : 'SKIP')}</button><button type="button" class="frt-joinleave frt-leave" data-self-action="leave" ${disabled}>LEAVE</button></div>`;
    }
    const upMember = rotation.find(member => member.role === 'up') || null;
    const deckMember = rotation.find(member => member.role === 'on-deck') || null;
    let compactPrimaryAction = '';
    let compactSecondaryAction = '';
    if (authRequired) {
      compactSecondaryAction = (pdaDeviceProof || !authDiagnostic)
        ? '<button type="button" class="frt-compact-join frt-link">LINK</button>'
        : '<button type="button" class="frt-compact-join frt-diag">DIAG</button>';
    } else if (!joined()) {
      compactSecondaryAction = `<button type="button" class="frt-compact-join" data-self-action="join" ${disabled}>${writePending ? '…' : 'JOIN'}</button>`;
    } else {
      const skipped = viewerIsSkipped();
      compactPrimaryAction = `<button type="button" class="${skipped ? 'frt-compact-return' : 'frt-compact-skip'}" data-self-action="${skipped ? 'return' : 'skip'}" ${disabled}>${writePending ? '…' : (skipped ? 'RETURN' : 'SKIP')}</button>`;
      compactSecondaryAction = `<button type="button" class="frt-compact-leave" data-self-action="leave" ${disabled}>LEAVE</button>`;
    }
    const compactHtml = `<div class="frt-compact">
      <div class="frt-compact-top">
        <div class="frt-compact-brand" title="${esc(lastError)}"><span class="frt-live"></span><span>ROTATION</span><span>•</span><span class="frt-compact-timer-value">${esc(formatChain(currentChainSeconds()))}</span></div>
        <button type="button" class="frt-compact-settings">SETTINGS</button>
        ${compactPrimaryAction || '<span></span>'}
        ${compactSecondaryAction || '<span></span>'}
      </div>
      <div class="frt-compact-front">${compactMemberButton(upMember, 'up')}${compactMemberButton(deckMember, 'deck')}</div>
      ${compactViewerRow()}
    </div>`;
    root.innerHTML = `<div class="frt-bar"><div class="frt-brand" title="${esc(lastError)}"><span class="frt-live"></span>ROTATION</div><div class="frt-desktop">${desktop}</div><div class="frt-mobile">${mobile}</div><div class="frt-timer"><small>CHAIN TIMER</small><strong>${esc(formatChain(currentChainSeconds()))}</strong><div class="frt-timer-controls"><button type="button" class="frt-off">OFF</button></div></div><div class="frt-actions"><button type="button" class="frt-settings-button" title="Rotation settings" aria-label="Rotation settings">SETTINGS</button>${actionHtml}</div></div>${compactHtml}`;
    document.body.prepend(root);

    root.querySelectorAll('[data-readiness-action]').forEach(badge => badge.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      rotationAction(String(e.currentTarget.dataset.readinessAction || ''));
    }));
    root.querySelectorAll('.frt-target-hit').forEach(target => target.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      const url = String(e.currentTarget.dataset.attackUrl || '');
      if (url) window.location.assign(url);
    }));
    root.querySelectorAll('.frt-member, .frt-compact-person[data-rotation-id], .frt-compact-me[data-rotation-id]').forEach(btn => btn.addEventListener('click', e => {
      const member = rotation.find(m => m.rotationUserId === String(e.currentTarget.dataset.rotationId));
      if (member) openOverlay(member, e.currentTarget);
    }));
    root.querySelectorAll('.frt-link, .frt-diag').forEach(linkOrDiagButton => linkOrDiagButton.addEventListener('click', () => {
      if (authRequired && pdaDeviceProof) { linkDevice(); return; }
      if (authRequired && authDiagnostic) { alert(diagnosticDetails()); return; }
      linkDevice();
    }));
    root.querySelectorAll('[data-self-action]').forEach(button => {
      button.addEventListener('click', () => rotationAction(button.dataset.selfAction));
    });
    root.querySelector('.frt-settings-button')?.addEventListener('click', openSettings);
    root.querySelector('.frt-compact-settings')?.addEventListener('click', openSettings);
    root.querySelector('.frt-off').addEventListener('click', () => { closeRotationEditor(); closeSettings(); closeTransitionAlert(); setEnabled(false); stopPolling(); render(); });
  }

  function startPolling() {
    stopPolling();
    if (!enabled()) return;
    startChainTicker();
    pollTimer = window.setInterval(requestState, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
    stopChainTicker();
  }

  document.addEventListener('pointerdown', e => {
    const ov = document.getElementById(OVERLAY_ID);
    if (ov && !ov.contains(e.target) && !e.target.closest?.(`#${ROOT_ID} .frt-member`)) closeOverlay();
  }, true);

  function maintenanceCheck() {
    // Keep SPA navigation resilience without observing every combat/UI mutation.
    // Polling already refreshes live data every five seconds; this lightweight
    // check only remounts our own UI if Torn removed it during navigation.
    if (enabled()) {
      if (!document.getElementById(ROOT_ID)) render();
    } else if (!document.getElementById(OFF_BUTTON_ID)) {
      mountOffButton();
    }
  }

  function startMaintenance() {
    if (maintenanceTimer !== null) window.clearInterval(maintenanceTimer);
    maintenanceTimer = window.setInterval(maintenanceCheck, 2000);
  }

  async function boot() {
    migrateAuthStorage();
    await initializePdaDeviceProof();
    viewerTornId = detectViewerTornId();
    authRequired = !hasAuthCredential();
    if (!authRequired) restoreCachedState();
    render();
    requestState();
    startPolling();
    startMaintenance();
  }

  boot().catch(err => {
    console.error('Faction War Coordinator startup failed', err);
    authRequired = true;
    lastError = String(err?.message || err);
    render();
  });
})();
