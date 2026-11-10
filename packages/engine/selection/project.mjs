import { SelectionConfigError } from './define.mjs';

/**
 * The engine reads no project default: every caller passes its selection config. Reaching this
 * function means a caller omitted it.
 */
export const projectSelection = () => {
  throw new SelectionConfigError(
    'no selection config: pass one (define it under `selection` in gate.config.mjs)',
  );
};
