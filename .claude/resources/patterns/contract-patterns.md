
## Contract Types

| Type | Purpose | When to Use |
|------|---------|-------------|
| API Contract | REST/GraphQL endpoint documentation | Integrating with external APIs |
| Integration Contract | Service connection details | Connecting to third-party services |
| Component Contract | Props, events, data flow | Documenting component interfaces |

---

## Contract Document Structure

Every contract should include these sections:

### Required Sections

1. **Overview**: Brief description of the service
2. **Source**: URL and type (docs/repo)
3. **Authentication**: How to authenticate requests
4. **Base Configuration**: URLs, rate limits, timeouts
5. **Endpoints**: Available API endpoints with schemas
6. **Error Handling**: Error codes and response formats

### Recommended Sections

7. **FE Integration Notes**: Frontend-specific guidance
8. **Usage Examples**: Code examples for common use cases
9. **Webhooks**: Event subscriptions if applicable
10. **Rate Limits**: Throttling information
11. **Changelog**: Version history

---

## Allowed Patterns

### 1. Use TypeScript Interfaces for Schemas

Define request and response types using TypeScript interfaces:

```typescript
interface CreateUserRequest {
  email: string;
  name: string;
  role?: 'admin' | 'user';
}

interface CreateUserResponse {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}
```

### 2. Document All Status Codes

List all possible HTTP status codes with their meaning:

| Code | Meaning | FE Action |
|------|---------|-----------|
| 200 | Success | Process response |
| 201 | Created | Navigate to new resource |
| 400 | Bad Request | Show validation errors |
| 401 | Unauthorized | Redirect to login |
| 403 | Forbidden | Show permission error |
| 404 | Not Found | Show not found UI |
| 429 | Rate Limited | Retry with backoff |
| 500 | Server Error | Show generic error |

### 3. Include Authentication Examples

Provide complete authentication setup:

```typescript
// API Key Authentication
const headers = {
  'X-API-Key': process.env.API_KEY,
  'Content-Type': 'application/json',
};

// Bearer Token Authentication
const headers = {
  'Authorization': `Bearer ${accessToken}`,
  'Content-Type': 'application/json',
};

// OAuth2 Flow
async function getAccessToken(): Promise<string> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  const { access_token } = await response.json();
  return access_token;
}
```

### 4. Define Error Response Types

Create typed error handling:

```typescript
interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}

function handleError(error: ApiError): void {
  switch (error.code) {
    case 'VALIDATION_ERROR':
      // Show field-specific errors
      break;
    case 'UNAUTHORIZED':
      // Clear auth and redirect
      break;
    case 'RATE_LIMITED':
      // Queue for retry
      break;
    default:
      // Show generic error
  }
}
```

### 5. Document Rate Limit Handling

Include retry logic patterns:

```typescript
async function fetchWithRetry<T>(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || '1';
      await delay(parseInt(retryAfter) * 1000);
      continue;
    }
    
    if (!response.ok) {
      throw new ApiError(await response.json());
    }
    
    return response.json();
  }
  throw new Error('Max retries exceeded');
}
```

---

## Forbidden Patterns

### 1. DON'T Hardcode Credentials

Never include actual API keys or secrets in contracts:

```typescript
// BAD
const API_KEY = 'sk_live_abc123';

// GOOD
const API_KEY = process.env.STRIPE_API_KEY;
```

### 2. DON'T Skip Error Documentation

Always document error scenarios:

```markdown
// BAD - No error handling documented
## Endpoints
### GET /users
Returns list of users.

// GOOD - Error cases documented
## Endpoints
### GET /users
Returns list of users.

**Error Responses**:
- 401: Invalid or expired token
- 403: Insufficient permissions
- 429: Rate limit exceeded
```

### 3. DON'T Use Generic Types

Be specific with type definitions:

```typescript
// BAD
interface Response {
  data: any;
  meta: object;
}

// GOOD
interface UserListResponse {
  data: User[];
  meta: {
    total: number;
    page: number;
    perPage: number;
  };
}
```

### 4. DON'T Omit Required Fields

Mark required vs optional clearly:

```typescript
// BAD - Unclear requirements
interface CreateUserRequest {
  email: string;
  name: string;
  phone: string;
}

// GOOD - Optional fields marked
interface CreateUserRequest {
  email: string;      // Required
  name: string;       // Required
  phone?: string;     // Optional
}
```

---

## FE Integration Guidelines

### State Management Recommendations

| Data Type | Recommendation |
|-----------|----------------|
| User session | Global store (Zustand/Redux) |
| API responses | React Query / SWR |
| Form state | Local component state |
| UI state | Local or context |

### Loading State Patterns

```typescript
type RequestState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: ApiError };
```

### Caching Recommendations

| Endpoint Type | Cache Strategy |
|---------------|----------------|
| List endpoints | Cache with revalidation |
| Detail endpoints | Cache by ID |
| Mutations | Invalidate related queries |
| Real-time data | No cache / short TTL |

---

## Contract Maintenance

### When to Update Contracts

- API version changes
- New endpoints added
- Breaking changes in schemas
- Authentication method changes
- Rate limit adjustments

### Version Tracking

Include changelog in contracts:

```markdown
## Changelog

| Date | Version | Changes |
|------|---------|---------|
| 2024-01-15 | 2.0 | Added pagination to list endpoints |
| 2024-01-10 | 1.1 | Added webhook documentation |
| 2024-01-01 | 1.0 | Initial contract |
```

---

## Contract File Organization

```
contracts/
├── stripe_payments_contract.md
├── auth0_authentication_contract.md
├── sendgrid_email_contract.md
├── openai_chat_contract.md
└── internal_api_contract.md
```

### Naming Convention

`<service_name>_<feature>_contract.md`

Examples:
- `stripe_payments_contract.md`
- `stripe_subscriptions_contract.md`
- `github_repos_contract.md`

---

## Summary

| Pattern | Description |
|---------|-------------|
| TypeScript Interfaces | Use typed schemas for requests/responses |
| Status Code Documentation | Document all HTTP status codes |
| Authentication Examples | Provide complete auth setup code |
| Error Type Definitions | Create typed error handling |
| Rate Limit Handling | Include retry logic patterns |
| No Hardcoded Secrets | Use environment variables |
| Specific Types | Avoid `any` and `object` |
| Required Field Markers | Mark optional fields explicitly |
