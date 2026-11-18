import Foundation

/// The script that keeps an agent's click or key off the buttons that answer a card or a prompt, inside Talos's own web page. The
/// Talos window injects it at document start into the top frame, in a content world of its own (page scripts cannot see or call it).
///
/// What it does: the window tells it, before it delivers each mouse or key event, who sent the event (`__talosGuardStamp(origin,
/// type, token, keyCode)`, see `SyntheticInput`). A click, an Enter or Space, a pointer or mouse press or a form submit that lands
/// on anything inside `[data-talos-protected]` (the one attribute, the one selector `PROTECTED` below: mark more elements and they
/// are covered) is cancelled, in the capture phase on `window` ahead of every handler of the page, unless the newest stamp is a
/// fresh human one that goes with THIS event:
/// - a pointer click (`detail` above 0) needs a human mouse release, a press needs a press, a release a release;
/// - a click made by the keyboard (`detail` 0) needs a human key press or release whose Enter or Space the page has just seen as a
///   key event of its own; a click with no such key event before it (an Accessibility press) is refused, whatever stamps are fresh;
/// - an Enter or Space key event needs a human key stamp of its own phase and key code.
/// A human stamp is spent by the click it allowed, and a key stamp ends with the key event's own turn of the event loop, so an
/// event that comes later never rides it. After each event of a request the window asks the script to answer its token
/// (`__talosGuardAck`): the app is told "handled" after every drop of that token was reported, never before.
///
/// The text between the `begin` and `end` markers is what the window injects, and what apps/web/test/protected-input.test.ts runs.
public enum ProtectedInputScript {
  /// Name of the content world and of the script message handler.
  public static let worldName = "talos-input-guard"
  public static let handlerName = "talosGuard"

  // begin-script
  public static let source = #"""
    (() => {
      if (window.__talosGuardStamp) return;
      const REQUIRE_TRUSTED = true;
      const FRESH_MS = 700;
      const PROTECTED = '[data-talos-protected]';
      const DOWN = ['leftMouseDown', 'rightMouseDown', 'otherMouseDown'];
      const UP = ['leftMouseUp', 'rightMouseUp', 'otherMouseUp'];
      const KEY_NAME = { 36: 'Enter', 76: 'Enter', 49: ' ' };
      let stamp = null;
      const tell = (m) => {
        try { window.webkit.messageHandlers.talosGuard.postMessage(m); } catch (_) {}
      };
      const keyName = (e) => (e.key === 'Spacebar' ? ' ' : e.key);
      const fresh = () => stamp !== null && performance.now() - stamp.at <= FRESH_MS;
      const human = () => (fresh() && stamp.origin === 'human' ? stamp : null);
      const isKeyStamp = (s) => s.type === 'keyDown' || s.type === 'keyUp';
      const allowed = (e) => {
        if (REQUIRE_TRUSTED && !e.isTrusted) return false;
        const s = human();
        if (!s) return false;
        switch (e.type) {
          case 'mousedown': case 'pointerdown': return DOWN.includes(s.type);
          case 'mouseup': case 'pointerup': return UP.includes(s.type);
          case 'click': case 'auxclick': case 'dblclick':
            return e.detail > 0 ? UP.includes(s.type) : isKeyStamp(s) && s.keySeen;
          case 'submit': return UP.includes(s.type) || (isKeyStamp(s) && s.keySeen);
          case 'keydown': case 'keypress': return s.type === 'keyDown' && KEY_NAME[s.keyCode] === keyName(e);
          case 'keyup': return s.type === 'keyUp' && KEY_NAME[s.keyCode] === keyName(e);
        }
        return false;
      };
      const guard = (e) => {
        const inside = e.target && e.target.closest ? e.target.closest(PROTECTED) : null;
        if (!inside) return;
        if (allowed(e)) {
          if (e.type === 'click' || e.type === 'auxclick' || e.type === 'dblclick' || e.type === 'submit') stamp = null;
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        tell({ dropped: e.type, token: stamp ? stamp.token : 0 });
      };
      const guardKey = (e) => {
        const name = keyName(e);
        if (name !== 'Enter' && name !== ' ') return;
        const s = human();
        const mine = s && (!REQUIRE_TRUSTED || e.isTrusted) && KEY_NAME[s.keyCode] === name;
        if (mine) {
          s.keySeen = true;
          setTimeout(() => { if (stamp === s) stamp = null; }, 0);
        }
        guard(e);
      };
      for (const t of ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'submit'])
        window.addEventListener(t, guard, true);
      for (const t of ['keydown', 'keyup', 'keypress']) window.addEventListener(t, guardKey, true);
      Object.defineProperty(window, '__talosGuardStamp', {
        value: (origin, type, token, keyCode) => {
          stamp = {
            origin: origin === 'human' ? 'human' : 'synthetic', type: String(type), token: Number(token) || 0,
            keyCode: Number(keyCode) || 0, at: performance.now(), keySeen: false,
          };
        },
        enumerable: false,
      });
      Object.defineProperty(window, '__talosGuardAck', {
        value: (token) => tell({ ack: Number(token) || 0 }),
        enumerable: false,
      });
    })();
    """#
  // end-script
}
