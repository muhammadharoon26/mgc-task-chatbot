"use client";

import { useEffect, useRef, useState } from "react";
import type { Answer, AnswerStatus, ChatTurn } from "@/lib/types";

const STORAGE_KEY = "mgc-copilot-thread-v1";

/** The five cases the brief grades. One click each, so no hard case gets missed. */
const STARTERS = [
  "What's the base price of a 2-bed in Block B?",
  "What's the total for a Margalla-facing corner unit on floor 15, 2-bed Block B?",
  "What's the transfer fee?",
  "What's the rental yield on a 1-bed?",
  "Who is the anchor tenant?",
];

const STATUS_LABEL: Record<AnswerStatus, string> = {
  answered: "answered",
  conflict: "sources disagree",
  unconfirmed: "not confirmed",
  policy_refusal: "policy — cannot answer",
  not_in_documents: "not in the documents",
};

type Message =
  | { kind: "user"; text: string }
  | { kind: "assistant"; answer: Answer; meta: Meta }
  | { kind: "error"; text: string };

type Meta = {
  strategy: string;
  keyLabel: string | null;
  model: string;
  offline: boolean;
  priceComputed: boolean;
  conflictsDetected: string[];
};

export default function Page() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string>("");
  const endRef = useRef<HTMLDivElement>(null);

  // Restore the thread across refreshes — a salesperson shouldn't lose context
  // to an accidental reload.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setMessages(JSON.parse(saved));
    } catch {
      /* corrupt or unavailable storage is not worth surfacing */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      /* quota or private mode — the thread still works in memory */
    }
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) =>
        setHealth(
          `${h.mode} · ${h.model} · retriever:${h.retriever} · ${h.corpus.sections} sections · keys:${h.keyPool.available}/${h.keyPool.keysConfigured}`,
        ),
      )
      .catch(() => setHealth("health check unavailable"));
  }, []);

  async function send(text: string) {
    const question = text.trim();
    if (!question || busy) return;

    // Only the plain transcript goes back to the server — the model does not
    // need its own metadata replayed.
    const history: ChatTurn[] = messages.flatMap<ChatTurn>((m) =>
      m.kind === "user"
        ? [{ role: "user", content: m.text }]
        : m.kind === "assistant"
          ? [{ role: "assistant", content: m.answer.answer }]
          : [],
    );

    setMessages((prev) => [...prev, { kind: "user", text: question }]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, history }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { kind: "error", text: data.message ?? "Request failed." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { kind: "assistant", answer: data, meta: data.meta },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { kind: "error", text: "Network error — is the dev server running?" },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shell">
      <header className="top">
        <h1>MGC Sales Copilot</h1>
        <span className="status-line">{health}</span>
      </header>

      <div className="chips">
        {STARTERS.map((s) => (
          <button
            key={s}
            className="chip"
            disabled={busy}
            onClick={() => send(s)}
          >
            {s}
          </button>
        ))}
        {messages.length > 0 && (
          <button
            className="chip"
            onClick={() => setMessages([])}
            disabled={busy}
          >
            ↺ New chat
          </button>
        )}
      </div>

      <div className="thread">
        {messages.length === 0 && (
          <div className="empty">
            Ask about pricing, payment plans, or booking policy. Every answer
            cites the document section it came from — or says plainly that it
            can&apos;t answer.
          </div>
        )}

        {messages.map((m, i) =>
          m.kind === "user" ? (
            <div className="msg user" key={i}>
              <div className="role">Salesperson</div>
              <div className="body">{m.text}</div>
            </div>
          ) : m.kind === "error" ? (
            <div className="msg error" key={i}>
              <div className="role">System</div>
              <div className="body">{m.text}</div>
            </div>
          ) : (
            <AssistantMessage key={i} answer={m.answer} meta={m.meta} />
          ),
        )}

        {busy && <div className="typing">Copilot is checking the documents…</div>}
        <div ref={endRef} />
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about price, payment plan, or booking policy…"
          disabled={busy}
        />
        <button className="send" type="submit" disabled={busy || !input.trim()}>
          Ask
        </button>
      </form>
    </div>
  );
}

function AssistantMessage({ answer, meta }: { answer: Answer; meta: Meta }) {
  // A computed price breakdown is a table — monospace keeps the columns aligned.
  const isTrace = answer.answer.includes("COMPUTED (deterministic");

  return (
    <div className={`msg assistant ${answer.status}`}>
      <div className="role">
        Copilot
        <span className="badge">{STATUS_LABEL[answer.status]}</span>
        {meta?.offline && <span className="badge">offline mode</span>}
        {meta?.keyLabel && <span className="badge">{meta.keyLabel}</span>}
      </div>

      <div className={`body${isTrace ? " pre" : ""}`}>{answer.answer}</div>

      {answer.escalateTo && (
        <div className="escalate">→ Escalate to the {answer.escalateTo}.</div>
      )}

      {answer.caveats.length > 0 && (
        <ul className="caveats">
          {answer.caveats.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}

      {answer.citations.length > 0 && (
        <details className="sources" open={answer.status === "conflict"}>
          <summary>
            {answer.citations.length} source
            {answer.citations.length === 1 ? "" : "s"}
          </summary>
          {answer.citations.map((c, i) => (
            <div className="source" key={i}>
              <div className="where">
                {c.documentTitle} › {c.heading}
              </div>
              <div className="quote">“{c.quote}”</div>
              <div className="sid">{c.sectionId}</div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
