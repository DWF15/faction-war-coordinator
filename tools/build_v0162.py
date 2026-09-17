from pathlib import Path

src = Path('faction-war-coordinator.user.js')
out_dir = Path('MWC-Torn-Remote-Bridge-v0.16.2')
out_dir.mkdir(exist_ok=True)
text = src.read_text(encoding='utf-8')


def rep(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f'Missing expected source for {label}')
    text = text.replace(old, new, 1)

rep('// @version      0.16.0', '// @version      0.16.2', 'version')
rep('      `Version: 0.16.0`,', '      `Version: 0.16.2`,', 'diagnostic version')

rep(
    '  let attackRepeatTimer = null;\n',
    '  let attackRepeatTimer = null;\n'
    '  let pendingReadinessSignature = null;\n'
    '  let pendingReadinessCount = 0;\n'
    '  const READINESS_CONFIRMATIONS = 2;\n',
    'readiness confirmation state'
)

old_eval = '''  function evaluateAlertTransition({ rerender = false } = {}) {
    if (authRequired || !apiOnline) return;
    const current = viewerOperationalStage();
    if (!alertBaselineInitialized) {
      alertBaselineInitialized = true;
      // Always baseline to the state observed by this live script instance.
      // Do not seed lastAlertStage from sessionStorage: a stale stored stage
      // can make a resize/PDA reinjection look like a new transition on the
      // very next timer tick. Genuine alerts begin only after this baseline.
      lastAlertStage = current.stage;
      rememberAlertStage(current.stage);
      return;
    }
    if (current.stage === lastAlertStage) return;
    cancelAttackRepeat();
    lastAlertStage = current.stage;
    rememberAlertStage(current.stage);
    if (current.stage && alertClaim(current.stage, current.detail)) showTransitionAlert(current.stage, current.detail);
    if (current.stage === 'attack_now') armAttackRepeat();
    if (rerender && document.getElementById(ROOT_ID)) render();
  }
'''
new_eval = '''  function evaluateAlertTransition({ source = 'api' } = {}) {
    if (authRequired || !apiOnline) return;
    if (source !== 'api') return;
    const current = viewerOperationalStage();
    if (!alertBaselineInitialized) {
      alertBaselineInitialized = true;
      lastAlertStage = current.stage;
      rememberAlertStage(current.stage);
      pendingReadinessSignature = null;
      pendingReadinessCount = 0;
      return;
    }
    if (current.stage === lastAlertStage) {
      pendingReadinessSignature = null;
      pendingReadinessCount = 0;
      return;
    }

    // NOT READY / RETURN READY must be confirmed by two consecutive fresh
    // Coordinator responses. Viewport changes, timer ticks, cached state and
    // Torn responsive reflow can never create these alerts on their own.
    const requiresConfirmation = current.stage === 'blocked' || current.stage === 'return_ready';
    if (requiresConfirmation) {
      const signature = `${current.stage}|${String(current.detail || '').trim().toUpperCase()}`;
      if (pendingReadinessSignature !== signature) {
        pendingReadinessSignature = signature;
        pendingReadinessCount = 1;
        return;
      }
      pendingReadinessCount += 1;
      if (pendingReadinessCount < READINESS_CONFIRMATIONS) return;
    }

    pendingReadinessSignature = null;
    pendingReadinessCount = 0;
    cancelAttackRepeat();
    lastAlertStage = current.stage;
    rememberAlertStage(current.stage);
    if (current.stage && alertClaim(current.stage, current.detail)) showTransitionAlert(current.stage, current.detail);
    if (current.stage === 'attack_now') armAttackRepeat();
  }
'''
rep(old_eval, new_eval, 'API-only alert evaluation')

rep(
    "    if (!timer && !compactTimer) return;\n    evaluateAlertTransition({ rerender: true });\n",
    "    if (!timer && !compactTimer) return;\n",
    'remove timer-driven alert evaluation'
)

rep(
    "    if (options.evaluateAlerts !== false) evaluateAlertTransition();\n",
    "    if (options.evaluateAlerts !== false) evaluateAlertTransition({ source: 'api' });\n",
    'fresh API alert evaluation'
)

old_off_css = '''      #${OFF_BUTTON_ID} { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; min-width:26px; margin-left:5px; padding:0; border:1px solid rgba(255,255,255,.12); border-radius:4px; background:rgba(12,15,18,.90); color:#e8edf1; cursor:pointer; box-sizing:border-box; vertical-align:middle; }
      #${OFF_BUTTON_ID} svg { width:20px; height:20px; display:block; } #${OFF_BUTTON_ID} .frt-chain { stroke:#cfd3d6; } #${OFF_BUTTON_ID} .frt-rotate { stroke:#55c95f; }
      #${OFF_BUTTON_ID}:hover { background:rgba(255,255,255,.08); border-color:rgba(85,201,95,.75); box-shadow:0 0 8px rgba(85,201,95,.28); }
      #${OFF_BUTTON_ID}:focus-visible { outline:1px solid #55c95f; outline-offset:2px; }
      #${OFF_BUTTON_ID}.frt-header-fallback { position:fixed; top:8px; right:8px; z-index:1000010; margin:0; }
'''
new_off_css = '''      #${OFF_BUTTON_ID} { display:flex; align-items:center; gap:7px; min-height:30px; padding:0 9px; border:1px solid #3a4047; border-radius:3px; background:linear-gradient(180deg,#353535,#292929); color:#f0f0f0; box-shadow:0 1px 2px rgba(0,0,0,.38); cursor:pointer; box-sizing:border-box; font:700 11px/1 Arial,Helvetica,sans-serif; text-align:left; }
      #${OFF_BUTTON_ID} .frt-off-live { width:8px; height:8px; flex:0 0 8px; border-radius:50%; background:#49d17d; box-shadow:0 0 7px rgba(73,209,125,.55); }
      #${OFF_BUTTON_ID} .frt-off-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #${OFF_BUTTON_ID} .frt-off-state { color:#aab1b8; font-size:9px; font-weight:800; }
      #${OFF_BUTTON_ID}:hover { background:linear-gradient(180deg,#414141,#303030); border-color:#59616a; }
      #${OFF_BUTTON_ID}:focus-visible { outline:1px solid #55c95f; outline-offset:2px; }
      #${OFF_BUTTON_ID}.frt-off-wide { position:static; width:100%; margin:6px 0; }
      #${OFF_BUTTON_ID}.frt-off-narrow { position:sticky; top:0; z-index:999990; width:100%; min-height:28px; margin:0; padding:0 10px; border-width:0 0 1px; border-radius:0; background:rgba(31,34,37,.985); }
      #${OFF_BUTTON_ID}.frt-off-narrow .frt-off-state { margin-left:auto; }
'''
rep(old_off_css, new_off_css, 'collapsed off-state styles')

old_mount = '''  function mountOffButton() {
    document.getElementById(OFF_BUTTON_ID)?.remove();
    const btn = document.createElement('button');
    btn.id = OFF_BUTTON_ID; btn.type = 'button'; btn.title = 'Enable Rotation'; btn.setAttribute('aria-label','Enable Rotation');
    btn.innerHTML = `<svg viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path class=\"frt-rotate\" d=\"M5 8.2a8 8 0 0 1 12.8-2.1\" fill=\"none\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path class=\"frt-rotate\" d=\"M17.8 3.9l.4 3.7-3.7-.3\" fill=\"none\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path class=\"frt-rotate\" d=\"M19 15.8a8 8 0 0 1-12.8 2.1\" fill=\"none\" stroke-width=\"1.8\" stroke-linecap=\"round\"/><path class=\"frt-rotate\" d=\"M6.2 20.1l-.4-3.7 3.7.3\" fill=\"none\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path class=\"frt-chain\" d=\"M9.1 14.9l-1.2 1.2a3 3 0 0 1-4.2-4.2l2.2-2.2a3 3 0 0 1 4.2 0\" fill=\"none\" stroke-width=\"2.1\" stroke-linecap=\"round\"/><path class=\"frt-chain\" d=\"M14.9 9.1l1.2-1.2a3 3 0 1 1 4.2 4.2l-2.2 2.2a3 3 0 0 1-4.2 0\" fill=\"none\" stroke-width=\"2.1\" stroke-linecap=\"round\"/><path class=\"frt-chain\" d=\"M8.6 15.4l6.8-6.8\" fill=\"none\" stroke-width=\"2.1\" stroke-linecap=\"round\"/></svg>`;
    btn.addEventListener('click', () => { setEnabled(true); render(); requestState(); startPolling(); });
    const profile = findTornProfileControl();
    if (profile) (profile.closest('li') || profile).insertAdjacentElement('afterend', btn);
    else { document.body.appendChild(btn); btn.classList.add('frt-header-fallback'); }
  }
'''
new_mount = '''  function syncOffButtonPlacement() {
    const btn = document.getElementById(OFF_BUTTON_ID);
    if (!btn) return;
    const narrow = window.innerWidth <= 1000;
    if (narrow) {
      btn.classList.remove('frt-off-wide');
      btn.classList.add('frt-off-narrow');
      if (btn.parentElement !== document.body || document.body.firstElementChild !== btn) document.body.prepend(btn);
      return;
    }

    btn.classList.remove('frt-off-narrow');
    btn.classList.add('frt-off-wide');
    const sidebar = document.querySelector('#sidebarroot');
    if (sidebar) {
      // Mount inside Torn's actual sidebar so the control follows the same
      // centered layout as Addiction Watch instead of using viewport pixels.
      if (btn.parentElement !== sidebar) sidebar.prepend(btn);
    } else if (btn.parentElement !== document.body) {
      document.body.prepend(btn);
    }
  }

  function mountOffButton() {
    document.getElementById(OFF_BUTTON_ID)?.remove();
    const btn = document.createElement('button');
    btn.id = OFF_BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Enable Rotation';
    btn.setAttribute('aria-label', 'Enable Rotation');
    btn.innerHTML = `<span class=\"frt-off-live\"></span><span class=\"frt-off-label\">ROTATION</span><span class=\"frt-off-state\">OFF</span>`;
    btn.addEventListener('click', () => { setEnabled(true); render(); requestState(); startPolling(); });
    document.body.prepend(btn);
    syncOffButtonPlacement();
  }
'''
rep(old_mount, new_mount, 'responsive off-state mount')

rep(
    "    } else if (!document.getElementById(OFF_BUTTON_ID)) {\n      mountOffButton();\n    }\n",
    "    } else if (!document.getElementById(OFF_BUTTON_ID)) {\n      mountOffButton();\n    } else {\n      syncOffButtonPlacement();\n    }\n",
    'off-state placement maintenance'
)

out = out_dir / 'faction-war-coordinator.user.js'
out.write_text(text, encoding='utf-8')
(out_dir / 'README-v0.16.2.txt').write_text(
    'Faction War Coordinator v0.16.2\n\n'
    'USERSCRIPT-ONLY TEST RELEASE. No bot/backend changes.\n\n'
    'Corrective changes from promoted v0.16.0 baseline:\n'
    '- Removes timer-driven readiness alert evaluation.\n'
    '- NOT READY / RETURN READY now require two consecutive fresh Coordinator API confirmations.\n'
    '- No scrollTo/scroll-restoration code from the v0.16.1 experiment.\n'
    '- Keeps the narrow/split-screen ROTATION OFF strip.\n'
    '- Wide-screen OFF control mounts inside Torn #sidebarroot so it follows the actual centered sidebar.\n'
    '- No rotation, target, coordinator overview, or backend mechanics changed.\n\n'
    'Test full screen -> split screen -> full screen repeatedly while status remains unchanged, then repeat with Rotation OFF.\n',
    encoding='utf-8'
)
print(out)
