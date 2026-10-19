
## How to Use This File

1. **Analyze the existing codebase** to understand the patterns, conventions, and architectural decisions already established in the project. Look at:
   - Naming conventions used throughout the codebase
   - Code organization and folder structure
   - Error handling approaches
   - Testing patterns and frameworks in use
   - Existing abstractions and utilities
   - Configuration and dependency management style
2. **Identify the language(s)** in the PR being reviewed
3. **Apply general review patterns** from this file
4. **Reference language-specific patterns** based on the codebase:
   - For TypeScript/JavaScript: See `.claude/resources/languages/typescript-patterns.md`
   - For Python: See `.claude/resources/languages/python-patterns.md`
5. **Cross-check against forbidden patterns** in `.claude/rules/core/forbidden-patterns.md`
6. **Validate alignment with allowed patterns** in `.claude/rules/core/allowed-patterns.md`

> **Important:** The patterns already present in the project take precedence. New code should be consistent with the existing codebase style, even if it differs slightly from generic best practices.

---

## General PR Review Checklist

### 1. Code Quality

Before approving any PR, verify the following:

- [ ] Code follows the patterns defined in `.claude/rules/core/allowed-patterns.md`
- [ ] Code avoids anti-patterns defined in `.claude/rules/core/forbidden-patterns.md`
- [ ] Code adheres to language-specific patterns (see Language-Specific Reviews section)
- [ ] No magic numbers or hardcoded values without context
- [ ] Error handling is explicit and meaningful
- [ ] Functions and components follow single responsibility principle

### 2. Naming and Readability

- [ ] Variables, functions, and classes have descriptive names
- [ ] Code is self-documenting where possible
- [ ] Complex logic has appropriate comments explaining the "why"
- [ ] Consistent naming conventions throughout the PR

### 3. Testing

- [ ] New functionality has corresponding tests
- [ ] Edge cases are covered
- [ ] Tests are readable and follow AAA pattern (Arrange, Act, Assert)
- [ ] No flaky or timing-dependent tests

### 4. Security

- [ ] No hardcoded secrets, API keys, or credentials
- [ ] User inputs are validated and sanitized
- [ ] Authentication and authorization are properly checked
- [ ] Sensitive data is handled appropriately

### 5. Performance

- [ ] No unnecessary loops or repeated computations
- [ ] Appropriate use of caching where applicable
- [ ] No N+1 query problems
- [ ] Large data sets are handled efficiently

---

## Language-Specific Reviews

### TypeScript/JavaScript PRs

When reviewing TypeScript or JavaScript code, apply these additional checks from `.claude/resources/languages/typescript-patterns.md`:

**Type Safety:**

- [ ] Strict type-checking is enabled and followed
- [ ] No use of `any` type (use `unknown` with type guards instead)
- [ ] Interfaces are used for object shapes
- [ ] Discriminated unions for state management
- [ ] Proper use of generics for reusable components

**Patterns to Look For:**

```typescript
// GOOD - Discriminated unions for state
type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: Error };

// BAD - Loose typing with any
let value: any;
```

**Null Safety:**

- [ ] Optional chaining is used appropriately (`?.`)
- [ ] Nullish coalescing is used (`??`)
- [ ] Type guards are implemented for runtime type checking

**Immutability:**

- [ ] `readonly` is used where mutation should be prevented
- [ ] Arrays are not mutated directly; spread operators or `.map()` are used

**Reference:** See `.claude/resources/languages/typescript-patterns.md` for the complete TypeScript best practices.

---

### Python PRs

When reviewing Python code, apply these additional checks from `.claude/resources/languages/python-patterns.md`:

**Type Hints:**

- [ ] Function signatures have type hints
- [ ] Return types are specified
- [ ] Complex types use `typing` module (e.g., `List`, `Dict`, `Optional`)

**Patterns to Look For:**

```python
# GOOD - Type hints with docstrings
def fetch_user(user_id: str) -> Optional[User]:
    """Fetch a user by their ID.

    Args:
        user_id: The unique identifier of the user.

    Returns:
        The user if found, None otherwise.
    """
    pass

# BAD - No type hints, unclear function signature
def fetch_user(user_id):
    pass
```

**Error Handling:**

- [ ] Specific exceptions are caught (not bare `except:`)
- [ ] Context managers are used for resources (`with` statement)
- [ ] Errors are logged with appropriate context

**Code Style:**

- [ ] PEP 8 compliance
- [ ] Meaningful variable and function names (snake_case)
- [ ] Docstrings for public functions and classes
- [ ] No circular imports

**Reference:** See `.claude/resources/languages/python-patterns.md` for the complete Python best practices.

---

## Forbidden Patterns to Catch in Reviews

Always flag these anti-patterns from `.claude/rules/core/forbidden-patterns.md`:

### 1. Magic Numbers

```typescript
// FLAG THIS
setTimeout(cleanup, 86400000)
if (retryCount > 5) { ... }

// SUGGEST THIS
const ONE_DAY_MS = 24 * 60 * 60 * 1000
setTimeout(cleanup, ONE_DAY_MS)
```

### 2. Silent Error Swallowing

```typescript
// FLAG THIS
try {
  await saveData(data);
} catch (error) {
  // Silent failure
}

// SUGGEST THIS
try {
  await saveData(data);
} catch (error) {
  logger.error("Failed to save data", { error, data });
  throw new UserFacingError("Unable to save. Please try again.");
}
```

### 3. Nested Ternaries

```typescript
// FLAG THIS
const status = isLoading
  ? "loading"
  : hasError
  ? "error"
  : isComplete
  ? "complete"
  : "idle";

// SUGGEST THIS
function getStatus(isLoading: boolean, hasError: boolean, isComplete: boolean) {
  if (isLoading) return "loading";
  if (hasError) return "error";
  if (isComplete) return "complete";
  return "idle";
}
```

### 4. Parameter Mutation

```typescript
// FLAG THIS
function addItem(items: string[], newItem: string) {
  items.push(newItem); // Mutates original!
  return items;
}

// SUGGEST THIS
function addItem(items: string[], newItem: string) {
  return [...items, newItem];
}
```

### 5. Mixed Async Patterns

```typescript
// FLAG THIS
async function processData() {
  const result = await fetchData();
  return result.then((data) => transform(data));
}

// SUGGEST THIS
async function processData() {
  const data = await fetchData();
  return transform(data);
}
```

---

## Allowed Patterns to Encourage

Reference `.claude/rules/core/allowed-patterns.md` and encourage these practices:

### 1. Descriptive Naming

```typescript
// ENCOURAGE
function calculateOrderTotal(items: OrderItem[]): number;
function fetchUserProfile(userId: string): Promise<User>;
const isAuthenticated = checkAuthStatus();
```

### 2. Single Responsibility

```typescript
// ENCOURAGE - Focused, testable functions
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}
```

### 3. Explicit Error Handling

```typescript
// ENCOURAGE
async function fetchData(url: string) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new ApiError(`Request failed: ${response.status}`);
    }
    return response.json();
  } catch (error) {
    logger.error("Failed to fetch data", { url, error });
    throw error;
  }
}
```

### 4. Consistent Code Organization

```
// ENCOURAGE this structure
src/
├── components/       # UI components
├── hooks/            # Custom React hooks
├── utils/            # Utility functions
├── types/            # TypeScript type definitions
├── services/         # API and external service integrations
└── stores/           # State management
```

---

## Review Comment Templates

Use these templates for consistent review feedback:

### Suggesting a Pattern Change

```markdown
**Pattern Suggestion**: This code uses [anti-pattern name].

Consider refactoring to:
\`\`\`typescript
// Suggested improvement
\`\`\`

Reference: See `.claude/rules/core/forbidden-patterns.md` for details on why this pattern is problematic.
```

### Requesting Type Safety Improvements

```markdown
**Type Safety**: The use of `any` here bypasses TypeScript's type checking.

Consider using `unknown` with a type guard, or define a specific interface.

Reference: See `.claude/resources/languages/typescript-patterns.md` section on "Avoid the `any` Type".
```

### Flagging Missing Error Handling

```markdown
**Error Handling**: This error is being swallowed silently.

Please add appropriate logging and user feedback. See `.claude/rules/core/allowed-patterns.md` for error handling guidelines.
```

---

## PR Approval Criteria

A PR should only be approved when:

1. **No forbidden patterns** are present (or have been addressed)
2. **Allowed patterns** are followed where applicable
3. **Language-specific patterns** are adhered to
4. **Tests** are present and passing
5. **No security concerns** have been identified
6. **Code is readable** and maintainable

---

## Quick Reference: Pattern Files

| File                      | Purpose                        | When to Reference              |
| ------------------------- | ------------------------------ | ------------------------------ |
| `.claude/rules/core/forbidden-patterns.md`  | Anti-patterns to avoid         | When flagging problematic code |
| `.claude/rules/core/allowed-patterns.md`    | Best practices to follow       | When suggesting improvements   |
| `.claude/resources/languages/typescript-patterns.md` | TypeScript-specific guidelines | When reviewing TS/JS code      |
| `.claude/resources/languages/python-patterns.md`     | Python-specific guidelines     | When reviewing Python code     |
