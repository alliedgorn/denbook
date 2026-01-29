---
project: github.com/Soul-Brews-Studio/oracle-v2
---

# Always Trace Full Execution Path for Visibility Changes

**Date**: 2026-01-26
**Context**: Oracle 3D Graph lightning effects implementation
**Confidence**: High

## Key Learning

When implementing visibility logic in animation loops, especially with multiple conditional paths, always trace the FULL execution path to ensure no code later in the loop overrides your intended visibility state.

In this session, I correctly set lightning line visibility based on whether a node was hovered (`line.visible = isConnected`), but a separate block of code later in the animation loop was unconditionally setting `line.visible = true` for all ambient lightnings. This override was buried in what looked like cleanup code for "show ambient lightnings when enabled", but it was actually negating all the conditional logic above it.

The bug persisted through multiple iterations because I kept looking at the code I'd written rather than tracing what happened AFTER my code in the same loop.

## The Pattern

```javascript
// ❌ WRONG: Adding visibility logic without checking downstream
function animate() {
  // ... earlier code sets visibility conditionally
  ambientLightnings.forEach(l => {
    l.line.visible = isConnectedToActiveNode(l);
  });

  // ... 50 lines later, forgotten code:
  if (lightningEnabled) {
    ambientLightnings.forEach(l => { l.line.visible = true; }); // OVERRIDES!
  }
}

// ✅ RIGHT: Single source of truth, or explicit guards
function animate() {
  const activeId = activeNodeRef.current;

  if (!activeId) {
    // No hover - hide all lightning
    ambientLightnings.forEach(l => { l.line.visible = false; });
  } else {
    // Show only connected lightning
    ambientLightnings.forEach(l => {
      l.line.visible = isConnectedTo(l, activeId);
    });
  }
  // NO OTHER CODE TOUCHES visibility after this point
}
```

## Why This Matters

Animation loops in THREE.js often accumulate code over time. Each feature adds its own visibility/state logic, but they can conflict. The last write wins, so any code that runs after your conditional logic can silently override it.

This is especially insidious because:
1. The override code may have been correct when written
2. It may be far from the code you're debugging
3. The bug only manifests at runtime, not in code review

**Rule**: After implementing visibility logic, search the entire animation function for other places that touch the same property.

## Tags

`three.js`, `animation-loop`, `visibility`, `debugging`, `state-management`
