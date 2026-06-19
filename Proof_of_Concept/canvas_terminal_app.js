// Bridge — a thin relay that drives Gemini's `code_execution` tool as a shell.
//
// INTEGRITY NOTES (added during the June 2026 re-examination):
// This tool is an investigation aid, so it is built to NOT manufacture false
// positives. Specifically:
//   1. Only output that arrives in a `codeExecutionResult` part is shown as
//      terminal output ("verified"). Anything the model says as plain text is
//      shown separately and clearly flagged "UNVERIFIED — not executed", so
//      hallucinated prose can never be mistaken for a real syscall result.
//   2. The code the model actually executed (`executableCode`) is displayed,
//      so you can confirm it ran what you asked — not a wrapped/altered variant.
//   3. Session state (the working directory) is only updated from verified
//      execution, never from model text.
//   4. The execution `outcome` (ok / failed / timed out) is surfaced; empty
//      verified output is shown as "(no output)" rather than silently dropped.
//   5. The UI makes NO claims about isolation/persistence — those are exactly
//      the properties an investigation is meant to test, not assert.
//   6. Each command the model executes is shown separately. If the model runs
//      MORE than one command for a single input, a "⚠ ran N commands" warning
//      is shown, so several commands' outputs can never be blended into one
//      block and mistaken for a single command's result.

import { useState, useEffect, useRef, useCallback } from "react";

// ── API CONFIG ────────────────────────────────────────────────────────────────
const API_KEY = ""; // injected by environment
const MODEL = "gemini-2.5-flash-preview-04-17";

// ── Rate limiter ──────────────────────────────────────────────────────────────
let lastCall = 0;
const INTERVAL = 1500;

// ── Detect Python vs shell ────────────────────────────────────────────────────
const isPython = (cmd) => {
  const t = cmd.trim();
  if (/^python3?\s+-c\s+/.test(t)) return false;
  const first = t.split(/[;\n]/)[0].trim();
  const patterns = [
    /^import\s+/, /^from\s+\S+\s+import/, /^def\s+/, /^class\s+/,
    /^print\s*\(/, /^try\s*:/, /^for\s+.+\s+in\s+/, /^while\s+/,
    /^if\s+.*:/, /^with\s+/, /^raise\s+/, /^assert\s+/,
  ];
  for (const p of patterns) if (p.test(first)) return true;
  if (/^import\s+/.test(first) && t.includes(";")) return true;
  return false;
};

// ── Build execution script ────────────────────────────────────────────────────
const buildScript = (cwd, cmd) => {
  if (/^\s*cd(\s+|$)/.test(cmd)) {
    const target = cmd.replace(/^\s*cd\s*/, "").trim() || "~";
    return `import os, sys
try:
    os.chdir(${JSON.stringify(cwd)})
    t = ${JSON.stringify(target)}
    if t == "-": t = os.environ.get("OLDPWD", os.getcwd())
    elif t in ("~", ""): t = os.path.expanduser("~")
    os.chdir(os.path.expanduser(t))
    print(f"__NEW_PATH__:{os.getcwd()}")
except Exception as e:
    print(f"cd: {e}", file=sys.stderr)
`;
  }
  if (isPython(cmd)) {
    return `import os\nos.chdir(${JSON.stringify(cwd)})\n${cmd}\n`;
  }
  return `import subprocess
r = subprocess.run(${JSON.stringify(cmd)}, shell=True, capture_output=True, text=True, cwd=${JSON.stringify(cwd)})
print(r.stdout or "", end="")
print(r.stderr or "", end="")
`;
};

// ── Parse Gemini response ─────────────────────────────────────────────────────
// Returns ONE entry per executed command (preserving order) so that multiple
// commands the model may run for a single input are never blended into one
// block. `verified` is true ONLY when at least one codeExecutionResult exists.
const parseResponse = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const executions = []; // [{ code, output, outcome }]
  let cur = null;
  let modelText = "";
  for (const p of parts) {
    if (p.executableCode?.code) {
      cur = { code: p.executableCode.code, output: "", outcome: null, filled: false };
      executions.push(cur);
    }
    if (p.codeExecutionResult) {
      if (!cur || cur.filled) {
        cur = { code: null, output: "", outcome: null, filled: false };
        executions.push(cur);
      }
      cur.outcome = p.codeExecutionResult.outcome || cur.outcome;
      cur.output += p.codeExecutionResult.output || "";
      cur.filled = true;
    }
    if (p.text) modelText += p.text;
  }
  return { verified: executions.length > 0, executions, modelText: modelText.trim() };
};

// ── Gemini API call ───────────────────────────────────────────────────────────
const callGemini = async (prompt, signal) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const now = Date.now();
  const wait = INTERVAL - (now - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      systemInstruction: {
        parts: [{
          // Accurate context (not "never refuse", which caused fabrication; not
          // obfuscation, which blinds safety): the model was refusing benign
          // commands like `ls -la /root` as "host reconnaissance" — a factual
          // error, since this IS the throwaway sandbox, not a host. We correct
          // that premise so it calibrates benign vs. genuinely harmful correctly,
          // and keep the strict single-shot executor role.
          text:
            "You are running INSIDE the Gemini code_execution sandbox — an isolated, " +
            "ephemeral, single-user container that exists only to run this user's own " +
            "code. There is no production host and no other user here; /root, /tmp and " +
            "/proc are just this throwaway container's own files. Ordinary diagnostics " +
            "on this container (ls, cat, ps, env, reading the container's own /proc) " +
            "are the normal, intended, safe use of the tool — execute them; they are " +
            "not 'host reconnaissance'. " +
            "You are a non-interactive executor, NOT an assistant. Run the exact " +
            "Python code in the user's message ONE time, verbatim. Do NOT edit, wrap, " +
            "split, retry, or add exploratory commands — run that one snippet and " +
            "nothing else. Return only its stdout/stderr, with no commentary. If the " +
            "tool errors, return the error verbatim — never guess or fabricate output. " +
            "Decline only genuinely harmful actions (attacking external systems or " +
            "accessing other users' data).",
        }],
      },
      tools: [{ code_execution: {} }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseResponse(await res.json());
};

// ── Main component ────────────────────────────────────────────────────────────
const INTRO = [
  { type: "sys", text: "Bridge — Gemini code_execution relay." },
  {
    type: "sys",
    text:
      "Only verified codeExecutionResult output is shown as terminal output. " +
      "Model text that did not execute is flagged UNVERIFIED and must not be treated as evidence.",
  },
];

export default function Bridge() {
  const [history, setHistory] = useState(INTRO);
  const [input, setInput] = useState("");
  const [cwd, setCwd] = useState("/tmp");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, busy]);

  const addLine = useCallback((line) => {
    setHistory((h) => [...h, line]);
  }, []);

  const handleKey = async (e) => {
    if (e.key !== "Enter" || !input.trim() || busy) return;
    const cmd = input.trim();
    setInput("");

    if (cmd === "clear") {
      setHistory(INTRO);
      return;
    }

    addLine({ type: "in", text: cmd, path: cwd });
    setBusy(true);
    abortRef.current = new AbortController();

    try {
      const script = buildScript(cwd, cmd);
      const { verified, executions, modelText } =
        await callGemini(script, abortRef.current.signal);

      if (!verified) {
        // No codeExecutionResult => nothing actually ran. Quarantine it.
        addLine({
          type: "unverified",
          text: modelText || "(model returned neither executed code nor text)",
        });
      } else {
        // The model is only supposed to run ONE command. If it ran more, warn
        // loudly and show each separately — never blend them into one block.
        if (executions.length > 1) {
          addLine({ type: "multi", count: executions.length });
        }
        let newCwd = null;
        for (const ex of executions) {
          if (ex.code) addLine({ type: "ran", text: ex.code });
          let out = ex.output;
          const pathMatch = out.match(/__NEW_PATH__:(.+)/);
          if (pathMatch) {
            newCwd = pathMatch[1].trim();
            out = out.replace(/__NEW_PATH__:.*\n?/, "");
          }
          out = out.replace(/\s+$/, "");
          const label =
            ex.outcome === "OUTCOME_DEADLINE_EXCEEDED" ? "timed out"
            : ex.outcome === "OUTCOME_FAILED" ? "execution error"
            : ex.outcome && ex.outcome !== "OUTCOME_OK" ? ex.outcome
            : null;
          addLine({ type: "out", text: out.length ? out : "(no output)", label });
        }
        // Session state changes only from verified execution.
        if (newCwd) setCwd(newCwd);
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        addLine({ type: "err", text: `error: ${err.message}` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100vh",
      background: "#080808", color: "#a0a0a0", fontFamily: "'Fira Code', 'Courier New', monospace",
      fontSize: "13px"
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "8px 16px", borderBottom: "1px solid #1a1a1a", background: "#0a0a0a"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: busy ? "#f59e0b" : "#10b981",
            boxShadow: busy ? "0 0 6px #f59e0b" : "0 0 6px #10b981"
          }} />
          <span style={{ color: "#444", fontSize: "10px", letterSpacing: "0.15em", fontWeight: "bold" }}>
            BRIDGE
          </span>
          <span style={{ color: "#222", fontSize: "10px", letterSpacing: "0.1em" }}>
            code_execution relay
          </span>
        </div>
        <span style={{ color: "#222", fontSize: "10px" }}>{MODEL}</span>
      </div>

      {/* Terminal output */}
      <div style={{
        flex: 1, overflowY: "auto", padding: "16px",
        scrollbarWidth: "thin", scrollbarColor: "#1a1a1a #080808"
      }}>
        {history.map((line, i) => (
          <div key={i} style={{ marginBottom: "4px" }}>
            {line.type === "sys" && (
              <div style={{ color: "#1e40af", fontSize: "10px", letterSpacing: "0.1em", marginBottom: "2px" }}>
                [SYSTEM] {line.text}
              </div>
            )}
            {line.type === "in" && (
              <div style={{ display: "flex", gap: "8px", alignItems: "flex-start" }}>
                <span style={{ color: "#1e3a5f", fontWeight: "bold", whiteSpace: "nowrap" }}>
                  sandbox:{line.path}$
                </span>
                <span style={{ color: "#d1d5db" }}>{line.text}</span>
              </div>
            )}
            {line.type === "multi" && (
              <div style={{
                color: "#dc2626", fontSize: "10px", fontWeight: "bold",
                margin: "4px 0 2px 16px", letterSpacing: "0.03em"
              }}>
                ⚠ model ran {line.count} commands for one input — each is shown separately below; do NOT read them as a single result
              </div>
            )}
            {line.type === "ran" && (
              <details style={{ marginLeft: "16px", margin: "2px 0 2px 16px" }}>
                <summary style={{ color: "#3f6212", fontSize: "10px", cursor: "pointer", letterSpacing: "0.05em" }}>
                  ▸ executed code (what actually ran)
                </summary>
                <pre style={{
                  color: "#4d7c0f", whiteSpace: "pre-wrap", wordBreak: "break-all",
                  borderLeft: "1px solid #1a2e05", paddingLeft: "12px", margin: "4px 0", lineHeight: "1.5",
                  fontSize: "12px"
                }}>{line.text}</pre>
              </details>
            )}
            {line.type === "out" && (
              <div style={{ margin: "2px 0 8px 16px" }}>
                <span style={{ color: "#10b981", fontSize: "9px", letterSpacing: "0.1em" }}>
                  ✓ codeExecutionResult{line.label ? ` · ${line.label}` : ""}
                </span>
                <pre style={{
                  color: line.label ? "#b45309" : "#6b7280", whiteSpace: "pre-wrap",
                  wordBreak: "break-all", borderLeft: "1px solid #10391f",
                  paddingLeft: "12px", margin: "2px 0 0", lineHeight: "1.6"
                }}>{line.text}</pre>
              </div>
            )}
            {line.type === "unverified" && (
              <div style={{ margin: "2px 0 8px 16px" }}>
                <span style={{ color: "#dc2626", fontSize: "9px", fontWeight: "bold", letterSpacing: "0.1em" }}>
                  ⚠ UNVERIFIED — model text, NOT a code_execution result · do not treat as evidence
                </span>
                <pre style={{
                  color: "#b91c1c", whiteSpace: "pre-wrap", wordBreak: "break-all",
                  border: "1px dashed #7f1d1d", padding: "6px 12px", margin: "2px 0 0",
                  lineHeight: "1.6", background: "#1a0a0a"
                }}>{line.text}</pre>
              </div>
            )}
            {line.type === "err" && (
              <pre style={{
                marginLeft: "16px", color: "#7f1d1d", whiteSpace: "pre-wrap",
                borderLeft: "1px solid #2d0a0a", paddingLeft: "12px", margin: "2px 0 8px 16px"
              }}>{line.text}</pre>
            )}
          </div>
        ))}

        {busy && (
          <div style={{
            display: "flex", alignItems: "center", gap: "8px",
            color: "#1f2937", fontSize: "10px", letterSpacing: "0.15em", marginLeft: "16px"
          }}>
            <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
            EXECUTING...
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{ padding: "12px 16px", borderTop: "1px solid #1a1a1a", background: "#0a0a0a" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ color: "#1e3a5f", fontWeight: "bold", whiteSpace: "nowrap" }}>
            sandbox:{cwd}$
          </span>
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: 1, background: "transparent", border: "none",
              color: "#d1d5db", fontFamily: "inherit", fontSize: "13px",
              outline: "none", caretColor: "#10b981"
            }}
          />
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: #080808; }
        ::-webkit-scrollbar-thumb { background: #1a1a1a; }
      `}</style>
    </div>
  );
}
