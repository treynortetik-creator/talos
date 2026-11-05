// swift-tools-version:6.2
import PackageDescription

let package = Package(
  name: "TalosDesktop",
  platforms: [.macOS(.v14)],
  products: [
    .executable(name: "TalosDesktop", targets: ["TalosDesktop"]),
    // The supervisor is a library so Option C (a session per thread) can host several sessions with the same code.
    .library(name: "TalosSupervisor", targets: ["TalosSupervisor"]),
  ],
  dependencies: [
    // Pinned exactly: SwiftTerm's API is mid-migration to 2.0 (DESKTOP-SPEC D14).
    .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.1"),
  ],
  targets: [
    // Foundation only, pure, fully unit-tested (DESKTOP-SPEC 3.1).
    .target(name: "TalosDesktopCore"),
    // Process launching, tmux, the owned pty and the supervisor loop. No AppKit, so it is testable headless.
    .target(
      name: "TalosSupervisor",
      dependencies: ["TalosDesktopCore", .product(name: "SwiftTerm", package: "SwiftTerm")]
    ),
    .executableTarget(
      name: "TalosDesktop",
      dependencies: ["TalosDesktopCore", "TalosSupervisor", .product(name: "SwiftTerm", package: "SwiftTerm")]
    ),
    .testTarget(name: "TalosDesktopCoreTests", dependencies: ["TalosDesktopCore"]),
    // A real WKWebView (no window is shown). Runs only with TALOS_GUI_TESTS=1 (DESKTOP-SPEC 7.2).
    .testTarget(name: "TalosDesktopGuiTests", dependencies: ["TalosDesktop", "TalosDesktopCore"]),
    // Real tmux (private socket), real pty and the fake-claude fixtures. No windows.
    .testTarget(
      name: "TalosDesktopIntegrationTests",
      dependencies: ["TalosDesktopCore", "TalosSupervisor", .product(name: "SwiftTerm", package: "SwiftTerm")]
    ),
  ]
)
