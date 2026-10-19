# Pattern authoring guide

On-demand reference for authoring or updating project patterns. These generic
examples and templates are illustrative, not additional project rules. The active
rules live in `.claude/rules/core/allowed-patterns.md` and
`.claude/rules/core/forbidden-patterns.md`. Keep existing project rule numbers
stable and assign new rules unused numbers; do not renumber after these examples.

## Allowed-pattern authoring

## How to Use This File

1. **Add patterns** that represent your team's coding standards
2. **Include examples** showing the correct way to implement each pattern
3. **Explain why** each pattern is beneficial
4. **Reference tools/rules** if applicable (ESLint, SonarQube, etc.)

---

## Example Pattern Structure

### Pattern Name

Brief description of what this pattern accomplishes.

```typescript
// GOOD - Example of the correct approach
const example = doThingCorrectly()

// Optionally show the contrast
// BAD - What to avoid (but keep this minimal)
const badExample = doThingWrong()
```

**Why**: Explain the benefit of following this pattern.

**Guidelines**:

- Specific guideline 1
- Specific guideline 2

---

## Example Patterns

### 1. Descriptive Naming

Use clear, descriptive names for functions, variables, and components.

```typescript
// GOOD - Clear intent
function calculateOrderTotal(items: OrderItem[]): number
function fetchUserProfile(userId: string): Promise<User>
const isAuthenticated = checkAuthStatus()

// GOOD - Component names describe what they render
export const UserProfileCard = () => { ... }
export const OrderSummaryTable = () => { ... }
```

**Why**: Improves code readability and makes the codebase self-documenting.

---

### 2. Single Responsibility

Each function/component should do one thing well.

```typescript
// GOOD - Focused function
function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}

// GOOD - Focused component
const PriceDisplay = ({ amount }: { amount: number }) => (
  <span className="price">{formatCurrency(amount)}</span>
)
```

**Why**: Easier to test, maintain, and reuse.

---

### 3. Error Handling

Handle errors explicitly with meaningful messages.

```typescript
// GOOD - Explicit error handling
async function fetchData(url: string) {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      throw new ApiError(`Request failed: ${response.status}`)
    }
    return response.json()
  } catch (error) {
    logger.error('Failed to fetch data', { url, error })
    throw error
  }
}
```

**Why**: Makes debugging easier and provides better user feedback.

---

### 4. Type Safety

Leverage TypeScript's type system to catch errors at compile time.

```typescript
// GOOD - Explicit types for function signatures
interface User {
  id: string
  name: string
  email: string
}

function createUser(input: CreateUserInput): User {
  // Implementation
}

// GOOD - Use type inference where appropriate
const users = await fetchUsers() // Type inferred from function return
```

**Why**: Catches errors before runtime and improves IDE autocomplete.

---

### 5. Consistent Code Organization

Follow a consistent structure for files and folders.

```
src/
├── components/       # UI components
├── hooks/            # Custom React hooks
├── utils/            # Utility functions
├── types/            # TypeScript type definitions
├── services/         # API and external service integrations
└── stores/           # State management
```

**Why**: Makes the codebase navigable and predictable.

---

## Adding Your Patterns

When adding new patterns to this file:

1. **Start with the pattern name** as a heading
2. **Provide code examples** showing the correct approach
3. **Explain the "Why"** - benefits of the pattern
4. **Add guidelines** for edge cases or nuances
5. **Reference external rules** if applicable (linting, etc.)

---

## Template for New Patterns

```markdown
### Pattern Name

Brief description of what this pattern accomplishes.

\`\`\`typescript
// GOOD - Example code
const example = correctApproach()
\`\`\`

**Why**: Explanation of benefits.

**Guidelines**:

- Guideline 1
- Guideline 2
```

---


## Forbidden-pattern authoring

## How to Use This File

1. **Add anti-patterns** that cause problems in your codebase
2. **Show examples** of the problematic code
3. **Explain why** each pattern is harmful
4. **Reference the fix** in `.claude/rules/core/allowed-patterns.md` when applicable

---

## Example Pattern Structure

### DON'T: Pattern Name

**Problem**: Brief description of why this is problematic.

```typescript
// BAD - Example of the anti-pattern
const badExample = doThingWrong()
```

**Why This is Wrong**:

- Reason 1
- Reason 2

**Fix**: Description of the correct approach or link to `.claude/rules/core/allowed-patterns.md`.

---

## Example Anti-Patterns

### 1. DON'T Use Magic Numbers

**Problem**: Hardcoded numbers without context make code hard to understand and maintain.

```typescript
// BAD - What does 86400000 mean?
setTimeout(cleanup, 86400000)

// BAD - Why 5? What if it needs to change?
if (retryCount > 5) {
  throw new Error('Too many retries')
}
```

**Why This is Wrong**:

- No context for what the number represents
- Hard to find and update when requirements change
- Easy to introduce bugs with typos

**Fix**: Use named constants with descriptive names.

```typescript
// GOOD
const ONE_DAY_MS = 24 * 60 * 60 * 1000
setTimeout(cleanup, ONE_DAY_MS)

const MAX_RETRY_ATTEMPTS = 5
if (retryCount > MAX_RETRY_ATTEMPTS) {
  throw new Error('Too many retries')
}
```

---

### 2. DON'T Swallow Errors Silently

**Problem**: Catching errors without handling them hides bugs and makes debugging impossible.

```typescript
// BAD - Error is completely ignored
try {
  await saveData(data)
} catch (error) {
  // Silent failure - no one knows something went wrong
}

// BAD - Generic catch that hides the real issue
try {
  await complexOperation()
} catch {
  return null
}
```

**Why This is Wrong**:

- Bugs go unnoticed until they cause bigger problems
- Impossible to debug issues in production
- Users don't know their action failed

**Fix**: Always log errors and provide appropriate user feedback.

```typescript
// GOOD
try {
  await saveData(data)
} catch (error) {
  logger.error('Failed to save data', { error, data })
  throw new UserFacingError('Unable to save. Please try again.')
}
```

---

### 3. DON'T Use Nested Ternaries

**Problem**: Deeply nested ternary operators are hard to read and maintain.

```typescript
// BAD - Unreadable nested ternaries
const status = isLoading ? 'loading' : hasError ? 'error' : isComplete ? 'complete' : 'idle'

// BAD - Even worse with more nesting
const message = !user ? 'Not logged in' : !user.verified ? 'Please verify' : user.isPremium ? 'Welcome back, premium user!' : 'Welcome back!'
```

**Why This is Wrong**:

- Extremely hard to read and understand
- Easy to introduce bugs when modifying
- Difficult to add new conditions

**Fix**: Use if/else statements, switch statements, or lookup objects.

```typescript
// GOOD - Clear and maintainable
function getStatus(isLoading: boolean, hasError: boolean, isComplete: boolean) {
  if (isLoading) return 'loading'
  if (hasError) return 'error'
  if (isComplete) return 'complete'
  return 'idle'
}
```

---

### 4. DON'T Mutate Function Parameters

**Problem**: Mutating parameters causes unexpected side effects and makes code unpredictable.

```typescript
// BAD - Mutating the input array
function addItem(items: string[], newItem: string) {
  items.push(newItem) // Modifies the original array!
  return items
}

// BAD - Mutating object properties
function updateUser(user: User) {
  user.lastUpdated = new Date() // Modifies the original object!
  return user
}
```

**Why This is Wrong**:

- Caller doesn't expect their data to change
- Causes bugs that are hard to track down
- Breaks immutability expectations in React/Redux

**Fix**: Return new objects/arrays instead of mutating.

```typescript
// GOOD - Returns new array
function addItem(items: string[], newItem: string) {
  return [...items, newItem]
}

// GOOD - Returns new object
function updateUser(user: User) {
  return { ...user, lastUpdated: new Date() }
}
```

---

### 5. DON'T Mix Async Patterns

**Problem**: Mixing callbacks, promises, and async/await makes code confusing and error-prone.

```typescript
// BAD - Mixing callbacks and promises
function fetchData(callback) {
  fetch('/api/data')
    .then(res => res.json())
    .then(data => callback(null, data))
    .catch(err => callback(err))
}

// BAD - Mixing .then() with async/await
async function processData() {
  const result = await fetchData()
  return result.then(data => transform(data)) // Mixing patterns!
}
```

**Why This is Wrong**:

- Confusing control flow
- Error handling becomes inconsistent
- Harder to debug and maintain

**Fix**: Use async/await consistently throughout.

```typescript
// GOOD - Consistent async/await
async function fetchData() {
  const response = await fetch('/api/data')
  return response.json()
}

async function processData() {
  const data = await fetchData()
  return transform(data)
}
```

---

## Adding Your Anti-Patterns

When adding new anti-patterns to this file:

1. **Start with "DON'T"** followed by the pattern name
2. **Describe the problem** briefly
3. **Provide BAD examples** showing the anti-pattern
4. **Explain why it's wrong** with a bullet list
5. **Show the fix** or reference `.claude/rules/core/allowed-patterns.md`

---

## Template for New Anti-Patterns

```markdown
### DON'T: Pattern Name

**Problem**: Brief description of why this is problematic.

\`\`\`typescript
// BAD - Example of the anti-pattern
const badExample = problematicCode()
\`\`\`

**Why This is Wrong**:

- Reason 1
- Reason 2

**Fix**: Description or link to `.claude/rules/core/allowed-patterns.md`.
```

---
