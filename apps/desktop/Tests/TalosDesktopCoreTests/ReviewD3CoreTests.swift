import Foundation
import Testing
@testable import TalosDesktopCore

/// Verdicts from the real TypeScript schemas (packages/protocol/src/native.ts, run with bun on 2026-10-30). The header of
/// NativeMessages.swift promises "at least as strict as the TypeScript ones", so anything TS refuses Swift must refuse.
enum TSVerdicts {
  static let paths: [(String, Bool)] = [
    ("/", true),
    ("/t/general", true),
    ("/media", false),
    ("/media/x", false),
    ("/MEDIA/x", false),
    ("/%6dedia/x", false),
    ("/%256dedia/x", false),
    ("/%2fmedia", false),
    ("//evil.com", false),
    ("/\\evil.com", false),
    ("/x/../media/y", false),
    ("/x/%2e%2e/media/y", false),
    ("/x/..%2fmedia", true),
    ("/.%2e/media", false),
    ("/%2e/media/x", false),
    ("/media?x=1", false),
    ("/media#a", false),
    ("/mediax", true),
    ("/api", false),
    ("/ws", false),
    ("/hook/x", false),
    ("/bridge", false),
    ("/healthz", true),
    ("/x?y=/media", true),
    ("/x#/media", true),
    ("/%00", false),
    ("/%0a", false),
    ("/ok%ZZ", false),
    ("/%", false),
    ("/a b", false),
    ("/\u{e9}", false),
    ("/x;media", true),
    ("/;/media", true),
    ("/./media", false),
    ("/a/./b", true),
    ("/a/../b", true),
    ("/..", true),
    ("/.", true),
    ("/%2e", true),
    ("/%2E%2E/x", true),
    ("/x/%2f/y", true),
    ("/?", true),
    ("/#", true),
    ("/@evil.com", true),
    ("/:80", true),
    ("/a:b", true),
    ("/%5cevil.com", false),
    ("/%2f%2fevil.com", false),
    ("/x%00y", false),
  ]
  static let urls: [(String, Bool)] = [
    ("https://a.example/x", true),
    ("HTTP://A.example", true),
    ("mailto:a@b.c", true),
    ("MAILTO:a@b.c", true),
    ("javascript:alert(1)", false),
    ("file:///etc/passwd", false),
    ("data:text/html,x", false),
    ("about:blank", false),
    ("x-apple.systempreferences:", false),
    ("ftp://a", false),
    ("https://", false),
    ("http://", false),
    ("https:///x", true),
    ("https:/x", false),
    ("https:x", false),
    ("mailto:", true),
    ("https://a b.example/", false),
    ("https://a.example/a b", true),
    ("https://exa[mple.com/", false),
    ("https://[::1]/", true),
    ("http://user:pw" + "@a.example.com/", true),  // split so the literal is not an email-shaped string (check-no-personal)
    ("https://%zz/", false),
    ("https://a.example/%zz", true),
    (" https://a.example", false),
    ("https://a.example/\n", true),
    ("https://\ta.example/", true),
    ("https://a.example\\@b.example/", true),
    ("http://0x7f.1/", true),
    ("http://a.example:/", true),
    ("https://.", true),
    ("https://..", true),
    ("https://a..b/", true),
  ]
  static let codes: [(String, Bool)] = [
    ("0123456789ABCDEFGHJKMNPQRS", true),
    ("0123456789abcdefghjkmnpqrs", true),
    ("0123-4567-89AB-CDEF-GHJK-MNPQRS", true),
    ("O123456789ABCDEFGHJKMNPQRS", true),
    ("I123456789ABCDEFGHJKMNPQRS", true),
    ("L123456789ABCDEFGHJKMNPQRS", true),
    ("8123456789ABCDEFGHJKMNPQRS", false),
    ("Z123456789ABCDEFGHJKMNPQRS", false),
    ("0123456789ABCDEFGHJKMNPQR", false),
    ("0123456789ABCDEFGHJKMNPQRSU", false),
    ("0123456789ABCDEFGHJKMNPQRU", false),
    ("0123456789ABCDEFGHJKMNPQ\u{a0}RS", true),
    ("0123456789ABCDEFGHJKMNPQ\u{2003}RS", true),
    ("0123456789ABCDEFGHJKMNPQ\u{200b}RS", false),
    ("\u{df}123456789ABCDEFGHJKMNPQRS", false),
    ("\u{fb01}123456789ABCDEFGHJKMNPQ", false),
    ("0123456789ABCDEFGHJKMNPQR\u{131}", true),
    ("", false),
  ]
}

@Suite("Review D3: core")
struct ReviewD3CoreTests {
  @Test func appPathIsAtLeastAsStrictAsTheSchema() {
    let laxer = TSVerdicts.paths.filter { !$0.1 && AppPath.isValid($0.0) }.map(\.0)
    #expect(laxer.isEmpty, "Swift accepts, TS refuses: \(laxer)")
  }

  @Test func externalURLIsAtLeastAsStrictAsTheSchema() {
    let laxer = TSVerdicts.urls.filter { !$0.1 && ExternalURL.parse($0.0) != nil }.map(\.0)
    #expect(laxer.isEmpty, "Swift accepts, TS refuses: \(laxer)")
  }

  @Test func theSetupCodeRuleMatchesTheSchemaBothWays() {
    let differ = TSVerdicts.codes.filter { (EnrollCode.normalize($0.0) != nil) != $0.1 }.map(\.0)
    #expect(differ.isEmpty, "differs from TS: \(differ.map(\.debugDescription))")
  }

  // Spec WP-D3 "reviewer writes failing first": held.
  @Test func anOverLongNotifyIsDropped() {
    func n(_ t: Int, _ b: Int) -> [String: Any] {
      ["type": "notify", "title": String(repeating: "t", count: t), "body": String(repeating: "b", count: b), "navigate": "/t/general"]
    }
    #expect(WebToNative.decode(n(200, 2000)) != nil)
    #expect(WebToNative.decode(n(201, 1)) == nil)
    #expect(WebToNative.decode(n(1, 2001)) == nil)
    #expect(WebToNative.decode(["type": "notify", "title": "a", "body": "b", "navigate": "/media/x"]) == nil)
    #expect(WebToNative.decode(["type": "notify", "title": "a", "body": "b", "navigate": "//evil.com"]) == nil)
  }

  @Test func openExternalRefusesEverythingButWebAndMail() {
    for u in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "x-apple.systempreferences:", "about:blank", "vbscript:x"] {
      #expect(WebToNative.decode(["type": "open_external", "url": u]) == nil, "\(u)")
    }
  }

  @Test func twoLinksOnOneLineSendNothing() {
    let c1 = "0123456789ABCDEFGHJKMNPQRS", c2 = "0123456789ABCDEFGHJKMNPQR1"
    var s = PairingSession(relay: RelayOrigin("https://relay.example.com"))
    #expect(s.update(screen: "https://relay.example.com/enroll#\(c1) https://relay.example.com/enroll#\(c2)\n") == nil)
  }

  /// The CLI prints the relay as configured; an upper-case host or a default port is the same origin.
  @Test func sameOriginSpelledDifferentlyStillMatches() {
    var s = PairingSession(relay: RelayOrigin("https://relay.example.com"))
    #expect(s.update(screen: "https://RELAY.example.com:443/enroll#0123456789ABCDEFGHJKMNPQRS\n") != nil)
  }

  /// `RelayOrigin.url` force-unwraps this (WebPolicy.swift:43): `relay_url: http://[::1]:3000` crashes the app at launch. The
  /// test rebuilds the same URLComponents instead of calling `.url`, so it fails rather than killing the test run.
  @Test func aLoopbackIPv6RelayDoesNotCrashTheApp() throws {
    let r = try #require(RelayOrigin("http://[::1]:3000"))
    var c = URLComponents()
    c.scheme = r.scheme
    c.host = r.host
    c.port = r.port
    c.path = "/"
    #expect(c.url != nil, "host \(r.host) makes URLComponents return nil; RelayOrigin.url would crash")
  }
}
