import Foundation

/// A small strict JSON reader (RFC 8259) for the attest answer. Apple's parser accepts a leading BOM and trailing commas and
/// keeps the FIRST of a repeated key, while JavaScript keeps the last; the phone and the bridge must read one body the same
/// way, so this refuses all three (and a lone surrogate, or bytes that are not UTF-8) instead. Bounded: the caller caps the
/// body size, and nesting is capped here.
enum StrictJSON {
    indirect enum Value {
        case string(String)
        case object([String: Value])
        case array([Value])
        case other  // a number, true, false or null: valid, but not a string
    }

    static let maxDepth = 16

    /// The one value in `data`, or nil when it is not strict JSON.
    static func parse(_ data: Data) -> Value? {
        var p = Parser(bytes: Array(data))
        guard let v = p.value(depth: 0) else { return nil }
        p.skipSpace()
        return p.i == p.bytes.count ? v : nil
    }

    private struct Parser {
        let bytes: [UInt8]
        var i = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func skipSpace() {
            while i < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[i]) { i += 1 }
        }

        mutating func eat(_ c: Character) -> Bool {
            guard i < bytes.count, bytes[i] == c.asciiValue else { return false }
            i += 1
            return true
        }

        mutating func literal(_ s: String) -> Bool {
            let u = Array(s.utf8)
            guard i + u.count <= bytes.count, Array(bytes[i..<i + u.count]) == u else { return false }
            i += u.count
            return true
        }

        mutating func value(depth: Int) -> Value? {
            skipSpace()
            guard i < bytes.count else { return nil }
            switch bytes[i] {
            case UInt8(ascii: "{"): return depth < StrictJSON.maxDepth ? object(depth: depth) : nil  // depth = containers already open: 16 levels fit
            case UInt8(ascii: "["): return depth < StrictJSON.maxDepth ? array(depth: depth) : nil
            case UInt8(ascii: "\""): return string().map { .string($0) }
            case UInt8(ascii: "t"): return literal("true") ? .other : nil
            case UInt8(ascii: "f"): return literal("false") ? .other : nil
            case UInt8(ascii: "n"): return literal("null") ? .other : nil
            default: return number() ? .other : nil
            }
        }

        mutating func object(depth: Int) -> Value? {
            i += 1
            var out = [String: Value]()
            var seen = Set<[UInt8]>()  // keys compared as raw UTF-8, as JavaScript compares code units, not canonical equivalence
            skipSpace()
            if eat("}") { return .object(out) }
            while true {
                skipSpace()
                guard i < bytes.count, bytes[i] == UInt8(ascii: "\""), let key = string() else { return nil }
                guard seen.insert(Array(key.utf8)).inserted else { return nil }  // a repeated key
                skipSpace()
                guard eat(":"), let v = value(depth: depth + 1) else { return nil }
                guard out.updateValue(v, forKey: key) == nil else { return nil }  // keys equal as Swift Strings (canonically equivalent) are a repeat too
                skipSpace()
                if eat(",") { continue }  // a "," then "}" fails at the key guard above: no trailing comma
                return eat("}") ? .object(out) : nil
            }
        }

        mutating func array(depth: Int) -> Value? {
            i += 1
            var out = [Value]()
            skipSpace()
            if eat("]") { return .array(out) }
            while true {
                guard let v = value(depth: depth + 1) else { return nil }  // "," then "]" fails here
                out.append(v)
                skipSpace()
                if eat(",") { continue }
                return eat("]") ? .array(out) : nil
            }
        }

        mutating func hex4() -> UInt32? {
            guard i + 4 <= bytes.count else { return nil }
            var v: UInt32 = 0
            for b in bytes[i..<i + 4] {
                guard let d = Character(UnicodeScalar(b)).hexDigitValue else { return nil }
                v = v << 4 | UInt32(d)
            }
            i += 4
            return v
        }

        mutating func string() -> String? {
            i += 1  // the opening quote
            var raw = [UInt8]()
            while i < bytes.count {
                let b = bytes[i]
                i += 1
                switch b {
                case UInt8(ascii: "\""): return String(bytes: raw, encoding: .utf8)  // nil on invalid UTF-8
                case 0..<0x20: return nil
                case UInt8(ascii: "\\"):
                    guard i < bytes.count else { return nil }
                    let e = bytes[i]
                    i += 1
                    switch e {
                    case UInt8(ascii: "\""), UInt8(ascii: "\\"), UInt8(ascii: "/"): raw.append(e)
                    case UInt8(ascii: "b"): raw.append(0x08)
                    case UInt8(ascii: "f"): raw.append(0x0C)
                    case UInt8(ascii: "n"): raw.append(0x0A)
                    case UInt8(ascii: "r"): raw.append(0x0D)
                    case UInt8(ascii: "t"): raw.append(0x09)
                    case UInt8(ascii: "u"):
                        guard var cp = hex4() else { return nil }
                        if (0xD800...0xDBFF).contains(cp) {  // a high surrogate needs its low one right after
                            guard literal("\\u"), let lo = hex4(), (0xDC00...0xDFFF).contains(lo) else { return nil }
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00)
                        } else if (0xDC00...0xDFFF).contains(cp) {
                            return nil  // a lone low surrogate
                        }
                        guard let scalar = UnicodeScalar(cp) else { return nil }
                        raw.append(contentsOf: Array(String(Character(scalar)).utf8))
                    default: return nil
                    }
                default: raw.append(b)
                }
            }
            return nil
        }

        /// -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
        mutating func number() -> Bool {
            func digits(_ p: inout Parser) -> Bool {
                let s = p.i
                while p.i < p.bytes.count, (48...57).contains(p.bytes[p.i]) { p.i += 1 }
                return p.i > s
            }
            _ = eat("-")
            if eat("0") {
            } else if !digits(&self) { return false }
            if eat("."), !digits(&self) { return false }
            if eat("e") || eat("E") {
                _ = eat("+") || eat("-")
                if !digits(&self) { return false }
            }
            return true
        }
    }
}
