import CoreGraphics
import Foundation

/// What the screen socket asks of the screen helper. `ScreenCore` is the real one; tests give a fake.
public protocol ScreenService: Sendable {
  func shot(area: ScreenArea, allowed: ScreenAllowed) async throws(ScreenRefusal) -> ScreenShot
  func input(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int
  /// Types text and reads the field back.
  func type(_ text: String, allowed: ScreenAllowed) throws(ScreenRefusal) -> (events: Int, readBack: ScreenCore.ReadBack)
  func listApps() -> [ScreenApp]
  func open(bundleID: String, allowed: ScreenAllowed) async throws(ScreenRefusal)
}

extension ScreenService {
  /// A service with no read-back: the text is sent, and nothing says it landed.
  public func type(_ text: String, allowed: ScreenAllowed) throws(ScreenRefusal) -> (events: Int, readBack: ScreenCore.ReadBack) {
    (try input(.type(text), allowed: allowed), .unverified)
  }
}

extension ScreenCore: ScreenService {
  public func type(_ text: String, allowed: ScreenAllowed) throws(ScreenRefusal) -> (events: Int, readBack: ReadBack) {
    try typeText(text, allowed: allowed)
  }
  public func shot(area: ScreenArea, allowed: ScreenAllowed) async throws(ScreenRefusal) -> ScreenShot {
    try await agentCapture(allowed: allowed, area: area)
  }
  public func input(_ request: ScreenInputRequest, allowed: ScreenAllowed) throws(ScreenRefusal) -> Int {
    try perform(request, allowed: allowed)
  }
  public func listApps() -> [ScreenApp] { runningApps() }
  public func open(bundleID: String, allowed: ScreenAllowed) async throws(ScreenRefusal) {
    try await openApp(bundleID: bundleID, allowed: allowed)
  }
}

/// Where the allow list comes from (`ScreenAllowStore`, the owner's signed approvals). Read-only here.
public protocol ScreenAllowListProvider: Sendable {
  func allowedApps() -> [ScreenAllowedApp]
}

/// No app allowed: what the socket uses when it has no store.
public struct EmptyScreenAllowList: ScreenAllowListProvider {
  public init() {}
  public func allowedApps() -> [ScreenAllowedApp] { [] }
}

/// The screen socket's protocol (`$TALOS_APP_HOME/run/screen.sock`): one JSON object per line each way, `v` 1.
///
/// Request: `{"v":1,"id":"…","op":"shot"|"click"|"type"|"key"|"scroll"|"apps"|"open_app"|"ask_info"|"allow", …}`. Unknown fields
/// are ignored. Answer: `{"v":1,"id":"…","ok":true, …}` or `{"v":1,"id":"…","ok":false,"error":{"code":"…","text":"…","app":"…"}}`.
/// Every failure is an answer with a code; nothing here asks macOS for a permission or waits on the owner.
///
/// Consent (lane 3): an `app_not_allowed` refusal about an app the Mac could measure also carries `ask` (an id for that measurement)
/// and `app_name`. The bridge asks back with `ask_info` for the app's id, team and requirement to put on the owner's card, and hands
/// the owner's signed tap over with `allow`; the Mac checks it and writes the list. Neither changes anything without that proof.
public struct ScreenProtocol: Sendable {
  public static let version = 1
  /// The longest request line, newline included. Typing is capped at 10,000 characters, which fits with room.
  public static let maxRequestBytes = 64 * 1024

  /// Codes the server itself sends, beside `ScreenRefusal.code`.
  public enum ServerCode {
    public static let badJSON = "bad_json"
    public static let unknownOp = "unknown_op"
    public static let unsupportedVersion = "unsupported_version"
    public static let requestTooLarge = "request_too_large"
    public static let peerRefused = "peer_refused"
    public static let timedOut = "timed_out"
    public static let busy = "busy"
    public static let askUnknown = "ask_unknown"
    public static let allowRefused = "allow_refused"
  }

  let service: any ScreenService
  let allowList: any ScreenAllowListProvider
  let signing: any ScreenCodeSigning
  let asks: ScreenAskBook
  /// Where an owner's approval is written; nil: `allow` is refused (no store in this process).
  let store: ScreenAllowStore?

  public init(
    service: any ScreenService, allowList: any ScreenAllowListProvider, signing: any ScreenCodeSigning,
    asks: ScreenAskBook = ScreenAskBook(), store: ScreenAllowStore? = nil
  ) {
    self.service = service
    self.allowList = allowList
    self.signing = signing
    self.asks = asks
    self.store = store
  }

  /// One request line (without its newline) to one answer line (without its newline).
  public func answer(_ line: Data) async -> Data {
    guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
      return Self.error(id: nil, code: ServerCode.badJSON, text: "The request is not a JSON object.")
    }
    let id = (obj["id"] as? String).map { String($0.prefix(100)) }
    if let v = obj["v"], (v as? Int) != Self.version {
      return Self.error(id: id, code: ServerCode.unsupportedVersion, text: "This Talos app speaks version 1 of the screen socket.")
    }
    let allowed = ScreenAllowed(apps: allowList.allowedApps(), signing: signing)
    do {
      switch obj["op"] as? String {
      case "shot":
        let shot = try await service.shot(area: try Self.area(obj["area"]), allowed: allowed)
        return Self.ok(
          id: id,
          [
            "png_base64": shot.png.base64EncodedString(), "width": shot.width, "height": shot.height,
            "area": Self.rect(shot.area), "shown_apps": shot.shownApps ?? [], "hidden_windows": shot.hiddenWindows,
          ])
      case "click":
        let button = try Self.button(obj["button"])
        let count = obj["count"] == nil ? 1 : try Self.int(obj["count"], "count")
        let n = try service.input(.click(try Self.point(obj), button: button, count: count), allowed: allowed)
        return Self.ok(id: id, ["events": n])
      case "type":
        guard let text = obj["text"] as? String else { throw ScreenRefusal.badRequest("type needs text") }
        let t = try service.type(text, allowed: allowed)
        var body: [String: Any] = ["events": t.events]
        switch t.readBack {
        case .verified: body["read_back"] = "verified"
        case .mismatch(let suffix): body["read_back"] = "mismatch"; body["field_suffix"] = suffix
        case .unverified: body["read_back"] = "unverified"
        }
        return Self.ok(id: id, body)
      case "key":
        guard let keys = obj["keys"] as? String else { throw ScreenRefusal.badRequest("key needs keys, like \"cmd+s\"") }
        return Self.ok(id: id, ["events": try service.input(.key(keys), allowed: allowed)])
      case "scroll":
        let dx = obj["dx"] == nil ? 0 : try Self.int(obj["dx"], "dx")
        let dy = obj["dy"] == nil ? 0 : try Self.int(obj["dy"], "dy")
        let n = try service.input(.scroll(at: try Self.point(obj), dx: dx, dy: dy), allowed: allowed)
        return Self.ok(id: id, ["events": n])
      case "apps":
        let apps: [[String: Any]] = service.listApps().map { a in
          var o: [String: Any] = ["name": a.name, "pid": Int(a.pid), "allowed": allowed.allows(bundleID: a.bundleID, pid: a.pid)]
          if let b = a.bundleID { o["bundle_id"] = b }
          return o
        }
        return Self.ok(id: id, ["apps": apps])
      case "open_app":
        guard let b = obj["bundle_id"] as? String else { throw ScreenRefusal.badRequest("open_app needs bundle_id") }
        try await service.open(bundleID: b, allowed: allowed)
        return Self.ok(id: id, [:])
      case "ask_info":
        guard let ask = obj["ask"] as? String, let who = asks.identity(ask) else {
          return Self.error(
            id: id, code: ServerCode.askUnknown, text: "That request is too old or unknown. Use the app again to ask the owner.")
        }
        return Self.ok(
          id: id,
          [
            "bundle_id": who.bundleID, "team_id": who.teamID.map { $0 as Any } ?? NSNull(), "requirement": who.requirement,
            "name": who.name, "signer": who.signer.rawValue,
          ])
      case "allow":
        guard let store else {
          return Self.error(id: id, code: ServerCode.allowRefused, text: "This Talos app keeps no allowed list, so nothing was allowed.")
        }
        guard let proof = ScreenAllowProof.parse(obj["proof"]) else { throw ScreenRefusal.badRequest("allow needs the owner's proof") }
        switch store.add(proof) {
        case .success(let app): return Self.ok(id: id, ["bundle_id": app.bundleID, "name": app.name])
        case .failure(let e): return Self.error(id: id, code: ServerCode.allowRefused, text: e.text)
        }
      case let op:
        return Self.error(id: id, code: ServerCode.unknownOp, text: "No screen operation \"\(String((op ?? "").prefix(40)))\".")
      }
    } catch let r as ScreenRefusal {
      if case .appNotAllowed(let app, let subject?) = r { return notAllowed(id: id, app: app, subject: subject) }
      return Self.error(id: id, code: r.code, text: r.reason, app: r.app)
    } catch {
      return Self.error(id: id, code: ScreenRefusal.badRequest("").code, text: ScreenRefusal.detail(error))
    }
  }

  static func area(_ v: Any?) throws(ScreenRefusal) -> ScreenArea {
    guard let v else { return .full }
    guard let o = v as? [String: Any], let kind = o["kind"] as? String else { throw .badRequest("area needs a kind") }
    switch kind {
    case "full": return .full
    case "display": return .display(UInt32(clamping: try int(o["id"], "area.id")))
    case "window": return .window(UInt32(clamping: try int(o["id"], "area.id")))
    case "region":
      return .region(
        CGRect(
          x: try num(o["x"], "area.x"), y: try num(o["y"], "area.y"), width: try num(o["width"], "area.width"),
          height: try num(o["height"], "area.height")))
    default: throw .badRequest("no area kind \"\(kind.prefix(40))\"")
    }
  }

  static func point(_ o: [String: Any]) throws(ScreenRefusal) -> CGPoint {
    CGPoint(x: try num(o["x"], "x"), y: try num(o["y"], "y"))
  }

  static func button(_ v: Any?) throws(ScreenRefusal) -> ScreenMouseButton {
    guard let v else { return .left }
    guard let s = v as? String, let b = ScreenMouseButton(rawValue: s) else { throw .badRequest("button is left, right or middle") }
    return b
  }

  /// A JSON number (never a bool: JSONSerialization reads `true` as 1).
  static func num(_ v: Any?, _ name: String) throws(ScreenRefusal) -> Double {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else {
      throw .badRequest("\(name) needs a number")
    }
    return n.doubleValue
  }

  static func int(_ v: Any?, _ name: String) throws(ScreenRefusal) -> Int {
    let d = try num(v, name)
    guard d == d.rounded(), abs(d) < 1e9 else { throw .badRequest("\(name) needs a whole number") }
    return Int(d)
  }

  static func rect(_ r: CGRect) -> [String: Any] { ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height] }

  static func ok(id: String?, _ fields: [String: Any]) -> Data {
    var o = fields
    o["v"] = version
    o["ok"] = true
    if let id { o["id"] = id }
    return encode(o)
  }

  /// An app that is not on the list: measured here, so the bridge can ask the owner about exactly this app. An app that can never be
  /// on the list (unsigned, no app id, Talos) is said so in words, with no `ask`.
  func notAllowed(id: String?, app: String, subject: ScreenSubject) -> Data {
    let found: ScreenCodeLookup
    switch subject {
    case .running(let pid): found = signing.lookup(pid: pid)
    case .installed(let path): found = signing.lookup(appPath: path)
    }
    let plain = ScreenRefusal.appNotAllowed(app: app)
    switch found {
    case .signed(let who):
      if ScreenCore.isTalos(who.bundleID) { return Self.error(id: id, code: ScreenRefusal.talosItself.code, text: ScreenRefusal.talosItself.reason) }
      let ask = asks.record(who)
      return Self.error(id: id, code: plain.code, text: plain.reason, app: who.bundleID, extra: ["ask": ask, "app_name": who.name])
    case .unsigned(let name):
      let r = ScreenRefusal.appNotAllowable(app: app, why: "\(Self.clip(name)) isn't signed, so it can't be put on this Mac's allowed list.")
      return Self.error(id: id, code: r.code, text: r.reason, app: app)
    case .noBundleID(let name):
      let r = ScreenRefusal.appNotAllowable(app: app, why: "\(Self.clip(name)) has no app id, so it can't be put on this Mac's allowed list.")
      return Self.error(id: id, code: r.code, text: r.reason, app: app)
    case .gone:
      return Self.error(id: id, code: plain.code, text: plain.reason, app: app)
    }
  }

  static func clip(_ s: String) -> String {
    let one = s.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
    return one.isEmpty ? "That app" : String(one.prefix(80))
  }

  public static func error(id: String?, code: String, text: String, app: String? = nil, extra: [String: Any] = [:]) -> Data {
    var e: [String: Any] = extra
    e["code"] = code
    e["text"] = text
    if let app { e["app"] = app }
    var o: [String: Any] = ["v": version, "ok": false, "error": e]
    if let id { o["id"] = id }
    return encode(o)
  }

  static func encode(_ o: [String: Any]) -> Data {
    (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]))
      ?? Data(#"{"error":{"code":"bad_json","text":"The answer could not be made."},"ok":false,"v":1}"#.utf8)
  }
}
