import Foundation
import TalosDesktopCore
import WebKit

/// What the page asked for, after the gate and the strict decoder. The window implements this.
@MainActor
protocol NativeBridgeDelegate: AnyObject {
  func nativeMessage(_ m: WebToNative)
}

/// The one `WKScriptMessageHandlerWithReply` named `talos` (DESKTOP-SPEC 5.3). A message is dropped unless it comes from
/// the main frame, on the relay origin (not opaque, not empty), while the main frame is not on a /media/ path; then it
/// must decode under the strict schema. Nothing is ever executed from a message.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
  weak var delegate: NativeBridgeDelegate?
  var relay: RelayOrigin
  /// Count of dropped messages (tests and the About box).
  private(set) var dropped = 0

  init(relay: RelayOrigin) { self.relay = relay }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
    replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
  ) {
    replyHandler(nil, nil)  // there is nothing to answer; the page learns state from native -> web messages
    guard accept(message.frameInfo, mainFrameURL: message.webView?.url), let m = WebToNative.decode(message.body) else {
      dropped += 1
      return
    }
    delegate?.nativeMessage(m)
  }

  func accept(_ frame: WKFrameInfo, mainFrameURL: URL?) -> Bool {
    let o = frame.securityOrigin
    let path = mainFrameURL.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedPath }
    let sender = WebPolicy.Sender(
      isMainFrame: frame.isMainFrame, scheme: o.protocol, host: o.host, port: o.port == 0 ? nil : o.port,
      mainFramePath: path)
    // The main frame's own URL must also be on the relay: a page at another origin can't be "main frame, relay origin".
    guard let u = mainFrameURL, relay.contains(u) else { return false }
    return WebPolicy.accepts(sender, relay: relay)
  }
}
