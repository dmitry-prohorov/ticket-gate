# @ticket-gate/react

The React Compiler bailout ratchet for `@ticket-gate/engine`. `compiler.mjs` exports `reactCompiler(options)`, which runs
`babel-plugin-react-compiler` over the `.ts` and `.tsx` files of the configured scan directories and compares what the compiler
could not compile with a baseline file. A new bailout, a skipped component or hook, or a stale baseline entry fails the check.

Every project value (scan directories, exclude pattern, where `@babel/core` and the plugin resolve from, baseline path, message
texts) is an option. The package has no runtime dependency beyond the engine: `@babel/core` and `babel-plugin-react-compiler` are
resolved from the consuming project at call time.
