import AppKit
import CoreText
import SwiftUI
import TalosDesktopCore

/// The setup screens' look, from the approved mock: cream grounds, ink text, one orange, done-green, Cinzel headings, Inter body.
@MainActor
enum OB {
  static let cream = Color(hex: 0xF3E6CF)
  static let paper = Color(hex: 0xFBF4E6)
  static let ink = Color(hex: 0x141110)
  static let muted = Color(hex: 0x5A4A3C)
  static let line = Color(hex: 0xD3BF9C)
  static let accent = Color(hex: 0xD9692B)
  static let done = Color(hex: 0x2E6A3A)
  static let track = Color(hex: 0xE8D6B6)
  static let link = Color(hex: 0x9A3F12)
  static let dot = Color(hex: 0xC9B38F)
  static let paused = Color(hex: 0xB8A68E)
  static let danger = Color(hex: 0xA3241A)
  static let width: CGFloat = 760
  static let height: CGFloat = 560
  static let helloSize = CGSize(width: 960, height: 640)

  static func heading(_ size: CGFloat) -> Font { OnboardingFonts.font(family: "Cinzel", size: size, weight: .bold) }
  static func body(_ size: CGFloat, _ weight: NSFont.Weight = .regular) -> Font {
    OnboardingFonts.font(family: "Inter", size: size, weight: weight)
  }
}

extension Color {
  init(hex: UInt32) {
    self.init(.sRGB, red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255, blue: Double(hex & 255) / 255, opacity: 1)
  }
}

/// Where the setup's art and type are: inside the app (`Contents/Resources/onboarding`), or a folder a test names.
@MainActor
enum OnboardingFonts {
  static var directoryOverride: URL?
  private static var registered = false

  static var directory: URL? {
    directoryOverride ?? Bundle.main.resourceURL?.appendingPathComponent("onboarding", isDirectory: true)
  }

  /// Registers Cinzel and Inter for this process (once). A missing file leaves the system's serif and sans in their place.
  static func register() {
    guard !registered, let dir = directory else { return }
    registered = true
    for f in ["Cinzel.ttf", "Inter.ttf"] {
      CTFontManagerRegisterFontsForURL(dir.appendingPathComponent(f) as CFURL, .process, nil)
    }
  }

  static func font(family: String, size: CGFloat, weight: NSFont.Weight) -> Font {
    register()
    let base = NSFontDescriptor(fontAttributes: [.family: family])
    let d = base.addingAttributes([.traits: [NSFontDescriptor.TraitKey.weight: weight]])
    if let f = NSFont(descriptor: d, size: size), f.familyName == family { return Font(f) }
    // not installed (a stripped bundle): the closest system look, never a crash
    return family == "Cinzel" ? .system(size: size, weight: Font.Weight(weight), design: .serif) : .system(size: size, weight: Font.Weight(weight))
  }

  static func robot() -> NSImage? { directory.flatMap { NSImage(contentsOf: $0.appendingPathComponent("talos-robot.png")) } }
}

extension Font.Weight {
  init(_ w: NSFont.Weight) {
    switch w {
    case .bold: self = .bold
    case .semibold: self = .semibold
    case .medium: self = .medium
    default: self = .regular
    }
  }
}

/// A pill: 44 pt tall at least, the mock's primary (orange), quiet (grey, for a button that is not lit yet) or outline.
struct PillStyle: ButtonStyle {
  enum Kind { case primary, quiet, outline }
  var kind: Kind = .primary
  var height: CGFloat = 44
  var padding: CGFloat = 28
  var size: CGFloat = 15
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    let lit = kind == .primary && enabled
    configuration.label
      .font(OB.body(size, kind == .outline ? .medium : .semibold))
      .foregroundStyle(lit ? OB.ink : (kind == .outline ? OB.ink : OB.muted))
      .padding(.horizontal, padding)
      .frame(minHeight: height)
      .background { if kind == .outline { OutlineCapsule(color: OB.line) } else { Capsule().fill(lit ? OB.accent : OB.track) } }
      .opacity(configuration.isPressed ? 0.85 : 1)
      .contentShape(Capsule())
  }
}

struct LinkStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(OB.body(14)).foregroundStyle(OB.link).underline().frame(minHeight: 44).contentShape(Rectangle())
      .opacity(configuration.isPressed ? 0.7 : 1)
  }
}

/// The mock's frame: a 40 pt title strip, the three-step bar when the screen has one, the content, and the footer.
struct OBFrame<Content: View, Footer: View>: View {
  var flow: OnboardingFlow?
  var size = CGSize(width: OB.width, height: OB.height)
  var footerAlignment: HorizontalAlignment = .trailing
  @ViewBuilder var content: Content
  @ViewBuilder var footer: Footer

  var body: some View {
    VStack(spacing: 0) {
      Text(OnboardingCopy.windowTitle).font(OB.body(13)).foregroundStyle(OB.muted)
        .frame(maxWidth: .infinity).frame(height: 40)
        .background(OB.paper).overlay(alignment: .bottom) { OB.line.frame(height: 1) }
      if let flow, let n = flow.stepNumber {
        VStack(alignment: .leading, spacing: 8) {
          Text(OnboardingCopy.stepLabel(n)).font(OB.body(13, .semibold)).foregroundStyle(OB.muted)
          HStack(spacing: 6) {
            ForEach(Array(flow.segments.enumerated()), id: \.offset) { _, s in
              RoundedRectangle(cornerRadius: 3).fill(s == .done ? OB.done : (s == .current ? OB.accent : OB.track)).frame(height: 6)
            }
          }
        }
        .padding(.horizontal, 64).padding(.top, 20)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(OnboardingCopy.stepLabel(n))
      }
      content.frame(maxWidth: .infinity, maxHeight: .infinity)
      HStack(spacing: 12) { footer }
        .padding(.horizontal, 32).padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .overlay(alignment: .top) { OB.line.frame(height: 1) }
    }
    .frame(width: size.width, height: size.height)
    .background(OB.cream)
    .foregroundStyle(OB.ink)
  }
}

/// The bar of a download or install: a 12 pt track with an orange fill, or a moving one when no number is known.
struct OBBar: View {
  var pct: Int?
  var color: Color = OB.accent
  var label: String
  @State private var phase: CGFloat = 0

  var body: some View {
    GeometryReader { g in
      ZStack(alignment: .leading) {
        Capsule().fill(OB.track)
        if let pct {
          Capsule().fill(color).frame(width: g.size.width * CGFloat(min(100, max(0, pct))) / 100)
        } else {
          Capsule().fill(color).frame(width: g.size.width * 0.3).offset(x: (g.size.width * 0.7) * phase)
            .onAppear { withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { phase = 1 } }
        }
      }
      .clipShape(Capsule())
    }
    .frame(height: 12)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue(pct.map { "\($0) percent" } ?? "working")
  }
}

struct OBSpinner: View {
  var size: CGFloat = 22
  var color: Color = OB.accent
  @State private var turn = false
  var body: some View {
    Circle().trim(from: 0, to: 0.75).stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round)).frame(width: size - 4, height: size - 4)
      .frame(width: size, height: size).rotationEffect(.degrees(turn ? 360 : 0))
      .onAppear { withAnimation(.linear(duration: 1).repeatForever(autoreverses: false)) { turn = true } }
      .accessibilityHidden(true)
  }
}

/// A capsule with a 1 pt outline, drawn as two fills (the outline colour, then the ground inside it). A stroked capsule leaves a stray
/// vertical line at each end when it is rendered to an image; two filled shapes do not.
struct OutlineCapsule: View {
  var color: Color
  var width: CGFloat = 1
  var body: some View {
    Capsule().fill(color).overlay(Capsule().fill(OB.cream).padding(width))
  }
}
