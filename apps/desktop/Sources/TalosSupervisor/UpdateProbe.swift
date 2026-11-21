import Foundation
import TalosDesktopCore

/// What a look at the release feed found.
public enum UpdateProbeResult: Equatable, Sendable {
  case upToDate(String)
  /// A newer version is published (the running one is older, or too old to update in place: the full check says which).
  case newer(String)
  case problem(UpdateStatus.CheckProblem)
}

extension AutoUpdater {
  /// A look at the feed that needs nothing else: no agent session, no Talos code folder, no clone acceptance, and it does not matter
  /// whether automatic updates are on. It fetches the signed release note, verifies it with the pinned keys and compares versions;
  /// it downloads and changes nothing. This is what lets "Check for Updates" give an answer before sign-in. Safe from any thread.
  public func probe(timeout: Double = 7) -> UpdateProbeResult {
    guard !options.keys.isEmpty, let running = options.appVersion else {
      audit("probe", ["result": "no_key_or_version"])
      return .problem(.other)
    }
    guard let base = AutoUpdate.feedBase(hooks.settings().feed, allowLocal: options.allowLocalFeed),
      let mURL = AutoUpdate.fileURL(base, AutoUpdate.manifestName), let sURL = AutoUpdate.fileURL(base, AutoUpdate.sigName)
    else {
      audit("probe", ["result": "bad_feed"])
      return .problem(.other)
    }
    guard let bytes = hooks.fetch(mURL, ReleaseManifest.maxBytes, timeout), let sig = hooks.fetch(sURL, ReleaseManifest.maxSigBytes, timeout)
    else {
      let off = hooks.offline()
      audit("probe", ["result": off ? "offline" : "fetch_failed"])
      return .problem(off ? .offline : .server)
    }
    switch ReleaseManifest.verify(bytes, sig: sig, trust: keyring()) {
    case .failure(let why):
      audit("probe", ["result": "refused", "why": "\(why)"])
      return .problem(.unverified)
    case .success(let m):
      switch m.decision(running: running) {
      case .install, .tooOld:
        audit("probe", ["result": "newer", "version": m.version])
        return .newer(m.version)
      case .upToDate, .downgrade, .unknownRunning:
        audit("probe", ["result": "up_to_date"])
        return .upToDate(running)
      }
    }
  }
}
