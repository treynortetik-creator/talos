import Foundation

/// Whether 32 bytes encode a point on the Ed25519 curve, decided here and not left to whether CryptoKit's key constructor
/// throws: decode y (sign bit stripped), require y < p, compute x^2 = (y^2 - 1) / (d y^2 + 1) mod p, require it to be a square
/// (Euler's criterion: x2^((p-1)/2) is 0 or 1), and refuse x = 0 with the sign bit set. Plain 256-bit arithmetic mod
/// p = 2^255 - 19 on four little-endian UInt64 limbs; slow and simple, used a few times per answer. Same test as
/// packages/protocol/src/bridge-attest.ts, which does it with BigInt.
enum Ed25519Point {
    private typealias Limbs = [UInt64]  // little-endian, any length; field elements are exactly 4 and fully reduced

    private static let p: Limbs = [0xffff_ffff_ffff_ffed, .max, .max, 0x7fff_ffff_ffff_ffff]

    static func isOnCurve(_ raw: Data) -> Bool {
        guard raw.count == 32 else { return false }
        var y = Limbs(repeating: 0, count: 4)
        for (i, b) in raw.enumerated() { y[i / 8] |= UInt64(b) << UInt64(8 * (i % 8)) }
        let signBit = (y[3] >> 63) == 1
        y[3] &= 0x7fff_ffff_ffff_ffff
        guard !atLeast(y, p) else { return false }  // y >= p
        let y2 = mul(y, y)
        let num = sub(y2, one)
        let den = add(mul(d, y2), one)
        let x2 = mul(num, pow(den, pMinus2))  // den is never 0: d is not a square, so d y^2 = -1 has no solution
        if x2 == zero { return !signBit }  // x = 0 has no negative: the sign bit must be clear
        return pow(x2, euler) == one  // a nonzero square raised to (p-1)/2 is 1, a non-square gives p - 1
    }

    // MARK: field arithmetic

    private static let zero: Limbs = [0, 0, 0, 0]
    private static let one: Limbs = [1, 0, 0, 0]
    private static let pMinus2: Limbs = [p[0] - 2, p[1], p[2], p[3]]
    /// (p - 1) / 2 = 2^254 - 10
    private static let euler: Limbs = {
        let m = [p[0] - 1, p[1], p[2], p[3]]
        return [(m[0] >> 1) | (m[1] << 63), (m[1] >> 1) | (m[2] << 63), (m[2] >> 1) | (m[3] << 63), m[3] >> 1]
    }()
    /// d = -121665 / 121666 mod p
    private static let d: Limbs = sub(zero, mul([121665, 0, 0, 0], pow([121666, 0, 0, 0], pMinus2)))

    private static func atLeast(_ a: Limbs, _ b: Limbs) -> Bool {  // a >= b, both 4 limbs
        for i in stride(from: 3, through: 0, by: -1) where a[i] != b[i] { return a[i] > b[i] }
        return true
    }

    /// a - b for 4-limb values with a >= b.
    private static func rawSub(_ a: Limbs, _ b: Limbs) -> Limbs {
        var out = Limbs(repeating: 0, count: 4)
        var borrow: UInt64 = 0
        for i in 0..<4 {
            let (t, o1) = a[i].subtractingReportingOverflow(b[i])
            let (r, o2) = t.subtractingReportingOverflow(borrow)
            out[i] = r
            borrow = (o1 || o2) ? 1 : 0
        }
        return out
    }

    /// Any length to a fully reduced element: fold the part above bit 255 back in as 19 times itself (2^255 = 19 mod p).
    private static func reduce(_ input: Limbs) -> Limbs {
        var a = input
        while a.count < 4 { a.append(0) }
        while a.count > 4 || a[3] >> 63 != 0 {
            let n = a.count
            var hi = Limbs(repeating: 0, count: n - 3)
            for k in 0..<(n - 3) {
                let next: UInt64 = 4 + k < n ? a[4 + k] << 1 : 0
                hi[k] = (a[3 + k] >> 63) | next
            }
            var lo = Array(a[0..<4])
            lo[3] &= 0x7fff_ffff_ffff_ffff
            // lo + 19 * hi
            var out = Limbs(repeating: 0, count: max(4, hi.count + 1) + 1)
            var carry: UInt64 = 0
            for i in 0..<out.count {
                let h = i < hi.count ? hi[i] : 0
                let (ph, pl) = h.multipliedFullWidth(by: 19)
                let l = i < 4 ? lo[i] : 0
                let (s1, o1) = l.addingReportingOverflow(pl)
                let (s2, o2) = s1.addingReportingOverflow(carry)
                out[i] = s2
                carry = ph + (o1 ? 1 : 0) + (o2 ? 1 : 0)
            }
            while out.count > 4, out.last == 0 { out.removeLast() }
            a = out
        }
        if atLeast(a, p) { a = rawSub(a, p) }
        return a
    }

    private static func add(_ a: Limbs, _ b: Limbs) -> Limbs {
        var out = Limbs(repeating: 0, count: 5)
        var carry: UInt64 = 0
        for i in 0..<4 {
            let (s1, o1) = a[i].addingReportingOverflow(b[i])
            let (s2, o2) = s1.addingReportingOverflow(carry)
            out[i] = s2
            carry = (o1 ? 1 : 0) + (o2 ? 1 : 0)
        }
        out[4] = carry
        return reduce(out)
    }

    private static func sub(_ a: Limbs, _ b: Limbs) -> Limbs {  // a - b mod p, both reduced
        add(a, b == zero ? zero : rawSub(p, b))
    }

    private static func mul(_ a: Limbs, _ b: Limbs) -> Limbs {
        var r = Limbs(repeating: 0, count: 8)
        for i in 0..<4 {
            var carry: UInt64 = 0
            for j in 0..<4 {
                let (h, l) = a[i].multipliedFullWidth(by: b[j])
                let (s1, o1) = r[i + j].addingReportingOverflow(l)
                let (s2, o2) = s1.addingReportingOverflow(carry)
                r[i + j] = s2
                carry = h + (o1 ? 1 : 0) + (o2 ? 1 : 0)
            }
            r[i + 4] = carry
        }
        return reduce(r)
    }

    private static func pow(_ base: Limbs, _ exp: Limbs) -> Limbs {
        var result = one
        var sq = base
        for i in 0..<256 {
            if (exp[i / 64] >> UInt64(i % 64)) & 1 == 1 { result = mul(result, sq) }
            sq = mul(sq, sq)
        }
        return result
    }
}
