# Interactive Questions Tool for Claude Code

## Purpose

Provides a standardized way to ask interactive questions using Claude Code's native `AskUserQuestion` tool. This tool presents structured questions with multiple-choice options to gather requirements and confirm decisions.

## Usage

This tool is used by:
- Discovery commands that need to gather requirements from users
- Skills that require user input before proceeding
- Any process that needs interactive question-answer sessions

---

## How to Use Interactive Questions in Claude Code

Claude Code has a native `AskUserQuestion` tool that presents structured questions to users. Use this for gathering requirements and confirming patterns.

### Using the AskUserQuestion Tool

When you need to ask the user questions, use the `AskUserQuestion` tool with structured options:

```typescript
// Example: Ask about feature requirements
AskUserQuestion({
  questions: [{
    question: "What is the primary user action for this feature?",
    header: "Action",
    options: [
      { label: "Create new items", description: "Users will create new data entries" },
      { label: "View existing items", description: "Users will browse and view data" },
      { label: "Edit existing items", description: "Users will modify existing data" },
      { label: "Delete items", description: "Users will remove data entries" }
    ],
    multiSelect: false
  }]
})
```

### Question Format

Each question object has these properties:

| Property | Required | Description |
|----------|----------|-------------|
| `question` | Yes | The complete question text |
| `header` | Yes | Short label (max 12 chars) for the question |
| `options` | Yes | Array of 2-4 choices |
| `multiSelect` | No | Set to `true` to allow multiple selections |

### Option Format

Each option in the options array has:

| Property | Required | Description |
|----------|----------|-------------|
| `label` | Yes | Short display text (1-5 words) |
| `description` | Yes | Explanation of what this option means |

---

## Workflow for Gathering Requirements

### Step 1: Present Context First

Before asking questions, summarize what you've learned:

```markdown
## Analysis Summary

I've analyzed the codebase and found:

**Stack**: TypeScript + Next.js
**Key Libraries**: Zod, Prisma, Zustand
**Architecture**: Feature-based organization

Now I'll ask a few questions to confirm these patterns.
```

### Step 2: Ask Questions

Use the `AskUserQuestion` tool to present questions. You can ask up to 4 questions at once.

**Example for Stack Confirmation**:

```typescript
AskUserQuestion({
  questions: [{
    question: "I detected the following stack. Is this accurate?",
    header: "Stack",
    options: [
      { label: "Yes, correct", description: "The detected stack matches our project" },
      { label: "Partially correct", description: "Some details need adjustment" },
      { label: "No, different", description: "Let me describe our actual stack" }
    ],
    multiSelect: false
  }]
})
```

**Example for Pattern Enforcement**:

```typescript
AskUserQuestion({
  questions: [{
    question: "Which coding patterns should I enforce when generating code?",
    header: "Patterns",
    options: [
      { label: "All detected (Recommended)", description: "Enforce all patterns I found in the codebase" },
      { label: "Let me review", description: "Show me the patterns first and I'll select which to keep" },
      { label: "Describe preferred", description: "These are legacy patterns, I'll describe new ones" }
    ],
    multiSelect: false
  }]
})
```

**Example for Strictness Level**:

```typescript
AskUserQuestion({
  questions: [{
    question: "How strictly should patterns be enforced?",
    header: "Strictness",
    options: [
      { label: "Strict", description: "Always follow patterns exactly, no exceptions" },
      { label: "Moderate (Recommended)", description: "Follow patterns but allow justified exceptions" },
      { label: "Loose", description: "Use as guidelines, not strict requirements" }
    ],
    multiSelect: false
  }]
})
```

### Step 3: Wait for Responses

After calling `AskUserQuestion`, wait for the user to respond before proceeding. The tool will return the selected option(s).

### Step 4: Process Responses

Use the selected answers to inform your next actions:

1. Extract the selected options from the response
2. Map them to corresponding actions
3. Document the confirmed decisions
4. Proceed with the workflow based on user choices

---

## When to Use Interactive Questions

### Use For:

1. **Discovery Phase**: Gathering requirements and clarifying unknowns
2. **Planning Phase**: Understanding scope, priorities, and constraints
3. **Critical Decisions**: When user input is required before proceeding
4. **Pattern Confirmation**: Confirming detected patterns during setup
5. **Complex Choices**: When options need to be clearly presented

### Don't Use For:

1. **Simple Yes/No Questions**: Just ask in regular conversation
2. **Single Simple Questions**: Regular conversation is faster
3. **Information Already Available**: Don't ask if you can find the answer
4. **Read-Only Operations**: No questions needed for reading/searching

---

## Question Guidelines

### Good Questions

```typescript
// Clear, specific, with context
AskUserQuestion({
  questions: [{
    question: "Where should the new button be placed in the navigation?",
    header: "Placement",
    options: [
      { label: "Before Library", description: "Insert before the Library menu item" },
      { label: "After Library", description: "Insert after the Library menu item" },
      { label: "Separate toolbar", description: "Create a new toolbar for this action" },
      { label: "Dropdown menu", description: "Add as an option in an existing dropdown" }
    ],
    multiSelect: false
  }]
})
```

### Avoid

- Questions that are too vague ("What do you want?")
- Too many options (stick to 2-4)
- Options without clear descriptions
- Asking about things you can determine from code

---

## Multiple Questions at Once

You can ask up to 4 related questions in a single call:

```typescript
AskUserQuestion({
  questions: [
    {
      question: "Is the detected tech stack correct?",
      header: "Stack",
      options: [
        { label: "Yes, correct", description: "All detected technologies are accurate" },
        { label: "Needs adjustment", description: "Some corrections needed" }
      ],
      multiSelect: false
    },
    {
      question: "Which patterns should be enforced?",
      header: "Patterns",
      options: [
        { label: "All detected", description: "Enforce all patterns found" },
        { label: "Review first", description: "Let me review before deciding" }
      ],
      multiSelect: false
    }
  ]
})
```

---

## Related Rules

- Discovery patterns: `.claude/resources/patterns/discovery-patterns.md`
- Plan patterns: `.claude/resources/patterns/plans-patterns.md`
- Setup skill: `.claude/skills/setup/SKILL.md`
