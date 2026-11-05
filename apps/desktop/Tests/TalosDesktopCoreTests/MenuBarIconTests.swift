import AppKit
import Foundation
import ImageIO
import Testing

@testable import TalosDesktopCore

private let menuBarResourcesDir: URL = {
  let here = URL(fileURLWithPath: #filePath)
  return here.appendingPathComponent("../../../Resources/menubar").standardized
}()

/// The menu-bar icon is Talos's head, not an SF Symbol (the bell said nothing about Talos). Nothing here skips: a missing file fails.
@Suite("Menu bar icon")
struct MenuBarIconTests {
  static let states = HealthSummary.Icon.allCases
  static let oldSymbols: Set<String> = ["flame", "flame.fill", "bell.badge.fill", "exclamationmark.triangle", "questionmark.circle"]

  @Test func everyStateHasATalosPictureAtBothScalesAtTheMenuBarSize() throws {
    let pt = HealthSummary.Icon.menuBarPoints
    for state in Self.states {
      for scale in [1, 2] {
        let url = menuBarResourcesDir.appendingPathComponent("\(state.menuBarAsset)-\(scale)x.png")
        let src = try #require(CGImageSourceCreateWithURL(url as CFURL, nil), "\(url.lastPathComponent) is missing or unreadable")
        let img = try #require(CGImageSourceCreateImageAtIndex(src, 0, nil))
        #expect(img.width == pt * scale && img.height == pt * scale, "\(url.lastPathComponent) is \(img.width)x\(img.height)")
      }
    }
  }

  @Test func everyStateHasItsOwnPictureAndItIsNoSFSymbol() {
    let names = Self.states.map(\.menuBarAsset)
    #expect(Set(names).count == Self.states.count, "two states share a picture: \(names)")
    for n in names {
      #expect(NSImage(systemSymbolName: n, accessibilityDescription: nil) == nil, "\(n) is an SF Symbol")
      #expect(!Self.oldSymbols.contains(n), "\(n) is one of the old symbols")
    }
  }

  @Test func everyStateHasItsOwnSpokenLabel() {
    let labels = Self.states.map(\.menuBarLabel)
    #expect(Set(labels).count == Self.states.count && !labels.contains(""), "\(labels)")
  }

  /// Help on the failure screen has to describe the picture the bar really shows: the old words (triangle, bell, flame) are gone.
  @Test func theOutageHelpDescribesTheSlashedHeadAndNoOldSymbol() {
    let all = PageState.outageHelp.joined(separator: " ").lowercased()
    #expect(all.contains("a head with a slash through it"))
    for old in ["triangle", "bell", "flame", "question mark"] { #expect(!all.contains(old), Comment(rawValue: old)) }
  }
}
