# Release notes — working draft

This file stages the body of the **next** GitHub Release. It is not a record of
past releases:

- Shipped releases are recorded in [`CHANGELOG.md`](CHANGELOG.md), which is
  authoritative.
- Published release bodies live on the
  [Releases page](https://github.com/mahadansar/sol-luna-orchestrator/releases).

Drafting the narrative version here rather than in the changelog means a release
body can be written and reviewed before the tag exists. Once a release has
shipped, clear this file back to the outline below: a copy of an entry that is
already published only drifts from it.

**Currently in preparation: nothing.** The latest release is v0.6.1.

---

## Outline for the next release

Title the body `sol-luna-orchestrator vX.Y.Z`, then:

1. **What this release is for** — one or two sentences, in the reader's terms
   rather than the diff's, saying who should care.
2. **Install** — a fenced `bash` block with `npm install -g sol-luna-orchestrator`
   followed by `sol-luna-orchestrator init`.
3. **Fixed / Added / Changed** — what actually shipped. State plainly when a
   release contains no runtime change, and equally plainly when it does; 0.5.1
   was briefly described as documentation-only when it also carried a real
   concurrency fix.
4. **Unchanged** — anything a reader might reasonably assume changed but did not,
   particularly the benchmark conclusions, which no release so far has altered.
5. **Links** — README, [`CHANGELOG.md`](CHANGELOG.md), [`SECURITY.md`](SECURITY.md),
   and the MIT licence.

Keep every claim traceable to something measured or shipped. No performance or
cost claim belongs here that `bench/RESULTS.md` does not support.
