import Foundation
import Testing
@testable import TalosDesktopCore

@Suite("WebPolicy")
struct WebPolicyTests {
  let relay = RelayOrigin("https://relay.example.com")!
  func u(_ s: String) -> URL { URL(string: s)! }

  @Test func onlyTheRelayOriginLoads() {
    #expect(WebPolicy.decide(u("https://relay.example.com/"), relay: relay) == .allow)
    #expect(WebPolicy.decide(u("https://RELAY.example.com:443/t/general"), relay: relay) == .allow)
    #expect(WebPolicy.decide(u("https://relay.example.com/enroll#abc"), relay: relay) == .allow)
  }

  @Test func mediaGoesToTheBrowserWhateverTheSpelling() {
    for p in ["/media/x/page", "/MEDIA/x", "/%6dedia/x", "/%256dedia/x", "/a/../media/x", "/media", "//media/x", "/./media/x", "/a/%2e%2e/media/x"] {
      let url = u("https://relay.example.com" + p)
      #expect(WebPolicy.decide(url, relay: relay) == .openExternally(url), "\(p)")
    }
    #expect(WebPolicy.decide(u("https://relay.example.com/mediafoo"), relay: relay) == .allow)
  }

  @Test func otherLinksOpenExternallyAndOddSchemesNeverLoad() {
    let other = u("https://example.org/page")
    #expect(WebPolicy.decide(other, relay: relay) == .openExternally(other))
    // a look-alike host and another port are not the relay
    #expect(WebPolicy.decide(u("https://relay.example.com.evil.example/"), relay: relay) == .openExternally(u("https://relay.example.com.evil.example/")))
    #expect(WebPolicy.decide(u("https://relay.example.com:8443/"), relay: relay) == .openExternally(u("https://relay.example.com:8443/")))
    #expect(WebPolicy.decide(u("http://relay.example.com/"), relay: relay) == .openExternally(u("http://relay.example.com/")))
    let mail = u("mailto:a@example.com")
    #expect(WebPolicy.decide(mail, relay: relay) == .openExternally(mail))
    for bad in ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "talos://x", "about:blank", "ftp://x.com/a", "blob:https://relay.example.com/x"] {
      #expect(WebPolicy.decide(u(bad), relay: relay) == .deny, "\(bad)")
    }
  }

  @Test func subframesMayLoadAgentPagesFromTheRelayButNothingElse() {
    #expect(WebPolicy.decideSubframe(u("https://relay.example.com/media/x/page"), relay: relay) == .allow)
    #expect(WebPolicy.decideSubframe(u("https://relay.example.com/t/general"), relay: relay) == .deny)  // not an agent page
    #expect(WebPolicy.decideSubframe(u("about:blank"), relay: relay) == .allow)
    #expect(WebPolicy.decideSubframe(u("about:srcdoc"), relay: relay) == .allow)
    for bad in ["https://evil.example/", "http://relay.example.com/media/x", "data:text/html,x", "blob:https://relay.example.com/a",
      "javascript:1", "file:///etc/passwd", "about:config"]
    {
      #expect(WebPolicy.decideSubframe(u(bad), relay: relay) == .deny, "\(bad)")
    }
  }

  @Test func anIPv6LoopbackRelayHasAUsableURL() {
    let r = RelayOrigin("http://[::1]:3000")
    #expect(r?.host == "[::1]")
    #expect(r?.url.absoluteString.contains("[::1]:3000") == true)
    #expect(r?.contains(URL(string: "http://[::1]:3000/x")!) == true)
  }

  @Test func relayOriginParsing() {
    #expect(RelayOrigin("https://relay.example.com/") == RelayOrigin("https://relay.example.com"))
    #expect(RelayOrigin("http://relay.example.com") == nil)  // plain http only for loopback
    #expect(RelayOrigin("http://localhost:4173")?.port == 4173)
    #expect(RelayOrigin("ftp://x.com") == nil)
    #expect(RelayOrigin("not a url") == nil)
    #expect(RelayOrigin("https://relay.example.com:443")?.port == nil)
  }

  func sender(main: Bool = true, scheme: String? = "https", host: String? = "relay.example.com", port: Int? = nil, path: String? = "/") -> WebPolicy.Sender {
    .init(isMainFrame: main, scheme: scheme, host: host, port: port, mainFramePath: path)
  }

  @Test func theMicrophoneIsForTheRelaysOwnPageOnly() {
    let page = u("https://relay.example.com/t/general")
    #expect(WebPolicy.grantsMedia(.microphone, sender: sender(path: "/t/general"), mainFrameURL: page, relay: relay))
    #expect(!WebPolicy.grantsMedia(.camera, sender: sender(path: "/t/general"), mainFrameURL: page, relay: relay))
    #expect(!WebPolicy.grantsMedia(.cameraAndMicrophone, sender: sender(path: "/t/general"), mainFrameURL: page, relay: relay))
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(main: false), mainFrameURL: page, relay: relay))  // an iframe
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(host: "evil.example"), mainFrameURL: page, relay: relay))
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(host: ""), mainFrameURL: page, relay: relay))  // opaque
    let agentPage = u("https://relay.example.com/media/x/page")
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(path: "/media/x/page"), mainFrameURL: agentPage, relay: relay))
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(), mainFrameURL: u("https://evil.example/"), relay: relay))
    #expect(!WebPolicy.grantsMedia(.microphone, sender: sender(), mainFrameURL: nil, relay: relay))
  }

  @Test func theNativeHandlerAcceptsOnlyTheRelaysMainFrame() {
    #expect(WebPolicy.accepts(sender(), relay: relay))
    #expect(WebPolicy.accepts(sender(path: "/t/general"), relay: relay))
    #expect(!WebPolicy.accepts(sender(main: false), relay: relay))  // an iframe
    #expect(!WebPolicy.accepts(sender(host: "evil.example"), relay: relay))
    #expect(!WebPolicy.accepts(sender(host: ""), relay: relay))  // opaque origin (a sandboxed document)
    #expect(!WebPolicy.accepts(sender(scheme: nil, host: nil), relay: relay))
    #expect(!WebPolicy.accepts(sender(scheme: "http"), relay: relay))
    #expect(!WebPolicy.accepts(sender(port: 8443), relay: relay))
    #expect(!WebPolicy.accepts(sender(path: "/media/x/page"), relay: relay))  // an agent page loaded top-level
    #expect(!WebPolicy.accepts(sender(path: "/%6dedia/x"), relay: relay))
    #expect(!WebPolicy.accepts(sender(path: nil), relay: relay))
  }

  @Test func userAgentSuffixHasTheMarkTheWebAppLooksFor() {
    #expect(WebPolicy.userAgentSuffix(version: "1.2.3") == "TalosDesktop/1.2.3")
    #expect(WebPolicy.userAgentSuffix(version: "1 2;3") == "TalosDesktop/123")
    #expect(WebPolicy.userAgentSuffix(version: "") == "TalosDesktop/0")
  }

  @Test func relayComesFromNativeConfigNeverThePage() {
    let env = "# c\nFOO=1\nexport TALOS_APP_RELAY_URL=\"https://my.relay.test/\"  \nTALOS_APP_BRIDGE=1\n"
    #expect(RelayConfig.resolve(configured: "auto", bridgeEnv: env)?.host == "my.relay.test")
    #expect(RelayConfig.resolve(configured: "https://relay.example.com", bridgeEnv: env)?.host == "my.relay.test")  // placeholder
    #expect(RelayConfig.resolve(configured: "https://set.example.net", bridgeEnv: env)?.host == "set.example.net")
    #expect(RelayConfig.resolve(configured: "auto", bridgeEnv: nil) == nil)
    #expect(RelayConfig.resolve(configured: "auto", bridgeEnv: "TALOS_APP_RELAY_URL=http://not-loopback.test") == nil)
    #expect(RelayConfig.envValue("A", in: "A=1\nA=2 # c\n") == "2")
    #expect(RelayConfig.envValue("A", in: "B=1") == nil)
  }
}
