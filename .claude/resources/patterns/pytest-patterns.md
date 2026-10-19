
## File Naming Conventions

| Pattern | Purpose |
| ------- | ------- |
| `test_*.py` | Test modules (preferred) |
| `*_test.py` | Alternative test module naming |
| `conftest.py` | Shared fixtures for a directory |

**Directory Structure**:

```
src/
├── mymodule/
│   ├── __init__.py
│   ├── service.py
│   └── utils.py
tests/
├── conftest.py           # Root fixtures
├── test_service.py       # Tests for service.py
├── test_utils.py         # Tests for utils.py
└── integration/
    ├── conftest.py       # Integration-specific fixtures
    └── test_api.py
```

---

## Test Structure

Use descriptive function names and organize with classes when grouping:

```python
import pytest
from mymodule.service import UserService
from mymodule.errors import NotFoundError


class TestUserService:
    """Tests for UserService class."""

    def test_get_user_returns_user_when_exists(self, mock_db):
        """Should return user data when user exists in database."""
        # Arrange
        mock_db.find_user.return_value = {"id": "user-1", "name": "Test User"}
        service = UserService(mock_db)

        # Act
        result = service.get_user("user-1")

        # Assert
        assert result["id"] == "user-1"
        assert result["name"] == "Test User"
        mock_db.find_user.assert_called_once_with("user-1")

    def test_get_user_raises_not_found_when_missing(self, mock_db):
        """Should raise NotFoundError when user doesn't exist."""
        mock_db.find_user.return_value = None
        service = UserService(mock_db)

        with pytest.raises(NotFoundError) as exc_info:
            service.get_user("nonexistent")

        assert "user-1" in str(exc_info.value)
```

---

## Fixtures

Use fixtures for reusable test setup:

```python
# conftest.py - Shared fixtures
import pytest
from unittest.mock import Mock, MagicMock, AsyncMock


@pytest.fixture
def mock_db():
    """Provides a mocked database connection."""
    db = Mock()
    db.find_user = Mock()
    db.create_user = Mock()
    db.update_user = Mock()
    return db


@pytest.fixture
def mock_user():
    """Provides a mock user object."""
    return {
        "id": "user-1",
        "email": "test@example.com",
        "name": "Test User",
        "created_at": "2024-01-01T00:00:00Z",
    }


@pytest.fixture
def mock_chat(mock_user):
    """Provides a mock chat with users."""
    return {
        "id": "chat-1",
        "name": "Test Chat",
        "tenant_id": "tenant-1",
        "users": [mock_user],
    }


@pytest.fixture
async def mock_async_client():
    """Provides an async HTTP client mock."""
    client = AsyncMock()
    client.get = AsyncMock()
    client.post = AsyncMock()
    return client
```

---

## Factory Fixtures

Create parameterized factory fixtures for flexibility:

```python
@pytest.fixture
def create_mock_user():
    """Factory fixture for creating mock users with custom attributes."""
    def _create_user(**overrides):
        defaults = {
            "id": "user-1",
            "email": "test@example.com",
            "name": "Test User",
            "active": True,
            "created_at": "2024-01-01T00:00:00Z",
        }
        return {**defaults, **overrides}
    return _create_user


@pytest.fixture
def create_mock_message(create_mock_user):
    """Factory fixture for creating mock messages."""
    def _create_message(**overrides):
        defaults = {
            "id": "msg-1",
            "chat_id": "chat-1",
            "user": create_mock_user(),
            "content": "Test message",
            "role": "user",
        }
        return {**defaults, **overrides}
    return _create_message


# Usage in tests
def test_message_creation(create_mock_message):
    message = create_mock_message(content="Custom content", role="assistant")
    assert message["content"] == "Custom content"
    assert message["role"] == "assistant"
```

---

## Mocking

### Basic Mocking with unittest.mock

```python
from unittest.mock import Mock, MagicMock, patch, AsyncMock


class TestStreamService:
    def test_stream_response_success(self):
        """Should stream response from engine."""
        mock_engine = Mock()
        mock_engine.stream_response.return_value = iter(["chunk1", "chunk2"])
        
        service = StreamService(mock_engine)
        result = list(service.stream("Hello"))
        
        assert result == ["chunk1", "chunk2"]
        mock_engine.stream_response.assert_called_once_with("Hello")

    @patch("mymodule.service.EngineAPI")
    def test_with_patched_dependency(self, MockEngineAPI):
        """Should use patched engine API."""
        mock_instance = MockEngineAPI.return_value
        mock_instance.get_agent.return_value = {"id": "agent-1"}
        
        service = AgentService()
        result = service.get_agent("agent-1")
        
        assert result["id"] == "agent-1"
```

### Async Mocking

```python
import pytest
from unittest.mock import AsyncMock, patch


class TestAsyncOperations:
    @pytest.mark.asyncio
    async def test_async_fetch_data(self):
        """Should fetch data asynchronously."""
        mock_client = AsyncMock()
        mock_client.get.return_value = {"data": "test"}
        
        service = AsyncService(mock_client)
        result = await service.fetch_data("endpoint")
        
        assert result["data"] == "test"
        mock_client.get.assert_awaited_once_with("endpoint")

    @pytest.mark.asyncio
    @patch("mymodule.service.aiohttp.ClientSession")
    async def test_with_patched_async_client(self, MockSession):
        """Should work with patched async client."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.json.return_value = {"status": "ok"}
        mock_session.get.return_value.__aenter__.return_value = mock_response
        MockSession.return_value.__aenter__.return_value = mock_session
        
        result = await fetch_external_data()
        assert result["status"] == "ok"
```

---

## Parametrized Tests

Use `@pytest.mark.parametrize` for testing multiple cases:

```python
import pytest


class TestValidator:
    @pytest.mark.parametrize("email,expected", [
        ("test@example.com", True),
        ("user@domain.org", True),
        ("invalid-email", False),
        ("@no-local-part.com", False),
        ("no-domain@", False),
        ("", False),
    ])
    def test_email_validation(self, email, expected):
        """Should correctly validate email addresses."""
        result = validate_email(email)
        assert result == expected

    @pytest.mark.parametrize("input_data,error_type", [
        ({"chat_id": None}, ValueError),
        ({"messages": []}, EmptyMessagesError),
        ({"tenant_id": ""}, InvalidTenantError),
    ])
    def test_input_validation_errors(self, input_data, error_type):
        """Should raise appropriate errors for invalid inputs."""
        with pytest.raises(error_type):
            validate_input(input_data)
```

---

## Testing Exceptions

```python
import pytest
from mymodule.errors import NotFoundError, ForbiddenError


class TestErrorHandling:
    def test_raises_not_found_error(self, mock_db):
        """Should raise NotFoundError when resource doesn't exist."""
        mock_db.find.return_value = None
        service = MyService(mock_db)

        with pytest.raises(NotFoundError) as exc_info:
            service.get_item("nonexistent")

        assert exc_info.value.resource_id == "nonexistent"
        assert "not found" in str(exc_info.value).lower()

    def test_raises_forbidden_with_details(self, mock_db):
        """Should raise ForbiddenError with proper details."""
        mock_db.check_permission.return_value = False
        service = MyService(mock_db)

        with pytest.raises(ForbiddenError) as exc_info:
            service.access_resource("resource-1", user_id="user-1")

        error = exc_info.value
        assert error.reason == "INSUFFICIENT_PERMISSIONS"
        assert error.user_id == "user-1"
```

---

## Testing Context Managers

```python
from contextlib import contextmanager
from unittest.mock import Mock


class TestContextManager:
    def test_database_transaction(self, mock_db):
        """Should properly manage database transaction."""
        mock_db.begin_transaction = Mock()
        mock_db.commit = Mock()
        mock_db.rollback = Mock()

        with database_transaction(mock_db) as tx:
            tx.execute("INSERT INTO users ...")

        mock_db.begin_transaction.assert_called_once()
        mock_db.commit.assert_called_once()
        mock_db.rollback.assert_not_called()

    def test_transaction_rollback_on_error(self, mock_db):
        """Should rollback transaction on error."""
        mock_db.begin_transaction = Mock()
        mock_db.commit = Mock()
        mock_db.rollback = Mock()

        with pytest.raises(ValueError):
            with database_transaction(mock_db) as tx:
                raise ValueError("Simulated error")

        mock_db.rollback.assert_called_once()
        mock_db.commit.assert_not_called()
```

---

## Async Testing

```python
import pytest
import asyncio


class TestAsyncService:
    @pytest.mark.asyncio
    async def test_async_operation_success(self, mock_async_client):
        """Should complete async operation successfully."""
        mock_async_client.post.return_value = {"status": "success"}
        
        service = AsyncService(mock_async_client)
        result = await service.create_resource({"name": "test"})
        
        assert result["status"] == "success"

    @pytest.mark.asyncio
    async def test_concurrent_operations(self):
        """Should handle concurrent operations correctly."""
        async def mock_operation(delay, value):
            await asyncio.sleep(delay)
            return value

        results = await asyncio.gather(
            mock_operation(0.1, "first"),
            mock_operation(0.05, "second"),
            mock_operation(0.15, "third"),
        )

        assert results == ["first", "second", "third"]

    @pytest.mark.asyncio
    async def test_async_timeout(self, mock_async_client):
        """Should handle timeout correctly."""
        mock_async_client.get.side_effect = asyncio.TimeoutError()
        
        service = AsyncService(mock_async_client)
        
        with pytest.raises(ServiceTimeoutError):
            await service.fetch_with_timeout("endpoint", timeout=1.0)
```

---

## Test Naming

- Use descriptive names that explain the expected behavior
- Describe the outcome in the function name
- Include context about the scenario

```python
# Good
def test_raises_not_found_error_when_chat_missing(self):
def test_extracts_text_from_multipart_message(self):

# Bad
def test_1(self):
def test_chat(self):
```

---

## Forbidden Patterns

### DON'T Share State Between Tests

```python
# BAD - Shared mutable state
class TestService:
    shared_data = []  # Dangerous!

    def test_one(self):
        self.shared_data.append("item")

    def test_two(self):
        # Depends on test_one running first
        assert len(self.shared_data) == 1

# GOOD - Fresh fixtures
@pytest.fixture
def data_list():
    return []

def test_one(data_list):
    data_list.append("item")
    assert len(data_list) == 1

def test_two(data_list):
    assert len(data_list) == 0  # Fresh list
```

### DON'T Write Tests That Always Pass

```python
# BAD - No real assertion
def test_something():
    some_function()
    assert True

# GOOD - Meaningful assertion
def test_returns_expected_data():
    result = some_function()
    assert result.data == expected_data
```

---

## Summary

Following these testing patterns ensures:

- **Consistency**: Same patterns across the codebase
- **Maintainability**: Tests are easy to understand and update
- **Reliability**: Tests are isolated and deterministic
- **Coverage**: Edge cases and errors are tested
- **Speed**: Tests run efficiently with proper mocking
