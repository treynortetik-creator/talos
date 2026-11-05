import Foundation

/// A web origin reduced to (scheme, host, port) with default ports made explicit, so "https://a.example.test" and "https://a.example.test:443"
/// compare equal and nothing else does.
public struct Origin: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init(scheme: String, host: String, port: Int?) {
        let s = scheme.lowercased()
        self.scheme = s
        self.host = host.lowercased()
        // WebKit's WKSecurityOrigin reports port 0 for "default".
        if let p = port, p > 0 {
            self.port = p
        } else {
            self.port = Origin.defaultPort(for: s)
        }
    }

    public init?(url: URL) {
        guard let scheme = url.scheme, let host = url.host, !host.isEmpty else { return nil }
        self.init(scheme: scheme, host: host, port: url.port)
    }

    static func defaultPort(for scheme: String) -> Int {
        switch scheme {
        case "https": return 443
        case "http": return 80
        default: return 0
        }
    }
}

/// Decides which web content may talk to native code, and which pages must leave the shell web view.
/// The relay origin is fixed at build time (capacitor.config.json); it is never read from page content.
public struct BridgeGuard: Sendable {
    public let relay: Origin

    public init(relay: Origin) {
        self.relay = relay
    }

    public init?(relayURL: URL) {
        guard let origin = Origin(url: relayURL) else { return nil }
        self.init(relay: origin)
    }

    /// A plugin call is delivered only when it comes from the top frame, on the relay origin, at a path outside /media/.
    /// Anything missing or unparsable is denied.
    public func allowsPluginCall(isMainFrame: Bool, frameOrigin: Origin?, pageURL: URL?) -> Bool {
        guard isMainFrame else { return false }
        guard let frameOrigin, frameOrigin == relay else { return false }
        guard let pageURL, isRelayURL(pageURL) else { return false }
        return !BridgeGuard.isMediaPath(pageURL)
    }

    /// True for /media and everything under it, after percent-decoding, slash collapsing and dot-segment removal, so
    /// "/Media/x", "//media/x", "/a/../media/x" and "/%6Dedia/x" all count. (Case-insensitive on purpose: over-blocking is safe.)
    public static func isMediaPath(_ url: URL) -> Bool {
        let comps = normalizedSegments(of: url)
        return comps.first == "media"
    }

    static func normalizedSegments(of url: URL) -> [String] {
        // Use the raw, still-encoded path so "%2e%2e" and "%2F" are seen by us, not pre-resolved.
        let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        var out: [String] = []
        for seg in raw.split(separator: "/", omittingEmptySubsequences: true) {
            let decoded = (String(seg).removingPercentEncoding ?? String(seg)).lowercased()
            // A decoded slash inside a segment ("%2F") splits it, as a lenient server might.
            for part in decoded.split(whereSeparator: { $0 == "/" || $0 == "\\" }) {
                switch part {
                case ".": continue
                case "..": if !out.isEmpty { out.removeLast() }
                default: out.append(String(part))
                }
            }
        }
        return out
    }

    // MARK: Sharing an attachment from the page

    /// The relay URL for a "share this attachment" request, or nil. Only `/media/<id>` is accepted, where the id is letters,
    /// digits, `_` or `-` (at most 64): no sub-path (`/page`, `/app`), no query, no dot segments, no other host. The page sends
    /// a path, never a URL, so the host always comes from the build-time relay origin.
    public func shareMediaURL(path: String) -> URL? {
        guard path.hasPrefix("/media/") else { return nil }
        let id = path.dropFirst("/media/".count)
        guard !id.isEmpty, id.utf8.count <= 64,
              id.unicodeScalars.allSatisfy({ ($0.isASCII) && (CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-") })
        else { return nil }
        var c = URLComponents()
        c.scheme = relay.scheme
        c.host = relay.host
        let isDefault = relay.port == 0 || relay.port == Origin.defaultPort(for: relay.scheme)
        if !isDefault { c.port = relay.port }
        c.path = path
        return c.url
    }

    /// A file name that is safe to create in a temp folder and to show in the share sheet: no path parts, no control or
    /// direction-changing characters, no leading dot, at most 200 UTF-8 bytes (the extension is kept), never empty.
    public static func shareFileName(_ raw: String) -> String {
        let banned: (Unicode.Scalar) -> Bool = { u in
            let v = u.value
            return v < 0x20 || (0x7F...0x9F).contains(v) || (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v)
                || v == 0x2028 || v == 0x2029 || v == 0x200E || v == 0x200F || v == 0x061C || v == 0xFEFF
        }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: raw.unicodeScalars.filter { !banned($0) })
        var name = String(scalars)
        name = String(name.split(omittingEmptySubsequences: true, whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? "")
        // Whitespace and dots go together from the front, so " .." and ". ." cannot leave a ".." or "." behind.
        let lead: (Character) -> Bool = { $0 == "." || $0.isWhitespace }
        while let first = name.first, lead(first) { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let limit = 200
        if name.utf8.count > limit {
            var ext = ""
            if let dot = name.lastIndex(of: "."), name.distance(from: dot, to: name.endIndex) <= 12 { ext = String(name[dot...]) }
            let stemBudget = limit - ext.utf8.count
            var stem = ""
            for ch in name.dropLast(ext.count) {
                if stem.utf8.count + String(ch).utf8.count > stemBudget { break }
                stem.append(ch)
            }
            name = stem + ext
        }
        return name.isEmpty ? "file" : name
    }

    /// Exact origin match (scheme + host + port). No prefix matching, no userinfo trick (a URL whose userinfo names the relay has the other host as its host;
    /// a URL with any userinfo is rejected outright), and a trailing-dot host is a different origin.
    public func isRelayURL(_ url: URL) -> Bool {
        guard let o = Origin(url: url), o == relay else { return false }
        return url.user == nil && url.password == nil
    }

    /// A relay /media/ URL: it opens in the bridge-less in-app viewer, not in the shell and not in Safari (Safari has no
    /// session cookie, so it would get a 401).
    public func isRelayMedia(_ url: URL) -> Bool {
        isRelayURL(url) && BridgeGuard.isMediaPath(url)
    }

    /// True when a navigation must leave the shell web view:
    /// - any new-window request (target=_blank, window.open) to http(s), and
    /// - any top-level http(s) navigation that is not a relay page outside /media/ (other hosts, other ports, http
    ///   downgrade, lookalikes, relay /media/).
    /// Non-web schemes (the capacitor:// offline page, about:blank) are not decided here. Sub-frame loads stay in
    /// place: the app embeds /media/ pages in a sandboxed iframe whose bridge and prompt() calls are dropped.
    public func shouldOpenInSafari(url: URL, isNewWindow: Bool, isMainFrameTarget: Bool) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        if isNewWindow { return true }
        guard isMainFrameTarget else { return false }
        return !(isRelayURL(url) && !BridgeGuard.isMediaPath(url))
    }

    // MARK: Decisions for the web view's native hooks
    // Each one is a single answer the view controller passes straight to WebKit, so the rule is tested here and the controller
    // cannot quietly keep a looser one.

    public enum Permission: Equatable, Sendable { case grant, deny }

    /// Camera, microphone and motion: only the top frame on the relay origin outside /media/ (the same test as a plugin call).
    /// An iframe of agent-written HTML, another origin or a missing origin is denied.
    public func devicePermission(isMainFrame: Bool, frameOrigin: Origin?, pageURL: URL?) -> Permission {
        allowsPluginCall(isMainFrame: isMainFrame, frameOrigin: frameOrigin, pageURL: pageURL) ? .grant : .deny
    }

    /// Capacitor answers its cookie channel through `prompt()`. Only the plugin-call frame may reach it; every other frame
    /// gets the cancelled answer (nil).
    public func allowsPromptChannel(isMainFrame: Bool, frameOrigin: Origin?, pageURL: URL?) -> Bool {
        allowsPluginCall(isMainFrame: isMainFrame, frameOrigin: frameOrigin, pageURL: pageURL)
    }

    public enum PopupAction: Equatable, Sendable {
        /// Relay /media/ opens in the in-app viewer; any other web address opens in Safari.
        case showMedia, openInBrowser
        /// `mailto:` from the trusted frame only.
        case openMail
        /// Everything else: tel:, other apps' schemes, javascript:, data:, a missing address, mail from an untrusted frame.
        case refuse
    }

    /// What a new-window request does. A page can never launch another app.
    public func popupAction(url: URL?, sourceIsTrusted: Bool) -> PopupAction {
        guard let url else { return .refuse }
        switch url.scheme?.lowercased() ?? "" {
        case "http", "https": return isRelayMedia(url) ? .showMedia : .openInBrowser
        case "mailto": return sourceIsTrusted ? .openMail : .refuse
        default: return .refuse
        }
    }
}
