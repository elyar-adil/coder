# Python Flask API Skill

Use this skill when building or modifying Python Flask web applications.

## Project structure
```
project/
  app.py              # Flask app entry point
  requirements.txt    # Dependencies
  config.py           # Configuration
  models/             # SQLAlchemy models
  routes/             # Route blueprints
  services/           # Business logic
  tests/              # pytest tests
```

## Conventions
- Use Flask blueprints for route organization
- Use SQLAlchemy for database
- Use pytest with pytest-flask for testing
- Type hints on all functions
- Use pydantic or dataclasses for request/response schemas
