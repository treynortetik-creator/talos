import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import TalosDesktopCore

/// The real bundled art (Resources/companion), not the fixtures. The first failure here was a manifest that said the ember
/// sheet was one cell wide while the file was eleven: every load came back "corrupt" and the owner saw the app icon on an
/// orange square. Nothing here skips: if the files are missing, these fail.
@MainActor
@Suite("Companion real art")
struct CompanionRealArtTests {
  static let dir = URL(fileURLWithPath: companionResourcesDir, isDirectory: true)

  @Test(arguments: [1, 2], [false, true])
  func theRealArtLoadsThroughLoadedAtlas(scale: Int, mini: Bool) {
    switch LoadedAtlas.load(directory: Self.dir, scale: scale, mini: mini) {
    case .success(let a):
      let sheets: [CompanionAtlas.Sheet] = mini ? [.mini, .miniEmber] : [.talos, .ember, .talosExt, .talosLife, .talosLoops]
      for s in sheets { #expect(a.image(s) != nil, "\(s.fileName(scale: scale)) did not load") }
    case .failure(let e):
      Issue.record("real art failed at \(scale)x mini \(mini): \(e)")
    }
  }

  @Test func everySheetFileIsExactlyTheSizeTheManifestSays() throws {
    let data = try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"), "companion.json is missing")
    let a = try CompanionAtlas.decode(data).get()
    #expect(a.grids[.ember] == .init(columns: 11, rows: 1), "the real manifest states the ember grid")
    #expect(a.grids[.miniEmber] == .init(columns: 4, rows: 1))
    for s in CompanionAtlas.Sheet.allCases {
      for scale in [1, 2] {
        let url = Self.dir.appendingPathComponent(s.fileName(scale: scale))
        let src = try #require(CGImageSourceCreateWithURL(url as CFURL, nil), "\(url.lastPathComponent) is missing or unreadable")
        let img = try #require(CGImageSourceCreateImageAtIndex(src, 0, nil))
        let want = a.expectedPixelSize(s, scale: scale)
        #expect(CGSize(width: img.width, height: img.height) == want, "\(url.lastPathComponent)")
      }
    }
  }

  @Test func everyKnownClipIsAcceptedAndEveryGlowingClipNamesACellInsideTheEmberSheet() throws {
    let data = try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"))
    let a = try CompanionAtlas.decode(data).get()
    #expect(a.rejected.isEmpty, "rejected clips: \(a.rejected)")
    for name in CompanionAtlas.knownClips {
      let clip = try #require(a.clip(name), "\(name)")
      if name == "statue" {
        #expect(clip.ember == nil, "the statue has no glow")
        continue
      }
      if clip.sheet == .talosLife || clip.sheet == .talosLoops {
        // The antics carry their own glow in the body (it breathes with the pose), so no ember layer sits over them.
        #expect(clip.ember == nil && a.emberRect(for: clip, col: clip.still) == nil, "\(name): no ember layer over an antic")
        continue
      }
      let e = try #require(clip.ember, "\(name) has no ember block: it would draw with no glow")
      #expect((0..<11).contains(e.cell) && e.cols.contains(clip.still), "\(name): the glow is cut for the still frame")
      // The glow is the cell the manifest names, not the whole 11-cell strip squeezed onto the figure.
      let r = try #require(a.emberRect(for: clip, col: clip.still))
      #expect(abs(r.width - 1.0 / 11) < 1e-9 && abs(r.origin.x - Double(e.cell) / 11) < 1e-9, "\(name)")
    }
    // Distinct clips glow in distinct cells (the sheet has one per clip).
    let cells = a.clips.values.compactMap { $0.ember?.cell }
    #expect(Set(cells).count == cells.count)
  }

  @Test func theMiniEmberIsOneOfFourCellsPerPose() throws {
    let data = try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"))
    let a = try CompanionAtlas.decode(data).get()
    for pose in [CompanionAtlas.MiniPose.pleased, .worried, .waiting, .statue] {
      let r = a.miniEmberRect(pose: pose)
      #expect(abs(r.width - 0.25) < 1e-9 && abs(r.origin.x - 0.25 * Double(pose.rawValue)) < 1e-9, "\(pose)")
      #expect(a.contentsRect(sheet: .mini, col: pose.rawValue, row: 0) == r, "the pose and its glow are the same cell")
    }
  }

  @Test func aLegacyManifestWithNoAtlasesBlockStillUsesTheSpecGrids() throws {
    let data = try #require(FileManager.default.contents(atPath: companionFixtureDir + "/companion.json"))
    let a = try CompanionAtlas.decode(data).get()
    #expect(a.grid(.ember) == .init(columns: 1, rows: 1) && a.grid(.talos) == .init(columns: 8, rows: 9))
    #expect(a.contentsRect(sheet: .ember, col: 5, row: 0) == CGRect(x: 0, y: 0, width: 1, height: 1), "one-pose glow serves every cell")
  }

  @Test func aManifestGridDecidesTheExpectedSizeAndAWrongFileNamesItselfAndWhy() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-grid-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    // Swap the ember sheet for the one-pose fixture: right manifest, wrong file.
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("ember-2x.png"))
    try FileManager.default.copyItem(
      atPath: companionFixtureDir + "/ember-2x.png", toPath: tmp.appendingPathComponent("ember-2x.png").path)
    switch LoadedAtlas.load(directory: tmp, scale: 2, mini: false) {
    case .success: Issue.record("a one-pose ember file must not load against an 11-cell grid")
    case .failure(let e):
      #expect(e == .corrupt(file: "ember-2x.png", why: "is 192 x 208 px, expected 2112 x 208"), "\(e)")
      #expect("\(e)" == "ember-2x.png: is 192 x 208 px, expected 2112 x 208", "this is the line Settings shows")
    }
  }

  @Test func aMissingFileOrManifestIsNamedNotJustMissing() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-gone-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-1x.png"))
    #expect(LoadedAtlas.load(directory: tmp, scale: 1, mini: false).failureValue == .missing(file: "talos-1x.png"))
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("companion.json"))
    #expect(LoadedAtlas.load(directory: tmp, scale: 1, mini: false).failureValue?.file == "companion.json")
  }

  private func copyOfTheArt() throws -> URL {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-art-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    return tmp
  }

  @Test func theExtensionSheetIsCheckedAtEnableSoTheStatueNeverFailsSilently() throws {
    let tmp = try copyOfTheArt()
    defer { try? FileManager.default.removeItem(at: tmp) }
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-ext-2x.png"))
    #expect(LoadedAtlas.load(directory: tmp, scale: 2, mini: false).failureValue == .missing(file: "talos-ext-2x.png"))
    // The Mini never draws from it.
    #expect(LoadedAtlas.load(directory: tmp, scale: 2, mini: true).failureValue == nil)
    // And a good one is not kept in memory until it is needed.
    #expect(LoadedAtlas.load(directory: Self.dir, scale: 2, mini: false).failureValue == nil)
  }

  @Test(arguments: ["talos-2x.png", "talos-ext-1x.png", "ember-2x.png", "talos-life-2x.png", "talos-life-1x.png"])
  func aSheetCutShortIsCorruptAndNamed(file: String) throws {
    let tmp = try copyOfTheArt()
    defer { try? FileManager.default.removeItem(at: tmp) }
    let url = tmp.appendingPathComponent(file)
    let whole = try Data(contentsOf: url)
    try whole.prefix(4096).write(to: url)
    let scale = file.contains("1x") ? 1 : 2
    let e = try #require(LoadedAtlas.load(directory: tmp, scale: scale, mini: false).failureValue, "\(file) cut to 4096 bytes loaded")
    #expect(e.file == file, "\(e)")
  }

  @Test func aSheetThatFailedStaysFailedWithoutAskingTheDiskAgain() throws {
    let tmp = try copyOfTheArt()
    defer { try? FileManager.default.removeItem(at: tmp) }
    let a = try LoadedAtlas.load(directory: tmp, scale: 2, mini: false).get()
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-ext-2x.png"))
    #expect(a.image(.talosExt) == nil)
    // Put it back: the same atlas still says failed, until the next enable builds a new one.
    try FileManager.default.copyItem(at: Self.dir.appendingPathComponent("talos-ext-2x.png"), to: tmp.appendingPathComponent("talos-ext-2x.png"))
    #expect(a.image(.talosExt) == nil)
    #expect(a.firstFailure == .missing(file: "talos-ext-2x.png"))
  }

  /// The first real idle clip is `[[0,4000],[0,4000],[0,3600],[1,90],[2,140],[1,90]]`: the eyes held open over three frames and
  /// then the blink. Reading frames 1 and 2 as half and closed never closed his eyes.
  @Test func theRealIdleClipBlinksAndTheGlowIsOffForExactlyTheBlinkFrames() throws {
    let a = try CompanionAtlas.decode(try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"))).get()
    let clip = try #require(a.clip("idle"))
    let loop = CompanionAtlas.idleLoop(clip, random: { $0.lowerBound })
    #expect(Set(loop.map(\.col)) == [0, 1, 2], "columns seen: \(Set(loop.map(\.col)))")
    #expect(loop.reduce(0) { $0 + $1.ms } == 60_000)
    let blinks = loop.filter { $0.col == 2 }.count
    #expect(blinks >= 3 && blinks <= 22, "3 s gaps in 60 s: \(blinks)")
    // Every blink is half, closed, half.
    for i in loop.indices where loop[i].col == 2 {
      #expect(loop[i - 1].col == 1 && loop[i + 1].col == 1)
    }
    let e = try #require(clip.ember)
    #expect(e.cols == [0])
    let hidden = loop.map { !e.cols.contains($0.col) }
    #expect(zip(loop, hidden).allSatisfy { ($0.col != 0) == $1 })
    #expect(CompanionAtlas.blinkFrames(clip).map(\.col) == [1, 2, 1])
  }

  @Test func aThreePoseIdleStillBlinksHalfClosedHalf() throws {
    let a = try CompanionAtlas.decode(try #require(FileManager.default.contents(atPath: companionFixtureDir + "/companion.json"))).get()
    let clip = try #require(a.clip("idle"))
    #expect(CompanionAtlas.blinkFrames(clip).map(\.col) == [1, 2, 1])
  }

  @Test func aManifestWithNoEmberGridServesItsOnePoseToEveryClipButARealOneDoesNotGlowTheStatue() throws {
    let legacy = try CompanionAtlas.decode(try #require(FileManager.default.contents(atPath: companionFixtureDir + "/companion.json"))).get()
    let idle = try #require(legacy.clip("idle"))
    #expect(legacy.emberRect(for: idle, col: 0) == CGRect(x: 0, y: 0, width: 1, height: 1), "fixture art has a glow at rest")
    let real = try CompanionAtlas.decode(try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"))).get()
    #expect(real.emberRect(for: try #require(real.clip("statue")), col: 0) == nil)
  }

  @Test func theOtherDisplaysArtLineIsClearedWhenTheArtOnScreenIsRightAgainAndNotRetriedMeanwhile() {
    var st = ArtReloadStatus()
    #expect(st.shouldTry(want: 1) && st.cleared() == nil)
    st.failed(scale: 1, line: "Character art for the 1x display can't be loaded: talos-1x.png is missing")
    #expect(!st.shouldTry(want: 1), "same scale, nothing changed: the disk is not asked again")
    #expect(st.shouldTry(want: 2))
    // Back on the display the loaded art is for: the line goes.
    #expect(st.cleared() == "Character art for the 1x display can't be loaded: talos-1x.png is missing")
    #expect(st.line == nil && st.shouldTry(want: 1), "after a clear he may try the other display again")
  }

  /// Runs from scripts/ci.sh against the packed app (`TALOS_BUILT_APP=<path to Talos.app>`): the art inside the bundle loads.
  @Test(.enabled(if: ProcessInfo.processInfo.environment["TALOS_BUILT_APP"] != nil))
  func BuiltAppArtLoads() throws {
    let app = try #require(ProcessInfo.processInfo.environment["TALOS_BUILT_APP"])
    let dir = URL(fileURLWithPath: app).appendingPathComponent("Contents/Resources/companion", isDirectory: true)
    for scale in [1, 2] {
      for mini in [false, true] {
        let r = LoadedAtlas.load(directory: dir, scale: scale, mini: mini)  // the standard load decodes talos-ext too
        #expect(r.failureValue == nil, "packed app art at \(scale)x mini \(mini): \(String(describing: r.failureValue))")
      }
    }
  }

  // MARK: the idle antics

  func manifest() throws -> CompanionAtlas {
    try CompanionAtlas.decode(try #require(FileManager.default.contents(atPath: Self.dir.path + "/companion.json"))).get()
  }

  @Test func theAnticsTableTheModelShipsWithIsTheManifestsOwn() throws {
    let a = try manifest()
    #expect(a.grid(.talosLife) == .init(columns: 8, rows: 6), "the manifest grid drives the loader")
    for (name, seconds) in CompanionModel.shippedAntics {
      let clip = try #require(a.clip(name), "\(name) is in the manifest")
      #expect(abs(Double(clip.totalMs) / 1000 - seconds) < 0.01, "\(name): the model thinks \(seconds) s, the art plays \(Double(clip.totalMs) / 1000) s")
      #expect(!clip.loop && clip.frames.count >= 2)
    }
    let pool = a.antics(among: CompanionModel.shippedAntics.keys)
    #expect(Set(pool.keys) == Set(CompanionModel.shippedAntics.keys), "every shipped antic is in this art's pool")
  }

  @Test func theIdlePoolTheModelShipsWithIsTheManifestsOwnAndHasNoNapOrStumble() throws {
    let a = try manifest()
    for (name, seconds) in CompanionModel.idleAntics {
      let clip = try #require(a.clip(name), "\(name) is in the manifest")
      #expect(abs(Double(clip.totalMs) / 1000 - seconds) < 0.01, "\(name): the model thinks \(seconds) s, the art plays \(Double(clip.totalMs) / 1000) s")
      #expect(!clip.loop && clip.frames.count >= 2)
    }
    #expect(a.antics(among: CompanionModel.idleAntics.keys) == CompanionModel.idleAntics)
    #expect(CompanionModel.idleAntics["nap"] == nil && CompanionModel.idleAntics["stumble"] == nil)
  }

  @Test func everyAnticAndTheNapsTwoTransitionsAreWholeAndStayOnTheirOwnSheet() throws {
    let a = try manifest()
    for name in ["sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake", "wake-low"] {
      let clip = try #require(a.clip(name), "\(name)")
      #expect(clip.sheet == .talosLife, "\(name)")
      #expect(a.rejected.contains(name) == false)
      #expect(clip.frames.allSatisfy { (80...4000).contains($0.ms) }, "\(name)")
    }
    // The nap and its transitions share one row; the Asleep rest is the nap's still, the lying frame.
    let nap = try #require(a.clip("nap")), sleep = try #require(a.clip("sleep")), wake = try #require(a.clip("wake"))
    #expect(nap.row == sleep.row && nap.row == wake.row)
    #expect(sleep.frames.last?.col == nap.still, "going to sleep ends on the frame the long rest shows")
    #expect(wake.frames.first?.col == nap.still && wake.frames.last?.col == 0, "waking starts lying and ends standing")
  }

  @Test func theNapsEdgesAndTheLowWakeMatchTheModelsNumbers() throws {
    let a = try manifest()
    let nap = try #require(a.clip("nap")), low = try #require(a.clip("wake-low")), sleep = try #require(a.clip("sleep"))
    // The first five cells go down (0..4), the last five come up (4..0): the model cuts a wake by where in them he is.
    let down = Double(nap.frames.prefix(5).reduce(0) { $0 + $1.ms }) / 1000
    let up = Double(nap.frames.suffix(5).reduce(0) { $0 + $1.ms }) / 1000
    #expect(abs(down - CompanionModel.napEdge) < 0.01 && abs(up - CompanionModel.napEdge) < 0.01, "down \(down) s, up \(up) s")
    #expect(nap.frames.prefix(5).map(\.col) == [0, 1, 2, 3, 4] && nap.frames.suffix(5).map(\.col) == [4, 3, 2, 1, 0])
    #expect(sleep.frames.prefix(5).map(\.col) == [0, 1, 2, 3, 4], "the sleep clip lies down in the same cells, so the same edge")
    #expect(low.row == nap.row && low.frames.last?.col == 0, "the low wake gets up from a seat to the idle stance")
    #expect(low.frames.first?.col == 2, "it starts on the seated cell, the one a cut in the first second shows")
  }

  @Test func theLifeSheetIsReasonablySmall() throws {
    for scale in [1, 2] {
      let url = Self.dir.appendingPathComponent(CompanionAtlas.Sheet.talosLife.fileName(scale: scale))
      let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
      #expect(size > 50_000 && size < 700_000, "\(url.lastPathComponent) is \(size) bytes")
    }
  }

  @Test(arguments: [1, 2])
  func everyFrameOfEveryNewClipIsADrawnCell(scale: Int) throws {
    guard case .success(let loaded) = LoadedAtlas.load(directory: Self.dir, scale: scale, mini: false) else {
      Issue.record("art failed to load")
      return
    }
    let img = try #require(loaded.image(.talosLife))
    let a = loaded.manifest
    let cw = img.width / 8, ch = img.height / 6
    for name in ["sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake"] {
      let clip = try #require(a.clip(name))
      for f in clip.frames {
        let rect = CGRect(x: f.col * cw, y: clip.row * ch, width: cw, height: ch)
        let cell = try #require(img.cropping(to: rect))
        #expect(opaquePixels(cell) > cw * ch / 30, "\(name) col \(f.col) at \(scale)x is blank or nearly")
      }
    }
  }

  func opaquePixels(_ img: CGImage) -> Int {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    var n = 0
    for i in stride(from: 3, to: px.count, by: 4) where px[i] > 200 { n += 1 }
    return n
  }

  @Test func anArtBundleWithoutTheLifeSheetStillLoadsAndJustHasNoAntics() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-old-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    var m = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: tmp.appendingPathComponent("companion.json"))) as? [String: Any])
    var clips = m["clips"] as! [String: Any]
    var atlases = m["atlases"] as! [String: Any]
    for n in ["sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake", "wake-low"] { clips[n] = nil }
    atlases["talos-life"] = nil
    m["clips"] = clips
    m["atlases"] = atlases
    try JSONSerialization.data(withJSONObject: m).write(to: tmp.appendingPathComponent("companion.json"))
    for f in ["talos-life-1x.png", "talos-life-2x.png"] { try FileManager.default.removeItem(at: tmp.appendingPathComponent(f)) }
    guard case .success(let a) = LoadedAtlas.load(directory: tmp, scale: 2, mini: false) else {
      Issue.record("an older bundle must still load")
      return
    }
    // Only review and waving are left of the idle pool: a bundle without the sheet never has the rest picked.
    #expect(Set(a.manifest.antics(among: CompanionModel.idleAntics.keys).keys) == ["review", "waving", "idle-look"], "the look around is on the loops sheet, which this bundle still has")
    #expect(a.manifest.clip("nap") == nil)
  }

  // MARK: the idle life loops (the `talos-loops` sheet)

  static let loopClips = ["idle-loop", "idle-look", "needs-loop", "needs-beckon", "needs-tap"]

  @Test func theLoopsSheetIsListedWithItsGridAndEveryLoopIsOnItWithoutAGlowLayer() throws {
    let a = try manifest()
    #expect(a.grid(.talosLoops) == .init(columns: 20, rows: 5), "the manifest grid drives the loader")
    for name in Self.loopClips {
      let clip = try #require(a.clip(name))
      #expect(clip.sheet == .talosLoops && clip.ember == nil, "\(name): the glow is in the body")
      #expect(clip.frames.count >= 8 && clip.frames.count <= 20, "\(name): \(clip.frames.count) cells")
      #expect(clip.frames.allSatisfy { (80...420).contains($0.ms) }, "\(name): no cell is held past a third of a second, none under 80 ms")
      #expect(clip.frames.map { $0.col } == Array(0..<clip.frames.count), "\(name): every cell plays once, in order")
    }
    #expect(CompanionAtlas.restLoopName(.idle) == "idle-loop" && CompanionAtlas.restLoopName(.holdStill("waiting")) == "needs-loop")
    #expect(CompanionAtlas.restLoopName(.statue) == nil && CompanionAtlas.restLoopName(.nap) == nil && CompanionAtlas.restLoopName(.holdLast("running")) == nil)
  }

  @Test func theBaseLoopsAreFourSecondsTheRotatingClipsMatchTheModelsLengths() throws {
    let a = try manifest()
    for name in ["idle-loop", "needs-loop"] {
      let c = try #require(a.clip(name))
      #expect(c.loop && abs(Double(c.totalMs) / 1000 - 4.0) < 0.02, "\(name) loops and takes \(Double(c.totalMs) / 1000) s")
    }
    for (name, seconds) in CompanionModel.idleAntics.merging(CompanionModel.needsAntics, uniquingKeysWith: { a, _ in a }) where a.clip(name)?.sheet == .talosLoops {
      let c = try #require(a.clip(name))
      #expect(!c.loop && abs(Double(c.totalMs) / 1000 - seconds) < 0.02, "\(name): the model thinks \(seconds) s, the art plays \(Double(c.totalMs) / 1000) s")
    }
  }

  @Test func theLoopsSheetIsReasonablySmall() throws {
    var total = 0
    for scale in [1, 2] {
      let url = Self.dir.appendingPathComponent(CompanionAtlas.Sheet.talosLoops.fileName(scale: scale))
      let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
      #expect(size > 100_000, "\(url.lastPathComponent) is \(size) bytes")
      total += size
    }
    #expect(total < 1_900_000, "the two loop sheets are \(total) bytes")
  }

  @Test(arguments: [1, 2])
  func everyCellOfEveryLoopIsDrawnAndTheBodyChangesFromCellToCell(scale: Int) throws {
    guard case .success(let loaded) = LoadedAtlas.load(directory: Self.dir, scale: scale, mini: false) else {
      Issue.record("art failed to load")
      return
    }
    let img = try #require(loaded.image(.talosLoops))
    let g = loaded.manifest.grid(.talosLoops)
    let cw = img.width / g.columns, ch = img.height / g.rows
    for name in Self.loopClips {
      let clip = try #require(loaded.manifest.clip(name))
      var previous: [UInt8]?
      var changed = 0
      for f in clip.frames {
        let cell = try #require(img.cropping(to: CGRect(x: f.col * cw, y: clip.row * ch, width: cw, height: ch)))
        #expect(opaquePixels(cell) > cw * ch / 30, "\(name) col \(f.col) at \(scale)x is blank or nearly")
        let px = pixels(cell)
        if let p = previous, p != px { changed += 1 }
        previous = px
      }
      #expect(changed == clip.frames.count - 1, "\(name): every cell must differ from the one before it, or it is a held frame wasting bytes")
    }
  }

  func pixels(_ img: CGImage) -> [UInt8] {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ctx = CGContext(data: &px, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return px
  }

  @Test func anArtBundleWithoutTheLoopsSheetStillLoadsAndKeepsItsStillIdle() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-noloops-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    var m = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: tmp.appendingPathComponent("companion.json"))) as? [String: Any])
    var clips = m["clips"] as! [String: Any]
    var atlases = m["atlases"] as! [String: Any]
    for n in Self.loopClips { clips[n] = nil }
    atlases["talos-loops"] = nil
    m["clips"] = clips
    m["atlases"] = atlases
    try JSONSerialization.data(withJSONObject: m).write(to: tmp.appendingPathComponent("companion.json"))
    for f in ["talos-loops-1x.png", "talos-loops-2x.png"] { try FileManager.default.removeItem(at: tmp.appendingPathComponent(f)) }
    guard case .success(let a) = LoadedAtlas.load(directory: tmp, scale: 2, mini: false) else {
      Issue.record("an older bundle must still load")
      return
    }
    for n in Self.loopClips { #expect(a.manifest.clip(n) == nil, "\(n)") }
    #expect(a.manifest.clip("idle") != nil && a.manifest.clip("waiting") != nil, "the stills the rests fall back to")
    #expect(a.manifest.antics(among: CompanionModel.needsAntics.keys).isEmpty)
  }

  @Test func aManifestThatListsTheLoopsButLacksTheirFileIsNamedAtEnable() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-noloopfile-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-loops-2x.png"))
    switch LoadedAtlas.load(directory: tmp, scale: 2, mini: false) {
    case .success: Issue.record("a missing sheet must fail at enable, not an hour in")
    case .failure(let e): #expect(e == .missing(file: "talos-loops-2x.png"))
    }
  }

  @Test func aManifestThatListsTheLifeClipsButLacksItsFileIsNamedAtEnable() throws {
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory() + "companion-nolife-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.copyItem(at: Self.dir, to: tmp)
    defer { try? FileManager.default.removeItem(at: tmp) }
    try FileManager.default.removeItem(at: tmp.appendingPathComponent("talos-life-2x.png"))
    switch LoadedAtlas.load(directory: tmp, scale: 2, mini: false) {
    case .success: Issue.record("a missing sheet must fail at enable, not 12 minutes in")
    case .failure(let e): #expect(e == .missing(file: "talos-life-2x.png"))
    }
  }
}

extension Result {
  fileprivate var failureValue: Failure? {
    if case .failure(let e) = self { return e }
    return nil
  }

}
