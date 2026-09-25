/**
 * Daemon unit project only. The shipped default engine is `pairs`; suites
 * written against the legacy supervision registry pin `legacy` here, and pair
 * suites set `pairs` themselves. Kept apart from isolated-home.ts so projects
 * that only need home isolation (e2e) keep the shipped default.
 */
process.env.IMCODES_SUPERVISION_ENGINE ??= 'legacy';
