
## Examples

For detailed error handling examples, see the Error Handling section above.

### Correct Usage (GOOD)

```bash
# Always load credentials from .plan.flow.env first
source .plan.flow.env

# Then authenticate using the loaded token
echo "$GITHUB_TOKEN" | gh auth login --with-token

# Verify access before proceeding
gh auth status
```

### Incorrect Usage (BAD - NEVER Do This)

```bash
# BAD - Using interactive login
gh auth login  # Never use interactive login in automated contexts

# BAD - Hardcoding tokens
GITHUB_TOKEN="ghp_hardcoded_token"  # Never hardcode tokens

# BAD - Skipping .plan.flow.env
gh auth login --with-token <<< "ghp_token"  # Always use .plan.flow.env
```
