# Cross-Tenant Container Isolation Failure in Google Gemini code_execution API

**Disclosure Date:** April 3, 2026
**Target:** Google Gemini API — `code_execution` tool
**Status:** Unpatched / Closed by Vendor

## Executive Summary
This repository contains a 42-page technical report and supplementary evidence documenting a multi-tenant isolation failure within the Google Gemini `code_execution` sandbox environment. 

The Gemini `code_execution` environment runs Python in a gVisor container on Borg. Testing across multiple independently authenticated Google accounts confirmed that separate user sessions share the same PID namespace and filesystem with no isolation boundary between tenants. An authenticated API user can read process memory, environment variables, and session control scripts belonging to other independent API users.

## Verified Impact
The impact on other users was verified using independently authenticated Google accounts. The following data was successfully extracted from foreign sessions:

| Impact | Evidence |
| :--- | :--- |
| **Read of foreign user session environment** | `/proc/14/environ` extracted in full — returns `INTERPRETER_CALLBACK_SOCKET`, `INTERPRETER_POLL_CALLBACK`, `INTERPRETER_CUT_CALLBACK` of a process belonging to a different API user. |
| **Read of foreign user process memory** | `/proc/15/mem` read returning 256 bytes — ELF header confirmed from a process I do not own. |
| **Write to foreign user session control scripts** | Confirmed write to `poll`, `cut`, `cb.sock` in a foreign session directory — direct code injection path into another user’s active session. |
| **Shared physical container across accounts** | Identical kernel `BOOT_ID` confirmed across two independently authenticated Google accounts. |
| **Session identity collision across accounts** | Two different Google accounts assigned the same session ID simultaneously. |

## Independent Architecture Corroboration
The internal RPC infrastructure extracted and documented in this report (`sandbox_rpc.py`, `StubbyForwardingRequest`, communication via `fd 3` and `fd 4`) matches the sandbox architecture independently confirmed via binary extraction by researchers Lupin & Holmes (MVH, Google bugSWAT) in March 2025. 

## Documentation
* [Full Vulnerability Report (PDF)](Reports/VRP_Report_FINAL_v2.pdf)
* [Supplementary Evidence: Cross-Account Verification (PDF)](Reports/VRP_Supplementary_Evidence_FINAL.pdf)
* [Extracted RPC Client Source Code](Evidence_Extracts/)
* [Proof of Concept Terminal Application](Proof_of_Concept/)
* [VRP Ticket Correspondence History (HTML)](VRP_Ticket_History/)

## Disclosure Timeline
* **March 14-19, 2026:** Discovery of cross-session isolation failure.
* **March 19, 2026:** Initial report submitted to Google VRP.
* **March 23, 2026:** Supplementary evidence (cross-account verification) submitted.
* **March 19 - April 2, 2026:** Ticket closed multiple times by triage without technical engagement on the cross-tenant isolation evidence.
* **April 3, 2026:** Public disclosure executed as per filed timeline.
