
## Running Tests

```bash
# Run all tests
npm run test

# Run tests in watch mode
npm run test -- --watch

# Run specific test file
npm run test -- src/commands/streamTurn.server.test.ts

# Run tests matching pattern
npm run test -- --testNamePattern="chat validation"

# Run with coverage
npm run test -- --coverage

# Run only changed files
npm run test -- --onlyChanged

# Run with verbose output
npm run test -- --verbose
```

---

## Coverage Commands

```bash
# Generate coverage report
npm run test -- --coverage

# Generate HTML coverage report
npm run test -- --coverage --coverageReporters="html"

# Check coverage thresholds
npm run test -- --coverage --coverageThreshold='{"global":{"branches":80,"functions":80,"lines":80}}'

# Coverage for specific files
npm run test -- --coverage --collectCoverageFrom="src/commands/**/*.ts"
```

---

## Debugging Tests

```bash
# Run with Node debugger
node --inspect-brk node_modules/.bin/jest --runInBand

# Run single test for debugging
npm run test -- --runInBand --testNamePattern="specific test name"

# Show why tests are slow
npm run test -- --detectOpenHandles
```

---

## CI/CD Commands

```bash
# Run in CI mode (no watch, fail on console errors)
npm run test -- --ci

# Run with JUnit reporter for CI
npm run test -- --ci --reporters=default --reporters=jest-junit

# Run with max workers for parallel execution
npm run test -- --maxWorkers=4
```
