import CoreGraphics
import Foundation

/// The companion's sprite atlases (DESKTOP-COMPANION-SPEC 9.1). Pure: the manifest `companion.json`, the grid maths, the Mini
/// map and where the files are looked for. The pictures themselves are loaded by the app target.
///
/// The manifest shape is frozen (spec 9.1) so C-ART and C-PANEL don't wait on each other:
/// `{"v":1,"cell":{"2x":[192,208],"1x":[96,104]},"anchor":[96,200],"clips":{"waving":{"atlas":"talos","row":3,"frames":[[0,140]],"loop":false,"still":0}}}`
public struct CompanionAtlas: Equatable, Sendable {
  /// The files an atlas name points at: `<name>-1x.png` and `<name>-2x.png`.
  public enum Sheet: String, CaseIterable, Sendable {
    case talos
    case talosExt = "talos-ext"
    /// The idle antics (sit, nap, stretch, scratch, stumble, tinker) and the sleep and wake transitions.
    case talosLife = "talos-life"
    /// The idle life: the base loops he plays whenever nothing else does (Idle's breathing, Needs you's rock), the look around, the
    /// beckon and the toe tap. Wider than the others (one clip per row, a cell per column).
    case talosLoops = "talos-loops"
    case ember
    case mini
    case miniEmber = "mini-ember"

    /// The grid of a manifest that has no `atlases` block (the frozen spec 9.1 shape, and the test fixtures: one ember pose).
    /// The real manifest states its grids in `atlases`, and `CompanionAtlas.grid(_:)` reads those first, so the art and the
    /// code can't disagree again (the ember is 11 cells wide, one per clip, and the mini ember is 4).
    public var columns: Int {
      switch self {
      case .talos, .talosExt, .talosLife: return 8
      case .talosLoops: return 20
      case .ember, .miniEmber: return 1
      case .mini: return 4
      }
    }
    public var rows: Int {
      switch self {
      case .talos: return 9
      case .talosExt: return 3
      case .talosLife: return 6
      case .talosLoops: return 5
      case .ember, .miniEmber, .mini: return 1
      }
    }
    public func fileName(scale: Int) -> String { "\(rawValue)-\(scale)x.png" }
  }

  /// Columns and rows of one sheet, as the manifest's `atlases` block states them.
  public struct Grid: Equatable, Sendable {
    public var columns: Int
    public var rows: Int
    public init(columns: Int, rows: Int) {
      self.columns = columns
      self.rows = rows
    }
  }

  /// Which cell of the ember sheet glows for a clip, and for which of the clip's columns that cell is right.
  public struct Ember: Equatable, Sendable {
    public var cell: Int
    public var cols: [Int]
  }

  public struct Frame: Equatable, Sendable {
    public var col: Int
    public var ms: Int
    public init(col: Int, ms: Int) {
      self.col = col
      self.ms = ms
    }
  }

  public struct Clip: Equatable, Sendable {
    public var sheet: Sheet
    public var row: Int
    public var frames: [Frame]
    public var loop: Bool
    /// The column shown for Reduce Motion and Low Power.
    public var still: Int
    /// nil: no glow for this clip (statue has none).
    public var ember: Ember?
    public var totalMs: Int { frames.reduce(0) { $0 + $1.ms } }
  }

  public enum DecodeError: Error, Equatable, Sendable {
    case notJSON, unsupportedVersion(Int), badCell, badAnchor
  }

  /// Cell size in points (the 1x size); the 2x file is twice that.
  public var cell: CGSize
  public var anchor: CGPoint
  public var clips: [String: Clip]
  /// Grids the manifest stated. A sheet it didn't state keeps `Sheet.columns` x `Sheet.rows`.
  public var grids: [Sheet: Grid] = [:]
  /// The Mini cell in points (the 1x size): the manifest's `atlases.mini.cell`, 44 x 44 when it says nothing.
  public var miniCell = CGSize(width: 44, height: 44)
  /// Clip names the manifest listed but that failed validation. One bad clip degrades one clip, never the whole file.
  public var rejected: [String]

  /// The names C-ART delivers: the nine Codex rows plus `talking`, `statue` and `landed`, and the idle antics with the `sleep` and
  /// `wake` transitions of the nap.
  public static let knownClips: [String] = [
    "idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review", "talking", "statue",
    "landed", "sit", "nap", "stretch", "scratch", "stumble", "tinker", "sleep", "wake", "wake-low", "idle-loop", "idle-look", "needs-loop",
    "needs-beckon", "needs-tap",
  ]

  /// The clip that plays on a rest for as long as nothing else does, when the art has it: Idle's breathing loop and Needs you's rock. nil
  /// for every other rest (and for art without the loops sheet): those hold their still.
  public static func restLoopName(_ rest: CompanionRest) -> String? {
    switch rest {
    case .idle: return "idle-loop"
    case .holdStill("waiting"): return "needs-loop"
    default: return nil
    }
  }

  public static let minLimitMs = 80
  public static let maxLimitMs = 4000

  public static func decode(_ data: Data) -> Result<CompanionAtlas, DecodeError> {
    guard let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return .failure(.notJSON) }
    guard let v = o["v"] as? Int else { return .failure(.notJSON) }
    guard v == 1 else { return .failure(.unsupportedVersion(v)) }
    guard let c = o["cell"] as? [String: Any], let one = c["1x"] as? [Any], one.count == 2,
      let w = (one[0] as? NSNumber)?.doubleValue, let h = (one[1] as? NSNumber)?.doubleValue, w > 0, h > 0, w <= 1024, h <= 1024
    else { return .failure(.badCell) }
    guard let a = o["anchor"] as? [Any], a.count == 2, let ax = (a[0] as? NSNumber)?.doubleValue,
      let ay = (a[1] as? NSNumber)?.doubleValue
    else { return .failure(.badAnchor) }

    var grids: [Sheet: Grid] = [:]
    var miniCell = CGSize(width: 44, height: 44)
    if let atlases = o["atlases"] as? [String: Any] {
      for (name, value) in atlases {
        // One bad entry degrades one sheet to its default, never the file. An unknown sheet is a newer manifest.
        guard let sheet = Sheet(rawValue: name), let d = value as? [String: Any] else { continue }
        if let g = d["grid"] as? [Any], g.count == 2, let c = g[0] as? Int, let r = g[1] as? Int, (1...64).contains(c), (1...64).contains(r) {
          grids[sheet] = Grid(columns: c, rows: r)
        }
        if sheet == .mini, let cell = d["cell"] as? [String: Any], let one = cell["1x"] as? [Any], one.count == 2,
          let w = (one[0] as? NSNumber)?.doubleValue, let h = (one[1] as? NSNumber)?.doubleValue, w > 0, h > 0, w <= 1024, h <= 1024
        {
          miniCell = CGSize(width: w, height: h)
        }
      }
    }
    var clips: [String: Clip] = [:]
    var rejected: [String] = []
    if let raw = o["clips"] as? [String: Any] {
      for (name, value) in raw.sorted(by: { $0.key < $1.key }) {
        // An unknown clip name is ignored quietly (a newer manifest); a known one that fails validation is reported.
        if let clip = parseClip(value, grids: grids) { clips[name] = clip } else if knownClips.contains(name) { rejected.append(name) }
      }
    }
    return .success(
      CompanionAtlas(
        cell: CGSize(width: w, height: h), anchor: CGPoint(x: ax, y: ay), clips: clips, grids: grids, miniCell: miniCell, rejected: rejected))
  }

  private static func parseClip(_ value: Any, grids: [Sheet: Grid]) -> Clip? {
    func grid(_ s: Sheet) -> Grid { grids[s] ?? Grid(columns: s.columns, rows: s.rows) }
    guard let d = value as? [String: Any], let atlas = d["atlas"] as? String, let sheet = Sheet(rawValue: atlas),
      let row = d["row"] as? Int, (0..<grid(sheet).rows).contains(row), let frames = d["frames"] as? [Any], !frames.isEmpty,
      frames.count <= 64
    else { return nil }
    var out: [Frame] = []
    for f in frames {
      guard let pair = f as? [Any], pair.count == 2, let col = pair[0] as? Int, let ms = pair[1] as? Int,
        (0..<grid(sheet).columns).contains(col), (minLimitMs...maxLimitMs).contains(ms)
      else { return nil }
      out.append(Frame(col: col, ms: ms))
    }
    let still = (d["still"] as? Int) ?? out[0].col
    guard (0..<grid(sheet).columns).contains(still) else { return nil }
    // A bad ember block costs the clip its glow, not the clip.
    var ember: Ember?
    if let e = d["ember"] as? [String: Any], let cell = e["cell"] as? Int, let cols = e["cols"] as? [Int], (0..<grid(.ember).columns).contains(cell),
      cols.allSatisfy({ (0..<grid(sheet).columns).contains($0) })
    {
      ember = Ember(cell: cell, cols: cols)
    }
    return Clip(sheet: sheet, row: row, frames: out, loop: (d["loop"] as? Bool) ?? false, still: still, ember: ember)
  }

  public func clip(_ name: String) -> Clip? { clips[name] }

  /// The idle antics this art has, each with its length in seconds: the model's pool. An art bundle without a clip never has it picked.
  public func antics(among names: some Sequence<String>) -> [String: TimeInterval] {
    var out: [String: TimeInterval] = [:]
    for n in names { if let c = clips[n] { out[n] = Double(c.totalMs) / 1000 } }
    return out
  }

  /// The grid of a sheet: what the manifest states, else the spec default.
  public func grid(_ s: Sheet) -> Grid { grids[s] ?? Grid(columns: s.columns, rows: s.rows) }

  /// `contentsRect` for a cell, in the unit space CALayer wants: the origin is the bottom left of the picture, and row 0 is the
  /// top row of the file. A column or row past the grid is clamped to its last, so a one-pose ember sheet serves every pose.
  public func contentsRect(sheet: Sheet, col: Int, row: Int) -> CGRect {
    let g = grid(sheet)
    let col = min(max(col, 0), g.columns - 1)
    let row = min(max(row, 0), g.rows - 1)
    let w = 1.0 / Double(g.columns)
    let h = 1.0 / Double(g.rows)
    return CGRect(x: Double(col) * w, y: 1.0 - Double(row + 1) * h, width: w, height: h)
  }

  /// The ember cell to lay over `clip` drawn at column `col`: nil when the clip has no glow (a manifest that states its ember grid), or the glow was drawn for another
  /// pose than the one on screen (a glow at the eyes of a different frame would sit in the wrong place).
  public func emberRect(for clip: Clip, col: Int) -> CGRect? {
    guard let e = clip.ember else {
      // A manifest that states no ember grid is the frozen spec 9.1 shape: one ember pose serves every clip. A manifest that
      // states a grid and gives this clip no cell (the statue) has no glow for it.
      return grids[.ember] == nil ? contentsRect(sheet: .ember, col: 0, row: 0) : nil
    }
    guard e.cols.contains(col) else { return nil }
    return contentsRect(sheet: .ember, col: e.cell, row: 0)
  }

  /// The Mini ember for a pose. The statue's cell is blank in the art, so the same call serves all four.
  public func miniEmberRect(pose: MiniPose) -> CGRect { contentsRect(sheet: .miniEmber, col: pose.rawValue, row: 0) }

  /// The pixel size a sheet's file must have at a backing scale. A truncated or swapped file fails this instead of drawing garbage.
  public func expectedPixelSize(_ s: Sheet, scale: Int) -> CGSize {
    let cell = (s == .mini || s == .miniEmber) ? miniCell : cell
    let g = grid(s)
    return CGSize(width: cell.width * CGFloat(g.columns * scale), height: cell.height * CGFloat(g.rows * scale))
  }

  /// The blink a clip carries: the frames after the last one on the open column. The real idle holds the eyes open over several
  /// frames and then lists its blink as `[half, closed, half]`; a three-pose clip (open, half, closed, as the fixtures have it)
  /// lists `[half, closed]` and blinks half, closed, half. Fewer than two frames after the open ones: no blink.
  public static func blinkFrames(_ clip: Clip) -> [Frame] {
    guard let open = clip.frames.first?.col, let lastOpen = clip.frames.lastIndex(where: { $0.col == open }) else { return [] }
    let tail = Array(clip.frames[(lastOpen + 1)...])
    switch tail.count {
    case 0, 1: return []
    case 2: return [tail[0], tail[1], tail[0]]
    default: return tail
    }
  }

  /// The gap between two blinks, in milliseconds.
  public static let blinkGapMs: ClosedRange<Double> = 3000...8000

  /// The idle bob: he rises and settles by these lifts in points, one step each, evenly spaced over a period (seconds). A stepped
  /// animation, never a smooth one: a smooth one keeps WindowServer drawing at full refresh (see the ember). The first lift is 0,
  /// his rest position.
  public static let breathLifts: [Double] = [0, 1]
  public static let breathPeriod: Double = 3.6

  /// A long repeating Idle: the clip's first frame held, blinking at random gaps of 3 to 8 s. Blinks are planned into one
  /// animation so no timer runs for them. A clip with no blink just holds.
  public static func idleLoop(_ clip: Clip, totalMs: Int = 60_000, random: (ClosedRange<Double>) -> Double) -> [Frame] {
    let open = clip.frames.first?.col ?? clip.still
    let blinkFrames = blinkFrames(clip)
    guard !blinkFrames.isEmpty else { return [Frame(col: open, ms: totalMs)] }
    var out: [Frame] = []
    var used = 0
    let blink = blinkFrames.reduce(0) { $0 + $1.ms }
    while true {
      let gap = Int(random(blinkGapMs))
      if used + gap + blink > totalMs {
        out.append(Frame(col: open, ms: max(totalMs - used, 1)))
        break
      }
      out.append(Frame(col: open, ms: gap))
      out.append(contentsOf: blinkFrames)
      used += gap + blink
    }
    return out
  }

  // MARK: Mini

  public enum MiniPose: Int, Equatable, Sendable { case pleased = 0, worried, waiting, statue }

  /// Down worried; Needs you waiting; Asleep statue; everything else pleased (spec 9.1). Quiet hours do not change it.
  public static func miniPose(_ s: CompanionState) -> MiniPose {
    switch s {
    case .down, .trouble: return .worried
    case .needsYou: return .waiting
    case .asleep: return .statue
    case .working, .idle, .done: return .pleased
    }
  }

  // MARK: where the files are

  /// The folder holding `companion.json`: the app bundle's `Resources/companion`, then `TALOS_COMPANION_DIR` (for `swift run`).
  /// nil means "no art", which the app shows as the app icon still.
  public static func locate(bundleResources: URL?, environment: [String: String], exists: (URL) -> Bool) -> URL? {
    var candidates: [URL] = []
    if let b = bundleResources { candidates.append(b.appendingPathComponent("companion", isDirectory: true)) }
    if let e = environment["TALOS_COMPANION_DIR"], !e.isEmpty { candidates.append(URL(fileURLWithPath: e, isDirectory: true)) }
    return candidates.first { exists($0.appendingPathComponent("companion.json")) }
  }
}
