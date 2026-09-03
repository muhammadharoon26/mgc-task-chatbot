-- MGC lead queries — PostgreSQL
-- Companion to schema.sql. Run that first.

-- ═════════════════════════════════════════════════════════════════════════════
-- Q1 · Conversion rate by lead source
--      Only sources with 200+ leads. Best first.
--
-- Runs against `lead` (the deduplicated table), NOT `lead_raw`, and that is a
-- deliberate correctness choice: the 160 duplicate rows are not spread evenly
-- across sources, so counting them twice biases the rate of whichever source
-- happened to get double-entered. A conversion-rate report computed on raw CRM
-- output is a report that quietly rewards sloppy data entry.
--
-- The 200-lead floor is doing real work too — Expo Stall converts at 2.9% on
-- 345 leads, but a source with 30 leads and 2 conversions would top this table
-- at 6.7% on nothing but noise.
-- ═════════════════════════════════════════════════════════════════════════════
SELECT
    source,
    count(*)                                            AS leads,
    count(*) FILTER (WHERE converted)                   AS conversions,
    round(
        100.0 * count(*) FILTER (WHERE converted) / count(*),
        2
    )                                                   AS conversion_rate_pct
FROM lead
GROUP BY source
HAVING count(*) >= 200
ORDER BY conversion_rate_pct DESC;

-- Expected on this extract (9,000 deduplicated leads):
--
--   source              leads  conversions  rate
--   Referral              730           95  13.01
--   Walk-in               610           63  10.33
--   Facebook Ads        2,366          160   6.76
--   Google Search       1,460           96   6.58
--   WhatsApp Campaign     548           35   6.39
--   Property Portal     1,812          108   5.96
--   Instagram           1,007           55   5.46
--   Billboard             282           12   4.26
--   Expo Stall            345           10   2.90
--
-- The finding a sales manager actually wants: Referral and Walk-in convert at
-- roughly twice everything else, while Facebook Ads supplies 26% of all volume
-- at 6.76%. That is a budget conversation, not a reporting one.


-- ═════════════════════════════════════════════════════════════════════════════
-- Q2 · Finding the duplicate leads
--
-- ── HOW THE SCHEMA PREVENTS THESE ──────────────────────────────────────────
-- schema.sql declares:
--
--     CREATE UNIQUE INDEX lead_crm_record_hash_key ON lead (crm_record_hash);
--
-- and the ingest runs INSERT ... ON CONFLICT (crm_record_hash) DO NOTHING.
-- crm_record_hash is the CRM's fingerprint of the underlying person + enquiry,
-- so the second agent's entry is rejected at write time. lead_id cannot serve
-- this purpose: MGC-104183 and MGC-104183-B are DIFFERENT lead_ids for the SAME
-- enquiry, which is exactly the bug.
--
-- Consequence: in `lead`, Q2a returns zero rows by construction. Both queries
-- therefore run against `lead_raw`, the staging table, which is where a CSV
-- dump from a messy CRM actually lands and where duplicates still exist.
-- ═════════════════════════════════════════════════════════════════════════════

-- Q2a · Exact duplicates: the same CRM fingerprint entered more than once.
--       Finds all 160 pairs in this extract.
SELECT
    crm_record_hash,
    count(*)                       AS copies,
    array_agg(lead_id ORDER BY lead_id) AS lead_ids,
    min(created_at)                AS first_entered,
    max(created_at)                AS last_entered
FROM lead_raw
GROUP BY crm_record_hash
HAVING count(*) > 1
ORDER BY copies DESC, crm_record_hash;

-- Every pair in this extract is a byte-for-byte copy apart from the lead_id
-- suffix, which is the signature of "the same lead entered twice by different
-- agents" rather than a genuine second enquiry from the same person.


-- Q2b · Fuzzy duplicates: same enquiry, DIFFERENT fingerprint.
--
-- Q2a only catches duplicates the CRM itself already recognised. It misses the
-- more common real-world case: two agents type the same walk-in, one of them
-- misspells the name or transposes a digit, and the CRM hashes them
-- differently. This is the query that keeps working when the vendor changes its
-- hashing, and the one worth running weekly.
--
-- Match rule: same source, city, property type and budget, created within an
-- hour of each other. Tight enough that a genuine second enquiry from a real
-- buyer (weeks apart, or a different budget) does not trip it.
SELECT
    a.lead_id            AS lead_id_a,
    b.lead_id            AS lead_id_b,
    a.source,
    a.city,
    a.property_type,
    a.budget_pkr_lac,
    a.created_at         AS created_a,
    b.created_at         AS created_b,
    abs(EXTRACT(EPOCH FROM (b.created_at::timestamptz - a.created_at::timestamptz))) / 60.0
                         AS minutes_apart
FROM lead_raw a
JOIN lead_raw b
  ON  a.lead_id < b.lead_id                      -- each pair once, never self-matched
  AND a.crm_record_hash <> b.crm_record_hash     -- Q2a already has the exact ones
  AND a.source        = b.source
  AND upper(trim(a.city)) = upper(trim(b.city))  -- 21 spellings for 9 cities in raw
  AND a.property_type = b.property_type
  AND a.budget_pkr_lac = b.budget_pkr_lac
  AND abs(EXTRACT(EPOCH FROM (b.created_at::timestamptz - a.created_at::timestamptz))) < 3600
ORDER BY minutes_apart, a.lead_id;

-- Note the city comparison uses upper(trim(...)) rather than equality: in
-- lead_raw, 'Islamabad', 'ISLAMABAD' and 'ISB' are three different strings for
-- one city. Once loaded into `lead` via city_alias this is a plain city_id
-- comparison — which is the point of having the alias table.


-- ── Bonus: what the ingest transform looks like ──────────────────────────────
-- Included because "how do duplicates get prevented" is really a question about
-- the write path, and the write path is three lines.
--
-- INSERT INTO lead (lead_id, crm_record_hash, created_at, source, city_id,
--                   area_id, property_type, budget_pkr_lac, bedrooms,
--                   is_overseas, referred_by_existing_client,
--                   has_financing_approved, converted)
-- SELECT r.lead_id,
--        r.crm_record_hash::bigint,
--        r.created_at::timestamptz,
--        r.source::lead_source,
--        ca.city_id,
--        ar.area_id,
--        r.property_type::property_type,
--        nullif(r.budget_pkr_lac, '')::numeric,
--        nullif(r.bedrooms, '')::numeric::smallint,
--        r.is_overseas = '1',
--        r.referred_by_existing_client = '1',
--        r.has_financing_approved = '1',
--        r.converted = '1'
-- FROM lead_raw r
-- LEFT JOIN city_alias ca ON ca.alias = lower(trim(r.city))
-- LEFT JOIN area       ar ON ar.name  = nullif(trim(r.area), '')
-- ORDER BY r.lead_id                     -- keeps MGC-104183 and drops -104183-B
-- ON CONFLICT (crm_record_hash) DO NOTHING;
