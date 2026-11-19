import CryptoKit
import Foundation

/// Installs Claude Code with Anthropic's own installer script, only when `claude` is missing. The script is the exact copy this Talos was
/// released with, inside the signed app (`Contents/Resources/claude-install.sh`, fetched and sha256-checked by `bundle-tools.sh` at build
/// time): nothing is downloaded to get it, so it cannot change under the app. Its sha256 is checked again before it runs, with the
/// pinned version, a clean environment and no terminal. The script itself fetches the Claude Code binary and checks it against
/// Anthropic's manifest.
public struct ClaudeInstaller: Sendable {
  /// sha256 of the installer script as it was when this Talos was released (2026-11-19), and the Claude Code version it is asked for.
  /// `bundle-tools.sh` pins the same hash. Bump both together.
  public static let pinnedScriptSHA256 = "2c5506d110560bf618bbe88f678f2c2a0047c86a9c6585fc84976120b1de0b44"
  public static let pinnedVersion = "2.1.328"

  /// The copy inside the app; nil for a build that has none (a development build).
  public var scriptPath: String?
  public var sha256: String
  public var version: String
  public var env: [String: String]
  public var bash = "/bin/bash"
  public var timeout: Double = 900
  /// Where Claude Code lands (`~/.local/bin/claude`); checked after the script ran.
  public var expectedBinary: String
  public var workDir: String

  public init(
    env: [String: String], home: String, workDir: String, scriptPath: String?, sha256: String = ClaudeInstaller.pinnedScriptSHA256,
    version: String = ClaudeInstaller.pinnedVersion
  ) {
    self.env = env
    self.workDir = workDir
    self.scriptPath = scriptPath
    self.sha256 = sha256
    self.version = version
    expectedBinary = home + "/.local/bin/claude"
  }

  /// nil: installed. Otherwise what to tell the owner.
  public func run() -> String? {
    guard version.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+$"#, options: .regularExpression) != nil else {
      return "The Claude Code version this Talos asks for (\(version)) is not a plain version number."
    }
    guard let scriptPath, let data = FileManager.default.contents(atPath: scriptPath) else {
      return "This build of Talos has no Claude Code installer inside it. Install Claude Code yourself (https://claude.ai/code), then press Retry."
    }
    let got = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard got == sha256 else {
      return "The Claude Code installer inside this Talos is not the one it was released with (its checksum differs), so Talos did not run it. "
        + "Reinstall Talos, or install Claude Code yourself (https://claude.ai/code), then press Retry."
    }
    let dir = workDir + "/.talos-claude-" + UUID().uuidString
    do { try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch {
      return "Talos couldn't make a folder to run Claude Code's installer in: \(error.localizedDescription)"
    }
    defer { try? FileManager.default.removeItem(atPath: dir) }
    let r = ProcessRunner.run([bash, scriptPath, version], env: Self.minimalEnv(env), cwd: dir, timeout: timeout)
    if r.timedOut { return "Installing Claude Code took too long and was stopped. Press Retry." }
    guard r.ok else { return "Installing Claude Code failed.\n\(CloneProvisioner.said(r))\nPress Retry." }
    guard FileManager.default.isExecutableFile(atPath: expectedBinary) else {
      return "The Claude Code installer finished, but \(expectedBinary) is not there. Press Retry."
    }
    return nil
  }

  /// HOME, PATH and the proxy settings; nothing else of the owner's environment reaches the installer.
  static func minimalEnv(_ env: [String: String]) -> [String: String] {
    var e: [String: String] = ["HOME": env["HOME"] ?? NSHomeDirectory(), "PATH": env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin", "LC_ALL": "C"]
    for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"] {
      if let v = env[k] { e[k] = v }
    }
    return e
  }
}
