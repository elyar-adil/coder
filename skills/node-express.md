# Node.js Express API Skill

Use this skill when building or modifying Node.js Express web applications.

## Project structure
```
project/
  src/
    index.ts            # Express app entry point
    routes/             # Route handlers
    middleware/          # Custom middleware
    models/             # Data models / schemas
    services/           # Business logic
    utils/              # Utility functions
  tests/                # Test files
  package.json
  tsconfig.json
```

## Conventions
- Use TypeScript with ES module syntax
- Organize routes with Express Router
- Use Zod for request/response validation
- Use async/await with proper error handling
- Centralized error middleware
- Environment config via dotenv or env vars
- Jest or Vitest for testing
