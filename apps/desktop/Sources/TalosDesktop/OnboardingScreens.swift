import AppKit
import CoreImage
import SwiftUI
import TalosDesktopCore

/// What the screens show besides the flow's own state: facts the app knows (time spent, the sign-in page's link, a code box).
struct OnboardingExtras: Equatable {
  var downloadElapsed: TimeInterval = 0
  var signInLink: String?
  var signInWantsCode = false
  var failureDetail: String?
}

/// The buttons and links of every screen, handed in by the coordinator (a screenshot passes empty ones).
struct OnboardingActions {
  var getStarted: () -> Void = {}
  var tryAgain: () -> Void = {}
  var continuePressed: () -> Void = {}
  var signIn: () -> Void = {}
  var openSignInPage: () -> Void = {}
  var submitCode: (String) -> Void = { _ in }
  var back: () -> Void = {}
  var choosePhone: () -> Void = {}
  var chooseThisMacOnly: () -> Void = {}
  var wordsMatch: (NSEvent?, NSButton) -> Void = { _, _ in }
  var wordsDontMatch: () -> Void = {}
  var retryPairing: () -> Void = {}
  var showAppleWindow: () -> Void = {}
  /// Not enough free space for Apple's install: look again.
  var recheckSpace: () -> Void = {}
  /// Opens System Settings at General > Storage.
  var openStorage: () -> Void = {}
  /// Asks Apple's installer without the space check (Apple's own installer has the final say).
  var tryAnyway: () -> Void = {}
}

/// The setup window's one view: the screen for the flow's step. Pure of any process; `OnboardingCoordinator` feeds it.
struct OnboardingRootView: View {
  var flow: OnboardingFlow
  var extras = OnboardingExtras()
  var actions = OnboardingActions()

  var body: some View {
    Group {
      switch flow.step {
      case .welcome: WelcomeScreen(actions: actions)
      case .ready:
        switch flow.download {
        case .offline(let p): OfflineScreen(flow: flow, pct: p, failed: nil, extras: extras, actions: actions)
        case .failed(let p, let m): OfflineScreen(flow: flow, pct: p, failed: m, extras: extras, actions: actions)
        default: ReadyScreen(flow: flow, extras: extras, actions: actions)
        }
      case .appleTools: AppleToolsScreen(flow: flow, actions: actions)
      case .signIn: SignInScreen(flow: flow, extras: extras, actions: actions)
      case .phone: PhoneScreen(flow: flow, actions: actions)
      case .pair: PairScreen(flow: flow, actions: actions)
      case .hello: Color.clear  // the Talos window takes over; nothing of the setup is left on screen
      }
    }
    .frame(width: OB.width, height: OB.height)
  }
}

private struct Robot: View {
  var size: CGFloat
  var decorative = false
  var body: some View {
    Group {
      if let img = OnboardingFonts.robot() {
        Image(nsImage: img).resizable().interpolation(.high).scaledToFit()
      } else {
        Image(systemName: "figure.stand").resizable().scaledToFit().foregroundStyle(OB.muted)
      }
    }
    .frame(width: size, height: size)
    .accessibilityLabel(decorative ? "" : OnboardingCopy.robotAlt)
    .accessibilityHidden(decorative)
  }
}

@MainActor private func muted(_ s: String, size: CGFloat = 16) -> some View {
  Text(s).font(OB.body(size)).foregroundStyle(OB.muted).lineSpacing(size * 0.5 - 4).fixedSize(horizontal: false, vertical: true)
}

// MARK: 1 Welcome

private struct WelcomeScreen: View {
  var actions: OnboardingActions
  var body: some View {
    OBFrame(flow: nil) {
      HStack(spacing: 40) {
        Robot(size: 200)
        VStack(alignment: .leading, spacing: 16) {
          Text(OnboardingCopy.welcomeTitle).font(OB.heading(40)).tracking(0.8).accessibilityAddTraits(.isHeader)
          muted(OnboardingCopy.welcomeBody, size: 17)
          VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(OnboardingCopy.welcomeSteps.enumerated()), id: \.offset) { i, t in
              HStack(spacing: 12) {
                Text("\(i + 1)").font(OB.body(13, .semibold)).frame(width: 28, height: 28).background(Circle().fill(OB.track))
                Text(t).font(OB.body(15))
              }
              .accessibilityElement(children: .combine)
            }
          }
          .padding(.top, 8)
        }
      }
      .padding(.horizontal, 64)
    } footer: {
      Button(OnboardingCopy.getStarted, action: actions.getStarted).buttonStyle(PillStyle()).keyboardShortcut(.defaultAction)
    }
  }
}

// MARK: 2 Getting Talos ready

private struct ReadyScreen: View {
  var flow: OnboardingFlow
  var extras: OnboardingExtras
  var actions: OnboardingActions

  private var pct: Int { if case .running(let p) = flow.download { return p } else { return 100 } }
  private var bar: OnboardingFlow.ReadyBar { OnboardingFlow.readyBar(pct: pct, done: flow.download == .done, elapsed: extras.downloadElapsed) }

  var body: some View {
    OBFrame(flow: flow) {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 24) {
          Robot(size: 96, decorative: true)
          VStack(alignment: .leading, spacing: 8) {
            Text(OnboardingCopy.readyTitle).font(OB.heading(30)).accessibilityAddTraits(.isHeader)
            muted(OnboardingCopy.readyBody)
          }
        }
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text(OnboardingCopy.readyDownloading).font(OB.body(14, .medium))
            Spacer()
            Text(bar.detail).font(OB.body(14)).foregroundStyle(OB.muted)
          }
          OBBar(pct: bar.pct, label: "Download progress")
        }
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(OnboardingFlow.readyLines(pct: pct, done: flow.download == .done).enumerated()), id: \.offset) { i, state in
            let titles = [OnboardingCopy.readyHome, OnboardingCopy.readyDownloading, OnboardingCopy.readyChecking]
            HStack(spacing: 12) {
              switch state {
              case .done:
                Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundStyle(OB.done).frame(width: 22, height: 22)
              case .active: OBSpinner()
              case .waiting: Circle().fill(OB.dot).frame(width: 8, height: 8).frame(width: 22, height: 22)
              }
              Text(titles[i]).font(OB.body(15, state == .active ? .medium : .regular)).foregroundStyle(state == .waiting ? OB.muted : OB.ink)
            }
            .accessibilityElement(children: .combine)
            .accessibilityValue(state == .done ? "done" : (state == .active ? "in progress" : "waiting"))
          }
        }
      }
      .padding(.horizontal, 64)
    } footer: {
      Text(OnboardingCopy.readyFooter).font(OB.body(13)).foregroundStyle(OB.muted).frame(maxWidth: .infinity, alignment: .leading)
      Button(OnboardingCopy.continueButton, action: actions.continuePressed).buttonStyle(PillStyle()).disabled(!flow.continueLit)
    }
  }
}

// MARK: 2b One quick Apple install

private struct AppleToolsScreen: View {
  var flow: OnboardingFlow
  var actions: OnboardingActions

  var body: some View {
    OBFrame(flow: flow) {
      HStack(spacing: 40) {
        VStack(alignment: .leading, spacing: 14) {
          Text(flow.tools.isNeedSpace ? OnboardingCopy.spaceTitle : OnboardingCopy.appleTitle).font(OB.heading(28)).fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
          switch flow.tools {
          case .asking:
            muted(OnboardingCopy.appleAsking)
            (Text(OnboardingCopy.appleClick).bold() + Text(OnboardingCopy.appleClickRest)).font(OB.body(16)).lineSpacing(4)
              .fixedSize(horizontal: false, vertical: true)
            Button(OnboardingCopy.appleNoWindow, action: actions.showAppleWindow).buttonStyle(LinkStyle())
          case .needSpace(let have):
            muted(OnboardingCopy.spaceBody(have: have))
            Button(OnboardingCopy.tryAgain, action: actions.recheckSpace).buttonStyle(PillStyle())
            HStack(spacing: 20) {
              Button(OnboardingCopy.spaceAnyway, action: actions.tryAnyway).buttonStyle(LinkStyle())
              Button(OnboardingCopy.spaceHow, action: actions.openStorage).buttonStyle(LinkStyle())
            }
          case .installing(let pct):
            muted(OnboardingCopy.appleInstalling)
            HStack {
              Text(OnboardingCopy.appleInstallingLabel).font(OB.body(14, .medium))
              Spacer()
              Text(pct.map { OnboardingCopy.appleLeft(minutes: max(1, Int((Double(100 - $0) / 20).rounded()))) } ?? OnboardingCopy.appleWorking)
                .font(OB.body(14)).foregroundStyle(OB.muted)
            }
            OBBar(pct: pct, label: "Apple's tools, installing")
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if !flow.tools.isNeedSpace {
          AppleWindowSketch().opacity({ if case .installing = flow.tools { return 0.45 } else { return 1 } }()).accessibilityHidden(true)
        }
      }
      .padding(.horizontal, 64)
    } footer: {
      Text(flow.tools.isNeedSpace ? OnboardingCopy.spaceFooter : OnboardingCopy.appleFooter).font(OB.body(13)).foregroundStyle(OB.muted).frame(maxWidth: .infinity, alignment: .leading)
      Button(OnboardingCopy.continueButton, action: {}).buttonStyle(PillStyle()).disabled(true)
    }
  }
}

/// A drawing of Apple's own window, so the owner knows which button to press (the mock's right-hand card).
private struct AppleWindowSketch: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(OnboardingCopy.appleWindowTitle).font(OB.body(13, .semibold)).foregroundStyle(OB.ink)
      Text(OnboardingCopy.appleWindowText).font(OB.body(12)).foregroundStyle(Color(hex: 0x333333)).lineSpacing(2)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 6) {
        Spacer()
        ForEach(Array(OnboardingCopy.appleWindowButtons.enumerated()), id: \.offset) { i, t in
          let install = i == OnboardingCopy.appleWindowButtons.count - 1
          Text(t).font(OB.body(12, install ? .semibold : .regular)).foregroundStyle(install ? OB.ink : Color(hex: 0x333333)).lineLimit(1).fixedSize()
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(install ? OB.accent : Color(hex: 0xEEEEEE)))
            .overlay { if install { RoundedRectangle(cornerRadius: 8).stroke(OB.accent, lineWidth: 3).padding(-5) } }
        }
      }
      .padding(.top, 4)
      Text(OnboardingCopy.appleWindowAgree).font(OB.body(12)).foregroundStyle(Color(hex: 0x555555)).fixedSize(horizontal: false, vertical: true)
    }
    .padding(18)
    .frame(width: 250)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
    .overlay(RoundedRectangle(cornerRadius: 12).stroke(OB.line, lineWidth: 1))
    .shadow(color: OB.ink.opacity(0.12), radius: 12, y: 8)
  }
}

// MARK: Offline (and any other stop of the download)

private struct OfflineScreen: View {
  var flow: OnboardingFlow
  var pct: Int
  var failed: String?
  var extras: OnboardingExtras
  var actions: OnboardingActions

  var body: some View {
    OBFrame(flow: flow) {
      VStack(alignment: .leading, spacing: 24) {
        HStack(spacing: 24) {
          Image(systemName: "wifi.slash").font(.system(size: 40, weight: .regular)).foregroundStyle(OB.danger)
            .frame(width: 96, height: 96).background(RoundedRectangle(cornerRadius: 24).fill(OB.paper))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(OB.line, lineWidth: 1)).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 8) {
            Text(failed == nil ? OnboardingCopy.offlineTitle : OnboardingCopy.readyTitle).font(OB.heading(30)).accessibilityAddTraits(.isHeader)
            muted(failed == nil ? OnboardingCopy.offlineBody : OnboardingCopy.downloadStopped)
          }
        }
        VStack(alignment: .leading, spacing: 10) {
          HStack {
            Text(OnboardingCopy.offlinePaused(pct: pct)).font(OB.body(14, .medium))
            Spacer()
            Text(OnboardingCopy.offlineSafe).font(OB.body(14)).foregroundStyle(OB.muted)
          }
          OBBar(pct: pct, color: OB.paused, label: "Download progress, paused")
        }
        HStack(spacing: 12) {
          Image(systemName: "info.circle").font(.system(size: 18)).foregroundStyle(OB.muted).accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 4) {
            Text(OnboardingCopy.offlineNote).font(OB.body(14)).foregroundStyle(OB.muted)
            if let failed {
              DisclosureGroup(OnboardingCopy.details) { Text(failed).font(OB.body(12)).foregroundStyle(OB.muted).textSelection(.enabled) }
                .font(OB.body(12)).foregroundStyle(OB.muted)
            }
          }
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(RoundedRectangle(cornerRadius: 12).fill(OB.paper))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(OB.line, lineWidth: 1))
      }
      .padding(.horizontal, 64)
    } footer: {
      Button(OnboardingCopy.offlineButton, action: actions.tryAgain).buttonStyle(PillStyle()).keyboardShortcut(.defaultAction)
    }
  }
}

// MARK: 3 Sign in

private struct SignInScreen: View {
  var flow: OnboardingFlow
  var extras: OnboardingExtras
  var actions: OnboardingActions
  @State private var code = ""

  var body: some View {
    OBFrame(flow: flow) {
      VStack(spacing: 20) {
        Image(systemName: "person").font(.system(size: 30, weight: .regular)).foregroundStyle(OB.ink)
          .frame(width: 72, height: 72).background(RoundedRectangle(cornerRadius: 20).fill(OB.paper))
          .overlay(RoundedRectangle(cornerRadius: 20).stroke(OB.line, lineWidth: 1)).accessibilityHidden(true)
        Text(OnboardingCopy.signInTitle).font(OB.heading(30)).accessibilityAddTraits(.isHeader)
        muted(OnboardingCopy.signInBody).multilineTextAlignment(.center).frame(maxWidth: 480)
        switch flow.signIn {
        case .waiting:
          VStack(spacing: 12) {
            HStack(spacing: 10) {
              OBSpinner(size: 20)
              Text(OnboardingCopy.signInWaiting).font(OB.body(15, .medium))
            }
            .accessibilityElement(children: .combine)
            Button(OnboardingCopy.signInNoBrowser, action: actions.openSignInPage).buttonStyle(LinkStyle())
            if extras.signInWantsCode {
              HStack {
                SecureField(OnboardingText.signInCodeLabel, text: $code).textFieldStyle(.roundedBorder).frame(width: 260)
                  .onSubmit { actions.submitCode(code); code = "" }
                Button(OnboardingCopy.signInCodeSend) { actions.submitCode(code); code = "" }.buttonStyle(PillStyle(kind: .outline, height: 36, padding: 16, size: 13))
                  .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty)
              }
            }
          }
        case .idle, .failed:
          if case .failed(let m) = flow.signIn {
            Text(m).font(OB.body(14)).foregroundStyle(OB.danger).multilineTextAlignment(.center).frame(maxWidth: 480)
              .fixedSize(horizontal: false, vertical: true)
          }
          Button(OnboardingCopy.signInButton, action: actions.signIn)
            .buttonStyle(PillStyle(height: 52, padding: 36, size: 17)).keyboardShortcut(.defaultAction)
        }
      }
      .padding(.horizontal, 96)
    } footer: {
      Button(OnboardingCopy.back, action: actions.back).buttonStyle(.plain).font(OB.body(14)).foregroundStyle(OB.muted).frame(minHeight: 44)
      Spacer()
      Text(OnboardingCopy.signInFooter).font(OB.body(13)).foregroundStyle(OB.muted)
    }
  }
}

// MARK: 4a Use Talos on your phone

private struct PhoneScreen: View {
  var flow: OnboardingFlow
  var actions: OnboardingActions

  var body: some View {
    OBFrame(flow: flow) {
      VStack(alignment: .leading, spacing: 24) {
        VStack(alignment: .leading, spacing: 8) {
          Text(OnboardingCopy.phoneTitle).font(OB.heading(30)).accessibilityAddTraits(.isHeader)
          muted(OnboardingCopy.phoneBody)
        }
        HStack(spacing: 16) {
          choice("iphone", OnboardingCopy.phoneYes, OnboardingCopy.phoneYesBody, strong: true, action: actions.choosePhone)
          choice("desktopcomputer", OnboardingCopy.phoneNo, OnboardingCopy.phoneNoBody, strong: false, action: actions.chooseThisMacOnly)
        }
      }
      .padding(.horizontal, 64)
    } footer: {
      Button(OnboardingCopy.back, action: actions.back).buttonStyle(.plain).font(OB.body(14)).foregroundStyle(OB.muted).frame(minHeight: 44)
      Spacer()
    }
  }

  private func choice(_ icon: String, _ title: String, _ detail: String, strong: Bool, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 12) {
        Image(systemName: icon).font(.system(size: 34, weight: .regular)).foregroundStyle(OB.ink).frame(height: 40).accessibilityHidden(true)
        Text(title).font(OB.body(19, .semibold))
        Text(detail).font(OB.body(14)).foregroundStyle(OB.muted).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
      }
      .padding(24)
      .frame(maxWidth: .infinity, minHeight: 180, maxHeight: 180, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 16).fill(OB.paper))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(strong ? OB.accent : OB.line, lineWidth: 2))
      .contentShape(RoundedRectangle(cornerRadius: 16))
    }
    .buttonStyle(.plain)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(title). \(detail)")
    .accessibilityAddTraits(.isButton)
  }
}

// MARK: 4b Scan, then check the four words

private struct PairScreen: View {
  var flow: OnboardingFlow
  var actions: OnboardingActions

  private var link: String? {
    switch flow.pair {
    case .scan(let l), .confirm(let l, _): return l
    default: return nil
    }
  }
  private var failedPair: Bool { if case .failed = flow.pair { return true } else { return false } }
  private var words: [String]? { if case .confirm(_, let w) = flow.pair { return w } else { return nil } }

  var body: some View {
    OBFrame(flow: flow) {
      HStack(spacing: 48) {
        VStack(spacing: 12) {
          QRBox(link: link, failed: failedPair).accessibilityLabel(OnboardingCopy.pairScanLabel)
          Text(failedPair ? OnboardingCopy.pairNoCode : (link == nil ? OnboardingCopy.pairMaking : OnboardingCopy.pairPoint)).font(OB.body(13)).foregroundStyle(OB.muted)
        }
        VStack(alignment: .leading, spacing: 16) {
          Text(OnboardingCopy.pairTitle).font(OB.heading(28)).accessibilityAddTraits(.isHeader)
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(OnboardingCopy.pairSteps.enumerated()), id: \.offset) { i, t in
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(i + 1).").font(OB.body(15)).foregroundStyle(OB.muted)
                Text(t).font(OB.body(15)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
              }
            }
          }
          HStack(spacing: 8) {
            ForEach(0..<4, id: \.self) { i in
              Text(words?[i] ?? (failedPair ? "" : "\u{2026}")).font(OB.body(15, .semibold)).foregroundStyle(words == nil ? OB.muted : OB.ink)
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: 10).fill(OB.paper))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(OB.line, lineWidth: 1))
                .accessibilityLabel(words?[i] ?? "waiting for your phone")
            }
          }
          bottom
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .padding(.horizontal, 64)
    } footer: {
      Button(OnboardingCopy.back, action: actions.back).buttonStyle(.plain).font(OB.body(14)).foregroundStyle(OB.muted).frame(minHeight: 44)
      Spacer()
      // the hint is about a button that is not shown while the last try failed
      if !failedPair { Text(OnboardingCopy.pairFooter).font(OB.body(13)).foregroundStyle(OB.muted) }
    }
  }

  @ViewBuilder private var bottom: some View {
    switch flow.pair {
    case .failed(let m):
      Text(m).font(OB.body(14)).foregroundStyle(OB.danger).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 12) {
        Button(OnboardingCopy.tryAgain, action: actions.retryPairing).buttonStyle(PillStyle(padding: 24))
        Button(OnboardingCopy.phoneNo, action: actions.chooseThisMacOnly).buttonStyle(PillStyle(kind: .outline, padding: 20))
      }
    case .connecting:
      HStack(spacing: 10) {
        OBSpinner(size: 20)
        Text(OnboardingCopy.pairConnecting).font(OB.body(15, .medium))
      }
    default:
      HStack(spacing: 12) {
        // a real click only: the four words are answered by the owner's own hand (PairingController.approve)
        RealClickPill(title: OnboardingCopy.pairMatch, enabled: words != nil, action: actions.wordsMatch)
          .frame(width: 168, height: 44)
        Button(OnboardingCopy.pairNoMatch, action: actions.wordsDontMatch).buttonStyle(PillStyle(kind: .outline, padding: 20))
          .disabled(words == nil)
      }
    }
  }
}

/// The QR of a link, drawn crisp (no smoothing) on a white card as in the mock. No link yet: an empty card with a spinner.
private struct QRBox: View {
  var link: String?
  var failed = false
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 16).fill(failed ? OB.paper : Color.white)
      if let link, let img = Self.image(for: link) {
        Image(nsImage: img).resizable().interpolation(.none).scaledToFit().padding(16).accessibilityHidden(true)
      } else if !failed {
        OBSpinner(size: 28)  // only while a code is being made, never after a failure
      }
    }
    .frame(width: 200, height: 200)
    .overlay(RoundedRectangle(cornerRadius: 16).stroke(OB.line, lineWidth: 1))
    .accessibilityElement(children: .ignore)
  }

  static func image(for text: String) -> NSImage? {
    guard let f = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    f.setValue(Data(text.utf8), forKey: "inputMessage")
    f.setValue("M", forKey: "inputCorrectionLevel")
    guard let out = f.outputImage else { return nil }
    let scaled = out.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
    let rep = NSCIImageRep(ciImage: scaled)
    let img = NSImage(size: rep.size)
    img.addRepresentation(rep)
    return img
  }
}

/// An orange pill that is a real `NSButton`, so the click can be checked: only the owner's own mouse answers the four words.
private struct RealClickPill: NSViewRepresentable {
  var title: String
  var enabled: Bool
  var action: (NSEvent?, NSButton) -> Void

  func makeNSView(context: Context) -> FirstMouseButton {
    let b = FirstMouseButton(title: title, target: context.coordinator, action: #selector(Coordinator.pressed(_:)))
    b.isBordered = false
    b.wantsLayer = true
    b.keyEquivalent = ""
    b.setAccessibilityLabel(title)
    return b
  }

  func updateNSView(_ b: FirstMouseButton, context: Context) {
    context.coordinator.action = action
    b.isEnabled = enabled
    let color = enabled ? NSColor(srgbRed: 0x14 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1) : NSColor(srgbRed: 0x5A / 255, green: 0x4A / 255, blue: 0x3C / 255, alpha: 1)
    b.attributedTitle = NSAttributedString(
      string: title,
      attributes: [
        .font: NSFont.systemFont(ofSize: 15, weight: .semibold), .foregroundColor: color,
      ])
    b.layer?.backgroundColor = (enabled ? NSColor(srgbRed: 0xD9 / 255, green: 0x69 / 255, blue: 0x2B / 255, alpha: 1) : NSColor(srgbRed: 0xE8 / 255, green: 0xD6 / 255, blue: 0xB6 / 255, alpha: 1)).cgColor
    b.layer?.cornerRadius = 22
  }

  func makeCoordinator() -> Coordinator { Coordinator(action: action) }

  final class Coordinator: NSObject {
    var action: (NSEvent?, NSButton) -> Void
    init(action: @escaping (NSEvent?, NSButton) -> Void) { self.action = action }
    @objc func pressed(_ sender: NSButton) { action(NSApp.currentEvent, sender) }
  }
}

/// The setup window's content: the coordinator's flow, drawn. Shown only when this Mac needs setup (`OnboardingMarker.isNeeded`).
struct OnboardingWindowView: View {
  @ObservedObject var model: SupervisorController
  @ObservedObject private var coordinator: OnboardingCoordinator
  @Environment(\.dismissWindow) private var dismissWindow
  private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

  init(model: SupervisorController) {
    _model = ObservedObject(wrappedValue: model)
    // one setup per app run: opening the window again reattaches to the download that is running
    _coordinator = ObservedObject(wrappedValue: OnboardingShared.get(model: model))
  }

  var body: some View {
    OnboardingRootView(flow: coordinator.flow, extras: coordinator.extras, actions: coordinator.actions)
      .onAppear {
        OnboardingDismissal.clear(home: NSHomeDirectory())  // opened again (the menu or a launch): the earlier close is forgotten
        coordinator.setCloseWindow { dismissWindow(id: "onboarding") }
        // A Mac that is already set up never sees the new screens (an existing install, or this one finished).
        if !OnboardingMarker.isNeeded(configured: model.configured, pending: OnboardingMarker.isPending(home: NSHomeDirectory())),
          coordinator.flow.step == .welcome
        {
          dismissWindow(id: "onboarding")
        }
      }
      .onDisappear {
        coordinator.windowClosed()
        // closed by the owner before the end while this Mac still needs setup: remembered, so the launch does not open it again
        let home = NSHomeDirectory()
        if coordinator.flow.step != .hello, OnboardingMarker.isNeeded(configured: model.configured, pending: OnboardingMarker.isPending(home: home)) {
          OnboardingDismissal.set(home: home)
        }
      }
      .onReceive(tick) { _ in coordinator.tick() }
  }
}
