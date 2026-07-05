/*!
 * soma-feedback.js — SOMA App Standard §8 (feedback lifecycle, "under construction" phase)
 * v2 — 2026-07-04 (WQ-128), per Mike Wolf's live dogfooding on Playmaker.
 * v2.1 — 2026-07-04 (WQ-130), robustness/UX pass: (A) keyboard focus trap
 * inside the open panel + focus returns to the tab on a keyboard-driven
 * close; (B) actionable Retry button on network/server failure (was: a
 * static "try again" message with no button, leaving the user to notice
 * their text survived and re-click Submit themselves); (C) touch targets on
 * Submit/Submit & Build/Close bumped to the ~44px accessible minimum (were
 * ~34-36px, well under it); (D) the tab shows a small unread-result dot
 * after a fire-and-forget success/failure so a user who glanced away still
 * sees the outcome on return, and the busy state now also disables Escape/
 * click-away close so an in-flight request's result is never silently lost.
 *
 * A single embeddable, framework-free feedback widget: a floating tab
 * (bottom-LEFT, to stay clear of the bottom-right guide-widget/tour-card
 * convention — V'Eric, Bill, §7 poster-frame tour cards all live bottom-right)
 * that opens a small panel with a textarea + name/email + Submit /
 * Submit & Build.
 *
 * Zero dependencies. Copy this file + soma-feedback.css into any static
 * site, then add:
 *
 *   <link rel="stylesheet" href="/soma-feedback.css">
 *   <script src="/soma-feedback.js" data-endpoint="/.netlify/functions/feedback" data-site="my-site-name" defer></script>
 *
 * Config via data-* attributes on the <script> tag:
 *   data-endpoint  (required) — POST URL that accepts
 *                  { site, page, url, title, area, text, name, email,
 *                    submitBuild, hp, elementHint }
 *                  and returns { ok: true } on success. See
 *                  playmaker/netlify/functions/feedback.ts for the reference
 *                  backend (emails a [BOARD] card into the SOMA board inbox —
 *                  reuses claude-email-daemon, no new service).
 *   data-site      (required) — short app/site identifier, goes on the card.
 *   data-label     (optional) — tab label, default "Feedback".
 *
 * Config via a page-level global (set BEFORE this script tag, or any time
 * before the user opens the panel — read live, not cached at load):
 *   window.somaFeedbackIdentity — optional function returning
 *     { name, email } (or a Promise of it) for the CURRENTLY signed-in user.
 *     Wire it to your site's own auth/session state — see §8 "identity hook."
 *     Values win over localStorage-remembered fields but never overwrite what
 *     a user has actively typed in the panel this session.
 *
 * Config via a `data-area` attribute — set it ANYWHERE in the DOM (the
 * nearest ancestor of the widget's mount point wins; falls back to
 * <body data-area="...">), so a single-page app can label its regions
 * ("rehearsal room", "editor", "plays list") without a page reload. Read
 * live at submit time, not cached, so it stays correct across in-app
 * navigation. Goes on the card as a Location line alongside the URL.
 *
 * Honeypot: a visually-hidden text input named "hp" is posted; a filled
 * value means a bot, and the widget silently no-ops the submit (looks
 * successful to the bot, is a no-op server-side too).
 *
 * localStorage: remembers name/email under `soma-feedback:name` /
 * `soma-feedback:email` so a repeat reporter (e.g. Eric) types them once.
 * Superseded per-open by the identity hook when one is wired and a user is
 * actually signed in.
 *
 * ── Unequivocal-intent guard on Submit & Build ───────────────────────────
 * "Submit & Build" auto-dispatches a build (admin-tier RSI outer-loop item,
 * `auto-dispatch: true`). Mike, verbatim (2026-07-04 card): "should not
 * simply go off and build... a check to make sure it wasn't accidentally
 * pushed... some modifier that makes it unequivocal on desktop, maybe the
 * Shift key or the Command key. On mobile, press and hold." Implemented as
 * a SOMA standard, not a Playmaker-only tweak:
 *
 *   - Desktop, modifier-click (Shift or Cmd/Ctrl held): unequivocal by
 *     construction — submits immediately. The button grows a distinct
 *     "armed" pressed style for the duration of the click so there's visual
 *     feedback that the modifier was recognized.
 *   - Desktop, plain click: NOT unequivocal. First click flips the button's
 *     label to "Really build? Click again" for a 3-second window (no modal,
 *     no extra DOM element — the button becomes its own confirmation). A
 *     second click within the window submits; letting the window lapse (or
 *     clicking elsewhere / closing the panel) reverts the label and no-ops.
 *   - Touch (mobile/no hover capability, detected via pointer/touch events
 *     and `matchMedia('(pointer: coarse)')`): press-and-hold. A visible fill
 *     animation sweeps the button over 600ms; release before it completes
 *     cancels (no submit, no confirm-step fallback needed since the hold
 *     itself IS the unequivocal signal); holding through the full duration
 *     submits immediately, same as a modifier-click.
 *
 * Plain "Submit" (non-build) is never gated — it's a review-only card, no
 * auto-dispatch, so an accidental click costs nothing more than noise.
 */
(function (root, factory) {
  // UMD-lite shim: real browser usage runs the IIFE for its side effects
  // (mounts the widget) exactly as before. A CommonJS/Node test runner
  // importing this file instead gets `{ decideBuildClick }` — the one pure,
  // side-effect-free decision function worth unit testing directly, per
  // playmaker/tests/wq128-feedback-guard.test.ts. Browsers never take this
  // branch (no `module` global), so production behavior is unchanged.
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    factory();
  }
})(this, function () {
  'use strict';

  // Pure decision function for the unequivocal-intent guard (item 1 of
  // WQ-128) — no DOM reads/writes, defined before any `document`/`window`
  // access below so it's safe to call from a Node test environment even
  // though the rest of this module is browser-only. See the doc comment
  // near its browser-side call site further down for the full rationale.
  function decideBuildClick(opts) {
    if (opts.isCoarsePointer) {
      // Touch devices never resolve a build from a click event at all —
      // press-and-hold (startHold/cancelHold) is the only path in.
      return { action: 'ignore' };
    }
    if (opts.shiftKey || opts.metaKey || opts.ctrlKey) {
      return { action: 'submit-immediately', reason: 'modifier' };
    }
    if (opts.confirmArmed) {
      return { action: 'submit-immediately', reason: 'second-click' };
    }
    return { action: 'arm-confirm' };
  }

  // Everything below this line touches document/window and only runs in a
  // real browser (or a test environment that stubs both) — a plain Node
  // import (module.exports path above) gets just { decideBuildClick } and
  // never executes any of it.
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return { decideBuildClick: decideBuildClick };
  }

  function currentScript() {
    if (document.currentScript) return document.currentScript;
    var scripts = document.getElementsByTagName('script');
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (/soma-feedback\.js/.test(scripts[i].src)) return scripts[i];
    }
    return null;
  }

  var script = currentScript();
  var endpoint = (script && script.getAttribute('data-endpoint')) || '';
  var site = (script && script.getAttribute('data-site')) || document.title || 'unknown-site';
  var label = (script && script.getAttribute('data-label')) || 'Feedback';

  if (!endpoint) {
    console.warn('[soma-feedback] no data-endpoint set on the script tag — widget disabled.');
    return { decideBuildClick: decideBuildClick };
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function loadRemembered(field) {
    try { return window.localStorage.getItem('soma-feedback:' + field) || ''; }
    catch (_) { return ''; }
  }
  function remember(field, value) {
    try { window.localStorage.setItem('soma-feedback:' + field, value); }
    catch (_) { /* localStorage may be unavailable (private mode) — non-fatal */ }
  }

  // ── Identity hook (item 2: auto-populate for signed-in users) ──────────
  // Reads window.somaFeedbackIdentity fresh every time the panel opens —
  // never cached at script-load time, since a user may sign in/out after
  // the widget mounts (SPA navigation). Supports both a plain return value
  // and a Promise, so sites whose session check is async (most are) work
  // without extra plumbing.
  function resolveIdentity(cb) {
    var hook = window.somaFeedbackIdentity;
    if (typeof hook !== 'function') { cb(null); return; }
    try {
      var result = hook();
      if (result && typeof result.then === 'function') {
        result.then(function (v) { cb(v || null); }, function () { cb(null); });
      } else {
        cb(result || null);
      }
    } catch (err) {
      console.warn('[soma-feedback] data-identity-hook threw, ignoring:', err);
      cb(null);
    }
  }

  // ── Origin context (item 3: richer than just the site name) ────────────
  // data-area can live on any ancestor of the widget root, or on <body>, and
  // is read live at submit time (not cached) so an SPA route change is
  // reflected without a page reload.
  function currentArea() {
    var node = root;
    while (node) {
      if (node.getAttribute && node.getAttribute('data-area')) return node.getAttribute('data-area');
      node = node.parentElement;
    }
    return '';
  }

  // Cheap, best-effort context capture: last right-clicked or selected
  // element's tag + nearest heading/text snippet. Not a full DOM path (that's
  // the interactive-guide job for a DEPLOYED site) — just enough to help
  // whoever triages the card find the right spot.
  var lastElementHint = '';
  function describeElement(node) {
    if (!node || node === document.body || node === document.documentElement) return '';
    var tag = node.tagName ? node.tagName.toLowerCase() : '';
    var text = (node.textContent || '').trim().slice(0, 80);
    var id = node.id ? '#' + node.id : '';
    var cls = node.className && typeof node.className === 'string'
      ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    return [tag + id + cls, text].filter(Boolean).join(' — ');
  }
  document.addEventListener('contextmenu', function (e) {
    lastElementHint = describeElement(e.target);
  }, true);
  document.addEventListener('mouseup', function () {
    var sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim().length > 0) {
      lastElementHint = 'selected text: "' + String(sel).trim().slice(0, 120) + '"';
    }
  });

  // ── DOM ────────────────────────────────────────────────────────────────

  var root = el('div', { class: 'soma-feedback-root' });

  var tab = el('button', {
    class: 'soma-feedback-tab',
    type: 'button',
    'aria-label': label + ' — under construction, tell us what to change',
  }, [document.createTextNode('💬 ' + label)]);

  var panel = el('div', { class: 'soma-feedback-panel', hidden: 'hidden' });

  var heading = el('div', { class: 'soma-feedback-heading' }, [
    el('strong', { text: label }),
    el('span', { class: 'soma-feedback-microcopy', text: 'Under construction — tell us what to change.' }),
  ]);

  var closeBtn = el('button', { class: 'soma-feedback-close', type: 'button', 'aria-label': 'Close' }, [document.createTextNode('×')]);
  heading.appendChild(closeBtn);

  var textarea = el('textarea', {
    class: 'soma-feedback-textarea',
    placeholder: 'What should we change? Be as specific as you can.',
    rows: '5',
  });

  var nameInput = el('input', { class: 'soma-feedback-input', type: 'text', placeholder: 'Your name', value: loadRemembered('name') });
  var emailInput = el('input', { class: 'soma-feedback-input', type: 'email', placeholder: 'Your email (optional)', value: loadRemembered('email') });

  // Track whether the user has hand-edited name/email this session — if so,
  // the identity hook must never clobber it (item 2's "falls back to
  // localStorage" also implies: never override an active edit).
  var nameTouched = false;
  var emailTouched = false;
  nameInput.addEventListener('input', function () { nameTouched = true; });
  emailInput.addEventListener('input', function () { emailTouched = true; });

  // Honeypot — visually hidden via CSS class, NOT display:none (some bots
  // skip display:none fields specifically); real users never see or fill it.
  var honeypot = el('input', { class: 'soma-feedback-hp', type: 'text', name: 'website', tabindex: '-1', autocomplete: 'off' });

  var statusLine = el('div', { class: 'soma-feedback-status', 'aria-live': 'polite' });

  var submitBtn = el('button', { class: 'soma-feedback-submit', type: 'button' }, [document.createTextNode('Submit')]);
  var submitBuildBtn = el('button', {
    class: 'soma-feedback-submit-build',
    type: 'button',
    title: 'Click + Shift (or ⌘/Ctrl) to build immediately. Plain click asks you to confirm. On touch, press and hold.',
  }, [document.createTextNode('Submit & Build')]);
  var buildFill = el('span', { class: 'soma-feedback-submit-build-fill', 'aria-hidden': 'true' });
  submitBuildBtn.appendChild(buildFill);

  var actions = el('div', { class: 'soma-feedback-actions' }, [submitBtn, submitBuildBtn]);

  // ── Item B: actionable retry on network/server failure ──────────────────
  // Previously a failed POST just printed "try again in a moment" and left
  // the user to notice the textarea still holds their text and re-click
  // Submit themselves. Offline/flaky-connection is exactly when a reporter
  // is most likely to give up. Hidden by default; shown only in the catch
  // path, replaying the SAME submitBuild mode that just failed.
  var retryBtn = el('button', { class: 'soma-feedback-retry', type: 'button', hidden: 'hidden' },
    [document.createTextNode('Retry')]);

  panel.appendChild(heading);
  panel.appendChild(textarea);
  panel.appendChild(nameInput);
  panel.appendChild(emailInput);
  panel.appendChild(honeypot);
  panel.appendChild(actions);
  panel.appendChild(statusLine);
  panel.appendChild(retryBtn);

  root.appendChild(panel);
  root.appendChild(tab);

  function ready() {
    document.body.appendChild(root);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }

  // ── Behavior ─────────────────────────────────────────────────────────────

  function applyIdentity(identity) {
    if (!identity) return;
    if (identity.name && !nameTouched && !nameInput.value.trim()) {
      nameInput.value = identity.name;
    }
    if (identity.email && !emailTouched && !emailInput.value.trim()) {
      emailInput.value = identity.email;
    }
  }

  // ── Item A: keyboard focus trap while the panel is open ─────────────────
  // Native `title=`-era widgets like this are easy to ship with Escape-to-
  // close but no Tab containment — a keyboard user can Tab straight out of
  // the panel into the rest of the page while it's still visually open.
  // Trap Tab/Shift+Tab within the panel's focusable elements; restore focus
  // to the tab button on close so keyboard users land back where they left
  // off, not at the top of the document.
  function focusableInPanel() {
    // Every clause excludes tabindex="-1" — most importantly the honeypot
    // input (deliberately tabindex="-1" + visually hidden, see the honeypot
    // doc comment above): without this exclusion on the bare `input` clause,
    // a real keyboard user tabbing through the panel could land focus on a
    // field that's invisible to them, and the trap's first/last-element math
    // would silently include a decoy field in the cycle.
    //
    // Also excludes anything currently `hidden` (e.g. retryBtn, which stays
    // in the DOM at all times but only becomes relevant after a failed
    // submit) — the CSS `:not([hidden])` selector itself can't reach it
    // because `hidden` toggles via the DOM property, not always a literal
    // attribute string match in every browser, so this filters on the
    // element's own offsetParent (null when the element or an ancestor is
    // display:none) rather than trusting the attribute alone.
    var candidates = panel.querySelectorAll(
      'button:not([disabled]):not([tabindex="-1"]), ' +
      'input:not([tabindex="-1"]), ' +
      'textarea:not([tabindex="-1"]), ' +
      '[tabindex]:not([tabindex="-1"])'
    );
    return Array.prototype.filter.call(candidates, function (el) {
      return !el.hidden && el.offsetParent !== null;
    });
  }
  function trapTabKey(e) {
    if (e.key !== 'Tab' || panel.hidden) return;
    var items = focusableInPanel();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // ── Item D: never lose an in-flight result to a stray close ─────────────
  // If a request is in flight, force-closing (Escape, the × button, or a
  // click elsewhere) would silently discard whatever the response turns
  // out to be — the user would have no way to know if their feedback
  // actually landed. `requestInFlight` gates the close paths that are easy
  // to trigger by accident; a deliberate re-click of the tab still works
  // (it's the same explicit "I want this closed" signal either way, so it's
  // not blocked — only the passive/incidental close paths are).
  var requestInFlight = false;
  // `tabResultDot` marks the tab itself with the last outcome (success/
  // error) so a user who fires a submit and glances away (or the panel
  // auto-closes on success per the 2200ms timeout below) still sees the
  // result when they look back at the page, not just inside a panel they
  // may never reopen.
  function setTabResult(kind) {
    tab.classList.remove('soma-feedback-tab--result-success', 'soma-feedback-tab--result-error');
    if (kind) tab.classList.add('soma-feedback-tab--result-' + kind);
  }
  function clearTabResult() { setTabResult(null); }

  function openPanel() {
    panel.hidden = false;
    tab.setAttribute('aria-expanded', 'true');
    clearTabResult();
    resolveIdentity(applyIdentity);
    textarea.focus();
  }
  function closePanel(force) {
    if (panel.hidden) return;
    if (requestInFlight && !force) return;
    // Only return focus to the tab if focus is currently inside the panel
    // (a real keyboard-driven close). An auto-close on success (see the
    // setTimeout below) or a click elsewhere on the page must never yank
    // focus back to the tab out from under whatever the user has since
    // done — that would be its own accessibility regression.
    var focusWasInPanel = panel.contains(document.activeElement);
    panel.hidden = true;
    tab.setAttribute('aria-expanded', 'false');
    cancelBuildConfirm();
    cancelHold();
    if (focusWasInPanel) tab.focus();
  }

  tab.addEventListener('click', function () {
    if (panel.hidden) openPanel(); else closePanel();
  });
  closeBtn.addEventListener('click', function () { closePanel(); });
  panel.addEventListener('keydown', trapTabKey);

  function setStatus(msg, kind) {
    statusLine.textContent = msg;
    statusLine.className = 'soma-feedback-status' + (kind ? ' soma-feedback-status--' + kind : '');
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBuildBtn.disabled = busy;
    retryBtn.disabled = busy;
    requestInFlight = busy;
  }

  var lastFailedSubmitBuild = null;
  function hideRetry() {
    retryBtn.hidden = true;
    lastFailedSubmitBuild = null;
  }
  // Any fresh edit after a failure clears the stale retry affordance — the
  // next Submit/Submit & Build click is a new attempt, not a retry of a now-
  // possibly-different message.
  textarea.addEventListener('input', hideRetry);

  // ── Item 4a: immediate submitter acknowledgment ─────────────────────────
  function ackFiled(ts) {
    var stamp = ts ? new Date(ts) : new Date();
    var hh = String(stamp.getHours()).padStart(2, '0');
    var mm = String(stamp.getMinutes()).padStart(2, '0');
    setStatus('Filed — the team has it (' + hh + ':' + mm + ').', 'success');
  }

  function submit(submitBuild) {
    var text = textarea.value.trim();
    if (!text) {
      setStatus('Type something first.', 'error');
      textarea.focus();
      return;
    }
    remember('name', nameInput.value.trim());
    remember('email', emailInput.value.trim());

    hideRetry();
    setBusy(true);
    setStatus(submitBuild ? 'Filing + queuing for build…' : 'Filing…');

    var payload = {
      site: site,
      page: document.title || '',
      url: window.location.href,
      area: currentArea(),
      text: text,
      name: nameInput.value.trim() || 'anonymous',
      email: emailInput.value.trim(),
      submitBuild: !!submitBuild,
      elementHint: lastElementHint,
      hp: honeypot.value,
    };

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error('status ' + resp.status);
        return resp.json();
      })
      .then(function (data) {
        ackFiled(data && data.filedAt);
        setTabResult('success');
        textarea.value = '';
        lastElementHint = '';
        setTimeout(function () { closePanel(true); }, 2200);
      })
      .catch(function (err) {
        console.error('[soma-feedback] submit failed:', err);
        setStatus('Could not send just now — your text is still here.', 'error');
        setTabResult('error');
        lastFailedSubmitBuild = submitBuild;
        retryBtn.hidden = false;
      })
      .then(function () {
        setBusy(false);
      });
  }

  submitBtn.addEventListener('click', function () { submit(false); });
  retryBtn.addEventListener('click', function () {
    var mode = lastFailedSubmitBuild;
    hideRetry();
    submit(!!mode);
  });

  // ── Unequivocal-intent guard ─────────────────────────────────────────────

  var CONFIRM_WINDOW_MS = 3000;
  var HOLD_DURATION_MS = 600;
  var isCoarsePointer = (function () {
    try { return window.matchMedia && window.matchMedia('(pointer: coarse)').matches; }
    catch (_) { return false; }
  })();

  // decideBuildClick is defined once, near the top of this factory (before
  // any document/window access) — see that definition for the full doc
  // comment. Reused here as the click handler's only decision logic.

  var confirmArmed = false;
  var confirmTimer = null;
  function armBuildConfirm() {
    confirmArmed = true;
    submitBuildBtn.classList.add('soma-feedback-submit-build--confirming');
    submitBuildBtn.textContent = '';
    submitBuildBtn.appendChild(document.createTextNode('Really build? Click again'));
    submitBuildBtn.appendChild(buildFill);
    confirmTimer = setTimeout(cancelBuildConfirm, CONFIRM_WINDOW_MS);
  }
  function cancelBuildConfirm() {
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null; }
    if (!confirmArmed) return;
    confirmArmed = false;
    submitBuildBtn.classList.remove('soma-feedback-submit-build--confirming');
    submitBuildBtn.textContent = '';
    submitBuildBtn.appendChild(document.createTextNode('Submit & Build'));
    submitBuildBtn.appendChild(buildFill);
  }

  function flashArmed() {
    submitBuildBtn.classList.add('soma-feedback-submit-build--armed');
    setTimeout(function () { submitBuildBtn.classList.remove('soma-feedback-submit-build--armed'); }, 220);
  }

  // Desktop click path (mouse/click events only — touch devices are
  // intercepted by the capture-phase listener below, which stops this one
  // from ever running for a touch-originated click).
  submitBuildBtn.addEventListener('click', function (e) {
    var decision = decideBuildClick({
      isCoarsePointer: isCoarsePointer,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      confirmArmed: confirmArmed,
    });
    if (decision.action === 'ignore') return;
    if (decision.action === 'submit-immediately') {
      cancelBuildConfirm();
      flashArmed();
      submit(true);
      return;
    }
    armBuildConfirm();
  });

  // ── Touch path: press-and-hold with a visible fill animation ────────────
  var holdTimer = null;
  var holdStart = 0;
  var holdActive = false;

  function startHold(e) {
    if (!isCoarsePointer) return;
    e.preventDefault();
    holdActive = true;
    holdStart = Date.now();
    submitBuildBtn.classList.add('soma-feedback-submit-build--holding');
    buildFill.style.transitionDuration = HOLD_DURATION_MS + 'ms';
    // Force layout so the 0%->100% transition actually runs from 0.
    // eslint-disable-next-line no-unused-expressions
    buildFill.offsetHeight;
    buildFill.style.width = '100%';
    holdTimer = setTimeout(function () {
      if (!holdActive) return;
      holdActive = false;
      submitBuildBtn.classList.remove('soma-feedback-submit-build--holding');
      flashArmed();
      submit(true);
    }, HOLD_DURATION_MS);
  }
  function cancelHold() {
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (!holdActive) return;
    holdActive = false;
    submitBuildBtn.classList.remove('soma-feedback-submit-build--holding');
    buildFill.style.transitionDuration = '150ms';
    buildFill.style.width = '0%';
  }

  submitBuildBtn.addEventListener('touchstart', startHold, { passive: false });
  submitBuildBtn.addEventListener('touchend', cancelHold);
  submitBuildBtn.addEventListener('touchcancel', cancelHold);
  submitBuildBtn.addEventListener('touchmove', function (e) {
    // Any significant finger movement off the button cancels the hold —
    // press-and-hold means hold still, not swipe-through.
    var t = e.touches && e.touches[0];
    if (!t) return;
    var rect = submitBuildBtn.getBoundingClientRect();
    if (t.clientX < rect.left || t.clientX > rect.right || t.clientY < rect.top || t.clientY > rect.bottom) {
      cancelHold();
    }
  }, { passive: true });
  // Suppress the synthetic click browsers fire after touchend — on a
  // coarse-pointer device the hold path already handled (or didn't earn)
  // the submit; the click event is not a second, independent signal here.
  // Capture-phase so this runs before the desktop click listener above.
  submitBuildBtn.addEventListener('click', function (e) {
    if (isCoarsePointer) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });

  return { decideBuildClick: decideBuildClick };
});
