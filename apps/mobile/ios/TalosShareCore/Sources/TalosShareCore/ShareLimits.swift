import Foundation

/// The relay's share limits (packages/protocol/src/share.ts `SHARE_LIMITS`, `SharePostBody`). Lengths are UTF-16 code
/// units because the relay measures JavaScript string length.
public enum ShareLimits {
    public static let textUTF16 = 32_000
    public static let noteUTF16 = 4_000
    public static let titleUTF16 = 300
    public static let maxFiles = 4
    public static let fileBytes: Int64 = 20 * 1024 * 1024
    /// `SHARE_IDEMPOTENCY_KEY_RE`: what the relay accepts in the `Idempotency-Key` header (a UUID fits).
    static let idempotencyKeyPattern = #"^[A-Za-z0-9_-]{16,64}\z"#
}
