# Debugging Skill

Use this skill when diagnosing and fixing bugs.

## Approach
1. **Reproduce** — Confirm the bug with a minimal, repeatable test case
2. **Read the error** — Parse stack traces, error messages, and exit codes carefully
3. **Isolate** — Narrow scope: which file, function, or line?
4. **Read before fix** — Always read the relevant source code before making changes
5. **Fix the root cause** — Don't patch symptoms; fix the underlying issue
6. **Verify** — Run the reproduction case to confirm the fix
7. **Check side effects** — Run the full test suite to catch regressions

## Common patterns
- TypeError: null/undefined → check for missing null guards or optional chaining
- ImportError / Module not found → check file paths, case sensitivity, extensions
- Test failures → read the diff, not just "FAIL"
- Build errors → check TypeScript strict mode, missing dependencies
