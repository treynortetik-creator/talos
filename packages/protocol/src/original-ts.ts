// A queued owner message that waited past the Mac's signature age limit is signed again with a new time. A Mac that lists
// this feature also accepts `original_ts` (signed with the rest of the frame) on `message` and `voice_note`: when the words
// were first written. The app adds it only for a Mac that lists the feature, because older frame parsers refuse unknown fields.
export const ORIGINAL_TS_FEATURE = 'original-ts/1'
