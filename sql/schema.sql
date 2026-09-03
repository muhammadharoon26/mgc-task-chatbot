-- MGC lead store — PostgreSQL
--
-- Designed against the actual contents of mgc-task-pack/leads.csv (9,160 rows),
-- profiled before writing a line of DDL. The findings that drove each decision
-- are noted inline, because "why is this column nullable" is the question I
-- expect to be asked.
--
-- Shape:
--     lead_raw          staging — everything text, no constraints, mirrors the CSV
--        │ normalise + dedupe
--        ▼
--     lead              one row per real enquiry, typed and constrained
--     lead_engagement   1:1, the mutable operational counters
--     city / city_alias canonical cities + the messy spellings that map to them
--     area              lookup, nullable from lead
--
-- Why a staging table at all: a dump from a messy CRM cannot land directly in a
-- constrained table — the first duplicate aborts the load. lead_raw accepts
-- anything; the transform into `lead` is where normalisation and dedup happen,
-- auditably. It also gives queries.sql something to detect duplicates *in*:
-- in `lead` they cannot exist by construction.

BEGIN;

DROP TABLE IF EXISTS lead_engagement, lead, lead_raw, city_alias, city, area CASCADE;
DROP TYPE  IF EXISTS lead_source, property_type CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Enumerations
--
-- ENUMs rather than lookup tables for these two: both are small, closed and
-- stable in the data (source has exactly 9 values across 9,160 rows,
-- property_type exactly 6), and an ENUM gives the same referential guarantee
-- without a join on every analytical query. Cities get a table instead, because
-- they are neither closed nor clean — see below.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE lead_source AS ENUM (
    'Facebook Ads', 'Property Portal', 'Google Search', 'Instagram',
    'Referral', 'Walk-in', 'WhatsApp Campaign', 'Expo Stall', 'Billboard'
);

CREATE TYPE property_type AS ENUM (
    'Apartment', 'Plot', 'Villa', 'Commercial Shop', 'Penthouse', 'Farmhouse'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Reference data
--
-- The CSV holds 21 distinct city spellings for 9 real cities:
--   Islamabad / ISLAMABAD / ISB,  Rawalpindi / RAWALPINDI / Rwp,
--   Karachi / KARACHI / khi,  and ALLCAPS variants of the rest.
-- Encoding that as a table rather than a CASE expression buried in an ETL
-- script means the next unseen spelling is one INSERT, not a code change.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE city (
    city_id   smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      text NOT NULL UNIQUE
);

CREATE TABLE city_alias (
    alias     text PRIMARY KEY,            -- stored lower-cased; lookup lowers the input
    city_id   smallint NOT NULL REFERENCES city (city_id) ON DELETE CASCADE
);

CREATE TABLE area (
    area_id   smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name      text NOT NULL UNIQUE
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Staging
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE lead_raw (
    lead_id                      text,
    created_at                   text,
    source                       text,
    city                         text,
    area                         text,
    property_type                text,
    budget_pkr_lac               text,
    bedrooms                     text,
    first_response_minutes       text,
    calls_made                   text,
    total_call_seconds           text,
    whatsapp_replies             text,
    site_visits                  text,
    agent_experience_years       text,
    is_overseas                  text,
    referred_by_existing_client  text,
    has_financing_approved       text,
    token_amount_received_pkr    text,
    crm_record_hash              text,
    converted                    text
);
-- \copy lead_raw FROM 'mgc-task-pack/leads.csv' WITH (FORMAT csv, HEADER true);

-- ─────────────────────────────────────────────────────────────────────────────
-- The clean table
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE lead (
    -- The CRM's own id, and what the sales team says out loud. Kept as the PK
    -- for traceability back to the source system.
    lead_id            text PRIMARY KEY,

    -- The CRM's fingerprint of the underlying person + enquiry.
    --
    -- This is the important column. lead_id does NOT identify a person — that is
    -- the entire duplicate problem: MGC-104183 and MGC-104183-B are one enquiry
    -- entered twice by two agents, with the SAME crm_record_hash. The unique
    -- index below is therefore what makes the second entry impossible.
    --
    -- Measured: 9,160 rows, 9,000 distinct hashes, 160 collisions, every one of
    -- them a genuine duplicate pair (multiplicity is never above 2).
    --
    -- In a CRM I controlled I would rather this were a GENERATED column over a
    -- normalised phone or CNIC — a vendor-supplied hash is opaque and I cannot
    -- verify its inputs. This dataset has neither column, so the hash is the
    -- best available natural key and swapping it is a one-line change.
    crm_record_hash    bigint NOT NULL,

    created_at         timestamptz NOT NULL,
    source             lead_source NOT NULL,

    city_id            smallint REFERENCES city (city_id),
    -- 477 rows (5.2%) have no area. Genuinely not captured, so genuinely NULL —
    -- and "nobody asked" may itself be signal about lead quality.
    area_id            smallint REFERENCES area (area_id),

    property_type      property_type NOT NULL,

    budget_pkr_lac     numeric(10,2),
    -- 3,602 rows (39.3%) have no bedrooms — and that is EXACTLY the 2,553 Plot
    -- plus 1,049 Commercial Shop rows. The value is not missing, it is
    -- inapplicable, and the CHECK below states that so the database will refuse
    -- a plot of land with three bedrooms.
    bedrooms           smallint,

    is_overseas                  boolean NOT NULL DEFAULT false,
    referred_by_existing_client  boolean NOT NULL DEFAULT false,
    has_financing_approved       boolean NOT NULL DEFAULT false,

    -- 634 of 9,160 = 6.92%.
    converted          boolean NOT NULL DEFAULT false,

    CONSTRAINT lead_budget_positive
        CHECK (budget_pkr_lac IS NULL OR budget_pkr_lac > 0),
    CONSTRAINT lead_bedrooms_sane
        CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 10),
    CONSTRAINT lead_bedrooms_only_for_residential
        CHECK (
            CASE WHEN property_type IN ('Plot', 'Commercial Shop')
                 THEN bedrooms IS NULL
                 ELSE true
            END
        ),
    CONSTRAINT lead_created_at_not_future
        CHECK (created_at <= now())
);

-- ═════════════════════════════════════════════════════════════════════════════
-- THE DUPLICATE PREVENTION (see queries.sql Q2 for the detection side)
--
-- One unique index is the whole answer. Ingest runs
--     INSERT INTO lead (...) SELECT ... FROM lead_raw
--     ON CONFLICT (crm_record_hash) DO NOTHING;
-- so the second agent's entry is rejected at write time rather than discovered
-- in an analysis six months later.
--
-- Note what is deliberately NOT used as the key: the '-B' suffix on lead_id.
-- It happens to identify all 160 duplicates in this extract, but it is a naming
-- convention, not a constraint — the next agent will type '_dup' or '(2)'.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE UNIQUE INDEX lead_crm_record_hash_key ON lead (crm_record_hash);

-- Supports the conversion-by-source report and the usual "leads this month" cuts.
CREATE INDEX lead_source_converted_idx ON lead (source, converted);
CREATE INDEX lead_created_at_idx       ON lead (created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Engagement counters, split 1:1 from `lead`
--
-- Why separate: `lead` rows are write-once intake facts. These five change on
-- every touch — a call placed, a WhatsApp reply, a site visit booked. Splitting
-- them keeps the intake row immutable, and it is the natural stepping stone to
-- the model I would actually want: a `lead_touch` event table with one row per
-- interaction, of which these columns are merely a rollup. At 9,000 rows the
-- rollup is the honest amount of structure; the event table is the next step.
--
-- Note also what is NOT here and NOT on `lead`: token_amount_received_pkr.
-- A received token is a *booking* fact, not a lead attribute, and it belongs on
-- a `booking` table keyed to the unit. Measured: token = 0 → 0 of 8,441
-- converted; token > 0 → 634 of 719 converted. Storing it on the lead row is
-- how it ends up in a feature matrix by accident (see ml/train.py, where it is
-- the first column dropped).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE lead_engagement (
    lead_id                  text PRIMARY KEY REFERENCES lead (lead_id) ON DELETE CASCADE,
    -- 1 to 3,107 minutes in the data; median 30. A response that never happened
    -- is NULL, not 0 — zero would mean "answered instantly".
    first_response_minutes   integer CHECK (first_response_minutes IS NULL OR first_response_minutes >= 0),
    calls_made               smallint NOT NULL DEFAULT 0 CHECK (calls_made >= 0),
    total_call_seconds       integer  NOT NULL DEFAULT 0 CHECK (total_call_seconds >= 0),
    whatsapp_replies         smallint NOT NULL DEFAULT 0 CHECK (whatsapp_replies >= 0),
    site_visits              smallint NOT NULL DEFAULT 0 CHECK (site_visits >= 0),
    -- A property of the AGENT, not the lead. Kept because it is predictive, but
    -- it is the reason a lead-scoring model built on this table needs a
    -- fairness caveat: "route good leads to senior agents" is a staffing
    -- decision, not a lead score.
    agent_experience_years   numeric(4,1) CHECK (agent_experience_years IS NULL OR agent_experience_years >= 0),

    CONSTRAINT engagement_calls_consistent
        CHECK (calls_made > 0 OR total_call_seconds = 0)
);

COMMIT;
