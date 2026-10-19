
## Running Tests

```bash
# Run all tests
pytest

# Run with verbose output
pytest -v

# Run specific test file
pytest tests/test_service.py

# Run specific test class
pytest tests/test_service.py::TestUserService

# Run specific test
pytest tests/test_service.py::TestUserService::test_get_user_returns_user

# Run with coverage
pytest --cov=src --cov-report=html

# Run only marked tests
pytest -m "integration"

# Run with parallel execution
pytest -n auto

# Stop on first failure
pytest -x
```

---

## Coverage Commands

```bash
# Generate coverage report
pytest --cov=src

# Generate HTML coverage report
pytest --cov=src --cov-report=html

# Generate XML coverage report (for CI)
pytest --cov=src --cov-report=xml

# Check coverage thresholds
pytest --cov=src --cov-fail-under=80

# Coverage for specific modules
pytest --cov=src/mymodule --cov-report=term-missing
```

---

## Debugging Tests

```bash
# Drop into debugger on failure
pytest --pdb

# Drop into debugger at start of each test
pytest --pdb-first

# Show local variables in tracebacks
pytest -l

# Verbose output with full diff
pytest -vv

# Show print statements
pytest -s

# Capture no output (show all print statements)
pytest --capture=no
```

---

## CI/CD Commands

```bash
# Run with JUnit XML output for CI
pytest --junitxml=results.xml

# Run with coverage and XML output
pytest --cov=src --cov-report=xml --junitxml=results.xml

# Fail if coverage drops below threshold
pytest --cov=src --cov-fail-under=80

# Run in parallel (requires pytest-xdist)
pytest -n auto

# Rerun only failed tests
pytest --lf

# Rerun failed tests first, then rest
pytest --ff
```

---

## Test Selection

```bash
# Run tests matching a keyword expression
pytest -k "user and not integration"

# Run tests matching a marker
pytest -m "slow"

# Run tests in a specific directory
pytest tests/unit/

# Run tests that failed in the last run
pytest --lf

# Run tests in random order (requires pytest-random-order)
pytest --random-order
```
