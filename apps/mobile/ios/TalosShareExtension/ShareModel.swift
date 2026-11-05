import Foundation
import SwiftUI
import TalosShareCore
import UniformTypeIdentifiers

/// What the sheet shows. Messages are fixed phrases: nothing from the relay, the system or the token is ever displayed.
@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        case sent
        case failed(String)
        /// Nothing to retry: the user has to do something in Talos first.
        case blocked(String)
    }

    @Published var phase: Phase = .loading
    @Published var note = ""
    @Published private(set) var summary = ""
    /// Items left out because of the 4-file or 20 MB limits (shown in the preview, never silently dropped).
    @Published private(set) var skipped = 0
    @Published private(set) var agentLabel = "Talos"
    var onClose: () -> Void = {}

    private var payload = SharePayload()
    private var token: ShareToken?
    private var relay: URL?
    private var scratch: URL?

    deinit { if let scratch { try? FileManager.default.removeItem(at: scratch) } }

    func load(from items: [NSExtensionItem]) {
        guard let relay = CompiledRelay.url() else {
            phase = .blocked("Open Talos once, then try sharing again.")
            return
        }
        guard let token = KeychainTokenStore.load() else {
            phase = .blocked("Turn on \u{201C}Use the iPhone share sheet\u{201D} in Talos Settings first.")
            return
        }
        self.relay = relay
        self.token = token
        Task {
            await collect(items)
            // A text-only link cannot send files: say so now, before a note is typed, instead of at Send (audit D50).
            if !payload.files.isEmpty, !token.scopes.contains(.files) {
                phase = .blocked(Self.filesOffMessage)
                return
            }
            if payload.text == nil, payload.url == nil, payload.files.isEmpty {
                // Everything offered was over the size cap: say that, not that the kind of item is unsupported (audit D50).
                phase = .blocked(skipped > 0 ? Self.tooLargeMessage : "Talos can't share this kind of item.")
            } else {
                phase = .ready
            }
        }
    }

    func send() {
        guard let token, let relay, phase == .ready || isFailed else { return }
        var p = payload
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        p.note = trimmed.isEmpty ? nil : trimmed
        phase = .sending
        Task {
            let result = await ShareClient.send(p, token: token, relayHost: relay)
            phase = Self.phase(for: result)
            if phase == .sent {
                try? await Task.sleep(nanoseconds: 900_000_000)
                onClose()
            }
        }
    }

    private var isFailed: Bool { if case .failed = phase { return true } else { return false } }

    nonisolated static let tooLargeMessage = "That is too large to share (20 MB per file, 4 files)."
    nonisolated static let filesOffMessage = "Photos and files are off for this share link. Turn them on in Talos Settings."

    nonisolated static func phase(for result: ShareResult) -> Phase {
        switch result {
        case .sent: return .sent
        case .tokenInvalid: return .blocked("Turn the share sheet on again in Talos Settings.")
        case .rateLimited: return .failed("Too many shares. Try again in a few minutes.")
        case .tooLarge: return .failed(Self.tooLargeMessage)
        case .network: return .failed("Couldn't reach Talos. Check your connection and try again.")
        case .refused(let r):
            switch r {
            case .filesNotAllowed: return .blocked(filesOffMessage)
            case .empty: return .failed("There is nothing to send.")
            case .fieldTooLong: return .failed("That is too long to share.")
            default: return .failed("Couldn't share that item.")
            }
        case .rejected: return .failed("Talos couldn't take that share.")
        }
    }

    // MARK: - Reading the items

    private func collect(_ items: [NSExtensionItem]) async {
        var texts: [String] = []
        var files: [ShareFile] = []
        for item in items {
            if let t = item.attributedTitle?.string ?? item.attributedContentText?.string, payload.title == nil {
                payload.title = String(t.prefix(ShareLimits.titleUTF16))
            }
            for provider in item.attachments ?? [] {
                if Self.isFileProvider(provider) {
                    // Caps are checked before anything is copied: a 5th file, or one over 20 MB, is counted and skipped.
                    if files.count >= ShareLimits.maxFiles { skipped += 1; continue }
                    if let file = await fileFrom(provider) { files.append(file) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                    let url = await urlFrom(provider)
                {
                    if url.isFileURL { continue }
                    if payload.url == nil { payload.url = url.absoluteString }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                    let s = await textFrom(provider)
                {
                    texts.append(s)
                }
            }
        }
        if !texts.isEmpty { payload.text = texts.joined(separator: "\n\n") }
        payload.files = files
        var parts: [String] = []
        if let u = payload.url { parts.append(URL(string: u)?.host ?? "a link") }
        if let t = payload.text { parts.append(String(t.prefix(140))) }
        if !files.isEmpty { parts.append(files.count == 1 ? "1 file" : "\(files.count) files") }
        if skipped > 0 { parts.append("\(skipped) not included (4 files, 20 MB each)") }
        summary = parts.joined(separator: "\n")
    }

    private func urlFrom(_ p: NSItemProvider) async -> URL? {
        (try? await p.loadItem(forTypeIdentifier: UTType.url.identifier)) as? URL
    }

    private func textFrom(_ p: NSItemProvider) async -> String? {
        let v = try? await p.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        return (v as? String) ?? (v as? NSAttributedString)?.string
    }

    /// A provider is a file when it is an image, movie, PDF, a file URL, or generic data that is NOT text or a web link.
    /// (`public.plain-text` and `public.url` conform to `public.data`, so a Notes or Messages share would otherwise be
    /// uploaded as a .txt file and refused for a text-only token.)
    nonisolated static func isFileProvider(_ p: NSItemProvider) -> Bool {
        let has = { (t: UTType) in p.hasItemConformingToTypeIdentifier(t.identifier) }
        if has(.plainText) || has(.text) { return false }
        if has(.url) && !has(.fileURL) { return false }
        return has(.image) || has(.movie) || has(.pdf) || has(.fileURL) || has(.data)
    }

    /// The system deletes the provider's file when the callback returns, so it is copied into this extension's own temp
    /// folder (and streamed from there by the upload; never read into memory). Over-size files are not copied.
    private func fileFrom(_ p: NSItemProvider) async -> ShareFile? {
        let type = p.registeredTypeIdentifiers.compactMap { UTType($0) }.first { $0.conforms(to: .data) || $0.conforms(to: .image) }
            ?? .data
        let dir = scratchDir()
        let outcome: ShareFile?? = await withCheckedContinuation { cont in
            p.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else { return cont.resume(returning: .some(nil)) }
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
                if size > ShareLimits.fileBytes { return cont.resume(returning: .none) }  // too large: skip before copying
                let name = Self.safeName(p.suggestedName, fallback: url.lastPathComponent, ext: url.pathExtension)
                let dest = dir.appendingPathComponent(UUID().uuidString + "-" + name)
                do {
                    try FileManager.default.copyItem(at: url, to: dest)
                    cont.resume(returning: .some(ShareFile(url: dest, filename: name, mimeType: type.preferredMIMEType ?? "application/octet-stream")))
                } catch { cont.resume(returning: .some(nil)) }
            }
        }
        if case .none = outcome { skipped += 1; return nil }
        return outcome ?? nil
    }

    nonisolated static func safeName(_ suggested: String?, fallback: String, ext: String) -> String {
        var name = (suggested?.isEmpty == false ? suggested! : fallback)
        name = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
        if !ext.isEmpty, !name.lowercased().hasSuffix("." + ext.lowercased()) { name += "." + ext }
        return String(name.prefix(120))
    }

    private func scratchDir() -> URL {
        if let scratch { return scratch }
        let d = FileManager.default.temporaryDirectory.appendingPathComponent("talos-share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        scratch = d
        return d
    }
}
