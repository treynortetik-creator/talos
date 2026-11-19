-- Linked agents (P2): which queued `peer.message` frame belongs to which peer connection, so a revoke can find them without opening
-- every sealed frame. Written in the same transaction as the frame's queue write; purged with the connection and when the frame is gone.
create table hooks_peer_frames (
  frame_id text primary key not null,
  conn_id text not null
);
create index hooks_peer_frames_conn on hooks_peer_frames (conn_id);
