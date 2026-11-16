import Foundation

/// A thread session's plan-usage reading (packages/protocol usage-readings.ts says why): the session's status line runs
/// `recorderSource`, which writes the status line's `rate_limits` with the time into `workers/<id>/usage.json`, and the bridge reads
/// that file on its poll and shows the newest reading of any session. The Linux twin is `usageRecorderCommand` in the protocol
/// package; swift-parity.test.ts holds the program and the command's shape equal.
public enum WorkerUsage {
  /// The file the status line writes, beside the session's settings file.
  public static func path(talosHome: String, threadId: String) -> String { talosHome + "/workers/" + threadId + "/usage.json" }

  /// The recorder: reads the status-line JSON on stdin, keeps `rate_limits` and the session id, writes them with `at` through a
  /// temporary file and a rename, prints "Talos: <model> | 7d: N%" and exits 0 on anything. The model's name: every character outside
  /// [A-Za-z0-9 .()+-] made a space, runs of spaces made one, from its first letter or digit, cut at 40 and never ending in a space; N
  /// rounded and held to 0-100, the " | 7d" part left out with no reading. No name left: plain "Talos", with no reading either. The key guard allows exactly that row under Claude's input box (BoxFrame.talosStatusLine). No backslash and no single quote in it.
  public static let recorderSource = """
    import json, os, sys, time
    def main():
        p = sys.argv[1]
        try:
            d = json.loads(sys.stdin.read(1048576) or "{}")
        except Exception:
            d = {}
        if not isinstance(d, dict):
            d = {}
        r = d.get("rate_limits")
        if isinstance(r, dict) and r:
            keep = {}
            for k, w in list(r.items())[:6]:
                if isinstance(k, str) and len(k) <= 24 and isinstance(w, dict):
                    keep[k] = {x: w[x] for x in ("used_percentage", "resets_at") if type(w.get(x)) in (int, float)}
            try:
                t = "%s.%d.tmp" % (p, os.getpid())
                with open(t, "w") as f:
                    json.dump({"v": 1, "session_id": str(d.get("session_id") or "")[:64], "at": time.time(), "rate_limits": keep}, f)
                os.replace(t, p)
            except Exception:
                pass
        name = ""
        m = d.get("model")
        if isinstance(m, dict) and isinstance(m.get("display_name"), str):
            kept = "".join(c if c.isascii() and (c.isalnum() or c in ".()+-") else " " for c in m["display_name"][:400])
            kept = " ".join(kept.split())
            while kept and not kept[0].isalnum():
                kept = kept[1:]
            name = kept[:8].rstrip(" .")
        if not name:
            print("Talos")
            return
        out = "Talos: " + name
        try:
            n = min(100, max(0, int(round(float(r["seven_day"]["used_percentage"])))))
            out = out + " | 7d: %d%%" % n
        except Exception:
            pass
        print(out)
    try:
        main()
    except Exception:
        pass
    """

  /// The `statusLine.command`: the recorder run by the permission hook's python3 (absolute) in an emptied environment, isolated.
  public static func command(python: String, usageFile: String) -> String {
    "exec /usr/bin/env -i PATH=/usr/bin:/bin LANG=en_US.UTF-8 \(WorkerHook.quote(python)) -I -c \(WorkerHook.quote(recorderSource)) \(WorkerHook.quote(usageFile))"
  }

  /// The settings' `statusLine` entry for a session.
  public static func statusLine(python: String, talosHome: String, threadId: String) -> [String: Any] {
    ["type": "command", "command": command(python: python, usageFile: path(talosHome: talosHome, threadId: threadId)), "padding": 0]
  }
}
