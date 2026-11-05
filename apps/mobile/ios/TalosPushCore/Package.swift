// swift-tools-version: 5.9
import PackageDescription

// What the push plugin decides, with no UIKit import (UserNotifications is only used for the plain option and category values) so `swift test` runs on any Mac (IOS-SPEC WP-I5):
// the token as hex, the notification categories and their buttons, which in-app path a tap may open, and which APNs
// environment this build talks to. The app target supplies the real UNUserNotificationCenter behind it.
let package = Package(
    name: "TalosPushCore",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "TalosPushCore", targets: ["TalosPushCore"])
    ],
    targets: [
        .target(name: "TalosPushCore"),
        .testTarget(name: "TalosPushCoreTests", dependencies: ["TalosPushCore"])
    ]
)
