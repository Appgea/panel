---
title: Does a dropped or doubled connection leave the session recoverable?
family: journey
parts: network
agent: claude
---

Lens: a user on a live connection when the link drops, doubles or a peer leaves. Read only.

1. Name every live transport the app opens: sockets, streams, realtime listeners.
2. Read each open call and what happens when the attempt is no longer wanted.
3. Find the close side and which object owns each connection and timer.
4. Find the retry timing: the delay, the attempt count and what cancels a pending retry.
5. Check peer presence: when a peer drops mid-session, is its state cleared?
6. Check framing: is every message framed, and is one decoder kept per peer?

A finding: a path where the user loses the session or sees a ghost peer, with the sequence on both ends and the `path:line` of the open, close and reader.
Not a finding: the wording of a failure message, a request that fails once and offers Retry, an offline mode on purpose.

## Learned
