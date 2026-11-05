-- Bytes of dictation audio sent to the transcription service, one row per call, written when the call is sent. The daily
-- cap sums the last 24 hours, so it survives a restart. No audio, no words: a time and a size.
create table voice_dictation_usage (
  at integer not null,
  bytes integer not null
);
create index voice_dictation_usage_at on voice_dictation_usage (at);
