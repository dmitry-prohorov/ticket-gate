import { readFileSync } from 'node:fs';
import { helper } from '../lib/a.mjs';

// A comment may say fetch( or import(x) and a string may say 'node:https'.
const note = 'fetch( is only text here; so is import(variable)';
export const run = () => helper(readFileSync, note);
