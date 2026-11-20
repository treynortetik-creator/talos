import Foundation
import Testing

@testable import TalosDesktopCore

/// Apple's installer helper "appears" after a number of looks, as the real one takes a moment after `xcode-select --install`.
private final class AppearingApps: AppActivating, @unchecked Sendable {
  private let lock = NSLock()
  private var looks = 0
  let appearsAtLook: Int?
  init(appearsAtLook: Int?) { self.appearsAtLook = appearsAtLook }
  var count: Int { lock.withLock { looks } }
  func isRunning(bundleID: String) -> Bool { lock.withLock { appearsAtLook.map { looks >= $0 } ?? false } }
  func activate(bundleID: String) -> Bool {
    lock.withLock {
      looks += 1
      guard bundleID == AppleInstallerFront.bundleID, let at = appearsAtLook else { return false }
      return looks >= at
    }
  }
}

@Suite("Apple's installer comes forward")
struct AppleInstallerFrontTests {
  @Test func itLooksAgainUntilTheHelperAppearsThenRaisesIt() async {
    let apps = AppearingApps(appearsAtLook: 4)
    let slept = Counter()
    let ok = await AppleInstallerFront.bringForward(apps, attempts: 10, interval: 0.5, sleep: { _ in slept.bump() })
    #expect(ok)
    #expect(apps.count == 4, "it stops at the first success")
    #expect(slept.value == 3, "one pause between looks, none after the last")
  }

  @Test func aHelperThatNeverAppearsGivesUpAfterTheAttemptsAndSaysSo() async {
    let apps = AppearingApps(appearsAtLook: nil)
    let ok = await AppleInstallerFront.bringForward(apps, attempts: 5, interval: 0.5, sleep: { _ in })
    #expect(!ok)
    #expect(apps.count == 5)
  }

  @Test func theBundleIdIsApplesInstallOnDemandHelper() {
    #expect(AppleInstallerFront.bundleID == "com.apple.dt.CommandLineTools.installondemand")
  }

  @Test func theDefaultLooksOutlastTheFewSecondsAppleNeeds() async {
    // 12 looks at half a second is about 5.5 seconds of looking, with the real pause replaced here by a counter
    let slept = Counter()
    let sum = Sum()
    _ = await AppleInstallerFront.bringForward(AppearingApps(appearsAtLook: nil), sleep: { sum.add($0); slept.bump() })
    #expect(sum.value >= 4.5 && sum.value <= 8)
  }
}

private final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func bump() { lock.withLock { n += 1 } }
  var value: Int { lock.withLock { n } }
}

private final class Sum: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0.0
  func add(_ x: Double) { lock.withLock { n += x } }
  var value: Double { lock.withLock { n } }
}

@Suite("Where the app runs from")
struct AppLocationTests {
  let id = "8A0F1C52-6D2B-4F0E-9B1E-3F5A7C9D2E10"

  @Test func aTranslocatedCopyIsOffered() {
    let p = "/private/var/folders/xy/abc123/T/AppTranslocation/\(id)/d/Talos.app"
    #expect(AutoUpdate.isTranslocated(p))
    #expect(AppLocation.shouldOfferMove(bundlePath: p, home: "/home/alex", isRelease: true))
  }

  @Test func aCopyOutsideTheApplicationsFoldersIsOffered() {
    for p in ["/home/alex/Downloads/Talos.app", "/Volumes/Talos 0.1.7/Talos.app", "/home/alex/Desktop/Talos.app"] {
      #expect(AppLocation.shouldOfferMove(bundlePath: p, home: "/home/alex", isRelease: true), Comment(rawValue: p))
    }
  }

  @Test func onlyTheOwnersApplicationsFolderIsARightPlaceAndSystemApplicationsNeedsAMove() {
    for p in ["/home/alex/Applications/Talos.app", "/home/alex/Applications/Utilities/Talos.app"] {
      #expect(!AppLocation.shouldOfferMove(bundlePath: p, home: "/home/alex", isRelease: true), Comment(rawValue: p))
    }
    #expect(AppLocation.moveReason(bundlePath: "/Applications/Talos.app", home: "/home/alex", isRelease: true) == .systemApplications, "the updater refuses /Applications")
    #expect(AppLocation.moveReason(bundlePath: "/Applications/Utilities/Talos.app", home: "/home/alex", isRelease: true) == .systemApplications)
    #expect(AppLocation.moveReason(bundlePath: "/home/alex/Downloads/Talos.app", home: "/home/alex", isRelease: true) == .elsewhere)
    #expect(AppLocation.shouldOfferMove(bundlePath: "/home/alex/ApplicationsOld/Talos.app", home: "/home/alex", isRelease: true), "a folder that only starts with the same word")
    #expect(AppLocation.shouldOfferMove(bundlePath: "/home/node/Applications/Talos.app", home: "/home/alex", isRelease: true), "another person's Applications folder is not mine")
  }

  @Test func aDevelopmentRunAndANonBundleAreNeverAsked() {
    #expect(!AppLocation.shouldOfferMove(bundlePath: "/home/alex/code/.build/debug/Talos.app", home: "/home/alex", isRelease: false))
    #expect(!AppLocation.shouldOfferMove(bundlePath: "/home/alex/code/.build/debug/TalosDesktop", home: "/home/alex", isRelease: true))
  }
}
