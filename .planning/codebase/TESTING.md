# TESTING.md — Testing Patterns
*Generated: 2026-03-21 | Project: Mail_Watcher (Sentinel)*

## Current State

**No automated tests exist.** The only verification mechanism is `verify_table.js` — a manual read-only DB diagnostic script.

## Existing Smoke Test (`verify_table.js`)

```bash
node verify_table.js
```

Checks:
1. Row counts for `emails`, `sender_profiles`, `vec_emails`
2. Alert if `emails` count ≠ `vec_emails` count
3. Vector dimensionality check (`vec_length(embedding)` === 768)
4. Top sender by interaction count

**Limitation:** Manual only, not integrated in any CI/CD.

## Testing Gaps

| Area | Gap |
|------|-----|
| `extractBody()` | No unit test for HTML vs plain text paths |
| `extractAddress()` | No unit test for `"Name <email>"` parsing |
| `buildPrompt()` | No test for prompt construction with missing profile/knn |
| `syncImap()` | No integration test (requires live Gmail) |
| `updateProfiles()` | No unit test for email normalization SQL |
| `vectorizeNew()` | No test for Ollama failure handling |
| `handleTrigger()` | No HTTP endpoint test |
| `analyzeWithGemini()` | No mock test for Gemini response parsing |
| `content.js` | No browser/extension test |

## Recommended Test Approach

Use Node.js native test runner (no Jest/Vitest needed):

```javascript
// test/unit/extractAddress.test.js
import { test } from 'node:test';
import assert from 'node:assert';

test('extracts email from "Name <email>" format', () => {
  // import extractAddress from bridge.js (refactor to export first)
  assert.equal(extractAddress('John Doe <john@example.com>'), 'john@example.com');
});
```

### Testable Units (after minimal refactor to export)
- `extractBody(parsed)` — `sync.js`
- `extractAddress(sender)` — `bridge.js`
- `buildPrompt({email, profile, knn})` — `bridge.js`
- `formatTs(unixSec)` — both files
- `riskColor(score)` / `riskEmoji(score)` — `bridge.js`

### Integration Tests
- `verify_table.js` logic should be converted to assertions in CI
- HTTP endpoint test using Node.js `http` client against a test DB
