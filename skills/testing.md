# Testing Skill

Use this skill when writing or fixing tests.

## Guidelines
- Use the project's existing test framework (detect from package.json or config files)
- Name test files `*.test.ts` or `*_test.py` matching the source file
- Test one behavior per test case
- Use descriptive test names
- Mock external dependencies
- Test edge cases: empty, null, boundary values, error conditions
- Run full test suite after writing tests to confirm nothing breaks
