import Foundation

/// A relay id is minted once by the relay: `r_` plus 20 lowercase RFC 4648 base32 characters (a-z, 2-7).
public enum RelayID {
    public static func isValid(_ s: String) -> Bool {
        let chars = Array(s.utf8)
        guard chars.count == 22, chars[0] == UInt8(ascii: "r"), chars[1] == UInt8(ascii: "_") else { return false }
        return chars[2...].allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 50 && $0 <= 55) }
    }
}
