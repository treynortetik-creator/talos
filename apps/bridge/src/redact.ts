// The redaction `talos-app report` and `talos-app logs` use lives in the protocol now, so the bug reporter in the app and the
// relay's webhook clean text by the same rules (packages/protocol/src/redact.ts).
export { type RedactOptions, redact } from '@talos-app/protocol'
