import Foundation
import Testing
import TalosDesktopCore

@testable import TalosSupervisor

/// The look at the release feed that "Check for Updates" makes before anything else is running: on the same signed file feed as the
/// updater's own tests. The updater here is never started and never ticked (the app before sign-in), automatic updates are off in most
/// of these, there is no agent and no clone.
@Suite("Check for updates: the look at the feed", .serialized)
struct UpdateProbeTests {
  typealias Rig = AutoUpdaterTests.Rig

  @Test func upToDateAnswersWithTheRunningVersionAndTouchesNothing() throws {
    let r = try Rig()
    r.on.set(false)  // automatic updates off
    try r.publish(version: "1.4.0")
    let u = r.updater(version: "1.4.0")
    #expect(u.probe() == .upToDate("1.4.0"))
    #expect(r.fetches.get() == 2, "the release note and its signature, nothing else")
    #expect(r.downloads.get() == 0)
    #expect(r.spawns.get().isEmpty)
  }

  @Test func aNewerReleaseIsFoundWithItsVersion() throws {
    let r = try Rig()
    r.on.set(false)
    try r.publish(version: "1.5.0")
    #expect(r.updater(version: "1.4.0").probe() == .newer("1.5.0"))
    #expect(r.downloads.get() == 0, "a look downloads nothing")
  }

  @Test func anUnreachableFeedIsTheServerWhenOnlineAndOfflineWhenThereIsNoNetwork() throws {
    let r = try Rig()
    try r.publish(version: "1.5.0")
    let down: @Sendable (inout AutoUpdater.Hooks) -> Void = { $0.fetch = { _, _, _ in nil } }
    #expect(r.updater(hooks: down).probe() == .problem(.server))
    let offline: @Sendable (inout AutoUpdater.Hooks) -> Void = {
      $0.fetch = { _, _, _ in nil }
      $0.offline = { true }
    }
    #expect(r.updater(hooks: offline).probe() == .problem(.offline))
  }

  @Test func aFeedWithNothingPublishedIsAProblemNotAnEmptyAnswer() throws {
    let r = try Rig()  // nothing published: the files are missing
    let got = r.updater().probe()
    guard case .problem = got else { Issue.record("expected a problem, got \(got)"); return }
  }

  @Test func aTamperedReleaseNoteIsUnverified() throws {
    let r = try Rig()
    try r.publish(version: "1.5.0", tamper: true)
    #expect(r.updater(version: "1.4.0").probe() == .problem(.unverified))
  }

  @Test func aReleaseSignedWithAnUnknownKeyIsUnverified() throws {
    let r = try Rig()
    try r.publish(version: "1.5.0", key: "other")
    #expect(r.updater(version: "1.4.0").probe() == .problem(.unverified))
  }

  @Test func aBuildWithNoReleaseKeyOrVersionSaysSoInsteadOfStayingSilent() throws {
    let r = try Rig()
    try r.publish(version: "1.5.0")
    var o = AutoUpdater.Options(talosHome: r.home, appPath: r.dest + "/Talos.app", appVersion: nil, keys: ReleaseTrust.testKeys)
    o.allowLocalFeed = true
    let h = AutoUpdater.Hooks(settings: { (true, nil) }, checkout: { nil }, look: { [] }, post: { _ in }, env: { [:] })
    #expect(AutoUpdater(options: o, hooks: h).probe() == .problem(.other))
  }
}
