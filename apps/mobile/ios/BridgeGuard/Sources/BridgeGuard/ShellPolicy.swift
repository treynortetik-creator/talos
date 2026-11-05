import Foundation

// Pure decisions for the iPhone shell's launch, retry and file viewer (audit D3, D6, D49). No WebKit import: the view
// controller feeds in what WebKit reported and acts on the answer, and `swift test` covers the answers.

extension BridgeGuard {
    /// The offline page's "Try again" is a link to this scheme. It is intercepted natively and never loaded.
    public static let retryScheme = "talos-retry"

    /// How long a launch may wait for the relay page before the shell shows the offline page instead of a blank view.
    public static let launchTimeout: TimeInterval = 12

    public static func isRetryURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == retryScheme
    }

    /// True when the web view is NOT showing a relay page: the bundled offline page, a blank view after the web process
    /// died, or nothing loaded. A retry (tap, network back, app foregrounded) only acts then, so it never reloads a
    /// working page out from under the owner.
    public func needsRetry(currentURL: URL?) -> Bool {
        guard let currentURL else { return true }
        return !isRelayURL(currentURL)
    }

    /// A tap on "Try again" is honoured only when it comes from the main frame of a page that is not a relay page. A relay
    /// or /media/ page, or a sub-frame, cannot trigger a reload by linking to the scheme.
    public func allowsRetry(url: URL, isMainFrame: Bool, currentURL: URL?) -> Bool {
        BridgeGuard.isRetryURL(url) && isMainFrame && needsRetry(currentURL: currentURL)
    }

    /// A relay page that has COMMITTED (the relay answered and the HTML is arriving) is progressing, not stalled; its
    /// scripts may take longer than a stall before commit. It gets this longer limit, then the watchdog still ends it.
    public static let committedLaunchTimeout: TimeInterval = 60

    public static func launchLimit(relayPageCommitted: Bool) -> TimeInterval {
        relayPageCommitted ? committedLaunchTimeout : launchTimeout
    }

    /// The launch watchdog: after the launch limit with no relay page finished, fall to the offline page. A stall before
    /// commit uses `launchTimeout`; a committed, still-loading relay page uses `committedLaunchTimeout`.
    public static func shouldFallToOffline(elapsed: TimeInterval, relayPageFinished: Bool, relayPageCommitted: Bool = false) -> Bool {
        !relayPageFinished && elapsed >= launchLimit(relayPageCommitted: relayPageCommitted)
    }
}

/// What the file viewer does with a response from relay /media/.
public enum MediaOutcome: Equatable, Sendable {
    case show
    case download
    case failed(message: String)
}

public enum MediaPolicy {
    /// - Parameters:
    ///   - statusCode: HTTP status, nil for a non-HTTP response.
    ///   - contentDisposition: the raw Content-Disposition header, if any.
    ///   - canShowMIMEType: WebKit's `canShowMIMEType` for the response.
    ///   - mimeType: the response MIME type. A PDF or an image is downloaded even though WebKit can show it: the shown page
    ///     has no Save or Share, and the preview sheet has both (audit D6 for PDFs, L15 for images).
    /// A failure status never renders its body (the relay answers 410 with raw JSON). An attachment, or a type WebKit
    /// cannot show, is downloaded to a temp file and handed to the system preview and Share sheet.
    public static func classify(statusCode: Int?, contentDisposition: String?, canShowMIMEType: Bool, mimeType: String? = nil) -> MediaOutcome {
        if let statusCode, statusCode >= 400 { return .failed(message: failureMessage(statusCode: statusCode)) }
        if let cd = contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased(), cd.hasPrefix("attachment") {
            return .download
        }
        let type = mimeType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if type == "application/pdf" || type.hasPrefix("image/") { return .download }
        return canShowMIMEType ? .show : .download
    }

    /// WebKit reports "Plug-in handled load" (WebKitErrorDomain 204) when a main-frame media document (video/mp4) is
    /// handed to the media player. The file is playing; it is not a failure.
    public static func isPluginHandledLoad(domain: String, code: Int) -> Bool {
        domain == "WebKitErrorDomain" && code == 204
    }

    /// Cancelled navigations are not new failures: a download took over, or the failure panel is already up. WebKit
    /// reports "frame load interrupted by policy change" (WebKitErrorDomain 102) for both.
    public static func isCancelledLoad(domain: String, code: Int) -> Bool {
        (domain == NSURLErrorDomain && code == NSURLErrorCancelled) || (domain == "WebKitErrorDomain" && code == 102)
    }

    public static func failureMessage(statusCode: Int) -> String {
        switch statusCode {
        case 404, 410: return "This file is no longer available. Files are kept for a limited time."
        case 401, 403: return "Talos could not open this file. Sign in again, then retry."
        default: return "Talos could not load this file (error \(statusCode)). Check your connection and retry."
        }
    }

    /// Filesystem limit is 255 bytes, not characters; 200 leaves room for the temp-folder rules and a suffix.
    public static let maxFileNameBytes = 200

    /// A name safe to use inside the temp folder: no path parts, no hidden-file dot, bounded length, never empty.
    public static func safeFileName(_ suggested: String?) -> String {
        let last = (suggested ?? "").split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? ""
        var name = last.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
            .map(String.init).joined()
        while name.hasPrefix(".") { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        if name.isEmpty { return "file" }
        if name.count > 120 || name.utf8.count > maxFileNameBytes {
            let ext = (name as NSString).pathExtension
            let keepExt = !ext.isEmpty && ext.count <= 10 && ext.utf8.count <= 20
            let tail = keepExt ? "." + ext : ""
            let stemSource = keepExt ? (name as NSString).deletingPathExtension : name
            let budget = maxFileNameBytes - tail.utf8.count
            var stem = ""
            for ch in stemSource {
                if stem.count + tail.count >= 120 || stem.utf8.count + ch.utf8.count > budget { break }
                stem.append(ch)
            }
            name = (stem.isEmpty ? "file" : stem) + tail
        }
        return name
    }
}
