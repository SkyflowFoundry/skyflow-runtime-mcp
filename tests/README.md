# Testing Guide

This project uses [Vitest](https://vitest.dev/) for unit testing.

## Running Tests

```bash
# Run all tests once
pnpm test

# Run tests in watch mode (re-runs on file changes)
pnpm test:watch

# Run tests with coverage report
pnpm test:coverage
```

## Test Structure

```
tests/
├── unit/
│   ├── middleware/       # Tests for Express middleware
│   ├── tools/           # Tests for MCP tool handlers
│   ├── context/         # Tests for AsyncLocalStorage context
│   └── mappings/        # Tests for entity/type mappings
└── README.md
```

## Writing Tests

### Basic Test Example

```typescript
import { describe, it, expect } from "vitest";

describe("Feature Name", () => {
  it("should do something", () => {
    const result = 2 + 2;
    expect(result).toBe(4);
  });
});
```

### Mocking Example

```typescript
import { describe, it, expect, vi } from "vitest";

describe("Function with dependency", () => {
  it("should call external API", () => {
    const mockFn = vi.fn();
    mockFn.mockReturnValue("mocked value");

    expect(mockFn()).toBe("mocked value");
    expect(mockFn).toHaveBeenCalledTimes(1);
  });
});
```

### Skyflow SDK Mocking Pattern

The tool handler tests mock `skyflow-node` at the module level. Because the SDK classes are instantiated with `new`, mock implementations must use `function` syntax (not arrow functions):

```typescript
const mockSetDefault = vi.fn();

vi.mock("skyflow-node", () => ({
  // Use function syntax for classes instantiated with `new`
  TokenFormat: vi.fn(function (this: any) { this.setDefault = mockSetDefault; }),
  // Plain objects are fine as-is
  TokenType: { VAULT_TOKEN: "VAULT_TOKEN" },
}));

// Factory for mock Skyflow instances with configurable responses
function createMockSkyflow(response: Record<string, unknown>) {
  return {
    detect: vi.fn(() => ({
      deidentifyText: vi.fn().mockResolvedValue(response),
    })),
  };
}
```

## Configuration

- **vitest.config.ts** - Vitest test runner configuration
- **tsconfig.json** - TypeScript compiler configuration

## Coverage

Coverage reports are generated in the `coverage/` directory (git-ignored).

- `coverage/index.html` - Visual HTML report
- `coverage/coverage-final.json` - JSON data

## Test Coverage

The tool handler tests (`tests/unit/tools/`) cover:

- **dehydrate**: Output shape, entity metadata, token format by mode, anonymous mode flags
- **rehydrate**: Output shape, inputText passthrough, anonymous mode error
- **dehydrateFile**: File metadata passthrough, image/audio processing, entity/masking mapping, wait time defaults, optional fields, SkyflowError handling, generic error handling, anonymous mode error
