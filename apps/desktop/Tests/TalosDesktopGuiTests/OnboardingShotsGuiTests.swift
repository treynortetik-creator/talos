import AppKit
import Foundation
import SwiftUI
import Testing
import TalosDesktopCore

@testable import TalosDesktop

/// Not an assertion suite for looks: renders every setup screen, in the states the mock shows, to PNG files at the mock's size (760 by 560;
/// Hello 960 by 640) for a person to compare with the approved mock. Runs only with TALOS_GUI_TESTS=1 and TALOS_ONBOARDING_SHOTS (a
/// folder). It also asserts what a picture cannot show: the pixels are not blank, and each screen is the size the mock draws.
@Suite("Onboarding screens to PNG", .serialized, .guiExclusive, .enabled(if: guiTestsEnabled && ProcessInfo.processInfo.environment["TALOS_ONBOARDING_SHOTS"] != nil))
@MainActor
struct OnboardingShotsGuiTests {
  func resources() -> URL {
    // apps/desktop/Tests/TalosDesktopGuiTests/<file> -> apps/desktop/Resources/onboarding
    URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("Resources/onboarding")
  }

  func render<V: View>(_ v: V, size: CGSize, to path: String) async throws {
    _ = NSApplication.shared
    OnboardingFonts.directoryOverride = resources()
    let host = NSHostingView(rootView: AnyView(v.frame(width: size.width, height: size.height)))
    let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.appearance = NSAppearance(named: .aqua)
    w.contentView = host
    host.frame = NSRect(origin: .zero, size: size)
    host.layoutSubtreeIfNeeded()
    await pump(0.6)
    host.layoutSubtreeIfNeeded()
    host.displayIfNeeded()
    let raw = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: raw)
    // the file's numbers are sRGB (the mock's #d9692b is an sRGB value), whatever colour space this display draws in
    let rep = try #require(raw.converting(to: NSColorSpace.sRGB, renderingIntent: .default))
    #expect(rep.pixelsWide == Int(size.width) * (rep.pixelsWide / Int(size.width)), "an exact multiple of the mock's width")
    #expect(rep.pixelsWide / Int(size.width) >= 1)
    // not blank: the cream ground and at least one other colour
    var seen = Set<UInt32>()
    for x in stride(from: 0, to: rep.pixelsWide, by: 7) {
      for y in stride(from: 0, to: rep.pixelsHigh, by: 7) {
        if let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) {
          seen.insert(UInt32(c.redComponent * 255) << 16 | UInt32(c.greenComponent * 255) << 8 | UInt32(c.blueComponent * 255))
        }
      }
    }
    #expect(seen.count > 6, "\(path) looks blank")
    let png = try #require(rep.representation(using: .png, properties: [:]))
    try png.write(to: URL(fileURLWithPath: path))
    // read the file back: what is checked is what was saved
    let back = try #require(NSBitmapImageRep(data: png))
    if path.hasSuffix("/main.png") {
      // the accent is the mock's #d9692b as the file's own numbers (the file holds sRGB values), in plenty of pixels (the Get started pill)
      let data = try #require(back.bitmapData)
      let per = back.bitsPerPixel / 8
      var near = 0
      for i in 0..<(back.pixelsWide * back.pixelsHigh) {
        let px = data + i * per
        if abs(Int(px[0]) - 0xD9) <= 1, abs(Int(px[1]) - 0x69) <= 1, abs(Int(px[2]) - 0x2B) <= 1 { near += 1 }
      }
      #expect(near > 400, "the accent is not #d9692b in sRGB (\(near) pixels)")
    }

  }

  func flow(_ events: [OnboardingFlow.Event]) -> OnboardingFlow {
    var f = OnboardingFlow()
    for e in events { f.apply(e) }
    return f
  }

  @Test func everyScreen() async throws {
    let dir = try #require(ProcessInfo.processInfo.environment["TALOS_ONBOARDING_SHOTS"])
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let std = CGSize(width: OB.width, height: OB.height)
    func shot(_ name: String, _ f: OnboardingFlow, _ extras: OnboardingExtras = .init()) async throws {
      try await render(OnboardingRootView(flow: f, extras: extras), size: std, to: dir + "/\(name).png")
    }
    let link = "https://talos.example/enroll#0123456789ABCDEFGHJKMNPQRS"

    try await shot("main", flow([]))
    try await shot("ready", flow([.getStarted, .downloadProgress(pct: 62)]), .init(downloadElapsed: 100))
    try await shot("apple-tools-asking", flow([.getStarted, .toolsAsked]))
    try await shot("apple-tools-installing", flow([.getStarted, .toolsAsked, .toolsInstalling(pct: 40)]))
    try await shot("sign-in", flow([.getStarted, .downloadDone(signedIn: false)]))
    try await shot("sign-in-waiting", flow([.getStarted, .downloadDone(signedIn: false), .signInPressed]), .init(signInLink: "https://claude.ai/x"))
    try await shot("phone", flow([.getStarted, .downloadDone(signedIn: true)]))
    // the same step with the pair screen's outlined pills, and its failure
    try await shot("pair-failed", flow([.getStarted, .downloadDone(signedIn: true), .phoneLinkKnown(true), .choosePhone, .pairFailed(OnboardingCopy.pairFailed)]))
    try await shot("pair-waiting", flow([.getStarted, .downloadDone(signedIn: true), .phoneLinkKnown(true), .choosePhone, .pairLink(link)]))
    try await shot(
      "pair", flow([.getStarted, .downloadDone(signedIn: true), .phoneLinkKnown(true), .choosePhone, .pairLink(link), .pairWords(["amber", "falcon", "river", "stone"])]))
    try await shot("offline", flow([.getStarted, .downloadProgress(pct: 62), .downloadOffline]))
    try await render(HelloPreview(phoneConnected: true), size: OB.helloSize, to: dir + "/hello.png")
    try await render(HelloPreview(phoneConnected: false), size: OB.helloSize, to: dir + "/hello-no-phone.png")

    for n in ["main", "ready", "apple-tools-asking", "apple-tools-installing", "sign-in", "sign-in-waiting", "phone", "pair", "offline", "hello", "hello-no-phone", "pair-failed"] {
      #expect(FileManager.default.fileExists(atPath: dir + "/\(n).png"))
    }
  }
}

/// A stand-in for the Talos window at the end of setup (Hello): the app's own chat with the agent's first message, drawn from the same
/// words `FirstHello` asks Main for. The real screen is the Talos web window; this exists only so the greeting can be compared with the
/// mock. It is never shown to an owner.
private struct HelloPreview: View {
  var phoneConnected: Bool
  var body: some View {
    VStack(spacing: 0) {
      Text("Talos").font(OB.body(13)).foregroundStyle(OB.cream).frame(maxWidth: .infinity).frame(height: 40).background(OB.ink)
      HStack(spacing: 0) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Talos").font(OB.heading(20)).foregroundStyle(Color(hex: 0xEC8A52)).padding(.horizontal, 8).padding(.bottom, 12)
          row("General", selected: true)
          row("Inbox", selected: false)
          Spacer()
          HStack(spacing: 8) {
            Circle().fill(phoneConnected ? Color(hex: 0x74B85A) : Color(hex: 0xB8A68E)).frame(width: 8, height: 8)
            Text(phoneConnected ? OnboardingCopy.helloStatusConnected : OnboardingCopy.helloStatusNoPhone).font(OB.body(12)).foregroundStyle(Color(hex: 0xB8A68E))
          }
          .padding(.horizontal, 10)
        }
        .padding(.vertical, 16).padding(.horizontal, 12)
        .frame(width: 220).background(OB.ink)
        VStack(spacing: 0) {
          Text("General").font(OB.heading(20)).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 24).frame(height: 56)
            .overlay(alignment: .bottom) { OB.line.frame(height: 1) }
          VStack(alignment: .leading, spacing: 16) {
            Spacer()
            HStack(alignment: .top, spacing: 14) {
              Group {
                if let img = OnboardingFonts.robot() { Image(nsImage: img).resizable().scaledToFit() } else { Color.clear }
              }
              .frame(width: 44, height: 44).background(Circle().fill(OB.paper)).overlay(Circle().stroke(OB.line, lineWidth: 1))
              VStack(alignment: .leading, spacing: 12) {
                Text(phoneConnected ? OnboardingCopy.helloGreeting[0] : OnboardingCopy.helloGreetingNoPhone)
                Text(OnboardingCopy.helloGreeting[1])
                VStack(alignment: .leading, spacing: 4) {
                  ForEach(OnboardingCopy.helloOffers, id: \.self) { t in Text("\u{2022}  " + t) }
                }
                Text(OnboardingCopy.helloAsk)
              }
              .font(OB.body(15)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
              .padding(.horizontal, 18).padding(.vertical, 16).background(RoundedRectangle(cornerRadius: 16).fill(OB.paper))
              .overlay(RoundedRectangle(cornerRadius: 16).stroke(OB.line, lineWidth: 1))
              .frame(maxWidth: 600, alignment: .leading)
            }
            HStack(spacing: 8) {
              ForEach(Array((phoneConnected ? OnboardingCopy.helloChips : OnboardingCopy.helloChipsNoPhone).enumerated()), id: \.offset) { i, t in
                Text(t).font(OB.body(14, .medium)).foregroundStyle(i < 2 ? OB.link : OB.muted).padding(.horizontal, 16).frame(height: 40)
                  .background(OutlineCapsule(color: i < 2 ? OB.accent : OB.line))
              }
            }
            .padding(.leading, 58)
          }
          .padding(24).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
          HStack {
            Text("Message Talos").font(OB.body(15)).foregroundStyle(OB.muted)
            Spacer()
            Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(OB.ink).frame(width: 40, height: 40)
              .background(Circle().fill(OB.accent))
          }
          .padding(.leading, 18).padding(.trailing, 8).padding(.vertical, 8)
          .background(RoundedRectangle(cornerRadius: 22).fill(OB.paper)).overlay(RoundedRectangle(cornerRadius: 22).stroke(OB.line, lineWidth: 1))
          .padding(.horizontal, 24).padding(.bottom, 20)
        }
        .background(OB.cream)
      }
    }
    .foregroundStyle(OB.ink)
  }

  private func row(_ t: String, selected: Bool) -> some View {
    HStack(spacing: 10) {
      Circle().fill(selected ? OB.accent : Color.clear).frame(width: 8, height: 8)
      Text(t).font(OB.body(14, selected ? .medium : .regular))
    }
    .foregroundStyle(selected ? OB.cream : Color(hex: 0xB8A68E))
    .padding(.horizontal, 10).frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color(hex: 0x2E261F) : Color.clear))
  }
}
