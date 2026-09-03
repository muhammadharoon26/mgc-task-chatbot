# Build Task — AI Developer & Engineer
### MGC Developments · Islamabad

A short, practical build in four parts. We'd rather see something rough that runs
than something polished that doesn't.

**Time:** about 1 hour. If you hit the hour, stop and submit what you have.
**Deadline:** Thursday 3 September, 12:00 PM (noon) Pakistan time. The form closes then.
**Stack:** entirely your choice. Use whatever you're fastest in.
**AI tools:** allowed and expected — see ground rules.

---

## The situation

MGC sells apartments. Two things currently eat our sales team's day:

1. Staff answer the same questions about price, payment plans and booking policy over
   and over, usually by flipping through PDFs. They get it wrong often enough to matter.
2. We get far more leads than the team can call, and nobody knows which to call first.

The four parts below are all slices of that one problem.

---

## Part 1 — AI Development (~20 min)

In `docs/` there are three real MGC documents: a project brochure, a price list with
payment plans, and a booking policy FAQ.

Build something a salesperson can ask questions of, in plain language, and get an
answer **grounded in those documents with the source shown**. A script, a notebook,
a small pipeline — the form doesn't matter. The behaviour does.

It must handle these correctly:

| Question | Why it's here |
|---|---|
| "What's the base price of a 2-bed in Block B?" | Straight lookup |
| "What's the total for a Margalla-facing corner unit on floor 15, 2-bed Block B?" | Needs base price + stacked premiums |
| "What's the transfer fee?" | **The two documents disagree. Handle it.** |
| "What's the rental yield on a 1-bed?" | Not in the documents. Don't invent one. |
| "Who is the anchor tenant?" | Explicitly unconfirmed. Say so. |

The last three matter more than the first two. A confident wrong answer to a customer
costs us a sale; "I don't have that, ask the marketing manager" costs us nothing.

## Part 2 — Database (~10 min)

`leads.csv` has ~9,000 historical leads. Treat it as the dump of a messy CRM.

- Design a **minimal SQL schema** you'd store this in properly (one table is fine if
  you can defend it; split things out if you think you should). Put it in `schema.sql`.
- Write **two queries** (any SQL dialect, runnable or clearly written in `queries.sql`):
  1. Conversion rate by lead source, best first, only for sources with 200+ leads.
  2. A query that finds the **duplicate leads** in the data (hint: same lead entered
     twice by different agents) — and say in a comment how you'd prevent that at the
     schema level.

## Part 3 — ML (~15 min)

Using the same `leads.csv`, with the outcome column `converted`:

- Decide what you'd **clean, drop or fix** — write those decisions down. A few
  bullets in your README is enough. Part of the test is noticing **which columns you
  should and shouldn't use**.
- Train a **quick baseline model** that scores likelihood to convert. No tuning
  needed — a notebook or script is fine.
- Report **one metric** and say why you chose it. The class balance should inform
  that choice.

## Part 4 — Web Development (~15 min)

A minimal web interface that ties it together: one page where a salesperson can

- ask the document assistant a question and see the answer with its source, **or**
- enter a lead's details and see its score — either one is enough; both is a bonus.

Bare HTML served by anything (Flask, FastAPI, Express, Streamlit — your call) is
fine. **No styling points.** It should run on our machine from your README.

---

## What we look at

- **Does it run** from your README
- **Part 1's hard cases** — grounding, refusal, the conflict
- **Part 2's schema sense** — keys, types, and the duplicate logic
- **Part 3's decisions** — what you dropped and why, and an honest number
- **Part 4 working at all** — wiring, not looks
- **Code you can explain** — structure, not style

What we're **not** looking at: visual design, test coverage, deployment, auth.
Don't spend your hour there.

---

## Ground rules

Use AI tools. Claude, Copilot, ChatGPT — whatever you normally use. We do too, and
pretending otherwise would tell us nothing about how you actually work.

The one thing that matters: **you must be able to explain every line you submit.**
Shortlisted candidates get a 30-minute call where we open your repo and ask why you
did things. That's the real interview. Code you can't explain is worse than code you
didn't write.

If you run out of time, submit what you have and write down what you'd do next.
That's a completely acceptable submission and we've hired on them before. Finishing
two parts well beats rushing four.

---

## Submitting

Push to a **public GitHub repo** and submit the link at the page in your invitation
before **Thursday 3 September, 12:00 PM PKT** — the form closes automatically.

Your README should cover:
- How to run it
- Your Part 3 data decisions and your metric
- Anything broken or half-finished — tell us, don't hide it

A 1–2 minute screen recording of it working helps (Loom or unlisted YouTube).

Questions about the task itself: **0308-77 77 275**. Asking a clarifying question is
not a mark against you.

*MGC Developments · Head Office, Near Al-Jannat Mall, GT Road, Islamabad*
