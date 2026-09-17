from pathlib import Path

src = Path('faction-war-coordinator.user.js')
out_dir = Path('MWC-Torn-Remote-Bridge-v0.16.1')
out_dir.mkdir(exist_ok=True)
text = src.read_text(encoding='utf-8')


def replace_once(old, new, label):
    global text
    if old not in text:
        raise SystemExit(f'Missing expected source for {label}')
    text = text.replace(old, new, 1)


replace_once('// @version      0.16.0', '// @version      0.16.1', 'version')
replace_once('      `Version: 0.16.0`,', '      `Version: 0.16.1`,', 'diagnostic version')

replace_once(
    '  let attackRepeatTimer = null;\n',
    '  let attackRepeatTimer = null;\n'
    '  let pendingReadinessStage = null;\n'
    '  let pendingReadinessDetail = \'\';\n'
    '  let pendingReadinessSince = 0;\n'
    '  const READINESS_ALERT_STABILITY_MS = 3500;\n',
    'readiness stability state'
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
new_eval = '''  function evaluateAlertTransition({ rerender = false } = {}) {
    if (authRequired || !apiOnline) return;
    const current = viewerOperationalStage();
    if (!alertBaselineInitialized) {
      alertBaselineInitialized = true;
      lastAlertStage = current.stage;
      rememberAlertStage(current.stage);
      pendingReadinessStage = null;
      pendingReadinessDetail = '';
      pendingReadinessSince = 0;
      return;
    }
    if (current.stage === lastAlertStage) {
      pendingReadinessStage = null;
      pendingReadinessDetail = '';
      pendingReadinessSince = 0;
      return;
    }

    // Readiness status can briefly flicker while Torn changes responsive
    // layouts or while overlapping SPA instances finish a poll. Do not turn
    // a one-frame TRAVELING/READY observation into a user alert. Require the
    // semantic readiness transition to remain stable for a short window.
    const needsStability = current.stage === 'blocked' || current.stage === 'return_ready';
    if (needsStability) {
      const detail = String(current.detail || '');
      if (pendingReadinessStage !== current.stage || pendingReadinessDetail !== detail) {
        pendingReadinessStage = current.stage;
        pendingReadinessDetail = detail;
        pendingReadinessSince = Date.now();
        return;
      }
      if (Date.now() - pendingReadinessSince < READINESS_ALERT_STABILITY_MS) return;
    }

    pendingReadinessStage = null;
    pendingReadinessDetail = '';
    pendingReadinessSince = 0;
    cancelAttackRepeat();
    lastAlertStage = current.stage;
    rememberAlertStage(current.stage);
    if (current.stage && alertClaim(current.stage, current.detail)) showTransitionAlert(current.stage, current.detail);
    if (current.stage === 'attack_now') armAttackRepeat();

    // Only timer-driven role changes need an immediate visual refresh. A
    // blocked/ready transition is already reflected by the normal API poll,
    // and forcing a full rebuild here is what made split-screen pages jump.
    if (rerender && current.stage !== 'blocked' && current.stage !== 'return_ready' && document.getElementById(ROOT_ID)) render();
  }
'''
replace_once(old_eval, new_eval, 'alert transition guard')

old_off_css = '''      #${OFF_BUTTON_ID} { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; min-width:26px; margin-left:5px; padding:0; border:1px solid rgba(255,255,255,.12); border-radius:4px; background:rgba(12,15,18,.90); color:#e8edf1; cursor:pointer; box-sizing:border-box; vertical-align:middle; }
      #${OFF_BUTTON_ID} svg { width:20px; height:20px; display:block; } #${OFF_BUTTON_ID} .frt-chain { stroke:#cfd3d6; } #${OFF_BUTTON_ID} .frt-rotate { stroke:#55c95f; }
      #${OFF_BUTTON_ID}:hover { background:rgba(255,255,255,.08); border-color:rgba(85,201,95,.75); box-shadow:0 0 8px rgba(85,201,95,.28); }
      #${OFF_BUTTON_ID}:focus-visible { outline:1px solid #55c95f; outline-offset:2px; }
      #${OFF_BUTTON_ID}.frt-header-fallback { position:fixed; top:8px; right:8px; z-index:1000010; margin:0; }
'''
new_off_css = '''      #${OFF_BUTTON_ID} { position:fixed; left:12px; top:98px; z-index:999988; display:flex; align-items:center; gap:7px; width:172px; min-height:34px; padding:0 10px; border:1px solid #3a4047; border-radius:3px; background:linear-gradient(180deg,#353535,#292929); color:#f0f0f0; box-shadow:0 1px 2px rgba(0,0,0,.45); cursor:pointer; box-sizing:border-box; font:700 12px/1 Arial,Helvetica,sans-serif; text-align:left; }
      #${OFF_BUTTON_ID} .frt-off-live { width:8px; height:8px; flex:0 0 8px; border-radius:50%; background:#49d17d; box-shadow:0 0 7px rgba(73,209,125,.55); }
      #${OFF_BUTTON_ID} .frt-off-label { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      #${OFF_BUTTON_ID} .frt-off-state { color:#aab1b8; font-size:9px; font-weight:800; }
      #${OFF_BUTTON_ID}:hover { background:linear-gradient(180deg,#414141,#303030); border-color:#59616a; }
      #${OFF_BUTTON_ID}:focus-visible { outline:1px solid #55c95f; outline-offset:2px; }
      @media (max-width:1000px) {
        #${OFF_BUTTON_ID} { position:sticky; top:0; left:auto; width:100%; min-height:28px; margin:0; padding:0 12px; border-width:0 0 1px; border-radius:0; z-index:999990; background:rgba(31,34,37,.985); }
        #${OFF_BUTTON_ID} .frt-off-state { margin-left:auto; }
      }
'''
replace_once(old_off_css, new_off_css, 'collapsed off-state styles')

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
new_mount = '''  function mountOffButton() {
    document.getElementById(OFF_BUTTON_ID)?.remove();
    const btn = document.createElement('button');
    btn.id = OFF_BUTTON_ID;
    btn.type = 'button';
    btn.title = 'Enable Rotation';
    btn.setAttribute('aria-label', 'Enable Rotation');
    btn.innerHTML = `<span class=\"frt-off-live\"></span><span class=\"frt-off-label\">ROTATION</span><span class=\"frt-off-state\">OFF</span>`;
    btn.addEventListener('click', () => { setEnabled(true); render(); requestState(); startPolling(); });
    // Keep this as the first body child. On wide Torn layouts CSS parks it in
    // the left sidebar area; when Torn collapses to split-screen/mobile width,
    // the same control becomes a thin sticky strip across the top.
    document.body.prepend(btn);
  }
'''
replace_once(old_mount, new_mount, 'collapsed off-state mount')

old_render_start = '''  function render() {
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(OFF_BUTTON_ID)?.remove();
    closeOverlay(); addStyles();
    if (!enabled()) { mountOffButton(); return; }
'''
new_render_start = '''  function render() {
    const preserveScroll = Boolean(document.getElementById(ROOT_ID) || document.getElementById(OFF_BUTTON_ID));
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    document.getElementById(ROOT_ID)?.remove();
    document.getElementById(OFF_BUTTON_ID)?.remove();
    closeOverlay(); addStyles();
    if (!enabled()) {
      mountOffButton();
      if (preserveScroll) requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));
      return;
    }
'''
replace_once(old_render_start, new_render_start, 'scroll-preserving render start')

replace_once(
    '    document.body.prepend(root);\n\n    root.querySelectorAll(\'[data-readiness-action]\')',
    '    document.body.prepend(root);\n    if (preserveScroll) requestAnimationFrame(() => window.scrollTo(scrollX, scrollY));\n\n    root.querySelectorAll(\'[data-readiness-action]\')',
    'scroll restore after mount'
)

out = out_dir / 'faction-war-coordinator.user.js'
out.write_text(text, encoding='utf-8')
(out_dir / 'README-v0.16.1.txt').write_text(
    'Faction War Coordinator v0.16.1\n\n'
    'USERSCRIPT-ONLY TEST RELEASE. No bot/backend changes.\n\n'
    'Changes:\n'
    '- Debounces NOT READY / RETURN READY transitions for 3.5 seconds to suppress responsive-layout/status flicker.\n'
    '- Avoids forced full rerenders for readiness-only transitions.\n'
    '- Preserves page scroll position when the ticker must rebuild.\n'
    '- Replaces the floating OFF icon with a Torn-style collapsed ROTATION bar.\n'
    '- Wide screen: compact bar in the left-side toolbar area.\n'
    '- Split screen / narrow: compact ROTATION strip across the top.\n\n'
    'Test full screen -> split screen -> full screen repeatedly, both ON and OFF, while remaining in the same Torn status.\n',
    encoding='utf-8'
)
print(out)
