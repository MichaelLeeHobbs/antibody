// Compatibility for guards written for the old failure-ledger hooks: the same pipelines() and
// maskQuotes() they imported from ./lib/guard.mjs, now backed by antibody's shell parser.
// `antibody migrate` copies this file and shell.mjs next to the converted guards.
import { mask, parse } from './shell.mjs';

export const maskQuotes = (cmd) => mask(cmd);
export const pipelines = (cmd) => parse(cmd).map((p) => ({ stages: p.stages.map((s) => ({ orig: s.orig, masked: s.masked })) }));
