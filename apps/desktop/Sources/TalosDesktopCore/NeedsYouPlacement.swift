import CoreGraphics

/// Where the Mac's Needs-you popups stand. Main's popup (the development-channels warning) is centred on the screen; a thread's popups stack
/// down the top right.
public enum NeedsYouPlacement {
  /// The lower-left corner of each panel, in the order given. `area` is the screen's visible frame.
  public static func origins(panels: [(isMain: Bool, size: CGSize)], area: CGRect) -> [CGPoint] {
    var top = area.maxY - 16
    return panels.map { p in
      if p.isMain { return CGPoint(x: area.midX - p.size.width / 2, y: area.midY - p.size.height / 2) }
      let o = CGPoint(x: area.maxX - p.size.width - 16, y: top - p.size.height)
      top -= p.size.height + 12
      return o
    }
  }
}
