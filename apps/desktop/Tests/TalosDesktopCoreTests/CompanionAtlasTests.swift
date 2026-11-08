import CoreGraphics
import Foundation
import Testing

@testable import TalosDesktopCore

let companionFixtureDir: String = {
  let here = URL(fileURLWithPath: #filePath)
  return here.appendingPathComponent("../../Fixtures/companion").standardized.path
}()

let companionResourcesDir: String = {
  let here = URL(fileURLWithPath: #filePath)
  return here.appendingPathComponent("../../../Resources/companion").standardized.path
}()

@Suite("Companion atlas")
struct CompanionAtlasTests {
  func load(_ dir: String = companionFixtureDir) throws -> CompanionAtlas {
    let data = try #require(FileManager.default.contents(atPath: dir + "/companion.json"))
    return try CompanionAtlas.decode(data).get()
  }

  @Test func decodesTheFixtureManifestWithEveryKnownClip() throws {
    let a = try load()
    #expect(a.cell == CGSize(width: 96, height: 104))
    #expect(a.anchor == CGPoint(x: 96, y: 200))
    // The fixture is the spec 9.1 art: the twelve original names. The antics sheet came later, and an older bundle simply lacks it.
    let original = CompanionAtlas.knownClips.filter { !["sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake", "wake-low", "idle-loop", "idle-look", "needs-loop", "needs-beckon", "needs-tap"].contains($0) }
    #expect(Set(a.clips.keys) == Set(original))
    #expect(a.rejected.isEmpty)
    #expect(a.clip("waving")?.frames.map(\.ms) == [140, 120, 120, 200])
    #expect(a.clip("failed")?.still == 2)
    #expect(a.clip("statue")?.sheet == .talosExt)
  }

  /// Runs in whichever of C-ART or C-PANEL merges last (spec section 10, class 1): when the real atlas is committed it must
  /// parse and carry every clip the reducer can ask for.
  @Test(.enabled(if: FileManager.default.fileExists(atPath: companionResourcesDir + "/companion.json")))
  func theCommittedAtlasParsesAndHasEveryClipTheReducerAsksFor() throws {
    let a = try load(companionResourcesDir)
    for name in ["idle", "waving", "waiting", "failed", "running", "jumping", "review", "talking", "statue", "landed", "running-left", "running-right"] {
      #expect(a.clip(name) != nil, "missing clip \(name)")
    }
    for s in CompanionAtlas.Sheet.allCases {
      for scale in [1, 2] {
        #expect(FileManager.default.fileExists(atPath: companionResourcesDir + "/" + s.fileName(scale: scale)), "\(s.fileName(scale: scale))")
      }
    }
  }

  @Test func oneBadClipDegradesOneClipNotTheFile() throws {
    let json = """
      {"v":1,"cell":{"2x":[192,208],"1x":[96,104]},"anchor":[96,200],"clips":{
       "waving":{"atlas":"talos","row":3,"frames":[[0,140]],"loop":false,"still":0},
       "failed":{"atlas":"talos","row":5,"frames":[[0,5]],"loop":false,"still":0},
       "idle":{"atlas":"nowhere","row":0,"frames":[[0,140]]},
       "jumping":{"atlas":"talos","row":4,"frames":[[9,140]]},
       "review":{"atlas":"talos","row":99,"frames":[[0,140]]},
       "talking":{"atlas":"talos-ext","row":0,"frames":[]},
       "future-clip":{"atlas":"talos","row":0,"frames":[[0,140]]}}}
      """
    let a = try CompanionAtlas.decode(Data(json.utf8)).get()
    #expect(a.clip("waving") != nil)
    #expect(Set(a.rejected) == ["failed", "idle", "jumping", "review", "talking"])
    #expect(a.clip("future-clip") != nil, "an unknown name from a newer manifest is kept and ignored by the reducer")
  }

  @Test func unknownValuesAndOldOrBrokenFilesAreRefusedWholeOnlyWhereTheyMustBe() {
    #expect(CompanionAtlas.decode(Data("nope".utf8)) == .failure(.notJSON))
    #expect(CompanionAtlas.decode(Data(#"{"v":2}"#.utf8)) == .failure(.unsupportedVersion(2)))
    #expect(CompanionAtlas.decode(Data(#"{"v":1,"cell":{},"anchor":[1,2]}"#.utf8)) == .failure(.badCell))
    #expect(CompanionAtlas.decode(Data(#"{"v":1,"cell":{"1x":[96,104]},"anchor":"x"}"#.utf8)) == .failure(.badAnchor))
    let noClips = try? CompanionAtlas.decode(Data(#"{"v":1,"cell":{"1x":[96,104]},"anchor":[1,2]}"#.utf8)).get()
    #expect(noClips?.clips.isEmpty == true)
  }

  @Test func frameTimesOutsideEightyToFourThousandMillisecondsAreRefused() {
    for ms in [79, 4001, 0, -1] {
      let json = #"{"v":1,"cell":{"1x":[96,104]},"anchor":[1,2],"clips":{"waving":{"atlas":"talos","row":3,"frames":[[0,\#(ms)]]}}}"#
      let a = try? CompanionAtlas.decode(Data(json.utf8)).get()
      #expect(a?.clip("waving") == nil, "\(ms)")
    }
    for ms in [80, 4000] {
      let json = #"{"v":1,"cell":{"1x":[96,104]},"anchor":[1,2],"clips":{"waving":{"atlas":"talos","row":3,"frames":[[0,\#(ms)]]}}}"#
      #expect((try? CompanionAtlas.decode(Data(json.utf8)).get())?.clip("waving") != nil)
    }
  }

  @Test func contentsRectIsInCoreAnimationUnitSpaceWithRowZeroOnTop() {
    let atlas = try! load()
    let r = atlas.contentsRect(sheet: .talos, col: 1, row: 0)
    #expect(r.origin.x == 1.0 / 8)
    #expect(abs(r.origin.y - 8.0 / 9) < 1e-9, "row 0 is the top of the file, which is y near 1 for a layer")
    #expect(abs(r.width - 1.0 / 8) < 1e-9 && abs(r.height - 1.0 / 9) < 1e-9)
    let last = atlas.contentsRect(sheet: .talos, col: 7, row: 8)
    #expect(last.origin.y == 0)
    #expect(atlas.contentsRect(sheet: .ember, col: 0, row: 0) == CGRect(x: 0, y: 0, width: 1, height: 1))
  }

  @Test func sheetsHaveTheSpecGeometryAndFileNames() {
    #expect(CompanionAtlas.Sheet.talos.columns == 8 && CompanionAtlas.Sheet.talos.rows == 9)
    #expect(CompanionAtlas.Sheet.talosExt.rows == 3)
    #expect(CompanionAtlas.Sheet.mini.columns == 4)
    #expect(CompanionAtlas.Sheet.talosExt.fileName(scale: 2) == "talos-ext-2x.png")
    #expect(CompanionAtlas.Sheet.miniEmber.fileName(scale: 1) == "mini-ember-1x.png")
  }

  @Test func theMiniMapFollowsTheSpec() {
    #expect(CompanionAtlas.miniPose(.down) == .worried)
    #expect(CompanionAtlas.miniPose(.needsYou) == .waiting)
    #expect(CompanionAtlas.miniPose(.asleep) == .statue)
    #expect(CompanionAtlas.miniPose(.working) == .pleased)
    #expect(CompanionAtlas.miniPose(.idle) == .pleased)
  }

  @Test func idleLoopPlansItsBlinksWithoutATimer() throws {
    let a = try load()
    let clip = try #require(a.clip("idle"))
    let loop = CompanionAtlas.idleLoop(clip, random: { $0.lowerBound })
    #expect(loop.reduce(0) { $0 + $1.ms } == 60_000)
    let blinks = loop.filter { $0.col == 2 }.count
    #expect(blinks >= 3 && blinks <= 22, "3 s gaps in 60 s: \(blinks)")
    let slow = CompanionAtlas.idleLoop(clip, random: { $0.upperBound })
    #expect(slow.filter { $0.col == 2 }.count >= 2)
    #expect(blinks > slow.filter { $0.col == 2 }.count, "the longer the gap, the fewer the blinks")
    for f in loop where f.col == 0 { #expect(f.ms >= 1) }
    let short = CompanionAtlas.Clip(sheet: .talos, row: 0, frames: [.init(col: 0, ms: 200)], loop: true, still: 0)
    #expect(CompanionAtlas.idleLoop(short, random: { $0.lowerBound }).count == 1)
  }

  @Test func blinksComeEveryThreeToEightSecondsAndTheOpenEyesNeverHoldLonger() throws {
    #expect(CompanionAtlas.blinkGapMs == 3000...8000)
    let clip = try #require(try load().clip("idle"))
    for pick in [{ (r: ClosedRange<Double>) in r.lowerBound }, { $0.upperBound }, { ($0.lowerBound + $0.upperBound) / 2 }] {
      let loop = CompanionAtlas.idleLoop(clip, random: pick)
      let open = loop.first!.col
      // Every stretch of open eyes but the last one that fills the minute is at most the longest gap.
      for f in loop.dropLast() where f.col == open { #expect(f.ms <= 8000, "an open-eyed stretch of \(f.ms) ms") }
    }
  }

  @Test func theIdleBobIsSteppedStartsAtRestAndLiftsHimByAPointOrTwo() {
    let lifts = CompanionAtlas.breathLifts
    #expect(lifts.first == 0, "the first step is the rest position")
    #expect(lifts.count >= 2 && lifts.max()! >= 1 && lifts.max()! <= 2, "a bob you can see but not a jump: \(lifts)")
    // Steps per second, from the numbers and not from a clock: a stepped animation redraws only when a step changes.
    #expect(Double(lifts.count) / CompanionAtlas.breathPeriod <= 2, "no more than two changes a second")
  }

  @Test func theArtIsFoundInTheBundleThenTheEnvironmentThenNowhere() {
    let bundle = URL(fileURLWithPath: "/App/Contents/Resources")
    let inBundle = CompanionAtlas.locate(bundleResources: bundle, environment: ["TALOS_COMPANION_DIR": "/dev/art"]) {
      $0.path == "/App/Contents/Resources/companion/companion.json"
    }
    #expect(inBundle?.path == "/App/Contents/Resources/companion")
    let env = CompanionAtlas.locate(bundleResources: bundle, environment: ["TALOS_COMPANION_DIR": "/dev/art"]) {
      $0.path == "/dev/art/companion.json"
    }
    #expect(env?.path == "/dev/art")
    #expect(CompanionAtlas.locate(bundleResources: bundle, environment: [:], exists: { _ in false }) == nil)
    #expect(CompanionAtlas.locate(bundleResources: nil, environment: ["TALOS_COMPANION_DIR": ""], exists: { _ in true }) == nil)
  }
}

@Suite("Companion phrases")
struct CompanionPhraseTests {
  static let hostile = [
    "Line\nbreak\r\nand\ttab", "\u{202E}evil\u{202C} name", "a\u{200F}b\u{200B}c", String(repeating: "x", count: 500),
    "**bold** [link](http://x) `code`", "   ", "", "tab\u{2028}sep\u{2029}x", "\u{0007}bell\u{0000}nul",
  ]

  @Test func aHostileLabelIsOneShortPlainLine() {
    for h in Self.hostile {
      let l = CompanionPhrase.label(h)
      #expect(l.count <= 40, "\(l.count)")
      #expect(!l.contains("\n") && !l.contains("\r"))
      #expect(!l.unicodeScalars.contains { [.control, .format, .lineSeparator, .paragraphSeparator].contains($0.properties.generalCategory) })
      #expect(!l.isEmpty)
    }
    #expect(CompanionPhrase.label("   ") == "Talos")
    #expect(CompanionPhrase.label("A\n\nB") == "A B")
  }

  @Test func everyBubbleAndEveryLabelBuiltFromAHostileNameIsAPlainLine() {
    for h in Self.hostile {
      for b in [CompanionBubble.sessionStopped(agent: h), .needsYou(agent: h), .overnight(items: 5)] {
        let t = b.text
        #expect(!t.contains("\n") && !t.contains("\r") && t.count <= 80)
      }
      let a = CompanionPhrase.accessibility(agent: h, word: "Working")
      #expect(!a.contains("\n") && a.count <= 60)
    }
  }

  @Test func sharedPhrasesPassThePushBuildersTemplates() {
    #expect(NotificationPolicy.isPushPhrase(CompanionBubble.sessionStopped(agent: "Talos").text))
    #expect(NotificationPolicy.isPushPhrase(CompanionBubble.overnight(items: 12).text))
    #expect(NotificationPolicy.isPushPhrase(CompanionBubble.sessionStopped(agent: "\u{202E}x\ny").text))
  }

  @Test func overnightIsBounded() {
    #expect(CompanionBubble.overnight(items: -3).text == "Overnight: 0 items")
    #expect(CompanionBubble.overnight(items: 10_000_000).text == "Overnight: 99999 items")
  }

  @Test func theWordLineCoversEveryIdleReading() {
    func w(_ s: CompanionSession, _ st: CompanionState = .idle) -> String { CompanionPhrase.word(st, session: s, relayDown: false, needs: 0) }
    #expect(w(.notConfigured) == "Not set up")
    #expect(w(.notStarted) == "Not started")
    #expect(w(.starting) == "Starting")
    #expect(w(.restarting) == "Restarting")
    #expect(w(.stopped(byOwner: true)) == "Session stopped by you")
    #expect(w(.running(busy: false)) == "Ready")
    #expect(w(.running(busy: true), .working) == "Working")
    #expect(w(.running(busy: false), .asleep) == "Dozing")
    #expect(CompanionPhrase.word(.needsYou, session: .running(busy: false), relayDown: false, needs: 1000) == "Needs you · 99")
  }

  @Test func accessibilityReadsTalosWorking() {
    #expect(CompanionPhrase.accessibility(agent: "Talos", word: "Working") == "Talos, working")
  }
}
