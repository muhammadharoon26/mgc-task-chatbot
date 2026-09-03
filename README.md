# MGC Sales Copilot

A chat assistant that answers questions about MGC Aurora Heights from the three
project documents, and a model that scores how likely a lead is to convert.

Built with Next.js, TypeScript, Google Gemini and scikit-learn.

## Quick start (about 2 minutes)

You need Node.js 18 or newer. Nothing else. No database, no Docker, no Python.

**Step 1.** Install dependencies. Takes about a minute.

```bash
npm install
```

**Step 2.** Start the server. Ready in about 20 seconds.

```bash
npm run dev
```

**Step 3.** Open http://localhost:3000 and click any of the five example
questions on the page.

That is it. **You do not need an API key to see it work.** Without one, answers
are assembled straight from the documents instead of written by the model, and
all five example questions still answer correctly. The page shows an
`offline mode` badge so you know which path you are on.

### Optional: turn on Gemini (about 30 seconds more)

**Step 4.** Get a free key from https://aistudio.google.com/apikey

**Step 5.** Create a file called `.env.local` in the project root:

```bash
GEMINI_API_KEYS=paste_your_key_here
```

**Step 6.** Stop the server with Ctrl+C and run `npm run dev` again. Next.js only
reads env files at startup, so a restart is required.

The badge on each answer now shows which key served it instead of `offline mode`.

You can add several keys separated by commas. If you do, take them from
**different Google Cloud projects**: Google counts usage per project, not per
key, so keys from one project all hit the limit at the same moment.

### Check it is working

Open http://localhost:3000/api/health. You should see `"mode":"gemini"` (or
`"offline"` with no key), `"sections":22`, and the transfer-fee conflict listed.

### Optional: retrain the lead-scoring model

The trained model is already committed, so this is only needed if you want to
reproduce the numbers.

```bash
pip install -r ml/requirements.txt
python ml/train.py
```

## Deploy to Vercel

```bash
npm i -g vercel
vercel login
vercel --prod
```

Then add your key in the Vercel dashboard under Settings, Environment Variables:
`GEMINI_API_KEYS`. Redeploy after adding it. Without the key the deployed site
still works in offline mode.

`.env` and `.env.local` are gitignored and never uploaded, which is why the key
has to be set in the dashboard separately.

## The four parts

| Part | Files | Try it |
|---|---|---|
| 1. Document assistant | `lib/`, `app/api/chat` | The chat box on the home page |
| 2. SQL schema and queries | `sql/schema.sql`, `sql/queries.sql` | Read them |
| 3. Lead scoring | `ml/train.py`, `ml/metrics.md` | `python ml/train.py` |
| 4. Web page | `app/page.tsx` | The home page |

## Part 1: the document assistant

Ask a question, get an answer with the document section it came from. If the
documents cannot support an answer, it says so instead of guessing.

Every answer has one of five states, and the page colours each one differently:

| State | Meaning |
|---|---|
| `answered` | Found in the documents, with a source |
| `conflict` | Two documents disagree, so both are shown |
| `unconfirmed` | The documents say this is not decided yet |
| `policy_refusal` | MGC policy forbids answering this |
| `not_in_documents` | Not covered at all |

How it handles the five test questions:

| Question | Answer |
|---|---|
| Base price of a 2-bed in Block B? | PKR 22,425,000, and notes that a 2-Bed Corner also exists at 26,855,000 |
| Total for a Margalla-facing corner, floor 15, 2-bed Block B? | PKR 25,340,250, with the sum shown line by line |
| What is the transfer fee? | Shows both: 2% from the price list and 2.5% from the FAQ, and says the FAQ is newer |
| Rental yield on a 1-bed? | Refuses. The FAQ says staff must not give yield projections, so it points to the marketing manager |
| Who is the anchor tenant? | Says none is confirmed, quoting the brochure |

Three things make this reliable:

1. **Conflicts are found before the model runs.** The code scans all three
   documents for the same topic having different values, then tells the model to
   show both. The model cannot quietly pick one.
2. **The model never does maths.** Prices are calculated in `lib/pricing.ts` and
   handed to the model as a finished breakdown for it to read out.
3. **Sources are checked afterwards.** If a quoted source does not actually exist
   in the documents, the answer is dropped and replaced with a refusal.

On the price question, the documents are genuinely ambiguous: Block B lists a
2-Bed Corner as its own unit type at 26,855,000, so "2-bed corner" could mean
25,340,250 or 29,540,500. The price list's own worked example points to the
first, so that is shown, and the second is flagged as a caveat.

## Key rotation

`lib/gemini/keyPool.ts` spreads requests across several Gemini keys.

- Picks the least busy key that is not in cooldown.
- On a rate limit, cools that key down and retries on another.
- On an invalid key, disables it rather than retrying it forever.
- On a bad request (400), stops instead of rotating, because that is a bug in our
  code and no other key will accept it either.

Check pool state at http://localhost:3000/api/health. Keys are never shown, only
their position and last four characters.

## Rate limiting

`/api/chat` allows 20 requests per caller per minute, set with
`RATE_LIMIT_PER_MINUTE`. The endpoint has no login and every request sends the
whole corpus to Gemini, so without a cap anyone who can reach a deployment could
drain the quota in a loop. Implemented in `lib/rateLimit.ts`.

Two similar-looking errors mean different things. A **429** means you are sending
too fast. A **503** means our Gemini keys are exhausted.

Both the rate limiter and the key pool keep their state in memory, so on Vercel
each server instance counts separately. That raises the cost of abuse rather than
making it impossible. Shared state in Vercel KV is the proper fix and is not
built. There is also no authentication, which the task brief does not grade.

## Part 2: the SQL

`sql/schema.sql` loads the messy CSV into a `lead_raw` staging table, then a clean
`lead` table with proper types.

Duplicates are prevented by one line:

```sql
CREATE UNIQUE INDEX ON lead (crm_record_hash);
```

`lead_id` cannot do this job, because `MGC-104183` and `MGC-104183-B` are the same
enquiry entered twice by two agents. `crm_record_hash` is identical for both, so
the second insert is rejected.

`sql/queries.sql` has the conversion rate by source, and two duplicate finders:
an exact one that catches all 160 pairs, and a fuzzy one for near-duplicates the
CRM's own hash misses.

## Part 3: lead scoring

Run `python ml/train.py` (needs `pip install -r ml/requirements.txt`).
Full output is written to `ml/metrics.md`.

### What was dropped, and why

**`token_amount_received_pkr`.** With no token paid, 0 out of 8,441 leads
converted. With a token paid, 634 out of 719 converted. The token *is* the
booking, so the model would just be reading the answer. It is also always zero
when you actually need to score a new lead.

**Call and visit data** (`calls_made`, `site_visits`, `whatsapp_replies`,
`total_call_seconds`, `first_response_minutes`). These predict well, but they only
exist *after* someone has worked the lead. The question is who to call first, and
at that moment they are all zero.

### What was cleaned

- Removed 160 duplicate leads, before splitting into train and test.
- Merged 21 city spellings into 9 (`ISB` to Islamabad, `Rwp` to Rawalpindi, and so on).
- `bedrooms` is missing for 39.3% of rows, and those rows are exactly the plots and
  commercial shops. So it is marked "not applicable" rather than filled in. A plot
  of land does not have a median number of bedrooms.
- Missing budget and agent experience filled with the median, plus a flag marking
  that they were missing.

### The result

| | Score |
|---|---|
| PR-AUC (average precision) | **0.1997** |
| Precision in the top 200 leads | **21.5%**, against a 7.0% base rate |

**Why PR-AUC and not accuracy:** only 6.9% of leads convert, so a model that
predicts "nobody converts" is 93% accurate and completely useless. PR-AUC only
measures performance on the leads that do convert, and its floor is the 6.9% base
rate, so the number is easy to judge against doing nothing.

A second model trained *with* the call and visit data scores 0.3737. It looks
better but cannot be used, because that data does not exist when a lead arrives.
The gap between the two is the cost of answering the real question.

## What is not finished

1. **No form for lead scoring on the page.** The API works
   (`POST /api/score`, example below) but has no input boxes yet.
2. **Search is keyword-based, not semantic.** Fine for three documents. For a
   larger document set I would add embeddings alongside the keyword search. The
   code is structured for this: `lib/types.ts` defines a `Retriever` interface and
   `lib/retrieval/lexical.ts` is one implementation of it.
3. **Answers do not stream.** They appear all at once after a second or two.
4. **No tests.**

```bash
curl -s -X POST http://localhost:3000/api/score -H "content-type: application/json" -d '{"source":"Referral","city":"ISB","property_type":"Apartment","budget_pkr_lac":250,"bedrooms":2,"referred_by_existing_client":true,"has_financing_approved":true,"agent_experience_years":8}'
```

## AI tools used

Claude (Claude Code) for scaffolding, the SQL, the training script and this file.

The one place I went against its first suggestion: it wanted a vector database
and chunked search. With only three short documents that would have broken the
transfer fee question, because chunked search returns whichever of the two
conflicting sections scores higher and the model then answers confidently from
half the evidence. Searching all of it and detecting the conflict up front is
both simpler and more correct here.
