# Git Workflow Skill

Use this skill when working with git repositories.

## Guidelines
- Check `git status` before making changes
- Read `git log --oneline -10` for recent history and commit style
- Create feature branches from main: `git checkout -b feature/description`
- Write conventional commit messages: `type(scope): description`
  - Types: feat, fix, refactor, docs, test, chore, perf
- Stage specific files, not `git add .`
- Never force push to main/master
- Run tests before committing
- Check for uncommitted changes before switching branches
