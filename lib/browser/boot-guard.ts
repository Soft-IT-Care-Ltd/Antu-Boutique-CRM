// The last line of defence against a silent white page (P3.0, Gift Valy
// CORRECTIONS Round 2 §2.8: every iPhone showed a blank login page because
// a bundle used syntax old Safari couldn't parse). React error boundaries
// can't help there — React never starts. This tiny script is inlined in the
// root layout's <head> and runs before any bundle: if one of OUR scripts
// fails to load or throws before the app has booted, it shows a visible
// "Something went wrong — Reload" panel. <BootMarker> flips the flag (and
// removes the panel) once React has hydrated; from then on app/error.tsx
// and app/global-error.tsx take over.
//
// Deliberately ES5 with no dependencies: it must run on the oldest browser
// we'll ever meet. Errors from other origins (browser extensions) and failed
// images/stylesheets are ignored.

export const BOOT_FLAG = "__antuBooted";
export const BOOT_PANEL_ID = "antu-boot-error";

export const BOOT_GUARD_SCRIPT = `(function () {
  var shown = false;
  function sameOrigin(url) { return !url || url.indexOf(location.origin) === 0; }
  function show() {
    if (shown || window.${BOOT_FLAG}) return;
    shown = true;
    var render = function () {
      var d = document.createElement("div");
      d.id = "${BOOT_PANEL_ID}";
      d.setAttribute("role", "alert");
      d.style.cssText = "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:#fff;color:#111;font:16px/1.5 -apple-system,system-ui,sans-serif";
      d.innerHTML = '<div style="max-width:360px;text-align:center"><p style="font-size:18px;font-weight:600;margin:0 0 8px">Something went wrong</p><p style="margin:0 0 16px;color:#555">The app couldn\\'t start on this browser. Reload to try again. If it keeps happening, update the device (Settings → General → Software Update).</p><button type="button" style="font:inherit;font-weight:600;padding:10px 20px;border-radius:8px;border:0;background:#111;color:#fff" onclick="location.reload()">Reload</button></div>';
      document.body.appendChild(d);
    };
    if (document.body) render(); else document.addEventListener("DOMContentLoaded", render);
  }
  window.addEventListener("error", function (e) {
    if (window.${BOOT_FLAG}) return;
    var t = e.target;
    if (t && t.tagName === "SCRIPT") { if (sameOrigin(t.src)) show(); return; }
    if (t && t !== window) return;
    if (sameOrigin(e.filename)) show();
  }, true);
})();`;
