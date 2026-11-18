// swift-tools-version: 5.9
import PackageDescription

// The native side of bring-your-own-relay (docs/specs/BYOR.md): the setup-link parser, the relay profile, the relay list in
// the Keychain and the relay descriptor. Foundation and Security only, no UIKit, so `swift test` runs on any Mac.
let package = Package(
    name: "TalosRelayCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TalosRelayCore", targets: ["TalosRelayCore"])
    ],
    targets: [
        .target(name: "TalosRelayCore"),
        .testTarget(
            name: "TalosRelayCoreTests",
            dependencies: ["TalosRelayCore"],
            resources: [.copy("Fixtures")]
        )
    ]
)
