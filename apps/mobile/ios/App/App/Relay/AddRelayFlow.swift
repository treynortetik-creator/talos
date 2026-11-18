import Foundation
import TalosRelayCore

/// BYOR phase 3b (docs/specs/BYOR.md 3.2, 10): from a scanned setup link to a saved RelayProfile. No UI here, so it is unit-tested
/// with a stubbed descriptor fetch. It never switches the web view's origin, never pins and never runs device/verify (phase 4).

/// Reads `<origin>/.well-known/talos-relay`. A protocol so tests (and the DEBUG hook) can stub the network.
protocol DescriptorFetching {
    func fetch(origin: URL) async throws -> RelayDescriptor
}

enum DescriptorFetchError: Error, Equatable { case network, badAnswer }

/// One case per thing that can go wrong, each with the plain words the owner reads.
enum AddRelayError: Error, Equatable {
    case link(EnrollLinkError)
    case noFp
    case unreachable(host: String)
    case notARelay(host: String)

    var message: String {
        switch self {
        case .link(.badLink): return "That isn't a Talos setup link. Show the code again on your Mac and scan it."
        case .link(.noCode): return "This setup link has no pairing code. Show the code again on your Mac and scan it."
        case .link(.badFp): return "This setup link's security fingerprint is damaged. Show the code again on your Mac and scan it."
        case .link(.dupFp): return "This setup link is not valid (it repeats the fingerprint). Show the code again on your Mac."
        case .noFp: return "This setup link is from an older Talos. Update Talos on your Mac and show the code again."
        case let .unreachable(host): return "Couldn't reach \(host). Check that your Mac is online, then scan again."
        case let .notARelay(host): return "\(host) did not answer like a Talos relay. Nothing was saved."
        }
    }
}

/// What the owner confirms before anything is saved.
struct PendingRelay: Equatable {
    let profile: RelayProfile
    /// Shown large on the confirmation: the host the owner reads is the guard against lookalike domains.
    var host: String { profile.label }
    /// An advisory only (spec 10c): never blocks.
    let note: String?
    /// The scanned setup code, kept in memory only (never stored) so the page can continue pairing after the switch.
    let code: String
}

struct AddRelayFlow {
    let fetcher: DescriptorFetching
    let appVersion: String
    var now: () -> Date = Date.init
    var newDataStoreId: () -> UUID = UUID.init

    /// Parse, require the pin, fetch the descriptor, check min_app, build the profile. Saves nothing.
    func prepare(link: String) async -> Result<PendingRelay, AddRelayError> {
        let parsed: EnrollLink
        switch EnrollLink.parse(link) {
        case let .success(l): parsed = l
        case let .failure(e): return .failure(.link(e))
        }
        guard case let .success(fp) = parsed.requirePin() else { return .failure(.noFp) }
        let host = parsed.origin.host ?? parsed.origin.absoluteString
        let shown = parsed.origin.port.map { "\(host):\($0)" } ?? host
        let descriptor: RelayDescriptor
        do {
            descriptor = try await fetcher.fetch(origin: parsed.origin)
        } catch let e as DescriptorFetchError {
            return .failure(e == .badAnswer ? .notARelay(host: shown) : .unreachable(host: shown))
        } catch {
            return .failure(.unreachable(host: shown))
        }
        // device_id "" means NOT ENROLLED (phase 4 fills it in after device/verify). Nothing may treat "" as a device.
        guard let profile = RelayProfile(
            id: descriptor.relayId, origin: parsed.origin, kind: descriptor.kind, label: shown, bridgeFp: fp, deviceId: "",
            dataStoreId: newDataStoreId(), addedAt: now())
        else { return .failure(.notARelay(host: shown)) }
        return .success(PendingRelay(profile: profile, note: descriptor.check(appVersion: appVersion).note, code: parsed.code))
    }

    static func save(_ pending: PendingRelay, in store: RelayStore) throws { try store.add(pending.profile) }
}

/// The real fetch: https only, ephemeral session (no cookies, no cache), 10 s, no redirects (a redirect could leave the host the
/// owner is about to confirm), a small body.
struct URLSessionDescriptorFetcher: DescriptorFetching {
    static let maxBytes = 16 * 1024

    private final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ s: URLSession, task: URLSessionTask, willPerformHTTPRedirection r: HTTPURLResponse,
                        newRequest: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    }

    func fetch(origin: URL) async throws -> RelayDescriptor {
        guard origin.scheme == "https", let url = URL(string: "/.well-known/talos-relay", relativeTo: origin)?.absoluteURL else {
            throw DescriptorFetchError.badAnswer
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 10
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        let bytes: URLSession.AsyncBytes, response: URLResponse
        do { (bytes, response) = try await session.bytes(for: request) } catch { throw DescriptorFetchError.network }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.expectedContentLength <= Int64(Self.maxBytes) else { throw DescriptorFetchError.badAnswer }
        let data: Data
        do { data = try await Self.readCapped(bytes, cap: Self.maxBytes) } catch let e as DescriptorFetchError { throw e } catch {
            throw DescriptorFetchError.network
        }
        guard let descriptor = try? JSONDecoder().decode(RelayDescriptor.self, from: data) else { throw DescriptorFetchError.badAnswer }
        return descriptor
    }

    /// Reads a body byte by byte and gives up as soon as it passes `cap`, so a huge answer is never downloaded whole.
    static func readCapped<S: AsyncSequence>(_ bytes: S, cap: Int) async throws -> Data where S.Element == UInt8 {
        var out = Data()
        for try await b in bytes {
            out.append(b)
            if out.count > cap { throw DescriptorFetchError.badAnswer }
        }
        return out
    }
}
