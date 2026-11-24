import Foundation

/// The `Idempotency-Key` of a share sheet session. One random id per share, the same on every retry of that same share,
/// so a send whose reply was lost (the relay may already have stored it) is not stored twice. If anything in the share
/// changes between tries (the owner edits the note), the id changes: the relay would otherwise answer the edit with the
/// first version. The id is random and carries nothing from the share.
public struct ShareRetryKey: Sendable {
    private var last: (payload: SharePayload, key: String)?

    public init() {}

    public mutating func key(for payload: SharePayload) -> String {
        if let last, last.payload == payload { return last.key }
        let key = UUID().uuidString
        last = (payload, key)
        return key
    }
}
