# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Agent usage queries

Agents can call `t3_environment_usage` to inspect the current environment's aggregated usage. The
query accepts at most 31 calendar days at daily resolution or 24 hours at hourly resolution. Large
bucket sets are paged; pages read the live cache and can shift when new transcript records arrive.
For hourly queries, the day labels must match the supplied instants in the requested time zone;
`untilTime` is exclusive, including when it lands on local midnight or across a daylight-saving
transition.

The result reports token totals, cache savings, pricing status, and whether each bucket was priced
from provider-reported cost, a model rate, or not priced. Dollar figures are API-equivalent
estimates, not subscription charges. Pricing provenance uses a fixed public-catalog label rather
than a service URL. Provider-source status and file counts come from the existing usage service. A
missing source is not proof of zero usage; nonzero skipped-file counts can also represent empty,
unreadable, or unusable files even when the source status is `ok`.

This is an explicit read, but it can scan provider transcript files, refresh the existing pricing
cache, and update the existing scan cache. It never returns transcript contents, provider-home
paths, source fingerprints, credentials, or raw scan errors.
