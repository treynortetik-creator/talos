import CoreGraphics
import Foundation
import ImageIO

/// The atlas pictures for one backing scale, loaded on enable and released on off (spec 3.2). The extension sheet loads on first
/// use. A missing or corrupt file is an error the controller turns into the app icon still and a line in Settings that names the
/// file and says why. It lives in Core so the real bundled art can be loaded by a plain unit test.
@MainActor
public final class LoadedAtlas {
  public enum LoadError: Error, Equatable, Sendable, CustomStringConvertible {
    /// companion.json is absent, unreadable or not a manifest this build understands.
    case manifest(file: String, why: String)
    case missing(file: String)
    case corrupt(file: String, why: String)

    public var file: String {
      switch self {
      case .manifest(let f, _), .missing(let f), .corrupt(let f, _): return f
      }
    }

    /// One line for Settings and the log: which file, and what is wrong with it.
    public var description: String {
      switch self {
      case .manifest(let f, let why): return "\(f): \(why)"
      case .missing(let f): return "\(f) is missing"
      case .corrupt(let f, let why): return "\(f): \(why)"
      }
    }
  }

  public let manifest: CompanionAtlas
  public let directory: URL
  public let scale: Int
  private var images: [CompanionAtlas.Sheet: CGImage] = [:]
  /// A sheet that failed stays failed until the next enable, so a recompute doesn't hit the disk again for it.
  private var failures: [CompanionAtlas.Sheet: LoadError] = [:]

  public var loadedSheetCount: Int { images.count }

  public static func load(directory: URL, scale: Int, mini: Bool) -> Result<LoadedAtlas, LoadError> {
    let name = "companion.json"
    guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else {
      return .failure(.manifest(file: name, why: "can't be read in \(directory.lastPathComponent)"))
    }
    let manifest: CompanionAtlas
    switch CompanionAtlas.decode(data) {
    case .success(let m): manifest = m
    case .failure(let e): return .failure(.manifest(file: name, why: "isn't a usable manifest (\(e))"))
    }
    let a = LoadedAtlas(manifest: manifest, directory: directory, scale: scale)
    let first: [CompanionAtlas.Sheet] = mini ? [.mini, .miniEmber] : [.talos, .ember]
    for s in first { if case .failure(let e) = a.load(s) { return .failure(e) } }
    // The extension sheet (talking, statue, landed) is used on first need, which for the statue is 30 minutes in. A bad one
    // must be found now and named, not at that moment as an app icon with no explanation. Decoded to prove it, then dropped.
    if !mini {
      if case .failure(let e) = a.load(.talosExt) { return .failure(e) }
      a.images[.talosExt] = nil
      // The antics sheet the same way: a manifest that lists clips on it must have the file, found now and named.
      if manifest.clips.values.contains(where: { $0.sheet == .talosLife }) {
        if case .failure(let e) = a.load(.talosLife) { return .failure(e) }
        a.images[.talosLife] = nil
      }
      // The idle loops play all day, so this sheet is loaded now (a bad or missing file is named at once) and kept.
      if manifest.clips.values.contains(where: { $0.sheet == .talosLoops }) {
        if case .failure(let e) = a.load(.talosLoops) { return .failure(e) }
      }
    }
    return .success(a)
  }

  private init(manifest: CompanionAtlas, directory: URL, scale: Int) {
    self.manifest = manifest
    self.directory = directory
    self.scale = scale
  }

  /// The expected pixel size of a sheet, so a truncated or wrong file is "corrupt" and not a garbled sprite.
  public func expectedSize(_ s: CompanionAtlas.Sheet) -> CGSize { manifest.expectedPixelSize(s, scale: scale) }

  @discardableResult public func load(_ s: CompanionAtlas.Sheet) -> Result<CGImage, LoadError> {
    if let i = images[s] { return .success(i) }
    if let f = failures[s] { return .failure(f) }
    let r = read(s)
    switch r {
    case .success(let i): images[s] = i
    case .failure(let e): failures[s] = e
    }
    return r
  }

  /// The last twelve bytes of every whole PNG: a zero-length IEND chunk and its CRC.
  private static let pngEnd: [UInt8] = [0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]

  private func read(_ s: CompanionAtlas.Sheet) -> Result<CGImage, LoadError> {
    let file = s.fileName(scale: scale)
    let url = directory.appendingPathComponent(file)
    guard FileManager.default.fileExists(atPath: url.path) else { return .failure(.missing(file: file)) }
    // ImageIO decodes lazily, reads only the header for the size, and reports a cut-short file as complete (probed: a PNG cut to
    // 4096 bytes still comes back at full size). A PNG ends with an IEND chunk; one that doesn't was cut short.
    guard let bytes = try? Data(contentsOf: url, options: .mappedIfSafe) else {
      return .failure(.corrupt(file: file, why: "can't be read"))
    }
    guard bytes.suffix(Self.pngEnd.count) == Data(Self.pngEnd) else {
      return .failure(.corrupt(file: file, why: "is cut short or damaged"))
    }
    guard let src = CGImageSourceCreateWithData(bytes as CFData, nil), CGImageSourceGetCount(src) > 0,
      let img = CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    else { return .failure(.corrupt(file: file, why: "isn't a readable picture")) }
    let want = expectedSize(s)
    guard CGFloat(img.width) == want.width, CGFloat(img.height) == want.height else {
      return .failure(
        .corrupt(file: file, why: "is \(img.width) x \(img.height) px, expected \(Int(want.width)) x \(Int(want.height))"))
    }
    return .success(img)
  }

  /// A sheet already loaded or loaded now; nil if it can't be.
  public func image(_ s: CompanionAtlas.Sheet) -> CGImage? {
    if case .success(let i) = load(s) { return i }
    return nil
  }

  /// What went wrong with a sheet that was asked for and failed, so the view can say so.
  public var firstFailure: LoadError? { CompanionAtlas.Sheet.allCases.compactMap { failures[$0] }.first }

  public func release() { images.removeAll() }
}

/// The Settings line about art for the display he is NOT on (a drag to a display with the other backing scale). It is set when that
/// reload fails, kept so the disk isn't asked again at every recompute, and cleared the moment the art on screen is right for the
/// display he is on, so Settings never says "can't be loaded" over a character that is drawn correctly.
public struct ArtReloadStatus: Equatable, Sendable {
  public private(set) var line: String?
  public private(set) var failedScale: Int?
  public init() {}

  /// Whether to try loading the art for `want`: not when that scale already failed and nothing has changed.
  public func shouldTry(want: Int) -> Bool { failedScale != want }

  public mutating func failed(scale: Int, line: String) {
    self.line = line
    failedScale = scale
  }

  /// The art on screen is right (same scale as the display, or a reload worked). Returns the line to take off Settings, if any.
  @discardableResult public mutating func cleared() -> String? {
    defer {
      line = nil
      failedScale = nil
    }
    return line
  }
}
