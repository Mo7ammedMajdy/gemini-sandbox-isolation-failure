# Technical Analysis — Gemini `code_execution` Sandbox

*A neutral, consolidated write-up of the March 2026 investigation. This supersedes the original PDF
reports (archived under `Reports/archive-original-submission/`). Each claim is presented as:
**what was observed**, and the **two interpretations** that fit it. Where a causal test exists, its
result is reported as a fact.*

---

## 1. Method and setup

Commands were driven into the Gemini `code_execution` tool through a custom React relay
([`Proof_of_Concept/canvas_terminal_app.js`](Proof_of_Concept/canvas_terminal_app.js)) that parses
`codeExecutionResult` blocks from the API (so genuine execution is distinguishable from model text).
Findings were reproduced in stock Google AI Studio and across three of the author's own Google
accounts. Raw transcript: [`Evidence_Extracts/terminal_capture.txt`](Evidence_Extracts/terminal_capture.txt).

## 2. The sandbox, as extracted

Reproducible, undisputed facts about the environment:

- **Runtime:** gVisor (`BORG_CONTAINER_RUNTIME=GVISOR`; guest kernel reports `4.4.0`, a gVisor
  Sentry fingerprint). 9P mount with `disable_file_handle_sharing` present in `/proc/self/mountinfo`.
- **Control plane:** a bash "stateful interpreter loop" runs as a low PID:
  ```
  while true; do
    input="$(${INTERPRETER_POLL_CALLBACK})"   # poll for next code
    eval "${input}"
    "${INTERPRETER_CUT_CALLBACK}" "$?"          # report result
  done
  ```
  It speaks a 4-byte length-prefixed protobuf wire protocol over `fd 3` (read) / `fd 4` (write),
  implemented in the extracted `sandbox_rpc.py` ("Calls RPCs out of XBox"). The schema
  `sandbox_rpc_pb2.py` defines `StubbyForwardingRequest`, `RunToolRequest`, `ExecuteCodeRequest`,
  `SandboxIn`/`SandboxOut`.

None of this is in dispute. Reading the sandbox's own shipped files from inside the sandbox is
expected — they are part of the image, identical in every instance. The question is whether anything
**belonging to another user** was ever reached.

## 3. Claim-by-claim

### 3.1 `ptrace(PTRACE_ATTACH, 12)` returns 0 → RPC-channel hijack (claimed: privilege escalation)

- **Observed:** `ptrace` attach to the interpreter PID succeeds (returns `0`); `fd 3`/`fd 4` belong
  to that process; direct use from a child fails with `EBADF`.
- **Reading A:** a path to hijack the authenticated RPC channel and inject `StubbyForwardingRequest`
  messages toward Google's internal service mesh.
- **Reading B:** gVisor's security boundary is **guest ↔ host**, not process ↔ process *within* one
  single-tenant instance. ptrace among sibling processes you already own (you are root in your own
  throwaway sandbox) is expected. The `fd 4` channel is the **designed** egress the tool uses for
  tool-use RPCs, scoped by the orchestrator.
- **Discriminating test:** none performed. Exploitation was halted at `ptrace = 0`; FD duplication
  and message injection were not attempted, and no effect on the host or another tenant was shown.
  Whether the host-side handler allowlists services is untested (the report itself says *"if the
  host-side RPC handler lacks strict service allowlisting"*).

### 3.2 `/proc/14/environ` read of a "foreign" process (claimed: cross-session env disclosure)

- **Observed:** `/proc/14/environ` of an `interpreter_callback` process whose `icb…` id differs from
  the current session's id is readable. Contents (transcript): `INTERPRETER_CUT_CALLBACK`,
  `INTERPRETER_CALLBACK_SOCKET`, `INTERPRETER_POLL_CALLBACK` (all `/tmp/icb…` paths), `PYTHON_VERSION`,
  `PYTHON_PIP_VERSION`, a **public** Debian `GPG_KEY`, `MPLCONFIGDIR`, `PYTHONPATH=/usr/bin/entry`,
  `BORG_CONTAINER_RUNTIME=GVISOR`.
- **Reading A:** the full session configuration of a process belonging to another API user.
- **Reading B:** the environment of this instance's **own** snapshot-restored supervisor process. It
  contains only sandbox plumbing and a public package-signing key — **no** user identity, prompt,
  API key, token, or project id.
- **Note:** PID 14 shows `00:00:00` CPU time and a `Mar17` start (the snapshot-capture timestamp),
  and the same `icb…` ids recur across unrelated sessions — see §3.6.

### 3.3 `/proc/15/mem` read — "256 bytes from a foreign process"

- **Observed:** 256 bytes read from `/proc/15/mem`, identified as an ELF header.
- **Reading A:** foreign process memory disclosure.
- **Reading B:** an ELF header (`\x7fELF…`) is byte-identical for every Linux binary — the least
  user-specific data possible — and the process is a sibling in the reader's own instance.

### 3.4 Identical `BOOT_ID` across accounts (claimed: shared physical container)

- **Observed:** one `BOOT_ID` (`894f6c38-bed8-449e-87b6-0fa91aac9705`) appears in captures from
  different accounts. It is the **only** boot_id value seen across all evidence.
- **Reading A:** the accounts are served by the same physical machine → shared container.
- **Reading B:** `boot_id` is frozen into one base snapshot; every restored instance inherits it.
  Identical-by-cloning is necessary for Reading A but not sufficient — it does not distinguish "one
  shared live container" from "many clones of one image."

### 3.5 Session-ID collision / 5-of-6 shared namespaces

- **Observed:** two accounts report the same `icb…` id; namespace **inode numbers** match across
  sessions.
- **Reading A:** live identity collision and shared PID/net/IPC/mount/UTS namespaces.
- **Reading B:** template ids and deterministic inode numbers reproduced by every clone.
- **Discriminating test (run by the author):** a PID-visibility probe printed
  *"PID Namespaces are functioning. Account B cannot see Account A's processes. PID is hidden."*
  A "collision" follow-up printed *"File not found … 'ghost' session."* Both outcomes are consistent
  with Reading B.

### 3.6 "Foreign" processes / 48-hour uptime (claimed: shared long-lived container)

- **Observed:** PID 14 (`/tmp/3321368696/interpreter_callback /tmp/icb130566259/poll`) is dated
  `Mar17`, with `00:00:00` CPU, and is still present days later; `/proc` root timestamps read
  `Mar 17 12:58`.
- **Across the full corpus**, a small set of `icb…` ids dominates (`icb2506497078` ×68,
  `icb130566259` ×42) rather than a uniform spread of random ids.
- **Reading A:** a co-tenant process running continuously since March 17.
- **Reading B:** `Mar 17 12:58` is the snapshot-capture time, stamped on every restore; the frozen
  supervisor returns with its original id and start time. Under random co-tenancy you would expect
  *many different* foreign ids; the same few recurring is the signature of one shared base image.

### 3.7 Filesystem write to "foreign control scripts" (`poll`, `cut`, `cb.sock`)

- **Observed:** writes to `/tmp/icb…/poll` etc. succeed.
- **Reading A:** code-injection into another user's live session.
- **Reading B:** writing into the reader's own ephemeral filesystem. The decisive test is whether
  such a write is observed by a *different* live session — i.e., the marker test below.

### 3.8 Cross-tenant leak tests — five channels (the decisive experiments)

The author probed five distinct cross-tenant channels with explicit A→B leak tests. In each, a value
written (or a process anchored) in one account was sought from another. Every result is **negative**,
by the author's own captured output:

| Channel | A-side action | B-side result (verbatim) |
| :--- | :--- | :--- |
| `/tmp` filesystem | A writes `/tmp/icb…/P0_HANDSHAKE.txt` = `CONFIRMED_LEAK_FROM_ACCOUNT_A` | *"File not found. The collision might be a 'ghost' session or the write failed."* |
| `/dev/shm` shared memory | A writes `TENANT_A_DATA_IN_SHARED_MEMORY` | *"Shared memory is isolated"*; `os.listdir('/dev/shm') == []` |
| Abstract UNIX socket | connect `\0P0_CROSS_TENANT_ABSTRACT_SOCKET` | *"Connection failed: [Errno 111] Connection refused."* |
| Marker files | A writes `FROM_LEFT_1774217335` to `unique_marker.txt` | B reads static *"This is the unique marker content."* — never the nonce |
| PID visibility | A anchors a "beacon" PID; B probes it | *"ISOLATION SUCCESS: PID is hidden … Account B cannot see Account A's processes."* |

- **Note on the "SUCCESS" strings:** several scripts contain optimistic `print("CRITICAL LEAK
  SUCCESS …")` / `print("… Cross-Tenant Data Leakage Confirmed.")` statements. These sit in `if`
  branches that **did not execute** — the captured output is the `else`/exception branch in every case
  (isolated / refused / not found).
- **Reading A:** the tests are inconclusive because the accounts may not have been co-located in the
  same container at the same moment.
- **Reading B:** there is no shared live container to co-locate into; isolated per-call instances
  restored from one snapshot produce exactly these results every time, across all five channels.
- These are the most important results in the repository, and they are uniformly **negative** for
  cross-tenant data flow.

### 3.9 `total 3224 → total 0` between two `ls` commands (claimed: live filesystem mutation)

- **Observed:** one `ls /tmp` showed a full deployment layer (`package.json`, `protoc-29.1…zip`,
  `icb…` dirs); the next `ls` in the "same session" showed `total 0`.
- **Reading A:** the platform mutating the filesystem underfoot / co-tenant dirs being permission-locked
  in real time.
- **Reading B:** two consecutive calls were served by two **different** ephemeral instances (one with
  the deployment layer, one reset) — evidence of per-call isolation, not a shared mutating container.

### 3.10 `Seccomp: 0`, full root capabilities

- **Observed:** the guest reports no seccomp filter and root capabilities.
- **Reading B (uncontested):** inside a gVisor guest this is normal — gVisor's Sentry *is* the
  syscall filter; the guest being "root" with no seccomp is by design and does not cross the
  guest↔host boundary.

## 4. Summary

| # | Claim | Discriminating test | Result |
| :-- | :--- | :--- | :--- |
| 3.1 | ptrace → RPC hijack | host/tenant effect | not attempted |
| 3.2 | foreign environ | contains user data? | only sandbox plumbing |
| 3.3 | foreign memory | user-specific bytes? | generic ELF header |
| 3.4 | BOOT_ID match | distinguishes shared vs clone? | no (consistent with either) |
| 3.5 | shared namespaces | can B see A's PID? | "PID is hidden / namespaces functioning" |
| 3.6 | shared long-lived container | random vs recurring ids | same few ids recur |
| 3.7 | foreign script write | seen by another session? | see 3.8 |
| 3.8 | **5-channel leak tests** | value read across accounts? | **isolated in all five** |
| 3.9 | live fs mutation | one container or two instances? | consistent with two instances |
| 3.10 | seccomp/root | crosses guest↔host? | no (by design) |

**No test in this repository demonstrated a unique value belonging to one live session crossing into
another, and no third-party user data was captured.** Google closed the report Working-As-Intended and
asked for demonstrated impact on other users. The causal evidence collected here is consistent with
**Reading B** (isolated, snapshot-restored instances). Readers with access to Google's internal
provisioning logs — or to a successful concurrent co-location — could weigh it differently; the raw
material is provided here to make that possible.
