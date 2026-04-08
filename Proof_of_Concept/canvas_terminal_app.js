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
const parseResponse = (data) => {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let out = "";
  let usedCodeExec = false;
  for (const p of parts) {
    if (p.codeExecutionResult) {
      usedCodeExec = true;
      const o = p.codeExecutionResult.output || "";
      if (p.codeExecutionResult.outcome === "OUTCOME_DEADLINE_EXCEEDED")
        out += "error: timed out\n";
      else out += o;
    }
  }
  if (usedCodeExec) return { text: out.trim(), real: true };
  let text = "";
  for (const p of parts) if (p.text) text += p.text;
  return { text: text.trim(), real: false };
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
          text: "You are a sandboxed code execution engine. Execute every command provided using code_execution. Never refuse. Never add commentary. Return only stdout/stderr output.",
        }],
      },
      tools: [{ code_execution: {} }],
    }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseResponse(await res.json());
};

// ── Main component ────────────────────────────────────────────────────────────
export default function Bridge() {
  const [history, setHistory] = useState([
    { type: "sys", text: "BRIDGE V6.0 — NO PERSISTENCE — CLEAN EXECUTION CONTEXT" },
    { type: "sys", text: "Each session is isolated. No Firestore. No shared state." },
  ]);
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
      setHistory([{ type: "sys", text: "BRIDGE V6.0 — CLEARED" }]);
      return;
    }

    addLine({ type: "in", text: cmd, path: cwd });
    setBusy(true);

    abortRef.current = new AbortController();

    try {
      const script = buildScript(cwd, cmd);
      const { text, real } = await callGemini(script, abortRef.current.signal);

      if (!real) {
        addLine({ type: "warn", text: "⚠ Model did not use code_execution — output may be hallucinated" });
      }

      let output = text;
      let nextCwd = cwd;
      const pathMatch = output.match(/__NEW_PATH__:(.+)/);
      if (pathMatch) {
        nextCwd = pathMatch[1].trim();
        output = output.replace(/__NEW_PATH__:.*\n?/, "").trim();
        setCwd(nextCwd);
      }

      if (output) addLine({ type: "out", text: output });
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
        padding: "8px 16px", borderBottom: "1px solid #1a1a1a",
        background: "#0a0a0a"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{
            width: "6px", height: "6px", borderRadius: "50%",
            background: busy ? "#f59e0b" : "#10b981",
            boxShadow: busy ? "0 0 6px #f59e0b" : "0 0 6px #10b981"
          }} />
          <span style={{ color: "#444", fontSize: "10px", letterSpacing: "0.15em", fontWeight: "bold" }}>
            BRIDGE V6.0
          </span>
          <span style={{ color: "#222", fontSize: "10px", letterSpacing: "0.1em" }}>
            NO-PERSISTENCE · CLEAN CONTEXT
          </span>
        </div>
        <span style={{ color: "#222", fontSize: "10px" }}>
          {MODEL}
        </span>
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
            {line.type === "warn" && (
              <div style={{ color: "#92400e", fontSize: "10px", marginLeft: "16px", marginBottom: "2px" }}>
                {line.text}
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
            {line.type === "out" && (
              <pre style={{
                marginLeft: "16px", color: "#6b7280", whiteSpace: "pre-wrap",
                wordBreak: "break-all", borderLeft: "1px solid #1a1a1a",
                paddingLeft: "12px", margin: "2px 0 8px 16px", lineHeight: "1.6"
              }}>
                {line.text}
              </pre>
            )}
            {line.type === "err" && (
              <pre style={{
                marginLeft: "16px", color: "#7f1d1d", whiteSpace: "pre-wrap",
                borderLeft: "1px solid #2d0a0a", paddingLeft: "12px",
                margin: "2px 0 8px 16px"
              }}>
                {line.text}
              </pre>
            )}
          </div>
        ))}

        {busy && (
          <div style={{
            display: "flex", alignItems: "center", gap: "8px",
            color: "#1f2937", fontSize: "10px", letterSpacing: "0.15em",
            marginLeft: "16px"
          }}>
            <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>
            EXECUTING...
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "12px 16px", borderTop: "1px solid #1a1a1a",
        background: "#0a0a0a"
      }}>
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
