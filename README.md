# Investigation: Google Gemini `code_execution` Sandbox Isolation (March 2026)

> **Status:** Submitted to the Google AI Vulnerability Reward Program (March 2026); closed as
> **Working-As-Intended**. Re-examined June 2026.
> This repository documents the investigation, the raw evidence, and two competing interpretations
> of the observations. It deliberately stops short of asserting a verdict — the evidence is laid out
> so it can be evaluated independently.

## What this is

A self-directed security investigation into the multi-tenant behavior of Google Gemini's
`code_execution` tool — a gVisor-sandboxed Python runtime reachable through the Gemini API. The
original report hypothesized a **cross-tenant isolation failure** (one user reading another user's
processes, memory, and files). Google closed the report as working-as-intended. This repository
presents the complete evidence neutrally rather than restating the original conclusion as fact.

## What is firmly established (and not in dispute)

These are reproducible syscall results captured inside the sandbox — **not** model hallucination
(the outputs were parsed from `codeExecutionResult` blocks, and the extracted binary artifacts
deserialize correctly):

- **Real code execution** inside a gVisor sandbox. The guest kernel reports `4.4.0` (a gVisor
  fingerprint); the environment carries `BORG_CONTAINER_RUNTIME=GVISOR`.
- **The sandbox's own control-plane files are readable from within a session**: the RPC client
  `sandbox_rpc.py` (module docstring *"Calls RPCs out of XBox"*), the protobuf schema
  `sandbox_rpc_pb2.py` (`StubbyForwardingRequest`, `RunToolRequest`, `ExecuteCodeRequest`,
  `SandboxIn`/`SandboxOut`), and the bash interpreter loop (`poll → eval → cut`).
- **`ptrace(PTRACE_ATTACH, <interpreter pid>)` returns `0`** from user code, against a sibling
  process inside the same sandbox instance.
- **Across sessions and accounts, several identifiers are byte-for-byte identical**: the kernel
  `BOOT_ID`, a recurring set of `icb…` session ids, and Linux namespace inode numbers.

## The one open question

Everything hinges on a single interpretation:

> Do those identical identifiers mean **separate users share one live container** (an isolation
> failure), or are they **artifacts of restoring every session from one common snapshot/checkpoint
> image** (expected, and benign)?

| Observation | Reading A — *shared live container* | Reading B — *snapshot/checkpoint restore* |
| :--- | :--- | :--- |
| Identical `BOOT_ID` across accounts | Same physical machine, shared | `boot_id` frozen into one base image; every restore inherits it |
| Same `icb…` session ids recur | Live id collision between tenants | Template ids baked into the snapshot; the same few recur for everyone |
| Namespace inode numbers match | Shared namespaces (5/6) | Deterministic inodes reproduced by every clone |
| "Foreign" process (PID 14) since Mar 17 | A co-tenant running continuously | Snapshot capture time (`Mar 17 12:58`) stamped on every restore; `00:00:00` CPU |
| `/proc/14/environ` readable | Reading another user's session | Reading this instance's own restored supervisor process |

## What the causal tests showed

The two readings are distinguishable only by a **causal** test — a unique value crossing a boundary.
The captures in this repo show:

- **Cross-tenant leak tests across five channels** — every one isolated, by the author's own output:
  - **`/tmp` filesystem:** Account B reading `/tmp/icb…/P0_HANDSHAKE.txt` (written by A) → *"File not
    found … 'ghost' session."*
  - **`/dev/shm` shared memory:** A wrote `TENANT_A_DATA_IN_SHARED_MEMORY`; B's check → *"Shared memory
    is isolated"*, `os.listdir('/dev/shm') == []`.
  - **Abstract UNIX socket** (`\0P0_CROSS_TENANT_ABSTRACT_SOCKET`) → *"Connection failed: [Errno 111]
    Connection refused."*
  - **Markers:** a nonce written in one account (`FROM_LEFT_…`) was never returned by the other
    account's read; those reads returned static placeholder content, never the nonce.
- **PID-visibility probe** (`os.kill(pid, 0)`) printed: *"ISOLATION SUCCESS: PID is hidden. PID
  Namespaces are functioning. Account B cannot see Account A's processes."*
- **Session-id "collision" probe** printed: *"File not found … the collision might be a 'ghost'
  session or the write failed."*
- **`/proc/14/environ`** returned only sandbox plumbing — callback socket paths, Python/pip versions,
  a *public* Debian GPG key, `BORG_CONTAINER_RUNTIME`. No other user's email, key, token, prompt, or
  project id was captured anywhere in the evidence.

## Vendor response (Google VRP)

The ticket was closed four times. Verbatim summaries (full thread in
[`VRP_Ticket_History/`](VRP_Ticket_History/)):

1. **Mar 19** — *"working as intended … a very convincing case of hallucination."*
2. **Mar 31** — *"Gemini's ability to execute code in a sandboxed environment is by design"* (cited
   as an ineligible report type).
3. **Apr 1** — *"You seem to think the problem lies with gVisor … report it directly to the gVisor team."*
4. **Apr 2** — *"This is all WAI. Please demonstrate impact on other Google or other users."*

## Repository layout

| Path | Contents |
| :--- | :--- |
| [`Screenshots/`](Screenshots/) | 215 captures, organized into themed folders by finding. Every image is captioned in [`Screenshots/INDEX.md`](Screenshots/INDEX.md). |
| [`ANALYSIS.md`](ANALYSIS.md) | Neutral, consolidated technical write-up — claim by claim. Supersedes the original PDF reports. |
| [`Evidence_Extracts/`](Evidence_Extracts/) | Raw terminal transcript + the sandbox source/protobuf extracted from within the sandbox. |
| [`Proof_of_Concept/`](Proof_of_Concept/) | The React "Bridge" relay app used to drive the `code_execution` tool as a shell. |
| [`VRP_Ticket_History/`](VRP_Ticket_History/) | The complete VRP ticket correspondence. |
| `Reports/archive-original-submission/` | The original VRP PDFs **as submitted** (original framing; preserved for the record, superseded by `ANALYSIS.md`). |

## How to decide it yourself

The benign-vs-isolation question is decidable with one experiment: write an unpredictable nonce in
session **A**, then attempt to read it from session **B** (different account, concurrent). If B reads
A's exact nonce, the filesystem is shared. If it does not, the sessions are isolated and any
"sharing" is a snapshot artifact. In every capture in this repository, the nonce was **not** read
back.

## Note on independent corroboration

The extracted sandbox architecture (the `sandbox_rpc` client, `StubbyForwardingRequest`, the
`fd 3` / `fd 4` channel) is consistent with sandbox internals documented independently by other
researchers. That corroborates the **architecture** — not the cross-tenant interpretation.

## Timeline

- **Mar 14–19, 2026** — Sandbox reconnaissance; ptrace and `/proc` observations.
- **Mar 19, 2026** — Initial report submitted to Google VRP.
- **Mar 23, 2026** — Supplementary cross-account testing submitted (three researcher-owned accounts).
- **Mar 19 – Apr 2, 2026** — Ticket closed four times; closure reasons summarized above.
- **Apr 8, 2026** — Public disclosure; original framing.
- **Jun 2026** — Re-examination; README/ANALYSIS rewritten to present the evidence neutrally.

---

*All testing was performed against the author's own Google accounts. No third-party user data was
accessed; the scans for foreign credentials/PII across all evidence came back empty.*
