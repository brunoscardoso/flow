
## File Naming Conventions

Tests must follow specific naming conventions based on their execution environment:

| Suffix | Environment | Purpose |
| ------ | ----------- | ------- |
| `*.client.test.ts` | Client-side (jsdom) | React hooks, components, client utilities |
| `*.server.test.ts` | Server-side (node) | API routes, commands, server utilities |
| `*.test.ts` | Default (node) | General utilities without specific environment needs |
| `*.test.tsx` | JSX support | Components that need JSX in tests |

**Examples**:

```
src/components/chat/MessageInput/useComposerLogic.client.test.ts
src/commands/streamTurn.server.test.ts
src/utils/linkRewriter.client.test.ts
src/app/api/chat/stream/route.server.test.ts
```

---

## Test File Location

Place test files next to the code they test (co-location pattern):

```
src/
├── components/
│   └── chat/
│       └── MessageInput/
│           ├── index.tsx
│           ├── useComposerLogic.internal.ts
│           └── useComposerLogic.client.test.ts  # Co-located
├── commands/
│   ├── streamTurn.ts
│   └── streamTurn.server.test.ts  # Co-located
├── utils/
│   ├── linkRewriter.ts
│   └── linkRewriter.client.test.ts  # Co-located
```

**Why**: Co-location makes tests easy to find, encourages testing, and ensures tests are updated when code changes.

---

## Test Structure

Use the **Arrange-Act-Assert** (AAA) pattern with descriptive `describe` and `it` blocks:

```typescript
describe('streamTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe('chat validation', () => {
    it('should throw BadRequestError if chat does not exist', async () => {
      // Arrange
      mockDatabase.findChatWithUsers.mockResolvedValue(null)

      // Act & Assert
      await expect(streamTurn(createValidInput())).rejects.toThrow(
        new BadRequestError(BadRequestReason.NOT_FOUND, { chatId: 'chat-1' }),
      )

      expect(mockDatabase.findChatWithUsers).toHaveBeenCalledWith('chat-1')
    })
  })
})
```

**Guidelines**:

- Group related tests in `describe` blocks
- Use descriptive test names that explain the expected behavior
- Start test names with "should" for consistency
- One assertion per test when possible (or related assertions)

---

## Server Test Setup

For server-side tests, use the centralized mock setup:

```typescript
import { mockDatabase } from '@/test-utils/db-mock-setup'  // MUST be first import
import { streamTurn } from './streamTurn'
import { EngineAPI } from '@/datasources/EngineAPI'
import { BadRequestError, BadRequestReason } from '@/types/errors'

// Mock external dependencies
jest.mock('@/datasources/EngineAPI')

const mockEngineAPI = EngineAPI as jest.MockedClass<
  typeof EngineAPI
>

describe('streamTurn', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  // ... tests
})
```

**Critical**: Import `@/test-utils/db-mock-setup` **before** any other `@/` imports. This ensures the database mock is hoisted correctly.

---

## Client Test Setup

For client-side tests, mock stores and providers explicitly:

```typescript
import { act, renderHook } from '@testing-library/react'
import { useComposerLogic } from './useComposerLogic.internal'

// Mock stores
jest.mock('@/stores/chatStore', () => ({
  useChatStore: jest.fn(),
}))

jest.mock('@/stores/selectedModelStore', () => ({
  useSelectedModelStore: jest.fn(),
}))

// Get typed mocks
const { useChatStore } = jest.requireMock('@/stores/chatStore')
const { useSelectedModelStore } = jest.requireMock('@/stores/selectedModelStore')

describe('useComposerLogic', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    
    // Setup default mock implementations
    useChatStore.mockImplementation((selector) => {
      if (typeof selector === 'function') {
        return selector(mockStoreState)
      }
      return mockStoreState
    })
  })

  // ... tests
})
```

---

## Mock Factories

Use type-safe mock factories from `@/types/mocks` for consistent test data:

```typescript
import {
  createMockUser,
  createMockChatWithUsers,
  createMockMessageWithUser,
  createMockAgent,
} from '@/types/mocks'

describe('chat feature', () => {
  it('should handle user message', async () => {
    const mockUser = createMockUser({ id: 'user-1', name: 'Test User' })
    const mockChat = createMockChatWithUsers({ tenantId: 'tenant-1' })
    const mockMessage = createMockMessageWithUser({ 
      id: 'msg-1',
      message: 'Hello, world!',
    })

    // ... test logic
  })
})
```

**Creating Mock Factories**:

```typescript
// In @/types/mocks.ts
export const createMockEntity = (overrides?: Partial<Entity>): Entity => ({
  id: 'entity-1',
  name: 'Default Name',
  createdAt: new Date('2024-01-01'),
  // ... all required fields with sensible defaults
  ...overrides,  // Allow overrides
})
```

---

## Testing Logic Hooks

Test logic hooks in isolation using `renderHook`:

```typescript
import { renderHook, act } from '@testing-library/react'
import { useComposerLogic } from './useComposerLogic.internal'

describe('useComposerLogic', () => {
  const createBaseProps = (overrides = {}) => ({
    chatId: 'chat-1',
    input: '',
    handleChange: jest.fn(),
    handleSubmit: jest.fn(),
    ...overrides,
  })

  it('should update input value on change', () => {
    const handleChange = jest.fn()
    const { result } = renderHook(() =>
      useComposerLogic(createBaseProps({ handleChange })),
    )

    act(() => {
      result.current.handleChange({
        target: { value: 'Hello' },
      } as React.ChangeEvent<HTMLTextAreaElement>)
    })

    expect(handleChange).toHaveBeenCalled()
  })
})
```

---

## Mocking Dependencies

### Mocking Modules

```typescript
// Full module mock
jest.mock('@/datasources/EngineAPI')

// Partial module mock
jest.mock('@/utils/streamProcessing', () => ({
  processAssistantStream: jest.fn(),
  toInputJson: jest.fn((data) => data),  // Keep some real implementation
}))

// Typed mock access
const mockEngineAPI = EngineAPI as jest.MockedClass<
  typeof EngineAPI
>
const mockProcessStream = processAssistantStream as jest.MockedFunction<
  typeof processAssistantStream
>
```

### Mocking Class Instances

```typescript
jest.mock('@/datasources/EngineAPI')

const mockEngineAPI = EngineAPI as jest.MockedClass<
  typeof EngineAPI
>

beforeEach(() => {
  mockEngineAPI.prototype.streamAgentResponse = jest
    .fn()
    .mockResolvedValue({
      body: {
        tee: () => [mockStream, mockStream],
      },
    })
})
```

### Mocking Zustand Stores

```typescript
jest.mock('@/stores/chatStore', () => ({
  useChatStore: jest.fn(),
}))

const { useChatStore } = jest.requireMock('@/stores/chatStore')

beforeEach(() => {
  useChatStore.mockImplementation((selector) => {
    if (typeof selector === 'function') {
      return selector(mockStoreState)
    }
    return mockStoreState
  })
})
```

---

## Testing Async Code

```typescript
describe('async operations', () => {
  it('should handle successful async operation', async () => {
    mockDatabase.findChatWithUsers.mockResolvedValue(mockChat)

    const result = await streamTurn(createValidInput())

    expect(result.stream).toBeDefined()
  })

  it('should handle async errors', async () => {
    mockDatabase.findChatWithUsers.mockRejectedValue(new Error('DB Error'))

    await expect(streamTurn(createValidInput())).rejects.toThrow('DB Error')
  })
})
```

---

## Testing Error Cases

```typescript
import { BadRequestError, ForbiddenError, EngineError } from '@/types/errors'

describe('error handling', () => {
  it('should throw BadRequestError for missing chat', async () => {
    mockDatabase.findChatWithUsers.mockResolvedValue(null)

    await expect(streamTurn(createValidInput())).rejects.toThrow(
      new BadRequestError(BadRequestReason.NOT_FOUND, { chatId: 'chat-1' }),
    )
  })

  it('should throw ForbiddenError for tenant mismatch', async () => {
    mockDatabase.findChatWithUsers.mockResolvedValue(
      createMockChatWithUsers({ tenantId: 'different-tenant' }),
    )

    await expect(streamTurn(createValidInput())).rejects.toThrow(
      new ForbiddenError(ForbiddenReason.INVALID_TENANT_MEMBERSHIP),
    )
  })
})
```

---

## Testing with Input Factories

Create factory functions for valid inputs to reduce boilerplate:

```typescript
const createValidInput = (overrides = {}) => ({
  messages: [
    {
      id: 'msg-1',
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Hello' }],
    },
  ],
  chatId: 'chat-1',
  internalTenantId: 'tenant-1',
  accessToken: 'token-123',
  userId: 'user-1',
  ...overrides,
})
```

---

## Browser API Mocks

For client tests requiring browser APIs:

```typescript
// ResizeObserver mock
const installResizeObserver = () => {
  const callbacks: ResizeObserverCallback[] = []

  class MockObserver implements ResizeObserver {
    private callback: ResizeObserverCallback
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      callbacks.push(callback)
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  globalThis.ResizeObserver = MockObserver as unknown as typeof ResizeObserver
  return callbacks
}

// Storage mock (in jest.setup.ts)
const createMockStorage = () => {
  const storage: Record<string, string> = {}
  return {
    getItem: jest.fn((key) => storage[key] ?? null),
    setItem: jest.fn((key, value) => { storage[key] = value }),
    removeItem: jest.fn((key) => { delete storage[key] }),
    clear: jest.fn(() => Object.keys(storage).forEach(k => delete storage[k])),
  }
}
```

---

## Forbidden Patterns

### DON'T Skip Test Cleanup

```typescript
// BAD - No cleanup
it('should handle error', () => {
  jest.spyOn(console, 'error').mockImplementation()
  // Test runs, but spy is never restored
})

// GOOD - Proper cleanup
it('should handle error', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation()
  // ... test logic
  spy.mockRestore()
})
```

### DON'T Use Implementation Details in Tests

```typescript
// BAD - Testing implementation
it('should set internal state', () => {
  const component = render(<MyComponent />)
  expect(component.instance().state.isLoading).toBe(true)
})

// GOOD - Testing behavior
it('should show loading indicator', () => {
  render(<MyComponent />)
  expect(screen.getByRole('progressbar')).toBeInTheDocument()
})
```

### DON'T Write Tests That Always Pass

```typescript
// BAD - No real assertion
it('should work', async () => {
  await someFunction()
  expect(true).toBe(true)
})

// GOOD - Meaningful assertion
it('should return processed data', async () => {
  const result = await someFunction()
  expect(result.data).toEqual(expectedData)
})
```

### DON'T Ignore Async Behavior

```typescript
// BAD - Missing await
it('should fetch data', () => {
  const result = fetchData()  // Returns promise, not data!
  expect(result).toBeDefined()  // Always passes
})

// GOOD - Proper async handling
it('should fetch data', async () => {
  const result = await fetchData()
  expect(result.data).toBeDefined()
})
```

---

## Summary

Following these testing patterns ensures:

- **Consistency**: Same patterns across the codebase
- **Maintainability**: Tests are easy to understand and update
- **Reliability**: Tests are isolated and deterministic
- **Coverage**: Edge cases and errors are tested
- **Speed**: Tests run efficiently with proper mocking
