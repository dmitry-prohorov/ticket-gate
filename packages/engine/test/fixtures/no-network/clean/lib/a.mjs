import { join } from 'node:path';

export const helper = (read, note) => join(String(typeof read), note);
