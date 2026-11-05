import Foundation

/// One crash, hang or resource-limit report from the system, boiled down to what a fixer needs and nothing the owner wrote.
/// The page turns it into a problem report (apps/web/src/features/problems). Every field is a number, a system name or a
/// system-written sentence; there is no message, thread, card or file name in MetricKit's output to begin with, and nothing
/// here goes looking for one.
public struct CrashSummary: Codable, Equatable {
    public struct Frame: Codable, Equatable {
        /// The binary the frame is in (`Talos`, `libsystem_kernel.dylib`).
        public var binary: String
        /// Offset into that binary's text segment. Turning it into a function name needs the build's dSYM.
        public var offset: Int
    }

    /// `crash`, `hang`, `cpu` or `disk`.
    public var kind: String
    /// `EXC_BAD_ACCESS`, `SIGSEGV`, or the kind for the ones without either.
    public var name: String
    /// The system's own reason line, cut short. May be empty.
    public var reason: String
    public var appVersion: String
    public var appBuild: String
    public var frames: [Frame]
}

public enum CrashCore {
    /// The most frames kept from one report and the most reports kept waiting. Matches the protocol's stack cap.
    public static let maxFrames = 40
    public static let maxWaiting = 20
    static let maxReason = 120

    static let exceptionNames: [Int: String] = [
        1: "EXC_BAD_ACCESS", 2: "EXC_BAD_INSTRUCTION", 3: "EXC_ARITHMETIC", 4: "EXC_EMULATION", 5: "EXC_SOFTWARE",
        6: "EXC_BREAKPOINT", 7: "EXC_SYSCALL", 8: "EXC_MACH_SYSCALL", 9: "EXC_RPC_ALERT", 10: "EXC_CRASH",
        11: "EXC_RESOURCE", 12: "EXC_GUARD", 13: "EXC_CORPSE_NOTIFY",
    ]
    static let signalNames: [Int: String] = [
        1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 4: "SIGILL", 5: "SIGTRAP", 6: "SIGABRT", 7: "SIGEMT", 8: "SIGFPE",
        9: "SIGKILL", 10: "SIGBUS", 11: "SIGSEGV", 12: "SIGSYS", 13: "SIGPIPE", 15: "SIGTERM",
    ]

    /// Reads `MXDiagnosticPayload.jsonRepresentation()`. Each diagnostic is read on its own: one with a shape this code does
    /// not know is skipped and the rest still come out, and a payload that is not JSON at all gives an empty list.
    public static func summaries(fromPayloadJSON data: Data) -> [CrashSummary] {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [] }
        var out: [CrashSummary] = []
        let groups: [(key: String, kind: String)] = [
            ("crashDiagnostics", "crash"), ("hangDiagnostics", "hang"),
            ("cpuExceptionDiagnostics", "cpu"), ("diskWriteExceptionDiagnostics", "disk"),
        ]
        for group in groups {
            guard let list = root[group.key] as? [Any] else { continue }
            for item in list {
                if let one = summary(from: item, kind: group.kind) { out.append(one) }
            }
        }
        return out
    }

    private static func summary(from item: Any, kind: String) -> CrashSummary? {
        guard let d = item as? [String: Any] else { return nil }
        let meta = d["diagnosticMetaData"] as? [String: Any] ?? [:]
        let exception = (meta["exceptionType"] as? Int).map { exceptionNames[$0] ?? "EXC_\($0)" }
        let signal = (meta["signal"] as? Int).map { signalNames[$0] ?? "SIG\($0)" }
        let name = exception ?? signal ?? kind
        let reason = String(((meta["terminationReason"] as? String) ?? "").prefix(maxReason))
        return CrashSummary(
            kind: kind,
            name: signal.map { exception == nil ? $0 : "\(name) (\($0))" } ?? name,
            reason: reason,
            appVersion: String((meta["appVersion"] as? String ?? "").prefix(20)),
            appBuild: String((meta["appBuildVersion"] as? String ?? "").prefix(20)),
            frames: frames(from: d["callStackTree"]))
    }

    /// The attributed thread's stack, first frame first, depth-first through the sub-frames.
    private static func frames(from tree: Any?) -> [CrashSummary.Frame] {
        guard let tree = tree as? [String: Any], let stacks = tree["callStacks"] as? [[String: Any]] else { return [] }
        let stack = stacks.first(where: { $0["threadAttributed"] as? Bool == true }) ?? stacks.first
        var out: [CrashSummary.Frame] = []
        func walk(_ frame: Any) {
            guard out.count < maxFrames, let f = frame as? [String: Any] else { return }
            if let binary = f["binaryName"] as? String, let offset = f["offsetIntoBinaryTextSegment"] as? Int {
                out.append(.init(binary: String(binary.prefix(80)), offset: offset))
            }
            for sub in (f["subFrames"] as? [Any]) ?? [] { walk(sub) }
        }
        for root in (stack?["callStackRootFrames"] as? [Any]) ?? [] { walk(root) }
        return out
    }

    /// Adds new summaries behind the waiting ones and keeps the newest `maxWaiting`.
    public static func appending(_ new: [CrashSummary], to waiting: [CrashSummary]) -> [CrashSummary] {
        Array((waiting + new).suffix(maxWaiting))
    }
}
